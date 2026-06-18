/**
 * Export: CSV, XLSX, GeoJSON
 */
import { loadScript } from "./config.js";
import { t } from "./i18n.js";

/** Land cover export columns — shared by the CSV and XLSX exporters. */
const LANDCOVER_HEADERS = ["id", "egrid", "fid", "art", "bfsnr", "gwr_egid", "check_greenspace",
  "VBS Kategorie", "VBS Biologisch produktiv", "VBS Typ", "area_m2", "lc_source", "prob"];

/** Bauzonen detail export columns. */
const BAUZONEN_HEADERS = ["id", "egrid", "fid", "art", "bauzone_code", "area_m2", "lc_source"];

/** BAFU habitat detail export columns. */
const HABITAT_HEADERS = ["id", "egrid", "fid", "art", "check_greenspace",
  "VBS Kategorie", "VBS Biologisch produktiv", "VBS Typ", "area_m2", "prob", "lc_source"];

/** Escape a CSV cell value (semicolon-delimited) */
function csvCell(val) {
  if (Array.isArray(val)) val = val.join("; ");
  const v = String(val ?? "").replace(/"/g, '""');
  return v.includes(";") || v.includes('"') || v.includes("\n") ? `"${v}"` : v;
}

/** Build CSV string from rows and headers */
function buildCSV(rows, headers) {
  const lines = [headers.join(";")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvCell(row[h])).join(";"));
  }
  return "\uFEFF" + lines.join("\n");
}

/** Union of non-internal keys across all rows — so per-parcel-varying columns
 *  (per-Art, VBS aggregation, per-zone Bauzonen) aren't dropped when the first
 *  row is an error parcel that lacks them. Preserves first-seen order. */
function unionHeaders(rows) {
  const set = new Set();
  for (const r of rows) for (const k in r) if (!k.startsWith("_")) set.add(k);
  return [...set];
}

/** Download parcels as CSV (semicolon-delimited, UTF-8 BOM) */
export function downloadParcelCSV(parcels, filename = "landcover-parcels.csv") {
  if (!parcels.length) return;
  const headers = unionHeaders(parcels);
  saveBlob(new Blob([buildCSV(parcels, headers)], { type: "text/csv;charset=utf-8" }), filename);
}

/** Download land cover detail as CSV */
export function downloadLandcoverCSV(landcover, filename = "landcover-detail.csv") {
  if (!landcover.length) return;
  saveBlob(new Blob([buildCSV(landcover, LANDCOVER_HEADERS)], { type: "text/csv;charset=utf-8" }), filename);
}

/** Download as Excel with one sheet per layer (parcels + land cover + any
 *  overlay layers that were analysed). */
export async function downloadXLSX(parcels, landcover, bauzonen = [], habitat = [], filename = "landcover-results.xlsx") {
  if (!parcels.length) return;
  try {
    await ensureXLSX();
  } catch {
    alert(t("export.xlsx.error"));
    return;
  }

  const wb = XLSX.utils.book_new();

  const pHeaders = unionHeaders(parcels);
  const ws1 = XLSX.utils.json_to_sheet(parcels.map((row) => {
    const obj = {};
    for (const h of pHeaders) { const v = row[h]; obj[h] = Array.isArray(v) ? v.join("; ") : (v ?? ""); }
    return obj;
  }));
  XLSX.utils.book_append_sheet(wb, ws1, t("table.tab.parcels"));

  // One detail sheet per layer, in fixed column order, when it has rows.
  const addSheet = (rows, headers, name) => {
    if (!rows || !rows.length) return;
    const ws = XLSX.utils.json_to_sheet(rows.map((row) => {
      const obj = {};
      for (const h of headers) obj[h] = row[h] ?? "";
      return obj;
    }));
    // Excel sheet names: max 31 chars, and none of : \ / ? * [ ]
    const safeName = name.replace(/[:\\/?*[\]]/g, " ").slice(0, 31);
    XLSX.utils.book_append_sheet(wb, ws, safeName);
  };
  addSheet(landcover, LANDCOVER_HEADERS, t("table.tab.landcover"));
  addSheet(bauzonen, BAUZONEN_HEADERS, t("table.tab.bauzonen"));
  addSheet(habitat, HABITAT_HEADERS, t("table.tab.habitat"));

  const wbOut = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  saveBlob(new Blob([wbOut], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename);
}

/** Build a GeoJSON Feature from a result row, tagged with its `layer` so a
 *  consumer can tell the four feature types apart (`lc_source` can't: a parcel
 *  and an AV land-cover piece both report "AV"). Drops the internal `_`-prefixed
 *  keys; keeps `_geometry` as the geometry (null where absent). */
function toFeature(row, layer) {
  const props = { layer };
  for (const [k, v] of Object.entries(row)) {
    if (!k.startsWith("_")) props[k] = v;
  }
  return { type: "Feature", geometry: row._geometry || null, properties: props };
}

/** Download all analysed layers as one GeoJSON FeatureCollection. Each feature
 *  carries a `layer` property (`parcel` | `landcover` | `bauzonen` | `habitat`)
 *  and links to its parcel via `id` + `egrid`. Parcels without geometry (not
 *  found / invalid EGRID) are kept with a null geometry so the file is a complete
 *  record of every input parcel; the detail layers are the clipped pieces. */
export function downloadGeoJSON(results, filename = "landcover-parcels.geojson") {
  const features = [];
  for (const p of results.parcels) features.push(toFeature(p, "parcel"));
  for (const lc of results.landcover || []) features.push(toFeature(lc, "landcover"));
  for (const bz of results.bauzonen || []) features.push(toFeature(bz, "bauzonen"));
  for (const h of results.habitat || []) features.push(toFeature(h, "habitat"));
  saveBlob(new Blob([JSON.stringify({ type: "FeatureCollection", features }, null, 2)], { type: "application/geo+json" }), filename);
}

function saveBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function ensureXLSX() {
  if (window.XLSX) return;
  await loadScript("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js");
}
