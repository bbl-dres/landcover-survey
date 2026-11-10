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

# Elements of the list that this sample does NOT cover, and why (written to the
# «Quellen» sheet so the gaps stay visible).
NOT_COVERED = [
    ("7", "Stufige Waldränder", "keine Datenquelle in der Liste"),
    ("8", "Hochstammobstgärten (≥20 Bäume)",
     "Kultur-Codes 921–923 kommen im BLW-Layer nicht vor (Bäume werden vermutlich als Stückzahl geführt, nicht als Fläche)"),
    ("9", "Einheimische Einzelbäume / Baumgruppen",
     "Kultur-Code 924 kommt im BLW-Layer nicht vor (vermutlich Stückzahl, keine Fläche)"),
    ("14", "Kies-/Mergelplätze, schwach bewachsene Flächen", "nur REN-Layer als Zusatzinformation"),
    ("15", "Gewässerufer (bewachsen)", "Bestockungskarte ist über identify nicht abfragbar (HTTP 400)"),
    ("16", "Tümpel, Teiche, Wassergräben (naturnah)", "keine eindeutige Datenquelle"),
    ("19", "Nährstoffreiche Feuchtwiesen (nicht Moor)", "nur REN-Layer / Feuchtgebietskorridore"),
    ("21", "Spezielle Waldstandorte", "Waldreservate: noch nicht eingebunden"),
    ("22", "Felsen, Schutthalden", "nur «ev.»-Quellen"),
    ("23", "Sonderstandorte", "keine Datenquelle in der Liste"),
    ("24", "Flachdach-/Fassadenbegrünung", "keine Datenquelle in der Liste"),
    ("25", "Versickerungsfähige Wege/Plätze", "keine Datenquelle in der Liste"),
    ("6, 9", "Lebensraumkarte – Gehölze (Datenquelle 2)", "noch nicht eingebunden"),
]

# ---------------------------------------------------------------------------
# Data dictionary (written to the «Datenmodell» sheet; see docs/DATAMODEL.md)
# ---------------------------------------------------------------------------

# Attributes the source layers deliver through ``identify``:
# (layer, attribute, type, description, used in the output as)
LAYER_ATTRS = [
    (BLW, "lnf_code", "integer", "Kultur-Code der Nutzungsfläche (z. B. 611); Filter für die Elemente", "out_kultur_code"),
    (BLW, "nutzung_de / _fr / _it", "text", "Bezeichnung der Nutzung zum Kultur-Code", "out_bezeichnung (de)"),
    (BLW, "hauptkategorie_de / _fr / _it", "text", "Hauptkategorie (Ackerfläche, Dauerwiesen, …)", ""),
    (BLW, "bff_qualitaet_1", "text", "Biodiversitätsförderfläche Qualitätsstufe I («1» = ja, «0» = nein)", "out_bff_qualitaet_1"),
    (BLW, "bezugsjahr", "integer", "Stand der Daten als JJJJMMTT (z. B. 20250101)", "out_bezugsjahr"),
    (BLW, "flaeche_m2", "integer", "Fläche des ganzen Objekts gemäss Quelle (nicht zugeschnitten)", ""),
    (BLW, "bewirtschaftungsgrad", "integer", "Bewirtschaftungsgrad in %", ""),
    (BLW, "nutzungsidentifikator", "text", "Kennung der Nutzungsfläche im kantonalen System", ""),
    (BLW, "bur_nr", "text", "BUR-Nummer des Betriebs (Betriebskennung, nicht exportiert)", ""),
    (BLW, "t_id / label", "text", "Technische Kennung des Objekts", ""),
    (TWW, "name", "text", "Name des Objekts", "out_bezeichnung"),
    (TWW, "objnummer", "integer", "Objektnummer im Bundesinventar", "out_objnummer"),
    (TWW, "teilobjnummer", "text", "Nummer des Teilobjekts (z. B. BE2130018)", ""),
    (TWW, "bewertung", "integer", "Bewertung des Teilobjekts", ""),
    (TWW, "singularitaet", "text", "Singularität (Ja / Nein)", ""),
    (TWW, "shape_area", "float", "Fläche des ganzen Objekts in m² (nicht zugeschnitten)", ""),
    (TWW, "refobjblat", "URL", "Objektblatt (PDF)", ""),
    (HOCHMOOR, "name", "text", "Name des Objekts", "out_bezeichnung"),
    (HOCHMOOR, "objnummer", "integer", "Objektnummer im Bundesinventar", "out_objnummer"),
    (HOCHMOOR, "hochmoore_type_de / _fr / _it", "text", "Typ (z. B. Primäre Hochmoorfläche)", ""),
    (HOCHMOOR, "hm_ke / unit_de / _fr / _it", "integer / text", "Kartiereinheit (z. B. Birken- und Fichtenmoore)", ""),
    (HOCHMOOR, "shape_area", "float", "Fläche der Teilfläche in m² (nicht zugeschnitten)", ""),
    (HOCHMOOR, "refobjblat", "URL", "Objektblatt (PDF)", ""),
    (FLACHMOOR, "name", "text", "Name des Objekts", "out_bezeichnung"),
    (FLACHMOOR, "objnummer", "integer", "Objektnummer im Bundesinventar", "out_objnummer"),
    (FLACHMOOR, "shape_area", "float", "Fläche des ganzen Objekts in m² (nicht zugeschnitten)", ""),
    (FLACHMOOR, "refobjblat", "URL", "Objektblatt (PDF)", ""),
    (AUEN, "name", "text", "Name des Objekts", "out_bezeichnung"),
    (AUEN, "objnummer", "integer", "Objektnummer im Bundesinventar", "out_objnummer"),
    (AUEN, "auen_type / auen_type_de / _fr / _it", "integer / text", "Auentyp (z. B. Fliessgewässer)", ""),
    (AUEN, "shape_area", "float", "Fläche des ganzen Objekts in m² (nicht zugeschnitten)", ""),
    (AUEN, "refobjblat", "URL", "Objektblatt (PDF)", ""),
]

