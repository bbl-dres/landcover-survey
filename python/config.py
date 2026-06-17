"""Constants, classification mappings, and default paths."""

from pathlib import Path

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
DEFAULT_GPKG_PATH = Path(r"D:\AV_lv95\av_2056.gpkg")
CRS_EPSG = 2056
CRS_STRING = f"EPSG:{CRS_EPSG}"
SLIVER_THRESHOLD = 0.001  # m² — clip results smaller than this are dropped

# GeoPackage layer names
LAYER_PARCELS = "resf"
LAYER_LANDCOVER = "lcsf"

# Actual column names in the AV GeoPackage
COL_FLAECHE = "Flaeche"  # official area column in resf

# SQL batch size for IN-clause queries
SQL_BATCH_SIZE = 500

# ---------------------------------------------------------------------------
# Green space classification  (Art → Check_GreenSpace)
# ---------------------------------------------------------------------------
GREEN_SPACE: dict[str, str] = {
    # Soil-covered (humusiert)
    "Acker_Wiese_Weide": "Green space (soil-covered)",
    "Reben": "Green space (soil-covered)",
    "Gartenanlage": "Green space (soil-covered)",
    "Hoch_Flachmoor": "Green space (soil-covered)",
    "uebrige_humusierte": "Green space (soil-covered)",
    # Wytweide — officially wooded (bestockt), treated as soil-covered (pasture dominates)
    "Wytweide_dicht": "Green space (soil-covered)",
    "Wytweide_offen": "Green space (soil-covered)",
    # Wooded (bestockt)
    "geschlossener_Wald": "Green space (wooded)",
    "uebrige_bestockte": "Green space (wooded)",
}

DEFAULT_GREEN_SPACE = "Not green space"

# ---------------------------------------------------------------------------
# SIA 416 classification  (Art → SIA 416 category)
#
# GSF (Grundstücksfläche) = GGF + UF
# UF  (Umgebungsfläche)   = BUF + UUF
# ---------------------------------------------------------------------------
SIA416: dict[str, str] = {
    # GGF — Gebäudegrundfläche
    "Gebaeude": "GGF",
    # BUF — Bearbeitete Umgebungsfläche (befestigt + humusiert)
    "Strasse_Weg": "BUF",
    "Trottoir": "BUF",
    "Verkehrsinsel": "BUF",
    "Bahn": "BUF",
    "Flugplatz": "BUF",
    "Wasserbecken": "BUF",
    "uebrige_befestigte": "BUF",
    "Acker_Wiese_Weide": "BUF",
    "Reben": "BUF",
    "uebrige_Intensivkultur": "BUF",
    "Gartenanlage": "BUF",
    "Hoch_Flachmoor": "BUF",
    "uebrige_humusierte": "BUF",
    # BUF — Wytweide: officially bestockt, but actively managed pasture = bearbeitet (SIA 416)
    "Wytweide_dicht": "BUF",
    "Wytweide_offen": "BUF",
    # UUF — Unbearbeitete Umgebungsfläche (Gewässer + bestockt + vegetationslos)
    "Gewaesser_stehendes": "UUF",
    "Gewaesser_fliessendes": "UUF",
    "Schilfguertel": "UUF",
    "geschlossener_Wald": "UUF",
    "uebrige_bestockte": "UUF",
    "Fels": "UUF",
    "Gletscher_Firn": "UUF",
    "Geroell_Sand": "UUF",
    "Abbau_Deponie": "UUF",
    "uebrige_vegetationslose": "UUF",
}

# Versiegelt = GGF + befestigt (subset of BUF)
VERSIEGELT_ARTS: set[str] = {
    "Gebaeude", "Strasse_Weg", "Trottoir", "Verkehrsinsel",
    "Bahn", "Flugplatz", "Wasserbecken", "uebrige_befestigte",
}

# ---------------------------------------------------------------------------
# DIN 277:2021 classification  (Art → DIN 277 category)
#
# GF  (Grundstücksfläche) = BF + UF
# AF  (Außenanlagenfläche) overlaps both — area outside the building
# ---------------------------------------------------------------------------
DIN277: dict[str, str] = {
    # BF — Bebaute Fläche (überbaut / unterbaut)
    "Gebaeude": "BF",
    # UF — Unbebaute Fläche (nicht überbaut)
    "Strasse_Weg": "UF",
    "Trottoir": "UF",
    "Verkehrsinsel": "UF",
    "Bahn": "UF",
    "Flugplatz": "UF",
    "Wasserbecken": "UF",
    "uebrige_befestigte": "UF",
    "Acker_Wiese_Weide": "UF",
    "Reben": "UF",
    "uebrige_Intensivkultur": "UF",
    "Gartenanlage": "UF",
    "Hoch_Flachmoor": "UF",
    "uebrige_humusierte": "UF",
    "Wytweide_dicht": "UF",
    "Wytweide_offen": "UF",
    "Gewaesser_stehendes": "UF",
    "Gewaesser_fliessendes": "UF",
    "Schilfguertel": "UF",
    "geschlossener_Wald": "UF",
    "uebrige_bestockte": "UF",
    "Fels": "UF",
    "Gletscher_Firn": "UF",
    "Geroell_Sand": "UF",
    "Abbau_Deponie": "UF",
    "uebrige_vegetationslose": "UF",
}

