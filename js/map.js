/**
 * MapLibre GL JS map with parcel polygons, land cover overlay,
 * Home/3D controls, and thumbnail basemap selector
 */
import { ART_COLORS, CATEGORY_COLORS, ART_LABELS, MAP_STYLES, MAP_DEFAULT } from "./config.js";

let map = null;
let popup = null;
let onFeatureClick = null;
let summaryToggleCallback = null;
let summaryToggleControl = null;
let currentStyle = "positron";
let is3D = false;
let searchMarker = null;

// Store current data for re-adding after basemap change
let currentParcelData = null;
let currentLandcoverData = null;

/* ── Custom Controls ── */

class HomeControl {
  onAdd() {
    this._container = document.createElement("div");
    this._container.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = "Schweiz-Übersicht";
    btn.innerHTML = '<span class="material-symbols-outlined">home</span>';
    btn.addEventListener("click", () => {
      map.flyTo({ center: MAP_DEFAULT.center, zoom: MAP_DEFAULT.zoom, pitch: 0, bearing: 0, duration: 1000 });
      if (is3D) toggle3D();
    });
    this._container.appendChild(btn);
    return this._container;
  }
  onRemove() { this._container.remove(); }
}

class Toggle3DControl {
  onAdd() {
    this._container = document.createElement("div");
    this._container.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "map-3d-btn";
    btn.title = "2D/3D umschalten";
    btn.textContent = "3D";
    btn.addEventListener("click", () => toggle3D());
    this._btn = btn;
    this._container.appendChild(btn);
    return this._container;
  }
  onRemove() { this._container.remove(); }
}

let toggle3DBtn = null;

function toggle3D() {
  is3D = !is3D;
  if (is3D) {
    map.flyTo({ pitch: 60, bearing: -20, duration: 800, center: map.getCenter(), zoom: map.getZoom() });
  } else {
    map.flyTo({ pitch: 0, bearing: 0, duration: 800, center: map.getCenter(), zoom: map.getZoom() });
  }
  if (toggle3DBtn) {
    toggle3DBtn.textContent = is3D ? "2D" : "3D";
    toggle3DBtn.classList.toggle("active", is3D);
  }
}

class SummaryToggleControl {
  onAdd() {
    this._container = document.createElement("div");
    this._container.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = "Zusammenfassung";
    btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h7v7H3z"/><path d="M14 3h7v7h-7z"/><path d="M3 14h7v7H3z"/><path d="M14 14h7v7h-7z"/></svg>`;
    btn.addEventListener("click", () => { if (summaryToggleCallback) summaryToggleCallback(); });
    this._container.appendChild(btn);
    return this._container;
  }
  onRemove() { this._container.remove(); }
  setHidden(hidden) { this._container.style.display = hidden ? "none" : "block"; }
}

/* ── Exports ── */

export function onSummaryToggle(callback) { summaryToggleCallback = callback; }
export function setSummaryToggleVisible(visible) { if (summaryToggleControl) summaryToggleControl.setHidden(!visible); }

export async function initMap(containerId, clickCallback) {
  onFeatureClick = clickCallback;

  if (map) { map.remove(); map = null; }

  const styleObj = MAP_STYLES[currentStyle];
  map = new maplibregl.Map({
    container: containerId,
    style: styleObj.url,
    center: MAP_DEFAULT.center,
    zoom: MAP_DEFAULT.zoom,
    attributionControl: false,
  });

  // Top-right: Nav → Home → 3D
  map.addControl(new maplibregl.NavigationControl(), "top-right");
  const homeCtrl = new HomeControl();
  map.addControl(homeCtrl, "top-right");
  const ctrl3d = new Toggle3DControl();
  map.addControl(ctrl3d, "top-right");
  toggle3DBtn = ctrl3d._btn;

  // Summary toggle (top-right, hidden initially)
  summaryToggleControl = new SummaryToggleControl();
  map.addControl(summaryToggleControl, "top-right");
  summaryToggleControl.setHidden(true);

  // Attribution bottom-right
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");

  // Initialize basemap selector (DOM element, not MapLibre control)
  initBasemapSelector();

  popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: "360px" });

  await new Promise((resolve) => map.on("load", resolve));

  // Click handlers
  map.on("click", "parcels-fill", (e) => {
    if (!e.features.length) return;
    const props = e.features[0].properties;
    showParcelPopup(e.lngLat, props);
    if (onFeatureClick) onFeatureClick(props.index);
  });

  map.on("click", "landcover-fill", (e) => {
    if (!e.features.length) return;
    showLandcoverPopup(e.lngLat, e.features[0].properties);
  });

  for (const layer of ["parcels-fill", "landcover-fill"]) {
    map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
  }

  // Footer coordinates on mouse move
  const coordsEl = document.getElementById("footer-coords");
  if (coordsEl) {
    map.on("mousemove", (e) => {
      const { lng, lat } = e.lngLat;
      coordsEl.textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    });
    map.on("mouseout", () => {
      coordsEl.textContent = "\u2014";
    });
  }
}

/* ── Basemap Selector ── */

let thumbnailsLoaded = false;

