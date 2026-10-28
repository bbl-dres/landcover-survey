/**
 * Live-service clients for the processing pipeline — the exact requests the Python
 * `api` source fires (processing-cli/api.py). The two files are kept in lock-step so the web
 * app and the CLI resolve the same feature sets and therefore the same results:
 *
 * - fetchParcelGeometry — geo.admin.ch `find` (parcel by EGRID, duplicates unioned,
 *   cached per session)
 * - fetchLandCover      — geodienste.ch WFS `ms:LCSF`, paged with STARTINDEX until
 *   an EMPTY page (the only reliable end signal) and deduplicated
 * - fetchIdentify       — geo.admin.ch `identify`, bbox quadtree so that every
 *   request is a single page (offset paging is lossy on this endpoint)
 * - loadGreenInventory  — the public green-inventory parcel list, once per session
 *
 * Every request goes through fetchWithRetry (AbortController timeout + exponential
 * backoff on 429/5xx and network errors). Nothing in here clips or classifies —
 * that is processor.js.
 */
import { API, fetchWithTimeout, BAFU_LAYER_ID, GREEN_INVENTORY } from "./config.js";

/** Land-cover WFS page size (GetFeature COUNT) and the total safety cap across all
 *  pages. Paging ends at the first empty page; the cap is only a backstop. */
export const WFS_PAGE = 1000;
export const WFS_MAX_FEATURES = 10000;
const FETCH_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

/** Identify per-request page size — the server's documented hard max (default 50,
 *  max 200). A tile that returns a full page is subdivided instead of paged. */
export const IDENTIFY_PAGE = 200;
/** Quadtree depth cap for identify tiling (4^8 tiles worst case — never reached in
 *  practice: a tile at depth 8 of a 2 km parcel bbox is ~8 m wide). */
export const IDENTIFY_MAX_DEPTH = 8;
/** Safety caps on the total features fetched per parcel for each overlay layer. */
export const BAFU_MAX_FEATURES = 5000;
export const BAUZONEN_LAYER_ID = "ch.are.bauzonen";
export const BAUZONEN_MAX_FEATURES = 2000;

/* ── Cancellation (shared with processor.js) ── */

let cancelled = false;
export function setCancelled(flag) { cancelled = !!flag; }
export function isCancelled() { return cancelled; }

/* ── Fetch with retry and timeout ── */

/**
 * Fetch with AbortController timeout and exponential backoff retry.
 * Retries on 429, 500, 502, 503, 504 and network errors.
 */
export async function fetchWithRetry(url, opts = {}) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (cancelled) throw new Error("Cancelled");

    let resp;
    try {
      resp = await fetchWithTimeout(url, { ...opts, timeoutMs: FETCH_TIMEOUT_MS });
    } catch (err) {
      lastError = err.name === "AbortError" ? new Error("Request timeout") : err;
      // Retry on network errors and timeouts
      if (attempt < MAX_RETRIES) {
        await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
        continue;
      }
      break;
    }

    if (resp.ok) return resp;
    lastError = new Error(`HTTP ${resp.status}`);

    // Retry only on rate-limit or server errors; other statuses fail fast.
    if (resp.status !== 429 && resp.status < 500) break;
    if (attempt >= MAX_RETRIES) break;
    const retryAfter = parseInt(resp.headers.get("Retry-After"), 10);
    const delay = Number.isFinite(retryAfter)
      ? Math.min(retryAfter * 1000, 10000)
      : BASE_DELAY_MS * Math.pow(2, attempt);
    await sleep(delay);
  }

  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ── Parcel geometry — geo.admin.ch find ── */

/** EGRID → parcel geometry cache (survives across runs within the same session).
 *  Value `null` is the negative cache for "not found". */
const egridCache = new Map();
export function clearParcelCache() { egridCache.clear(); }

/** Fetch parcel geometry by EGRID (with dedup cache).
 *  The returned object is treated as read-only downstream (turf operations and
 *  MapLibre copy their inputs), so we can hand back the cached object directly
 *  instead of deep-cloning it on every hit. Returns
 *  `{ type, geometry, properties: { egrid, number, nbident, area, mergedCount } }`
 *  or null when the EGRID is unknown. */
