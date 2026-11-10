"""Offline tests for the near-natural sample analysis (no network: the two api
calls are replaced by fixtures)."""

from __future__ import annotations

import json
import sys
import urllib.error
from pathlib import Path

import pytest
from shapely.geometry import box

HERE = Path(__file__).resolve().parent
PKG = HERE.parent
SRC = PKG / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

import api  # noqa: E402
import geom_wgs84 as geom  # noqa: E402
import inputs  # noqa: E402
import cli as main  # noqa: E402
import sources  # noqa: E402

E1, E2, E3 = "CH111111111111", "CH222222222222", "CH333333333333"
# A parcel of 0.001° × 0.001° near Bern; features are given as fractions of it.
X0, Y0, D = 7.4, 46.9, 0.001
PARCEL = box(X0, Y0, X0 + D, Y0 + D)
PARCEL_AREA = geom.area(PARCEL)


def part(x0, x1, y0=0.0, y1=1.0):
    """A box covering the given fractions of the parcel."""
    return box(X0 + x0 * D, Y0 + y0 * D, X0 + x1 * D, Y0 + y1 * D)


def feat(fid, geometry, **props):
    return {"key": str(fid), "id": fid, "geometry": geometry, "properties": props}


class FakeService:
    """Stands in for geo.admin.ch: ``layers[layer_id]`` is a feature list or an
    exception to raise; ``parcels[egrid]`` a geometry, ``None`` or an exception."""

    def __init__(self, parcels=None, layers=None):
        self.parcels = {E1: PARCEL} if parcels is None else parcels
        self.layers = layers or {}
        self.parcel_calls: list[str] = []
        self.identify_calls: list[str] = []

    def fetch_parcel_geometry(self, egrid):
        self.parcel_calls.append(egrid)
        p = self.parcels.get(egrid)
        if isinstance(p, Exception):
            raise p
        return None if p is None else {"geometry": p, "properties": {"number": "42"}}

    def fetch_identify(self, layer_id, parcel_geom, max_features):
        self.identify_calls.append(layer_id)
        v = self.layers.get(layer_id, [])
        if isinstance(v, Exception):
            raise v
        return {"features": [f for f in v if f["geometry"] is not None],
                "dropped": [f for f in v if f["geometry"] is None],
                "total": len(v), "truncated": False}


@pytest.fixture
def service(monkeypatch):
    def install(**kw):
        svc = FakeService(**kw)
        monkeypatch.setattr(api, "fetch_parcel_geometry", svc.fetch_parcel_geometry)
        monkeypatch.setattr(api, "fetch_identify", svc.fetch_identify)
        monkeypatch.setattr(main, "LAYER_RETRY_PAUSE_S", 0)
        return svc
    return install


def approx(share):
    return pytest.approx(PARCEL_AREA * share, abs=0.02)


# ---------------------------------------------------------------------------
# Element table
# ---------------------------------------------------------------------------

def test_sources_are_consistent():
    main.check_sources()
    assert len(main.out_columns()) == len(set(main.out_columns()))
    # every category in use has a column, and no category is left without an element
    assert {e["kat"] for e in sources.ELEMENTS} == set(sources.KATEGORIEN)
    # the data dictionary describes every Details column the code writes
    assert all(c.startswith(("in_", "out_")) for c, _, _ in sources.DETAIL_COLS)


@pytest.mark.parametrize("name", ["api.py", "geom_wgs84.py", "fdlibm.py", "user_input.py"])
def test_copied_modules_match_processing_cli(name):
    """These four files are copies; a fix made in processing-cli must not be missed here."""
    original = PKG.parent / "processing-cli" / "src" / name
    if not original.exists():
        pytest.skip("processing-cli not present")
    assert (SRC / name).read_bytes() == original.read_bytes()


# ---------------------------------------------------------------------------
# Input
# ---------------------------------------------------------------------------

SAP = """﻿10.11.2026                  Dynamische Listenausgabe                 1
----------------------------------------------------------------------
Bericht             Infosystem: Grundstücke am 10.11.2026
----------------------------------------------------------------------
|BuKr|WE  |Bez. Grundstück      |L/R|Straße    |Haus-Nr.|E-GRID        |Eigent.art|
----------------------------------------------------------------------
|9999|0001|Musterdorf, Gbbl. 1  |CH |          |        |ch111111111111|         1|
|9999|0002|Parkplätze           |CH |Crêt 10   |10      |0000000000    |         3|
|BuKr|WE  |Bez. Grundstück      |L/R|Straße    |Haus-Nr.|E-GRID        |Eigent.art|
|9999|0003|Ohne EGRID           |CD |          |        |              |          |
----------------------------------------------------------------------
"""


