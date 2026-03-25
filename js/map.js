/**
 * MapLibre GL JS map with parcel polygons and land cover overlay
 */
import { ART_COLORS, CATEGORY_COLORS, ART_LABELS } from "./config.js";

let map = null;
let popup = null;
let onFeatureClick = null;
let summaryToggleCallback = null;
let summaryToggleControl = null;

const BASEMAPS = [
  {
    id: "positron",
    label: "Hell",
    url: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  },
  {
    id: "swisstopo",
    label: "Luftbild",
    url: "https://vectortiles.geo.admin.ch/styles/ch.swisstopo.imagerybasemap.vt/style.json",
  },
];

let currentBasemap = "positron";

class SummaryToggleControl {
  onAdd() {
    this._container = document.createElement("div");
    this._container.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.title = "Zusammenfassung";
    btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h7v7H3z"/><path d="M14 3h7v7h-7z"/><path d="M3 14h7v7H3z"/><path d="M14 14h7v7h-7z"/></svg>`;
    btn.addEventListener("click", () => {
      if (summaryToggleCallback) summaryToggleCallback();
    });
    this._container.appendChild(btn);
    return this._container;
  }
  onRemove() {
    this._container.remove();
  }
  setHidden(hidden) {
    this._container.style.display = hidden ? "none" : "block";
  }
}

class BasemapControl {
  onAdd() {
    this._container = document.createElement("div");
    this._container.className = "maplibregl-ctrl maplibregl-ctrl-group basemap-ctrl";
    for (const bm of BASEMAPS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = bm.id === currentBasemap ? "active" : "";
      btn.textContent = bm.label;
      btn.title = bm.label;
      btn.addEventListener("click", () => {
        currentBasemap = bm.id;
        map.setStyle(bm.url);
        this._container.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        // Re-add data layers after style change
        map.once("style.load", () => reAddDataLayers());
      });
      this._container.appendChild(btn);
    }
    return this._container;
  }
  onRemove() {
    this._container.remove();
  }
}

// Store current data for re-adding after basemap change
let currentParcelData = null;
let currentLandcoverData = null;

export function onSummaryToggle(callback) {
  summaryToggleCallback = callback;
}

export function setSummaryToggleVisible(visible) {
  if (summaryToggleControl) summaryToggleControl.setHidden(!visible);
}

export async function initMap(containerId, clickCallback) {
  onFeatureClick = clickCallback;

  if (map) {
    map.remove();
    map = null;
  }

  map = new maplibregl.Map({
    container: containerId,
    style: BASEMAPS.find((b) => b.id === currentBasemap).url,
    center: [8.2275, 46.8182], // Switzerland center
    zoom: 7,
    attributionControl: false,
  });

  map.addControl(new maplibregl.NavigationControl(), "top-left");
  map.addControl(new BasemapControl(), "top-left");

  summaryToggleControl = new SummaryToggleControl();
  map.addControl(summaryToggleControl, "top-right");
  summaryToggleControl.setHidden(true);

  map.addControl(
    new maplibregl.AttributionControl({ compact: true }),
    "bottom-right"
  );

  popup = new maplibregl.Popup({ closeButton: true, closeOnClick: false, maxWidth: "360px" });

  await new Promise((resolve) => map.on("load", resolve));

  // Click handlers for parcel and landcover layers
  map.on("click", "parcels-fill", (e) => {
    if (!e.features.length) return;
    const props = e.features[0].properties;
    showParcelPopup(e.lngLat, props);
    if (onFeatureClick) onFeatureClick(props.index);
  });

  map.on("click", "landcover-fill", (e) => {
    if (!e.features.length) return;
    const props = e.features[0].properties;
    showLandcoverPopup(e.lngLat, props);
  });

  // Cursor changes
  for (const layer of ["parcels-fill", "landcover-fill"]) {
    map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
  }
}

