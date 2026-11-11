"""User parcel-list reader — a port of the web app's reader (processing-web/js/userinput.js).

Both the ``api`` path (:func:`read_rows`) and the gpkg pipeline
(:func:`read_dataframe`) read ID/EGRID lists through this module, so one file
behaves the same in the browser and in the CLI:

- ``.csv`` / ``.tsv`` / ``.txt``: UTF-8 (BOM stripped), else Windows-1252. An
  Excel ``sep=<d>`` hint line wins; otherwise the delimiter is detected from the
  header line (``;`` / tab / ``,``). Quoted fields may hold the delimiter, quotes
  (``""``) and line breaks. Cells are trimmed, blank lines dropped; a row shorter
  than the header is padded, cells beyond the header are dropped;
- an **SAP «Dynamische Listenausgabe»** ``.txt`` (pipe-framed table whose header
  row starts with ``|BuKr``): ``id`` = BuKr/WE/Grundstk, ``egrid`` = E-GRID, every
  other named column passed through;
- ``.xlsx`` / ``.xls``: first sheet, cells stringified the way SheetJS + JS
  ``String()`` do (``1086`` not ``1086.0``);
- headers are lowercased + trimmed, the required ``id`` / ``egrid`` columns matched
  case-insensitively (error naming the missing ones), a duplicate header lets the
  last column win; the EGRID is trimmed and upper-cased.

Nothing is interpreted: a cell reading ``NA`` or ``null`` stays that text.

The function names follow userinput.js (``parseDelimited`` ⇄ ``_parse_delimited``,
``parseSAP`` ⇄ ``_parse_sap`` …); tests/test_parity_js.py runs both on the same
texts.
"""

from __future__ import annotations

import datetime as _dt
import re
from pathlib import Path

import pandas as pd

REQUIRED_COLUMNS = ("id", "egrid")
CSV_SUFFIXES = (".csv", ".tsv", ".txt")
EXCEL_SUFFIXES = (".xlsx", ".xls")

_SEP_HINT_RE = re.compile(r'^"?sep=(.)"?(?:\r\n|\n|\r)', re.IGNORECASE)
# Blanks inside an EGRID: whitespace, no-break space, zero-width space, BOM.
_BLANKS_RE = re.compile(r"[\s" + chr(0xA0) + chr(0x200B) + chr(0xFEFF) + "]+")
_SAP_HEADER_RE = re.compile(r"^\|BuKr\|", re.MULTILINE)
_SAP_DATA_ROW_RE = re.compile(r"^\|\s*[0-9]")


# ---------------------------------------------------------------------------
# Text files
# ---------------------------------------------------------------------------

def _decode_text(data: bytes) -> str:
    """Bytes of a text file → str: UTF-8 (BOM stripped), else Windows-1252 (what
    Excel and SAP write on a German Windows). Mirror of decodeText()."""
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return data.decode("cp1252", errors="replace")


def _detect_delimiter(text: str) -> str:
    """Port of ``detectDelimiter``: count raw ``;`` / ``,`` / tab in the header line
    (the first non-blank one); semicolon only wins outright, tab beats comma, ties
    fall back to comma."""
    first_line = next((line for line in re.split(r"\r\n|\n|\r", text) if line.strip() != ""), "")
    semis = first_line.count(";")
    commas = first_line.count(",")
    tabs = first_line.count("\t")
    if semis > commas and semis > tabs:
        return ";"
    if tabs > commas:
        return "\t"
    return ","


def _tokenize_delimited(text: str, delimiter: str) -> list[list[str]]:
    """Port of ``tokenizeDelimited``: single-pass RFC-4180 tokenizer. Splits the whole
    text into rows of fields, handling quoted fields that contain the delimiter,
    quotes (``""``) or line breaks.

    A quote opens a quoted field only at the start of a field (leading blanks
    allowed). Anywhere else it is an ordinary character — ``Halle 3" breit`` used to
    open a quoted field that swallowed the rest of the file. A quoted field that is
    never closed is an error, not a one-row file.
    """
    rows: list[list[str]] = []
    row: list[str] = []
    field: list[str] = []
    in_quotes = False
    quote_line = 0   # line on which the open quote started (for the error)
    line = 1
    saw_any = False  # did this row have any character (so trailing data flushes)?
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if in_quotes:
            if ch == '"':
                if i + 1 < n and text[i + 1] == '"':
                    field.append('"')
                    i += 1
                else:
                    in_quotes = False
            else:
                if ch == "\n":
                    line += 1
                field.append(ch)
        elif ch == '"' and "".join(field).strip() == "":
            in_quotes, quote_line, saw_any = True, line, True
        elif ch == delimiter:
            row.append("".join(field))
            field, saw_any = [], True
        elif ch in "\n\r":
            if ch == "\r" and i + 1 < n and text[i + 1] == "\n":
                i += 1  # CRLF is one line break; a lone CR is one too
            row.append("".join(field))
            rows.append(row)
            row, field, saw_any = [], [], False
            line += 1
        else:
            field.append(ch)
            saw_any = True
        i += 1
    if in_quotes:
        raise ValueError(f"The quotation mark opened in line {quote_line} is never closed.")
    # Flush the final field/row if the text didn't end with a line break.
    if saw_any or field or row:
        row.append("".join(field))
        rows.append(row)
    return rows


