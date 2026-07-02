"""Shared user-input reader — one file contract for every entry point.

Mirrors the web upload (``web/js/upload.js``) so a parcel list that works in the
browser works identically in both CLI paths:

- delimiter auto-detection from the header line (``,`` / ``;`` / tab; comma wins
  ties, exactly like the web's ``detectDelimiter``), plus a leading Excel
  ``sep=<d>`` hint line;
- UTF-8 with optional BOM;
- **required ``id`` + ``egrid`` columns, matched case-insensitively**; all
  headers lowercased + trimmed (a duplicate lowercased header keeps the last
  column, matching the web's row normalisation); cell values trimmed;
- Excel cells stringified like the web (SheetJS ``String()``): an
  integer-valued numeric cell becomes ``"123"``, never ``"123.0"``.

:func:`read_rows` returns the web-shaped ``[{"id", "egrid", …}]`` list (api
path); :func:`read_dataframe` returns a DataFrame with canonical ``ID`` /
``EGRID`` columns (gpkg pipeline).
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

CSV_SUFFIXES = (".csv", ".tsv", ".txt")
EXCEL_SUFFIXES = (".xlsx", ".xls")


def _excel_cell_str(v) -> str:
    """Stringify an Excel cell like JS ``String()`` on the SheetJS value."""
    if pd.isna(v):
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _detect_delimiter(first_line: str) -> str:
    """Port of the web's ``detectDelimiter``: count raw ``;`` / ``,`` / tab in
    the header line; semicolon only wins outright, tab beats comma, ties fall
    back to comma."""
    semis = first_line.count(";")
    commas = first_line.count(",")
    tabs = first_line.count("\t")
    if semis > commas and semis > tabs:
        return ";"
    if tabs > commas:
        return "\t"
    return ","


def _read_raw(path: str | Path):
    """Read the file and validate headers.

    Returns ``(df, lower)`` where *lower* holds the lowercased + trimmed header
    per raw column. Raises ``ValueError`` on an unsupported suffix or when the
    required ``id`` / ``egrid`` columns are missing.
    """
    p = Path(path)
    suffix = p.suffix.lower()

    if suffix in EXCEL_SUFFIXES:
        df = pd.read_excel(p)  # keep cell types; stringified like the web below
        df = df.apply(lambda col: col.map(_excel_cell_str))
    elif suffix in CSV_SUFFIXES:
        with open(p, encoding="utf-8-sig") as fh:
            first = fh.readline()
        if first.lower().startswith("sep="):
            delim, skip = (first.strip()[4:5] or ";"), 1
        else:
            delim, skip = _detect_delimiter(first), 0
        df = pd.read_csv(p, dtype=str, sep=delim, skiprows=skip, encoding="utf-8-sig")
    else:
        raise ValueError(
            f"Unsupported file format: {suffix}  (expected {', '.join(CSV_SUFFIXES + EXCEL_SUFFIXES)})"
        )

    trimmed = [str(c).strip() for c in df.columns]
    lower = [c.lower() for c in trimmed]

    missing = [c for c in ("id", "egrid") if c not in lower]
    if missing:
        raise ValueError(
            "Input file is missing required column(s): "
            f"{', '.join(missing)}. Found: {', '.join(trimmed)}"
        )
    return df, lower


def _cell(v) -> str:
    return "" if pd.isna(v) else str(v).strip()


def read_rows(path: str | Path) -> list[dict]:
    """Read a parcel list as web-shaped rows: lowercased keys, trimmed string
    values — ``[{"id": …, "egrid": …, <extra>: …}]``."""
    df, lower = _read_raw(path)
    rows: list[dict] = []
    for _, r in df.iterrows():
        # lowercased header → trimmed value; a duplicate lowercased header lets
        # the last column win, matching the web's row-object normalisation.
        rows.append({low: _cell(r[raw]) for raw, low in zip(df.columns, lower)})
    return rows


def read_dataframe(path: str | Path) -> pd.DataFrame:
    """Read a parcel list as a DataFrame for the gpkg pipeline: canonical
    ``ID`` / ``EGRID`` columns, every other column under its lowercased id."""
    df, lower = _read_raw(path)
    headers = list(dict.fromkeys(lower))  # dedupe, first-seen order
    rows = [{low: _cell(r[raw]) for raw, low in zip(df.columns, lower)}
            for _, r in df.iterrows()]
    out = pd.DataFrame(rows, columns=headers)
    return out.rename(columns={"id": "ID", "egrid": "EGRID"})
