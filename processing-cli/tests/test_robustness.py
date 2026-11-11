"""Robustness of the ``api`` source (review of 2026-11-10): the parcel lookup must
match the EGRID exactly, a failed query is asked again, an interrupted run keeps
what is finished, and the Excel export survives any input text. No network."""

from __future__ import annotations

import urllib.error
import urllib.parse

import pytest
from shapely.geometry import box, mapping

import api
import export_web
import processor_web

PARCEL = box(7.4, 46.9, 7.401, 46.901)
CADASTRE = ["CH385146357691", "CH120004463580", "CH120012463508"]


def _fake_find(url: str) -> dict:
    """geo.admin.ch ``find``: substring search unless ``contains=false``."""
    q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query, keep_blank_values=True)
    text, exact = q["searchText"][0], q.get("contains", ["true"])[0] == "false"
    hits = [e for e in CADASTRE if (e == text if exact else text in e)]
    return {"results": [{"geometry": mapping(PARCEL), "properties": {"number": "1", "egris_egrid": e}} for e in hits]}


@pytest.mark.parametrize("text, found", [
    ("CH385146357691", True),
    ("CH12", False),              # substring of two other parcels
    ("CH38514635769", False),     # truncated: a substring of the real one
    ("CH", False),
])
def test_parcel_lookup_matches_the_whole_egrid(monkeypatch, text, found):
    monkeypatch.setattr(api, "_fetch_json", _fake_find)
    r = api.fetch_parcel_geometry(text)
    assert (r is not None) == found
    if found:
        assert r["properties"]["mergedCount"] == 1


@pytest.fixture
def service(monkeypatch):
    """Fake services for one parcel: ``state["wfs_failures"]`` land-cover requests
    fail before one answers."""
    state = {"wfs_failures": 0, "parcel_calls": 0}

    def parcel(egrid):
        state["parcel_calls"] += 1
        return {"geometry": PARCEL, "properties": {"number": "1", "nbident": "", "area": "", "mergedCount": 1}}

    def landcover(bbox):
        if state["wfs_failures"] > 0:
            state["wfs_failures"] -= 1
            return {"features": [], "error": True, "truncated": False}
        return {"features": [{"geometry": PARCEL, "properties": {"Art": "Gebaeude", "BFSNr": 351}, "id": 1}],
                "error": False, "truncated": False}

    monkeypatch.setattr(api, "fetch_parcel_geometry", parcel)
    monkeypatch.setattr(api, "fetch_landcover", landcover)
    monkeypatch.setattr(processor_web, "RETRY_PAUSE_S", 0)
    api.clear_parcel_cache()
    return state


OPTIONS = {"bauzonen": False, "habitat": False, "synthLandcover": False}


def test_failed_query_is_asked_again(service):
    service["wfs_failures"] = 1
    res = processor_web.process_rows([{"id": "A", "egrid": "CH385146357691"}], OPTIONS)
    p = res["parcels"][0]
    assert p["check_wfs"] == "ok" and p["sia416_ggf_m2"] > 0 and not res["interrupted"]
    assert len(res["landcover"]) == 1


def test_persistent_failure_stays_flagged(service):
    service["wfs_failures"] = 99
    res = processor_web.process_rows([{"id": "A", "egrid": "CH385146357691"}], OPTIONS)
    p = res["parcels"][0]
    assert p["check_wfs"] == "wfs_error" and processor_web.needs_retry({"parcel": p})
    assert service["wfs_failures"] == 99 - 1 - processor_web.RETRY_ROUNDS      # first pass + the retry rounds


def test_invalid_and_unknown_rows_are_not_retried(service, monkeypatch):
    monkeypatch.setattr(api, "fetch_parcel_geometry", lambda egrid: service.__setitem__("parcel_calls", service["parcel_calls"] + 1))
    res = processor_web.process_rows([{"id": "A", "egrid": ""}, {"id": "B", "egrid": "CH000000000000"}], OPTIONS)
    assert [p["check_egrid"] for p in res["parcels"]] == ["invalid", "not_found"]
    assert service["parcel_calls"] == 1


