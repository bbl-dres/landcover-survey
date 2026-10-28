"""The shared input reader honours the web upload contract (upload.js)."""

from __future__ import annotations

import pytest

from user_input import normalize_egrid, read_dataframe, read_rows


def _write(tmp_path, name, text, encoding="utf-8"):
    p = tmp_path / name
    p.write_text(text, encoding=encoding, newline="")
    return p


def test_semicolon_with_bom_and_trimming(tmp_path):
    p = _write(tmp_path, "a.csv", "﻿ID;EGRID;Ort\n 1086/1/1 ; ch307635204644 ; Bern \n", encoding="utf-8")
    assert read_rows(p) == [{"id": "1086/1/1", "egrid": "CH307635204644", "ort": "Bern"}]


def test_comma_default_and_sep_hint(tmp_path):
    p = _write(tmp_path, "b.csv", "id,egrid\n1,CH1\n")
    assert read_rows(p) == [{"id": "1", "egrid": "CH1"}]
    # Excel's "sep=" hint line wins over detection.
    p = _write(tmp_path, "c.csv", "sep=;\nid;egrid\n2;CH2\n")
    assert read_rows(p) == [{"id": "2", "egrid": "CH2"}]


def test_tab_delimited(tmp_path):
    p = _write(tmp_path, "d.tsv", "id\tegrid\tnote\n3\tCH3\tx,y;z\n")
    assert read_rows(p) == [{"id": "3", "egrid": "CH3", "note": "x,y;z"}]


def test_headers_lowercased_last_duplicate_wins(tmp_path):
    p = _write(tmp_path, "e.csv", "Id;EGRID;Name;name\n4;CH4;first;second\n")
    rows = read_rows(p)
    assert rows == [{"id": "4", "egrid": "CH4", "name": "second"}]


def test_missing_required_column_raises(tmp_path):
    p = _write(tmp_path, "f.csv", "id;parcel\n5;CH5\n")
    with pytest.raises(ValueError, match="egrid"):
        read_rows(p)


def test_dataframe_variant_canonical_columns(tmp_path):
    p = _write(tmp_path, "g.csv", "ID;EGRID;Ort\n6; ch6 ;Thun\n")
    df = read_dataframe(p)
    assert list(df.columns) == ["ID", "EGRID", "ort"]
    assert df.iloc[0].tolist() == ["6", "CH6", "Thun"]


def test_excel_numeric_cells_stringified_like_sheetjs(tmp_path):
    pd = pytest.importorskip("pandas")
    pytest.importorskip("openpyxl")
    p = tmp_path / "h.xlsx"
    pd.DataFrame({"ID": [1086, 12.5], "EGRID": [" ch1 ", None], "Ort": ["A", "B"]}).to_excel(p, index=False)
    rows = read_rows(p)
    assert rows[0] == {"id": "1086", "egrid": "CH1", "ort": "A"}   # 1086, never "1086.0"
    assert rows[1] == {"id": "12.5", "egrid": "", "ort": "B"}


def test_normalize_egrid():
    assert normalize_egrid(" ch427760110057 ") == "CH427760110057"
    assert normalize_egrid(None) == ""
    assert normalize_egrid(float("nan")) == ""