def _parse_delimited(raw: str) -> tuple[list[str], list[dict]]:
    """Port of ``parseDelimited``: delimited text → ``(headers, rows)``."""
    text = raw
    # Honour a leading Excel "sep=<d>" hint line; otherwise auto-detect.
    hint = _SEP_HINT_RE.match(text)
    delimiter = hint.group(1) if hint else _detect_delimiter(text)
    if hint:
        text = text[hint.end():]

    matrix = [[c.strip() for c in cells] for cells in _tokenize_delimited(text, delimiter)]
    matrix = [cells for cells in matrix if any(c != "" for c in cells)]  # drop blank lines
    if len(matrix) < 2:
        raise ValueError("The file needs a header row and at least one data row.")

    headers = matrix[0]
    rows = [{h: (values[idx] if idx < len(values) else "") for idx, h in enumerate(headers)}
            for values in matrix[1:]]
    return headers, rows


def _is_sap_export(text: str) -> bool:
    """Port of ``isSapExport``: a pipe-delimited ``.txt`` whose column header row
    starts with ``|BuKr`` (banner / metadata lines sit above it)."""
    return _SAP_HEADER_RE.search(text) is not None


def _parse_sap(text: str) -> tuple[list[str], list[dict]]:
    """Port of ``parseSAP``: an SAP «Dynamische Listenausgabe» export → ``(headers, rows)``.

    The report is pipe-delimited with enclosing pipes and banner rows above the
    header; the dashed rules and the page footer are skipped. The two required
    columns are synthesized — ``id`` = BuKr/WE/Grundstk, ``egrid`` = E-GRID — and
    every other named column is passed through unchanged. A data row with a
    different number of cells than the header (a ``|`` inside a value would shift
    every column after it) stops the read with its line number.
    """
    lines = re.split(r"\r?\n", text)
    hi = next((i for i, line in enumerate(lines) if line.startswith("|BuKr")), -1)
    if hi < 0:
        raise ValueError("Not a readable SAP list export (no header row starting with |BuKr).")

    def split_row(line: str) -> list[str]:
        cells = line.split("|")
        return [c.strip() for c in cells[1:len(cells) - 1]]

    raw_headers = split_row(lines[hi])

    def col_index(name: str) -> int:
        return next((i for i, h in enumerate(raw_headers) if h.lower() == name.lower()), -1)

    i_bukr, i_we, i_grundstk, i_egrid = (col_index(n) for n in ("BuKr", "WE", "Grundstk", "E-GRID"))
    if min(i_bukr, i_we, i_grundstk, i_egrid) < 0:
        raise ValueError("SAP list export without the columns BuKr, WE, Grundstk and E-GRID.")

    # Pass-through columns: every named column except the id parts + E-GRID (consumed above).
    consumed = {i_bukr, i_we, i_grundstk, i_egrid}
    pass_cols = [(name, i) for i, name in enumerate(raw_headers) if name != "" and i not in consumed]

    headers = ["id", "egrid"] + [name for name, _ in pass_cols]
    rows: list[dict] = []
    for i in range(hi + 1, len(lines)):
        line = lines[i]
        if not _SAP_DATA_ROW_RE.match(line):
            continue  # skip the dashed rules, blank lines, and the footer
        cells = split_row(line)
        if len(cells) != len(raw_headers):
            raise ValueError(f"SAP list export: line {i + 1} has {len(cells)} cells, expected {len(raw_headers)}.")
        bukr, we, grundstk = cells[i_bukr], cells[i_we], cells[i_grundstk]
        if not bukr and not we and not grundstk:
            continue
        row = {"id": f"{bukr}/{we}/{grundstk}", "egrid": cells[i_egrid]}
        for name, ci in pass_cols:
            row[name] = cells[ci]
        rows.append(row)
    return headers, rows


