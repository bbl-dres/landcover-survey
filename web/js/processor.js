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
         BAFU_LAYER_ID, VBS_KATEGORIE_LABELS, VBS_PRODUKTIV_LABELS, VBS_TYP_LABELS } from "./config.js";

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

      // Step 3: Clip land cover to parcel. If AV has no land cover here (no-access
      // canton or coverage gap), fall back to the BAFU habitat map for this parcel.
      // A parcel is wholly AV or wholly BAFU — never mixed.
      let lcSource = "AV";
      let clipped, skipped;
      if (lcResult.features.length === 0) {
        const bafuResult = await fetchLandCoverBAFU(parcelGeom);
        if (bafuResult.features.length > 0) {
          lcSource = "BAFU";
          ({ results: clipped, skipped } = clipLandCoverBAFU(parcelGeom, bafuResult.features, id, egrid));
        } else {
          ({ results: clipped, skipped } = clipLandCover(parcelGeom, lcResult.features, id, egrid));
        }
      } else {
        ({ results: clipped, skipped } = clipLandCover(parcelGeom, lcResult.features, id, egrid));
      }

      // Step 4: Calculate parcel area
      const parcelArea = turf.area(parcelGeom);

      // Step 5: Aggregate
      const agg = aggregateLandCover(clipped);

      // Genuine errors (status stays "found"; QA notes like merged/truncated/
      // skipped remain in the check_* columns).
      const lcErrors = [];
      if (clipped.length === 0 && lcResult.error) lcErrors.push("Land cover unavailable (WFS)");

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

      // Optional: intersect with Bauzonen (building zones) — opt-in, one extra
      // Identify call per parcel. Failure is non-fatal (empty columns).
      if (options.bauzonen && parcelGeom) {
        try {
          const bz = await fetchBauzonen(parcelGeom);
          const agg = intersectBauzonen(parcelGeom, bz.features);
          parcel.bauzonen = agg.bauzonen;
          parcel.bauzonen_m2 = agg.bauzonen_m2;
          // One column per zone type (m²) — e.g. bauzonen_Wohnzonen_m2. Made
          // rectangular across all parcels in the flatten pass below.
          for (const [name, area] of Object.entries(agg.zones)) {
            parcel[`bauzonen_${name}_m2`] = area;
          }
        } catch (err) {
          console.warn(`Bauzonen analysis failed for ${egrid}:`, err.message);
          parcel.bauzonen = "";
          parcel.bauzonen_m2 = "";
        }
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
        if (k.startsWith("bauzonen_") && k.endsWith("_m2") && k !== "bauzonen_m2") zoneKeys.add(k);
      }
    }
  }

  // Flatten results
  const parcels = [];
  const landcover = [];
  for (const r of results) {
    if (!r) continue;
    // When Bauzonen ran, ensure every parcel (incl. error rows) carries the
    // joined columns and every per-zone column so the export header is uniform.
    if (options.bauzonen) {
      if (!("bauzonen" in r.parcel)) r.parcel.bauzonen = "";
      if (!("bauzonen_m2" in r.parcel)) r.parcel.bauzonen_m2 = "";
      for (const k of zoneKeys) if (!(k in r.parcel)) r.parcel[k] = 0;
    }
    parcels.push(r.parcel);
    landcover.push(...r.landcover);
  }

  return { parcels, landcover };
}