function initBasemapSelector() {
  const switcher = document.getElementById("style-switcher");
  if (!switcher) return;
  switcher.classList.add("visible");

  const btn = document.getElementById("style-switcher-btn");
  const panel = document.getElementById("style-panel");

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = panel.classList.contains("show");
    if (!isOpen && !thumbnailsLoaded) {
      thumbnailsLoaded = true;
      for (const [id, style] of Object.entries(MAP_STYLES)) {
        const img = document.getElementById(`thumb-${id}`);
        if (img) img.src = style.thumbnail;
      }
      document.getElementById("current-style-thumb").src = MAP_STYLES[currentStyle].thumbnail;
    }
    panel.classList.toggle("show");
  });

  document.addEventListener("click", (e) => {
    if (panel.classList.contains("show") && !e.target.closest(".style-switcher")) {
      panel.classList.remove("show");
    }
  });

  document.querySelectorAll(".style-option").forEach((optBtn) => {
    optBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const styleId = optBtn.dataset.style;
      if (styleId === currentStyle) { panel.classList.remove("show"); return; }

      currentStyle = styleId;
      localStorage.setItem("mapStyle", styleId);
      map.setStyle(MAP_STYLES[styleId].url);
      map.once("idle", () => reAddDataLayers());

      // Update active states
      document.querySelectorAll(".style-option").forEach((b) => b.classList.remove("active"));
      optBtn.classList.add("active");
      document.getElementById("current-style-thumb").src = MAP_STYLES[styleId].thumbnail;

      panel.classList.remove("show");
    });
  });
}

/* ── Data Layers ── */

function addDataLayers() {
  map.addSource("landcover", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "landcover-fill", type: "fill", source: "landcover", paint: { "fill-color": ["get", "color"], "fill-opacity": 0.5 } });
  map.addLayer({ id: "landcover-line", type: "line", source: "landcover", paint: { "line-color": ["get", "color"], "line-width": 1, "line-opacity": 0.8 } });

  map.addSource("parcels", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "parcels-fill", type: "fill", source: "parcels", paint: { "fill-color": "#1a365d", "fill-opacity": 0.08 } });
  map.addLayer({ id: "parcels-line", type: "line", source: "parcels", paint: { "line-color": "#1a365d", "line-width": 2.5 } });
  map.addLayer({
    id: "parcels-label", type: "symbol", source: "parcels",
    layout: { "text-field": ["get", "label"], "text-size": 12, "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"], "text-anchor": "center" },
    paint: { "text-color": "#1a365d", "text-halo-color": "#fff", "text-halo-width": 1.5 },
  });
}

function reAddDataLayers() {
  addDataLayers();
  if (currentParcelData) map.getSource("parcels").setData(currentParcelData);
  if (currentLandcoverData) map.getSource("landcover").setData(currentLandcoverData);
}

export function plotResults(results) {
  if (!map) return;
  if (!map.getSource("parcels")) addDataLayers();

  const parcelFeatures = [];
  const lcFeatures = [];

  results.parcels.forEach((p, i) => {
    if (!p._geometry) return;
    parcelFeatures.push({
      type: "Feature", geometry: p._geometry,
      properties: { index: i, id: p.id, egrid: p.egrid, nummer: p.nummer, label: p.id, area: p.parcel_area_m2 },
    });
    for (const lc of p._landcover) {
      if (!lc._geometry) continue;
      lcFeatures.push({
        type: "Feature", geometry: lc._geometry,
        properties: { art: lc.art, art_label: ART_LABELS[lc.art] || lc.art, area_m2: lc.area_m2, color: ART_COLORS[lc.art] || "#888", greenspace: lc.check_greenspace },
      });
    }
  });

  currentParcelData = { type: "FeatureCollection", features: parcelFeatures };
  currentLandcoverData = { type: "FeatureCollection", features: lcFeatures };
  map.getSource("parcels").setData(currentParcelData);
  map.getSource("landcover").setData(currentLandcoverData);

  if (parcelFeatures.length > 0) {
    const bounds = turf.bbox({ type: "FeatureCollection", features: parcelFeatures });
    map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 60, maxZoom: 18 });
  }
}

export function highlightParcel(index) {
  if (!map || !currentParcelData) return;
  const feature = currentParcelData.features.find((f) => f.properties.index === index);
  if (!feature) return;
  const bounds = turf.bbox(feature);
  map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 80, maxZoom: 19, duration: 600 });
  const center = turf.centroid(feature);
  const [lng, lat] = center.geometry.coordinates;
  showParcelPopup({ lng, lat }, feature.properties);
}

/** Fly to a location and place a temporary marker */
export function flyToLocation(lng, lat, bbox) {
  if (!map) return;
  if (searchMarker) { searchMarker.remove(); searchMarker = null; }

  if (bbox) {
    const [w, s, e, n] = bbox;
    map.fitBounds([[w, s], [e, n]], { padding: 40, duration: 800 });
  } else {
    map.flyTo({ center: [lng, lat], zoom: 15, duration: 800 });
  }

  searchMarker = new maplibregl.Marker({ color: "#d8232a" }).setLngLat([lng, lat]).addTo(map);
}

export function fitAllParcels() {
  if (!map || !currentParcelData || !currentParcelData.features.length) return;
  const bounds = turf.bbox(currentParcelData);
  map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 60, maxZoom: 18, duration: 800 });
}

function showParcelPopup(lngLat, props) {
  popup.setLngLat(lngLat).setHTML(`
    <div class="map-popup"><strong>${esc(props.id)}</strong><br>EGRID: ${esc(props.egrid)}<br>Nr: ${esc(props.nummer)}<br>Fläche: ${props.area} m²</div>
  `).addTo(map);
}

function showLandcoverPopup(lngLat, props) {
  popup.setLngLat(lngLat).setHTML(`
    <div class="map-popup"><strong>${esc(props.art_label)}</strong><br>Fläche: ${props.area_m2} m²<br>Grünfläche: ${esc(props.greenspace)}</div>
  `).addTo(map);
}

export function resizeMap() { if (map) map.resize(); }

function esc(s) { const d = document.createElement("div"); d.textContent = s || ""; return d.innerHTML; }