# Columns of the «Parzellen» sheet: (column, type, description). ``in_`` = taken
# from the input list, ``out_`` = produced by this tool. The ``out_<element>_m2``
# and ``out_kat<n>_m2`` columns sit between HEAD and TAIL and are generated from
# ELEMENTS / KATEGORIEN.
PARCEL_COLS_IN = [
    ("in_egrid", "text", "Eidgenössischer Grundstücksidentifikator; einzige Pflichtspalte, Schlüssel für den Verschnitt"),
    ("in_<Spalte>", "text",
     "Jede weitere Spalte der Eingabeliste, unverändert übernommen (Name = Spaltentitel in Kleinbuchstaben, "
     "Sonderzeichen als «_»)"),
]
PARCEL_COLS_HEAD = [
    ("out_error", "text",
     "Alles, was an dieser Zeile nicht stimmt, mit «; » getrennt; leer = in Ordnung. Mögliche Einträge: "
     "«EGRID fehlt», «EGRID ungültig», «EGRID mehrfach in der Liste (n×)», «EGRID nicht gefunden», "
     "«Grundstück konnte nicht abgefragt werden (Meldung des Dienstes)», «Nicht verarbeitet (Lauf abgebrochen)» "
     "sowie die Layer, die nicht oder unvollständig abgefragt werden konnten, mit der Meldung des Dienstes"),
    ("out_check_egrid", "text",
     "«EGRID found», «EGRID not found», «EGRID missing», «Invalid EGRID», «Not processed» oder «Error: …»"),
    ("out_egrid_count", "integer",
     "Anzahl Zeilen der Eingabeliste mit dieser EGRID; > 1 = dasselbe Grundstück mehrfach (beim Summieren beachten)"),
    ("out_nummer", "text", "Grundstücksnummer gemäss amtlicher Vermessung"),
    ("out_parcel_area_m2", "m²", "Berechnete Fläche des Grundstücks"),
    ("out_check_naturnah", "text",
     "«ok» oder die Layer, die nicht oder unvollständig abgefragt werden konnten (betroffene Werte bleiben leer)"),
]
PARCEL_COLS_TAIL = [
    ("out_naturnah_total_m2", "m²", "Vereinigung aller Elemente auf dem Grundstück (Überlappungen einmal gezählt)"),
    ("out_naturnah_anteil_pct", "%", "out_naturnah_total_m2 / out_parcel_area_m2 × 100"),
    ("out_blw_total_m2", "m²", "Gesamte BLW-Nutzungsfläche auf dem Grundstück (alle Kultur-Codes), als Kontext"),
]

# Columns of the «Details» sheet (one row per clipped object and distinct EGRID).
DETAIL_COLS = [
    ("in_egrid", "text", "EGRID des Grundstücks (Schlüssel zum Blatt «Parzellen»)"),
    ("out_layer", "text", "Layer-ID auf geo.admin.ch, aus dem das Objekt stammt"),
    ("out_element", "text", "Schlüssel des Elements (Spalte ohne «out_» und «_m2»); leer = Kultur-Code nicht in der Liste"),
    ("out_feature_id", "integer", "Objekt-ID im Layer"),
    ("out_kultur_code", "integer", "BLW: lnf_code; sonst leer"),
    ("out_bezeichnung", "text", "BLW: nutzung_de; Inventare: name"),
    ("out_objnummer", "integer", "Inventare: Objektnummer; BLW: leer"),
    ("out_bff_qualitaet_1", "text", "BLW: Qualitätsstufe I («1» / «0»); sonst leer"),
    ("out_bezugsjahr", "integer", "BLW: Stand der Daten (JJJJMMTT); sonst leer"),
    ("out_area_m2", "m²", "Fläche des Objekts innerhalb des Grundstücks"),
]
