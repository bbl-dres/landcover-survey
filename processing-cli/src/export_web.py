"""Exporters for the API path — GeoJSON / Excel / CSV, matching processing-web/js/export.js.

Same column sets, same semicolon-delimited UTF-8-BOM CSV, and the same combined
GeoJSON ``FeatureCollection`` where every feature carries a ``layer`` property
(``parcel`` | ``landcover`` | ``bauzonen`` | ``habitat``) and the ``_``-prefixed
internal keys are dropped (``_geometry`` becomes the feature geometry).

Numbers are normalised to match JS ``JSON.stringify`` / ``String(number)``: an
integer-valued area (e.g. ``0.0``) is written ``0``, not ``0.0`` — so the files
line up textually with the web export, not just numerically.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from shapely.geometry import mapping

logger = logging.getLogger(__name__)

# Fixed detail-layer column orders (export.js).
LANDCOVER_HEADERS = ["id", "egrid", "fid", "art", "bfsnr", "gwr_egid", "check_greenspace",
                     "av_kategorie", "av_produktiv", "av_typ", "area_m2", "lc_source", "prob"]
BAUZONEN_HEADERS = ["id", "egrid", "fid", "art", "bauzone_code", "area_m2", "lc_source"]
HABITAT_HEADERS = ["id", "egrid", "fid", "art", "typoch_l1", "typoch_l2", "typoch_l3", "check_greenspace",
                   "av_kategorie", "av_produktiv", "av_typ", "area_m2", "prob", "lc_source"]


def _norm_num(v):
    """Integer-valued float → int (so 0.0 serialises as ``0``, matching JS). A NaN
    or infinity becomes an empty value: ``json`` would write the bare token ``NaN``,
    which no JSON parser accepts — one such cell made the whole export unreadable."""
    if isinstance(v, float):
        if v != v or v in (float("inf"), float("-inf")):
            return ""
        if v.is_integer():
            return int(v)
    return v


def _public_props(row: dict) -> dict:
    """Row → output properties: drop ``_``-prefixed keys, normalise numbers."""
    return {k: _norm_num(v) for k, v in row.items() if not k.startswith("_")}


def _union_headers(rows: list) -> list:
    """Union of non-``_`` keys across rows, first-seen order (export.js unionHeaders)."""
    seen: dict[str, None] = {}
    for r in rows:
        for k in r:
            if not k.startswith("_"):
                seen.setdefault(k)
    return list(seen)


# ---------------------------------------------------------------------------
# GeoJSON
# ---------------------------------------------------------------------------

def _to_feature(row: dict, layer: str) -> dict:
    props = {"layer": layer}
    props.update(_public_props(row))
    g = row.get("_geometry")
    return {"type": "Feature", "geometry": mapping(g) if g is not None else None, "properties": props}


def build_geojson(results: dict) -> str:
    """All analysed layers as one GeoJSON FeatureCollection, as text (parcels first).

    Compact, one feature per line: a pretty-printed export of ~2,100 parcels was
    437 MB, 81 % of the largest string a browser can hold (the dashboard reads the
    file as one string); compact it is a third of that. Mirror of buildGeoJSON().
    """
    features = []
    for p in results.get("parcels", []):
        features.append(_to_feature(p, "parcel"))
    for lc in results.get("landcover", []):
        features.append(_to_feature(lc, "landcover"))
    for bz in results.get("bauzonen", []):
        features.append(_to_feature(bz, "bauzonen"))
    for h in results.get("habitat", []):
        features.append(_to_feature(h, "habitat"))
    nl = chr(10)
    lines = [json.dumps(f, ensure_ascii=False, separators=(",", ":"), allow_nan=False) for f in features]
    return '{"type":"FeatureCollection","features":[' + nl + ("," + nl).join(lines) + nl + "]}"


def write_geojson(results: dict, path: str | Path) -> None:
    """Write all analysed layers as one GeoJSON file (see :func:`build_geojson`)."""
    text = build_geojson(results)
    _write_text(text, path)
    logger.info("Wrote %d features to %s", text.count(chr(10)) - 1, Path(path).name)


# ---------------------------------------------------------------------------
# CSV (semicolon-delimited, UTF-8 BOM) — parcels + land cover, as in the web
# ---------------------------------------------------------------------------

def _csv_cell(val) -> str:
    if isinstance(val, list):
        val = "; ".join(str(x) for x in val)
    v = "" if val is None else str(_norm_num(val))
    v = v.replace('"', '""')
    if ";" in v or '"' in v or "\n" in v:
        return f'"{v}"'
    return v


def _build_csv(rows: list, headers: list) -> str:
    lines = [";".join(headers)]
    for row in rows:
        lines.append(";".join(_csv_cell(row.get(h, "")) for h in headers))
    return chr(0xFEFF) + "\n".join(lines)  # UTF-8 BOM, as in the web export


def write_parcels_csv(parcels: list, path: str | Path) -> None:
    if not parcels:
        return
    headers = _union_headers(parcels)
    _write_text(_build_csv(parcels, headers), path)
    logger.info("Wrote %d parcels to %s", len(parcels), Path(path).name)


def write_landcover_csv(landcover: list, path: str | Path) -> None:
    if not landcover:
        return
    _write_text(_build_csv(landcover, LANDCOVER_HEADERS), path)
    logger.info("Wrote %d land cover rows to %s", len(landcover), Path(path).name)


def _write_text(text: str, path: str | Path) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # newline="" so the "\n" line separators aren't translated to CRLF on Windows,
    # matching the web app's byte output.
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)


# ---------------------------------------------------------------------------
# Excel — one sheet per layer (openpyxl)
# ---------------------------------------------------------------------------

def _cell_value(v):
    if isinstance(v, list):
        v = "; ".join(str(x) for x in v)
    if v is None:
        return ""
    if isinstance(v, str):
        # openpyxl raises on control characters — one stray byte in an input column
        # would abort the export after the whole run.
        from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
        return ILLEGAL_CHARACTERS_RE.sub("", v)
    return _norm_num(v)


def _append_row(sheet, values: list) -> None:
    """Append plain values. A text starting with ``=`` stays text (openpyxl would
    store it as a formula; the web export, SheetJS, writes it as text too)."""
    sheet.append(values)
    if any(isinstance(v, str) and v.startswith("=") for v in values):
        for cell in sheet[sheet._current_row]:
            if cell.data_type == "f":
                cell.data_type = "s"


def _safe_sheet_name(name: str) -> str:
    for ch in ':\\/?*[]':
        name = name.replace(ch, " ")
    return name[:31]


def write_xlsx(results: dict, path: str | Path) -> None:
    """Write parcels + each non-empty detail layer to its own sheet."""
    from openpyxl import Workbook

    parcels = results.get("parcels", [])
    if not parcels:
        return
    wb = Workbook()

    # Sheet names match the web app's German export (the web translates its tab
    # names per UI language; German is the reference since the data endpoint is
    # pinned to deu) — so web and Python workbooks diff cleanly sheet-for-sheet.
    ws = wb.active
    ws.title = _safe_sheet_name("Grundstücke")
    p_headers = _union_headers(parcels)
    ws.append(p_headers)
    for p in parcels:
        _append_row(ws, [_cell_value(p.get(h, "")) for h in p_headers])

    def add_sheet(rows, headers, name):
        if not rows:
            return
        sheet = wb.create_sheet(_safe_sheet_name(name))
        sheet.append(headers)
        for row in rows:
            _append_row(sheet, [_cell_value(row.get(h, "")) for h in headers])

    add_sheet(results.get("landcover", []), LANDCOVER_HEADERS, "Bodenbedeckung")
    add_sheet(results.get("bauzonen", []), BAUZONEN_HEADERS, "Bauzonen")
    add_sheet(results.get("habitat", []), HABITAT_HEADERS, "Lebensräume")

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(path)
    logger.info("Wrote Excel workbook to %s", path.name)
