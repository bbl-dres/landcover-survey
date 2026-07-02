"""Web-parity classification — ports the functions in ``web/js/config.js``.

The base BBArt maps (SIA 416, DIN 277, green space, sealed, VBS) already live in
:mod:`config` and are verified identical to the web's. This module adds the parts
the web-parity API path needs that the GeoPackage pipeline never used:

- :func:`classify` — the web's ``classify(art)``, returning **codes** (``kat_a`` /
  ``produktiv`` / ``typ1`` …), which :mod:`processor_web` maps to the stable
  English output labels via ``config.VBS_*_LABELS``;
- the BAFU Lebensraumkarte (TypoCH) tables: :data:`BAFU_TYPOCH_L1` for the habitat
  overlay (:func:`classify_bafu`) and :data:`TYPOCH_BBART` for the synthetic-AV
  fallback (:func:`typoch_to_bbart`).

Keep this in lock-step with ``web/js/config.js`` — the cross-check depends on it.
"""

from __future__ import annotations

from config import (
    DEFAULT_GREEN_SPACE,
    DIN277,
    GREEN_SPACE,
    SIA416,
    VBS_KATEGORIE,
    VBS_PRODUKTIV,
    VBS_TYP,
    VERSIEGELT_ARTS,
    slugify,
)

__all__ = [
    "classify", "BAFU_TYPOCH_L1", "typoch_l1", "habitat_l1_label", "classify_bafu",
    "TYPOCH_BBART", "typoch_to_bbart", "slugify",
    "bauzone_area_key", "is_bauzone_area_key", "habitat_area_key", "is_habitat_area_key",
]


def classify(art: str) -> dict:
    """Classify one BBArt type — mirror of ``config.js`` ``classify()``.

    Returns codes (not labels): ``sia416`` GGF/BUF/UUF, ``din277`` BF/UF,
    ``greenSpace`` (English code), ``sealed`` bool, ``vbsKategorie`` kat_a–d,
    ``vbsProduktiv`` produktiv/unproduktiv, ``vbsTyp`` typ1/typ2/None. Unknown
    ``art`` falls back exactly as the web does (UUF / UF / not green / kat_d /
    unproduktiv / no Typ).
    """
    return {
        "sia416": SIA416.get(art, "UUF"),
        "din277": DIN277.get(art, "UF"),
        "greenSpace": GREEN_SPACE.get(art, DEFAULT_GREEN_SPACE),
        "sealed": art in VERSIEGELT_ARTS,
        "vbsKategorie": VBS_KATEGORIE.get(art, "kat_d"),
        "vbsProduktiv": VBS_PRODUKTIV.get(art, "unproduktiv"),
        "vbsTyp": VBS_TYP.get(art),  # None when absent — matches `VBS_TYP[art] || null`
    }


# ---------------------------------------------------------------------------
# BAFU Lebensraumkarte (TypoCH) — habitat overlay classification
#
# Keyed by TypoCH level-1 code (leading digit of `typoch_de`). Only green space +
# VBS are derived; SIA 416 / DIN 277 / sealed are None (a modeled habitat map
# can't resolve building footprints). Port of `BAFU_TYPOCH_L1` in config.js —
# the `color` field is web-only (map rendering) and intentionally omitted here.
# ---------------------------------------------------------------------------
BAFU_TYPOCH_L1: dict[str, dict] = {
    "1": {"name": "Gewässer", "green": "Not green space", "vbsKategorie": "kat_d", "vbsProduktiv": "produktiv", "vbsTyp": "typ2"},
    "2": {"name": "Ufer & Feuchtgebiete", "green": "Green space (soil-covered)", "vbsKategorie": "kat_d", "vbsProduktiv": "produktiv", "vbsTyp": "typ2"},
    "3": {"name": "Gletscher, Fels, Schutt, Geröll", "green": "Not green space", "vbsKategorie": "kat_d", "vbsProduktiv": "unproduktiv", "vbsTyp": None},
    "4": {"name": "Grünland", "green": "Green space (soil-covered)", "vbsKategorie": "kat_b", "vbsProduktiv": "produktiv", "vbsTyp": "typ2"},
    "5": {"name": "Krautsäume, Hochstauden, Gebüsche", "green": "Green space (wooded)", "vbsKategorie": "kat_c", "vbsProduktiv": "produktiv", "vbsTyp": "typ2"},
    "6": {"name": "Wälder", "green": "Green space (wooded)", "vbsKategorie": "kat_c", "vbsProduktiv": "produktiv", "vbsTyp": "typ2"},
    "7": {"name": "Pionier-/Ruderalvegetation", "green": "Not green space", "vbsKategorie": "kat_d", "vbsProduktiv": "produktiv", "vbsTyp": "typ2"},
    "8": {"name": "Pflanzungen, Äcker, Kulturen", "green": "Green space (soil-covered)", "vbsKategorie": "kat_b", "vbsProduktiv": "produktiv", "vbsTyp": "typ2"},
    "9": {"name": "Gebäude / Anlagen", "green": "Not green space", "vbsKategorie": "kat_a", "vbsProduktiv": "unproduktiv", "vbsTyp": None},
}

