/**
 * Core processing: EGRID → Parcel Geometry → WFS Land Cover → Turf.js Clip → Area
 *
 * This module clips, classifies and aggregates; every live request lives in
 * geoapi.js (mirrored by processing-cli/src/api.py) and this file is mirrored step for step by
 * processing-cli/src/processor_web.py — keep the two in lock-step, the cross-check
 * (processing-cli/src/compare.py) depends on it.
 *
 * A value whose query failed is left EMPTY, never 0: an empty cell means "not
 * known", a 0 means "asked, nothing there". Parcels with a failed query are asked
 * again at the end of the run (RETRY_ROUNDS).
 *
 * Function names follow processor_web.py (processOne ⇄ _process_one,
 * makeLandcoverRow ⇄ _make_landcover_row, aggregateLandCover ⇄ _aggregate_landcover …)
 * — see docs/ARCHITECTURE.md §Web ⇄ CLI name map.
 *
 * Performance strategy:
 * - Parallel parcels (bounded, max CONCURRENCY at once)
 * - Turf.js clipping runs synchronously per parcel (CPU-bound, fast)
 * - Exponential backoff on 429/5xx errors, EGRID dedup cache (geoapi.js)
 */
import { SLIVER_THRESHOLD, STATUS, SIA416, classify, classifyBafu, typochToBBArt, isFound,
         VBS_KATEGORIE_LABELS, VBS_PRODUKTIV_LABELS, VBS_TYP_LABELS,
         ERR_MSG, ERR_RUNTIME_PREFIX, bauzoneAreaKey, isBauzoneAreaKey,
         ensureTypoch, typochL1Label, typochL2Label, typochL3Label, typochCodeAtLevel,
         habitatAreaKeyL1, habitatAreaKeyL2, isHabitatAreaKey } from "./config.js";
import { setCancelled, isCancelled, fetchParcelGeometry, fetchLandCover, fetchLandCoverBAFU,
         fetchBauzonen, loadGreenInventory, greenInventoryFlag } from "./geoapi.js";

// Parcels processed in parallel. Each parcel makes two sequential requests to
// two different hosts (swisstopo find + geodienste WFS), both HTTP/2, so a
// moderate bump over the old value of 5 improves throughput. The 429/5xx
// exponential backoff in geoapi.js absorbs the occasional rate-limit response.
const CONCURRENCY = 8;
/** Below this fraction of AV land-cover coverage a parcel counts as "no AV", and
 *  (if BAFU data exists) its land cover is synthesized from BAFU — see TYPOCH_BBART. */
const MIN_AV_COVER_FRAC = 0.05;
/** Min zone-free area (m²) before we emit an "Ohne Bauzone" remainder row — keeps
 *  the zones summing to the parcel area without adding sub-m² sliver rows. */
const OHNE_BAUZONE_MIN_AREA = 1;
/** Min share of the parcel a dropped (null-geometry) habitat feature must cover
 *  before we gap-fill it — below this it's sliver noise, not a missing big feature. */
const HABITAT_GAP_MIN_FRAC = 0.01;
/** The services answer 502 in bursts that outlast the per-request retries, so parcels
 *  with a failed query are processed again after the first pass (as in processor_web.py). */
export const RETRY_ROUNDS = 2;
const RETRY_PAUSE_MS = 20000;
let retryPauseMs = RETRY_PAUSE_MS;
/** Test hook: shorten the pause between retry rounds. */
export function setRetryPauseMs(ms) { retryPauseMs = ms; }

/** The fixed aggregation columns of a parcel, in output order (aggregateLandCover). */
export const LANDCOVER_AGG_KEYS = [
  "sia416_ggf_m2", "sia416_buf_m2", "sia416_uuf_m2",
  "din277_bf_m2", "din277_uf_m2",
  "sealed_m2", "greenspace_m2",
  "av_produktiv_m2", "av_unproduktiv_m2",
  "av_kat_a_m2", "av_kat_b_m2", "av_kat_c_m2", "av_kat_d_m2",
  "av_typ1_m2", "av_typ2_m2",
];

export function cancelProcessing() {
  setCancelled(true);
}

/** Sequence number of the run in progress. A run stops when it is cancelled OR when
 *  a newer run has started: the cancel flag in geoapi.js is one global boolean that
 *  the next processRows() resets, which on its own would let an abandoned run carry on. */
let activeRun = 0;

