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
# Check_EGRID messages
# ---------------------------------------------------------------------------
MSG_EGRID_FOUND = "EGRID found in AV"
MSG_EGRID_MERGED = "EGRID found in AV ({n} entries merged)"
MSG_EGRID_NOT_FOUND = "EGRID missing or not in AV"
