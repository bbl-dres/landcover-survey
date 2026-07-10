/* Green-roof prototype.
 *
 * Pipeline (all analysis in LV95 / EPSG:2056, planar):
 *   EGRID ──find──▶ parcel polygon
 *         ──WFS───▶ AV land cover, keep Art == "Gebaeude", clip to parcel
 *         ──STAC──▶ SWISSIMAGE 10 COG tiles (latest year per tile), read the
 *                   pixel window around the buildings via HTTP range requests
 *         ─────────▶ vegetation index per pixel (NDVI if ≥4 bands, else GLI/VARI)
 *         ─────────▶ threshold within building mask → green-roof pixels
 *         ─────────▶ area (px count × px area), per-building stats,
 *                    vectorised outline (marching squares) for GeoJSON export.
 *
 * A local GeoTIFF (e.g. a 4-band SWISSIMAGE RS extract, LV95) can be dropped on
 * the page and replaces the STAC imagery — the rest of the pipeline is identical.
 *
 * Globals from CDN: turf (clipping), GeoTIFF (COG reader), d3 (d3-contour).
 */

/* ── constants (endpoints match web/js/config.js) ── */
const API_FIND = "https://api3.geo.admin.ch/rest/services/all/MapServer/find";
const WFS_AV = "https://geodienste.ch/db/av_0/deu"; // pinned to deu — classifier keys on German Art values
const STAC_ITEMS =
  "https://data.geo.admin.ch/api/stac/v0.9/collections/ch.swisstopo.swissimage-dop10/items";

const WFS_PAGE = 1000;
const WFS_MAX_PAGES = 4; // a parcel bbox is small; 4000 features is plenty
const MARGIN_M = 3; // imagery margin around the buildings bbox
const MAX_PX = 3200 * 3200; // composite raster safety cap (~10 MB/band as Float32)
const DEFAULT_THR = { ndvi: 0.2, gli: 0.1, vari: 0.1 };

/* ── state ── */
const S = {
  parcel: null, // GeoJSON Feature, LV95
  buildings: [], // [{ geometry, egid, area }] clipped to parcel, LV95
  raster: null, // { bands: Float32Array[], nBands, w, h, E0, N1, res, meta }
  index: null, // Float32Array(w*h)
  label: null, // Uint16Array(w*h): 0 = outside, i+1 = building i
  mask: null, // Uint8Array(w*h): 1 = green roof
  stats: [], // per building
  paths: [], // Path2D per building (raster px coords)
  parcelPath: null,
  stretch: null, // per-band [lo, hi] display stretch
  localTif: null, // ArrayBuffer of a dropped GeoTIFF
  localName: "",
  stacYears: [], // years available at the current parcel
  busy: false,
};

/* ── tiny DOM helpers ── */
const $ = (id) => document.getElementById(id);
const fmt = (v, d = 1) =>
  Number(v).toLocaleString("de-CH", { minimumFractionDigits: d, maximumFractionDigits: d });

function setStatus(msg, kind = "") {
  const el = $("status");
  el.textContent = msg;
  el.className = `status ${kind}`;
}

/* ── geometry helpers (planar LV95) ── */
function eachPoly(geom, cb) {
  if (!geom) return;
  if (geom.type === "Polygon") cb(geom.coordinates);
  else if (geom.type === "MultiPolygon") geom.coordinates.forEach(cb);
}

function eachRing(geom, cb) {
  eachPoly(geom, (rings) => rings.forEach(cb));
}

function bboxOfGeom(geom) {
  let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
  eachRing(geom, (ring) => {
    for (const [E, N] of ring) {
      if (E < minE) minE = E;
      if (E > maxE) maxE = E;
      if (N < minN) minN = N;
      if (N > maxN) maxN = N;
    }
  });
  return [minE, minN, maxE, maxN];
}

/** Shoelace area of one closed ring (signed). */
function ringArea(ring) {
  let s = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return s / 2;
}

/** Planar polygon area in m² (outer rings minus holes). */
function polyArea(geom) {
  let a = 0;
  eachPoly(geom, (rings) => {
    a += Math.abs(ringArea(rings[0]));
    for (let i = 1; i < rings.length; i++) a -= Math.abs(ringArea(rings[i]));
  });
  return a;
}

