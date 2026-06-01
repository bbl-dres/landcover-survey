"""
Join SAP parcel export with SAP measurement export (GSF Grundstückfläche).
=========================================================================

Produces a single CSV containing every attribute from the parcel export, plus a
canonical ``id`` (``BuKr/WE/Grundstk``) and the plot area ``GSF_m2`` joined from
the measurement export. The parcel ``E-GRID`` column is emitted as ``egrid`` so
the UTF-8 output uploads straight to the web app — no Excel round-trip (which
would re-save the file as ANSI/Windows-1252 and corrupt umlauts like
``Grundstück`` → ``Grundst?ck``).

Both inputs are SAP "Dynamische Listenausgabe" text reports: UTF-8 (with BOM),
pipe-delimited tables (``|col|col|``) whose column header is on row 11 and
repeats on every page break, interleaved with ``---`` separator rules and
page-header noise.

  * Parcels      ("Grundstück SAP")  columns: BuKr, WE, Grundstk,
                                     Bez. Grundstück, Ort, PLZ, E-GRID, ...
                                     (ALL columns are carried into the output)
  * Measurements ("Bemessungen GR")  columns: Ident. AO, BezAOTyp,
                                     Nummer AO, Bem.Art Mitt, Größe, Einh, ...

Filter (measurements)
---------------------
Keep rows where ``BezAOTyp == "Grundstück"`` (the parcel total, NOT the
``Grundstücksfläche`` sub-areas) and ``Bem.Art Mitt == "GSF Grundstückfläche"``;
the area is the ``Größe`` column (US-formatted, e.g. ``1,300.7060``).

Join
----
The measurement ``Ident. AO`` is ``WE.Grundstk`` (e.g. ``1502.3``). It carries
no BuKr, so the canonical object key ``BuKr/WE/Grundstk`` (e.g. ``1086/1502/3``)
is built from the parcel file, where BuKr is present (always 1086 in this
export). Parcels are LEFT-joined to measurements on ``f"{WE}.{Grundstk}"`` —
every parcel is kept; those without a parcel-level GSF measurement get an empty
``GSF_m2``.

Note: umlaut literals below use ``\\uXXXX`` escapes so the column/filter strings
are unaffected by the source file's encoding. Output column headers are read
straight from the parcel file, so they always match the source.

Usage
-----
    python join_sap_measurements.py
    python join_sap_measurements.py --parcels P.txt --measurements B.txt --output out.csv
    python join_sap_measurements.py --only-matched --delimiter ,

Run  python join_sap_measurements.py --help  for all options.
"""

from __future__ import annotations

import argparse
import csv
import logging
from pathlib import Path

logger = logging.getLogger("join_sap")

# --- Defaults (the files this script was built for) ---
DEFAULT_PARCELS = Path("C:\\Users\\david\\Downloads\\260601_Grundstück SAP.txt")
DEFAULT_MEASUREMENTS = Path("C:\\Users\\david\\Downloads\\260601_Bemessungen GR.txt")

# --- Key columns (umlauts as \u escapes; output carries all parcel columns) ---
COL_BUKR = "BuKr"
COL_WE = "WE"
COL_GRUNDSTK = "Grundstk"
COL_IDENT = "Ident. AO"
COL_BEZAOTYP = "BezAOTyp"
COL_BEMART = "Bem.Art Mitt"
COL_GROESSE = "Größe"          # Größe

# --- Measurement filter values ---
FILTER_BEZAOTYP = "Grundstück"                      # Grundstück
FILTER_BEMART = "GSF Grundstückfläche"          # GSF Grundstückfläche

# Characters to strip from numbers: spaces (incl. nbsp / narrow nbsp), apostrophe
# variants, and the comma thousands separator. The decimal point is kept.
_STRIP_FROM_NUMBER = "   ʼ’'`,"


# --------------------------------------------------------------------------- #
# SAP list-report parsing
# --------------------------------------------------------------------------- #
def _split_row(line: str) -> list[str]:
    """Split a ``|a|b|c|`` table line into stripped cells (no outer empties)."""
    parts = [c.strip() for c in line.split("|")]
    if parts and parts[0] == "":
        parts = parts[1:]
    if parts and parts[-1] == "":
        parts = parts[:-1]
    return parts


