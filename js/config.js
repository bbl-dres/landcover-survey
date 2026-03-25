/**
 * BBArt classification mappings — ported from python/config.py
 */

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

/** Classify a single BBArt type and return all classifications */
export function classify(art) {
  return {
    sia416: SIA416[art] || "UUF",
    din277: DIN277[art] || "UF",
    greenSpace: GREEN_SPACE[art] || "Not green space",
    sealed: SEALED.has(art),
  };
}

/** Status constants (used across modules) */
export const STATUS = {
  FOUND: "EGRID gefunden",
  NOT_FOUND: "EGRID nicht gefunden",
  INVALID: "Ungültiges EGRID",
};

/** Green space German labels */
export const GREEN_SPACE_DE = {
  "Green space (soil-covered)": "Humusiert",
  "Green space (wooded)": "Bestockt",
  "Not green space": "Keine Grünfläche",
};

/** Shared HTML escape utility */
const _escDiv = document.createElement("div");
export function esc(s) {
  _escDiv.textContent = s || "";
  return _escDiv.innerHTML;
}

/** Shared number formatter (de-CH locale) */
export function fmtNum(n, decimals = 1) {
  const v = parseFloat(n);
  return isNaN(v) ? "\u2013" : v.toLocaleString("de-CH", { maximumFractionDigits: decimals });
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

/** API endpoints */
export const API = {
  PARCEL_FIND: "https://api3.geo.admin.ch/rest/services/all/MapServer/find",
  SEARCH: "https://api3.geo.admin.ch/rest/services/ech/SearchServer",
  WFS_AV: "https://geodienste.ch/db/av_0/deu",
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
