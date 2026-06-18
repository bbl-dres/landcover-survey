/**
 * Single-parcel picker for the upload view.
 *
 * A lightweight MapLibre map showing the swisstopo cadastral overlay (rendered as
 * WMS GetMap, matching swisstopo.js — the layer is WMS, not WMTS) plus a search
 * box. Clicking a parcel — or selecting a search result — resolves its EGRID via
 * the geo.admin.ch Identify endpoint, then hands a one-row dataset to the same
 * `processRows()` pipeline used by the CSV batch upload.
 *
 * Deliberately self-contained: it does NOT reuse map.js / swisstopo.js, which are
 * wired to the single results map through a shared global `mapRef`. Driving a
 * second map through that global would corrupt the results view's layer state.
 */
import { API, MAP_STYLES, MAP_DEFAULT, esc, fetchWithTimeout, BRAND } from "./config.js";
import { showToast } from "./toast.js";
import { t, getLang } from "./i18n.js";
import { poleOfInaccessibility } from "./polylabel.js";

const CADASTRAL_LAYER = "ch.kantone.cadastralwebmap-farbe";
/** WMS GetMap tile template — {bbox-epsg-3857} is filled in by MapLibre. */
const CADASTRAL_WMS =
  "https://wms.geo.admin.ch/?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap" +
  `&LAYERS=${CADASTRAL_LAYER}&CRS=EPSG:3857&BBOX={bbox-epsg-3857}` +
  "&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true";
const REQUEST_TIMEOUT = 8000;
/** Looks like a Swiss EGRID (CH + ≥9 digits) → direct find by egris_egrid. */
const EGRID_RE = /^CH\d{9,}$/i;
/** "Zoom to parcel" target — building-level detail with surrounding context.
 *  Used as the max zoom so small urban parcels don't zoom in too close. */
const BUILDING_ZOOM = 17;
/** Parcel pre-selected on the landing — Fellerstrasse 21, 3027 Bern (the federal
 *  office). Gives the user a real, recognizable parcel to start from instead of
 *  an empty country-level map where nothing is clickable. */
const DEFAULT_EGRID = "CH373589574684";

let map = null;
let marker = null;       // single reusable selection pin
let resizeObserver = null;
let onAnalyze = null;    // callback(parsedData) — same shape as upload.js onReady
let getOptions = null;   // () => { bauzonen, habitat }
let selected = null;     // { id, egrid, nummer, geometry }
let inited = false;
let searchDebounce = null;
let searchToken = 0;     // guards against out-of-order async search responses
let lookupPending = false; // a parcel lookup (identify/find) is in flight
let defaultParcel = null;  // cached default parcel, so resets don't re-fetch

const fetchT = (url) => fetchWithTimeout(url, { timeoutMs: REQUEST_TIMEOUT });
const emptyFC = () => ({ type: "FeatureCollection", features: [] });

/** Wire the search + chip + analyse button and lazily build the map. Idempotent —
 *  safe to call again; only the first call does the work. */
export function initParcelPicker({ onAnalyze: analyzeCb, getOptions: optsFn }) {
  onAnalyze = analyzeCb;
  getOptions = optsFn;
  if (inited) return;
  inited = true;
  wireSearch();
  wireSelectionControls();
  createMap();
}

/** Clear the current selection + search field (e.g. on "Neue Analyse"). */
export function resetParcelPicker() {
  clearSelection();
  const input = document.getElementById("parcel-search-input");
  if (input) input.value = "";
  const clear = document.getElementById("parcel-search-clear");
  if (clear) clear.hidden = true;
  hideResults();
  // Restore the default landing parcel so "Neue Analyse" returns to a clean,
  // recognizable starting point — not wherever the last analysis left the map.
  selectDefaultParcel();
}

/* ── Map ── */

function createMap() {
  const container = document.getElementById("single-map");
  if (!container || map) return;

  map = new maplibregl.Map({
    container,
    style: MAP_STYLES.positron.url,
    center: MAP_DEFAULT.center,
    zoom: MAP_DEFAULT.zoom,
    attributionControl: false,
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");

  // The container is only laid out once the single-parcel tab is shown, so the
  // map can capture a zero size at creation — a ResizeObserver self-corrects it.
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => map && map.resize());
    resizeObserver.observe(container);
  }

  map.on("load", () => {
    map.addSource("cadastral", {
      type: "raster", tiles: [CADASTRAL_WMS], tileSize: 256,
      attribution: '&copy; <a href="https://www.swisstopo.admin.ch">swisstopo</a>',
    });
    map.addLayer({ id: "cadastral", type: "raster", source: "cadastral", paint: { "raster-opacity": 0.85 } });

    map.addSource("pick-highlight", { type: "geojson", data: emptyFC() });
    map.addLayer({ id: "pick-fill", type: "fill", source: "pick-highlight", paint: { "fill-color": BRAND.red, "fill-opacity": 0.2 } });
    map.addLayer({ id: "pick-line", type: "line", source: "pick-highlight", paint: { "line-color": BRAND.red, "line-width": 2.5 } });

    map.resize();
    selectDefaultParcel(); // open on a real, ready-to-analyse example parcel
  });

  map.on("click", (e) => onMapClick(e.lngLat));
}

