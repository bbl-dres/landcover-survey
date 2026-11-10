"""Input list reader for the near-natural sample analysis.

One column is required: **EGRID** (header ``EGRID`` or ``E-GRID``). All other
columns are free and vary from list to list. Every column is kept: its header is
turned into an attribute name by :func:`slug` (``Bez. Grundstück`` →
``bez_grundstueck``) and the output prefixes it with ``in_``. Nothing in here
knows a column other than EGRID.

Formats:

- **SAP list export** («Dynamische Listenausgabe», ``.txt``): a table whose rows
  start and end with ``|``. Title, page header and separator lines are skipped,
  a header row repeated on a later page too.
- **CSV / Excel**: delimiter detection and cell handling as in the main CLI
  (:mod:`user_input`).
"""

from __future__ import annotations

import re
from pathlib import Path

import pandas as pd

import user_input
from user_input import normalize_egrid

_TRANSLIT = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss", "é": "e", "è": "e", "à": "a"})
_EGRID_SLUGS = ("egrid", "e_grid")


def slug(header: str) -> str:
    """``"Bez. Grundstück"`` → ``"bez_grundstueck"``; ``"E-GRID"`` → ``"egrid"``."""
    s = re.sub(r"[^a-z0-9]+", "_", str(header).strip().lower().translate(_TRANSLIT)).strip("_")
    return "egrid" if s in _EGRID_SLUGS else s


def _unique(names: list[str]) -> list[str]:
    """Slugged headers, made unique (``x``, ``x_2``, …); an empty header becomes ``col``."""
    out: list[str] = []
    for n in names:
        base = n or "col"
        name, i = base, 2
        while name in out:
            name, i = f"{base}_{i}", i + 1
        out.append(name)
    return out


# ---------------------------------------------------------------------------
# Formats → (headers, rows of cells)
# ---------------------------------------------------------------------------

def is_sap_list(text: str) -> bool:
    """True when *text* holds a ``|``-framed table (SAP list export)."""
    return sum(1 for line in text.splitlines()[:200] if line.startswith("|") and line.rstrip().endswith("|")) >= 2


def parse_sap_list(text: str) -> tuple[list[str], list[list[str]]]:
    """``(headers, rows)`` of a SAP list export; cells are trimmed strings.

    The first ``|`` row is the header. Raises ``ValueError`` when a data row has a
    different number of cells (a ``|`` inside a value would shift every column
    after it).
    """
    table = [(no, line.rstrip()) for no, line in enumerate(text.splitlines(), 1) if line.startswith("|")]
    if not table:
        raise ValueError("No table rows (lines starting with '|') found in the SAP list.")
    split = lambda line: [c.strip() for c in line.strip()[1:-1].split("|")]  # noqa: E731
    headers = split(table[0][1])
    rows: list[list[str]] = []
    for no, line in table[1:]:
        cells = split(line)
        if cells == headers:             # header repeated on a new page
            continue
        if len(cells) != len(headers):
            raise ValueError(f"Line {no}: {len(cells)} cells, expected {len(headers)} (a '|' inside a value?)")
        rows.append(cells)
    return headers, rows


def _read_table(p: Path) -> tuple[list[str], list[list[str]]]:
    """``(headers, rows)`` of a CSV or Excel file, cells as trimmed strings."""
    suffix = p.suffix.lower()
    if suffix in user_input.EXCEL_SUFFIXES:
        df = pd.read_excel(p)
        df = df.apply(lambda col: col.map(user_input._excel_cell_str))
    elif suffix in user_input.CSV_SUFFIXES:
        with open(p, encoding="utf-8-sig") as fh:
            first = fh.readline()
        if first.lower().startswith("sep="):
            delim, skip = (first.strip()[4:5] or ";"), 1
        else:
            delim, skip = user_input._detect_delimiter(first), 0
        df = pd.read_csv(p, dtype=str, sep=delim, skiprows=skip, encoding="utf-8-sig")
    else:
        raise ValueError(f"Unsupported file format: {suffix}")
    return [str(c) for c in df.columns], [[user_input._cell(v) for v in row] for row in df.itertuples(index=False)]


# ---------------------------------------------------------------------------
# Public
# ---------------------------------------------------------------------------

def read_input(path: str | Path) -> list[dict]:
    """Read a parcel list → ``[{attribute: value}]``, all values trimmed strings.

    Every row carries ``egrid`` (trimmed, upper-cased; may be empty) plus all
    other columns under their slugged names, in file order. Raises ``ValueError``
    when there is no EGRID column.
    """
    p = Path(path)
    headers = rows = None
    if p.suffix.lower() in (".txt", ".lst"):
        try:
            text = p.read_text(encoding="utf-8-sig")
        except UnicodeDecodeError:       # SAP exports are written in the Windows code page by default
            text = p.read_text(encoding="cp1252")
        if is_sap_list(text):
            headers, rows = parse_sap_list(text)
    if headers is None:
        headers, rows = _read_table(p)

    cols = _unique([slug(h) for h in headers])
    if "egrid" not in cols:
        found = ", ".join(h.strip() for h in headers)
        raise ValueError(f"The input has no EGRID column (EGRID or E-GRID). Found: {found}")
    out: list[dict] = []
    for cells in rows:
        row = dict(zip(cols, cells))
        row["egrid"] = normalize_egrid(row["egrid"])
        out.append(row)
    return out
