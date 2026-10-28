/**
 * Search bar: local parcel search + swisstopo location search
 */
import { API, esc, fetchWithTimeout } from "./config.js";
import { highlightParcel, flyToLocation } from "./map.js";
import { highlightRow } from "./table.js";
import { addSwisstopoLayer } from "./swisstopo.js";
import { t, getLang } from "./i18n.js";

const SEARCH_TIMEOUT = 8000;

const fetchTimeout = (url) => fetchWithTimeout(url, { timeoutMs: SEARCH_TIMEOUT });

let parcelsData = []; // set by main.js after processing
let debounceTimer = null;
let activeIndex = -1; // keyboard-highlighted suggestion (-1 = none)

export function setSearchData(parcels) {
  parcelsData = parcels;
}

/** Show/hide the results listbox and keep the combobox's aria-expanded in sync. */
function setResultsVisible(visible) {
  const results = document.getElementById("search-results");
  if (results) results.hidden = !visible;
  document.getElementById("search-input")?.setAttribute("aria-expanded", visible ? "true" : "false");
}

export function initSearch() {
  const input = document.getElementById("search-input");
  const clearBtn = document.getElementById("search-clear-btn");
  const results = document.getElementById("search-results");

  input.addEventListener("input", () => {
    clearBtn.hidden = !input.value;
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (q.length < 2) { setResultsVisible(false); return; }
    debounceTimer = setTimeout(() => performSearch(q), 300);
  });

  input.addEventListener("focus", () => {
    if (input.value.trim().length >= 2) {
      setResultsVisible(true);
    }
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { setResultsVisible(false); input.blur(); return; }

    const items = [...results.querySelectorAll(".search-item")];
    if (results.hidden || !items.length) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveItem(items, activeIndex < items.length - 1 ? activeIndex + 1 : 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveItem(items, activeIndex > 0 ? activeIndex - 1 : items.length - 1);
    } else if (e.key === "Enter") {
      if (activeIndex >= 0 && items[activeIndex]) { e.preventDefault(); items[activeIndex].click(); }
    }
  });

  clearBtn.addEventListener("click", () => {
    input.value = "";
    clearBtn.hidden = true;
    setResultsVisible(false);
    input.focus();
  });

  // Close on click outside
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#search-wrapper")) setResultsVisible(false);
  });

  // Delegate clicks on results
  results.addEventListener("click", (e) => {
    const item = e.target.closest(".search-item");
    if (!item) return;

    const action = item.dataset.action;
    if (action === "local") {
      const idx = parseInt(item.dataset.index, 10);
      highlightParcel(idx);
      highlightRow(idx);
    } else if (action === "location") {
      const lat = parseFloat(item.dataset.lat);
      const lng = parseFloat(item.dataset.lng);
      let bbox = null;
      try { bbox = item.dataset.bbox ? JSON.parse(item.dataset.bbox) : null; } catch { /* malformed bbox */ }
      flyToLocation(lng, lat, bbox);
    } else if (action === "layer") {
      addSwisstopoLayer(item.dataset.layerId, item.dataset.title);
    }

    setResultsVisible(false);
    input.value = item.querySelector(".search-item-title").textContent;
  });
}

/** Move the keyboard highlight to item `idx` (or clear it with -1). */
function setActiveItem(items, idx) {
  const input = document.getElementById("search-input");
  items.forEach((el, i) => {
    const on = i === idx;
    el.classList.toggle("active", on);
    el.setAttribute("aria-selected", on ? "true" : "false");
  });
  activeIndex = idx;
  const active = items[idx];
  if (active) {
    active.scrollIntoView({ block: "nearest" });
    input?.setAttribute("aria-activedescendant", active.id);
  } else {
    input?.removeAttribute("aria-activedescendant");
  }
}