def _parse_text(text: str) -> tuple[list[str], list[dict]]:
    """Port of ``parseText``: an SAP list export goes to its own reader, everything
    else to the generic delimited parser."""
    return _parse_sap(text) if _is_sap_export(text) else _parse_delimited(text)


# ---------------------------------------------------------------------------
# Excel
# ---------------------------------------------------------------------------

def _excel_cell_str(v) -> str:
    """Stringify an Excel cell like JS ``String()`` on the SheetJS value: ``1086``
    not ``1086.0``, booleans lower-case, a date as its serial number (SheetJS
    reads dates as numbers unless told otherwise)."""
    if v is None or (isinstance(v, float) and v != v):
        return ""
    if v is pd.NaT:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (_dt.datetime, _dt.date)):
        d = v if isinstance(v, _dt.datetime) else _dt.datetime(v.year, v.month, v.day)
        v = (d - _dt.datetime(1899, 12, 30)).total_seconds() / 86400
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _parse_excel(path: Path) -> tuple[list[str], list[dict]]:
    """Port of ``parseExcel``: first sheet → ``(headers, rows)``, every cell a string."""
    df = pd.read_excel(path, dtype=object, keep_default_na=False, na_filter=False)
    headers = [str(c) for c in df.columns]
    rows = [{h: _excel_cell_str(v) for h, v in zip(headers, values)}
            for values in df.itertuples(index=False, name=None)]
    if not rows:
        raise ValueError("The first sheet has no data rows.")
    return headers, rows


# ---------------------------------------------------------------------------
# Normalisation (the upload contract)
# ---------------------------------------------------------------------------

def normalize_egrid(s) -> str:
    """Canonical EGRID spelling: upper-cased, without blanks (``" ch 4277 6011 0057 "`` →
    ``"CH427760110057"``). map.geo.admin.ch writes the EGRID in groups; the parcel
    lookup matches it exactly, so a grouped spelling would end as "not found".
    Mirrors the web's normalizeEgrid() — applied at every input boundary so the same
    list resolves identically in the browser and the CLI."""
    if s is None or (isinstance(s, float) and s != s):
        return ""
    return _BLANKS_RE.sub("", str(s)).upper()


def _normalize_parsed(headers: list[str], rows: list[dict]) -> tuple[list[str], list[dict]]:
    """Port of ``normalizeParsed``: check the required columns, lowercase + trim the
    headers, trim every cell and canonicalise the EGRID. A column without a header
    (a trailing delimiter in the header row) is dropped; a duplicate lowercased
    header lets the last column win."""
    if not headers or not rows:
        raise ValueError("The file is empty.")
    lower = [str(h).lower().strip() for h in headers]
    missing = [c for c in REQUIRED_COLUMNS if c not in lower]
    if missing:
        raise ValueError(
            "Input file is missing required column(s): "
            f"{', '.join(missing)}. Found: {', '.join(headers)}"
        )
    out = []
    for row in rows:
        normalized = {low: str(row.get(h, "") or "").strip() for h, low in zip(headers, lower) if low != ""}
        normalized["egrid"] = normalize_egrid(normalized["egrid"])
        out.append(normalized)
    return list(dict.fromkeys(low for low in lower if low != "")), out


def _read_parsed(path: str | Path) -> tuple[list[str], list[dict]]:
    p = Path(path)
    suffix = p.suffix.lower()
    if suffix in CSV_SUFFIXES:
        headers, rows = _parse_text(_decode_text(p.read_bytes()))
    elif suffix in EXCEL_SUFFIXES:
        headers, rows = _parse_excel(p)
    else:
        raise ValueError(
            f"Unsupported file format: {suffix}  (expected {', '.join(CSV_SUFFIXES + EXCEL_SUFFIXES)})"
        )
    return _normalize_parsed(headers, rows)


def read_rows(path: str | Path) -> list[dict]:
    """Read a parcel list as web-shaped rows: lowercased keys, trimmed string
    values — ``[{"id": …, "egrid": …, <extra>: …}]``."""
    return _read_parsed(path)[1]


def read_dataframe(path: str | Path) -> pd.DataFrame:
    """Read a parcel list as a DataFrame for the gpkg pipeline: canonical
    ``ID`` / ``EGRID`` columns, every other column under its lowercased id."""
    headers, rows = _read_parsed(path)
    out = pd.DataFrame(rows, columns=headers)
    return out.rename(columns={"id": "ID", "egrid": "EGRID"})