/** Pre-select the default landing parcel (cached after the first fetch so resets
 *  are instant). select() clears any prior selection as it sets the new one. */
async function selectDefaultParcel() {
  try {
    if (!defaultParcel) defaultParcel = await findByEgrid(DEFAULT_EGRID);
    if (defaultParcel) select(defaultParcel, { fly: true });
  } catch (err) {
    console.warn("Default parcel load failed:", err.message);
  }
}

/** Run a parcel lookup with shared feedback: a progress cursor, a "searching…"
 *  toast only if it's slow enough to notice, and a guard that ignores further
 *  clicks while one is in flight (so an unacknowledged click isn't repeated). */
async function withLookup(fn) {
  if (lookupPending) return;
  lookupPending = true;
  if (map) map.getCanvas().style.cursor = "progress";
  let toast = null;
  const slow = setTimeout(() => { toast = showToast(t("upload.single.searching"), { duration: 10000 }); }, 400);
  try {
    await fn();
  } finally {
    clearTimeout(slow);
    toast?.remove();
    lookupPending = false;
    if (map) map.getCanvas().style.cursor = "";
  }
}

function onMapClick(lngLat) {
  if (!map) return;
  withLookup(async () => {
    const b = map.getBounds();
    const c = map.getCanvas();
    try {
      const hit = await identifyParcel(
        lngLat.lng, lngLat.lat,
        `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`,
        `${c.width},${c.height},96`
      );
      if (!hit) { showToast(t("upload.single.notfound")); return; }
      select(hit, { fly: false });
    } catch (err) {
      console.warn("Parcel identify failed:", err.message);
      showToast(t("upload.single.lookupError"));
    }
  });
}

/* ── geo.admin.ch lookups ── */

/** Identify the cadastral parcel at a point. `mapExtent`/`imageDisplay` set the
 *  pixel→ground scale for the 5px tolerance; pass the live map view for a click,
 *  or a small synthetic box around a searched coordinate. Returns the parcel or
 *  null when no parcel is hit. May throw on network/HTTP error. */
async function identifyParcel(lng, lat, mapExtent, imageDisplay) {
  const params = new URLSearchParams({
    geometry: `${lng},${lat}`,
    geometryType: "esriGeometryPoint",
    geometryFormat: "geojson",
    layers: `all:${CADASTRAL_LAYER}`,
    sr: "4326",
    tolerance: "5",
    mapExtent,
    imageDisplay,
    returnGeometry: "true",
    lang: getLang(),
  });
  const resp = await fetchT(`${API.IDENTIFY}?${params}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  const r = (data.results || []).find((x) => (x.properties || x.attributes || {}).egris_egrid);
  if (!r) return null;
  const p = r.properties || r.attributes || {};
  return { egrid: p.egris_egrid, nummer: p.number || "", geometry: r.geometry || null };
}

/** Resolve a parcel directly by EGRID via the find endpoint. Returns the parcel
 *  or null. May throw. */
async function findByEgrid(egrid) {
  const params = new URLSearchParams({
    layer: CADASTRAL_LAYER,
    searchText: egrid,
    searchField: "egris_egrid",
    returnGeometry: "true",
    geometryFormat: "geojson",
    sr: "4326",
  });
  const resp = await fetchT(`${API.PARCEL_FIND}?${params}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  const feat = (data.results || []).find((r) => r.geometry);
  if (!feat) return null;
  const p = feat.properties || feat.attributes || {};
  return { egrid: egrid.toUpperCase(), nummer: p.number || "", geometry: feat.geometry };
}

/** swisstopo location search (addresses, places, parcels). */
async function searchLocations(query) {
  const params = new URLSearchParams({ searchText: query, type: "locations", sr: "4326", limit: "6" });
  const resp = await fetchT(`${API.SEARCH}?${params}`);
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data.results || []).map((r) => {
    const a = r.attrs || {};
    return {
      label: (a.label || "").replace(/<[^>]*>/g, ""),
      origin: a.origin || "",
      lat: a.lat,
      lng: a.lon,
      bbox: a.geom_st_box2d ? parseBBox(a.geom_st_box2d) : null,
    };
  });
}