/** True when a query of this parcel failed (a state of the service, not a property
 *  of the parcel): the lookup or the pipeline threw, or the land-cover, Bauzonen or
 *  habitat request did not answer. Mirror of needs_retry(). */
export function needsRetry(result) {
  const p = result.parcel;
  return String(p.check_egrid || "").startsWith("error:")
    || p.check_wfs === "wfs_error"
    || p.check_bauzonen === "error"
    || p.check_habitat === "error";
}

/** The result to keep after a retry: the new one, unless it failed again and the
 *  earlier one at least resolved the parcel — never trade a partial result for an
 *  error row. Mirror of _better_result(). */
function betterResult(prev, next) {
  if (!prev || !needsRetry(next) || !isFound(prev.parcel.check_egrid)) return next;
  return prev;
}

/** Value for an overlay area column the parcel has no entry in: 0 when the overlay
 *  answered for this parcel, "" when it did not. Mirror of _overlay_fill(). */
function overlayFill(parcel, checkKey) {
  const answered = isFound(parcel.check_egrid) && !!parcel[checkKey] && parcel[checkKey] !== "error";
  return answered ? 0 : "";
}

/** Wait `ms`, waking early when the run is stopped. */
async function pause(ms, stopped) {
  const until = Date.now() + ms;
  while (Date.now() < until && !stopped()) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, until - Date.now()))));
  }
}

/**
 * Process all rows from the CSV.
 * Returns { parcels, landcover, bauzonen, habitat, greeninvFailed, cancelled }
 *
 * A parcel is reported to `onProgress` once, with its final result; a parcel whose
 * query failed is held back and processed again (up to RETRY_ROUNDS times) first.
 */
