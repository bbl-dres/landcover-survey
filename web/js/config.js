/**
 * BBArt classification mappings — ported from python/config.py
 */
import { t, localeFmtNum, getLang } from "./i18n.js";

/** Land cover type → SIA 416 classification */
export const SIA416 = {
  Gebaeude: "GGF",
  Strasse_Weg: "BUF",
  Trottoir: "BUF",
  Verkehrsinsel: "BUF",
  Bahn: "BUF",
  Flugplatz: "BUF",
  Wasserbecken: "BUF",
  uebrige_befestigte: "BUF",
  Acker_Wiese_Weide: "BUF",
  Reben: "BUF",
  uebrige_Intensivkultur: "BUF",
  Gartenanlage: "BUF",
  Hoch_Flachmoor: "BUF",
  uebrige_humusierte: "BUF",
  Wytweide_dicht: "BUF",
  Wytweide_offen: "BUF",
  Gewaesser_stehendes: "UUF",
  Gewaesser_fliessendes: "UUF",
  Schilfguertel: "UUF",
  geschlossener_Wald: "UUF",
  uebrige_bestockte: "UUF",
  Fels: "UUF",
  Gletscher_Firn: "UUF",
  Geroell_Sand: "UUF",
  Abbau_Deponie: "UUF",
  uebrige_vegetationslose: "UUF",
};

/** Land cover type → DIN 277:2021 classification */
export const DIN277 = {
  Gebaeude: "BF",
};

/** Land cover type → Green Space classification */
export const GREEN_SPACE = {
  Acker_Wiese_Weide: "Green space (soil-covered)",
  Reben: "Green space (soil-covered)",
  Gartenanlage: "Green space (soil-covered)",
  Hoch_Flachmoor: "Green space (soil-covered)",
  uebrige_humusierte: "Green space (soil-covered)",
  Wytweide_dicht: "Green space (soil-covered)",
  Wytweide_offen: "Green space (soil-covered)",
  geschlossener_Wald: "Green space (wooded)",
  uebrige_bestockte: "Green space (wooded)",
};

/** Land cover type → VBS Kategorie (a–d) */
export const VBS_KATEGORIE = {
  // A. Siedlungsfläche
  Gebaeude: "kat_a",
  Strasse_Weg: "kat_a",
  Trottoir: "kat_a",
  Verkehrsinsel: "kat_a",
  Bahn: "kat_a",
  Flugplatz: "kat_a",
  Wasserbecken: "kat_a",
  uebrige_befestigte: "kat_a",
  Abbau_Deponie: "kat_a",
  // B. Landwirtschaftsfläche
  Acker_Wiese_Weide: "kat_b",
  Reben: "kat_b",
  uebrige_Intensivkultur: "kat_b",
  Gartenanlage: "kat_b",
  uebrige_humusierte: "kat_b",
  Wytweide_dicht: "kat_b",
  Wytweide_offen: "kat_b",
  // C. Bestockte Fläche
  geschlossener_Wald: "kat_c",
  uebrige_bestockte: "kat_c",
  // D. Unproduktive Fläche
  Hoch_Flachmoor: "kat_d",
  Gewaesser_stehendes: "kat_d",
  Gewaesser_fliessendes: "kat_d",
  Schilfguertel: "kat_d",
  Fels: "kat_d",
  Gletscher_Firn: "kat_d",
  Geroell_Sand: "kat_d",
  uebrige_vegetationslose: "kat_d",
};

/** VBS biological productivity — derived from VBS_KATEGORIE */
const _UNPRODUKTIV_FROM_D = new Set(["Fels", "Gletscher_Firn", "Geroell_Sand"]);
export const VBS_PRODUKTIV = Object.fromEntries(
  Object.entries(VBS_KATEGORIE).map(([art, kat]) => [
    art,
    kat === "kat_a" || _UNPRODUKTIV_FROM_D.has(art) ? "unproduktiv" : "produktiv",
  ])
);

/** VBS Typ — within biologically productive only */
export const VBS_TYP = Object.fromEntries(
  Object.entries(VBS_PRODUKTIV)
    .filter(([, prod]) => prod === "produktiv")
    .map(([art]) => [art, art === "Gartenanlage" ? "typ1" : "typ2"])
);