def test_interrupt_keeps_finished_parcels(service, monkeypatch):
    real = processor_web._process_one

    def one(row, options):
        if row["id"] == "B":
            raise KeyboardInterrupt
        return real(row, options)

    monkeypatch.setattr(processor_web, "CONCURRENCY", 1)
    monkeypatch.setattr(processor_web, "_process_one", one)
    rows = [{"id": i, "egrid": "CH385146357691", "ort": "x"} for i in "ABC"]
    res = processor_web.process_rows(rows, OPTIONS)
    assert res["interrupted"] and len(res["parcels"]) == 3              # every input row is still there
    by_id = {p["id"]: p for p in res["parcels"]}
    assert by_id["A"]["check_egrid"] == "found"
    assert by_id["B"]["check_egrid"] == processor_web.NOT_PROCESSED and by_id["B"]["input_ort"] == "x"


def test_xlsx_export_survives_formula_and_control_characters(tmp_path):
    from openpyxl import load_workbook

    parcels = [{"id": "=1+1", "egrid": "CH385146357691", "input_note": "a\x07b", "errors": ["=x", "y"], "area": 1.0}]
    export_web.write_xlsx({"parcels": parcels}, tmp_path / "o.xlsx")
    ws = load_workbook(tmp_path / "o.xlsx").active
    row = {h.value: c for h, c in zip(ws[1], ws[2])}
    assert row["id"].value == "=1+1" and row["id"].data_type == "s"      # text, as in the web export
    assert row["input_note"].value == "ab"
    assert row["errors"].value == "=x; y" and row["errors"].data_type == "s"
    assert row["area"].value == 1


# ---------------------------------------------------------------------------
# A failed query leaves the value empty — never 0, never a substitute
# ---------------------------------------------------------------------------

P2 = box(7.5, 46.9, 7.501, 46.901)


def _lc(geometry, art="Gebaeude"):
    return {"features": [{"geometry": geometry, "properties": {"Art": art, "BFSNr": 351}, "id": 1}],
            "error": False, "truncated": False}


def _install(monkeypatch, *, landcover, bauzonen=None, bafu=None):
    """Fake services keyed by parcel: ``landcover[egrid]`` etc. are results or exceptions."""
    geoms = {"CH000000000001": PARCEL, "CH000000000002": P2}
    by_bounds = {g.bounds: e for e, g in geoms.items()}
    egrid_of = lambda g: by_bounds[g.bounds]  # noqa: E731

    def give(v):
        if isinstance(v, Exception):
            raise v
        return v

    monkeypatch.setattr(api, "fetch_parcel_geometry", lambda e: None if e not in geoms else {
        "geometry": geoms[e], "properties": {"number": "1", "nbident": "", "area": "", "mergedCount": 1}})
    monkeypatch.setattr(api, "fetch_landcover", lambda bbox: give(landcover[by_bounds[tuple(bbox)]]))
    monkeypatch.setattr(api, "fetch_bauzonen", lambda g: give((bauzonen or {})[egrid_of(g)]))
    monkeypatch.setattr(api, "fetch_landcover_bafu", lambda g: give((bafu or {})[egrid_of(g)]))
    monkeypatch.setattr(processor_web, "RETRY_PAUSE_S", 0)
    api.clear_parcel_cache()


FAILED = {"features": [], "error": True, "truncated": False}
ROWS = [{"id": "A", "egrid": "CH000000000001"}, {"id": "B", "egrid": "CH000000000002"},
        {"id": "C", "egrid": "CH000000000009"}, {"id": "D", "egrid": ""}]


