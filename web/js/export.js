/**
 * Export: CSV, XLSX, GeoJSON
 */
import { loadScript } from "./config.js";
import { t } from "./i18n.js";

/** Escape a CSV cell value (semicolon-delimited) */
function csvCell(val) {
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

/** Download parcels as CSV (semicolon-delimited, UTF-8 BOM) */
export function downloadParcelCSV(parcels, filename = "landcover-parcels.csv") {
  if (!parcels.length) return;
  const headers = Object.keys(parcels[0]).filter((k) => !k.startsWith("_"));
  saveBlob(new Blob([buildCSV(parcels, headers)], { type: "text/csv;charset=utf-8" }), filename);
}

/** Download land cover detail as CSV */
export function downloadLandcoverCSV(landcover, filename = "landcover-detail.csv") {
  if (!landcover.length) return;
  const headers = ["id", "egrid", "fid", "art", "bfsnr", "gwr_egid", "check_greenspace", "area_m2"];
  saveBlob(new Blob([buildCSV(landcover, headers)], { type: "text/csv;charset=utf-8" }), filename);
}

/** Download as Excel with parcels + landcover sheets */
export async function downloadXLSX(parcels, landcover, filename = "landcover-results.xlsx") {
  if (!parcels.length) return;
  try {
    await ensureXLSX();
  } catch {
    alert(t("export.xlsx.error"));
    return;
  }

  const wb = XLSX.utils.book_new();

  const pHeaders = Object.keys(parcels[0]).filter((k) => !k.startsWith("_"));
  const ws1 = XLSX.utils.json_to_sheet(parcels.map((row) => {
    const obj = {};
    for (const h of pHeaders) obj[h] = row[h] ?? "";
    return obj;
  }));
  XLSX.utils.book_append_sheet(wb, ws1, t("table.tab.parcels"));

  if (landcover.length) {
    const lcH = ["id", "egrid", "fid", "art", "bfsnr", "gwr_egid", "check_greenspace", "area_m2"];
    const ws2 = XLSX.utils.json_to_sheet(landcover.map((row) => {
      const obj = {};
      for (const h of lcH) obj[h] = row[h] ?? "";
      return obj;
    }));
    XLSX.utils.book_append_sheet(wb, ws2, t("table.tab.landcover"));
  }

  const wbOut = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  saveBlob(new Blob([wbOut], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename);
}

/** Download parcels as GeoJSON */
export function downloadGeoJSON(parcels, filename = "landcover-parcels.geojson") {
  const features = [];
  for (const row of parcels) {
    if (!row._geometry) continue;
    const props = {};
    for (const [k, v] of Object.entries(row)) {
      if (!k.startsWith("_")) props[k] = v;
    }
    features.push({ type: "Feature", geometry: row._geometry, properties: props });
  }
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
