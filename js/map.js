/**
 * MapLibre GL JS map with parcel polygons, land cover overlay,
 * Home/3D controls, and thumbnail basemap selector
 */
import { ART_COLORS, CATEGORY_COLORS, ART_LABELS, MAP_STYLES, MAP_DEFAULT, greenSpaceLabel, esc, fmtNum } from "./config.js";
import { setMap, readdSwisstopoLayers, loadGeokatalog, addSwisstopoLayer, removeSwisstopoLayer } from "./swisstopo.js";
import { t, getLang } from "./i18n.js";

let map = null;
let popup = null;
let onParcelClick = null;
let onLandcoverClick = null;
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
    btn.title = t("map.home");
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
    btn.title = t("map.3d");
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
    show3DBuildings();
  } else {
    map.flyTo({ pitch: 0, bearing: 0, duration: 800, center: map.getCenter(), zoom: map.getZoom() });
    hide3DBuildings();
  }
  if (toggle3DBtn) {
    toggle3DBtn.textContent = is3D ? "2D" : "3D";
    toggle3DBtn.classList.toggle("active", is3D);
  }
}

function show3DBuildings() {
  if (!map) return;

  // Already added — just show
  if (map.getLayer("3d-buildings")) {
    map.setLayoutProperty("3d-buildings", "visibility", "visible");
    return;
  }

  // Find vector tile source from basemap
  const sources = map.getStyle().sources;
  let vectorSourceId = null;
  for (const key in sources) {
    if (sources[key].type === "vector") { vectorSourceId = key; break; }
  }
  if (!vectorSourceId) return;

  // Hide basemap's own building layers to prevent double-rendering
  for (const layer of map.getStyle().layers) {
    if (layer["source-layer"] === "building" && layer.id !== "3d-buildings") {
      map.setLayoutProperty(layer.id, "visibility", "none");
    }
  }

  // Insert below our data layers
  let beforeLayer = null;
  if (map.getLayer("landcover-fill")) beforeLayer = "landcover-fill";
  else if (map.getLayer("parcels-fill")) beforeLayer = "parcels-fill";

  map.addLayer({
    id: "3d-buildings",
    source: vectorSourceId,
    "source-layer": "building",
    type: "fill-extrusion",
    minzoom: 15,
    filter: ["!=", ["get", "hide_3d"], true],
    paint: {
      "fill-extrusion-color": "#d0d0d0",
      "fill-extrusion-height": ["coalesce", ["get", "render_height"], 5],
      "fill-extrusion-base": 0,
      "fill-extrusion-opacity": 1,
    },
  }, beforeLayer);
}

function hide3DBuildings() {
  if (!map) return;

  if (map.getLayer("3d-buildings")) {
    map.setLayoutProperty("3d-buildings", "visibility", "none");
  }

  // Restore basemap's building layers
  for (const layer of map.getStyle().layers) {
    if (layer["source-layer"] === "building" && layer.id !== "3d-buildings") {
      map.setLayoutProperty(layer.id, "visibility", "visible");
    }
  }
}