function addDataLayers() {
  // Land cover layer (below parcels)
  map.addSource("landcover", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: "landcover-fill",
    type: "fill",
    source: "landcover",
    paint: {
      "fill-color": ["get", "color"],
      "fill-opacity": 0.5,
    },
  });

  map.addLayer({
    id: "landcover-line",
    type: "line",
    source: "landcover",
    paint: {
      "line-color": ["get", "color"],
      "line-width": 1,
      "line-opacity": 0.8,
    },
  });

  // Parcel layer (on top)
  map.addSource("parcels", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: "parcels-fill",
    type: "fill",
    source: "parcels",
    paint: {
      "fill-color": "#1a365d",
      "fill-opacity": 0.08,
    },
  });

  map.addLayer({
    id: "parcels-line",
    type: "line",
    source: "parcels",
    paint: {
      "line-color": "#1a365d",
      "line-width": 2.5,
    },
  });

  // Parcel labels
  map.addLayer({
    id: "parcels-label",
    type: "symbol",
    source: "parcels",
    layout: {
      "text-field": ["get", "label"],
      "text-size": 12,
      "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
      "text-anchor": "center",
    },
    paint: {
      "text-color": "#1a365d",
      "text-halo-color": "#fff",
      "text-halo-width": 1.5,
    },
  });
}

function reAddDataLayers() {
  addDataLayers();
  if (currentParcelData) {
    map.getSource("parcels").setData(currentParcelData);
  }
  if (currentLandcoverData) {
    map.getSource("landcover").setData(currentLandcoverData);
  }
}

/** Plot parcel and land cover results on the map */
export function plotResults(results) {
  if (!map) return;

  // Ensure layers exist
  if (!map.getSource("parcels")) {
    addDataLayers();
  }

  // Build parcel GeoJSON
  const parcelFeatures = [];
  const lcFeatures = [];

  results.parcels.forEach((p, i) => {
    if (!p._geometry) return;

    parcelFeatures.push({
      type: "Feature",
      geometry: p._geometry,
      properties: {
        index: i,
        id: p.id,
        egrid: p.egrid,
        nummer: p.nummer,
        label: p.id,
        area: p.parcel_area_m2,
      },
    });

    for (const lc of p._landcover) {
      if (!lc._geometry) continue;
      const color = ART_COLORS[lc.art] || "#888";
      lcFeatures.push({
        type: "Feature",
        geometry: lc._geometry,
        properties: {
          art: lc.art,
          art_label: ART_LABELS[lc.art] || lc.art,
          area_m2: lc.area_m2,
          color: color,
          greenspace: lc.check_greenspace,
        },
      });
    }
  });

  currentParcelData = { type: "FeatureCollection", features: parcelFeatures };
  currentLandcoverData = { type: "FeatureCollection", features: lcFeatures };

  map.getSource("parcels").setData(currentParcelData);
  map.getSource("landcover").setData(currentLandcoverData);

  // Fit bounds
  if (parcelFeatures.length > 0) {
    const allFeatures = { type: "FeatureCollection", features: parcelFeatures };
    const bounds = turf.bbox(allFeatures);
    map.fitBounds(
      [[bounds[0], bounds[1]], [bounds[2], bounds[3]]],
      { padding: 60, maxZoom: 18 }
    );
  }
}

/** Highlight and zoom to a specific parcel on the map */
export function highlightParcel(index) {
  if (!map || !currentParcelData) return;

  const feature = currentParcelData.features.find((f) => f.properties.index === index);
  if (!feature) return;

  // Zoom to parcel bounds
  const bounds = turf.bbox(feature);
  map.fitBounds(
    [[bounds[0], bounds[1]], [bounds[2], bounds[3]]],
    { padding: 80, maxZoom: 19, duration: 600 }
  );

  // Show popup at centroid
  const center = turf.centroid(feature);
  const [lng, lat] = center.geometry.coordinates;
  showParcelPopup({ lng, lat }, feature.properties);
}

function showParcelPopup(lngLat, props) {
  const html = `
    <div class="map-popup">
      <strong>${escHtml(props.id)}</strong><br>
      EGRID: ${escHtml(props.egrid)}<br>
      Nr: ${escHtml(props.nummer)}<br>
      Fläche: ${props.area} m²
    </div>
  `;
  popup.setLngLat(lngLat).setHTML(html).addTo(map);
}

function showLandcoverPopup(lngLat, props) {
  const html = `
    <div class="map-popup">
      <strong>${escHtml(props.art_label)}</strong><br>
      Fläche: ${props.area_m2} m²<br>
      Grünfläche: ${escHtml(props.greenspace)}
    </div>
  `;
  popup.setLngLat(lngLat).setHTML(html).addTo(map);
}

export function resizeMap() {
  if (map) map.resize();
}

function escHtml(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}