export async function fetchParcelGeometry(egrid) {
  if (egridCache.has(egrid)) {
    return egridCache.get(egrid);
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

  const feats = (data.results || []).filter((r) => r.geometry);
  if (feats.length === 0) {
    egridCache.set(egrid, null);
    return null;
  }

  // A single EGRID can map to multiple features (ongoing mutations, overlapping
  // SDR / Baurecht). Union all matching geometries into one polygon so the
  // parcel area and its land-cover clip aren't under-counted — this mirrors the
  // Python pipeline's "dissolve by EGRID" step (DATAMODEL.md §Duplicate EGRIDs).
  let geom = feats[0].geometry;
  const mergedCount = feats.length;
  if (feats.length > 1) {
    try {
      const unioned = turf.union(turf.featureCollection(feats.map((r) => turf.feature(r.geometry))));
      if (unioned?.geometry) geom = unioned.geometry;
    } catch (err) {
      console.warn(`Union failed for ${egrid} (${feats.length} parts), using first:`, err.message);
    }
  }

  const props = feats[0].properties || feats[0].attributes || {};

  const result = {
    type: "Feature",
    geometry: geom,
    properties: {
      egrid: egrid,
      number: props.number || "",
      // The find service returns the cadastral numbering-area id (NBIdent, e.g.
      // "BE0200000042"), not the BFS municipality number — the parcel's bfsnr is
      // derived from its AV land cover in processor.js instead.
      nbident: props.identnd || "",
      area: "",
      mergedCount,
    },
  };

  egridCache.set(egrid, result);
  return result;
}

/* ── Land cover — geodienste.ch WFS ms:LCSF ── */

/**
 * Fetch land cover features via WFS for a bbox `[minLon, minLat, maxLon, maxLat]`.
 * Returns { features, error, truncated } so callers can distinguish "no land
 * cover" from "WFS failed".
 *
 * Paging: an EMPTY page is the only reliable end-of-results signal. The server
 * applies COUNT to its spatial-index candidates before the exact bbox test, so a
 * non-final page routinely holds fewer than COUNT features (observed: 923 of 1000
 * with five more pages behind it), and consecutive pages can overlap by a few
 * features. Stopping at the first short page silently truncated dense bboxes;
 * paging until empty and deduplicating by (geometry, properties) reproduces the
 * server's own numberMatched exactly.
 */
export async function fetchLandCover(bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const maxPages = Math.max(1, Math.ceil(WFS_MAX_FEATURES / WFS_PAGE));
  const seen = new Set();
  const features = [];
  let truncated = false;

  try {
    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams({
        SERVICE: "WFS",
        REQUEST: "GetFeature",
        VERSION: "2.0.0",
        TYPENAMES: "ms:LCSF",
        BBOX: `${minLat},${minLon},${maxLat},${maxLon},urn:ogc:def:crs:EPSG::4326`,
        SRSNAME: "urn:ogc:def:crs:EPSG::4326",
        OUTPUTFORMAT: "geojson",
        COUNT: String(WFS_PAGE),
        STARTINDEX: String(page * WFS_PAGE),
      });
      const resp = await fetchWithRetry(`${API.WFS_AV}?${params}`);
      const data = await resp.json();
      const batch = data.features || [];
      if (batch.length === 0) break; // drained
      for (const f of batch) {
        const key = JSON.stringify([f.geometry, f.properties]);
        if (seen.has(key)) continue;
        seen.add(key);
        features.push(f);
      }
      // Still receiving features at the safety cap → more may remain.
      if (page === maxPages - 1) truncated = true;
    }
    return { features, error: false, truncated };
  } catch (err) {
    console.warn("WFS fetch failed after retries:", err.message);
    return { features: [], error: true, truncated: false };
  }
}

/* ── geo.admin.ch Identify (shared by the BAFU fallback + Bauzonen) ── */

/** Dedupe/sort key of an identify result: its feature id as a string, else the
 *  serialized geometry + attributes (an id-less result can't be deduped by id). */
function identifyKey(r) {
  const id = r.featureId ?? r.id;
  return id != null ? String(id) : JSON.stringify([r.geometry, r.properties || r.attributes || null]);
}

const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * Fetch ALL features of `layerId` intersecting a parcel's bbox via the Identify
 * endpoint. Returns { features, dropped, total, truncated }.
 *
 * The endpoint caps a request at 200 results, and paging past that with `offset`
 * is NOT reliable: the server returns results in a client-dependent order, so
 * consecutive pages overlap and omit features (observed: 475 of 556 from Node, 544
 * from Python, for the same bbox). Instead the bbox is tiled as a quadtree — a tile
 * that returns a full page is split into four — so every request is a single page
 * that is complete by construction. Results are deduplicated by feature id (a
 * feature on a tile boundary is returned by both tiles) and sorted by id so the
 * output is independent of tile order and server order.
 *
 * geo.admin.ch returns `geometry: null` for features whose geometry exceeds a
 * server-side size cap (e.g. city-scale "Asphalt- und Betonstrasse"); those are
 * kept aside in `dropped` (type only) so callers can account for them. May throw.
 */
