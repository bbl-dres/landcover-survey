/**
 * Core processing: EGRID → Parcel Geometry → WFS Land Cover → Turf.js Clip → Area
 *
 * Performance strategy:
 * - Parallel EGRID lookups (batched, max CONCURRENCY at once)
 * - Parallel WFS queries (fired as soon as parcel geometry arrives)
 * - Turf.js clipping runs synchronously per parcel (CPU-bound, fast)
 * - Exponential backoff on 429/5xx errors
 * - EGRID dedup cache avoids redundant API calls
 * - AbortController timeout on all fetch calls
 */
import { API, SLIVER_THRESHOLD, STATUS, classify } from "./config.js";

const CONCURRENCY = 5;
const FETCH_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

let cancelled = false;

/** EGRID → parcel geometry cache (survives across runs within same session) */
const egridCache = new Map();

export function cancelProcessing() {
  cancelled = true;
}

/**
 * Process all rows from the CSV.
 * Returns { parcels: [...], landcover: [...] }
 */
export async function processRows(rows, onProgress) {
  cancelled = false;
  const total = rows.length;
  let completed = 0;
  let succeeded = 0;

  const results = new Array(total);

  const reportProgress = () => {
    onProgress({ processed: completed, total, succeeded, failed: completed - succeeded });
  };

  const processOne = async (row, index) => {
    if (cancelled) return null;

    const id = row.id || "";
    const egrid = row.egrid || "";

    if (!egrid || !egrid.startsWith("CH")) {
      return {
        parcel: makeErrorParcel(id, egrid, row, STATUS.INVALID),
        landcover: [],
      };
    }

    try {
      // Step 1: Fetch parcel geometry (with dedup cache)
      const parcelResult = await fetchParcelGeometry(egrid);

      if (!parcelResult) {
        return {
          parcel: makeErrorParcel(id, egrid, row, STATUS.NOT_FOUND),
          landcover: [],
        };
      }

      // Step 2: Fetch land cover via WFS
      const parcelGeom = parcelResult.geometry;
      const bbox = turf.bbox(parcelGeom);
      const lcResult = await fetchLandCover(bbox);

      // Step 3: Clip land cover to parcel
      const clipped = clipLandCover(parcelGeom, lcResult.features, id, egrid);

      // Step 4: Calculate parcel area
      const parcelArea = turf.area(parcelGeom);

      // Step 5: Aggregate
      const agg = aggregateLandCover(clipped);

      const parcel = {
        id,
        egrid,
        nummer: parcelResult.properties.number || "",
        bfsnr: parcelResult.properties.bfsnr || "",
        check_egrid: lcResult.error ? STATUS.FOUND : STATUS.FOUND,
        check_wfs: lcResult.error ? "wfs_error" : "ok",
        flaeche: parcelResult.properties.area || "",
        parcel_area_m2: round2(parcelArea),
        ...agg,
        _geometry: parcelGeom,
        _landcover: clipped,
      };

      // Pass through extra input columns
      for (const [k, v] of Object.entries(row)) {
        if (k !== "id" && k !== "egrid") parcel[`input_${k}`] = v;
      }

      return { parcel, landcover: clipped };
    } catch (err) {
      console.error(`Error processing ${egrid}:`, err);
      return {
        parcel: makeErrorParcel(id, egrid, row, `error:${err.message}`),
        landcover: [],
      };
    }
  };

  // Run with bounded concurrency
  const queue = rows.map((row, i) => ({ row, index: i }));
  const workers = [];

  const runNext = async () => {
    while (queue.length > 0 && !cancelled) {
      const { row, index } = queue.shift();
      const result = await processOne(row, index);
      results[index] = result;
      completed++;
      if (result && result.parcel.check_egrid === STATUS.FOUND) succeeded++;
      reportProgress();
    }
  };

  for (let i = 0; i < Math.min(CONCURRENCY, total); i++) {
    workers.push(runNext());
  }

  await Promise.all(workers);
  reportProgress();

  // Flatten results
  const parcels = [];
  const landcover = [];
  for (const r of results) {
    if (!r) continue;
    parcels.push(r.parcel);
    landcover.push(...r.landcover);
  }

  return { parcels, landcover };
}

/** Create an error parcel row */
function makeErrorParcel(id, egrid, row, message) {
  const parcel = {
    id,
    egrid,
    nummer: "",
    bfsnr: "",
    check_egrid: message,
    check_wfs: "",
    flaeche: "",
    parcel_area_m2: "",
    _geometry: null,
    _landcover: [],
  };
  for (const [k, v] of Object.entries(row)) {
    if (k !== "id" && k !== "egrid") parcel[`input_${k}`] = v;
  }
  return parcel;
}

/* ── Fetch with retry and timeout ── */

/**
 * Fetch with AbortController timeout and exponential backoff retry.
 * Retries on 429, 500, 502, 503, 504 and network errors.
 */