class SummaryToggleControl {
  onAdd() {
    this._container = document.createElement("div");
    this._container.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = t("map.summary");
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

export async function initMap(containerId, { onParcelSelect, onLandcoverSelect } = {}) {
  onParcelClick = onParcelSelect || null;
  onLandcoverClick = onLandcoverSelect || null;

  if (map) { map.remove(); map = null; }

  const styleObj = MAP_STYLES[currentStyle];
  map = new maplibregl.Map({
    container: containerId,
    style: styleObj.url,
    center: MAP_DEFAULT.center,
    zoom: MAP_DEFAULT.zoom,
    attributionControl: false,
  });

  setMap(map);

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

  // Bottom controls
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 200 }), "bottom-left");
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
    if (onParcelClick) onParcelClick(props.index);
  });

  map.on("click", "landcover-fill", (e) => {
    if (!e.features.length) return;
    const props = e.features[0].properties;
    showLandcoverPopup(e.lngLat, props);
    if (onLandcoverClick && props.lc_index !== undefined) onLandcoverClick(props.lc_index);
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

  // Context menu
  initContextMenu();

  // Accordion layer toggles
  initAccordionMenu();
}

/* ── Accordion Layer Menu ── */

function initAccordionMenu() {
  // Accordion header toggle (mutually exclusive)
  document.querySelectorAll(".accordion-header").forEach((header) => {
    header.addEventListener("click", () => {
      const content = header.nextElementSibling;
      const isActive = header.classList.contains("active");

      // Close all
      document.querySelectorAll(".accordion-header").forEach((h) => {
        h.classList.remove("active");
        h.setAttribute("aria-expanded", "false");
      });
      document.querySelectorAll(".accordion-content").forEach((c) => c.classList.remove("show"));

      // Open clicked if not already active
      if (!isActive) {
        header.classList.add("active");
        header.setAttribute("aria-expanded", "true");
        content.classList.add("show");

        // Load geokatalog on first open
        if (header.closest("#geokatalog-accordion")) {
          loadGeokatalog();
        }
      }
    });
  });

  // Menu toggle (collapse/expand panel)
  const menuToggle = document.getElementById("menu-toggle");
  const accordionPanel = document.getElementById("accordion-panel");
  const toggleText = document.getElementById("menu-toggle-text");

  // Auto-collapse on small screens (<= 1400px)
  let menuOpen = window.innerWidth > 1400;
  if (!menuOpen) {
    accordionPanel.classList.add("collapsed");
    toggleText.textContent = t("menu.open");
    menuToggle.querySelector(".material-symbols-outlined").textContent = "expand_more";
  }

  menuToggle?.addEventListener("click", () => {
    menuOpen = !menuOpen;
    accordionPanel.classList.toggle("collapsed", !menuOpen);
    toggleText.textContent = menuOpen ? t("menu.close") : t("menu.open");
    menuToggle.querySelector(".material-symbols-outlined").textContent = menuOpen ? "expand_less" : "expand_more";
  });

  // Layer visibility toggles
  initLayerToggle("layer-toggle-parcels", ["parcels-fill", "parcels-line", "parcels-label"]);
  initLayerToggle("layer-toggle-landcover", ["landcover-fill", "landcover-line"]);
  initLayerToggle("layer-toggle-labels", ["parcels-label"]);

  // Swisstopo overlay toggles (ÖREB, AV) — add/remove as swisstopo layers
  initSwisstopoToggle("layer-toggle-av");
  initSwisstopoToggle("layer-toggle-habitat");
}

function initSwisstopoToggle(checkboxId) {
  const cb = document.getElementById(checkboxId);
  if (!cb) return;
  const layerId = cb.dataset.swisstopo;
  if (!layerId) return;
  cb.addEventListener("change", () => {
    if (cb.checked) addSwisstopoLayer(layerId, cb.nextElementSibling?.textContent || layerId, true);
    else removeSwisstopoLayer(layerId);
  });
}

function initLayerToggle(checkboxId, layerIds) {
  const cb = document.getElementById(checkboxId);
  if (!cb) return;
  cb.addEventListener("change", () => {
    const vis = cb.checked ? "visible" : "none";
    for (const id of layerIds) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
    }
  });
}

/* ── Context Menu ── */

let contextLngLat = null;