function parseBBox(box2d) {
  // "BOX(5.95 45.82,10.49 47.81)" → [5.95, 45.82, 10.49, 47.81]
  const m = box2d.match(/BOX\(([^ ]+) ([^,]+),([^ ]+) ([^)]+)\)/);
  return m ? [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])] : null;
}

/* ── Selection ── */

function select({ egrid, nummer, geometry }, { fly = true } = {}) {
  selected = { id: nummer || egrid, egrid, nummer, geometry };

  if (map && map.getSource("pick-highlight")) {
    map.getSource("pick-highlight").setData(geometry ? { type: "Feature", geometry, properties: {} } : emptyFC());
  }
  // Pin the parcel's visual centre, then centre the camera on that same point so
  // the marker sits in the middle of the view (a bbox fit would centre on the
  // bbox instead, leaving the pin off to one side).
  const pt = geometry ? markerPointOf(geometry) : null;
  if (pt) placeMarker(pt[0], pt[1]); else removeMarker();
  if (fly && geometry && map && pt) zoomToParcel(geometry, pt);

  const chip = document.getElementById("parcel-chip");
  const txt = document.getElementById("parcel-chip-text");
  if (txt) txt.textContent = nummer ? `${t("col.nummer")} ${nummer} · ${egrid}` : egrid;
  if (chip) chip.hidden = false;

  const btn = document.getElementById("single-analyze-btn");
  if (btn) btn.disabled = false;
}

function clearSelection() {
  selected = null;
  if (map && map.getSource("pick-highlight")) map.getSource("pick-highlight").setData(emptyFC());
  removeMarker();
  const chip = document.getElementById("parcel-chip");
  if (chip) chip.hidden = true;
  const btn = document.getElementById("single-analyze-btn");
  if (btn) btn.disabled = true;
}

/** The parcel's visual centre (pole of inaccessibility) — the spot to pin and
 *  centre on. Uses the largest part of a MultiPolygon; falls back to centroid. */
function markerPointOf(geometry) {
  const feat = { type: "Feature", geometry, properties: {} };
  try {
    if (geometry.type === "Polygon") {
      return poleOfInaccessibility(geometry.coordinates) || turf.centroid(feat).geometry.coordinates;
    }
    if (geometry.type === "MultiPolygon") {
      let best = null, bestArea = -Infinity;
      for (const poly of geometry.coordinates) {
        const a = turf.area({ type: "Polygon", coordinates: poly });
        if (a > bestArea) { bestArea = a; best = poly; }
      }
      if (best) return poleOfInaccessibility(best) || turf.centroid(feat).geometry.coordinates;
    }
  } catch (err) { console.warn("marker point fallback:", err.message); }
  try { return turf.centroid(feat).geometry.coordinates; } catch { return null; }
}

/** Ease the camera to `center` at a zoom that fits the whole parcel but never
 *  closer than building level. cameraForBounds gives the fit zoom; we keep that
 *  zoom yet recentre on the marker so the pin stays in the middle of the view. */
function zoomToParcel(geometry, center) {
  // If the map isn't laid out yet (e.g. a reset while the upload view is hidden),
  // cameraForBounds can't compute a fit — jump to a fixed building zoom instead;
  // it renders correctly once the container is shown and the ResizeObserver fires.
  if (!map.getCanvas().width) {
    map.jumpTo({ center, zoom: BUILDING_ZOOM });
    return;
  }
  try {
    const bb = turf.bbox(geometry);
    const cam = map.cameraForBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 60, maxZoom: BUILDING_ZOOM });
    map.easeTo({ center, zoom: cam ? cam.zoom : BUILDING_ZOOM, duration: 600 });
  } catch (err) {
    console.warn("zoom-to-parcel failed:", err.message);
    map.easeTo({ center, zoom: BUILDING_ZOOM, duration: 600 });
  }
}

/** Drop (or move) the single reusable selection pin. */
function placeMarker(lng, lat) {
  if (!map || lng == null || lat == null) return;
  if (!marker) marker = new maplibregl.Marker({ color: BRAND.red });
  marker.setLngLat([lng, lat]).addTo(map);
}

function removeMarker() {
  if (marker) marker.remove();
}

function wireSelectionControls() {
  document.getElementById("parcel-chip-clear")?.addEventListener("click", clearSelection);
  document.getElementById("single-analyze-btn")?.addEventListener("click", () => {
    if (!selected || !onAnalyze) return;
    const options = getOptions ? getOptions() : { bauzonen: true, habitat: true };
    onAnalyze({
      headers: ["id", "egrid"],
      rows: [{ id: selected.id, egrid: selected.egrid }],
      filename: selected.nummer ? `${t("col.nummer")} ${selected.nummer}` : selected.egrid,
      options,
    });
  });
}

/* ── Search box ── */

