"""Exporters match the web's serialisation rules (export.js)."""

from __future__ import annotations

import json

from shapely.geometry import box

import export_web as E


def test_csv_cell_quoting_and_number_normalisation():
    assert E._csv_cell(12.0) == "12"          # JS String(12) — never "12.0"
    assert E._csv_cell(12.5) == "12.5"
    assert E._csv_cell("a;b") == '"a;b"'
    assert E._csv_cell('say "hi"') == '"say ""hi"""'
    assert E._csv_cell(["Invalid EGRID", "x"]) == '"Invalid EGRID; x"'  # joined, then quoted (contains ";")
    assert E._csv_cell(None) == ""


def test_csv_has_bom_semicolons_and_union_header():
    rows = [{"id": "1", "egrid": "CH1", "_geometry": None, "a": 1.0}, {"id": "2", "egrid": "CH2", "b": "x"}]
    text = E._build_csv(rows, E._union_headers(rows))
    assert text.startswith("﻿id;egrid;a;b\n")
    assert text.splitlines()[1:] == ["1;CH1;1;", "2;CH2;;x"]


def test_geojson_tags_layers_and_drops_internal_keys(tmp_path):
    parcel = {"id": "1", "egrid": "CH1", "bfsnr": 3203, "nbident": "SG0200320300", "_geometry": box(9, 47, 9.1, 47.1), "_landcover": []}
    lc = {"id": "1", "egrid": "CH1", "art": "Gebaeude", "area_m2": 10.0, "_rawArea": 10.0049, "_geometry": None}
    out = tmp_path / "x.geojson"
    E.write_geojson({"parcels": [parcel], "landcover": [lc]}, out)
    fc = json.loads(out.read_text(encoding="utf-8"))
    p, l = fc["features"]
    assert p["properties"] == {"layer": "parcel", "id": "1", "egrid": "CH1", "bfsnr": 3203, "nbident": "SG0200320300"}
    assert p["geometry"]["type"] == "Polygon"
    assert l["properties"] == {"layer": "landcover", "id": "1", "egrid": "CH1", "art": "Gebaeude", "area_m2": 10}
    assert l["geometry"] is None