/** VBS code → stable English output value (written verbatim to export columns;
 *  translated for on-screen display via vbsKategorieLabel/… below). */
export const VBS_KATEGORIE_LABELS = {
  kat_a: "A. Settlement area",
  kat_b: "B. Agricultural area",
  kat_c: "C. Wooded area",
  kat_d: "D. Unproductive area",
};
export const VBS_PRODUKTIV_LABELS = {
  produktiv: "1 Biologically productive",
  unproduktiv: "2 Biologically unproductive",
};
export const VBS_TYP_LABELS = {
  typ1: "Type 1 - Green spaces near buildings",
  typ2: "Type 2 - Other green spaces",
};

/** Land cover types classified as sealed (versiegelt) */
export const SEALED = new Set([
  "Gebaeude",
  "Strasse_Weg",
  "Trottoir",
  "Verkehrsinsel",
  "Bahn",
  "Flugplatz",
  "Wasserbecken",
  "uebrige_befestigte",
]);

/** German display names for BBArt types */
export const ART_LABELS = {
  Gebaeude: "Gebäude",
  Strasse_Weg: "Strasse/Weg",
  Trottoir: "Trottoir",
  Verkehrsinsel: "Verkehrsinsel",
  Bahn: "Bahn",
  Flugplatz: "Flugplatz",
  Wasserbecken: "Wasserbecken",
  uebrige_befestigte: "Übrige befestigte",
  Acker_Wiese_Weide: "Acker/Wiese/Weide",
  Reben: "Reben",
  uebrige_Intensivkultur: "Übrige Intensivkultur",
  Gartenanlage: "Gartenanlage",
  Hoch_Flachmoor: "Hoch-/Flachmoor",
  uebrige_humusierte: "Übrige humusierte",
  Wytweide_dicht: "Wytweide (dicht)",
  Wytweide_offen: "Wytweide (offen)",
  Gewaesser_stehendes: "Stehendes Gewässer",
  Gewaesser_fliessendes: "Fliessendes Gewässer",
  Schilfguertel: "Schilfgürtel",
  geschlossener_Wald: "Geschlossener Wald",
  uebrige_bestockte: "Übrige bestockte",
  Fels: "Fels",
  Gletscher_Firn: "Gletscher/Firn",
  Geroell_Sand: "Geröll/Sand",
  Abbau_Deponie: "Abbau/Deponie",
  uebrige_vegetationslose: "Übrige vegetationslose",
};

/**
 * BAFU Lebensraumkarte (TypoCH) fallback mapping — used where AV land cover is
 * unavailable. Keyed by the TypoCH **level-1** code (the leading digit of the
 * `typoch_de` label, e.g. "6.x.x Wald" → "6"). Only green space + VBS are
 * derived; SIA 416 / DIN 277 / sealed are deliberately left blank for BAFU rows
 * (BAFU is a modeled habitat map and cannot resolve building footprints).
 *
 * Starting-point mapping — pending validation by the sustainability dept.
 * See docs/CLASSIFICATION.md (§Fallback) for rationale and the ⚠ judgment calls.
 */
export const BAFU_TYPOCH_L1 = {
  "1": { name: "Gewässer", color: "#2980b9", green: "Not green space", vbsKategorie: "kat_d", vbsProduktiv: "produktiv", vbsTyp: "typ2" },
  "2": { name: "Ufer & Feuchtgebiete", color: "#16a085", green: "Green space (soil-covered)", vbsKategorie: "kat_d", vbsProduktiv: "produktiv", vbsTyp: "typ2" },
  "3": { name: "Gletscher, Fels, Schutt, Geröll", color: "#aab7b8", green: "Not green space", vbsKategorie: "kat_d", vbsProduktiv: "unproduktiv", vbsTyp: null },
  "4": { name: "Grünland", color: "#2ecc71", green: "Green space (soil-covered)", vbsKategorie: "kat_b", vbsProduktiv: "produktiv", vbsTyp: "typ2" },
  "5": { name: "Krautsäume, Hochstauden, Gebüsche", color: "#82c341", green: "Green space (wooded)", vbsKategorie: "kat_c", vbsProduktiv: "produktiv", vbsTyp: "typ2" },
  "6": { name: "Wälder", color: "#1e8449", green: "Green space (wooded)", vbsKategorie: "kat_c", vbsProduktiv: "produktiv", vbsTyp: "typ2" },
  "7": { name: "Pionier-/Ruderalvegetation", color: "#d4ac0d", green: "Not green space", vbsKategorie: "kat_d", vbsProduktiv: "produktiv", vbsTyp: "typ2" },
  "8": { name: "Pflanzungen, Äcker, Kulturen", color: "#a3d977", green: "Green space (soil-covered)", vbsKategorie: "kat_b", vbsProduktiv: "produktiv", vbsTyp: "typ2" },
  "9": { name: "Gebäude / Anlagen", color: "#c0392b", green: "Not green space", vbsKategorie: "kat_a", vbsProduktiv: "unproduktiv", vbsTyp: null },
};