async function fetchWithRetry(url, opts = {}) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (cancelled) throw new Error("Cancelled");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const resp = await fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(timeout);

      if (resp.ok) return resp;

      // Retry on rate-limit or server errors
      if (resp.status === 429 || resp.status >= 500) {
        const retryAfter = resp.headers.get("Retry-After");
        const delay = retryAfter
          ? Math.min(parseInt(retryAfter, 10) * 1000, 10000)
          : BASE_DELAY_MS * Math.pow(2, attempt);
        lastError = new Error(`HTTP ${resp.status}`);
        if (attempt < MAX_RETRIES) {
          await sleep(delay);
          continue;
        }
      }

      throw new Error(`HTTP ${resp.status}`);
    } catch (err) {
      clearTimeout(timeout);

      if (err.name === "AbortError") {
        lastError = new Error("Request timeout");
      } else {
        lastError = err;
      }

      // Retry on network errors and timeouts
      if (attempt < MAX_RETRIES) {
        await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
        continue;
      }
    }
  }

  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ── API calls ── */

/** Fetch parcel geometry by EGRID (with dedup cache) */
async function fetchParcelGeometry(egrid) {
  // Check cache first
  if (egridCache.has(egrid)) {
    const cached = egridCache.get(egrid);
    // Return a fresh copy so mutations don't affect cache
    return cached ? JSON.parse(JSON.stringify(cached)) : null;
  }

  const params = new URLSearchParams({
    layer: "ch.kantone.cadastralwebmap-farbe",
    searchText: egrid,
    searchField: "egris_egrid",
    returnGeometry: "true",
    geometryFormat: "geojson",
    sr: "4326",
  });

  const resp = await fetchWithRetry(`${API.PARCEL_FIND}?${params}`);
  const data = await resp.json();

  if (!data.results || data.results.length === 0) {
    egridCache.set(egrid, null);
    return null;
  }

  const feature = data.results[0];
  const geom = feature.geometry;
  const props = feature.properties || feature.attributes || {};

  const result = {
    type: "Feature",
    geometry: geom,
    properties: {
      egrid: egrid,
      number: props.number || "",
      bfsnr: props.identnd || "",
      area: "",
    },
  };

  egridCache.set(egrid, result);
  return JSON.parse(JSON.stringify(result));
}

/**
 * Fetch land cover features via WFS.
 * Returns { features: [...], error: boolean } so callers can distinguish
 * "no land cover" from "WFS failed".
 */
async function fetchLandCover(bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox;

  const params = new URLSearchParams({
    SERVICE: "WFS",
    REQUEST: "GetFeature",
    VERSION: "2.0.0",
    TYPENAMES: "ms:LCSF",
    BBOX: `${minLat},${minLon},${maxLat},${maxLon},urn:ogc:def:crs:EPSG::4326`,
    SRSNAME: "urn:ogc:def:crs:EPSG::4326",
    OUTPUTFORMAT: "geojson",
    COUNT: "1000",
  });

  try {
    const resp = await fetchWithRetry(`${API.WFS_AV}?${params}`);
    const data = await resp.json();
    return { features: data.features || [], error: false };
  } catch (err) {
    console.warn("WFS fetch failed after retries:", err.message);
    return { features: [], error: true };
  }
}

/** Clip land cover features to parcel polygon using Turf.js */
function clipLandCover(parcelGeom, lcFeatures, id, egrid) {
  const results = [];
  const parcelFeature = turf.feature(parcelGeom);

  for (const lc of lcFeatures) {
    try {
      const intersection = turf.intersect(
        turf.featureCollection([parcelFeature, turf.feature(lc.geometry)])
      );

      if (!intersection) continue;

      const area = turf.area(intersection);
      if (area < SLIVER_THRESHOLD) continue;

      const art = lc.properties?.art || lc.properties?.Art || lc.properties?.ART || "";
      const fid = lc.id || lc.properties?.fid || "";
      const bfsnr = lc.properties?.bfsnr || lc.properties?.BFSNr || "";
      const gwrEgid = lc.properties?.gwr_egid || lc.properties?.GWR_EGID || "";

      const cls = classify(art);

      results.push({
        id,
        egrid,
        fid,
        art,
        bfsnr,
        gwr_egid: gwrEgid,
        check_greenspace: cls.greenSpace,
        area_m2: round2(area),
        _geometry: intersection.geometry,
        _sia416: cls.sia416,
        _din277: cls.din277,
        _sealed: cls.sealed,
      });
    } catch (err) {
      console.warn("Clip error for feature:", lc.id, err.message);
    }
  }

  return results;
}

/** Aggregate clipped land cover into summary columns */
function aggregateLandCover(clippedFeatures) {
  const agg = {
    GGF_m2: 0,
    BUF_m2: 0,
    UUF_m2: 0,
    DIN277_BF_m2: 0,
    DIN277_UF_m2: 0,
    Sealed_m2: 0,
    GreenSpace_m2: 0,
  };

  const artAreas = {};

  for (const f of clippedFeatures) {
    const area = f.area_m2;

    if (f._sia416 === "GGF") agg.GGF_m2 += area;
    else if (f._sia416 === "BUF") agg.BUF_m2 += area;
    else agg.UUF_m2 += area;

    if (f._din277 === "BF") agg.DIN277_BF_m2 += area;
    else agg.DIN277_UF_m2 += area;

    if (f._sealed) agg.Sealed_m2 += area;
    if (f.check_greenspace !== "Not green space") agg.GreenSpace_m2 += area;

    const artKey = `${f.art}_m2`;
    artAreas[artKey] = (artAreas[artKey] || 0) + area;
  }

  for (const k of Object.keys(agg)) agg[k] = round2(agg[k]);
  for (const k of Object.keys(artAreas)) artAreas[k] = round2(artAreas[k]);

  return { ...agg, ...artAreas };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
