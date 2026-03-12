"""Constants, classification mappings, and default paths."""

from pathlib import Path

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
DEFAULT_GPKG_PATH = Path(r"D:\AV_lv95\av_2056.gpkg")
CRS_EPSG = 2056
SLIVER_THRESHOLD = 0.001  # m² — clip results smaller than this are dropped

# GeoPackage layer names
LAYER_PARCELS = "resf"
LAYER_LANDCOVER = "lcsf"

# Actual column names in the AV GeoPackage
COL_FLAECHE = "Flaeche"  # official area column in resf

# SQL batch size for IN-clause queries
SQL_BATCH_SIZE = 500

# ---------------------------------------------------------------------------
# Green space classification  (Art → Check_Grünfläche)
# ---------------------------------------------------------------------------
GREEN_SPACE: dict[str, str] = {
    # Humusiert
    "Acker_Wiese_Weide": "Grünfläche (Humusiert)",
    "Reben": "Grünfläche (Humusiert)",
    "Gartenanlage": "Grünfläche (Humusiert)",
    "Hoch_Flachmoor": "Grünfläche (Humusiert)",
    "uebrige_humusierte": "Grünfläche (Humusiert)",
    # Wytweide — officially bestockt, treated as Humusiert (pasture dominates)
    "Wytweide_dicht": "Grünfläche (Humusiert)",
    "Wytweide_offen": "Grünfläche (Humusiert)",
    # Bestockt
    "geschlossener_Wald": "Grünfläche (Bestockt)",
    "uebrige_bestockte": "Grünfläche (Bestockt)",
}

DEFAULT_GREEN_SPACE = "Keine Grünfläche"

# ---------------------------------------------------------------------------
# SIA 416 classification  (Art → SIA 416 category)
# ---------------------------------------------------------------------------
SIA416: dict[str, str] = {
    "Gebaeude": "GGF",
    "Strasse_Weg": "HF",
    "Trottoir": "HF",
    "Verkehrsinsel": "HF",
    "Bahn": "HF",
    "Flugplatz": "HF",
    "Wasserbecken": "HF",
    "uebrige_befestigte": "HF",
    "Acker_Wiese_Weide": "GF",
    "Reben": "GF",
    "uebrige_Intensivkultur": "GF",
    "Gartenanlage": "GF",
    "Hoch_Flachmoor": "GF",
    "uebrige_humusierte": "GF",
    "stehendes": "WF",
    "fliessendes": "WF",
    "Schilfguertel": "GF",
    "geschlossener_Wald": "GF",
    "Wytweide_dicht": "GF",
    "Wytweide_offen": "GF",
    "uebrige_bestockte": "GF",
    "Fels": "üF",
    "Gletscher_Firn": "üF",
    "Geroell_Sand": "üF",
    "Abbau_Deponie": "üF",
    "uebrige_vegetationslose": "üF",
}

# Versiegelt = GGF + HF
VERSIEGELT_CATEGORIES = {"GGF", "HF"}

# ---------------------------------------------------------------------------
# Check_EGRID messages
# ---------------------------------------------------------------------------
MSG_EGRID_FOUND = "EGRID in AV gefunden"
MSG_EGRID_MERGED = "EGRID in AV gefunden ({n} Einträge zusammengeführt)"
MSG_EGRID_NOT_FOUND = "EGRID fehlt oder nicht in AV"