def _is_separator(cells: list[str]) -> bool:
    """True for blank rows and ``---`` rule rows."""
    return all(c == "" or set(c) == {"-"} for c in cells)


def parse_sap_table(path: Path) -> tuple[list[str], list[list[str]]]:
    """Parse a SAP pipe-delimited list report into (header, data_rows).

    Skips page-header/footer noise (lines without ``|``), separator rules, and
    the column header repeated on each page break.
    """
    with open(path, encoding="utf-8-sig") as f:
        lines = [ln.rstrip("\r") for ln in f.read().split("\n")]

    header: list[str] | None = None
    rows: list[list[str]] = []
    for ln in lines:
        if "|" not in ln:
            continue  # page title / "Bericht" / date / warning lines
        cells = _split_row(ln)
        if not cells or _is_separator(cells):
            continue
        if header is None:
            header = cells  # first real table row is the column header (row 11)
            continue
        if cells == header:
            continue  # header repeated on a later page
        rows.append(cells)

    if header is None:
        raise ValueError(f"No table header found in {path}")
    return header, rows


def col_index(header: list[str], name: str, path: Path) -> int:
    try:
        return header.index(name)
    except ValueError:
        raise ValueError(f"Column {name!r} not found in {path.name}. Columns: {header}") from None


def fit(row: list[str], width: int) -> list[str]:
    """Pad/truncate a row to exactly ``width`` cells (keeps the CSV rectangular)."""
    if len(row) < width:
        return row + [""] * (width - len(row))
    if len(row) > width:
        logger.warning("Row has %d cells (expected %d) — truncating: %r", len(row), width, row)
        return row[:width]
    return row


def parse_area(raw: str) -> float | None:
    """Parse a US-formatted SAP number (``1,300.7060`` -> 1300.706)."""
    s = raw.strip()
    if not s:
        return None
    for ch in _STRIP_FROM_NUMBER:
        s = s.replace(ch, "")
    try:
        return float(s)
    except ValueError:
        logger.warning("Could not parse area value %r", raw)
        return None


def _norm_egrid(col: str) -> bool:
    """True if a parcel column is the E-GRID column (`E-GRID`, `EGRID`, `e_grid`, …)."""
    return "".join(ch for ch in col.lower() if ch.isalnum()) == "egrid"


def format_area(value: float | None) -> str:
    if value is None:
        return ""
    value = round(value, 4)
    if value == int(value):
        return str(int(value))
    return f"{value:.4f}".rstrip("0").rstrip(".")


# --------------------------------------------------------------------------- #
# Pipeline
# --------------------------------------------------------------------------- #
def load_gsf_areas(path: Path) -> dict[str, float | None]:
    """Return {Ident. AO: area_m2} for parcel-level GSF Grundstückfläche rows."""
    header, rows = parse_sap_table(path)
    i_ident = col_index(header, COL_IDENT, path)
    i_typ = col_index(header, COL_BEZAOTYP, path)
    i_mitt = col_index(header, COL_BEMART, path)
    i_gr = col_index(header, COL_GROESSE, path)
    need = max(i_ident, i_typ, i_mitt, i_gr)

    areas: dict[str, float | None] = {}
    n_seen = 0
    for r in rows:
        if len(r) <= need:
            continue
        if r[i_typ] != FILTER_BEZAOTYP or r[i_mitt] != FILTER_BEMART:
            continue
        n_seen += 1
        ident = r[i_ident]
        if ident in areas:
            logger.warning("Duplicate GSF measurement for %s — keeping the first", ident)
            continue
        areas[ident] = parse_area(r[i_gr])
    logger.info("GSF measurements: %d rows, %d unique parcels", n_seen, len(areas))
    return areas