/** geo.admin.ch layer id of the BAFU habitat map (own layer + legacy fallback). */
export const BAFU_LAYER_ID = "ch.bafu.lebensraumkarte-schweiz";

/** TypoCH level-1 digit of a habitat label ("6.3.1 Buchenwald" → "6"). */
export function typochL1(typochDe) {
  return String(typochDe || "").trim().charAt(0);
}

/** Display name for a TypoCH level-1 code, falling back to the raw label. */
export function habitatL1Label(typochDe) {
  const m = BAFU_TYPOCH_L1[typochL1(typochDe)];
  return m ? m.name : (typochDe || "–");
}

/** Map/legend color for a habitat label, by its TypoCH level-1 code. */
export function habitatColor(typochDe) {
  return BAFU_TYPOCH_L1[typochL1(typochDe)]?.color || "#888";
}

/** Classify a BAFU TypoCH habitat label (e.g. "6.3.1 Buchenwald") by its
 *  level-1 code. Returns the same shape as classify() for the fields BAFU can
 *  supply (greenSpace + VBS); SIA 416 / DIN 277 / sealed are intentionally null. */
export function classifyBafu(typochDe) {
  const code = typochL1(typochDe); // TypoCH level-1 digit
  const m = BAFU_TYPOCH_L1[code] || { green: "Not green space", vbsKategorie: "kat_d", vbsProduktiv: "unproduktiv", vbsTyp: null };
  return {
    sia416: null,
    din277: null,
    sealed: null,
    greenSpace: m.green,
    vbsKategorie: m.vbsKategorie,
    vbsProduktiv: m.vbsProduktiv,
    vbsTyp: m.vbsTyp,
  };
}

/**
 * TypoCH → AV BBArt crosswalk for the SYNTHETIC land-cover fallback, used only
 * where AV land cover is missing. Each habitat type maps to the BBArt whose
 * classification (SIA 416 / sealed / green / VBS, via classify()) best matches it,
 * so synthesized features run through the exact same pipeline as real AV — the
 * geometry is real (the clipped BAFU polygon), only the BBArt label is inferred.
 *
 * Keyed by TypoCH code, most-specific-first: a fine code (e.g. "9.2") overrides its
 * level-1 default ("9"). The single-digit keys are the level-1 defaults; the dotted
 * keys refine what level-1 can't resolve — above all class 9, where the cadastral-
 * critical building-vs-road / sealed-vs-unsealed split lives.
 *
 * ⚠ Starting-point mapping, pending validation against real AV on dual-coverage
 * parcels (see docs/CLASSIFICATION.md §Synthetic AV). ⚠ marks the judgment calls.
 */
