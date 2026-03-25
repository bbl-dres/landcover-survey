/**
 * Swisstopo external layer management — add/remove/toggle WMTS/WMS layers,
 * Geokatalog tree, restore after basemap change
 */
import { resizeMap } from "./map.js";

/** Active swisstopo layers: [{ id, title, sourceId, mapLayerId, tileUrl, maxZoom, visible }] */
export const activeSwisstopoLayers = [];

let mapRef = null;

export function setMap(map) { mapRef = map; }

/* ── Add Layer ── */

export function addSwisstopoLayer(layerId, title, silent) {
  if (!layerId || !mapRef) return;
  if (!/^[a-zA-Z0-9._-]+$/.test(layerId)) return;
  if (activeSwisstopoLayers.some((l) => l.id === layerId)) return;

  fetch(`https://api3.geo.admin.ch/rest/services/api/MapServer/${layerId}?lang=de`)
    .then((r) => { if (!r.ok) throw new Error("Metadata unavailable"); return r.json(); })
    .then((meta) => {
      const sourceId = `swisstopo-${layerId}`;
      const mapLayerId = `swisstopo-layer-${layerId}`;
      let tileUrl, maxZoom = 18;

      if (meta.format) {
        const fmt = meta.format.replace("image/", "");
        const ts = (meta.timestamps && meta.timestamps.length) ? meta.timestamps[0] : "current";
        tileUrl = `https://wmts.geo.admin.ch/1.0.0/${layerId}/default/${ts}/3857/{z}/{x}/{y}.${fmt}`;
      } else {
        tileUrl = `https://wms.geo.admin.ch/?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${layerId}&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true`;
        maxZoom = 19;
      }

      try {
        mapRef.addSource(sourceId, {
          type: "raster", tiles: [tileUrl], tileSize: 256, maxzoom: maxZoom,
          attribution: '&copy; <a href="https://www.swisstopo.admin.ch">swisstopo</a>',
        });

        let beforeLayer = null;
        if (mapRef.getLayer("landcover-fill")) beforeLayer = "landcover-fill";
        else if (mapRef.getLayer("parcels-fill")) beforeLayer = "parcels-fill";

        mapRef.addLayer({
          id: mapLayerId, type: "raster", source: sourceId,
          paint: { "raster-opacity": 0.7 },
        }, beforeLayer);
      } catch (e) {
        console.error("Error adding swisstopo layer:", e);
        return;
      }

      activeSwisstopoLayers.push({ id: layerId, title: title || layerId, sourceId, mapLayerId, tileUrl, maxZoom, visible: true });
      renderActiveLayersList();
    })
    .catch((e) => { if (e.name !== "AbortError") console.error("Layer load failed:", layerId, e); });
}

/* ── Remove Layer ── */

export function removeSwisstopoLayer(layerId) {
  const idx = activeSwisstopoLayers.findIndex((l) => l.id === layerId);
  if (idx === -1) return;
  const layer = activeSwisstopoLayers[idx];

  try {
    if (mapRef.getLayer(layer.mapLayerId)) mapRef.removeLayer(layer.mapLayerId);
    if (mapRef.getSource(layer.sourceId)) mapRef.removeSource(layer.sourceId);
  } catch (e) { console.error("Error removing layer:", e); }

  activeSwisstopoLayers.splice(idx, 1);
  renderActiveLayersList();
  updateGeokatalogCheckboxes();
}

/* ── Toggle Visibility ── */

export function toggleSwisstopoLayerVisibility(layerId) {
  const layer = activeSwisstopoLayers.find((l) => l.id === layerId);
  if (!layer || !mapRef.getLayer(layer.mapLayerId)) return;
  const vis = mapRef.getLayoutProperty(layer.mapLayerId, "visibility");
  const newVis = vis === "none" ? "visible" : "none";
  mapRef.setLayoutProperty(layer.mapLayerId, "visibility", newVis);
  layer.visible = newVis !== "none";
  renderActiveLayersList();
}

/* ── Re-add after basemap change ── */

export function readdSwisstopoLayers() {
  if (!mapRef || activeSwisstopoLayers.length === 0) return;

  for (const layer of activeSwisstopoLayers) {
    if (mapRef.getSource(layer.sourceId)) continue;
    try {
      mapRef.addSource(layer.sourceId, {
        type: "raster", tiles: [layer.tileUrl], tileSize: 256, maxzoom: layer.maxZoom,
        attribution: '&copy; <a href="https://www.swisstopo.admin.ch">swisstopo</a>',
      });

      let beforeLayer = null;
      if (mapRef.getLayer("landcover-fill")) beforeLayer = "landcover-fill";
      else if (mapRef.getLayer("parcels-fill")) beforeLayer = "parcels-fill";

      mapRef.addLayer({
        id: layer.mapLayerId, type: "raster", source: layer.sourceId,
        layout: { visibility: layer.visible !== false ? "visible" : "none" },
        paint: { "raster-opacity": 0.7 },
      }, beforeLayer);
    } catch (e) { console.error("Error restoring layer:", layer.id, e); }
  }
  renderActiveLayersList();
}

