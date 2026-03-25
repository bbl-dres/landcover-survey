/**
 * Swisstopo external layer management — add/remove/toggle WMTS/WMS layers,
 * Geokatalog tree, restore after basemap change
 */
import { esc } from "./config.js";
import { resizeMap } from "./map.js";
import { t, getLang } from "./i18n.js";

/** Active swisstopo layers: [{ id, title, sourceId, mapLayerId, tileUrl, maxZoom, visible }] */
export const activeSwisstopoLayers = [];

const FETCH_TIMEOUT = 15000;

/** Fetch with AbortController timeout */
function fetchTimeout(url, ms = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(id));
}

let mapRef = null;

export function setMap(map) { mapRef = map; }

/* ── Add Layer ── */

/** Layer IDs of static toggles in the HTML (not rendered dynamically) */
const STATIC_LAYER_IDS = new Set([
  "ch.kantone.cadastralwebmap-farbe",
  "ch.bafu.lebensraumkarte-schweiz",
  "ch.are.bauzonen",
]);

const pendingLayerIds = new Set();

export function addSwisstopoLayer(layerId, title, silent) {
  if (!layerId || !mapRef) return;
  if (!/^[a-zA-Z0-9._-]+$/.test(layerId)) return;
  if (activeSwisstopoLayers.some((l) => l.id === layerId)) return;
  if (pendingLayerIds.has(layerId)) return;
  pendingLayerIds.add(layerId);

  fetchTimeout(`https://api3.geo.admin.ch/rest/services/api/MapServer/${layerId}?lang=${getLang()}`)
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
      pendingLayerIds.delete(layerId);
      renderActiveLayersList();
      syncStaticCheckboxes();
    })
    .catch((e) => {
      pendingLayerIds.delete(layerId);
      if (e.name !== "AbortError") console.error("Layer load failed:", layerId, e);
    });
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
  syncStaticCheckboxes();
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

  tree.innerHTML = `<div class="geokatalog-loading">${esc(t("geokatalog.loading"))}</div>`;

  fetchTimeout(`https://api3.geo.admin.ch/rest/services/ech/CatalogServer?lang=${getLang()}`)
    .then((r) => { if (!r.ok) throw new Error("API error"); return r.json(); })
    .then((data) => {
      geokatalogLoaded = true;
      tree.innerHTML = "";
      if (data.results?.root?.children) {
        renderCatalogTree(data.results.root.children, tree);
      } else {
        tree.innerHTML = `<div class="geokatalog-empty">${esc(t("geokatalog.empty"))}</div>`;
      }
    })
    .catch((e) => {
      console.error("Geokatalog error:", e);
      tree.innerHTML = `<div class="geokatalog-empty">${esc(t("geokatalog.error"))}</div>`;
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
    label.textContent = item.label || item.category || t("geokatalog.unknown");
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

/** Keep static HTML checkboxes in sync with activeSwisstopoLayers */
function syncStaticCheckboxes() {
  document.querySelectorAll("[data-swisstopo]").forEach((cb) => {
    const layerId = cb.dataset.swisstopo;
    const isActive = activeSwisstopoLayers.some((l) => l.id === layerId);
    cb.checked = isActive;
  });
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

  // Only render dynamically added layers (not the static ones already in HTML)
  const dynamicLayers = activeSwisstopoLayers.filter((l) => !STATIC_LAYER_IDS.has(l.id));

  if (dynamicLayers.length === 0) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = dynamicLayers.map((layer) => {
    const isVisible = layer.visible !== false;
    return `<label class="active-layer-item">
      <button class="active-layer-remove" data-layer-id="${esc(layer.id)}" title="${esc(t("layer.remove"))}">
        <span class="material-symbols-outlined">close</span>
      </button>
      <input type="checkbox" class="active-layer-checkbox" ${isVisible ? "checked" : ""} data-layer-id="${esc(layer.id)}" title="${isVisible ? esc(t("layer.hide")) : esc(t("layer.show"))}">
      <span class="active-layer-title">${esc(layer.title)}</span>
      <button class="active-layer-info" data-info="swisstopo" data-layer-id="${esc(layer.id)}"><span class="material-symbols-outlined">info</span></button>
    </label>`;
  }).join("");

  // Wire events
  container.querySelectorAll(".active-layer-remove").forEach((btn) => {
    btn.addEventListener("click", () => removeSwisstopoLayer(btn.dataset.layerId));
  });
  container.querySelectorAll(".active-layer-checkbox").forEach((cb) => {
    cb.addEventListener("change", () => toggleSwisstopoLayerVisibility(cb.dataset.layerId));
  });
  container.querySelectorAll(".active-layer-info").forEach((btn) => {
    btn.addEventListener("click", (e) => { e.stopPropagation(); showLayerInfo(btn.dataset.layerId); });
  });
}

/* ── Layer Info Modal ── */

function getInternalLayerMeta(key) {
  return {
    parcels: {
      title: t("layermeta.parcels.title"),
      description: t("layermeta.parcels.desc"),
      source: t("layermeta.parcels.source"),
      format: t("layermeta.parcels.format"),
    },
    landcover: {
      title: t("layermeta.landcover.title"),
      description: t("layermeta.landcover.desc"),
      source: t("layermeta.landcover.source"),
      format: t("layermeta.landcover.format"),
    },
  }[key];
}

export function showLayerInfo(layerId) {
  const modal = document.getElementById("layer-info-modal");
  const content = document.getElementById("layer-info-content");
  if (!modal || !content || !layerId) return;

  content.innerHTML = `<div class="layer-info-loading">${esc(t("layerinfo.loading"))}</div>`;
  modal.classList.add("show");

  fetchTimeout(`https://api3.geo.admin.ch/rest/services/api/MapServer/${layerId}/legend?lang=${getLang()}`)
    .then((r) => { if (!r.ok) throw new Error("Unavailable"); return r.text(); })
    .then((html) => {
      // Sanitize: strip scripts and event handlers
      const doc = new DOMParser().parseFromString(html, "text/html");
      doc.querySelectorAll("script, iframe, object, embed, form").forEach((el) => el.remove());
      doc.querySelectorAll("*").forEach((el) => {
        for (const attr of Array.from(el.attributes)) {
          if (attr.name.startsWith("on") || attr.value.trim().toLowerCase().startsWith("javascript:")) {
            el.removeAttribute(attr.name);
          }
        }
      });
      content.innerHTML = `<div class="layer-info-api-content">${doc.body?.innerHTML || ""}</div>`;
    })
    .catch((e) => {
      console.error("Layer info error:", e);
      content.innerHTML = `<div class="layer-info-loading">${esc(t("layerinfo.unavailable"))}</div>`;
    });
}

export function showInternalLayerInfo(layerKey) {
  const modal = document.getElementById("layer-info-modal");
  const content = document.getElementById("layer-info-content");
  if (!modal || !content) return;

  const meta = getInternalLayerMeta(layerKey);
  if (!meta) return;

  const locale = { de: "de-CH", fr: "fr-CH", it: "it-CH", en: "en-CH" }[getLang()] || "de-CH";
  const today = new Date().toLocaleDateString(locale, { day: "2-digit", month: "2-digit", year: "numeric" });

  content.innerHTML = `
    <div class="legend-container">
      <div class="bod-title" id="layer-info-title">${esc(meta.title)}</div>
      <div class="legend-abstract">${esc(meta.description)}</div>
      <div class="legend-footer"><span>${esc(t("layerinfo.info"))}</span></div>
      <table>
        <tr><td>${esc(t("layerinfo.source"))}</td><td>${esc(meta.source)}</td></tr>
        <tr><td>${esc(t("layerinfo.format"))}</td><td>${esc(meta.format)}</td></tr>
        <tr><td>${esc(t("layerinfo.date"))}</td><td>${today}</td></tr>
      </table>
    </div>
  `;
  modal.classList.add("show");
}

function hideLayerInfo() {
  document.getElementById("layer-info-modal")?.classList.remove("show");
}

// Init modal events
document.addEventListener("DOMContentLoaded", () => {
  const modal = document.getElementById("layer-info-modal");
  if (!modal) return;

  modal.querySelector(".layer-info-modal-close")?.addEventListener("click", hideLayerInfo);
  modal.addEventListener("click", (e) => { if (e.target === modal) hideLayerInfo(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("show")) {
      e.stopImmediatePropagation();
      hideLayerInfo();
    }
  });

  // Delegated info button clicks (for static buttons in HTML)
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".active-layer-info");
    if (!btn) return;
    e.stopPropagation();
    if (btn.dataset.info === "swisstopo") showLayerInfo(btn.dataset.layerId);
    else if (btn.dataset.info === "internal") showInternalLayerInfo(btn.dataset.layerKey);
  });
});