export const TYPOCH_BBART = {
  // ── level-1 defaults ──
  "1": "Gewaesser_stehendes",       // Gewässer → Wasser (UUF, not green, kat_d)
  "2": "Hoch_Flachmoor",            // Ufer & Feuchtgebiete → Moor/humusiert (BUF, green, kat_d)
  "3": "Geroell_Sand",              // Gletscher, Fels, Schutt → vegetationslos (UUF, kat_d, unprod.)
  "4": "Acker_Wiese_Weide",         // Grünland → humusiert (BUF, green, kat_b)
  "5": "uebrige_bestockte",         // Krautsäume/Hochstauden/Gebüsche → bestockt (UUF, green-wooded, kat_c)
  "6": "geschlossener_Wald",        // Wälder → Wald (UUF, green-wooded, kat_c)
  "7": "uebrige_vegetationslose",   // Pionier-/Ruderalvegetation → vegetationslos (UUF, not green, kat_d)
  "8": "Acker_Wiese_Weide",         // Pflanzungen, Äcker, Kulturen → humusiert (BUF, green, kat_b)
  "9": "uebrige_befestigte",        // ⚠ Gebäude/Anlagen (unspecified) → befestigt, sealed but not a building (BUF)
  // ── class 9 refinements (the cadastral-critical ones) ──
  "9.2": "Gebaeude",                // Bauten → Gebäude (GGF, sealed)
  "9.3.2": "Strasse_Weg",           // Asphalt-/Betonstrasse → Strasse (BUF, sealed)
  "9.0.2": "uebrige_befestigte",    // Versiegelte vegetationslose Fläche → befestigt (BUF, sealed)
  "9.3.3": "uebrige_vegetationslose", // ⚠ Naturstrasse/Weg (unbefestigt) → not sealed
};

/** Resolve a TypoCH label (e.g. "9.3.2 Asphalt- und Betonstrasse") to a synthetic
 *  BBArt via TYPOCH_BBART, trying the most specific code first and falling back to
 *  the level-1 default. Returns null when nothing matches (caller skips the piece). */
export function typochToBBArt(typochDe) {
  const code = String(typochDe || "").trim().split(/\s+/)[0]; // "9.3.2"
  if (!code) return null;
  const parts = code.split(".");
  while (parts.length) {
    const key = parts.join(".");
    if (TYPOCH_BBART[key]) return TYPOCH_BBART[key];
    parts.pop();
  }
  return null;
}

/** Harmonised Bauzonen main-use category (ch.are.bauzonen `ch_code_hn`) → colour,
 *  loosely following Swiss zoning-plan conventions. Keyed by the harmonised code
 *  so a category gets the same colour in every municipality. */
export const BAUZONEN_HN_COLORS = {
  "11": "#f4c430", // Wohnzonen — residential yellow
  "12": "#8e8e8e", // Arbeitszonen — work / industry grey
  "13": "#e08a3c", // Mischzonen — mixed orange
  "14": "#b5651d", // Zentrumszonen — centre brown
  "15": "#6fa8dc", // Zonen für öffentliche Nutzungen — public blue-grey
  "16": "#7cb342", // eingeschränkte Bauzonen — restricted green
  "17": "#c2549d", // Tourismus- und Freizeitzonen — tourism magenta
  "18": "#5d6d7e", // Verkehrszonen innerhalb der Bauzonen — transport slate
};
/** Colour for a Bauzone by its harmonised use code; grey fallback for unknown. */
export function bauzoneColor(code) {
  return BAUZONEN_HN_COLORS[String(code ?? "").trim()] || "#9e9e9e";
}

/** Classify a single BBArt type and return all classifications */
export function classify(art) {
  return {
    sia416: SIA416[art] || "UUF",
    din277: DIN277[art] || "UF",
    greenSpace: GREEN_SPACE[art] || "Not green space",
    sealed: SEALED.has(art),
    vbsKategorie: VBS_KATEGORIE[art] || "kat_d",
    vbsProduktiv: VBS_PRODUKTIV[art] || "unproduktiv",
    vbsTyp: VBS_TYP[art] || null,
  };
}

/** Status constants — language-independent codes (translate at display time) */
export const STATUS = {
  FOUND: "found",
  MERGED: "merged",
  NOT_FOUND: "not_found",
  INVALID: "invalid",
};

/** True if an EGRID status code represents a successfully resolved parcel. */
export function isFound(code) {
  return code === STATUS.FOUND || code === STATUS.MERGED;
}

/** Translate a status code for display */
export function statusLabel(code) {
  const map = {
    found: "status.found",
    merged: "status.merged",
    not_found: "status.notFound",
    invalid: "status.invalid",
  };
  if (map[code]) return t(map[code]);
  // Error messages stored as "error:actual message"
  if (code && code.startsWith("error:")) return t("status.error", { message: code.slice(6) });
  return code || "\u2013";
}

/** Green space display labels — translates stable English codes at display time */
const GREEN_SPACE_I18N = {
  "Green space (soil-covered)": "gs.soil",
  "Green space (wooded)": "gs.wooded",
  "Not green space": "gs.none",
};