export async function processRows(rows, onProgress, options = {}) {
  const run = ++activeRun;
  setCancelled(false);
  const stopped = () => run !== activeRun || isCancelled();
  // Load the shared TypoCH name reference once up front (memoized, fail-soft) so the
  // per-parcel habitat labelling below can resolve level-1/2/3 names synchronously.
  if (options.habitat) await ensureTypoch();
  // Optional green-inventory join: one public parcel file, fetched once, keyed by EGRID + SAP id.
  const greenIndex = options.greeninv ? await loadGreenInventory() : null;
  const total = rows.length;
  let completed = 0;
  let succeeded = 0;

  const results = new Array(total);

  // How often each EGRID stands in the list. A repeated parcel is processed per row
  // and carries its full areas in each — a sum over the parcel table counts it that
  // many times. The count travels on the parcel as `_egridCount` (internal, not
  // exported) so the processing log can say so.
  const egridCounts = new Map();
  for (const r of rows) if (r.egrid) egridCounts.set(r.egrid, (egridCounts.get(r.egrid) || 0) + 1);

  // `parcel` is the row that just finished (null on the final call) — the UI's
  // processing log reads its check_* flags; nothing else depends on it. `retrying`
  // is the number of parcels waiting for another attempt (0 otherwise).
  const reportProgress = (parcel = null, retrying = 0) => {
    onProgress({ processed: completed, total, succeeded, failed: completed - succeeded, parcel, retrying });
  };

  const processOne = async (row) => {
    if (stopped()) return null;

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
      const lcFailed = lcResult.error; // the request failed: land cover is unknown, not absent
      const parcelArea = turf.area(parcelGeom);

      // Step 3: Clip AV land cover to the parcel + aggregate.
      let { results: clipped, skipped } = clipLandCover(parcelGeom, lcResult.features, id, egrid);
      const avRows = clipped; // the authoritative AV pieces, kept for the bfsnr even if synthesized below
      let agg = aggregateLandCover(clipped);
      let lcSource = "AV", lcSynthetic = false;

      // BAFU habitat is fetched at most once per parcel and shared by the synthetic
      // land-cover fallback (Step 3b) and the optional habitat overlay layer (below).
      let _bafu;
      const getBafu = async () => {
        if (_bafu !== undefined) return _bafu;
        try {
          const fr = await fetchLandCoverBAFU(parcelGeom);
          _bafu = { ...fr, clip: clipHabitat(parcelGeom, fr.features, id, egrid) };
        } catch (err) {
          console.warn(`BAFU fetch failed for ${egrid}:`, err.message);
          _bafu = null;
        }
        return _bafu;
      };

      // Step 3b: Synthetic AV land cover where AV is (essentially) absent. Build real
      // BBArt features from the BAFU habitat polygons — geometry is real, the BBArt
      // label is inferred via TYPOCH_BBART — so the KPIs stay geometry-backed and run
      // through the same classify/aggregate path as AV. Marked lc_source=BAFU +
      // lc_synthetic so it is never mistaken for authoritative cadastral land cover.
      // Not after a failed request: then AV is not absent but unknown, and the same
      // parcel would get BAFU-derived numbers on one run and AV numbers on the next.
      const avClassified = agg.sia416_ggf_m2 + agg.sia416_buf_m2 + agg.sia416_uuf_m2;
      if (options.synthLandcover !== false && !lcFailed && parcelArea > 0 && avClassified < parcelArea * MIN_AV_COVER_FRAC) {
        const bafu = await getBafu();
        if (bafu && bafu.clip.results.length) {
          const synth = [];
          for (const piece of bafu.clip.results) {
            const art = typochToBBArt(piece.art); // piece.art holds the TypoCH label
            if (art) synth.push(makeSynthLandcoverRow(id, egrid, art, piece.art, piece._rawArea, piece._geometry));
          }
          const synthArea = synth.reduce((s, r) => s + r._rawArea, 0);
          if (synth.length && synthArea > avClassified) { // only adopt if it fills more than the sparse AV
            clipped = synth;
            agg = aggregateLandCover(clipped);
            lcSource = "BAFU";
            lcSynthetic = true;
          }
        }
      }

      // Genuine errors (status stays "found"; QA notes like merged/truncated/
      // skipped remain in the check_* columns).
      const lcErrors = [];
      if (lcFailed) {
        lcErrors.push(ERR_MSG.wfsUnavailable);
        agg = emptyLandCoverAggregate();
        lcSource = "";
      }

      const merged = parcelResult.properties.mergedCount > 1;
      const parcel = {
        id,
        egrid,
        nummer: parcelResult.properties.number || "",
        // BFS municipality number: carried by the AV land-cover surfaces (the find
        // service has none) — the number covering the largest share of the parcel.
        bfsnr: dominantBfsnr(avRows),
        nbident: parcelResult.properties.nbident || "",
        status: "found",
        check_egrid: merged ? STATUS.MERGED : STATUS.FOUND,
        check_wfs: lcFailed ? "wfs_error" : (lcResult.truncated ? "truncated" : "ok"),
        check_geom: skipped > 0 ? `${skipped}_skipped` : "ok",
        errors: lcErrors,
        lc_source: lcSource,
        lc_synthetic: lcSynthetic ? "yes" : "",
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
      // Failures are non-fatal.
      let bauzonenRows = [];
      let habitatRows = [];

      if (options.bauzonen && parcelGeom) {
        try {
          const bz = await fetchBauzonen(parcelGeom);
          const clip = clipBauzonen(parcelGeom, bz.features, id, egrid);
          bauzonenRows = clip.results;
          // Building zones aren't wall-to-wall, so the parcel area no zone covers is
          // genuinely zone-free — emit it as an explicit "Ohne Bauzone" polygon so the
          // zones sum to the full parcel area. Area is exact (parcel − covered); the
          // geometry is best-effort (null on complex parcels — see ohneBauzoneGeometry).
          const covered = bauzonenRows.reduce((s, r) => s + r._rawArea, 0);
          const gap = parcelArea - covered;
          if (gap > OHNE_BAUZONE_MIN_AREA) {
            bauzonenRows.push(makeBauzoneRow(id, egrid, "Ohne Bauzone", "", "", gap, ohneBauzoneGeometry(parcelGeom, bauzonenRows)));
          }
          const bzAgg = aggregateBauzonen(bauzonenRows);
          parcel.bauzonen = bzAgg.bauzonen;
          parcel.bauzonen_m2 = bzAgg.bauzonen_m2;
          // ok | truncated / partial — a capped or dropped zone may be hiding inside
          // "Ohne Bauzone", so the computed zone-free area can't be fully trusted.
          parcel.check_bauzonen = bz.truncated ? "truncated"
            : (bz.dropped.length > 0 || clip.skipped > 0) ? "partial"
            : "ok";
          // One column per zone type (m²) — e.g. bauzonen_wohnzonen_m2. Made
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
          const bafu = await getBafu();
          if (!bafu) throw new Error("BAFU unavailable");
          const clip = bafu.clip;
          habitatRows = clip.results;
          // BAFU Lebensraumkarte is wall-to-wall, but geo.admin.ch returns `null`
          // geometry for oversized features (e.g. city-scale "Asphalt- und
          // Betonstrasse"), which then can't be clipped. The parcel area the returned
          // features leave uncovered is exactly that dropped feature's share — so when
          // exactly one feature was dropped and the data is trustworthy (complete +
          // no clip failures), attribute the whole gap to its type. Exact for area;
          // it has no geometry, so it can't be drawn on the map.
          const covered = habitatRows.reduce((s, r) => s + r._rawArea, 0);
          const gap = parcelArea - covered;
          const significantGap = gap > parcelArea * HABITAT_GAP_MIN_FRAC;
          const trustworthy = !bafu.truncated && clip.skipped === 0;
          let gapFilled = false;
          if (trustworthy && bafu.dropped.length === 1 && significantGap) {
            const typoch = bafu.dropped[0].properties?.typoch_de || "";
            if (typoch) {
              habitatRows.push(makeHabitatRow(id, egrid, typoch, "", bafu.dropped[0].id, gap, null));
              gapFilled = true;
            }
          }
          const hbAgg = aggregateHabitat(habitatRows);
          parcel.habitat = hbAgg.habitat;
          parcel.habitat_m2 = hbAgg.habitat_m2;
          // ok | estimated (a dropped feature was gap-filled) | partial (dropped
          // feature(s) we couldn't safely attribute) | truncated | error.
          parcel.check_habitat = bafu.error ? "error"
            : bafu.truncated ? "truncated"
            : gapFilled ? "estimated"
            : (bafu.dropped.length > 0 && significantGap) ? "partial"
            : "ok";
          // One column per TypoCH code at level 1 and level 2 (habitat_l1_<code>_m2 /
          // habitat_l2_<code>_m2). Made rectangular across all parcels in the flatten pass.
          for (const [code, area] of Object.entries(hbAgg.typesL1)) parcel[habitatAreaKeyL1(code)] = area;
          for (const [code, area] of Object.entries(hbAgg.typesL2)) parcel[habitatAreaKeyL2(code)] = area;
        } catch (err) {
          console.warn(`Habitat analysis failed for ${egrid}:`, err.message);
          parcel.habitat = "";
          parcel.habitat_m2 = "";
          parcel.check_habitat = "error";
        }
      }

      parcel._bauzonen = bauzonenRows;
      parcel._habitat = habitatRows;

      // Stopped while this parcel was in flight: its remaining requests were rejected
      // ("Cancelled"), which would otherwise be recorded as service failures. Drop it,
      // like the rows the run never reached.
      if (stopped()) return null;
      return { parcel, landcover: clipped, bauzonen: bauzonenRows, habitat: habitatRows };
    } catch (err) {
      if (stopped()) return null;
      console.error(`Error processing ${egrid}:`, err);
      return {
        parcel: makeErrorParcel(id, egrid, row, `error:${err.message}`),
        landcover: [],
      };
    }
  };

  const reported = new Set();
  const report = (index) => {
    reported.add(index);
    completed++;
    if (isFound(results[index].parcel.check_egrid)) succeeded++;
    reportProgress(results[index].parcel);
  };

  // First pass over every row, then up to RETRY_ROUNDS passes over the parcels with
  // a failed query — each with bounded concurrency. A parcel that will be asked
  // again is not reported yet.
  let pending = rows.map((_, i) => i);
  for (let attempt = 0; attempt <= RETRY_ROUNDS; attempt++) {
    const last = attempt === RETRY_ROUNDS;
    const queue = [...pending];
    const runNext = async () => {
      while (queue.length > 0 && !stopped()) {
        const index = queue.shift();
        const result = await processOne(rows[index]);
        if (!result) continue; // stopped
        result.parcel._egridCount = egridCounts.get(result.parcel.egrid) || 1;
        results[index] = betterResult(results[index], result);
        if (last || !needsRetry(results[index])) report(index);
      }
    };
    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY, queue.length); i++) workers.push(runNext());
    await Promise.all(workers);

    pending = pending.filter((i) => results[i] && needsRetry(results[i]));
    if (stopped() || pending.length === 0 || last) break;
    console.warn(`${pending.length} parcel(s) with a failed query — retry ${attempt + 1}/${RETRY_ROUNDS} in ${retryPauseMs / 1000} s`);
    reportProgress(null, pending.length);
    await pause(retryPauseMs, stopped);
    if (stopped()) break;
  }
  // Held back for a retry that did not happen (stopped).
  for (let i = 0; i < total; i++) if (results[i] && !reported.has(i)) report(i);
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
    // When an overlay ran, every parcel (incl. error rows) carries the joined columns
    // and every per-zone / per-habitat column, so the export header is uniform. A
    // column the parcel has no area in is 0 when its overlay answered and empty when
    // it did not (error rows, a failed request): empty = not known, 0 = nothing there.
    if (options.bauzonen) {
      if (!("bauzonen" in r.parcel)) r.parcel.bauzonen = "";
      if (!("bauzonen_m2" in r.parcel)) r.parcel.bauzonen_m2 = "";
      if (!("check_bauzonen" in r.parcel)) r.parcel.check_bauzonen = "";
      const fill = overlayFill(r.parcel, "check_bauzonen");
      for (const k of zoneKeys) if (!(k in r.parcel)) r.parcel[k] = fill;
    }
    if (options.habitat) {
      if (!("habitat" in r.parcel)) r.parcel.habitat = "";
      if (!("habitat_m2" in r.parcel)) r.parcel.habitat_m2 = "";
      if (!("check_habitat" in r.parcel)) r.parcel.check_habitat = "";
      const fill = overlayFill(r.parcel, "check_habitat");
      for (const k of habitatKeys) if (!(k in r.parcel)) r.parcel[k] = fill;
    }
    // One column, on every parcel (incl. error rows, which can still match by SAP id).
    if (options.greeninv) r.parcel.greeninv = greenInventoryFlag(greenIndex, r.parcel.id, r.parcel.egrid);
    parcels.push(r.parcel);
    landcover.push(...r.landcover);
    if (r.bauzonen) bauzonen.push(...r.bauzonen);
    if (r.habitat) habitat.push(...r.habitat);
  }

  return { parcels, landcover, bauzonen, habitat, greeninvFailed: !!(options.greeninv && !greenIndex), cancelled: stopped() };
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
    nbident: "",
    status: "not_found",
    check_egrid: message,
    check_wfs: "",
    check_geom: "",
    errors: [egridErrorMessage(message)],
    lc_source: "",
    lc_synthetic: "",
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

