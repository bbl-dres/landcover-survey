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
import { API, SLIVER_THRESHOLD, STATUS, classify, classifyBafu, isFound, fetchWithTimeout,
         BAFU_LAYER_ID, VBS_KATEGORIE_LABELS, VBS_PRODUKTIV_LABELS, VBS_TYP_LABELS,
         ERR_MSG, ERR_RUNTIME_PREFIX, bauzoneAreaKey, isBauzoneAreaKey,
         habitatL1Label, habitatAreaKey, isHabitatAreaKey } from "./config.js";

// Parcels processed in parallel. Each parcel makes two sequential requests to
// two different hosts (swisstopo find + geodienste WFS), both HTTP/2, so a
// moderate bump over the old value of 5 improves throughput. The 429/5xx
// exponential backoff below absorbs the occasional rate-limit response.
const CONCURRENCY = 8;
/** Max land-cover features requested per parcel bbox (WFS GetFeature COUNT). */
const WFS_MAX_FEATURES = 1000;
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
export async function processRows(rows, onProgress, options = {}) {
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

      // Step 2: Fetch land cover via AV WFS
      const parcelGeom = parcelResult.geometry;
      const bbox = turf.bbox(parcelGeom);
      const lcResult = await fetchLandCover(bbox);

      // Step 3: Clip AV land cover to the parcel. BAFU habitat is no longer a
      // fallback here — it is its own overlay layer (see below), so Bodenbedeckung
      // stays pure AV (parcels in no-coverage cantons get an empty land cover).
      const lcSource = "AV";
      const { results: clipped, skipped } = clipLandCover(parcelGeom, lcResult.features, id, egrid);

      // Step 4: Calculate parcel area
      const parcelArea = turf.area(parcelGeom);

      // Step 5: Aggregate
      const agg = aggregateLandCover(clipped);

      // Genuine errors (status stays "found"; QA notes like merged/truncated/
      // skipped remain in the check_* columns).
      const lcErrors = [];
      if (clipped.length === 0 && lcResult.error) lcErrors.push(ERR_MSG.wfsUnavailable);

      const merged = parcelResult.properties.mergedCount > 1;
      const parcel = {
        id,
        egrid,
        nummer: parcelResult.properties.number || "",
        bfsnr: parcelResult.properties.bfsnr || "",
        status: "found",
        check_egrid: merged ? STATUS.MERGED : STATUS.FOUND,
        check_wfs: lcResult.error ? "wfs_error" : (lcResult.truncated ? "truncated" : "ok"),
        check_geom: skipped > 0 ? `${skipped}_skipped` : "ok",
        errors: lcErrors,
        lc_source: lcSource,
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

      // Optional overlay layers (default on). Each clips an extra geo.admin.ch
      // layer to the parcel, producing first-class detail rows (with geometry,
      // for the map + table + export) plus aggregated columns on the parcel.
      // One extra Identify call per parcel each; failures are non-fatal.
      let bauzonenRows = [];
      let habitatRows = [];

      if (options.bauzonen && parcelGeom) {
        try {
          const bz = await fetchBauzonen(parcelGeom);
          bauzonenRows = clipBauzonen(parcelGeom, bz.features, id, egrid).results;
          const bzAgg = aggregateBauzonen(bauzonenRows);
          parcel.bauzonen = bzAgg.bauzonen;
          parcel.bauzonen_m2 = bzAgg.bauzonen_m2;
          parcel.check_bauzonen = bz.truncated ? "truncated" : "ok";
          // One column per zone type (m²) — e.g. bauzonen_Wohnzonen_m2. Made
          // rectangular across all parcels in the flatten pass below.
          for (const [name, area] of Object.entries(bzAgg.zones)) {
            parcel[bauzoneAreaKey(name)] = area;
          }
        } catch (err) {
          console.warn(`Bauzonen analysis failed for ${egrid}:`, err.message);
          parcel.bauzonen = "";
          parcel.bauzonen_m2 = "";
          parcel.check_bauzonen = "error";
        }
      }

      if (options.habitat && parcelGeom) {
        try {
          const bafu = await fetchLandCoverBAFU(parcelGeom);
          habitatRows = clipHabitat(parcelGeom, bafu.features, id, egrid).results;
          const hbAgg = aggregateHabitat(habitatRows);
          parcel.habitat = hbAgg.habitat;
          parcel.habitat_m2 = hbAgg.habitat_m2;
          parcel.check_habitat = bafu.error ? "error" : (bafu.truncated ? "truncated" : "ok");
          // One column per TypoCH level-1 habitat group (m²) — e.g. habitat_waelder_m2.
          // Made rectangular across all parcels in the flatten pass below.
          for (const [name, area] of Object.entries(hbAgg.types)) {
            parcel[habitatAreaKey(name)] = area;
          }
        } catch (err) {
          console.warn(`Habitat analysis failed for ${egrid}:`, err.message);
          parcel.habitat = "";
          parcel.habitat_m2 = "";
          parcel.check_habitat = "error";
        }
      }

      parcel._bauzonen = bauzonenRows;
      parcel._habitat = habitatRows;

      return { parcel, landcover: clipped, bauzonen: bauzonenRows, habitat: habitatRows };
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
      if (result && isFound(result.parcel.check_egrid)) succeeded++;
      reportProgress();
    }
  };

  for (let i = 0; i < Math.min(CONCURRENCY, total); i++) {
    workers.push(runNext());
  }

  await Promise.all(workers);
  reportProgress();

  // When Bauzonen ran, make the per-zone columns rectangular: collect every
  // bauzonen_<zone>_m2 key seen across parcels, then 0-fill it on every parcel
  // below — so the export has a consistent column per zone type (pivot-ready),
  // since a parcel can span multiple zones.
  let zoneKeys = null;
  if (options.bauzonen) {
    zoneKeys = new Set();
    for (const r of results) {
      if (!r) continue;
      for (const k in r.parcel) {
        if (isBauzoneAreaKey(k)) zoneKeys.add(k);
      }
    }
  }
  // Same for the per-habitat-type columns (habitat_<group>_m2).
  let habitatKeys = null;
  if (options.habitat) {
    habitatKeys = new Set();
    for (const r of results) {
      if (!r) continue;
      for (const k in r.parcel) {
        if (isHabitatAreaKey(k)) habitatKeys.add(k);
      }
    }
  }

  // Flatten results. Each overlay keeps its own flat detail array (parallel to
  // landcover) for the table/summary/export; the per-parcel _arrays drive the map.
  const parcels = [];
  const landcover = [];
  const bauzonen = [];
  const habitat = [];
  for (const r of results) {
    if (!r) continue;
    // When an overlay ran, ensure every parcel (incl. error rows) carries the
    // joined columns (and every per-zone column) so the export header is uniform.
    if (options.bauzonen) {
      if (!("bauzonen" in r.parcel)) r.parcel.bauzonen = "";
      if (!("bauzonen_m2" in r.parcel)) r.parcel.bauzonen_m2 = "";
      if (!("check_bauzonen" in r.parcel)) r.parcel.check_bauzonen = "";
      for (const k of zoneKeys) if (!(k in r.parcel)) r.parcel[k] = 0;
    }
    if (options.habitat) {
      if (!("habitat" in r.parcel)) r.parcel.habitat = "";
      if (!("habitat_m2" in r.parcel)) r.parcel.habitat_m2 = "";
      if (!("check_habitat" in r.parcel)) r.parcel.check_habitat = "";
      for (const k of habitatKeys) if (!(k in r.parcel)) r.parcel[k] = 0;
    }
    parcels.push(r.parcel);
    landcover.push(...r.landcover);
    if (r.bauzonen) bauzonen.push(...r.bauzonen);
    if (r.habitat) habitat.push(...r.habitat);
  }

  return { parcels, landcover, bauzonen, habitat };
}