# Fallback classification for an unknown level-1 code — matches classifyBafu().
_BAFU_DEFAULT = {"green": "Not green space", "vbsKategorie": "kat_d", "vbsProduktiv": "unproduktiv", "vbsTyp": None}


def typoch_l1(typoch_de: str | None) -> str:
    """TypoCH level-1 digit of a habitat label ('6.3.1 Buchenwald' → '6'; '' → '')."""
    return str(typoch_de or "").strip()[:1]


def habitat_l1_label(typoch_de: str | None) -> str:
    """Display name for a TypoCH level-1 code, falling back to the raw label."""
    m = BAFU_TYPOCH_L1.get(typoch_l1(typoch_de))
    return m["name"] if m else (typoch_de or "–")


def classify_bafu(typoch_de: str | None) -> dict:
    """Classify a BAFU TypoCH habitat label by its level-1 code — ``classifyBafu()``.

    Same shape as :func:`classify` for the fields BAFU can supply (green + VBS);
    ``sia416`` / ``din277`` / ``sealed`` are ``None``.
    """
    m = BAFU_TYPOCH_L1.get(typoch_l1(typoch_de), _BAFU_DEFAULT)
    return {
        "sia416": None,
        "din277": None,
        "sealed": None,
        "greenSpace": m["green"],
        "vbsKategorie": m["vbsKategorie"],
        "vbsProduktiv": m["vbsProduktiv"],
        "vbsTyp": m["vbsTyp"],
    }


# ---------------------------------------------------------------------------
# TypoCH → AV BBArt crosswalk (synthetic-AV fallback). Port of `TYPOCH_BBART`.
# Keyed by TypoCH code, most-specific-first: dotted keys refine the single-digit
# level-1 defaults (above all class 9, the building-vs-road / sealed split).
# ---------------------------------------------------------------------------
TYPOCH_BBART: dict[str, str] = {
    # level-1 defaults
    "1": "Gewaesser_stehendes",
    "2": "Hoch_Flachmoor",
    "3": "Geroell_Sand",
    "4": "Acker_Wiese_Weide",
    "5": "uebrige_bestockte",
    "6": "geschlossener_Wald",
    "7": "uebrige_vegetationslose",
    "8": "Acker_Wiese_Weide",
    "9": "uebrige_befestigte",
    # class 9 refinements
    "9.2": "Gebaeude",
    "9.3.2": "Strasse_Weg",
    "9.0.2": "uebrige_befestigte",
    "9.3.3": "uebrige_vegetationslose",
}


def typoch_to_bbart(typoch_de: str | None) -> str | None:
    """Resolve a TypoCH label to a synthetic BBArt, most-specific code first.

    '9.3.2 Asphalt- und Betonstrasse' → 'Strasse_Weg'; falls back to the level-1
    default; returns ``None`` when nothing matches (caller skips the piece).
    """
    s = str(typoch_de or "").strip()
    if not s:
        return None
    parts = s.split()[0].split(".")  # code token, e.g. "9.3.2" → ["9","3","2"]
    while parts:
        key = ".".join(parts)
        if key in TYPOCH_BBART:
            return TYPOCH_BBART[key]
        parts.pop()
    return None


# ---------------------------------------------------------------------------
# Per-type area column keys — mirror the web's bauzoneAreaKey / habitatAreaKey.
# A parcel can span several zones / habitat groups, so each becomes its own
# `bauzonen_<slug>_m2` / `habitat_<slug>_m2` column (slug via config.slugify).
# ---------------------------------------------------------------------------
_BAUZONEN_PREFIX, _BAUZONEN_SUFFIX = "bauzonen_", "_m2"
_HABITAT_PREFIX, _HABITAT_SUFFIX = "habitat_", "_m2"


def bauzone_area_key(name: str) -> str:
    return f"{_BAUZONEN_PREFIX}{slugify(name)}{_BAUZONEN_SUFFIX}"


def is_bauzone_area_key(k: str) -> bool:
    return k.startswith(_BAUZONEN_PREFIX) and k.endswith(_BAUZONEN_SUFFIX) and k != "bauzonen_m2"


def habitat_area_key(name: str) -> str:
    return f"{_HABITAT_PREFIX}{slugify(name)}{_HABITAT_SUFFIX}"


def is_habitat_area_key(k: str) -> bool:
    return k.startswith(_HABITAT_PREFIX) and k.endswith(_HABITAT_SUFFIX) and k != "habitat_m2"