/** Map an EGRID-resolution failure code to a stable English error message. */
function egridErrorMessage(message) {
  if (message === STATUS.INVALID) return "Invalid EGRID";
  if (message === STATUS.NOT_FOUND) return "EGRID not found in AV";
  if (typeof message === "string" && message.startsWith("error:")) return "Error: " + message.slice(6);
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

/** Max BAFU habitat features requested per parcel bbox (Identify limit cap). */
const BAFU_MAX_FEATURES = 200;

/**
 * Fetch BAFU Lebensraumkarte (habitat) features for a parcel, via the geo.admin.ch
 * Identify endpoint. Used as a fallback where AV land cover is unavailable.
 * Returns the same { features, error, truncated } shape as fetchLandCover().
 */
async function fetchLandCoverBAFU(parcelGeom) {
  const [minLon, minLat, maxLon, maxLat] = turf.bbox(parcelGeom);
  const envelope = `${minLon},${minLat},${maxLon},${maxLat}`;

  const params = new URLSearchParams({
    geometry: envelope,
    geometryType: "esriGeometryEnvelope",
    geometryFormat: "geojson",
    layers: `all:${BAFU_LAYER_ID}`,
    sr: "4326",
    tolerance: "0",
    mapExtent: envelope,
    imageDisplay: "100,100,96",
    returnGeometry: "true",
    limit: String(BAFU_MAX_FEATURES),
    lang: "de",
  });

  try {
    const resp = await fetchWithRetry(`${API.IDENTIFY}?${params}`);
    const data = await resp.json();
    const features = (data.results || [])
      .filter((r) => r.geometry)
      .map((r) => ({ geometry: r.geometry, properties: r.properties || r.attributes || {}, id: r.featureId ?? r.id }));
    return { features, error: false, truncated: features.length >= BAFU_MAX_FEATURES };
  } catch (err) {
    console.warn("BAFU identify failed after retries:", err.message);
    return { features: [], error: true, truncated: false };
  }
}

/* ── Bauzonen (building zones) — optional per-parcel intersection ── */

const BAUZONEN_LAYER_ID = "ch.are.bauzonen";
const BAUZONEN_MAX_FEATURES = 50;

/** Fetch building-zone features intersecting a parcel bbox (geo.admin.ch Identify). */
async function fetchBauzonen(parcelGeom) {
  const [minLon, minLat, maxLon, maxLat] = turf.bbox(parcelGeom);
  const envelope = `${minLon},${minLat},${maxLon},${maxLat}`;

  const params = new URLSearchParams({
    geometry: envelope,
    geometryType: "esriGeometryEnvelope",
    geometryFormat: "geojson",
    layers: `all:${BAUZONEN_LAYER_ID}`,
    sr: "4326",
    tolerance: "0",
    mapExtent: envelope,
    imageDisplay: "100,100,96",
    returnGeometry: "true",
    limit: String(BAUZONEN_MAX_FEATURES),
    lang: "de",
  });

  const resp = await fetchWithRetry(`${API.IDENTIFY}?${params}`);
  const data = await resp.json();
  const features = (data.results || [])
    .filter((r) => r.geometry)
    .map((r) => ({ geometry: r.geometry, properties: r.properties || r.attributes || {} }));
  return { features };
}

/** Clip Bauzonen to the parcel and aggregate area per zone name. Returns
 *  semicolon-joined `bauzonen` (names) + `bauzonen_m2` (areas), largest first —
 *  mirrors the Python `--bauzonen` output. */
function intersectBauzonen(parcelGeom, features) {
  const parcelFeature = turf.feature(parcelGeom);
  const byZone = new Map(); // zone name → area m²

  for (const bz of features) {
    try {
      const inter = turf.intersect(
        turf.featureCollection([parcelFeature, turf.feature(bz.geometry)])
      );
      if (!inter) continue;
      const area = turf.area(inter);
      if (area < SLIVER_THRESHOLD) continue;
      const name = bz.properties?.ch_bez_d || bz.properties?.bz_bezeichnung || "?";
      byZone.set(name, (byZone.get(name) || 0) + area);
    } catch {
      // skip invalid/self-intersecting zone geometry
    }
  }

  if (byZone.size === 0) return { bauzonen: "", bauzonen_m2: "", zones: {} };
  const sorted = [...byZone.entries()].sort((a, b) => b[1] - a[1]);
  // zones: { "Wohnzonen": 316.08, ... } — for the per-type m² columns
  const zones = {};
  for (const [n, a] of sorted) zones[n] = round2(a);
  return {
    bauzonen: sorted.map(([n]) => n).join("; "),
    bauzonen_m2: sorted.map(([, a]) => a.toFixed(1)).join("; "),
    zones,
  };
}

/** Clip land cover features to a parcel polygon using Turf.js.
 *  Returns { results, skipped } — `skipped` counts features whose intersection
 *  threw (e.g. invalid/self-intersecting geometry; Turf.js has no make_valid()
 *  equivalent, so those features are dropped rather than repaired). */
function clipLandCover(parcelGeom, lcFeatures, id, egrid) {
  const results = [];
  let skipped = 0;
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
        // VBS classification — stable English output values (translated for display).
        // Typ is only assigned within biologically productive area; blank otherwise.
        "VBS Kategorie": VBS_KATEGORIE_LABELS[cls.vbsKategorie] || "",
        "VBS Biologisch produktiv": VBS_PRODUKTIV_LABELS[cls.vbsProduktiv] || "",
        "VBS Typ": cls.vbsTyp ? (VBS_TYP_LABELS[cls.vbsTyp] || "") : "",
        lc_source: "AV",
        prob: "",
        area_m2: round2(area),
        _rawArea: area, // unrounded — summed by aggregateLandCover to avoid rounding drift
        _geometry: intersection.geometry,
        _sia416: cls.sia416,
        _din277: cls.din277,
        _sealed: cls.sealed,
        _vbsKategorie: cls.vbsKategorie,
        _vbsProduktiv: cls.vbsProduktiv,
        _vbsTyp: cls.vbsTyp,
      });
    } catch (err) {
      skipped++;
      console.warn("Clip error for feature:", lc.id, err.message);
    }
  }

  return { results, skipped };
}