def test_failed_landcover_request_leaves_areas_empty_and_is_not_replaced_by_bafu(monkeypatch):
    habitat = {"features": [{"geometry": PARCEL, "properties": {"typoch_de": "6.3.1 Buchenwald"}, "id": 7}],
               "dropped": [], "error": False, "truncated": False}
    _install(monkeypatch, landcover={"CH000000000001": FAILED, "CH000000000002": _lc(P2)},
             bafu={"CH000000000001": habitat, "CH000000000002": habitat})
    res = processor_web.process_rows(ROWS[:2], {"bauzonen": False, "habitat": False, "synthLandcover": True})
    a, b = res["parcels"]
    assert a["check_wfs"] == "wfs_error" and a["errors"] == ["Land cover unavailable (WFS)"]
    assert a["lc_synthetic"] == "" and a["lc_source"] == ""          # unknown ≠ absent: no BAFU substitute
    assert [a[k] for k in processor_web.LANDCOVER_AGG_KEYS] == [""] * len(processor_web.LANDCOVER_AGG_KEYS)
    assert a["parcel_area_m2"] > 0                                     # the parcel itself was found
    assert b["check_wfs"] == "ok" and b["sia416_ggf_m2"] > 0 and b["greenspace_m2"] == 0   # asked: really 0
    assert [lc["id"] for lc in res["landcover"]] == ["B"]


def test_overlay_columns_are_empty_where_the_overlay_did_not_answer(monkeypatch):
    zone = lambda g, name: {"features": [{"geometry": g, "properties": {"ch_bez_d": name, "ch_code_hn": "11"}, "id": 3}],  # noqa: E731
                            "dropped": [], "truncated": False}
    _install(monkeypatch, landcover={"CH000000000001": _lc(PARCEL), "CH000000000002": _lc(P2)},
             bauzonen={"CH000000000001": zone(PARCEL, "Wohnzonen"), "CH000000000002": RuntimeError("502")})
    res = processor_web.process_rows(ROWS, {"bauzonen": True, "habitat": False, "synthLandcover": False})
    a, b, c, d = res["parcels"]
    assert a["check_bauzonen"] == "ok" and a["bauzonen_wohnzonen_m2"] > 0
    assert b["check_bauzonen"] == "error" and b["bauzonen_wohnzonen_m2"] == ""    # the request failed: unknown
    assert c["check_egrid"] == "not_found" and c["bauzonen_wohnzonen_m2"] == ""   # no parcel: nothing asked
    assert d["check_egrid"] == "invalid" and d["bauzonen_wohnzonen_m2"] == ""

    other = lambda g: zone(g, "Arbeitszonen")  # noqa: E731
    _install(monkeypatch, landcover={"CH000000000001": _lc(PARCEL), "CH000000000002": _lc(P2)},
             bauzonen={"CH000000000001": zone(PARCEL, "Wohnzonen"), "CH000000000002": other(P2)})
    a, b = processor_web.process_rows(ROWS[:2], {"bauzonen": True, "habitat": False, "synthLandcover": False})["parcels"]
    assert a["bauzonen_arbeitszonen_m2"] == 0 and b["bauzonen_wohnzonen_m2"] == 0     # asked, not in that zone


def test_each_parcel_is_reported_once_with_its_final_result(monkeypatch):
    calls = {"n": 0}

    def landcover_flaky(bbox):
        calls["n"] += 1
        return FAILED if calls["n"] == 1 else _lc(PARCEL)

    _install(monkeypatch, landcover={})
    monkeypatch.setattr(api, "fetch_landcover", landcover_flaky)
    seen = []
    processor_web.process_rows(ROWS[:1] + ROWS[2:], {"bauzonen": False, "habitat": False, "synthLandcover": False},
                               on_progress=lambda p: seen.append((p["processed"], p["parcel"]["id"], p["parcel"].get("check_wfs"))))
    assert sorted(i for _, i, _ in seen) == ["A", "C", "D"]            # once each
    assert [p for p, _, _ in seen] == [1, 2, 3]
    assert ("A", "ok") in [(i, w) for _, i, w in seen]                 # the retried result, not the failed one