/* ── Geokatalog ── */

let geokatalogLoaded = false;

export function loadGeokatalog() {
  if (geokatalogLoaded) return;
  const tree = document.getElementById("geokatalog-tree");
  if (!tree) return;

  tree.innerHTML = '<div class="geokatalog-loading">Katalog wird geladen...</div>';

  fetch("https://api3.geo.admin.ch/rest/services/ech/CatalogServer?lang=de")
    .then((r) => { if (!r.ok) throw new Error("API error"); return r.json(); })
    .then((data) => {
      geokatalogLoaded = true;
      tree.innerHTML = "";
      if (data.results?.root?.children) {
        renderCatalogTree(data.results.root.children, tree);
      } else {
        tree.innerHTML = '<div class="geokatalog-empty">Keine Daten verfügbar</div>';
      }
    })
    .catch((e) => {
      console.error("Geokatalog error:", e);
      tree.innerHTML = '<div class="geokatalog-empty">Fehler beim Laden</div>';
    });
}

function renderCatalogTree(items, container) {
  for (const item of items) {
    const el = document.createElement("div");
    el.className = "catalog-item";

    const hasChildren = item.children?.length > 0;
    const node = document.createElement("div");
    node.className = `catalog-node${hasChildren ? "" : " leaf"}`;

    if (hasChildren) {
      const arrow = document.createElement("span");
      arrow.className = "node-arrow";
      arrow.innerHTML = '<span class="material-symbols-outlined">chevron_right</span>';
      node.appendChild(arrow);
    } else if (item.layerBodId) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "node-checkbox";
      cb.dataset.layerId = item.layerBodId;
      cb.checked = activeSwisstopoLayers.some((l) => l.id === item.layerBodId);
      node.appendChild(cb);
    }

    const label = document.createElement("span");
    label.className = "node-label";
    label.textContent = item.label || item.category || "Unbekannt";
    node.appendChild(label);

    el.appendChild(node);

    if (hasChildren) {
      const children = document.createElement("div");
      children.className = "catalog-children";
      renderCatalogTree(item.children, children);
      el.appendChild(children);

      node.addEventListener("click", (e) => {
        e.stopPropagation();
        el.classList.toggle("expanded");
      });
    } else if (item.layerBodId) {
      const lid = item.layerBodId;
      const lTitle = item.label || lid;
      node.addEventListener("click", (e) => {
        e.stopPropagation();
        const cb = node.querySelector(".node-checkbox");
        const isActive = activeSwisstopoLayers.some((l) => l.id === lid);
        if (isActive) {
          removeSwisstopoLayer(lid);
          if (cb) cb.checked = false;
        } else {
          addSwisstopoLayer(lid, lTitle, false);
          if (cb) cb.checked = true;
        }
      });
    }

    container.appendChild(el);
  }
}

function updateGeokatalogCheckboxes() {
  document.querySelectorAll("#geokatalog-tree .node-checkbox").forEach((cb) => {
    cb.checked = activeSwisstopoLayers.some((l) => l.id === cb.dataset.layerId);
  });
}

/* ── Active layers list in accordion ── */

export function renderActiveLayersList() {
  const container = document.getElementById("external-layers-list");
  if (!container) return;

  if (activeSwisstopoLayers.length === 0) {
    container.innerHTML = '<div class="active-layers-empty">Keine externen Karten aktiv. Suchen Sie nach Karten über das Suchfeld oder den Geokatalog.</div>';
    return;
  }

  container.innerHTML = activeSwisstopoLayers.map((layer) => {
    const isVisible = layer.visible !== false;
    return `<div class="active-layer-item">
      <button class="active-layer-remove" data-layer-id="${esc(layer.id)}" title="Entfernen">
        <span class="material-symbols-outlined">close</span>
      </button>
      <input type="checkbox" class="active-layer-checkbox" ${isVisible ? "checked" : ""} data-layer-id="${esc(layer.id)}" title="${isVisible ? "Ausblenden" : "Einblenden"}">
      <span class="active-layer-title">${esc(layer.title)}</span>
    </div>`;
  }).join("");

  // Wire events
  container.querySelectorAll(".active-layer-remove").forEach((btn) => {
    btn.addEventListener("click", () => removeSwisstopoLayer(btn.dataset.layerId));
  });
  container.querySelectorAll(".active-layer-checkbox").forEach((cb) => {
    cb.addEventListener("change", () => toggleSwisstopoLayerVisibility(cb.dataset.layerId));
  });
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}