async function performSearch(query) {
  const results = document.getElementById("search-results");
  const html = [];

  // Local search
  const localResults = searchLocal(query);
  if (localResults.length) {
    html.push(`<div class="search-section-header">${esc(t("search.section.parcels"))}</div>`);
    for (const r of localResults) {
      html.push(`
        <div class="search-item" data-action="local" data-index="${r.index}">
          <span class="material-symbols-outlined search-item-icon">location_on</span>
          <div>
            <div class="search-item-title">${esc(r.id)}</div>
            <div class="search-item-sub">${esc(r.egrid)} ${r.nummer ? '· ' + esc(t("col.nummer")) + ' ' + esc(r.nummer) : ''}</div>
          </div>
        </div>
      `);
    }
  }

  // Swisstopo searches (locations + layers) in parallel
  const [locationRes, layerRes] = await Promise.allSettled([
    searchSwisstopo(query),
    searchSwisstopoLayers(query),
  ]);

  const locationResults = locationRes.status === "fulfilled" ? locationRes.value : [];
  const layerResults = layerRes.status === "fulfilled" ? layerRes.value : [];

  if (locationResults.length) {
    html.push(`<div class="search-section-header">${esc(t("search.section.locations"))}</div>`);
    for (const r of locationResults) {
      const bboxAttr = r.bbox ? `data-bbox='${JSON.stringify(r.bbox)}'` : "";
      html.push(`
        <div class="search-item" data-action="location" data-lat="${r.lat}" data-lng="${r.lng}" ${bboxAttr}>
          <span class="material-symbols-outlined search-item-icon">map</span>
          <div>
            <div class="search-item-title">${esc(r.label)}</div>
            <div class="search-item-sub">${esc(r.origin)}</div>
          </div>
        </div>
      `);
    }
  }

  if (layerResults.length) {
    html.push(`<div class="search-section-header">${esc(t("search.section.layers"))}</div>`);
    for (const r of layerResults) {
      html.push(`
        <div class="search-item" data-action="layer" data-layer-id="${esc(r.id)}" data-title="${esc(r.title)}">
          <span class="material-symbols-outlined search-item-icon">layers</span>
          <div>
            <div class="search-item-title">${esc(r.title)}</div>
          </div>
        </div>
      `);
    }
  }

  if (html.length === 0) {
    html.push(`<div class="search-empty">${esc(t("search.empty"))}</div>`);
  }

  results.innerHTML = html.join("");

  // Make items keyboard-navigable (role=option + ids for aria-activedescendant)
  results.querySelectorAll(".search-item").forEach((el, i) => {
    el.id = `search-opt-${i}`;
    el.setAttribute("role", "option");
    el.setAttribute("aria-selected", "false");
  });
  activeIndex = -1;
  document.getElementById("search-input")?.removeAttribute("aria-activedescendant");

  setResultsVisible(true);
}

function searchLocal(query) {
  const q = query.toLowerCase();
  const matches = [];
  parcelsData.forEach((p, i) => {
    const searchStr = `${p.id} ${p.egrid} ${p.nummer}`.toLowerCase();
    if (searchStr.includes(q)) {
      matches.push({ index: i, id: p.id, egrid: p.egrid, nummer: p.nummer });
    }
  });
  return matches.slice(0, 5);
}

async function searchSwisstopo(query) {
  const params = new URLSearchParams({
    searchText: query,
    type: "locations",
    sr: "4326",
    limit: "5",
  });

  const resp = await fetchTimeout(`${API.SEARCH}?${params}`);
  if (!resp.ok) return [];
  const data = await resp.json();

  return (data.results || []).map((r) => {
    const attrs = r.attrs || {};
    return {
      label: (attrs.label || "").replace(/<[^>]*>/g, ""),
      origin: attrs.origin || "",
      lat: attrs.lat,
      lng: attrs.lon,
      bbox: attrs.geom_st_box2d ? parseBBox(attrs.geom_st_box2d) : null,
    };
  });
}

async function searchSwisstopoLayers(query) {
  const params = new URLSearchParams({
    searchText: query,
    type: "layers",
    lang: getLang(),
    limit: "5",
  });

  const resp = await fetchTimeout(`${API.SEARCH}?${params}`);
  if (!resp.ok) return [];
  const data = await resp.json();

  return (data.results || []).map((r) => ({
    id: r.attrs?.layer || "",
    title: (r.attrs?.label || r.attrs?.title || "").replace(/<[^>]*>/g, ""),
  })).filter((r) => r.id);
}

function parseBBox(box2d) {
  // "BOX(5.95 45.82,10.49 47.81)" → [5.95, 45.82, 10.49, 47.81]
  const match = box2d.match(/BOX\(([^ ]+) ([^,]+),([^ ]+) ([^)]+)\)/);
  if (!match) return null;
  return [parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3]), parseFloat(match[4])];
}