/* ── Clipping ── */

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

/* ── Row builders (one per output layer; mirrored by processor_web.py) ── */

/** VBS classification codes → the stable English output labels (blank Typ when none). */
function vbsLabels(cls) {
  return {
    av_kategorie: VBS_KATEGORIE_LABELS[cls.vbsKategorie] || "",
    av_produktiv: VBS_PRODUKTIV_LABELS[cls.vbsProduktiv] || "",
    av_typ: cls.vbsTyp ? (VBS_TYP_LABELS[cls.vbsTyp] || "") : "",
  };
}

/** BBArt values outside the known domain are classified with the fallbacks
 *  (UUF / UF / not green / kat_d / unproduktiv) — warn once per value per session
 *  so a data-model change (e.g. the DMAV migration) is noticed, not silently absorbed. */
const warnedArts = new Set();
function warnUnknownArt(art) {
  if (Object.prototype.hasOwnProperty.call(SIA416, art) || warnedArts.has(art)) return;
  warnedArts.add(art);
  console.warn(`Unknown land-cover Art "${art}" — classified with the fallback categories`);
}

/** Build one land-cover detail row — an AV clip (lcSource "AV") or a synthetic
 *  piece derived from BAFU (lcSource "BAFU", `typoch` keeps the source habitat label
 *  for traceability). Same shape either way so aggregateLandCover treats them alike. */