function initContextMenu() {
  const menu = document.getElementById("map-context-menu");
  if (!menu) return;

  map.on("contextmenu", (e) => {
    e.preventDefault();
    contextLngLat = e.lngLat;

    const lat = contextLngLat.lat.toFixed(5);
    const lon = contextLngLat.lng.toFixed(5);
    document.getElementById("ctx-coords-text").textContent = `${lat}, ${lon}`;
    menu.querySelector(".context-menu-coords")?.classList.remove("copied");

    const mapEl = map.getContainer();
    const rect = mapEl.getBoundingClientRect();
    const menuW = 200, menuH = 140;
    const flipH = (e.point.x + menuW) > rect.width;
    const flipV = (e.point.y + menuH) > rect.height;

    menu.style.left = e.point.x + "px";
    menu.style.top = e.point.y + "px";
    menu.classList.toggle("flip-horizontal", flipH);
    menu.classList.toggle("flip-vertical", flipV);
    menu.classList.add("show");
  });

  // Hide on click elsewhere
  map.on("click", () => menu.classList.remove("show"));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") menu.classList.remove("show");
  });

  // Copy coordinates
  document.getElementById("ctx-copy-coords")?.addEventListener("click", () => {
    const text = document.getElementById("ctx-coords-text").textContent;
    navigator.clipboard.writeText(text).then(() => {
      menu.querySelector(".context-menu-coords")?.classList.add("copied");
      setTimeout(() => menu.classList.remove("show"), 300);
    });
  });

  // Share
  document.getElementById("ctx-share")?.addEventListener("click", () => {
    if (!contextLngLat) return;
    const langParam = getLang() !== "de" ? `&lang=${getLang()}` : "";
    const url = `${location.origin}${location.pathname}?center=${contextLngLat.lng.toFixed(5)},${contextLngLat.lat.toFixed(5)}&zoom=${Math.round(map.getZoom())}${langParam}`;
    menu.classList.remove("show");
    if (navigator.share) {
      navigator.share({ title: "Landcover Survey", url }).catch(() => {
        navigator.clipboard.writeText(url);
      });
    } else {
      navigator.clipboard.writeText(url);
    }
  });

  // Report
  document.getElementById("ctx-report")?.addEventListener("click", () => {
    menu.classList.remove("show");
    if (!contextLngLat) return;
    const lat = contextLngLat.lat.toFixed(5);
    const lon = contextLngLat.lng.toFixed(5);
    const subject = encodeURIComponent(t("ctx.report.subject"));
    const body = encodeURIComponent(t("ctx.report.body", { lat, lon, url: location.href }));
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  });
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
  if (map.getSource("landcover")) return; // guard against duplicate calls
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

  // Clustered parcel centroids (visible when zoomed out)
  map.addSource("parcels-clusters", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
    cluster: true,
    clusterMaxZoom: 13,
    clusterRadius: 50,
  });

  // Cluster circles
  map.addLayer({
    id: "parcel-clusters", type: "circle", source: "parcels-clusters",
    filter: ["has", "point_count"],
    paint: {
      "circle-color": ["step", ["get", "point_count"], "#1a365d", 10, "#2d4a7a", 50, "#d8232a"],
      "circle-radius": ["step", ["get", "point_count"], 18, 10, 24, 50, 32],
      "circle-stroke-width": 2,
      "circle-stroke-color": "#fff",
    },
  });

  // Cluster count labels
  map.addLayer({
    id: "parcel-cluster-count", type: "symbol", source: "parcels-clusters",
    filter: ["has", "point_count"],
    layout: {
      "text-field": ["get", "point_count_abbreviated"],
      "text-size": 12,
      "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
    },
    paint: { "text-color": "#fff" },
  });

  // Unclustered single points (small dot when zoomed out)
  map.addLayer({
    id: "parcel-unclustered", type: "circle", source: "parcels-clusters",
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-color": "#1a365d",
      "circle-radius": 6,
      "circle-stroke-width": 1.5,
      "circle-stroke-color": "#fff",
    },
  });

  // Click on cluster → zoom in
  map.on("click", "parcel-clusters", (e) => {
    const features = map.queryRenderedFeatures(e.point, { layers: ["parcel-clusters"] });
    if (!features.length) return;
    const clusterId = features[0].properties.cluster_id;
    map.getSource("parcels-clusters").getClusterExpansionZoom(clusterId, (err, zoom) => {
      if (err) return;
      map.easeTo({ center: features[0].geometry.coordinates, zoom: zoom + 1 });
    });
  });

  // Click on unclustered point → select parcel
  map.on("click", "parcel-unclustered", (e) => {
    if (!e.features.length) return;
    const props = e.features[0].properties;
    showParcelPopup(e.lngLat, props);
    if (onParcelClick) onParcelClick(props.index);
  });

  map.on("mouseenter", "parcel-clusters", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "parcel-clusters", () => (map.getCanvas().style.cursor = ""));
  map.on("mouseenter", "parcel-unclustered", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "parcel-unclustered", () => (map.getCanvas().style.cursor = ""));
}

let currentClusterData = null;