function wireSearch() {
  const input = document.getElementById("parcel-search-input");
  const clear = document.getElementById("parcel-search-clear");
  const box = document.getElementById("parcel-search-results");
  if (!input) return;

  input.addEventListener("input", () => {
    if (clear) clear.hidden = !input.value;
    clearTimeout(searchDebounce);
    const q = input.value.trim();
    if (q.length < 2) { hideResults(); return; }
    searchDebounce = setTimeout(() => performSearch(q), 300);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { hideResults(); input.blur(); return; }
    if (e.key === "Enter") {
      const first = box?.querySelector(".parcel-search-item");
      if (first) { e.preventDefault(); first.click(); }
    }
  });

  clear?.addEventListener("click", () => {
    input.value = "";
    clear.hidden = true;
    hideResults();
    input.focus();
  });

  // Close the dropdown when clicking outside the search box.
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".parcel-search")) hideResults();
  });
}

async function performSearch(query) {
  const token = ++searchToken;
  const items = [];
  const clean = query.replace(/\s+/g, "");

  if (EGRID_RE.test(clean)) {
    try {
      const hit = await findByEgrid(clean);
      if (token !== searchToken) return; // a newer query superseded this one
      if (hit) items.push({ kind: "egrid", ...hit });
    } catch (err) { console.warn("EGRID find failed:", err.message); }
  }

  let locs = [];
  try { locs = await searchLocations(query); } catch (err) { console.warn("Location search failed:", err.message); }
  if (token !== searchToken) return;
  for (const l of locs) items.push({ kind: "loc", ...l });

  renderResults(items);
}

function renderResults(items) {
  const box = document.getElementById("parcel-search-results");
  if (!box) return;
  box.innerHTML = "";

  if (!items.length) {
    box.innerHTML = `<div class="parcel-search-empty">${esc(t("search.empty"))}</div>`;
    box.hidden = false;
    return;
  }

  for (const it of items) {
    const el = document.createElement("div");
    el.className = "parcel-search-item";
    el.setAttribute("role", "option");
    if (it.kind === "egrid") {
      el.innerHTML = `<span class="material-symbols-outlined">location_on</span>
        <div><div class="psi-title">${esc(it.egrid)}</div>
        <div class="psi-sub">${it.nummer ? esc(t("col.nummer")) + " " + esc(it.nummer) : ""}</div></div>`;
      el.addEventListener("click", () => {
        select({ egrid: it.egrid, nummer: it.nummer, geometry: it.geometry }, { fly: true });
        closeResultsWith(it.egrid);
      });
    } else {
      const icon = it.origin === "parcel" ? "location_on" : "map";
      el.innerHTML = `<span class="material-symbols-outlined">${icon}</span>
        <div><div class="psi-title">${esc(it.label)}</div>
        <div class="psi-sub">${esc(it.origin || "")}</div></div>`;
      el.addEventListener("click", () => {
        pickLocation(it);
        closeResultsWith(it.label);
      });
    }
    box.appendChild(el);
  }
  box.hidden = false;
}

/** Fly to a searched location and try to auto-select the parcel under it. */
async function pickLocation(loc) {
  if (map) {
    if (loc.bbox) map.fitBounds([[loc.bbox[0], loc.bbox[1]], [loc.bbox[2], loc.bbox[3]]], { padding: 40, maxZoom: BUILDING_ZOOM, duration: 600 });
    else if (loc.lat != null && loc.lng != null) map.flyTo({ center: [loc.lng, loc.lat], zoom: BUILDING_ZOOM, duration: 600 });
  }
  if (loc.lat == null || loc.lng == null) return;

  // Drop a pin at the searched spot straight away so the choice is obvious; if a
  // parcel is identified below, select() moves the pin onto the parcel.
  placeMarker(loc.lng, loc.lat);

  // Identify against a small synthetic box around the point (independent of the
  // in-flight map animation) so a precise address/parcel result auto-selects.
  const d = 0.0006;
  await withLookup(async () => {
    try {
      const hit = await identifyParcel(
        loc.lng, loc.lat,
        `${loc.lng - d},${loc.lat - d},${loc.lng + d},${loc.lat + d}`,
        "256,256,96"
      );
      if (hit) select(hit, { fly: true }); // recentre on the parcel's pin
      else showToast(t("upload.single.notfound"));
    } catch (err) {
      // Non-fatal: the map is already centred, so the user can click to pick.
      console.warn("Location identify failed:", err.message);
    }
  });
}

function hideResults() {
  const box = document.getElementById("parcel-search-results");
  if (box) box.hidden = true;
  document.getElementById("parcel-search-input")?.setAttribute("aria-expanded", "false");
}

function closeResultsWith(value) {
  hideResults();
  const input = document.getElementById("parcel-search-input");
  if (input && value != null) input.value = value;
}