export async function fetchIdentify(layerId, parcelGeom, maxFeatures) {
  const seen = new Set();
  const features = [], dropped = [];
  let total = 0, truncated = false;
  const stack = [[turf.bbox(parcelGeom), 0]];

  while (stack.length) {
    const [[minLon, minLat, maxLon, maxLat], depth] = stack.pop();
    const envelope = `${minLon},${minLat},${maxLon},${maxLat}`;
    const params = new URLSearchParams({
      geometry: envelope,
      geometryType: "esriGeometryEnvelope",
      geometryFormat: "geojson",
      layers: `all:${layerId}`,
      sr: "4326",
      tolerance: "0",
      mapExtent: envelope,
      imageDisplay: "100,100,96",
      returnGeometry: "true",
      limit: String(IDENTIFY_PAGE),
      offset: "0",
      lang: "de",
    });
    const resp = await fetchWithRetry(`${API.IDENTIFY}?${params}`);
    const data = await resp.json();
    const results = data.results || [];

    if (results.length >= IDENTIFY_PAGE) {
      if (depth < IDENTIFY_MAX_DEPTH) {
        // Full page → the tile may hold more than one page: subdivide instead.
        const midLon = (minLon + maxLon) / 2, midLat = (minLat + maxLat) / 2;
        stack.push(
          [[minLon, minLat, midLon, midLat], depth + 1],
          [[midLon, minLat, maxLon, midLat], depth + 1],
          [[minLon, midLat, midLon, maxLat], depth + 1],
          [[midLon, midLat, maxLon, maxLat], depth + 1],
        );
        continue;
      }
      truncated = true; // depth cap reached while still full — keep this page's results
    }

    for (const r of results) {
      const key = identifyKey(r);
      if (seen.has(key)) continue;
      seen.add(key);
      total++;
      const id = r.featureId ?? r.id;
      const properties = r.properties || r.attributes || {};
      if (r.geometry) features.push({ key, geometry: r.geometry, properties, id });
      else dropped.push({ key, properties, id });
    }
    if (total >= maxFeatures) { truncated = true; break; }
  }

  features.sort(byKey);
  dropped.sort(byKey);
  return { features, dropped, total, truncated };
}

/**
 * Fetch BAFU Lebensraumkarte (habitat) features for a parcel — fallback where AV
 * land cover is unavailable. Same { features, error, truncated } shape as fetchLandCover().
 */
export async function fetchLandCoverBAFU(parcelGeom) {
  try {
    const { features, dropped, truncated } = await fetchIdentify(BAFU_LAYER_ID, parcelGeom, BAFU_MAX_FEATURES);
    return { features, dropped, error: false, truncated };
  } catch (err) {
    console.warn("BAFU identify failed after retries:", err.message);
    return { features: [], dropped: [], error: true, truncated: false };
  }
}

/** Fetch building-zone features intersecting a parcel bbox (geo.admin.ch Identify). */
export async function fetchBauzonen(parcelGeom) {
  // A dropped (null-geometry) zone would inflate the "Ohne Bauzone" remainder, so the
  // caller flags those parcels rather than trusting the computed zone-free area.
  const { features, dropped, truncated } = await fetchIdentify(BAUZONEN_LAYER_ID, parcelGeom, BAUZONEN_MAX_FEATURES);
  return { features, dropped, truncated };
}

/* ── Green inventory (opt-in join) ── */

/** Green inventory parcel index ({ byEgrid, byErp } Maps), fetched at most once per
 *  session; resolves to null when the file could not be loaded (the join then stays
 *  empty and the caller reports it). */
let greenInventoryPromise = null;
export function loadGreenInventory() {
  if (!greenInventoryPromise) {
    greenInventoryPromise = fetchWithTimeout(GREEN_INVENTORY.PARCELS_URL, { timeoutMs: 30000 })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((fc) => {
        const byEgrid = new Map(), byErp = new Map();
        for (const f of fc.features || []) {
          const pr = f.properties || {};
          if (pr.egrid) byEgrid.set(String(pr.egrid).toUpperCase(), pr);
          if (pr.erp_id) byErp.set(String(pr.erp_id), pr);
        }
        return { byEgrid, byErp };
      })
      .catch((err) => { console.warn("Green inventory unavailable:", err.message); greenInventoryPromise = null; return null; });
  }
  return greenInventoryPromise;
}

/** "yes" when the parcel is in the green inventory (by EGRID, else by the SAP key = id),
 *  "no" otherwise, "" without an index. */
export function greenInventoryFlag(index, id, egrid) {
  if (!index) return "";
  if (egrid && index.byEgrid.has(String(egrid).toUpperCase())) return "yes";
  if (id && index.byErp.has(String(id))) return "yes";
  return "no";
}
