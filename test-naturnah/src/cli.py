"""
Near-natural ("naturnah") sample analysis
=========================================
Spatial join between cadastral parcels (EGRID) and the data sources of the BAFU
list «M5 Übersicht Datenquellen naturnahe Flächen» (see :mod:`sources`).

For every distinct EGRID the layers are fetched live from geo.admin.ch
(``identify``), clipped to the parcel and the area per element is reported.
Overlapping pieces are dissolved, so neither an element nor the total counts an
area twice.

Usage
-----
    python main.py --egrid CH427760110057
    python main.py --input "in/BBL Grundstücke 2026-11.txt"
    python main.py --input "in/BBL Grundstücke 2026-11.txt" --resume out/naturnah_<ts>.jsonl

Outputs (timestamped, in ``--output-dir``): an Excel workbook (Grundstücke /
Datenmodell), a GeoJSON with the Grundstücke and the clipped objects on them,
a log and a checkpoint (``.jsonl``, one line per finished EGRID) that
``--resume`` reads to re-query only what failed or is still missing.

Column prefixes: ``in_`` = taken from the input list, ``out_`` = produced here.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import threading
import urllib.error
import urllib.parse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

from shapely.geometry import mapping

import api
import geom_wgs84 as geom
import sources
from inputs import read_input
from user_input import normalize_egrid

logger = logging.getLogger("naturnah")

# test-naturnah/out — the default output directory (gitignored).
DEFAULT_OUTPUT_DIR = Path(__file__).resolve().parent.parent / "out"

SLIVER_M2 = 0.001
MAX_FEATURES = 5000
LAYER_ATTEMPTS = 3          # on top of the per-request retries in api._fetch_json
LAYER_RETRY_PAUSE_S = 10
WORKERS = 4                 # parcels in parallel (public service: keep it modest)
ABORT_AFTER_FAILURES = 10   # consecutive failed parcels → the service is down, stop and keep the checkpoint
FEATURE_URL = "https://api3.geo.admin.ch/rest/services/all/MapServer"

# The parcel lookup (``find``) is a *substring* search: an empty text returns
# arbitrary parcels and a short one every EGRID that contains it. Only a full
# 14-character EGRID is therefore ever sent to the service.
EGRID_RE = re.compile(r"^CH[0-9A-Z]{12}$")

ST_FOUND = "EGRID found"
ST_NOT_FOUND = "EGRID not found"
ST_MISSING = "EGRID missing"
ST_INVALID = "Invalid EGRID"
ST_NOT_PROCESSED = "Not processed"

# Set when a run stops early, so parcels still in flight give up instead of
# retrying for minutes against a service that is down.
_STOP = threading.Event()


def _r2(x: float) -> float:
    return round(x + 0.0, 2)


_col = sources.element_column   # output column of an element


def out_columns() -> list[str]:
    """The ``out_`` columns of a parcel record, in sheet order."""
    return ([c[0] for c in sources.GRUNDSTUECK_COLS_HEAD]
            + [_col(e) for e in sources.ELEMENTS]
            + [f"out_kat{k}_m2" for k in sources.KATEGORIEN]
            + [c[0] for c in sources.GRUNDSTUECK_COLS_TAIL])


def empty_out(status: str) -> dict:
    """An all-empty ``out_`` record carrying *status* in ``out_check_egrid``."""
    out = dict.fromkeys(out_columns())
    out["out_check_egrid"] = status
    out["out_check_naturnah"] = ""
    out["out_error"] = ""
    return out


def check_sources() -> None:
    """Fail fast on an inconsistent element table (a typo there would otherwise
    surface as a KeyError in the middle of a run)."""
    keys = [e["key"] for e in sources.ELEMENTS]
    if len(keys) != len(set(keys)):
        raise ValueError("sources.ELEMENTS: duplicate key")
    for e in sources.ELEMENTS:
        if e["layer"] not in sources.LAYERS:
            raise ValueError(f"sources.ELEMENTS[{e['key']}]: layer not in LAYERS")
        if e["kat"] not in sources.KATEGORIEN:
            raise ValueError(f"sources.ELEMENTS[{e['key']}]: category {e['kat']} not in KATEGORIEN")
        if e["codes"] is not None and e["layer"] != sources.BLW:
            raise ValueError(f"sources.ELEMENTS[{e['key']}]: Kultur-Codes only filter the BLW layer")


# ---------------------------------------------------------------------------
# Fetch + clip
# ---------------------------------------------------------------------------

def _retryable(e: Exception) -> bool:
    """A 4xx answer (except 429) is the service rejecting the request — asking
    again cannot help."""
    return not (isinstance(e, urllib.error.HTTPError) and 400 <= e.code < 500 and e.code != 429)


def fetch_feature_geometry(layer_id: str, fid):
    """Full geometry of one feature by id — the fallback for features whose geometry
    ``identify`` omits above its size cap. ``None`` when it cannot be fetched."""
    url = f"{FEATURE_URL}/{layer_id}/{urllib.parse.quote(str(fid))}?geometryFormat=geojson&sr=4326"
    try:
        data = api._fetch_json(url)
        g = (data.get("feature") or data).get("geometry")
        return geom.from_geojson(g) if g else None
    except Exception as e:  # noqa: BLE001
        logger.warning("Feature %s/%s could not be fetched: %s", layer_id, fid, e)
        return None


def clip_layer(layer_id: str, parcel_geom) -> dict:
    """Fetch *layer_id* for the parcel and clip every feature to it.

    Returns ``{pieces: [{geometry, area_m2, properties, id}], error, error_msg, truncated,
    missing}``; ``error_msg`` is what the service answered when the query failed and
    ``missing`` counts features whose geometry could not be obtained or clipped.
    """
    out = {"pieces": [], "error": False, "error_msg": "", "truncated": False, "missing": 0}
    r = None
    last_error = "abgebrochen"
    for attempt in range(LAYER_ATTEMPTS):
        if _STOP.is_set():      # the run is being stopped: do not start another request
            break
        try:
            r = api.fetch_identify(layer_id, parcel_geom, MAX_FEATURES)
            break
        except Exception as e:  # noqa: BLE001 — the service answers 502 in bursts; wait and retry
            logger.warning("identify failed for %s (attempt %d/%d): %s", layer_id, attempt + 1, LAYER_ATTEMPTS, e)
            last_error = str(e) or type(e).__name__
            if not _retryable(e):
                break
            if attempt + 1 < LAYER_ATTEMPTS:
                _STOP.wait(LAYER_RETRY_PAUSE_S)
    if r is None:
        out["error"], out["error_msg"] = True, last_error
        return out
    out["truncated"] = r["truncated"]
    features = list(r["features"])
    for d in r["dropped"]:
        g = fetch_feature_geometry(layer_id, d["id"]) if d.get("id") is not None else None
        if g is None:
            out["missing"] += 1
        else:
            features.append({"geometry": g, "properties": d["properties"], "id": d["id"]})
    for f in features:
        try:
            piece = geom.intersect(f["geometry"], parcel_geom)
        except Exception as e:  # noqa: BLE001
            logger.debug("clip failed for %s/%s: %s", layer_id, f.get("id"), e)
            out["missing"] += 1
            continue
        if piece is None:
            continue
        a = geom.area(piece)
        if a < SLIVER_M2:
            continue
        out["pieces"].append({"geometry": piece, "area_m2": a, "properties": f["properties"], "id": f["id"]})
    return out


def _matches(element: dict, piece: dict) -> bool:
    if element["codes"] is None:
        return True
    try:
        return int(piece["properties"].get(sources.BLW_CODE_ATTR)) in element["codes"]
    except (TypeError, ValueError):
        return False


def _union_area(pieces: list) -> float:
    u = geom.union([p["geometry"] for p in pieces])
    return geom.area(u) if u is not None else 0.0


# ---------------------------------------------------------------------------
# One parcel
# ---------------------------------------------------------------------------

def process_egrid(egrid: str) -> dict:
    """One EGRID → a JSON-serialisable result::

        {egrid, complete, out: {out_… columns}, details: [{…}], geometry, pieces}

    ``geometry`` is the parcel and ``pieces[i]`` the clipped geometry of
    ``details[i]``, both as GeoJSON. ``complete`` is False when something could
    not be queried — ``--resume`` asks again for exactly those.
    """
    out = empty_out("")
    res = {"egrid": egrid, "complete": False, "out": out, "details": [], "geometry": None, "pieces": []}

    try:
        parcel = api.fetch_parcel_geometry(egrid)
    except Exception as e:  # noqa: BLE001
        out["out_check_egrid"] = f"Error: {e}"
        return res
    if parcel is None:
        out["out_check_egrid"] = ST_NOT_FOUND
        res["complete"] = True
        return res

    pg = parcel["geometry"]
    parcel_area = geom.area(pg)
    out.update({"out_check_egrid": ST_FOUND, "out_nummer": parcel["properties"]["number"],
                "out_parcel_area_m2": _r2(parcel_area)})
    res["geometry"] = mapping(pg)

    by_layer = {lid: clip_layer(lid, pg) for lid in sources.LAYERS}
    notes = []
    for lid, r in by_layer.items():
        short = lid.split(".", 2)[-1]
        if r["error"]:
            notes.append(f"{short}: Abfrage fehlgeschlagen ({r['error_msg']})")
        if r["truncated"]:
            notes.append(f"{short}: unvollständig (Limit)")
        if r["missing"]:
            notes.append(f"{short}: {r['missing']} Objekt(e) ohne Geometrie")
    out["out_check_naturnah"] = "; ".join(notes) or "ok"
    failed = {lid for lid, r in by_layer.items() if r["error"]}

    # A value is left empty as soon as one layer it depends on could not be queried:
    # a number there would silently understate, and nobody re-reads the check column
    # after summing 2'000 rows.
    matched_all: list = []
    by_kat: dict[int, list] = {k: [] for k in sources.KATEGORIEN}
    kat_failed: set[int] = set()
    element_of: dict[int, str] = {}  # id(piece) → element key (for the details)
    for e in sources.ELEMENTS:
        layer = by_layer[e["layer"]]
        if layer["error"]:
            kat_failed.add(e["kat"])
            continue
        pieces = [p for p in layer["pieces"] if _matches(e, p)]
        out[_col(e)] = _r2(_union_area(pieces))
        for p in pieces:
            element_of[id(p)] = e["key"]
        matched_all.extend(pieces)
        by_kat[e["kat"]].extend(pieces)

    for k, pieces in by_kat.items():
        if k not in kat_failed:
            out[f"out_kat{k}_m2"] = _r2(_union_area(pieces))
    if not failed:
        total = _union_area(matched_all)
        out["out_naturnah_total_m2"] = _r2(total)
        out["out_naturnah_anteil_pct"] = _r2(100 * total / parcel_area) if parcel_area > 0 else None
    if sources.BLW not in failed:
        out["out_blw_total_m2"] = _r2(_union_area(by_layer[sources.BLW]["pieces"]))

    # Details: every clipped piece (all BLW Kultur-Codes, so codes outside the list show up too).
    for lid, r in by_layer.items():
        for p in r["pieces"]:
            pr = p["properties"]
            res["details"].append({
                "in_egrid": egrid, "out_layer": lid,
                "out_element": element_of.get(id(p), ""),
                "out_feature_id": p["id"],
                "out_kultur_code": pr.get(sources.BLW_CODE_ATTR, ""),
                "out_bezeichnung": pr.get("nutzung_de") or pr.get("name") or pr.get("label") or "",
                "out_objnummer": pr.get("objnummer", ""),
                "out_bff_qualitaet_1": pr.get("bff_qualitaet_1", ""),
                "out_bezugsjahr": pr.get("bezugsjahr", ""),
                "out_area_m2": _r2(p["area_m2"]),
            })
            res["pieces"].append(mapping(p["geometry"]))
    res["complete"] = not any(r["error"] or r["missing"] for r in by_layer.values())
    return res


def safe_process(egrid: str) -> dict:
    """:func:`process_egrid`, but an unexpected error costs one parcel, not the run."""
    try:
        return process_egrid(egrid)
    except Exception as e:  # noqa: BLE001
        logger.exception("Unexpected error for %s", egrid)
        return {"egrid": egrid, "complete": False, "out": empty_out(f"Error: {type(e).__name__}: {e}"),
                "details": [], "geometry": None, "pieces": []}


# ---------------------------------------------------------------------------
# Run (parallel, checkpointed)
# ---------------------------------------------------------------------------

def load_checkpoint(path: str | Path) -> dict[str, dict]:
    """Results of an earlier run by EGRID (a later line wins). A cut-off last line
    — the run was killed while writing — is skipped."""
    results: dict[str, dict] = {}
    with open(path, encoding="utf-8") as fh:
        for no, line in enumerate(fh, 1):
            if not line.strip():
                continue
            try:
                r = json.loads(line)
                results[r["egrid"]] = r
            except (ValueError, KeyError, TypeError):
                logger.warning("Checkpoint %s: line %d is unreadable, skipped", path, no)
    return results


def run(egrids: list[str], checkpoint: Path, resume: dict | None = None, workers: int = WORKERS) -> tuple[dict, bool]:
    """Process *egrids* (distinct, valid) → ``(results by EGRID, aborted)``.

    Complete results in *resume* are reused (unless the element table changed
    since). Every finished parcel is appended to *checkpoint* at once, so a crash,
    Ctrl-C or the abort after ``ABORT_AFTER_FAILURES`` consecutive failures loses
    nothing.
    """
    out_cols = set(out_columns())
    results = {e: resume[e] for e in egrids
               if resume and e in resume and resume[e].get("complete") and set(resume[e].get("out", {})) == out_cols}
    todo = [e for e in egrids if e not in results]
    if resume is not None:
        logger.info("Resume: %d parcel(s) reused, %d to query", len(results), len(todo))
    aborted = False
    _STOP.clear()
    with open(checkpoint, "w", encoding="utf-8") as fh:
        for r in results.values():
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
        if not todo:
            return results, aborted
        pool = ThreadPoolExecutor(max_workers=max(1, min(workers, len(todo))))
        futures = [pool.submit(safe_process, e) for e in todo]
        failures = 0
        try:
            for i, fut in enumerate(as_completed(futures), 1):
                r = fut.result()
                results[r["egrid"]] = r
                fh.write(json.dumps(r, ensure_ascii=False) + "\n")
                fh.flush()
                o = r["out"]
                logger.info("  %d/%d %s — %s, naturnah %s m², BLW %s m² [%s]", i, len(todo), r["egrid"],
                            o["out_check_egrid"], o["out_naturnah_total_m2"], o["out_blw_total_m2"],
                            o["out_check_naturnah"])
                failures = 0 if r["complete"] else failures + 1
                if failures >= ABORT_AFTER_FAILURES:
                    logger.error("%d parcels in a row failed — the service seems to be down. Stopping.", failures)
                    aborted = True
                    break
        except KeyboardInterrupt:
            logger.error("Interrupted — writing what is finished.")
            aborted = True
        finally:
            if aborted:
                _STOP.set()
            pool.shutdown(wait=False, cancel_futures=True)
    return results, aborted


def row_errors(egrid: str, count: int, out: dict) -> str:
    """Everything that is wrong with an input row, in one text (``out_error``);
    empty when the row is fine. The single column to filter on."""
    if not egrid:
        return "EGRID fehlt"
    if not EGRID_RE.match(egrid):
        return "EGRID ungültig"
    errors = []
    if count > 1:
        errors.append(f"EGRID mehrfach in der Liste ({count}×)")
    status = out["out_check_egrid"]
    if status == ST_NOT_PROCESSED:
        errors.append("Nicht verarbeitet (Lauf abgebrochen)")
    elif status == ST_NOT_FOUND:
        errors.append("EGRID nicht gefunden")
    elif status != ST_FOUND:        # "Error: <what the service answered>"
        errors.append(f"Grundstück konnte nicht abgefragt werden ({status.removeprefix('Error: ')})")
    if out["out_check_naturnah"] not in ("", "ok"):
        errors.append(out["out_check_naturnah"])
    return "; ".join(errors)


def build_rows(rows: list[dict], results: dict) -> list[dict]:
    """One record per input row: every input column as ``in_<name>``, then the
    ``out_`` columns of its EGRID."""
    counts = Counter(r["egrid"] for r in rows if EGRID_RE.match(r["egrid"]))
    records = []
    for row in rows:
        egrid = row["egrid"]
        rec = {f"in_{k}": v for k, v in row.items()}
        if not egrid:
            out = empty_out(ST_MISSING)
        elif not EGRID_RE.match(egrid):
            out = empty_out(ST_INVALID)
        elif egrid in results:
            out = dict(results[egrid]["out"])
        else:
            out = empty_out(ST_NOT_PROCESSED)
        out["out_egrid_count"] = counts.get(egrid)
        out["out_error"] = row_errors(egrid, counts.get(egrid, 0), out)
        rec.update(out)
        records.append(rec)
    return records


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

def _append(ws, values: list) -> None:
    """Append a row of plain values: control characters Excel rejects are removed,
    and a text starting with ``=`` stays text instead of becoming a formula."""
    from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
    values = [ILLEGAL_CHARACTERS_RE.sub("", v) if isinstance(v, str) else v for v in values]
    ws.append(values)
    if any(isinstance(v, str) and v.startswith("=") for v in values):
        for cell in ws[ws._current_row]:
            if cell.data_type == "f":
                cell.data_type = "s"


def write_xlsx(records: list[dict], path: Path) -> None:
    """The workbook: «Grundstücke» (one row per row of the input list) and
    «Datenmodell» (every attribute of the workbook and of the GeoJSON, with its
    format, description, source and a link to the dataset on the federal map
    viewer — :func:`sources.data_model`)."""
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font

    wb = Workbook()
    ws = wb.active
    ws.title = sources.SHEET_GRUNDSTUECKE
    cols = list(records[0].keys())
    _append(ws, cols)
    for rec in records:
        _append(ws, [rec.get(c) for c in cols])

    wm = wb.create_sheet(sources.SHEET_DATENMODELL)
    _append(wm, sources.DATENMODELL_HEADER)
    link_col = len(sources.DATENMODELL_HEADER)
    for row in sources.data_model():
        _append(wm, list(row))
        cell = wm.cell(row=wm.max_row, column=link_col)
        if cell.value:                      # a clickable link to the dataset on map.geo.admin.ch
            cell.hyperlink = cell.value
            cell.style = "Hyperlink"
    # Readable without resizing: fixed widths, long texts wrapped.
    for letter, width in zip("ABCDEF", (24, 32, 24, 80, 52, 60)):
        wm.column_dimensions[letter].width = width
    for row in wm.iter_rows(min_row=2, max_col=5):
        for cell in row:
            cell.alignment = Alignment(wrap_text=True, vertical="top")

    for sheet in (ws, wm):
        for c in sheet[1]:
            c.font = Font(bold=True)
        sheet.freeze_panes = "A2"
    wb.save(path)
    logger.info("Excel → %s", path)


def write_geojson(records: list[dict], results: dict, path: Path) -> None:
    """One FeatureCollection with two kinds of features, told apart by ``layer``: the
    Grundstücke (one per input row with a found Grundstück, with all its columns) and
    the clipped objects on them (one per object and distinct EGRID). Compact, one
    feature per line, as the main tools write it."""
    feats = []
    for rec in records:
        r = results.get(rec["in_egrid"])
        if r and r["geometry"] is not None:
            feats.append({"type": "Feature", "geometry": r["geometry"],
                          "properties": {"layer": sources.LAYER_GRUNDSTUECK, **rec}})
    for r in results.values():
        for d, g in zip(r["details"], r["pieces"]):
            feats.append({"type": "Feature", "geometry": g, "properties": {"layer": sources.LAYER_NATURNAH, **d}})
    nl = chr(10)
    lines = [json.dumps(f, ensure_ascii=False, separators=(",", ":"), allow_nan=False) for f in feats]
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write('{"type":"FeatureCollection","features":[' + nl + ("," + nl).join(lines) + nl + "]}")
    logger.info("GeoJSON → %s", path)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="test-naturnah", description=__doc__.split("\n\n")[0])
    ap.add_argument("--egrid", help="One or more EGRIDs, comma-separated")
    ap.add_argument("--input", dest="input_path", help="SAP list export (.txt), CSV or Excel with an EGRID column")
    ap.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR), help="Default: the out/ folder next to main.py")
    ap.add_argument("--limit", type=int, default=None, help="Process only the first N input rows")
    ap.add_argument("--resume", help="Checkpoint (.jsonl) of an earlier run: reuse what is complete")
    ap.add_argument("--workers", type=int, default=WORKERS, help=f"Parcels in parallel (default {WORKERS})")
    ap.add_argument("--verbose", "-v", action="store_true")
    args = ap.parse_args(argv)
    if not args.egrid and not args.input_path:
        ap.error("requires --egrid <EGRID[,EGRID…]> or --input <file>")
    check_sources()

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-8s %(name)s — %(message)s", datefmt="%H:%M:%S",
        handlers=[logging.StreamHandler(),
                  logging.FileHandler(out_dir / f"naturnah_{ts}.log", mode="w", encoding="utf-8")],
    )

    if args.input_path:
        rows = read_input(args.input_path)
    else:
        rows = [{"egrid": e} for e in (normalize_egrid(x) for x in args.egrid.split(",")) if e]
    if args.limit is not None:
        rows = rows[:args.limit]
    if not rows:
        logger.error("No rows to process.")
        return 1

    egrids = list(dict.fromkeys(r["egrid"] for r in rows if EGRID_RE.match(r["egrid"])))
    n_missing = sum(1 for r in rows if not r["egrid"])
    n_invalid = sum(1 for r in rows if r["egrid"] and not EGRID_RE.match(r["egrid"]))
    logger.info("%d row(s): %d without EGRID, %d with an invalid EGRID, %d distinct EGRID(s) to process "
                "(%d layers each)", len(rows), n_missing, n_invalid, len(egrids), len(sources.LAYERS))

    checkpoint = out_dir / f"naturnah_{ts}.jsonl"
    resume = load_checkpoint(args.resume) if args.resume else None
    results, aborted = run(egrids, checkpoint, resume, args.workers)
    results = {e: results[e] for e in egrids if e in results}   # input order

    records = build_rows(rows, results)
    n_found = sum(1 for r in results.values() if r["out"]["out_check_egrid"] == ST_FOUND)
    n_incomplete = sum(1 for r in results.values() if not r["complete"])
    n_hit = sum(1 for r in results.values() if (r["out"]["out_naturnah_total_m2"] or 0) > 0)
    write_xlsx(records, out_dir / f"naturnah_{ts}.xlsx")
    write_geojson(records, results, out_dir / f"naturnah_{ts}.geojson")
    logger.info("Done: %d of %d EGRID(s) queried, %d found, %d with near-natural area, %d incomplete → %s",
                len(results), len(egrids), n_found, n_hit, n_incomplete, out_dir)
    if aborted or n_incomplete or len(results) < len(egrids):
        logger.warning("Not everything could be queried. Re-run the same command with: --resume \"%s\"", checkpoint)
    return 2 if aborted else 0


if __name__ == "__main__":
    raise SystemExit(main())
