"""Data sources for the near-natural ("naturnah") sample analysis.

Transcribes the BAFU list «M5 Übersicht Datenquellen naturnahe Flächen.xlsx»
(sheet «Elemente_Anfrage», version of 3 Nov 2026) for the sources that the
geo.admin.ch ``identify`` service can deliver as polygons. First sample: the BLW
Nutzungsflächen (filtered by Kultur-Code = ``lnf_code``) and four Bundesinventare.

Each element is one output column ``out_<key>_m2``. ``rows`` are the Excel rows it
covers, ``kat`` the «Kategorie Nr.» of the list. ``codes`` filters the layer's
``lnf_code``; ``None`` takes the whole layer.
"""

from __future__ import annotations

BLW = "ch.blw.landwirtschaftliche-nutzungsflaechen"
TWW = "ch.bafu.bundesinventare-trockenwiesen_trockenweiden"
HOCHMOOR = "ch.bafu.bundesinventare-hochmoore"
FLACHMOOR = "ch.bafu.bundesinventare-flachmoore"
AUEN = "ch.bafu.bundesinventare-auen"

# Layers fetched once per parcel (one identify quadtree each).
LAYERS = [BLW, TWW, HOCHMOOR, FLACHMOOR, AUEN]

# Attribute of the BLW layer that carries the Kultur-Code.
BLW_CODE_ATTR = "lnf_code"

ELEMENTS = [
    {"key": "tww", "rows": "2", "kat": 1, "layer": TWW, "codes": None,
     "element": "Trockenwiesen und -weiden (TWW)", "source": "BAFU-Bundesinventar TWW"},
    {"key": "magerwiesen_611", "rows": "3", "kat": 1, "layer": BLW, "codes": [611],
     "element": "Magerwiesen/-weiden (übrige, nicht TWW)", "source": "BLW Nutzungsflächen, Kultur-Code 611"},
    {"key": "wenig_intensiv_612", "rows": "4", "kat": 1, "layer": BLW, "codes": [612],
     "element": "Wenig intensiv genutzte Wiesen", "source": "BLW Nutzungsflächen, Kultur-Code 612"},
    {"key": "streue_851", "rows": "5", "kat": 1, "layer": BLW, "codes": [851],
     "element": "Streueflächen", "source": "BLW Nutzungsflächen, Kultur-Code 851"},
    {"key": "hecken_852", "rows": "6", "kat": 2, "layer": BLW, "codes": [852],
     "element": "Hecken, Feld- und Ufergehölz", "source": "BLW Nutzungsflächen, Kultur-Code 852"},
    # Rows 8 and 9 (Kultur-Codes 921–924, trees) are NOT elements: the layer holds no
    # object with these codes (trees are presumably recorded as a count, not an area), so a
    # column would be 0 for every parcel and read as "queried, nothing there".
    {"key": "brachen_556_557", "rows": "10", "kat": 4, "layer": BLW, "codes": [556, 557],
     "element": "Bunt- und Rotationsbrachen", "source": "BLW Nutzungsflächen, Kultur-Code 556, 557"},
    # The list gives Kultur-Code 905 for three elements (rows 11–13); the data cannot
    # tell them apart, so they are one column.
    {"key": "ruderal_stein_mauer_905", "rows": "11–13", "kat": 4, "layer": BLW, "codes": [905],
     "element": "Ruderalflächen / Steinhaufen, -wälle / Trockensteinmauern",
     "source": "BLW Nutzungsflächen, Kultur-Code 905"},
    {"key": "hochmoor", "rows": "17", "kat": 6, "layer": HOCHMOOR, "codes": None,
     "element": "Hochmoore", "source": "BAFU-Bundesinventar Hochmoore"},
    {"key": "flachmoor", "rows": "18", "kat": 6, "layer": FLACHMOOR, "codes": None,
     "element": "Flachmoore", "source": "BAFU-Bundesinventar Flachmoore"},
    {"key": "auen", "rows": "20", "kat": 7, "layer": AUEN, "codes": None,
     "element": "Auen (national/regional bedeutend)", "source": "BAFU-Bundesinventar Auen"},
]

# Sheet «Legende Kategorien» — only the categories this sample can fill.
KATEGORIEN = {
    1: "Naturnahe Wiesen & Weiden",
    2: "Hecken, Feldgehölze, Waldränder",
    4: "Brachen, Ruderalflächen, Stein-/Kiesflächen, Trockenmauern",
    6: "Feuchtgebiete (Hoch-/Flachmoore, nährstoffreiche Feuchtwiesen)",
    7: "Auen",
}

# The elements of the list this sample does not cover are listed, with the reason, in
# docs/DATAMODEL.md («Not measured»).