export function greenSpaceLabel(code) {
  const key = GREEN_SPACE_I18N[code];
  return key ? t(key) : code || "\u2013";
}

/** VBS display labels \u2014 translate the stable English output values at display time */
const VBS_KATEGORIE_I18N = {
  "A. Settlement area": "agg.vbs.kat_a",
  "B. Agricultural area": "agg.vbs.kat_b",
  "C. Wooded area": "agg.vbs.kat_c",
  "D. Unproductive area": "agg.vbs.kat_d",
};
const VBS_PRODUKTIV_I18N = {
  "1 Biologically productive": "agg.vbs.produktiv.yes",
  "2 Biologically unproductive": "agg.vbs.produktiv.no",
};
const VBS_TYP_I18N = {
  "Type 1 - Green spaces near buildings": "agg.vbs.typ1",
  "Type 2 - Other green spaces": "agg.vbs.typ2",
};

export function vbsKategorieLabel(code) {
  const key = VBS_KATEGORIE_I18N[code];
  return key ? t(key) : code || "\u2013";
}
export function vbsProduktivLabel(code) {
  const key = VBS_PRODUKTIV_I18N[code];
  return key ? t(key) : code || "\u2013";
}
export function vbsTypLabel(code) {
  const key = VBS_TYP_I18N[code];
  return key ? t(key) : code || "\u2013";
}

/** Stable English error messages \u2014 shared so processor.js (which produces them)
 *  and errorLabel (which translates them) can't drift out of sync. */
export const ERR_MSG = {
  invalidEgrid: "Invalid EGRID",
  egridNotFound: "EGRID not found in AV",
  wfsUnavailable: "Land cover unavailable (WFS)",
};
/** Prefix for runtime errors carrying a dynamic message ("Error: <msg>"). */
export const ERR_RUNTIME_PREFIX = "Error: ";

const ERROR_I18N = {
  [ERR_MSG.invalidEgrid]: "status.invalid",
  [ERR_MSG.egridNotFound]: "status.notFound",
  [ERR_MSG.wfsUnavailable]: "err.wfsError",
};
export function errorLabel(msg) {
  if (!msg) return "";
  if (ERROR_I18N[msg]) return t(ERROR_I18N[msg]);
  if (msg.startsWith(ERR_RUNTIME_PREFIX)) return t("status.error", { message: msg.slice(ERR_RUNTIME_PREFIX.length) });
  return msg;
}
/** Translate + join an errors array (or single message) for display. */
export function errorsLabel(arr) {
  if (Array.isArray(arr)) return arr.map(errorLabel).filter(Boolean).join("; ");
  return errorLabel(arr);
}

