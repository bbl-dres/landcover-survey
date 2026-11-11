"""AV Produktivität and AV Typ follow BAFU's definition of 9 Nov 2026:

    Grünflächen: nach amtlicher Vermessung alle Kategorien ausser 0–7 und 24.
    Typ 1: Gartenanlagen 11.   Typ 2: 8–23 (ohne 11), plus 25.

The codes are the positions in BAFU's table (= the BBArt enumeration order of
DM.01-AV-CH). The same lists are asserted for the web app in
processing-web/tests/classification.test.mjs.
"""

from __future__ import annotations

import classify_web as C
import config

BAFU_CODES = [
    "Gebaeude", "Strasse_Weg", "Trottoir", "Verkehrsinsel", "Bahn", "Flugplatz", "Wasserbecken",
    "uebrige_befestigte", "Acker_Wiese_Weide", "Reben", "uebrige_Intensivkultur", "Gartenanlage",
    "Hoch_Flachmoor", "uebrige_humusierte", "Gewaesser_stehendes", "Gewaesser_fliessendes",
    "Schilfguertel", "geschlossener_Wald", "Wytweide_dicht", "Wytweide_offen", "uebrige_bestockte",
    "Fels", "Gletscher_Firn", "Geroell_Sand", "Abbau_Deponie", "uebrige_vegetationslose",
]
NOT_GREEN = set(range(0, 8)) | {24}
TYP1 = {11}
TYP2 = (set(range(8, 24)) - {11}) | {25}


def _codes(predicate) -> set[int]:
    return {code for code, art in enumerate(BAFU_CODES) if predicate(art)}


def test_the_code_table_is_the_bbart_domain():
    assert len(BAFU_CODES) == 26 and set(BAFU_CODES) == set(config.SIA416)


def test_typ_follows_the_bafu_definition():
    assert _codes(lambda a: config.VBS_TYP.get(a) == "typ1") == TYP1
    assert _codes(lambda a: config.VBS_TYP.get(a) == "typ2") == TYP2
    assert _codes(lambda a: a not in config.VBS_TYP) == NOT_GREEN


def test_green_area_is_everything_but_codes_0_to_7_and_24():
    assert _codes(lambda a: config.VBS_PRODUKTIV[a] == "unproduktiv") == NOT_GREEN
    assert _codes(lambda a: config.VBS_PRODUKTIV[a] == "produktiv") == TYP1 | TYP2
    # … which is exactly "outside Kategorie A"
    assert _codes(lambda a: config.VBS_KATEGORIE[a] == "kat_a") == NOT_GREEN


def test_rock_glacier_scree_are_typ2():
    """Codes 21–23 were unproductive, without Typ, until 2026-11-10."""
    for art in ("Fels", "Gletscher_Firn", "Geroell_Sand"):
        cls = C.classify(art)
        assert (cls["vbsProduktiv"], cls["vbsTyp"], cls["vbsKategorie"]) == ("produktiv", "typ2", "kat_d")
    # the habitat class these correspond to is classified alike
    cls = C.classify_bafu("3.4 Felsen")
    assert (cls["vbsProduktiv"], cls["vbsTyp"]) == ("produktiv", "typ2")


def test_typ1_plus_typ2_is_the_productive_area():
    import processor_web as P

    rows = [P._make_landcover_row("P", "CH1", art, 10.0, None) for art in BAFU_CODES]
    agg = P._aggregate_landcover(rows)
    assert agg["av_typ1_m2"] + agg["av_typ2_m2"] == agg["av_produktiv_m2"] == 10.0 * len(TYP1 | TYP2)
    assert agg["av_unproduktiv_m2"] == 10.0 * len(NOT_GREEN)
    assert agg["av_typ1_m2"] == 10.0