/** Map an EGRID-resolution failure code to a stable English error message. */
function egridErrorMessage(message) {
  if (message === STATUS.INVALID) return ERR_MSG.invalidEgrid;
  if (message === STATUS.NOT_FOUND) return ERR_MSG.egridNotFound;
  if (typeof message === "string" && message.startsWith("error:")) return ERR_RUNTIME_PREFIX + message.slice(6);
  return message;
}

/** Create an error parcel row */
function makeErrorParcel(id, egrid, row, message) {
  const parcel = {
    id,
    egrid,
    nummer: "",
    bfsnr: "",
    status: "not_found",
    check_egrid: message,
    check_wfs: "",
    check_geom: "",
    errors: [egridErrorMessage(message)],
    lc_source: "",
    flaeche: "",
    parcel_area_m2: "",
    _geometry: null,
    _landcover: [],
    _bauzonen: [],
    _habitat: [],
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

    try {
      const resp = await fetchWithTimeout(url, { ...opts, timeoutMs: FETCH_TIMEOUT_MS });

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

/** Fetch parcel geometry by EGRID (with dedup cache).
 *  The returned object is treated as read-only downstream (turf operations and
 *  MapLibre copy their inputs), so we can hand back the cached object directly
 *  instead of deep-cloning it on every hit. */
async function fetchParcelGeometry(egrid) {
  // Check cache first (value may be null = negative cache for "not found")
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
      bfsnr: props.identnd || "",
      area: "",
      mergedCount,
    },
  };

  egridCache.set(egrid, result);
  return result;
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
    COUNT: String(WFS_MAX_FEATURES),
  });

  try {
    const resp = await fetchWithRetry(`${API.WFS_AV}?${params}`);
    const data = await resp.json();
    const features = data.features || [];
    // If we hit the cap exactly, the bbox likely held more features than were
    // returned — the result may be truncated, so flag it for the caller.
    return { features, error: false, truncated: features.length >= WFS_MAX_FEATURES };
  } catch (err) {
    console.warn("WFS fetch failed after retries:", err.message);
    return { features: [], error: true, truncated: false };
  }
}