/** LV95 → WGS84, swisstopo approximate formulas (~1 m — used only for the STAC
 *  bbox query and the GeoJSON export; the analysis itself stays in LV95). */
function lv95ToWgs84(E, N) {
  const y = (E - 2600000) / 1e6;
  const x = (N - 1200000) / 1e6;
  const lon = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y * y * y;
  const lat =
    16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x -
    0.014 * x * x * x;
  return [(lon * 100) / 36, (lat * 100) / 36];
}

/* ── fetch helpers ── */
async function fetchJson(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${new URL(url).host}`);
  return resp.json();
}

async function fetchJsonRetry(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetchJson(url);
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
  throw lastErr;
}

/* ── data: parcel + buildings ── */
async function fetchParcel(egrid) {
  const params = new URLSearchParams({
    layer: "ch.kantone.cadastralwebmap-farbe",
    searchText: egrid,
    searchField: "egris_egrid",
    returnGeometry: "true",
    geometryFormat: "geojson",
    sr: "2056",
  });
  const data = await fetchJsonRetry(`${API_FIND}?${params}`);
  const feats = (data.results || []).filter((r) => r.geometry);
  if (!feats.length) return null;

  // A single EGRID can map to several features — union them (mirrors the app).
  let geom = feats[0].geometry;
  if (feats.length > 1) {
    try {
      const u = turf.union(turf.featureCollection(feats.map((f) => turf.feature(f.geometry))));
      if (u?.geometry) geom = u.geometry;
    } catch (err) {
      console.warn(`union failed for ${egrid}, using first feature:`, err.message);
    }
  }
  const props = feats[0].properties || feats[0].attributes || {};
  return { type: "Feature", geometry: geom, properties: { egrid, number: props.number || "" } };
}

async function fetchBuildings(parcel) {
  const [minE, minN, maxE, maxN] = bboxOfGeom(parcel.geometry);
  const raw = [];
  for (let page = 0; page < WFS_MAX_PAGES; page++) {
    const params = new URLSearchParams({
      SERVICE: "WFS",
      REQUEST: "GetFeature",
      VERSION: "2.0.0",
      TYPENAMES: "ms:LCSF",
      BBOX: `${minE},${minN},${maxE},${maxN},urn:ogc:def:crs:EPSG::2056`,
      SRSNAME: "urn:ogc:def:crs:EPSG::2056",
      OUTPUTFORMAT: "geojson",
      COUNT: String(WFS_PAGE),
      STARTINDEX: String(page * WFS_PAGE),
    });
    const data = await fetchJsonRetry(`${WFS_AV}?${params}`);
    const batch = data.features || [];
    raw.push(...batch);
    if (batch.length < WFS_PAGE) break;
  }

  const seen = new Set();
  const buildings = [];
  for (const f of raw) {
    if (f.properties?.Art !== "Gebaeude") continue;
    if (!f.geometry || !["Polygon", "MultiPolygon"].includes(f.geometry.type)) continue;
    if (f.id != null) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
    }
    let clipped = null;
    try {
      clipped = turf.intersect(
        turf.featureCollection([turf.feature(f.geometry), turf.feature(parcel.geometry)])
      );
    } catch (err) {
      console.warn("building clip failed:", err.message);
    }
    if (!clipped?.geometry) continue;
    const area = polyArea(clipped.geometry);
    if (area < 0.5) continue; // sliver of a neighbour's building on the boundary
    buildings.push({ geometry: clipped.geometry, egid: f.properties.GWR_EGID || "", area });
  }
  return buildings;
}

/* ── imagery: STAC lookup + COG window read ── */
async function stacLookup(bboxLv95) {
  const [w1, s1] = lv95ToWgs84(bboxLv95[0], bboxLv95[1]);
  const [e1, n1] = lv95ToWgs84(bboxLv95[2], bboxLv95[3]);
  const data = await fetchJsonRetry(`${STAC_ITEMS}?bbox=${w1},${s1},${e1},${n1}`);
  return data.features || [];
}

/** Latest (or `year`-pinned) item per 1-km tile, with its native-resolution asset. */
function pickAssets(items, year) {
  const byTile = new Map();
  for (const it of items) {
    const m = /_(\d{4})_(\d{4})-(\d{4})$/.exec(it.id);
    if (!m) continue;
    const y = +m[1];
    if (year && y !== year) continue;
    const tile = `${m[2]}-${m[3]}`;
    const cur = byTile.get(tile);
    if (!cur || y > cur.year) byTile.set(tile, { year: y, item: it, tile });
  }
  const picks = [];
  for (const { year: y, item, tile } of byTile.values()) {
    let best = null;
    for (const [key, asset] of Object.entries(item.assets || {})) {
      const m = /_(\d+(?:\.\d+)?)_2056\.tif$/.exec(key);
      if (!m) continue;
      const res = +m[1];
      if (!best || res < best.res) best = { res, href: asset.href, key };
    }
    if (best) picks.push({ ...best, year: y, tile });
  }
  return picks;
}

/** Open remote COGs (or one local ArrayBuffer) → [{ img, tile, year }]. */
async function openImagery(bboxLv95) {
  if (S.localTif) {
    const tif = await GeoTIFF.fromArrayBuffer(S.localTif);
    const img = await tif.getImage(0);
    const epsg = img.geoKeys?.ProjectedCSTypeGeoKey;
    if (epsg && epsg !== 2056) {
      throw new Error(`local GeoTIFF is EPSG:${epsg} — the prototype needs LV95 (EPSG:2056)`);
    }
    return { entries: [{ img, tile: S.localName || "local file", year: "file" }], source: "local" };
  }

  const items = await stacLookup(bboxLv95);
  if (!items.length) throw new Error("no SWISSIMAGE items found for this location");
  S.stacYears = [...new Set(items.map((it) => +(/_(\d{4})_/.exec(it.id)?.[1])).filter(Boolean))]
    .sort((a, b) => b - a);
  populateYearSelect();
  const year = +$("year").value || 0;
  const picks = pickAssets(items, year);
  if (!picks.length) throw new Error(`no SWISSIMAGE asset for year ${year || "latest"}`);

  const entries = [];
  for (const p of picks) {
    const tif = await GeoTIFF.fromUrl(p.href); // COG — range requests, CORS: *
    const img = await tif.getImage(0); // first IFD = full resolution
    entries.push({ img, tile: p.tile, year: p.year });
  }
  return { entries, source: "stac" };
}

/** Read the bbox window from all tiles into one aligned composite raster. */
async function readComposite(entries, bboxLv95) {
  const tiles = entries.map(({ img, tile, year }) => {
    const [ox, oy] = img.getOrigin(); // top-left corner (E, N)
    const [rx] = img.getResolution();
    return { img, tile, year, ox, oy, res: Math.abs(rx), bands: img.getSamplesPerPixel() };
  });

  const res = tiles[0].res;
  const usable = tiles.filter((t) => t.res === res);
  if (usable.length < tiles.length) {
    console.warn("dropping tiles with mismatched resolution:", tiles.filter((t) => t.res !== res));
  }
  const nBands = Math.min(...usable.map((t) => t.bands));

  // Snap the output grid to the (national, km-aligned) pixel grid.
  const E0 = Math.floor(bboxLv95[0] / res) * res;
  const N1 = Math.ceil(bboxLv95[3] / res) * res;
  const w = Math.max(1, Math.round((Math.ceil(bboxLv95[2] / res) * res - E0) / res));
  const h = Math.max(1, Math.round((N1 - Math.floor(bboxLv95[1] / res) * res) / res));
  if (w * h > MAX_PX) {
    throw new Error(`window too large (${w}×${h} px at ${res} m) — pick a parcel with a smaller building extent`);
  }

  const bands = Array.from({ length: nBands }, () => new Float32Array(w * h).fill(NaN));
  for (const t of usable) {
    const tw = t.img.getWidth();
    const th = t.img.getHeight();
    // overlap of the output window with this tile, in world coords
    const oE0 = Math.max(E0, t.ox);
    const oE1 = Math.min(E0 + w * res, t.ox + tw * res);
    const oN1 = Math.min(N1, t.oy);
    const oN0 = Math.max(N1 - h * res, t.oy - th * res);
    if (oE1 <= oE0 || oN1 <= oN0) continue;
    const wx0 = Math.round((oE0 - t.ox) / res);
    const wy0 = Math.round((t.oy - oN1) / res);
    const wx1 = Math.round((oE1 - t.ox) / res);
    const wy1 = Math.round((t.oy - oN0) / res);
    const data = await t.img.readRasters({ window: [wx0, wy0, wx1, wy1] });
    const dw = wx1 - wx0;
    const dh = wy1 - wy0;
    const dx0 = Math.round((oE0 - E0) / res);
    const dy0 = Math.round((N1 - oN1) / res);
    for (let b = 0; b < nBands; b++) {
      const src = data[b];
      for (let y = 0; y < dh; y++) {
        const so = y * dw;
        const dof = (dy0 + y) * w + dx0;
        for (let x = 0; x < dw; x++) bands[b][dof + x] = src[so + x];
      }
    }
  }

  return {
    bands,
    nBands,
    w,
    h,
    E0,
    N1,
    res,
    meta: usable.map((t) => ({ tile: t.tile, year: t.year, res: t.res, bands: t.bands })),
  };
}

/* ── analysis ── */
/** Semantic band mapping (which raster band is R / G / B / NIR).
 *  "cir" covers the 3-band false-colour composites most cantonal infrared
 *  orthophotos ship as (NIR,R,G — e.g. Kanton ZH FCIR, Geneva SITG IRC):
 *  NDVI works, but there is no blue band, so GLI/VARI are unavailable. */
function bandMapping() {
  const order = $("band-order").value;
  const n = S.raster.nBands;
  if (order === "cir") return { nir: 0, r: 1, g: 2, b: null };
  if (order === "nrgb" && n >= 4) return { nir: 0, r: 1, g: 2, b: 3 };
  return { r: 0, g: 1, b: 2, nir: n >= 4 ? 3 : null };
}

/** Bands to put on the screen's R/G/B channels. For CIR files the classic
 *  false-colour view (NIR→red: vegetation shows red) is bands 0,1,2 as-is. */
function displayBands() {
  if ($("band-order").value === "cir") return { r: 0, g: 1, b: 2 };
  const m = bandMapping();
  return { r: m.r, g: m.g, b: m.b };
}

function computeIndex(kind) {
  const { bands, w, h } = S.raster;
  const map = bandMapping();
  const R = bands[map.r];
  const G = bands[map.g];
  const B = bands[map.b];
  const NIR = map.nir != null ? bands[map.nir] : null;
  const idx = new Float32Array(w * h).fill(NaN);
  for (let i = 0; i < idx.length; i++) {
    const r = R[i];
    if (Number.isNaN(r)) continue;
    let v;
    if (kind === "ndvi") {
      const nir = NIR[i];
      const d = nir + r;
      v = d ? (nir - r) / d : 0;
    } else if (kind === "gli") {
      const g = G[i];
      const b = B[i];
      const d = 2 * g + r + b;
      v = d ? (2 * g - r - b) / d : 0;
    } else {
      // VARI
      const g = G[i];
      const b = B[i];
      const d = g + r - b;
      v = d ? (g - r) / d : 0;
      v = Math.max(-1, Math.min(1, v));
    }
    idx[i] = v;
  }
  return idx;
}

/** Label raster: px → building index+1. Canvas-rasterised per building
 *  (bbox-limited readback) so anti-aliased edges can't bleed between labels. */
function rasterizeBuildings() {
  const { w, h, E0, N1, res } = S.raster;
  const label = new Uint16Array(w * h);
  const cvs = document.createElement("canvas");
  cvs.width = w;
  cvs.height = h;
  const ctx = cvs.getContext("2d", { willReadFrequently: true });

  const toPath = (geom) => {
    const path = new Path2D();
    eachRing(geom, (ring) => {
      ring.forEach(([E, N], j) => {
        const x = (E - E0) / res;
        const y = (N1 - N) / res;
        if (j === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      });
      path.closePath();
    });
    return path;
  };

  S.paths = S.buildings.map((b) => toPath(b.geometry));
  S.parcelPath = toPath(S.parcel.geometry);

  S.buildings.forEach((b, i) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#fff";
    ctx.fill(S.paths[i], "evenodd");
    const bb = bboxOfGeom(b.geometry);
    const x0 = Math.max(0, Math.floor((bb[0] - E0) / res));
    const y0 = Math.max(0, Math.floor((N1 - bb[3]) / res));
    const x1 = Math.min(w, Math.ceil((bb[2] - E0) / res));
    const y1 = Math.min(h, Math.ceil((N1 - bb[1]) / res));
    if (x1 <= x0 || y1 <= y0) return;
    const px = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    const bw = x1 - x0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (px[((y - y0) * bw + (x - x0)) * 4 + 3] >= 128) label[y * w + x] = i + 1;
      }
    }
  });
  return label;
}

function computeMask(thr, despeckle) {
  const { w, h } = S.raster;
  const n = w * h;
  let mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    mask[i] = S.label[i] && S.index[i] > thr ? 1 : 0;
  }
  if (despeckle) {
    const out = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!S.label[i]) continue;
        let sum = 0;
        let cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const j = yy * w + xx;
            if (!S.label[j]) continue; // majority within the building only
            sum += mask[j];
            cnt++;
          }
        }
        out[i] = sum * 2 > cnt ? 1 : 0;
      }
    }
    mask = out;
  }
  return mask;
}

function computeStats() {
  const pxArea = S.raster.res * S.raster.res;
  const per = S.buildings.map(() => ({ roofPx: 0, greenPx: 0 }));
  for (let i = 0; i < S.mask.length; i++) {
    const l = S.label[i];
    if (!l) continue;
    per[l - 1].roofPx++;
    if (S.mask[i]) per[l - 1].greenPx++;
  }
  return per.map((p, i) => ({
    egid: S.buildings[i].egid,
    areaM2: S.buildings[i].area,
    greenM2: p.greenPx * pxArea,
    pct: p.roofPx ? (100 * p.greenPx) / p.roofPx : 0,
  }));
}

/* ── display ── */
function computeStretch() {
  // 2–98 percentile per displayed band (matters for 16-bit RS files).
  const map = displayBands();
  const stretch = {};
  for (const key of ["r", "g", "b"]) {
    const band = S.raster.bands[map[key]];
    const sample = [];
    const step = Math.max(1, Math.floor(band.length / 20000));
    for (let i = 0; i < band.length; i += step) {
      if (!Number.isNaN(band[i])) sample.push(band[i]);
    }
    sample.sort((a, b) => a - b);
    const lo = sample[Math.floor(sample.length * 0.02)] ?? 0;
    const hi = sample[Math.floor(sample.length * 0.98)] ?? 255;
    stretch[key] = [lo, Math.max(hi, lo + 1)];
  }
  return stretch;
}

function render() {
  if (!S.raster) return;
  const { w, h } = S.raster;
  const view = document.querySelector('input[name="view"]:checked').value;
  const map = displayBands();
  const [rl, rh] = S.stretch.r;
  const [gl, gh] = S.stretch.g;
  const [bl, bh] = S.stretch.b;
  const R = S.raster.bands[map.r];
  const G = S.raster.bands[map.g];
  const B = S.raster.bands[map.b];
  const img = new ImageData(w, h);
  const px = img.data;

  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (Number.isNaN(R[i])) {
      px[o] = 38; px[o + 1] = 50; px[o + 2] = 56; px[o + 3] = 255; // no-data
      continue;
    }
    let r = (255 * (R[i] - rl)) / (rh - rl);
    let g = (255 * (G[i] - gl)) / (gh - gl);
    let b = (255 * (B[i] - bl)) / (bh - bl);
    r = r < 0 ? 0 : r > 255 ? 255 : r;
    g = g < 0 ? 0 : g > 255 ? 255 : g;
    b = b < 0 ? 0 : b > 255 ? 255 : b;

    if (view === "index") {
      // −0.2 … 0.6 ramp: gray → yellow → green
      const t = Math.max(0, Math.min(1, (S.index[i] + 0.2) / 0.8));
      if (t < 0.5) {
        const u = t / 0.5;
        r = 120 + u * (212 - 120); g = 120 + u * (190 - 120); b = 120 - u * 90;
      } else {
        const u = (t - 0.5) / 0.5;
        r = 212 - u * 180; g = 190 - u * 60; b = 30 + u * 20;
      }
    } else if (view === "overlay") {
      const inB = S.label[i] > 0;
      if (!inB) {
        r *= 0.45; g *= 0.45; b *= 0.45; // dim context outside buildings
      }
      if (S.mask[i]) {
        r = 0.35 * r; g = 0.35 * g + 0.65 * 200; b = 0.35 * b + 0.65 * 83; // green blend
      }
    }
    px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
  }

  const cvs = $("view-canvas");
  cvs.width = w;
  cvs.height = h;
  const ctx = cvs.getContext("2d");
  ctx.putImageData(img, 0, 0);

  // vector overlays: parcel (dashed) + building outlines
  const lw = Math.max(1, Math.round(w / 700));
  ctx.lineWidth = lw;
  ctx.setLineDash([4 * lw, 3 * lw]);
  ctx.strokeStyle = "#40c4ff";
  ctx.stroke(S.parcelPath);
  ctx.setLineDash([]);
  ctx.strokeStyle = view === "index" ? "#1f2937" : "#ff9100";
  for (const p of S.paths) ctx.stroke(p);
}

function renderStats() {
  const pxArea = S.raster.res * S.raster.res;
  const totRoofPx = S.label.reduce((a, v) => a + (v ? 1 : 0), 0);
  const totGreen = S.stats.reduce((a, s) => a + s.greenM2, 0);
  const totRoofM2 = S.stats.reduce((a, s) => a + s.areaM2, 0);
  const pct = totRoofPx ? (100 * totGreen) / (totRoofPx * pxArea) : 0;

  $("kpi-buildings").textContent = S.buildings.length;
  $("kpi-roof").textContent = fmt(totRoofM2);
  $("kpi-green").textContent = fmt(totGreen);
  $("kpi-pct").textContent = `${fmt(pct)} %`;

  const rows = S.stats
    .map(
      (s, i) => `<tr>
        <td>${i + 1}</td>
        <td>${s.egid || "—"}</td>
        <td>${fmt(s.areaM2)}</td>
        <td>${fmt(s.greenM2)}</td>
        <td>${fmt(s.pct)} %</td>
      </tr>`
    )
    .join("");
  $("stats-table").innerHTML = `
    <tr><th>#</th><th>EGID (GWR)</th><th>Gebäude m²</th><th>Gründach m²</th><th>Anteil</th></tr>
    ${rows}
    <tr class="total"><td></td><td>Total</td><td>${fmt(totRoofM2)}</td><td>${fmt(totGreen)}</td><td>${fmt(pct)} %</td></tr>`;
}

function renderMeta(source) {
  const kind = $("index-kind").value;
  const m = S.raster.meta;
  const src =
    source === "local"
      ? `local GeoTIFF «${S.localName}»`
      : m.map((t) => `${t.tile} (${t.year})`).join(", ");
  const bandNote =
    S.raster.nBands >= 4
      ? `${S.raster.nBands} bands — NIR available`
      : `${S.raster.nBands}-band RGB — no NIR (expected with the 2026 SWISSIMAGE release)`;
  $("meta").textContent =
    `Imagery: ${src} · ${S.raster.res} m/px · ${bandNote} · index: ${kind.toUpperCase()} · ` +
    `raster ${S.raster.w}×${S.raster.h} px · parcel ${S.parcel.properties.egrid}` +
    (S.parcel.properties.number ? ` (no. ${S.parcel.properties.number})` : "");
}

/* ── vector export ── */
function maskToMultiPolygonLv95() {
  const { w, h, E0, N1, res } = S.raster;
  const contour = d3.contours().size([w, h]).smooth(true).contour(Array.from(S.mask), 0.5);
  const tx = ([x, y]) => [E0 + x * res, N1 - y * res];
  return {
    type: "MultiPolygon",
    coordinates: contour.coordinates.map((poly) => poly.map((ring) => ring.map(tx))),
  };
}

function geomToWgs84(geom) {
  const tx = ([E, N]) => lv95ToWgs84(E, N).map((v) => Math.round(v * 1e7) / 1e7);
  const conv = (coords) => coords.map((c) => (typeof c[0] === "number" ? tx(c) : conv(c)));
  return { type: geom.type, coordinates: conv(geom.coordinates) };
}

function downloadGeojson() {
  if (!S.mask) return;
  const kind = $("index-kind").value;
  const thr = +$("thr").value;
  const totGreen = S.stats.reduce((a, s) => a + s.greenM2, 0);
  const features = [
    {
      type: "Feature",
      geometry: geomToWgs84(S.parcel.geometry),
      properties: {
        layer: "parcel",
        egrid: S.parcel.properties.egrid,
        parcel_area_m2: Math.round(polyArea(S.parcel.geometry) * 10) / 10,
      },
    },
    ...S.buildings.map((b, i) => ({
      type: "Feature",
      geometry: geomToWgs84(b.geometry),
      properties: {
        layer: "building",
        egid: b.egid,
        area_m2: Math.round(b.area * 10) / 10,
        greenroof_m2: Math.round(S.stats[i].greenM2 * 10) / 10,
        greenroof_pct: Math.round(S.stats[i].pct * 10) / 10,
      },
    })),
    {
      type: "Feature",
      geometry: geomToWgs84(maskToMultiPolygonLv95()),
      properties: {
        layer: "greenroof",
        index: kind,
        threshold: thr,
        greenroof_total_m2: Math.round(totGreen * 10) / 10,
        imagery: S.raster.meta.map((t) => `${t.tile}:${t.year}`).join(","),
        resolution_m: S.raster.res,
        n_bands: S.raster.nBands,
      },
    },
  ];
  const blob = new Blob(
    [JSON.stringify({ type: "FeatureCollection", features }, null, 1)],
    { type: "application/geo+json" }
  );
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `greenroof_${S.parcel.properties.egrid}.geojson`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ── pipeline ── */
function recompute() {
  if (!S.raster || !S.index) return;
  S.mask = computeMask(+$("thr").value, $("despeckle").checked);
  S.stats = computeStats();
  renderStats();
  render();
}

function rebuildIndex() {
  if (!S.raster) return;
  // NDVI needs a NIR band; GLI/VARI need a blue band (absent in CIR files)
  const map = bandMapping();
  const sel = $("index-kind");
  sel.querySelector('option[value="ndvi"]').disabled = map.nir == null;
  sel.querySelector('option[value="gli"]').disabled = map.b == null;
  sel.querySelector('option[value="vari"]').disabled = map.b == null;
  if (sel.value === "ndvi" && map.nir == null) setIndexKind("gli");
  else if (sel.value !== "ndvi" && map.b == null) setIndexKind("ndvi");
  S.index = computeIndex($("index-kind").value);
  S.stretch = computeStretch();
  recompute();
  renderMeta(S.localTif ? "local" : "stac");
}

function setIndexKind(kind) {
  $("index-kind").value = kind;
  $("thr").value = DEFAULT_THR[kind];
  $("thr-val").textContent = fmt(DEFAULT_THR[kind], 2);
}

async function analyse() {
  if (S.busy) return;
  const egrid = $("egrid").value.trim().toUpperCase().replace(/\s+/g, "");
  if (!/^CH\d{12}$/.test(egrid)) {
    setStatus(`"${egrid}" does not look like an EGRID (CH + 12 digits) — trying anyway…`, "warn");
  }
  S.busy = true;
  $("analyse").disabled = true;
  $("download").disabled = true;
  $("result-card").style.display = "none";
  try {
    setStatus("1/4 — looking up the parcel…");
    S.parcel = await fetchParcel(egrid);
    if (!S.parcel) throw new Error(`EGRID ${egrid} not found`);

    setStatus("2/4 — fetching AV land cover (Bodenbedeckung)…");
    S.buildings = await fetchBuildings(S.parcel);
    if (!S.buildings.length) {
      throw new Error(
        "this parcel has no «Gebäude» land cover — nothing to analyse (note: 6 cantons return no AV data via the public WFS)"
      );
    }

    // imagery window: union of building bboxes + margin
    let bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const b of S.buildings) {
      const [a, c, d, e] = bboxOfGeom(b.geometry);
      bb = [Math.min(bb[0], a), Math.min(bb[1], c), Math.max(bb[2], d), Math.max(bb[3], e)];
    }
    bb = [bb[0] - MARGIN_M, bb[1] - MARGIN_M, bb[2] + MARGIN_M, bb[3] + MARGIN_M];

    setStatus("3/4 — loading SWISSIMAGE window (COG range requests)…");
    const { entries, source } = await openImagery(bb);
    S.raster = await readComposite(entries, bb);

    setStatus("4/4 — computing vegetation index…");
    S.label = rasterizeBuildings();
    rebuildIndex(); // also swaps to a valid index for the file's band layout

    $("result-card").style.display = "";
    $("download").disabled = false;
    const kind = $("index-kind").value.toUpperCase();
    const note =
      S.raster.nBands >= 4 ? `${kind} from NIR` : `${kind} — RGB fallback until the 2026 NIR release`;
    setStatus(
      `Done — ${S.buildings.length} building(s), imagery ${
        source === "local" ? S.localName : S.raster.meta.map((t) => t.year).join("/")
      }, ${note}. Tune the threshold on the slider.`,
      "ok"
    );
  } catch (err) {
    console.error(err);
    setStatus(`Failed: ${err.message}`, "err");
  } finally {
    S.busy = false;
    $("analyse").disabled = false;
  }
}

/* ── UI wiring ── */
function populateYearSelect() {
  const sel = $("year");
  const current = sel.value;
  sel.innerHTML =
    '<option value="">latest</option>' +
    S.stacYears.map((y) => `<option value="${y}">${y}</option>`).join("");
  if ([...sel.options].some((o) => o.value === current)) sel.value = current;
}

function setLocalTif(buf, name) {
  S.localTif = buf;
  S.localName = name;
  $("tif-clear").classList.remove("hidden");
  $("tif-clear").textContent = `✕ ${name}`;
  setStatus(`Local GeoTIFF «${name}» loaded — it now replaces the SWISSIMAGE tiles. ${
    S.parcel ? "Re-running analysis…" : "Enter an EGRID and hit Analyse."
  }`);
  if (S.parcel) analyse();
}

function init() {
  $("analyse").addEventListener("click", analyse);
  $("egrid").addEventListener("keydown", (e) => {
    if (e.key === "Enter") analyse();
  });

  let thrTimer;
  $("thr").addEventListener("input", () => {
    $("thr-val").textContent = fmt(+$("thr").value, 2);
    clearTimeout(thrTimer);
    thrTimer = setTimeout(recompute, 60);
  });
  $("despeckle").addEventListener("change", recompute);
  $("index-kind").addEventListener("change", () => {
    setIndexKind($("index-kind").value);
    rebuildIndex();
  });
  $("band-order").addEventListener("change", rebuildIndex);
  $("year").addEventListener("change", () => {
    if (S.parcel && !S.localTif) analyse();
  });
  document.querySelectorAll('input[name="view"]').forEach((r) => r.addEventListener("change", render));
  $("download").addEventListener("click", downloadGeojson);

  $("tif-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (f) setLocalTif(await f.arrayBuffer(), f.name);
  });
  $("tif-clear").addEventListener("click", () => {
    S.localTif = null;
    S.localName = "";
    $("tif-clear").classList.add("hidden");
    setStatus("Local GeoTIFF removed — back to SWISSIMAGE via STAC.");
    if (S.parcel) analyse();
  });
  ["dragenter", "dragover"].forEach((ev) =>
    document.body.addEventListener(ev, (e) => {
      e.preventDefault();
      document.body.classList.add("dragging");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    document.body.addEventListener(ev, (e) => {
      e.preventDefault();
      if (ev === "drop") {
        const f = e.dataTransfer?.files?.[0];
        if (f && /\.tiff?$/i.test(f.name)) f.arrayBuffer().then((buf) => setLocalTif(buf, f.name));
      }
      document.body.classList.remove("dragging");
    })
  );

  // cursor readout
  $("view-canvas").addEventListener("mousemove", (e) => {
    if (!S.raster) return;
    const cvs = $("view-canvas");
    const rect = cvs.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * S.raster.w);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * S.raster.h);
    if (x < 0 || y < 0 || x >= S.raster.w || y >= S.raster.h) return;
    const i = y * S.raster.w + x;
    const E = (S.raster.E0 + x * S.raster.res).toFixed(1);
    const N = (S.raster.N1 - y * S.raster.res).toFixed(1);
    const v = S.index?.[i];
    const l = S.label?.[i];
    $("readout").textContent =
      `E ${E}  N ${N} · ${$("index-kind").value.toUpperCase()} ${
        Number.isFinite(v) ? v.toFixed(3) : "—"
      }${l ? ` · building #${l}` : ""}${S.mask?.[i] ? " · green roof" : ""}`;
  });

  const q = new URLSearchParams(location.search).get("egrid");
  if (q) {
    $("egrid").value = q;
    analyse();
  }
}

init();