def run(parcels_path: Path, measurements_path: Path, output_path: Path,
        delimiter: str, only_matched: bool, excel_hint: bool) -> None:
    p_header, p_rows = parse_sap_table(parcels_path)
    i_bukr = col_index(p_header, COL_BUKR, parcels_path)
    i_we = col_index(p_header, COL_WE, parcels_path)
    i_gst = col_index(p_header, COL_GRUNDSTK, parcels_path)
    width = len(p_header)

    # Deduplicate parcels on WE.Grundstk, keeping the first occurrence.
    parcels: list[tuple[str, list[str]]] = []
    seen: set[str] = set()
    for r in p_rows:
        r = fit(r, width)
        if not r[i_we] or not r[i_gst]:
            continue
        key = f"{r[i_we]}.{r[i_gst]}"
        if key in seen:
            logger.warning("Duplicate parcel %s/%s/%s — keeping the first", r[i_bukr], r[i_we], r[i_gst])
            continue
        seen.add(key)
        parcels.append((key, r))
    logger.info("Parcels: %d unique", len(parcels))

    areas = load_gsf_areas(measurements_path)

    # Emit web-app-ready headers so the UTF-8 output uploads directly (no Excel
    # round-trip, which would re-save the file as ANSI and corrupt umlauts):
    # the leading key column is named `id`, and the parcel E-GRID column is
    # renamed to `egrid`. Both are matched case-/separator-insensitively.
    parcel_out_header = ["egrid" if _norm_egrid(c) else c for c in p_header]
    out_header = ["id"] + parcel_out_header + ["GSF_m2"]
    matched = 0
    out_rows: list[tuple[tuple, list[str]]] = []
    for key, r in parcels:
        area = areas.get(key)
        if area is not None:
            matched += 1
        elif only_matched:
            continue
        objektkey = f"{r[i_bukr]}/{r[i_we]}/{r[i_gst]}"
        out_rows.append((_sort_key(r[i_we], r[i_gst]), [objektkey] + r + [format_area(area)]))

    out_rows.sort(key=lambda t: t[0])

    with open(output_path, "w", encoding="utf-8-sig", newline="") as f:
        if excel_hint:
            # Excel reads this directive and uses the right delimiter regardless
            # of the user's locale list-separator setting.
            f.write(f"sep={delimiter}\r\n")
        writer = csv.writer(f, delimiter=delimiter)
        writer.writerow(out_header)
        writer.writerows(row for _, row in out_rows)

    extra = sorted(set(areas) - seen)
    logger.info("Wrote %d rows (%d columns) to %s", len(out_rows), len(out_header), output_path)
    logger.info("Parcels with GSF area: %d | without: %d", matched, len(parcels) - matched)
    if extra:
        logger.warning("%d GSF measurements had no matching parcel (e.g. %s)",
                       len(extra), ", ".join(extra[:8]))


def _sort_key(we: str, grundstk: str):
    def num(x: str):
        return (0, int(x)) if x.isdigit() else (1, x)
    return (num(we), num(grundstk))


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="join_sap_measurements",
        description="Join SAP parcel and measurement exports into one CSV (all parcel attributes + GSF area).",
    )
    parser.add_argument("--parcels", type=Path, default=DEFAULT_PARCELS,
                        help=f"SAP parcel export (default: {DEFAULT_PARCELS})")
    parser.add_argument("--measurements", type=Path, default=DEFAULT_MEASUREMENTS,
                        help=f"SAP measurement export (default: {DEFAULT_MEASUREMENTS})")
    parser.add_argument("--output", type=Path, default=None,
                        help="Output CSV (default: '<parcels dir>/parcels_gsf.csv')")
    parser.add_argument("--delimiter", default=";",
                        help="CSV delimiter (default: ';' for Excel DE/CH)")
    parser.add_argument("--only-matched", action="store_true",
                        help="Output only parcels that have a GSF measurement")
    parser.add_argument("--sep-line", action="store_true",
                        help="Prepend an Excel 'sep=' hint line (only needed if your Excel locale uses a different separator)")
    parser.add_argument("--verbose", "-v", action="store_true", help="Enable DEBUG logging")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)-8s %(message)s",
    )

    if not args.parcels.exists():
        parser.error(f"Parcels file not found: {args.parcels}")
    if not args.measurements.exists():
        parser.error(f"Measurements file not found: {args.measurements}")

    output = args.output or args.parcels.with_name("parcels_gsf.csv")
    run(args.parcels, args.measurements, output, args.delimiter, args.only_matched,
        excel_hint=args.sep_line)


if __name__ == "__main__":
    main()