/* ── geo.admin.ch Identify (shared by the BAFU fallback + Bauzonen) ── */

/** Fetch features of `layerId` intersecting a parcel's bbox via the Identify
 *  endpoint. Returns an array of { geometry, properties, id }. May throw. */
async function fetchIdentify(layerId, parcelGeom, limit) {
  const [minLon, minLat, maxLon, maxLat] = turf.bbox(parcelGeom);
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
    limit: String(limit),
    lang: "de",
  });
  const resp = await fetchWithRetry(`${API.IDENTIFY}?${params}`);
  const data = await resp.json();
  return (data.results || [])
    .filter((r) => r.geometry)
    .map((r) => ({ geometry: r.geometry, properties: r.properties || r.attributes || {}, id: r.featureId ?? r.id }));
}

/** Max BAFU habitat features requested per parcel bbox (Identify limit cap). */
const BAFU_MAX_FEATURES = 200;

/**
 * Fetch BAFU Lebensraumkarte (habitat) features for a parcel — fallback where AV
 * land cover is unavailable. Same { features, error, truncated } shape as fetchLandCover().
 */
async function fetchLandCoverBAFU(parcelGeom) {
  try {
    const features = await fetchIdentify(BAFU_LAYER_ID, parcelGeom, BAFU_MAX_FEATURES);
    return { features, error: false, truncated: features.length >= BAFU_MAX_FEATURES };
  } catch (err) {
    console.warn("BAFU identify failed after retries:", err.message);
    return { features: [], error: true, truncated: false };
  }
}

/* ── Bauzonen (building zones) — optional per-parcel intersection ── */

const BAUZONEN_LAYER_ID = "ch.are.bauzonen";
const BAUZONEN_MAX_FEATURES = 200; // identify honours up to 200; matches BAFU cap

/** Fetch building-zone features intersecting a parcel bbox (geo.admin.ch Identify). */
async function fetchBauzonen(parcelGeom) {
  const features = await fetchIdentify(BAUZONEN_LAYER_ID, parcelGeom, BAUZONEN_MAX_FEATURES);
  return { features, truncated: features.length >= BAUZONEN_MAX_FEATURES };
}

/** Clip each `features` item to `parcelGeom` and call `onPiece(feature, geometry,
 *  area)` for every intersection above the sliver threshold. Returns the count of
 *  features whose intersection threw (dropped — Turf has no make_valid()). */
function clipFeatures(parcelGeom, features, onPiece) {
  let skipped = 0;
  const parcelFeature = turf.feature(parcelGeom);
  for (const f of features) {
    try {
      const intersection = turf.intersect(turf.featureCollection([parcelFeature, turf.feature(f.geometry)]));
      if (!intersection) continue;
      const area = turf.area(intersection);
      if (area < SLIVER_THRESHOLD) continue;
      onPiece(f, intersection.geometry, area);
    } catch (err) {
      skipped++;
      console.warn("Clip error for feature:", f.id, err.message);
    }
  }
  return skipped;
}

/** Clip Bauzonen (building zones) to a parcel — one detail row per clipped piece.
 *  `art` holds the zone name (the generic "type" field shared by all overlay
 *  layers, so the map/table/summary treat it uniformly). */