def test_slug():
    assert inputs.slug("Bez. Grundstück") == "bez_grundstueck"
    assert inputs.slug("Straße") == "strasse"
    assert inputs.slug("L/R") == "l_r"
    assert inputs.slug("Haus-Nr.") == "haus_nr"
    assert inputs.slug("E-GRID") == inputs.slug(" EGRID ") == "egrid"


def test_sap_list_keeps_every_column(tmp_path):
    p = tmp_path / "list.txt"
    p.write_text(SAP, encoding="utf-8")
    rows = inputs.read_input(p)                            # no ID column: only EGRID is required
    assert list(rows[0]) == ["bukr", "we", "bez_grundstueck", "l_r", "strasse", "haus_nr", "egrid", "eigent_art"]
    assert [r["egrid"] for r in rows] == [E1, "0000000000", ""]   # header repeat skipped, upper-cased
    assert rows[1]["strasse"] == "Crêt 10" and rows[0]["eigent_art"] == "1"


def test_sap_list_rejects_shifted_row():
    bad = "|A|E-GRID|\n|x|y|CH111111111111|\n"
    with pytest.raises(ValueError, match="Line 2"):
        inputs.parse_sap_list(bad)


def test_csv_and_excel_input(tmp_path):
    """Any columns, in any order; only EGRID is required."""
    p = tmp_path / "list.csv"
    p.write_text("Bemerkung Nr.;egrid;Bemerkung Nr.\nx; ch111111111111 ;y\n", encoding="utf-8")
    rows = inputs.read_input(p)
    assert rows[0]["egrid"] == E1 and list(rows[0])[0] == "bemerkung_nr" and len(rows[0]) == 3
    import pandas as pd
    x = tmp_path / "list.xlsx"
    pd.DataFrame({"ID": [7], "E-GRID": [E2], "Fläche m²": [12.5]}).to_excel(x, index=False)
    assert inputs.read_input(x) == [{"id": "7", "egrid": E2, "flaeche_m": "12.5"}]


def test_input_without_egrid_column_is_rejected(tmp_path):
    p = tmp_path / "list.csv"
    p.write_text("ID;Ort\nA1;Bern\n", encoding="utf-8")
    with pytest.raises(ValueError, match="no EGRID column.*ID, Ort"):
        inputs.read_input(p)


# ---------------------------------------------------------------------------
# One parcel
# ---------------------------------------------------------------------------

def test_overlaps_count_once_and_codes_filter(service):
    service(layers={
        sources.BLW: [feat(1, part(0.0, 0.5), lnf_code=611, nutzung_de="Extensiv"),
                      feat(2, part(0.4, 0.6), lnf_code=611),            # overlaps feature 1 by 0.1
                      feat(3, part(0.6, 0.8), lnf_code=613),            # not in the list
                      feat(4, part(0.9, 1.5), lnf_code="851")],          # half outside the parcel, code as text
        sources.FLACHMOOR: [feat(9, part(0.3, 1.0), name="Moos", objnummer=7)],
    })
    r = main.process_egrid(E1)
    o = r["out"]
    assert r["complete"] and o["out_check_egrid"] == main.ST_FOUND and o["out_check_naturnah"] == "ok"
    assert o["out_parcel_area_m2"] == approx(1)
    assert o["out_magerwiesen_611_m2"] == approx(0.6)     # 0.5 + 0.2 − 0.1 overlap
    assert o["out_streue_851_m2"] == approx(0.1)          # clipped to the parcel
    assert o["out_flachmoor_m2"] == approx(0.7)
    assert o["out_tww_m2"] == 0                           # queried, nothing there
    assert o["out_kat1_m2"] == approx(0.7)                # 611 ∪ 851
    assert o["out_naturnah_total_m2"] == approx(1.0)      # 611 ∪ 851 ∪ Flachmoor, each m² once
    assert o["out_naturnah_anteil_pct"] == pytest.approx(100, abs=0.01)
    assert o["out_blw_total_m2"] == approx(0.9)           # includes code 613
    by_fid = {d["out_feature_id"]: d for d in r["details"]}
    assert by_fid[3]["out_element"] == "" and by_fid[1]["out_element"] == "magerwiesen_611"
    assert by_fid[9]["out_bezeichnung"] == "Moos" and by_fid[9]["out_objnummer"] == 7
    assert len(r["pieces"]) == len(r["details"]) == 5
    json.dumps(r)                                         # checkpoint-serialisable