/** Clip BAFU habitat features to a parcel polygon and classify via TypoCH.
 *  Mirrors clipLandCover() but: `art` holds the TypoCH label, only green space +
 *  VBS are derived (SIA416/DIN277/sealed left undefined), and `_bafu` marks the
 *  rows so aggregation knows to skip the AV-only columns. */
function clipLandCoverBAFU(parcelGeom, bafuFeatures, id, egrid) {
  const results = [];
  let skipped = 0;
  const parcelFeature = turf.feature(parcelGeom);

  for (const lc of bafuFeatures) {
    try {
      const intersection = turf.intersect(
        turf.featureCollection([parcelFeature, turf.feature(lc.geometry)])
      );

      if (!intersection) continue;

      const area = turf.area(intersection);
      if (area < SLIVER_THRESHOLD) continue;

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
        "VBS Kategorie": VBS_KATEGORIE_LABELS[cls.vbsKategorie] || "",
        "VBS Biologisch produktiv": VBS_PRODUKTIV_LABELS[cls.vbsProduktiv] || "",
        "VBS Typ": cls.vbsTyp ? (VBS_TYP_LABELS[cls.vbsTyp] || "") : "",
        lc_source: "BAFU",
        prob,
        area_m2: round2(area),
        _rawArea: area,
        _geometry: intersection.geometry,
        // SIA416 / DIN277 / sealed intentionally omitted (blank) for BAFU rows
        _vbsKategorie: cls.vbsKategorie,
        _vbsProduktiv: cls.vbsProduktiv,
        _vbsTyp: cls.vbsTyp,
        _bafu: true,
      });
    } catch (err) {
      skipped++;
      console.warn("BAFU clip error for feature:", lc.id, err.message);
    }
  }

  return { results, skipped };
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
    VBS_Produktiv_m2: 0,
    VBS_Unproduktiv_m2: 0,
    VBS_Kat_A_m2: 0,
    VBS_Kat_B_m2: 0,
    VBS_Kat_C_m2: 0,
    VBS_Kat_D_m2: 0,
    VBS_Typ1_m2: 0,
    VBS_Typ2_m2: 0,
  };

  const artAreas = {};

  // A parcel is wholly AV or wholly BAFU. BAFU rows can't supply SIA 416 / DIN 277
  // / sealed / per-Art breakdown, so those are left blank for a BAFU parcel.
  const isBafu = clippedFeatures.length > 0 && clippedFeatures.every((f) => f._bafu);

  for (const f of clippedFeatures) {
    // Sum unrounded areas; the result is rounded once at the end. Summing the
    // per-feature rounded area_m2 would accumulate rounding error.
    const area = f._rawArea ?? f.area_m2;

    // SIA 416 / DIN 277 / sealed / per-Art — AV rows only
    if (!f._bafu) {
      if (f._sia416 === "GGF") agg.GGF_m2 += area;
      else if (f._sia416 === "BUF") agg.BUF_m2 += area;
      else agg.UUF_m2 += area;

      if (f._din277 === "BF") agg.DIN277_BF_m2 += area;
      else agg.DIN277_UF_m2 += area;

      if (f._sealed) agg.Sealed_m2 += area;

      const artKey = `${f.art}_m2`;
      artAreas[artKey] = (artAreas[artKey] || 0) + area;
    }

    // Green space + VBS — both AV and BAFU
    if (f.check_greenspace !== "Not green space") agg.GreenSpace_m2 += area;

    if (f._vbsProduktiv === "produktiv") agg.VBS_Produktiv_m2 += area;
    else agg.VBS_Unproduktiv_m2 += area;

    // VBS Kategorie (a–d); unknown falls back to kat_d
    const kat = f._vbsKategorie || "kat_d";
    if (kat === "kat_a") agg.VBS_Kat_A_m2 += area;
    else if (kat === "kat_b") agg.VBS_Kat_B_m2 += area;
    else if (kat === "kat_c") agg.VBS_Kat_C_m2 += area;
    else agg.VBS_Kat_D_m2 += area;

    // VBS Typ — biologically productive only (unproductive contributes to neither)
    if (f._vbsTyp === "typ1") agg.VBS_Typ1_m2 += area;
    else if (f._vbsTyp === "typ2") agg.VBS_Typ2_m2 += area;
  }

  for (const k of Object.keys(agg)) agg[k] = round2(agg[k]);
  for (const k of Object.keys(artAreas)) artAreas[k] = round2(artAreas[k]);

  // BAFU parcels: SIA 416 / DIN 277 / sealed are not derivable — leave blank.
  if (isBafu) {
    agg.GGF_m2 = agg.BUF_m2 = agg.UUF_m2 = "";
    agg.DIN277_BF_m2 = agg.DIN277_UF_m2 = "";
    agg.Sealed_m2 = "";
  }

  return { ...agg, ...artAreas };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