export function makeLandcoverRow(id, egrid, art, { fid = "", bfsnr = "", gwrEgid = "", lcSource = "AV", prob = "", typoch } = {}, area, geometry) {
  warnUnknownArt(art);
  const cls = classify(art);
  const row = { id, egrid, fid, art };
  if (typoch !== undefined) row.typoch = typoch; // provenance of a synthetic row (GeoJSON only; not a CSV/XLSX header)
  Object.assign(row, {
    bfsnr,
    gwr_egid: gwrEgid,
    check_greenspace: cls.greenSpace,
    // VBS classification — stable English output values (translated for display).
    // Typ is only assigned within biologically productive area; blank otherwise.
    ...vbsLabels(cls),
    lc_source: lcSource,
    prob,
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
  return row;
}

/** Build one SYNTHETIC AV land-cover row from a BAFU habitat piece: `art` is the
 *  inferred BBArt, geometry the real (clipped) habitat polygon. */
function makeSynthLandcoverRow(id, egrid, art, typoch, area, geometry) {
  return makeLandcoverRow(id, egrid, art, { lcSource: "BAFU", typoch }, area, geometry);
}

/** Build one Bauzonen detail row. Shared by the clip and the "Ohne Bauzone"
 *  remainder (which passes name "Ohne Bauzone", no code, and a best-effort geometry).
 *  `art` holds the zone name (the generic "type" field shared by all overlay layers,
 *  so the map/table/summary treat it uniformly). */
export function makeBauzoneRow(id, egrid, name, code, fid, area, geometry) {
  return {
    id, egrid, fid,
    art: name,
    bauzone_code: code,
    lc_source: "Bauzonen",
    area_m2: round2(area),
    _rawArea: area,
    _geometry: geometry,
  };
}

/** Build one BAFU habitat detail row. `art` holds the TypoCH label; SIA 416 / DIN 277
 *  / sealed are `null` (a modeled habitat map can't supply them). Shared by the clip
 *  and the gap-fill — the gap-fill passes `geometry: null` (the dropped feature whose
 *  geometry the Identify endpoint won't serve), so the row carries area but can't be drawn. */
export function makeHabitatRow(id, egrid, typoch, prob, fid, area, geometry) {
  const cls = classifyBafu(typoch);
  return {
    id,
    egrid,
    fid,
    art: typoch, // TypoCH habitat label as served, deepest level, e.g. "6.3.1 Buchenwald"
    // Full TypoCH hierarchy split into its three levels ("<code> <name>"); typoch_l3 is
    // "" where the layer only resolved the feature to level-2. Names come from the shared
    // data/typoch.json reference (loaded by ensureTypoch()).
    typoch_l1: typochL1Label(typoch),
    typoch_l2: typochL2Label(typoch),
    typoch_l3: typochL3Label(typoch),
    bfsnr: "",
    gwr_egid: "",
    check_greenspace: cls.greenSpace,
    ...vbsLabels(cls),
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
    results.push(makeLandcoverRow(id, egrid, art, { fid, bfsnr, gwrEgid }, area, geometry));
  });
  return { results, skipped };
}

/** Clip BAFU habitat features to a parcel and classify via TypoCH. */
function clipHabitat(parcelGeom, bafuFeatures, id, egrid) {
  const results = [];
  const skipped = clipFeatures(parcelGeom, bafuFeatures, (lc, geometry, area) => {
    results.push(makeHabitatRow(id, egrid, lc.properties?.typoch_de || "", lc.properties?.prob_de || "", lc.id || lc.properties?.polyid || "", area, geometry));
  });
  return { results, skipped };
}

/** Clip Bauzonen (building zones) to a parcel — one detail row per clipped piece. */
function clipBauzonen(parcelGeom, features, id, egrid) {
  const results = [];
  const skipped = clipFeatures(parcelGeom, features, (bz, geometry, area) => {
    const name = bz.properties?.ch_bez_d || bz.properties?.bz_bezeichnung || "?";
    const code = bz.properties?.ch_code_hn || bz.properties?.bz_nutzung || "";
    const fid = bz.id || bz.properties?.fid || "";
    results.push(makeBauzoneRow(id, egrid, name, code, fid, area, geometry));
  });
  return { results, skipped };
}

/** Best-effort geometry for the zone-free remainder: parcel minus the union of the
 *  clipped zones. Returns the whole parcel when no zone touches it, and null when
 *  turf.union/difference throws on a complex parcel — the caller keeps the exact area. */
function ohneBauzoneGeometry(parcelGeom, zoneRows) {
  if (zoneRows.length === 0) return parcelGeom;
  try {
    const feats = zoneRows.map((r) => turf.feature(r._geometry));
    const union = feats.length === 1 ? feats[0] : turf.union(turf.featureCollection(feats));
    const diff = union && turf.difference(turf.featureCollection([turf.feature(parcelGeom), union]));
    return diff ? diff.geometry : null;
  } catch {
    return null;
  }
}

/* ── Aggregation ── */

/** BFS municipality number of a parcel from its AV land-cover pieces: the `bfsnr`
 *  value whose pieces cover the largest area (ties → the smaller value), keeping the
 *  value as served (number or string). "" when no piece carries one. */
export function dominantBfsnr(rows) {
  const area = new Map(), value = new Map(); // key → summed area / original value
  for (const r of rows) {
    const key = String(r.bfsnr ?? "").trim();
    if (!key) continue;
    if (!area.has(key)) value.set(key, r.bfsnr);
    area.set(key, (area.get(key) || 0) + r._rawArea);
  }
  let best = "", bestArea = -1;
  for (const [key, a] of area) {
    if (a > bestArea || (a === bestArea && key < best)) { best = key; bestArea = a; }
  }
  return best ? value.get(best) : "";
}

/** Aggregate Bauzonen detail rows into the parcel columns: semicolon-joined
 *  `bauzonen` (names) + `bauzonen_m2` (areas) + a `zones` map, largest first —
 *  mirrors the Python `--bauzonen` output. */
export function aggregateBauzonen(rows) {
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

/** Aggregate BAFU habitat detail rows into parcel columns, by TypoCH **code** at
 *  level 1 and level 2 (level-2 falls back to the level-1 code for features BAFU only
 *  classified to level 1). Returns the readable level-2 label summary
 *  (`habitat` / `habitat_m2`, largest first) plus `typesL1` / `typesL2` (code → area)
 *  that become `habitat_l1_<code>_m2` / `habitat_l2_<code>_m2` columns. */
export function aggregateHabitat(rows) {
  const byL1 = new Map(), byL2 = new Map(), l2Label = new Map(); // code → area; l2 code → label
  for (const r of rows) {
    const area = r._rawArea ?? r.area_m2;
    const c1 = typochCodeAtLevel(r.art, 1);
    const c2 = typochCodeAtLevel(r.art, 2) || c1; // level-1-only features fall back to their L1 code
    if (c1) byL1.set(c1, (byL1.get(c1) || 0) + area);
    if (c2) {
      byL2.set(c2, (byL2.get(c2) || 0) + area);
      if (!l2Label.has(c2)) l2Label.set(c2, r.typoch_l2 || typochL2Label(r.art) || typochL1Label(r.art));
    }
  }
  if (byL2.size === 0) return { habitat: "", habitat_m2: "", typesL1: {}, typesL2: {} };
  const sortedL2 = [...byL2.entries()].sort((a, b) => b[1] - a[1]);
  const typesL1 = {}, typesL2 = {};
  for (const [c, a] of byL1) typesL1[c] = round2(a);
  for (const [c, a] of sortedL2) typesL2[c] = round2(a);
  return {
    habitat: sortedL2.map(([c]) => l2Label.get(c)).join("; "),
    habitat_m2: sortedL2.map(([, a]) => a.toFixed(1)).join("; "),
    typesL1,
    typesL2,
  };
}

/** The aggregation columns of a parcel whose land-cover request failed: present
 *  (uniform export header) but empty — the areas are unknown, not 0. */
export function emptyLandCoverAggregate() {
  return Object.fromEntries(LANDCOVER_AGG_KEYS.map((k) => [k, ""]));
}

/** Aggregate clipped land cover into summary columns */
export function aggregateLandCover(clippedFeatures) {
  // Aggregation columns — all lowercase, namespaced by classification scheme
  // (sia416_/din277_/av_) or imperviousness/green. Raw per-Art areas are added
  // below as av_<art>_m2 (source = AV land cover).
  const agg = Object.fromEntries(LANDCOVER_AGG_KEYS.map((k) => [k, 0]));

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
    if (f._vbsProduktiv === "produktiv") agg.av_produktiv_m2 += area;
    else agg.av_unproduktiv_m2 += area;

    // VBS Kategorie (a–d); unknown falls back to kat_d
    const kat = f._vbsKategorie || "kat_d";
    if (kat === "kat_a") agg.av_kat_a_m2 += area;
    else if (kat === "kat_b") agg.av_kat_b_m2 += area;
    else if (kat === "kat_c") agg.av_kat_c_m2 += area;
    else agg.av_kat_d_m2 += area;

    // VBS Typ — biologically productive only (unproductive contributes to neither)
    if (f._vbsTyp === "typ1") agg.av_typ1_m2 += area;
    else if (f._vbsTyp === "typ2") agg.av_typ2_m2 += area;
  }

  for (const k of Object.keys(agg)) agg[k] = round2(agg[k]);
  for (const k of Object.keys(artAreas)) artAreas[k] = round2(artAreas[k]);

  return { ...agg, ...artAreas };
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}