def test_failed_layer_leaves_dependent_values_empty(service):
    service(layers={
        sources.BLW: [feat(1, part(0.0, 0.5), lnf_code=611)],
        sources.FLACHMOOR: urllib.error.URLError("502"),
    })
    o = (r := main.process_egrid(E1))["out"]
    assert not r["complete"]
    assert "flachmoore: Abfrage fehlgeschlagen (<urlopen error 502>)" in o["out_check_naturnah"]
    assert o["out_flachmoor_m2"] is None                  # not queried ≠ 0
    assert o["out_kat6_m2"] is None                       # Hochmoor answered, Flachmoor did not
    assert o["out_naturnah_total_m2"] is None and o["out_naturnah_anteil_pct"] is None
    assert o["out_magerwiesen_611_m2"] == approx(0.5)     # unaffected values stay
    assert o["out_kat1_m2"] == approx(0.5) and o["out_blw_total_m2"] == approx(0.5)


def test_client_error_is_not_retried(service):
    svc = service(layers={sources.AUEN: urllib.error.HTTPError("u", 400, "Bad Request", None, None)})
    main.process_egrid(E1)
    assert svc.identify_calls.count(sources.AUEN) == 1
    svc = service(layers={sources.AUEN: urllib.error.HTTPError("u", 502, "Bad Gateway", None, None)})
    main.process_egrid(E1)
    assert svc.identify_calls.count(sources.AUEN) == main.LAYER_ATTEMPTS


def test_feature_without_geometry_is_flagged(service, monkeypatch):
    service(layers={sources.AUEN: [feat(5, None, name="Aue")]})
    monkeypatch.setattr(main, "fetch_feature_geometry", lambda layer, fid: None)
    r = main.process_egrid(E1)
    assert not r["complete"] and "auen: 1 Objekt(e) ohne Geometrie" in r["out"]["out_check_naturnah"]
    monkeypatch.setattr(main, "fetch_feature_geometry", lambda layer, fid: part(0, 0.25))
    r = main.process_egrid(E1)
    assert r["complete"] and r["out"]["out_auen_m2"] == approx(0.25)


def test_not_found_and_lookup_error(service):
    service(parcels={E1: None, E2: urllib.error.URLError("down")})
    r = main.process_egrid(E1)
    assert r["complete"] and r["out"]["out_check_egrid"] == main.ST_NOT_FOUND
    assert r["out"]["out_naturnah_total_m2"] is None
    r = main.process_egrid(E2)
    assert not r["complete"] and r["out"]["out_check_egrid"].startswith("Error:")


def test_unexpected_error_costs_one_parcel(service, monkeypatch):
    service()
    monkeypatch.setattr(main, "clip_layer", lambda *a: 1 / 0)
    r = main.safe_process(E1)
    assert not r["complete"] and "ZeroDivisionError" in r["out"]["out_check_egrid"]


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

def test_invalid_egrids_never_reach_the_service(service, tmp_path):
    """The parcel lookup is a substring search: an empty or short text returns other parcels."""
    svc = service()
    rows = [{"egrid": ""}, {"egrid": "0000000000"}, {"egrid": "CH1234"}, {"egrid": E1, "we": "1"}, {"egrid": E1, "we": "2"}]
    egrids = list(dict.fromkeys(r["egrid"] for r in rows if main.EGRID_RE.match(r["egrid"])))
    results, aborted = main.run(egrids, tmp_path / "c.jsonl", workers=2)
    assert svc.parcel_calls == [E1] and not aborted       # asked once, although listed twice
    recs = main.build_rows(rows, results)
    assert [r["out_check_egrid"] for r in recs] == [main.ST_MISSING, main.ST_INVALID, main.ST_INVALID,
                                                    main.ST_FOUND, main.ST_FOUND]
    assert [r["out_egrid_count"] for r in recs] == [None, None, None, 2, 2]
    assert [r["out_error"] for r in recs] == ["EGRID fehlt", "EGRID ungültig", "EGRID ungültig",
                                              "EGRID mehrfach in der Liste (2×)", "EGRID mehrfach in der Liste (2×)"]
    assert recs[3]["in_we"] == "1" and recs[4]["in_we"] == "2"
    assert all(list(r)[: len(rows[i])] == [f"in_{k}" for k in rows[i]] for i, r in enumerate(recs))