function clipBauzonen(parcelGeom, features, id, egrid) {
  const results = [];
  const skipped = clipFeatures(parcelGeom, features, (bz, geometry, area) => {
    const name = bz.properties?.ch_bez_d || bz.properties?.bz_bezeichnung || "?";
    const code = bz.properties?.ch_code_hn || bz.properties?.bz_nutzung || "";
    const fid = bz.id || bz.properties?.fid || "";
    results.push({
      id, egrid, fid,
      art: name,
      bauzone_code: code,
      lc_source: "Bauzonen",
      area_m2: round2(area),
      _rawArea: area,
      _geometry: geometry,
    });
  });
  return { results, skipped };
}

/** Aggregate Bauzonen detail rows into the parcel columns: semicolon-joined
 *  `bauzonen` (names) + `bauzonen_m2` (areas) + a `zones` map, largest first —
 *  mirrors the Python `--bauzonen` output. */
function aggregateBauzonen(rows) {
  const byZone = new Map(); // zone name → area m²
  for (const r of rows) byZone.set(r.art, (byZone.get(r.art) || 0) + (r._rawArea ?? r.area_m2));

  if (byZone.size === 0) return { bauzonen: "", bauzonen_m2: "", zones: {} };
  const sorted = [...byZone.entries()].sort((a, b) => b[1] - a[1]);
  const zones = {};
  for (const [n, a] of sorted) zones[n] = round2(a);
  return {
    bauzonen: sorted.map(([n]) => n).join("; "),
    bauzonen_m2: sorted.map(([, a]) => a.toFixed(1)).join("; "),
    zones,
  };
}

/** Aggregate BAFU habitat detail rows into parcel columns, grouped by TypoCH
 *  **level-1** category (the 91 fine labels collapse to ~9 groups — the same
 *  grouping the map/table use). Returns semicolon-joined `habitat` (group names)
 *  + `habitat_m2` (areas) + a `types` map (group name → area) that becomes one
 *  `habitat_<slug>_m2` column per group, largest first. */
function aggregateHabitat(rows) {
  const byTyp = new Map(); // TypoCH level-1 group name → area m²
  for (const r of rows) {
    const name = habitatL1Label(r.art);
    byTyp.set(name, (byTyp.get(name) || 0) + (r._rawArea ?? r.area_m2));
  }

  if (byTyp.size === 0) return { habitat: "", habitat_m2: "", types: {} };
  const sorted = [...byTyp.entries()].sort((a, b) => b[1] - a[1]);
  const types = {};
  for (const [n, a] of sorted) types[n] = round2(a);
  return {
    habitat: sorted.map(([n]) => n).join("; "),
    habitat_m2: sorted.map(([, a]) => a.toFixed(1)).join("; "),
    types,
  };
}

/** Clip AV land cover features to a parcel and classify each piece. */
function clipLandCover(parcelGeom, lcFeatures, id, egrid) {
  const results = [];
  const skipped = clipFeatures(parcelGeom, lcFeatures, (lc, geometry, area) => {
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
      // VBS classification — stable English output values (translated for display).
      // Typ is only assigned within biologically productive area; blank otherwise.
      vbs_kategorie: VBS_KATEGORIE_LABELS[cls.vbsKategorie] || "",
      vbs_produktiv: VBS_PRODUKTIV_LABELS[cls.vbsProduktiv] || "",
      vbs_typ: cls.vbsTyp ? (VBS_TYP_LABELS[cls.vbsTyp] || "") : "",
      lc_source: "AV",
      prob: "",
      area_m2: round2(area),
      _rawArea: area, // unrounded — summed by aggregateLandCover to avoid rounding drift
      _geometry: geometry,
      _sia416: cls.sia416,
      _din277: cls.din277,
      _sealed: cls.sealed,
      _vbsKategorie: cls.vbsKategorie,
      _vbsProduktiv: cls.vbsProduktiv,
      _vbsTyp: cls.vbsTyp,
    });
  });
  return { results, skipped };
}

/** Clip BAFU habitat features to a parcel and classify via TypoCH. `art` holds the
 *  TypoCH label; SIA 416 / DIN 277 / sealed are `null` (a modeled habitat map can't
 *  supply them) so aggregation/summary skip them via the null check. */
