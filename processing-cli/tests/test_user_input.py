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


# --- behaviours pandas.read_csv got wrong (review 2026-11-10) -----------------

def test_trailing_delimiter_does_not_shift_the_columns(tmp_path):
    """Excel writes ``A1;CH…;`` when a deleted third column leaves its delimiter behind.
    pandas then took the first column as the index: id = the EGRID, egrid = empty."""
    p = _write(tmp_path, "t.csv", "ID;EGRID\nA1;CH111111111111;\nA2;CH222222222222;\n")
    assert read_rows(p) == [{"id": "A1", "egrid": "CH111111111111"}, {"id": "A2", "egrid": "CH222222222222"}]


def test_cells_are_text_never_missing_values(tmp_path):
    p = _write(tmp_path, "n.csv", "ID;EGRID;Kanton;Note\nNA;CH1;NA;null\nN/A;CH2;nan;None\n")
    assert read_rows(p) == [{"id": "NA", "egrid": "CH1", "kanton": "NA", "note": "null"},
                            {"id": "N/A", "egrid": "CH2", "kanton": "nan", "note": "None"}]


def test_short_and_long_rows_and_blank_lines(tmp_path):
    p = _write(tmp_path, "s.csv", "ID;EGRID;Note\r\nA1;CH1\r\n\r\n ; ; \r\nA2;CH2;x;surplus\r\n")
    assert read_rows(p) == [{"id": "A1", "egrid": "CH1", "note": ""}, {"id": "A2", "egrid": "CH2", "note": "x"}]


def test_quoted_fields(tmp_path):
    p = _write(tmp_path, "q.csv", 'ID;EGRID;Note\n"A;1";CH1;"say ""hi""\nline 2"\n')
    assert read_rows(p) == [{"id": "A;1", "egrid": "CH1", "note": 'say "hi"\nline 2'}]


def test_windows_1252_file_is_read(tmp_path):
    p = _write(tmp_path, "w.csv", "ID;EGRID;Straße\nA1;CH1;Zürich\n", encoding="cp1252")
    assert read_rows(p) == [{"id": "A1", "egrid": "CH1", "straße": "Zürich"}]


def test_header_only_and_empty_files_raise(tmp_path):
    with pytest.raises(ValueError, match="header row"):
        read_rows(_write(tmp_path, "h.csv", "ID;EGRID\n"))
    with pytest.raises(ValueError):
        read_rows(_write(tmp_path, "e.csv", ""))


SAP = """10.11.2026                  Dynamische Listenausgabe                 1
----------------------------------------------------------------------
Bericht             Infosystem: Grundstücke am 10.11.2026
----------------------------------------------------------------------
|BuKr|WE  |Grundstk|Bez. Grundstück      |E-GRID        |TPF|
----------------------------------------------------------------------
|9999|0001|1       |Musterdorf, Gbbl. 1  |ch111111111111|  9|
|9999|0002|2       |Parkplätze           |0000000000    |  3|
|9999|0003|1       |Ohne EGRID           |              |   |
----------------------------------------------------------------------
"""


def test_sap_list_export_is_read_like_the_web_app(tmp_path):
    rows = read_rows(_write(tmp_path, "sap.txt", SAP))
    assert rows[0] == {"id": "9999/0001/1", "egrid": "CH111111111111", "bez. grundstück": "Musterdorf, Gbbl. 1", "tpf": "9"}
    assert [r["id"] for r in rows] == ["9999/0001/1", "9999/0002/2", "9999/0003/1"]
    assert [r["egrid"] for r in rows] == ["CH111111111111", "0000000000", ""]
    df = read_dataframe(_write(tmp_path, "sap2.txt", SAP))
    assert list(df.columns) == ["ID", "EGRID", "bez. grundstück", "tpf"]


def test_sap_row_with_a_pipe_in_a_value_stops_the_read(tmp_path):
    bad = SAP.replace("Parkplätze           ", "Park|plätze          ")
    with pytest.raises(ValueError, match="line 8"):
        read_rows(_write(tmp_path, "bad.txt", bad))


def test_excel_cells_like_sheetjs(tmp_path):
    import datetime

    pd = pytest.importorskip("pandas")
    pytest.importorskip("openpyxl")
    p = tmp_path / "x.xlsx"
    pd.DataFrame({"ID": ["NA", 7], "EGRID": ["CH1", None], "Aktiv": [True, False],
                  "Datum": [datetime.datetime(2026, 11, 10), None]}).to_excel(p, index=False)
    assert read_rows(p) == [{"id": "NA", "egrid": "CH1", "aktiv": "true", "datum": "46336"},
                            {"id": "7", "egrid": "", "aktiv": "false", "datum": ""}]
