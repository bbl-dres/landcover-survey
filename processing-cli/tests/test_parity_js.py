"""Web ⇄ Python parity of everything that is pure code: classification tables,
classifiers, label/key helpers, number formatting, row shapes and aggregation.

The JS side is evaluated by tests/js_dump.mjs (Node) on tests/fixtures/parity_cases.json;
every value must be identical here — the end-to-end parity (processing-cli/compare.py) rests
on it.
"""

from __future__ import annotations

import json

import classify_web as C
import config
import processor_web as P
from conftest import REPO


def _public(row: dict) -> dict:
    return {k: v for k, v in row.items() if k != "_geometry"}


# --- tables ------------------------------------------------------------------

def test_classification_tables_identical(js_dump):
    t = js_dump["tables"]
    assert t["SIA416"] == config.SIA416
    assert t["GREEN_SPACE"] == config.GREEN_SPACE
    assert t["VBS_KATEGORIE"] == config.VBS_KATEGORIE
    assert t["VBS_PRODUKTIV"] == config.VBS_PRODUKTIV
    assert t["VBS_TYP"] == config.VBS_TYP
    assert t["SEALED"] == sorted(config.VERSIEGELT_ARTS)
    assert t["VBS_KATEGORIE_LABELS"] == config.VBS_KATEGORIE_LABELS
    assert t["VBS_PRODUKTIV_LABELS"] == config.VBS_PRODUKTIV_LABELS
    assert t["VBS_TYP_LABELS"] == config.VBS_TYP_LABELS
    assert t["BAFU_TYPOCH_L1"] == config.BAFU_TYPOCH_L1
    assert t["BAFU_TYPOCH_REFINE"] == config.BAFU_TYPOCH_REFINE
    assert t["TYPOCH_BBART"] == C.TYPOCH_BBART
    assert t["STATUS"] == {k.upper(): v for k, v in P.STATUS.items()} or t["STATUS"] == P.STATUS
    assert t["ERR_MSG"] == P.ERR_MSG
    assert t["ERR_RUNTIME_PREFIX"] == P.ERR_RUNTIME_PREFIX


def test_bbart_domain_matches_shared_reference():
    """data/landcover.json is the BBArt domain of record: every classifier table keys
    on exactly these 26 values (a typo in one copy would silently fall back)."""
    doc = json.loads((REPO / "data" / "landcover.json").read_text(encoding="utf-8"))
    keys = {t["key"] for t in doc["types"]}
    assert len(keys) == 26
    assert set(config.SIA416) == keys
    assert set(config.DIN277) == keys
    assert set(config.VBS_KATEGORIE) == keys
    assert config.VERSIEGELT_ARTS <= keys
    assert set(config.GREEN_SPACE) <= keys


# --- classifiers + helpers ---------------------------------------------------

def test_classify_identical(js_dump, cases):
    for art in cases["arts"]:
        assert C.classify(art) == js_dump["classify"][art], art


def test_classify_bafu_identical(js_dump, cases):
    for t in cases["typoch"]:
        assert C.classify_bafu(t) == js_dump["classifyBafu"][t], t


def test_typoch_to_bbart_identical(js_dump, cases):
    for t in cases["typoch"]:
        assert C.typoch_to_bbart(t) == js_dump["typochToBBArt"][t], t


def test_typoch_labels_identical(js_dump, cases):
    for t in cases["typoch"]:
        py = {
            "l1": C.typoch_l1_label(t), "l2": C.typoch_l2_label(t), "l3": C.typoch_l3_label(t),
            "c1": C.typoch_code_at_level(t, 1), "c2": C.typoch_code_at_level(t, 2), "c3": C.typoch_code_at_level(t, 3),
            "code": C.typoch_code(t), "l1digit": C.typoch_l1(t),
        }
        assert py == js_dump["labels"][t], t


def test_slugs_and_column_keys_identical(js_dump, cases):
    for s in cases["slugs"]:
        assert C.slugify(s) == js_dump["slugify"][s], s
        assert C.bauzone_area_key(s) == js_dump["bauzoneAreaKey"][s], s
    for code in cases["habitat_codes"]:
        assert C.habitat_area_key_l1(code) == js_dump["habitatKeys"][code]["l1"]
        assert C.habitat_area_key_l2(code) == js_dump["habitatKeys"][code]["l2"]


def test_normalize_egrid_identical(js_dump):
    from user_input import normalize_egrid
    for s, expected in js_dump["normalizeEgrid"].items():
        assert normalize_egrid(s) == expected


# --- number formatting --------------------------------------------------------

def test_number_formatting_identical(js_dump):
    """to_fixed_1 ≡ Number.prototype.toFixed(1) and round2 ≡ Math.round(x*100)/100 —
    the two places where a locale- or rounding-mode difference would show up in
    every exported area."""
    for case in js_dump["numbers"]:
        x = case["x"]
        assert config.to_fixed_1(x) == case["toFixed1"], x
        assert P.round2(x) == case["round2"], x


# --- rows + aggregation --------------------------------------------------------

def _lc_rows(cases):
    return [P._lc_row("P1", "CH1", art, bfsnr, "", "", area, None, C.classify(art))
            for art, area, bfsnr in cases["landcover_rows"]]


def test_landcover_rows_identical(js_dump, cases):
    rows = _lc_rows(cases)
    assert [_public(r) for r in rows] == js_dump["landcover"]["rows"]
    # Key order matters: it is the export header order.
    assert [list(_public(r)) for r in rows] == [list(r) for r in js_dump["landcover"]["rows"]]
    synth = P._make_synth_landcover_row("P1", "CH1", "Gebaeude", "9.2 Bauten", 12.345, None)
    assert _public(synth) == js_dump["landcover"]["synth"]
    assert list(_public(synth)) == list(js_dump["landcover"]["synth"])


def test_landcover_aggregation_identical(js_dump, cases):
    rows = _lc_rows(cases)
    assert P._aggregate_landcover(rows) == js_dump["landcover"]["agg"]
    assert P._dominant_bfsnr(rows) == js_dump["landcover"]["bfsnr"]


def test_habitat_rows_and_aggregation_identical(js_dump, cases):
    rows = [P._make_habitat_row("P1", "CH1", typoch, "", str(100 + i), area, None)
            for i, (typoch, area) in enumerate(cases["habitat_rows"])]
    assert [_public(r) for r in rows] == js_dump["habitat"]["rows"]
    assert [list(_public(r)) for r in rows] == [list(r) for r in js_dump["habitat"]["rows"]]
    assert P._aggregate_habitat(rows) == js_dump["habitat"]["agg"]


def test_bauzonen_rows_and_aggregation_identical(js_dump, cases):
    rows = [P._make_bauzone_row("P1", "CH1", name, code, "" if name == "Ohne Bauzone" else str(200 + i), area, None)
            for i, (name, code, area) in enumerate(cases["bauzonen_rows"])]
    assert [_public(r) for r in rows] == js_dump["bauzonen"]["rows"]
    assert P._aggregate_bauzonen(rows) == js_dump["bauzonen"]["agg"]
