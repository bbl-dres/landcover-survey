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
    processor_web.clear_cache()
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
