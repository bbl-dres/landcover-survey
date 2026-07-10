"""Web-parity classification — ports the functions in ``web/js/config.js``.

The base BBArt maps (SIA 416, DIN 277, green space, sealed, VBS) already live in
:mod:`config` and are verified identical to the web's. This module adds the parts
the web-parity API path needs that the GeoPackage pipeline never used:

- :func:`classify` — the web's ``classify(art)``, returning **codes** (``kat_a`` /
  ``produktiv`` / ``typ1`` …), which :mod:`processor_web` maps to the stable
  English output labels via ``config.VBS_*_LABELS``;
- the BAFU Lebensraumkarte (TypoCH) tables: :data:`BAFU_TYPOCH_L1` (level-1 class
  defaults) + :data:`BAFU_TYPOCH_REFINE` (level-2/3 overrides) for the habitat overlay
  (:func:`classify_bafu`), and :data:`TYPOCH_BBART` for the synthetic-AV fallback
  (:func:`typoch_to_bbart`).

Keep this in lock-step with ``web/js/config.js`` — the cross-check depends on it.
"""

from __future__ import annotations

import re

from config import (
    BAFU_TYPOCH_L1,
    BAFU_TYPOCH_REFINE,
    DEFAULT_GREEN_SPACE,
    DIN277,
    GREEN_SPACE,
    SIA416,
    VBS_KATEGORIE,
    VBS_PRODUKTIV,
    VBS_TYP,
    VERSIEGELT_ARTS,
    habitat_l1_label,
    slugify,
    typoch_code,
    typoch_code_at_level,
    typoch_l1,
    typoch_l1_label,
    typoch_l2_label,
    typoch_l3_label,
    typoch_name,
)

__all__ = [
    "classify", "BAFU_TYPOCH_L1", "BAFU_TYPOCH_REFINE", "typoch_l1", "habitat_l1_label",
    "typoch_code", "typoch_code_at_level", "typoch_l1_label", "typoch_l2_label", "typoch_l3_label",
    "classify_bafu", "TYPOCH_BBART", "typoch_to_bbart", "slugify",
    "bauzone_area_key", "is_bauzone_area_key",
    "habitat_area_key_l1", "habitat_area_key_l2", "is_habitat_area_key",
    "habitat_key_level", "habitat_code_from_key", "habitat_name_from_key",
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
# BAFU Lebensraumkarte (TypoCH) — habitat overlay classification.
# The level-1 table (`BAFU_TYPOCH_L1`) and label helpers live in :mod:`config`
# (single source of truth, shared with the gpkg pipeline) and are re-exported
# here so this module keeps mirroring web/js/config.js one-to-one.
# ---------------------------------------------------------------------------

# Fallback classification for an unknown code — matches classifyBafu().
_BAFU_DEFAULT = {"green": "Not green space", "vbsKategorie": "kat_d", "vbsProduktiv": "unproduktiv", "vbsTyp": None}


def classify_bafu(typoch_de: str | None) -> dict:
    """Classify a BAFU TypoCH habitat label for the fields BAFU can supply (green + VBS).

    Resolves the code **most-specific-first** against :data:`BAFU_TYPOCH_REFINE` (level-2/3
    overrides), then the level-1 class default in :data:`BAFU_TYPOCH_L1`, then a neutral
    fallback — mirror of ``classifyBafu()``. ``sia416`` / ``din277`` / ``sealed`` are ``None``.
    """
    parts = [p for p in typoch_code(typoch_de).split(".") if p]
    m = None
    for i in range(len(parts), 0, -1):
        m = BAFU_TYPOCH_REFINE.get(".".join(parts[:i]))
        if m:
            break
    if not m:
        m = BAFU_TYPOCH_L1.get(parts[0] if parts else "", _BAFU_DEFAULT)
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
# Per-type area column keys — mirror the web's bauzoneAreaKey / habitatAreaKeyL1/L2.
# Bauzonen: `bauzonen_<slug>_m2` (slug via config.slugify). Habitat: code-based at two
# levels, `habitat_l1_<code>_m2` / `habitat_l2_<code>_m2` (dotted code, dots → '_');
# the name is looked up from the TypoCH reference at display time.
# ---------------------------------------------------------------------------
_BAUZONEN_PREFIX, _BAUZONEN_SUFFIX = "bauzonen_", "_m2"
_HABITAT_KEY_RE = re.compile(r"^habitat_l([12])_(.+)_m2$")


def bauzone_area_key(name: str) -> str:
    return f"{_BAUZONEN_PREFIX}{slugify(name)}{_BAUZONEN_SUFFIX}"


def is_bauzone_area_key(k: str) -> bool:
    return k.startswith(_BAUZONEN_PREFIX) and k.endswith(_BAUZONEN_SUFFIX) and k != "bauzonen_m2"


def habitat_area_key_l1(code: str) -> str:
    return f"habitat_l1_{str(code).replace('.', '_')}_m2"


def habitat_area_key_l2(code: str) -> str:
    return f"habitat_l2_{str(code).replace('.', '_')}_m2"


def is_habitat_area_key(k: str) -> bool:
    return bool(_HABITAT_KEY_RE.match(k))


def habitat_key_level(k: str) -> int:
    m = _HABITAT_KEY_RE.match(k)
    return int(m.group(1)) if m else 0


def habitat_code_from_key(k: str) -> str:
    m = _HABITAT_KEY_RE.match(k)
    return m.group(2).replace("_", ".") if m else ""


def habitat_name_from_key(k: str) -> str:
    code = habitat_code_from_key(k)
    name = typoch_name(code)
    return f"{code} {name}" if name else code
