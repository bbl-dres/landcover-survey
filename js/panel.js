/**
 * Left accordion panel: Parcels list, SIA 416 overview, Bodenbedeckung by Art, Status
 */
import { ART_LABELS, CATEGORY_COLORS, ART_COLORS } from "./config.js";
import { highlightParcel } from "./map.js";
import { highlightRow } from "./table.js";

let panelOpen = false;

export function initPanel() {
  const toggle = document.getElementById("panel-toggle");
  const panel = document.getElementById("left-panel");

  toggle.addEventListener("click", () => {
    panelOpen = !panelOpen;
    panel.classList.toggle("open", panelOpen);
    toggle.classList.toggle("open", panelOpen);
  });

  // Accordion section toggles
  panel.addEventListener("click", (e) => {
    const header = e.target.closest(".acc-header");
    if (header) {
      header.parentElement.classList.toggle("open");
      return;
    }

    // Parcel item click
    const item = e.target.closest(".parcel-item");
    if (item) {
      const idx = parseInt(item.dataset.index, 10);
      highlightParcel(idx);
      highlightRow(idx);
    }
  });
}

export function populatePanel(results) {
  const parcels = results.parcels;
  const content = document.getElementById("panel-content");

  // Parcel list
  const parcelListHtml = parcels.map((p, i) => {
    const statusClass = p.check_egrid === "EGRID gefunden" ? "ok" : "err";
    return `<div class="parcel-item parcel-${statusClass}" data-index="${i}">
      <span class="parcel-item-id">${esc(p.id)}</span>
      <span class="parcel-item-area">${p.parcel_area_m2 ? p.parcel_area_m2 + ' m²' : '—'}</span>
    </div>`;
  }).join("");

  // SIA 416 summary
  let totalGGF = 0, totalBUF = 0, totalUUF = 0;
  for (const p of parcels) {
    totalGGF += parseFloat(p.GGF_m2) || 0;
    totalBUF += parseFloat(p.BUF_m2) || 0;
    totalUUF += parseFloat(p.UUF_m2) || 0;
  }
  const totalSIA = totalGGF + totalBUF + totalUUF;
  const fmt = (n) => n.toLocaleString("de-CH", { maximumFractionDigits: 1 });
  const bar = (val, color) => {
    const pct = totalSIA > 0 ? (val / totalSIA * 100) : 0;
    return `<div class="acc-bar-row">
      <span class="acc-bar-dot" style="background:${color}"></span>
      <div class="acc-bar-track"><div class="acc-bar-fill" style="width:${pct}%;background:${color}"></div></div>
      <span class="acc-bar-val">${fmt(val)} m²</span>
    </div>`;
  };

  // Bodenbedeckung by Art
  const artTotals = {};
  for (const p of parcels) {
    for (const [k, v] of Object.entries(p)) {
      if (k.endsWith("_m2") && !["GGF_m2", "BUF_m2", "UUF_m2", "DIN277_BF_m2", "DIN277_UF_m2", "Sealed_m2", "GreenSpace_m2", "parcel_area_m2"].includes(k)) {
        const art = k.replace(/_m2$/, "");
        artTotals[art] = (artTotals[art] || 0) + (parseFloat(v) || 0);
      }
    }
  }
  const artEntries = Object.entries(artTotals).sort((a, b) => b[1] - a[1]);
  const artHtml = artEntries.map(([art, area]) => {
    const color = ART_COLORS[art] || "#888";
    const label = ART_LABELS[art] || art;
    return `<div class="acc-art-row">
      <span class="acc-bar-dot" style="background:${color}"></span>
      <span class="acc-art-label">${esc(label)}</span>
      <span class="acc-art-val">${fmt(area)} m²</span>
    </div>`;
  }).join("");

  // Status summary
  const found = parcels.filter((p) => p.check_egrid === "EGRID gefunden").length;
  const notFound = parcels.filter((p) => p.check_egrid === "EGRID nicht gefunden").length;
  const invalid = parcels.filter((p) => p.check_egrid === "Ungültiges EGRID").length;
  const errors = parcels.length - found - notFound - invalid;

  content.innerHTML = `
    <div class="acc-section open" data-section="parcels">
      <div class="acc-header">
        <span>Parzellen (${parcels.length})</span>
        <span class="material-symbols-outlined acc-arrow">expand_more</span>
      </div>
      <div class="acc-body">${parcelListHtml}</div>
    </div>

    <div class="acc-section" data-section="sia416">
      <div class="acc-header">
        <span>SIA 416</span>
        <span class="material-symbols-outlined acc-arrow">expand_more</span>
      </div>
      <div class="acc-body">
        ${bar(totalGGF, CATEGORY_COLORS.GGF)}
        <div class="acc-bar-label">GGF (Gebäude): ${fmt(totalGGF)} m²</div>
        ${bar(totalBUF, CATEGORY_COLORS.BUF)}
        <div class="acc-bar-label">BUF (Bearbeitet): ${fmt(totalBUF)} m²</div>
        ${bar(totalUUF, CATEGORY_COLORS.UUF)}
        <div class="acc-bar-label">UUF (Unbearbeitet): ${fmt(totalUUF)} m²</div>
      </div>
    </div>

    <div class="acc-section" data-section="art">
      <div class="acc-header">
        <span>Bodenbedeckung</span>
        <span class="material-symbols-outlined acc-arrow">expand_more</span>
      </div>
      <div class="acc-body">${artHtml || '<span class="acc-empty">Keine Daten</span>'}</div>
    </div>

    <div class="acc-section" data-section="status">
      <div class="acc-header">
        <span>Status</span>
        <span class="material-symbols-outlined acc-arrow">expand_more</span>
      </div>
      <div class="acc-body">
        <div class="acc-status-row"><span class="acc-status-dot ok"></span> Gefunden: <strong>${found}</strong></div>
        <div class="acc-status-row"><span class="acc-status-dot warn"></span> Nicht gefunden: <strong>${notFound}</strong></div>
        <div class="acc-status-row"><span class="acc-status-dot err"></span> Ungültig: <strong>${invalid}</strong></div>
        ${errors > 0 ? `<div class="acc-status-row"><span class="acc-status-dot err"></span> Fehler: <strong>${errors}</strong></div>` : ''}
      </div>
    </div>
  `;
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}