# ---------------------------------------------------------------------------
# The datasets, as a reader should find them: official name (as geo.admin.ch gives
# it) and the address of the layer on the federal map viewer.
# ---------------------------------------------------------------------------

AV = "ch.kantone.cadastralwebmap-farbe"   # the cadastral layer the Grundstück is looked up in


def map_url(layer_id: str) -> str:
    """The layer on map.geo.admin.ch."""
    return f"https://map.geo.admin.ch/#/map?lang=de&layers={layer_id}"


# Name (owner) — one pattern for all six.
DATASETS = {
    AV: "Amtliche Vermessung (Kantone)",
    BLW: "Landwirtschaftliche Nutzungsflächen (BLW)",
    TWW: "Bundesinventar Trockenwiesen und -weiden (BAFU)",
    HOCHMOOR: "Bundesinventar Hoch- und Übergangsmoore (BAFU)",
    FLACHMOOR: "Bundesinventar Flachmoore (BAFU)",
    AUEN: "Bundesinventar Auengebiete (BAFU)",
}

# ---------------------------------------------------------------------------
# Data dictionary — the «Datenmodell» sheet of the workbook (see docs/DATAMODEL.md)
#
# One entry per attribute: (Attribut, Format, Beschreibung, Quelle, Link).
# ``in_`` = taken from the input list, ``out_`` = produced by this tool.
#
# «Quelle» has one fixed form, built by :func:`quelle`:
#
#     <Herkunft> – <Angabe>
#
# Herkunft is one of ORIGINS: the input list, one dataset by its name, a group of
# datasets, or «Berechnet». Angabe says what of it: «Attribut «x»», «Kultur-Code 611»,
# «alle Flächen», or «aus <columns>» for a computed value. A value with two origins
# lists both, separated by «; ». «Link» is the dataset on the map viewer (empty when
# the origin is not a single dataset).
# ---------------------------------------------------------------------------

FMT_TEXT = "Text"
FMT_INT = "Ganzzahl"
FMT_M2 = "Zahl (m², 2 Dezimalen)"
FMT_PCT = "Zahl (%, 2 Dezimalen)"
FMT_GEOM = "Polygon / MultiPolygon (WGS84)"

SRC_INPUT = "Eingabeliste"
SRC_CALC = "Berechnet"
SRC_ALL = "Alle fünf Datensätze"            # the five datasets that are measured
SRC_INVENTARE = "Bundesinventare (BAFU)"    # the four inventories together
SRC_SHEET = "Blatt «Grundstücke»"
ORIGINS = (SRC_INPUT, SRC_CALC, SRC_ALL, SRC_INVENTARE, SRC_SHEET) + tuple(DATASETS.values())
SEP = " – "


def quelle(origin: str, detail: str = "") -> str:
    """One «Quelle» entry in the fixed form ``<Herkunft> – <Angabe>``."""
    if origin not in ORIGINS:
        raise ValueError(f"unknown origin: {origin}")
    return origin + (SEP + detail if detail else "")


SHEET_GRUNDSTUECKE = "Grundstücke"
SHEET_DATENMODELL = "Datenmodell"
DATENMODELL_HEADER = ["Blatt / Layer", "Attribut", "Format", "Beschreibung", "Quelle", "Link"]
# GeoJSON `layer` values: the Grundstück itself, and the clipped objects on it.
LAYER_GRUNDSTUECK = "grundstueck"
LAYER_NATURNAH = "naturnah"

EMPTY_VS_ZERO = "Leer = nicht abgefragt (Grundstück nicht gefunden oder Datensatz nicht abfragbar), 0 = abgefragt, keine Fläche."