/** Slugify a label into a lowercase snake_case field-id token (umlauts → ae/oe/ue/ss). */
export function slugify(s) {
  return String(s).toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Bauzonen per-zone area columns: `bauzonen_<slug>_m2` (slug = slugified zone
 *  name, lowercase). Encode/decode helpers centralized so the producer (processor)
 *  and consumers (table, summary, offline dashboard) agree on the field id. */
const BAUZONEN_PREFIX = "bauzonen_";
const BAUZONEN_SUFFIX = "_m2";
/** Display label per zone slug (ARE harmonised Hauptnutzung set). */
export const BAUZONE_LABELS = {
  wohnzonen: "Wohnzonen",
  arbeitszonen: "Arbeitszonen",
  mischzonen: "Mischzonen",
  zentrumszonen: "Zentrumszonen",
  zonen_fuer_oeffentliche_nutzungen: "Zonen für öffentliche Nutzungen",
  eingeschraenkte_bauzonen: "eingeschränkte Bauzonen",
  tourismus_und_freizeitzonen: "Tourismus- und Freizeitzonen",
  verkehrszonen_innerhalb_der_bauzonen: "Verkehrszonen innerhalb der Bauzonen",
  weitere_bauzonen: "weitere Bauzonen",
};
export function bauzoneAreaKey(name) { return `${BAUZONEN_PREFIX}${slugify(name)}${BAUZONEN_SUFFIX}`; }
export function isBauzoneAreaKey(k) {
  return k.startsWith(BAUZONEN_PREFIX) && k.endsWith(BAUZONEN_SUFFIX) && k !== "bauzonen_m2";
}
/** Zone slug from a column key (`bauzonen_wohnzonen_m2` → `wohnzonen`). */
export function bauzoneSlugFromKey(k) { return k.slice(BAUZONEN_PREFIX.length, -BAUZONEN_SUFFIX.length); }
/** Display label from a column key, falling back to a prettified slug. */
export function bauzoneNameFromKey(k) {
  const slug = bauzoneSlugFromKey(k);
  return BAUZONE_LABELS[slug] || slug.replace(/_/g, " ");
}

/** Habitat per-type area columns: `habitat_<slug>_m2` (slug = slugified TypoCH
 *  level-1 group name). Mirrors the Bauzonen helpers. */
const HABITAT_PREFIX = "habitat_";
const HABITAT_SUFFIX = "_m2";
/** Display label per habitat slug — derived from the TypoCH level-1 groups. */
export const HABITAT_LABELS = Object.fromEntries(
  Object.values(BAFU_TYPOCH_L1).map((m) => [slugify(m.name), m.name])
);
export function habitatAreaKey(name) { return `${HABITAT_PREFIX}${slugify(name)}${HABITAT_SUFFIX}`; }
export function isHabitatAreaKey(k) {
  return k.startsWith(HABITAT_PREFIX) && k.endsWith(HABITAT_SUFFIX) && k !== "habitat_m2";
}
export function habitatSlugFromKey(k) { return k.slice(HABITAT_PREFIX.length, -HABITAT_SUFFIX.length); }
export function habitatNameFromKey(k) {
  const slug = habitatSlugFromKey(k);
  return HABITAT_LABELS[slug] || slug.replace(/_/g, " ");
}

/** Shared HTML escape utility */
const _escDiv = document.createElement("div");
export function esc(s) {
  _escDiv.textContent = s || "";
  return _escDiv.innerHTML;
}

/** Shared number formatter (locale-aware) */
export function fmtNum(n, decimals = 1) {
  return localeFmtNum(n, decimals);
}

/** Shared dynamic script loader */
export function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

/**
 * Shared fetch with an AbortController timeout. Rejects with an AbortError when
 * the request exceeds `timeoutMs`. Any extra fetch options are passed through.
 */
export function fetchWithTimeout(url, { timeoutMs = 15000, ...opts } = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(id));
}

/* ── Area display unit (frontend only — the underlying data stays in m²) ── */

const AREA_UNIT_KEY = "areaUnit";
let _areaUnit = "ha"; // default: hectares (raw m² values get very large)
try { const s = localStorage.getItem(AREA_UNIT_KEY); if (s === "ha" || s === "m2") _areaUnit = s; } catch { /* storage blocked */ }
const _areaUnitListeners = [];

/** Current display unit: "ha" (default) or "m2". */
export function getAreaUnit() { return _areaUnit; }

/** Register a callback fired (with the new unit) after the display unit changes. */
export function onAreaUnitChange(cb) { _areaUnitListeners.push(cb); }

/** Switch the display unit (persisted) and notify listeners so the dynamic,
 *  area-bearing views can re-render. No-op for an unknown or unchanged value. */
export function setAreaUnit(unit) {
  if ((unit !== "ha" && unit !== "m2") || unit === _areaUnit) return;
  _areaUnit = unit;
  try { localStorage.setItem(AREA_UNIT_KEY, unit); } catch { /* storage blocked */ }
  for (const cb of _areaUnitListeners) { try { cb(unit); } catch (e) { console.error("Area-unit listener failed:", e); } }
}

/** The current unit's symbol ("ha" or "m²"). */
export function areaUnitLabel(unit = _areaUnit) { return unit === "ha" ? "ha" : "m²"; }

/** Strip a baked-in "m²" from a label so the live unit can be shown instead. */
export function stripAreaUnit(s) { return String(s ?? "").replace(/\s*m²/g, "").trim(); }

/** Format an m² value in the current unit, WITHOUT the unit suffix (e.g. table
 *  cells, where the unit lives in the column header). ha → 2 dp, m² → 1 dp. */
export function fmtAreaValue(m2, unit = _areaUnit) {
  const v = parseFloat(m2);
  if (isNaN(v)) return "–";
  return unit === "ha" ? localeFmtNum(v / 10000, 2) : localeFmtNum(v, 1);
}