def test_resume_requeries_only_what_is_incomplete(service, tmp_path):
    svc = service(parcels={E1: PARCEL, E2: PARCEL, E3: None}, layers={sources.TWW: urllib.error.URLError("502")})
    first, _ = main.run([E1, E2, E3], tmp_path / "a.jsonl", workers=1)
    assert [first[e]["complete"] for e in (E1, E2, E3)] == [False, False, True]
    (tmp_path / "a.jsonl").open("a", encoding="utf-8").write('{"egrid": "CH9')     # killed while writing

    svc = service(parcels={E1: PARCEL, E2: PARCEL, E3: None}, layers={sources.TWW: [feat(1, part(0, 0.5))]})
    second, _ = main.run([E1, E2, E3], tmp_path / "b.jsonl", resume=main.load_checkpoint(tmp_path / "a.jsonl"), workers=1)
    assert sorted(svc.parcel_calls) == [E1, E2]            # the complete "not found" is reused
    assert all(r["complete"] for r in second.values())
    assert second[E1]["out"]["out_tww_m2"] == approx(0.5)
    assert set(main.load_checkpoint(tmp_path / "b.jsonl")) == {E1, E2, E3}
    before = main.build_rows([{"egrid": e} for e in (E1, E3)], first)
    assert before[0]["out_error"] == ("bundesinventare-trockenwiesen_trockenweiden: Abfrage fehlgeschlagen "
                                      "(<urlopen error 502>)")
    assert before[1]["out_error"] == "EGRID nicht gefunden"
    assert [r["out_error"] for r in main.build_rows([{"egrid": E1}], second)] == [""]      # nothing wrong


def test_run_stops_when_the_service_is_down(service, tmp_path, monkeypatch):
    egrids = [f"CH{i:012d}" for i in range(40)]
    svc = service(parcels={e: urllib.error.URLError("down") for e in egrids})
    monkeypatch.setattr(main, "ABORT_AFTER_FAILURES", 3)
    results, aborted = main.run(egrids, tmp_path / "c.jsonl", workers=1)
    assert aborted and 3 <= len(results) < len(egrids)
    recs = main.build_rows([{"egrid": e} for e in egrids], results)
    assert recs[-1]["out_check_egrid"] == main.ST_NOT_PROCESSED
    assert recs[-1]["out_error"] == "Nicht verarbeitet (Lauf abgebrochen)"
    assert recs[0]["out_error"] == "Grundstück konnte nicht abgefragt werden (<urlopen error down>)"


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

def test_outputs(service, tmp_path):
    from openpyxl import load_workbook

    service(layers={sources.BLW: [feat(1, part(0.0, 0.5), lnf_code=611, nutzung_de="=1+1\x07")]})
    rows = [{"we": "=cmd()", "egrid": E1}, {"we": "2", "egrid": E1}, {"we": "3", "egrid": ""}]
    results, _ = main.run([E1], tmp_path / "c.jsonl")
    recs = main.build_rows(rows, results)
    main.write_xlsx(recs, results, tmp_path / "o.xlsx", [("Zeilen", 3)])
    main.write_geojson(recs, results, tmp_path / "o.geojson")

    wb = load_workbook(tmp_path / "o.xlsx")
    assert wb.sheetnames == ["Parzellen", "Details", "Quellen", "Datenmodell"]
    ws = wb["Parzellen"]
    header = [c.value for c in ws[1]]
    assert header == ["in_we", "in_egrid"] + main.out_columns()
    assert ws.max_row == 4                                 # one row per input row
    assert ws["A2"].value == "=cmd()" and ws["A2"].data_type == "s"       # text, not a formula
    details = wb["Details"]
    assert details.max_row == 2                            # once per distinct EGRID
    assert details["F2"].value == "=1+1" and details["F2"].data_type == "s"   # control character removed
    documented = {r[1] for r in wb["Datenmodell"].iter_rows(min_row=2, values_only=True) if r[0] == "Parzellen"}
    assert set(main.out_columns()) <= documented

    fc = json.loads((tmp_path / "o.geojson").read_text(encoding="utf-8"))
    kinds = [f["properties"]["layer"] for f in fc["features"]]
    assert kinds == ["parcel", "parcel", "naturnah"]
    assert fc["features"][0]["properties"]["in_we"] == "=cmd()"