# Columns of the «Grundstücke» sheet. The ``out_<element>_m2`` and ``out_kat<n>_m2``
# columns sit between HEAD and TAIL and are generated from ELEMENTS / KATEGORIEN.
GRUNDSTUECK_COLS_IN = [
    ("in_egrid", FMT_TEXT,
     "Eidgenössischer Grundstücksidentifikator (E-GRID); einzige Pflichtspalte, Schlüssel für den Verschnitt",
     quelle(SRC_INPUT), ""),
    ("in_<Spalte>", FMT_TEXT,
     "Jede weitere Spalte der Eingabeliste, unverändert übernommen (Name = Spaltentitel in Kleinbuchstaben, "
     "Sonderzeichen als «_»)", quelle(SRC_INPUT), ""),
]
GRUNDSTUECK_COLS_HEAD = [
    ("out_error", FMT_TEXT,
     "Alles, was an dieser Zeile nicht stimmt, mit «; » getrennt; leer = in Ordnung. Mögliche Einträge: "
     "«EGRID fehlt», «EGRID ungültig», «EGRID mehrfach in der Liste (n×)», «EGRID nicht gefunden», "
     "«Grundstück konnte nicht abgefragt werden (Meldung des Dienstes)», «Nicht verarbeitet (Lauf abgebrochen)» "
     "sowie die Datensätze, die nicht oder unvollständig abgefragt werden konnten, mit der Meldung des Dienstes",
     quelle(SRC_CALC, "aus out_check_egrid, out_egrid_count, out_check_naturnah"), ""),
    ("out_check_egrid", FMT_TEXT,
     "Ergebnis der Suche nach dem Grundstück: «EGRID found», «EGRID not found», «EGRID missing», «Invalid EGRID», "
     "«Not processed» oder «Error: …»", quelle(DATASETS[AV], "Suche nach der E-GRID"), map_url(AV)),
    ("out_egrid_count", FMT_INT,
     "Anzahl Zeilen der Eingabeliste mit dieser EGRID; > 1 = dasselbe Grundstück mehrfach geführt "
     "(beim Summieren nur einmal zählen)", quelle(SRC_CALC, "aus der Eingabeliste"), ""),
    ("out_nummer", FMT_TEXT, "Grundstücksnummer", quelle(DATASETS[AV], "Attribut «number»"), map_url(AV)),
    ("out_parcel_area_m2", FMT_M2,
     "Fläche des Grundstücks, aus seiner Grenze berechnet (nicht das amtliche Flächenmass)",
     quelle(DATASETS[AV], "Fläche der Grundstücksgrenze"), map_url(AV)),
    ("out_check_naturnah", FMT_TEXT,
     "«ok» oder die Datensätze, die nicht oder unvollständig abgefragt werden konnten (betroffene Werte bleiben leer)",
     quelle(SRC_CALC, "aus den Abfragen der fünf Datensätze"), ""),
]
GRUNDSTUECK_COLS_TAIL = [
    ("out_naturnah_total_m2", FMT_M2,
     "Naturnahe Fläche auf dem Grundstück: alle Elemente zusammen, jede Fläche einmal gezählt (kann kleiner "
     "sein als die Summe der Element-Spalten). Leer, sobald ein Datensatz nicht abgefragt werden konnte.",
     quelle(SRC_CALC, "aus allen Element-Spalten"), ""),
    ("out_naturnah_anteil_pct", FMT_PCT,
     "Anteil der naturnahen Fläche an der Grundstücksfläche: out_naturnah_total_m2 / out_parcel_area_m2 × 100",
     quelle(SRC_CALC, "aus out_naturnah_total_m2, out_parcel_area_m2"), ""),
    ("out_blw_total_m2", FMT_M2,
     "Gesamte landwirtschaftliche Nutzungsfläche auf dem Grundstück, unabhängig vom Kultur-Code; als Kontext. "
     + EMPTY_VS_ZERO, quelle(DATASETS[BLW], "alle Flächen"), map_url(BLW)),
]

# Attributes of the clipped objects — the GeoJSON features with layer = «naturnah»
# (one per source object and Grundstück; a Grundstück listed twice has them once).
OBJEKT_COLS = [
    ("in_egrid", FMT_TEXT, "EGRID des Grundstücks, auf dem das Objekt liegt (Schlüssel zu «Grundstücke»)", quelle(SRC_INPUT), ""),
    ("out_layer", FMT_TEXT,
     "Datensatz, aus dem das Objekt stammt, als Layer-ID von geo.admin.ch (auf map.geo.admin.ch unter dieser ID zu finden)",
     quelle(SRC_ALL, "Layer-ID"), ""),
    ("out_element", FMT_TEXT,
     "Element der BAFU-Liste, zu dem das Objekt zählt (Spaltenname ohne «out_» und «_m2»); leer = der Kultur-Code "
     "steht nicht in der Liste", quelle(SRC_CALC, "aus out_layer, out_kultur_code"), ""),
    ("out_feature_id", FMT_INT, "Technische Nummer des Objekts in seinem Datensatz", quelle(SRC_ALL, "Objekt-ID"), ""),
    ("out_kultur_code", FMT_INT, "Kultur-Code der Nutzungsfläche (z. B. 611); nur landwirtschaftliche Flächen",
     quelle(DATASETS[BLW], "Attribut «lnf_code»"), map_url(BLW)),
    ("out_bezeichnung", FMT_TEXT, "Bezeichnung der Nutzung (landwirtschaftliche Flächen) bzw. Name des Inventarobjekts",
     quelle(DATASETS[BLW], "Attribut «nutzung_de»") + "; " + quelle(SRC_INVENTARE, "Attribut «name»"), ""),
    ("out_objnummer", FMT_INT,
     "Objektnummer im Bundesinventar (TWW, Hoch- und Übergangsmoore, Flachmoore, Auengebiete); bei "
     "landwirtschaftlichen Flächen leer", quelle(SRC_INVENTARE, "Attribut «objnummer»"), ""),
    ("out_bff_qualitaet_1", FMT_TEXT,
     "Biodiversitätsförderfläche Qualitätsstufe I («1» = ja, «0» = nein); nur landwirtschaftliche Flächen",
     quelle(DATASETS[BLW], "Attribut «bff_qualitaet_1»"), map_url(BLW)),
    ("out_bezugsjahr", FMT_INT, "Stand des Eintrags als JJJJMMTT (z. B. 20250101); nur landwirtschaftliche Flächen",
     quelle(DATASETS[BLW], "Attribut «bezugsjahr»"), map_url(BLW)),
    ("out_area_m2", FMT_M2, "Fläche des Objekts innerhalb des Grundstücks",
     quelle(SRC_CALC, "aus der zugeschnittenen Fläche"), ""),
]