function clipHabitat(parcelGeom, bafuFeatures, id, egrid) {
  const results = [];
  const skipped = clipFeatures(parcelGeom, bafuFeatures, (lc, geometry, area) => {
    const typoch = lc.properties?.typoch_de || "";
    const prob = lc.properties?.prob_de || "";
    const fid = lc.id || lc.properties?.polyid || "";
    const cls = classifyBafu(typoch);
    results.push({
      id,
      egrid,
      fid,
      art: typoch, // TypoCH habitat label, e.g. "6.3.1 Buchenwald"
      bfsnr: "",
      gwr_egid: "",
      check_greenspace: cls.greenSpace,
      vbs_kategorie: VBS_KATEGORIE_LABELS[cls.vbsKategorie] || "",
      vbs_produktiv: VBS_PRODUKTIV_LABELS[cls.vbsProduktiv] || "",
      vbs_typ: cls.vbsTyp ? (VBS_TYP_LABELS[cls.vbsTyp] || "") : "",
      lc_source: "BAFU",
      prob,
      area_m2: round2(area),
      _rawArea: area,
      _geometry: geometry,
      _sia416: null, // not derivable from a modeled habitat map
      _din277: null,
      _sealed: null,
      _vbsKategorie: cls.vbsKategorie,
      _vbsProduktiv: cls.vbsProduktiv,
      _vbsTyp: cls.vbsTyp,
    });
  });
  return { results, skipped };
}

/** Aggregate clipped land cover into summary columns */
function aggregateLandCover(clippedFeatures) {
  // Aggregation columns — all lowercase, namespaced by classification scheme
  // (sia416_/din277_/vbs_) or imperviousness/green. Raw per-Art areas are added
  // below as av_<art>_m2 (source = AV land cover).
  const agg = {
    sia416_ggf_m2: 0,
    sia416_buf_m2: 0,
    sia416_uuf_m2: 0,
    din277_bf_m2: 0,
    din277_uf_m2: 0,
    sealed_m2: 0,
    greenspace_m2: 0,
    vbs_produktiv_m2: 0,
    vbs_unproduktiv_m2: 0,
    vbs_kat_a_m2: 0,
    vbs_kat_b_m2: 0,
    vbs_kat_c_m2: 0,
    vbs_kat_d_m2: 0,
    vbs_typ1_m2: 0,
    vbs_typ2_m2: 0,
  };

  const artAreas = {};

  // This runs on AV land cover only (BAFU habitat is its own layer now), so every
  // row carries an SIA 416 / DIN 277 / sealed class — there is no unclassified path.
  for (const f of clippedFeatures) {
    // Sum unrounded areas; the result is rounded once at the end. Summing the
    // per-feature rounded area_m2 would accumulate rounding error.
    const area = f._rawArea ?? f.area_m2;

    // SIA 416
    if (f._sia416 === "GGF") agg.sia416_ggf_m2 += area;
    else if (f._sia416 === "BUF") agg.sia416_buf_m2 += area;
    else agg.sia416_uuf_m2 += area;

    // DIN 277
    if (f._din277 === "BF") agg.din277_bf_m2 += area;
    else agg.din277_uf_m2 += area;

    if (f._sealed) agg.sealed_m2 += area;

    // Raw AV land-cover area per BBArt type → av_<art>_m2 (art value lowercased).
    const artKey = `av_${String(f.art).toLowerCase()}_m2`;
    artAreas[artKey] = (artAreas[artKey] || 0) + area;

    // Green space
    if (f.check_greenspace !== "Not green space") agg.greenspace_m2 += area;

    // VBS biological productivity
    if (f._vbsProduktiv === "produktiv") agg.vbs_produktiv_m2 += area;
    else agg.vbs_unproduktiv_m2 += area;

    // VBS Kategorie (a–d); unknown falls back to kat_d
    const kat = f._vbsKategorie || "kat_d";
    if (kat === "kat_a") agg.vbs_kat_a_m2 += area;
    else if (kat === "kat_b") agg.vbs_kat_b_m2 += area;
    else if (kat === "kat_c") agg.vbs_kat_c_m2 += area;
    else agg.vbs_kat_d_m2 += area;

    // VBS Typ — biologically productive only (unproductive contributes to neither)
    if (f._vbsTyp === "typ1") agg.vbs_typ1_m2 += area;
    else if (f._vbsTyp === "typ2") agg.vbs_typ2_m2 += area;
  }

  for (const k of Object.keys(agg)) agg[k] = round2(agg[k]);
  for (const k of Object.keys(artAreas)) artAreas[k] = round2(artAreas[k]);

  return { ...agg, ...artAreas };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
