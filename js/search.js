/**
 * Search bar: local parcel search + swisstopo location search
 */
import { API } from "./config.js";
import { highlightParcel, flyToLocation } from "./map.js";
import { highlightRow } from "./table.js";

let parcelsData = []; // set by main.js after processing
let debounceTimer = null;

export function setSearchData(parcels) {
  parcelsData = parcels;
}

export function initSearch() {
  const input = document.getElementById("search-input");
  const clearBtn = document.getElementById("search-clear-btn");
  const results = document.getElementById("search-results");

  input.addEventListener("input", () => {
    clearBtn.hidden = !input.value;
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (q.length < 2) { results.hidden = true; return; }
    debounceTimer = setTimeout(() => performSearch(q), 300);
  });

  input.addEventListener("focus", () => {
    if (input.value.trim().length >= 2) {
      results.hidden = false;
    }
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { results.hidden = true; input.blur(); }
  });

  clearBtn.addEventListener("click", () => {
    input.value = "";
    clearBtn.hidden = true;
    results.hidden = true;
    input.focus();
  });

  // Close on click outside
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#search-wrapper")) results.hidden = true;
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
      const bbox = item.dataset.bbox ? JSON.parse(item.dataset.bbox) : null;
      flyToLocation(lng, lat, bbox);
    }

    results.hidden = true;
    input.value = item.querySelector(".search-item-title").textContent;
  });
}

async function performSearch(query) {
  const results = document.getElementById("search-results");
  const html = [];

  // Local search
  const localResults = searchLocal(query);
  if (localResults.length) {
    html.push('<div class="search-section-header">Parzellen</div>');
    for (const r of localResults) {
      html.push(`
        <div class="search-item" data-action="local" data-index="${r.index}">
          <span class="material-symbols-outlined search-item-icon">location_on</span>
          <div>
            <div class="search-item-title">${esc(r.id)}</div>
            <div class="search-item-sub">${esc(r.egrid)} ${r.nummer ? '· Nr. ' + esc(r.nummer) : ''}</div>
          </div>
        </div>
      `);
    }
  }

  // Swisstopo location search
  try {
    const locationResults = await searchSwisstopo(query);
    if (locationResults.length) {
      html.push('<div class="search-section-header">Orte</div>');
      for (const r of locationResults) {
        const bboxAttr = r.bbox ? `data-bbox='${JSON.stringify(r.bbox)}'` : "";
        html.push(`
          <div class="search-item" data-action="location" data-lat="${r.lat}" data-lng="${r.lng}" ${bboxAttr}>
            <span class="material-symbols-outlined search-item-icon">map</span>
            <div>
              <div class="search-item-title">${r.label}</div>
              <div class="search-item-sub">${esc(r.origin)}</div>
            </div>
          </div>
        `);
      }
    }
  } catch (err) {
    console.warn("Swisstopo search failed:", err);
  }

  if (html.length === 0) {
    html.push('<div class="search-empty">Keine Ergebnisse</div>');
  }

  results.innerHTML = html.join("");
  results.hidden = false;
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

  const resp = await fetch(`${API.SEARCH}?${params}`);
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

function parseBBox(box2d) {
  // "BOX(5.95 45.82,10.49 47.81)" → [5.95, 45.82, 10.49, 47.81]
  const match = box2d.match(/BOX\(([^ ]+) ([^,]+),([^ ]+) ([^)]+)\)/);
  if (!match) return null;
  return [parseFloat(match[1]), parseFloat(match[2]), parseFloat(match[3]), parseFloat(match[4])];
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}