def element_column(element: dict) -> str:
    """Output column of an element."""
    return f"out_{element['key']}_m2"


def element_source(element: dict) -> str:
    """«Quelle» of an element: the dataset by its name, and the Kultur-Codes that select it."""
    name = DATASETS[element["layer"]]
    if element["codes"] is None:
        return quelle(name, "alle Flächen")
    codes = ", ".join(str(c) for c in element["codes"])
    return quelle(name, ("Kultur-Code " if len(element["codes"]) == 1 else "Kultur-Codes ") + codes)


def data_model() -> list[tuple[str, str, str, str, str, str]]:
    """Rows of the «Datenmodell» sheet: (Blatt / Layer, Attribut, Format, Beschreibung, Quelle, Link)."""
    sheet = SHEET_GRUNDSTUECKE
    rows = [(sheet, *c) for c in GRUNDSTUECK_COLS_IN + GRUNDSTUECK_COLS_HEAD]
    for e in ELEMENTS:
        rows.append((sheet, element_column(e), FMT_M2,
                     f"{e['element']}: Fläche auf dem Grundstück, überlappende Objekte einmal gezählt. "
                     f"Zeile {e['rows']}, Kategorie {e['kat']} der BAFU-Liste. {EMPTY_VS_ZERO}",
                     element_source(e), map_url(e["layer"])))
    for k, label in KATEGORIEN.items():
        cols = ", ".join(element_column(e) for e in ELEMENTS if e["kat"] == k)
        rows.append((sheet, f"out_kat{k}_m2", FMT_M2,
                     f"Kategorie {k} der BAFU-Liste: {label}. Ihre Elemente zusammen, jede Fläche einmal "
                     "gezählt. Leer, sobald ein beteiligter Datensatz nicht abgefragt werden konnte.",
                     quelle(SRC_CALC, f"aus {cols}"), ""))
    rows += [(sheet, *c) for c in GRUNDSTUECK_COLS_TAIL]

    gj = f"GeoJSON · {LAYER_GRUNDSTUECK}"
    rows.append((gj, "geometry", FMT_GEOM,
                 "Grenze des Grundstücks; ein Feature je Zeile der Eingabeliste, deren Grundstück gefunden wurde",
                 quelle(DATASETS[AV], "Grundstücksgrenze"), map_url(AV)))
    rows.append((gj, "layer", FMT_TEXT, f"Immer «{LAYER_GRUNDSTUECK}»", quelle(SRC_CALC, "fester Wert"), ""))
    rows.append((gj, "in_… / out_…", "wie Blatt", f"Alle Attribute des Blatts «{sheet}»",
                 quelle(SRC_SHEET, "alle Spalten"), ""))
    gj = f"GeoJSON · {LAYER_NATURNAH}"
    rows.append((gj, "geometry", FMT_GEOM,
                 "Auf das Grundstück zugeschnittenes Objekt eines Datensatzes; ein Feature je Objekt und Grundstück. "
                 "Enthält alle landwirtschaftlichen Flächen, auch solche, deren Kultur-Code nicht in der BAFU-Liste steht.",
                 quelle(SRC_ALL, "Fläche innerhalb der Grundstücksgrenze"), ""))
    rows.append((gj, "layer", FMT_TEXT, f"Immer «{LAYER_NATURNAH}»", quelle(SRC_CALC, "fester Wert"), ""))
    rows += [(gj, *c) for c in OBJEKT_COLS]
    return rows