/** Format an m² value in the current unit, WITH the unit suffix (summary, popups). */
export function fmtArea(m2, unit = _areaUnit) {
  const v = parseFloat(m2);
  if (isNaN(v)) return "–";
  return `${fmtAreaValue(v, unit)} ${areaUnitLabel(unit)}`;
}

/** API endpoints */
const WFS_LANG = { de: "deu", fr: "fra", it: "ita", en: "eng" };
export const API = {
  PARCEL_FIND: "https://api3.geo.admin.ch/rest/services/all/MapServer/find",
  IDENTIFY: "https://api3.geo.admin.ch/rest/services/all/MapServer/identify",
  SEARCH: "https://api3.geo.admin.ch/rest/services/ech/SearchServer",
  get WFS_AV() { return `https://geodienste.ch/db/av_0/${WFS_LANG[getLang()] || "deu"}`; },
};

/** Basemap styles with thumbnails */
export const MAP_STYLES = {
  positron: {
    name: "Hell",
    url: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    thumbnail: "https://basemaps.cartocdn.com/light_all/8/134/91.png",
  },
  voyager: {
    name: "Standard",
    url: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json",
    thumbnail: "https://basemaps.cartocdn.com/rastertiles/voyager/8/134/91.png",
  },
  swissimage: {
    name: "Luftbild",
    url: {
      version: 8,
      glyphs: "https://tiles.basemaps.cartocdn.com/fonts/{fontstack}/{range}.pbf",
      sources: {
        swissimage: {
          type: "raster",
          tiles: ["https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg"],
          tileSize: 256,
          maxzoom: 20,
          attribution: '&copy; <a href="https://www.swisstopo.admin.ch">swisstopo</a>',
        },
      },
      layers: [{ id: "swissimage", type: "raster", source: "swissimage" }],
    },
    thumbnail: "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/8/134/91.jpeg",
  },
  "dark-matter": {
    name: "Dunkel",
    url: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
    thumbnail: "https://basemaps.cartocdn.com/dark_all/8/134/91.png",
  },
};

/** Default map center and zoom (Switzerland) */
export const MAP_DEFAULT = { center: [8.2275, 46.8182], zoom: 7 };

/** Sliver threshold in m² */
export const SLIVER_THRESHOLD = 0.001;

/** Brand colours — a JS-side mirror of the CSS tokens in tokens.css. MapLibre
 *  paint properties and Marker options take literal colour strings (they can't
 *  read CSS custom properties), so keep these in sync with tokens.css:
 *  red = --swiss-red, blue = --federal-blue, blueLight = --federal-blue-light. */
export const BRAND = {
  red: "#d8232a",
  blue: "#1a365d",
  blueLight: "#2d4a7a",
};

/** Colors for land cover categories on the map */
export const CATEGORY_COLORS = {
  GGF: "#e74c3c",      // buildings — red
  BUF: "#f39c12",      // developed — orange
  UUF: "#27ae60",      // undeveloped — green
};

/** Colors for Art types (for detail view) */
export const ART_COLORS = {
  Gebaeude: "#c0392b",
  Strasse_Weg: "#7f8c8d",
  Trottoir: "#95a5a6",
  Verkehrsinsel: "#bdc3c7",
  Bahn: "#2c3e50",
  Flugplatz: "#34495e",
  Wasserbecken: "#3498db",
  uebrige_befestigte: "#9b59b6",
  Acker_Wiese_Weide: "#2ecc71",
  Reben: "#8e44ad",
  uebrige_Intensivkultur: "#1abc9c",
  Gartenanlage: "#27ae60",
  Hoch_Flachmoor: "#16a085",
  uebrige_humusierte: "#a3d977",
  Wytweide_dicht: "#82c341",
  Wytweide_offen: "#a8d08d",
  Gewaesser_stehendes: "#2980b9",
  Gewaesser_fliessendes: "#1f6faa",
  Schilfguertel: "#45b39d",
  geschlossener_Wald: "#1e8449",
  uebrige_bestockte: "#196f3d",
  Fels: "#aab7b8",
  Gletscher_Firn: "#d5dbdb",
  Geroell_Sand: "#d4ac0d",
  Abbau_Deponie: "#873600",
  uebrige_vegetationslose: "#b7950b",
};
