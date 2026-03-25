/**
 * Export: CSV, XLSX, GeoJSON
 */

/** Download parcels as CSV (semicolon-delimited, UTF-8 BOM) */
export function downloadParcelCSV(parcels, filename = "landcover-parcels.csv") {
  if (!parcels.length) return;
  const headers = Object.keys(parcels[0]).filter((k) => !k.startsWith("_"));
  const BOM = "\uFEFF";
  const lines = [headers.join(";")];

  for (const row of parcels) {
    const vals = headers.map((h) => {
      const v = String(row[h] ?? "").replace(/"/g, '""');
      return v.includes(";") || v.includes('"') || v.includes("\n") ? `"${v}"` : v;
    });
    lines.push(vals.join(";"));
  }

  const blob = new Blob([BOM + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  saveBlob(blob, filename);
}

/** Download land cover detail as CSV */
export function downloadLandcoverCSV(landcover, filename = "landcover-detail.csv") {
  if (!landcover.length) return;
  const headers = ["id", "egrid", "fid", "art", "bfsnr", "gwr_egid", "check_greenspace", "area_m2"];
  const BOM = "\uFEFF";
  const lines = [headers.join(";")];

  for (const row of landcover) {
    const vals = headers.map((h) => {
      const v = String(row[h] ?? "").replace(/"/g, '""');
      return v.includes(";") || v.includes('"') || v.includes("\n") ? `"${v}"` : v;
    });
    lines.push(vals.join(";"));
  }

  const blob = new Blob([BOM + lines.join("\n")], { type: "text/csv;charset=utf-8" });
  saveBlob(blob, filename);
}

/** Download as Excel with parcels + landcover + summary sheets */
export async function downloadXLSX(parcels, landcover, filename = "landcover-results.xlsx") {
  if (!parcels.length) return;
  try {
    await ensureXLSX();
  } catch {
    alert("Excel-Export konnte nicht geladen werden.");
    return;
  }

  const wb = XLSX.utils.book_new();

  // Sheet 1: Parcels
  const pHeaders = Object.keys(parcels[0]).filter((k) => !k.startsWith("_"));
  const pData = parcels.map((row) => {
    const obj = {};
    for (const h of pHeaders) obj[h] = row[h] ?? "";
    return obj;
  });
  const ws1 = XLSX.utils.json_to_sheet(pData);
  XLSX.utils.book_append_sheet(wb, ws1, "Parzellen");

  // Sheet 2: Land cover detail
  if (landcover.length) {
    const lcHeaders = ["id", "egrid", "fid", "art", "bfsnr", "gwr_egid", "check_greenspace", "area_m2"];
    const lcData = landcover.map((row) => {
      const obj = {};
      for (const h of lcHeaders) obj[h] = row[h] ?? "";
      return obj;
    });
    const ws2 = XLSX.utils.json_to_sheet(lcData);
    XLSX.utils.book_append_sheet(wb, ws2, "Bodenbedeckung");
  }

  const wbOut = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([wbOut], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  saveBlob(blob, filename);
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
    features.push({
      type: "Feature",
      geometry: row._geometry,
      properties: props,
    });
  }

  const geojson = { type: "FeatureCollection", features };
  const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: "application/geo+json" });
  saveBlob(blob, filename);
}

function saveBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function ensureXLSX() {
  if (window.XLSX) return;
  await loadScript("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js");
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}