# ---------------------------------------------------------------------------
# VBS Kategorie classification  (Art → base category a–d)
#
# Based on: "Auswertung naturnahe VBS Flächen" (arImmo internal)
# Groups the 26 BBArt types into four base categories used by VBS/arImmo.
# ---------------------------------------------------------------------------
VBS_KATEGORIE: dict[str, str] = {
    # A. Siedlungsfläche
    "Gebaeude": "kat_a",
    "Strasse_Weg": "kat_a",
    "Trottoir": "kat_a",
    "Verkehrsinsel": "kat_a",
    "Bahn": "kat_a",
    "Flugplatz": "kat_a",
    "Wasserbecken": "kat_a",
    "uebrige_befestigte": "kat_a",
    "Abbau_Deponie": "kat_a",
    # B. Landwirtschaftsfläche
    "Acker_Wiese_Weide": "kat_b",
    "Reben": "kat_b",
    "uebrige_Intensivkultur": "kat_b",
    "Gartenanlage": "kat_b",
    "uebrige_humusierte": "kat_b",
    "Wytweide_dicht": "kat_b",
    "Wytweide_offen": "kat_b",
    # C. Bestockte Fläche
    "geschlossener_Wald": "kat_c",
    "uebrige_bestockte": "kat_c",
    # D. Unproduktive Fläche
    "Hoch_Flachmoor": "kat_d",
    "Gewaesser_stehendes": "kat_d",
    "Gewaesser_fliessendes": "kat_d",
    "Schilfguertel": "kat_d",
    "Fels": "kat_d",
    "Gletscher_Firn": "kat_d",
    "Geroell_Sand": "kat_d",
    "uebrige_vegetationslose": "kat_d",
}

# ---------------------------------------------------------------------------
# VBS biological productivity  (Art → produktiv / unproduktiv)
#
# 1 Biologisch produktiv  = B + C + D  minus  Fels, Gletscher_Firn, Geroell_Sand
# 2 Biologisch unproduktiv = A  plus  Fels, Gletscher_Firn, Geroell_Sand
# ---------------------------------------------------------------------------
_UNPRODUKTIV_FROM_D = {"Fels", "Gletscher_Firn", "Geroell_Sand"}

VBS_PRODUKTIV: dict[str, str] = {
    art: "unproduktiv" if (kat == "kat_a" or art in _UNPRODUKTIV_FROM_D) else "produktiv"
    for art, kat in VBS_KATEGORIE.items()
}

# ---------------------------------------------------------------------------
# VBS Typ  (within biologically productive only)
#
# Typ 1 — Grünflächen in Gebäudeumgebung  = Gartenanlage only
# Typ 2 — Übrige Grünflächen              = all other biologically productive
# ---------------------------------------------------------------------------
VBS_TYP: dict[str, str] = {
    art: ("typ1" if art == "Gartenanlage" else "typ2")
    for art, prod in VBS_PRODUKTIV.items()
    if prod == "produktiv"
}

# ---------------------------------------------------------------------------
# VBS output values  (stable, language-independent strings)
#
# Written verbatim to the "VBS Kategorie" / "VBS Biologisch produktiv" /
# "VBS Typ" output columns. The web app translates these for display; the
# CSV carries them as-is. Mirrors the Check_GreenSpace string pattern.
# Biologically unproductive types have NO Typ ("" — per the document hint
# "Unterscheidung Typ 1 und Typ 2 innerhalb biologisch produktiver Fläche").
# ---------------------------------------------------------------------------
VBS_KATEGORIE_LABELS: dict[str, str] = {
    "kat_a": "A. Settlement area",
    "kat_b": "B. Agricultural area",
    "kat_c": "C. Wooded area",
    "kat_d": "D. Unproductive area",
}
VBS_PRODUKTIV_LABELS: dict[str, str] = {
    "produktiv": "1 Biologically productive",
    "unproduktiv": "2 Biologically unproductive",
}
VBS_TYP_LABELS: dict[str, str] = {
    "typ1": "Type 1 - Green spaces near buildings",
    "typ2": "Type 2 - Other green spaces",
}

# Defaults for Art values outside the BBArt domain (mirror the web classify()
# fallbacks: unknown → kat_d / unproduktiv / no Typ).
DEFAULT_VBS_KATEGORIE = VBS_KATEGORIE_LABELS["kat_d"]
DEFAULT_VBS_PRODUKTIV = VBS_PRODUKTIV_LABELS["unproduktiv"]
DEFAULT_VBS_TYP = ""

# Art → stable output value (built from the code maps above)
VBS_KATEGORIE_BY_ART: dict[str, str] = {
    art: VBS_KATEGORIE_LABELS[kat] for art, kat in VBS_KATEGORIE.items()
}
VBS_PRODUKTIV_BY_ART: dict[str, str] = {
    art: VBS_PRODUKTIV_LABELS[prod] for art, prod in VBS_PRODUKTIV.items()
}
VBS_TYP_BY_ART: dict[str, str] = {
    art: VBS_TYP_LABELS[typ] for art, typ in VBS_TYP.items()
}

# Output column names (German, matching the source document)
COL_VBS_KATEGORIE = "VBS Kategorie"
COL_VBS_PRODUKTIV = "VBS Biologisch produktiv"
COL_VBS_TYP = "VBS Typ"

# ---------------------------------------------------------------------------
# Check_EGRID messages
# ---------------------------------------------------------------------------
MSG_EGRID_FOUND = "EGRID found in AV"
MSG_EGRID_MERGED = "EGRID found in AV ({n} entries merged)"
MSG_EGRID_NOT_FOUND = "EGRID missing or not in AV"