function reAddDataLayers() {
  addDataLayers();
  if (currentParcelData) map.getSource("parcels").setData(currentParcelData);
  if (currentLandcoverData) map.getSource("landcover").setData(currentLandcoverData);
  if (currentClusterData) map.getSource("parcels-clusters").setData(currentClusterData);
  if (is3D) show3DBuildings();
  readdSwisstopoLayers();
}

export function plotResults(results) {
  if (!map) return;
  if (!map.getSource("parcels")) addDataLayers();

  const parcelFeatures = [];
  const lcFeatures = [];
  let lcIndex = 0;

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
        properties: { lc_index: lcIndex, art: lc.art, art_label: ART_LABELS[lc.art] || lc.art, area_m2: lc.area_m2, color: ART_COLORS[lc.art] || "#888", greenspace: lc.check_greenspace, sia416: lc._sia416 || "", parcel_id: p.id },
      });
      lcIndex++;
    }
  });

  currentParcelData = { type: "FeatureCollection", features: parcelFeatures };
  currentLandcoverData = { type: "FeatureCollection", features: lcFeatures };
  map.getSource("parcels").setData(currentParcelData);
  map.getSource("landcover").setData(currentLandcoverData);

  // Build cluster centroids from parcel polygons
  const clusterPoints = parcelFeatures.map((f) => {
    const center = turf.centroid(f);
    center.properties = { index: f.properties.index, id: f.properties.id, egrid: f.properties.egrid, nummer: f.properties.nummer, label: f.properties.label, area: f.properties.area };
    return center;
  });
  currentClusterData = { type: "FeatureCollection", features: clusterPoints };
  map.getSource("parcels-clusters").setData(currentClusterData);

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

/** Highlight and zoom to a specific landcover feature */
export function highlightLandcover(lcIndex) {
  if (!map || !currentLandcoverData) return;
  const feature = currentLandcoverData.features.find((f) => f.properties.lc_index === lcIndex);
  if (!feature) return;
  const bounds = turf.bbox(feature);
  map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: 80, maxZoom: 19, duration: 600 });
  const center = turf.centroid(feature);
  const [lng, lat] = center.geometry.coordinates;
  showLandcoverPopup({ lng, lat }, feature.properties);
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
    <div class="map-popup">
      <div class="popup-layer">${esc(t("popup.parcel"))}</div>
      <div class="popup-title">${esc(props.id)} &middot; ${esc(props.egrid)}</div>
      <div class="popup-sub">${esc(t("col.nummer"))} ${esc(props.nummer)}</div>
      <table class="popup-table">
        <tr><td>${esc(t("popup.area"))}</td><td>${fmtNum(props.area, 2)} m²</td></tr>
      </table>
    </div>
  `).addTo(map);
}

function showLandcoverPopup(lngLat, props) {
  const gs = greenSpaceLabel(props.greenspace);
  popup.setLngLat(lngLat).setHTML(`
    <div class="map-popup">
      <div class="popup-layer">${esc(t("popup.landcover"))}</div>
      <div class="popup-title">${esc(props.art_label)}</div>
      <div class="popup-sub">${esc(t("popup.parcel.label"))} ${esc(props.parcel_id)}</div>
      <table class="popup-table">
        <tr><td>${esc(t("popup.area"))}</td><td>${fmtNum(props.area_m2, 2)} m²</td></tr>
        <tr><td>${esc(t("popup.greenspace"))}</td><td>${gs}</td></tr>
        <tr><td>SIA 416</td><td>${esc(props.sia416)}</td></tr>
      </table>
    </div>
  `).addTo(map);
}

export function resizeMap() { if (map) map.resize(); }

/** Update landcover polygon colors based on a color mapping function.
 *  colorFn receives a feature's properties and returns a hex color string. */
export function updateLandcoverColors(colorMap) {
  if (!map || !map.getLayer("landcover-fill") || !currentLandcoverData) return;

  // Update the GeoJSON features with new colors
  for (const f of currentLandcoverData.features) {
    f.properties.color = colorMap(f.properties) || "#888";
  }
  map.getSource("landcover").setData(currentLandcoverData);
}

