/**
 * App state machine: upload → processing → results
 */
import { initUpload } from "./upload.js";
import { processRows, cancelProcessing } from "./processor.js";
import { initMap, plotResults, highlightParcel, highlightLandcover, onSummaryToggle, setSummaryToggleVisible, updateLandcoverColors, showMapSpinner, hideMapSpinner, teardownMap } from "./map.js";
import { showToast } from "./toast.js";
import { initTable, populateTable, highlightRow, highlightLcRow } from "./table.js";
import { downloadParcelCSV, downloadLandcoverCSV, downloadXLSX, downloadGeoJSON } from "./export.js";
import { initSearch, setSearchData } from "./search.js";
import { ART_LABELS, ART_COLORS, CATEGORY_COLORS, isFound, esc, fmtNum } from "./config.js";
import { t, applyI18nDOM, setLang, getLang, getLocale } from "./i18n.js";

let processedResults = null;
let currentFilename = "";

document.addEventListener("DOMContentLoaded", () => {
  // Apply i18n to static DOM elements
  applyI18nDOM();
  initLangSelector();

  initUpload(onStartProcessing);
  initSearch();

  // Cancel
  document.getElementById("btn-cancel").addEventListener("click", () => cancelProcessing());

  // Table toggle
  document.getElementById("tbl-toggle").addEventListener("click", () => {
    const panel = document.getElementById("results-table-container");
    const btn = document.getElementById("tbl-toggle");
    const collapsed = !panel.classList.contains("collapsed");
    panel.style.height = ""; // Clear inline height from resize drag
    panel.style.maxHeight = ""; // Restore CSS max-height
    panel.classList.toggle("collapsed", collapsed);
    btn.classList.toggle("collapsed", collapsed);
    // The map resizes itself via a ResizeObserver (see initMap) when the panel changes size.
  });

  // Reset
  function resetToUpload() {
    cancelProcessing();
    teardownMap();
    processedResults = null;
    currentFilename = "";
    showState("upload");
    document.getElementById("btn-new").hidden = true;
    document.getElementById("btn-download").hidden = true;
    document.getElementById("search-wrapper").hidden = true;
    document.getElementById("file-input").value = "";
    const err = document.getElementById("upload-error");
    if (err) { err.hidden = true; err.textContent = ""; }
  }

  document.getElementById("btn-new").addEventListener("click", resetToUpload);
  document.querySelector(".header-left").addEventListener("click", resetToUpload);

  // Summary panel
  document.getElementById("sp-close").addEventListener("click", () => {
    document.getElementById("summary-panel").classList.add("collapsed");
    setSummaryToggleVisible(true);
  });
  onSummaryToggle(() => {
    document.getElementById("summary-panel").classList.remove("collapsed");
    setSummaryToggleVisible(false);
  });

  // Download modal
  const dlOverlay = document.getElementById("download-overlay");
  const dlModal = dlOverlay.querySelector(".dl-modal");
  let lastFocusedEl = null;

  function openDownloadModal() {
    lastFocusedEl = document.activeElement;
    dlOverlay.hidden = false;
    const firstOption = dlModal.querySelector(".dl-option");
    if (firstOption) firstOption.focus();
  }

  function closeDownloadModal() {
    dlOverlay.hidden = true;
    if (lastFocusedEl) lastFocusedEl.focus();
  }

  dlOverlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeDownloadModal(); return; }
    if (e.key !== "Tab") return;
    const focusable = dlModal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  document.getElementById("btn-download").addEventListener("click", openDownloadModal);
  document.getElementById("dl-close").addEventListener("click", closeDownloadModal);
  dlOverlay.addEventListener("click", (e) => { if (e.target === dlOverlay) closeDownloadModal(); });

  document.getElementById("dl-parcels-csv").addEventListener("click", () => {
    if (processedResults) downloadParcelCSV(processedResults.parcels);
    closeDownloadModal();
  });
  document.getElementById("dl-lc-csv").addEventListener("click", () => {
    if (processedResults) downloadLandcoverCSV(processedResults.landcover);
    closeDownloadModal();
  });
  document.getElementById("dl-xlsx").addEventListener("click", async () => {
    if (processedResults) {
      try {
        await downloadXLSX(processedResults.parcels, processedResults.landcover);
      } catch (err) {
        console.error("XLSX export failed:", err);
      }
    }
    closeDownloadModal();
  });
  document.getElementById("dl-geojson").addEventListener("click", () => {
    if (processedResults) downloadGeoJSON(processedResults.parcels);
    closeDownloadModal();
  });
});

function initLangSelector() {
  const btn = document.getElementById("lang-btn");
  const dropdown = document.getElementById("lang-dropdown");
  const current = document.getElementById("lang-current");
  if (!btn || !dropdown) return;

  current.textContent = getLang().toUpperCase();

  // Highlight active language
  dropdown.querySelectorAll(".lang-option").forEach((opt) => {
    opt.classList.toggle("active", opt.dataset.lang === getLang());
  });

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    dropdown.classList.toggle("show");
  });

  dropdown.addEventListener("click", (e) => {
    const opt = e.target.closest(".lang-option");
    if (!opt) return;
    setLang(opt.dataset.lang);
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest("#lang-selector")) dropdown.classList.remove("show");
  });
}

function showState(state) {
  document.querySelectorAll(".app-state").forEach((el) => {
    el.hidden = el.id !== `state-${state}`;
  });
  // Note: the map self-corrects its size via a ResizeObserver in initMap(),
  // so no timer-based resize is needed when entering the results view.
}

async function onStartProcessing(parsedData) {
  showState("processing");
  currentFilename = parsedData.filename || "";
  const startTime = Date.now();

  try {
    processedResults = await processRows(parsedData.rows, (progress) => {
      updateProgress(progress, startTime);
    }, parsedData.options);

    if (!processedResults || !processedResults.parcels.length) {
      showState("upload");
      const err = document.getElementById("upload-error");
      if (err) { err.textContent = t("upload.error.empty"); err.hidden = false; }
      return;
    }

    progressEls.barFill.style.width = "100%";
    progressEls.bar.setAttribute("aria-valuenow", "100");

    showResults();
  } catch (err) {
    console.error("Processing failed:", err);
    showState("upload");
    const errEl = document.getElementById("upload-error");
    if (errEl) { errEl.textContent = t("upload.error.read", { error: err.message }); errEl.hidden = false; }
  }
}

// Cached DOM refs for the progress hot path (queried once, reused hundreds of times)
const progressEls = {};

function cacheProgressEls() {
  progressEls.barFill = document.getElementById("progress-bar-fill");
  progressEls.bar = document.querySelector(".progress-bar");
  progressEls.text = document.getElementById("progress-text");
  progressEls.eta = document.getElementById("progress-eta");
  progressEls.stats = document.getElementById("progress-stats");
}

function updateProgress(progress, startTime) {
  if (!progressEls.barFill) cacheProgressEls();

  const { processed, total, succeeded, failed } = progress;
  const pct = total > 0 ? ((processed / total) * 100).toFixed(1) : 0;

  progressEls.barFill.style.width = `${pct}%`;
  progressEls.bar.setAttribute("aria-valuenow", Math.round(pct));
  progressEls.text.textContent = t("processing.parcel", { processed, total, pct });

  const elapsed = Date.now() - startTime;
  const perItem = processed > 0 ? elapsed / processed : 0;
  const remaining = perItem * (total - processed);
  const etaSeconds = Math.ceil(remaining / 1000);
  const etaMin = Math.floor(etaSeconds / 60);
  const etaSec = etaSeconds % 60;
  progressEls.eta.textContent =
    processed < total ? t("processing.eta", { min: etaMin, sec: etaSec }) : t("processing.finishing");
  progressEls.stats.textContent = t("processing.stats", { succeeded, failed });
}

/* ── Aggregation modes for Flächenanalyse ── */

const AGGREGATION_MODES = {
  landcover: {
    get label() { return t("agg.landcover"); },
    getEntries(lc) {
      const map = {};
      for (const f of lc) {
        const key = f.art;
        map[key] = (map[key] || 0) + f.area_m2;
      }
      return Object.entries(map)
        .map(([k, v]) => ({ label: ART_LABELS[k] || k, area: v, color: ART_COLORS[k] || "#888", key: k }))
        .sort((a, b) => b.area - a.area);
    },
    colorFn(props) { return ART_COLORS[props.art] || "#888"; },
  },
  sia416: {
    get label() { return t("agg.sia416"); },
    getEntries(lc) {
      // SIA 416 is AV-only — BAFU rows can't supply it, so they're excluded.
      const map = { GGF: 0, BUF: 0, UUF: 0 };
      for (const f of lc) { if (f._bafu) continue; const cls = f._sia416 || "UUF"; map[cls] += f.area_m2; }
      return [
        { label: t("agg.ggf"), area: map.GGF, color: CATEGORY_COLORS.GGF, key: "GGF" },
        { label: t("agg.buf"), area: map.BUF, color: CATEGORY_COLORS.BUF, key: "BUF" },
        { label: t("agg.uuf"), area: map.UUF, color: CATEGORY_COLORS.UUF, key: "UUF" },
      ];
    },
    colorFn(props) {
      if (props.bafu) return "#cccccc"; // BAFU rows: SIA 416 not derived
      const cls = props.sia416 || "UUF";
      return CATEGORY_COLORS[cls] || "#888";
    },
  },
  din277: {
    get label() { return t("agg.din277"); },
    getEntries(lc) {
      const map = { BF: 0, UF: 0 };
      for (const f of lc) { if (f._bafu) continue; const cls = f._din277 || "UF"; map[cls] += f.area_m2; }
      return [
        { label: t("agg.bf"), area: map.BF, color: "#c0392b", key: "BF" },
        { label: t("agg.uf"), area: map.UF, color: "#2980b9", key: "UF" },
      ];
    },
    colorFn(props) {
      if (props.bafu) return "#cccccc";
      return (props.din277 || "UF") === "BF" ? "#c0392b" : "#2980b9";
    },
  },
  greenspace: {
    get label() { return t("agg.greenspace"); },
    getEntries(lc) {
      const map = { "soil": 0, "wooded": 0, "none": 0 };
      for (const f of lc) {
        const gs = f.check_greenspace;
        if (gs === "Green space (soil-covered)") map.soil += f.area_m2;
        else if (gs === "Green space (wooded)") map.wooded += f.area_m2;
        else map.none += f.area_m2;
      }
      return [
        { label: t("agg.green.soil"), area: map.soil, color: "#27ae60", key: "soil" },
        { label: t("agg.green.wooded"), area: map.wooded, color: "#1e8449", key: "wooded" },
        { label: t("agg.green.none"), area: map.none, color: "#95a5a6", key: "none" },
      ];
    },
    colorFn(props) {
      const gs = props.greenspace;
      if (gs === "Green space (soil-covered)") return "#27ae60";
      if (gs === "Green space (wooded)") return "#1e8449";
      return "#95a5a6";
    },
  },
  sealed: {
    get label() { return t("agg.sealed"); },
    getEntries(lc) {
      let sealed = 0, unsealed = 0;
      for (const f of lc) { if (f._bafu) continue; if (f._sealed) sealed += f.area_m2; else unsealed += f.area_m2; }
      return [
        { label: t("agg.sealed.yes"), area: sealed, color: "#c0392b", key: "sealed" },
        { label: t("agg.sealed.no"), area: unsealed, color: "#27ae60", key: "unsealed" },
      ];
    },
    colorFn(props) {
      if (props.bafu) return "#cccccc";
      return props.sealed ? "#c0392b" : "#27ae60";
    },
  },
  vbsKategorie: {
    get label() { return t("agg.vbs.kategorie"); },
    getEntries(lc) {
      const map = { kat_a: 0, kat_b: 0, kat_c: 0, kat_d: 0 };
      for (const f of lc) { const k = f._vbsKategorie || "kat_d"; map[k] += f.area_m2; }
      return [
        { label: t("agg.vbs.kat_a"), area: map.kat_a, color: "#e74c3c", key: "kat_a" },
        { label: t("agg.vbs.kat_b"), area: map.kat_b, color: "#27ae60", key: "kat_b" },
        { label: t("agg.vbs.kat_c"), area: map.kat_c, color: "#1e8449", key: "kat_c" },
        { label: t("agg.vbs.kat_d"), area: map.kat_d, color: "#95a5a6", key: "kat_d" },
      ];
    },
    colorFn(props) {
      const k = props.vbsKategorie || "kat_d";
      return { kat_a: "#e74c3c", kat_b: "#27ae60", kat_c: "#1e8449", kat_d: "#95a5a6" }[k];
    },
  },
  vbsProduktiv: {
    get label() { return t("agg.vbs.produktiv"); },
    getEntries(lc) {
      const map = { produktiv: 0, unproduktiv: 0 };
      for (const f of lc) { const p = f._vbsProduktiv || "unproduktiv"; map[p] += f.area_m2; }
      return [
        { label: t("agg.vbs.produktiv.yes"), area: map.produktiv, color: "#27ae60", key: "produktiv" },
        { label: t("agg.vbs.produktiv.no"), area: map.unproduktiv, color: "#95a5a6", key: "unproduktiv" },
      ];
    },
    colorFn(props) {
      return (props.vbsProduktiv || "unproduktiv") === "produktiv" ? "#27ae60" : "#95a5a6";
    },
  },
  vbsTyp: {
    get label() { return t("agg.vbs.typ"); },
    getEntries(lc) {
      const map = { typ1: 0, typ2: 0, none: 0 };
      for (const f of lc) {
        const typ = f._vbsTyp;
        if (typ === "typ1") map.typ1 += f.area_m2;
        else if (typ === "typ2") map.typ2 += f.area_m2;
        else map.none += f.area_m2;
      }
      return [
        { label: t("agg.vbs.typ1"), area: map.typ1, color: "#27ae60", key: "typ1" },
        { label: t("agg.vbs.typ2"), area: map.typ2, color: "#1e8449", key: "typ2" },
        { label: t("agg.vbs.produktiv.no"), area: map.none, color: "#95a5a6", key: "none" },
      ];
    },
    colorFn(props) {
      const typ = props.vbsTyp;
      if (typ === "typ1") return "#27ae60";
      if (typ === "typ2") return "#1e8449";
      return "#95a5a6";
    },
  },
};

let currentAggMode = "landcover";

function updateSummaryPanel() {
  if (!processedResults) return;
  const parcels = processedResults.parcels;
  const landcover = processedResults.landcover;
  const total = parcels.length;
  const found = parcels.filter((r) => isFound(r.check_egrid)).length;
  const notFound = total - found;

  let totalSealed = 0, totalGreen = 0;
  for (const p of parcels) {
    totalSealed += parseFloat(p.Sealed_m2) || 0;
    totalGreen += parseFloat(p.GreenSpace_m2) || 0;
  }

  const now = new Date();
  const locale = getLocale();
  const fmt = (n) => fmtNum(n, 1);

  // Build dropdown options
  const modeOptions = Object.entries(AGGREGATION_MODES).map(([k, v]) =>
    `<option value="${k}" ${k === currentAggMode ? "selected" : ""}>${esc(v.label)}</option>`
  ).join("");

  document.getElementById("sp-body").innerHTML = `
    <!-- Section 1: Parzellen-Zuordnung -->
    <div class="sp-collapse-section open" data-sp-section="overview">
      <div class="sp-collapse-header">
        <span class="material-symbols-outlined sp-collapse-arrow">expand_more</span>
        <span>${esc(t("summary.parcels"))}</span>
      </div>
      <div class="sp-collapse-content">
        <div class="sp-meta-row">
          <span class="sp-meta-filename">${esc(currentFilename)}</span>
          <span class="sp-meta-sep">&middot;</span>
          <span>${now.toLocaleDateString(locale, { dateStyle: "medium" })}, ${now.toLocaleTimeString(locale, { timeStyle: "short" })}</span>
        </div>
        <div class="sp-kpi-grid" style="margin-top:var(--space-3)">
          <div class="sp-kpi"><div class="sp-kpi-value sp-color-good">${found}</div><div class="sp-kpi-label">${esc(t("summary.found"))}</div></div>
          <div class="sp-kpi"><div class="sp-kpi-value sp-color-poor">${notFound}</div><div class="sp-kpi-label">${esc(t("summary.notFound"))}</div></div>
        </div>
      </div>
    </div>

    <!-- Section 2: Flächenanalyse -->
    <div class="sp-collapse-section open" data-sp-section="area">
      <div class="sp-collapse-header">
        <span class="material-symbols-outlined sp-collapse-arrow">expand_more</span>
        <span>${esc(t("summary.area"))}</span>
        <select id="sp-agg-mode" class="sp-agg-select">${modeOptions}</select>
      </div>
      <div class="sp-collapse-content">
        <div id="sp-donut-container"></div>
        <div id="sp-legend-container"></div>
      </div>
    </div>

    <!-- Section 3: Weitere Kennzahlen -->
    <div class="sp-collapse-section open" data-sp-section="extra">
      <div class="sp-collapse-header">
        <span class="material-symbols-outlined sp-collapse-arrow">expand_more</span>
        <span>${esc(t("summary.extra"))}</span>
      </div>
      <div class="sp-collapse-content">
        <div class="sp-kpi-grid">
          <div class="sp-kpi"><div class="sp-kpi-value">${fmt(totalSealed)}</div><div class="sp-kpi-label">${esc(t("summary.sealed"))}</div></div>
          <div class="sp-kpi"><div class="sp-kpi-value">${fmt(totalGreen)}</div><div class="sp-kpi-label">${esc(t("summary.green"))}</div></div>
        </div>
        <div id="sp-bauzonen-container" class="sp-bauzonen-list"></div>
      </div>
    </div>
  `;

  // Section collapse toggles
  document.querySelectorAll(".sp-collapse-header").forEach((header) => {
    header.addEventListener("click", (e) => {
      if (e.target.closest(".sp-agg-select")) return; // don't toggle when clicking dropdown
      header.parentElement.classList.toggle("open");
    });
  });

  // Aggregation dropdown
  document.getElementById("sp-agg-mode")?.addEventListener("change", (e) => {
    currentAggMode = e.target.value;
    renderDonutAndLegend();
    applyAggColorsToMap();
  });

  renderDonutAndLegend();
  renderBauzonenList();
}

function renderDonutAndLegend() {
  const landcover = processedResults.landcover;
  const mode = AGGREGATION_MODES[currentAggMode];
  const entries = mode.getEntries(landcover);
  const totalArea = entries.reduce((s, e) => s + e.area, 0);

  const fmt = (n) => fmtNum(n, 1);
  const pctOf = (part) => totalArea > 0 ? ((part / totalArea) * 100).toFixed(1) : "0";

  // Donut SVG
  const R = 54, SW = 10, HIT_SW = 20;
  const C = 2 * Math.PI * R;
  let offset = C * 0.25;
  let arcs = "";
  let hitArcs = "";
  for (const e of entries) {
    const arc = totalArea > 0 ? (e.area / totalArea) * C : 0;
    if (arc > 0.01) {
      arcs += `<circle cx="64" cy="64" r="${R}" fill="none" stroke="${e.color}" stroke-width="${SW}" stroke-dasharray="${arc} ${C - arc}" stroke-dashoffset="${offset}" />`;
      // Invisible wider hit area for hover
      hitArcs += `<circle class="donut-hit" cx="64" cy="64" r="${R}" fill="none" stroke="transparent" stroke-width="${HIT_SW}" stroke-dasharray="${arc} ${C - arc}" stroke-dashoffset="${offset}" data-label="${esc(e.label)}" data-value="${fmt(e.area)} m²" data-pct="${pctOf(e.area)}%" data-color="${e.color}"><title>${esc(e.label)}: ${fmt(e.area)} m² (${pctOf(e.area)}%)</title></circle>`;
    }
    offset -= arc;
  }

  document.getElementById("sp-donut-container").innerHTML = `
    <div class="sp-donut-wrap">
      <svg class="sp-donut" viewBox="0 0 128 128">
        <circle cx="64" cy="64" r="${R}" fill="none" stroke="var(--gray-200)" stroke-width="${SW}" />
        ${arcs}
        ${hitArcs}
      </svg>
      <div class="sp-donut-text" id="sp-donut-center">
        <div class="sp-donut-value" id="sp-donut-val">${fmt(totalArea)}</div>
        <div class="sp-donut-label" id="sp-donut-lbl">m² Total</div>
      </div>
      <div class="sp-donut-tooltip" id="sp-donut-tooltip" hidden></div>
    </div>
  `;

  // Hover: update center text with segment info
  const centerVal = document.getElementById("sp-donut-val");
  const centerLbl = document.getElementById("sp-donut-lbl");
  const defaultVal = fmt(totalArea);
  const defaultLbl = t("summary.total");

  document.querySelectorAll(".donut-hit").forEach((hit) => {
    hit.addEventListener("mouseenter", () => {
      centerVal.textContent = hit.dataset.value;
      centerLbl.textContent = hit.dataset.label;
      centerVal.style.color = hit.dataset.color;
    });
    hit.addEventListener("mouseleave", () => {
      centerVal.textContent = defaultVal;
      centerLbl.textContent = defaultLbl;
      centerVal.style.color = "";
    });
  });

  // Legend
  const legendHtml = entries
    .filter((e) => e.area > 0)
    .map((e) => `
      <div class="sp-legend-row">
        <span class="sp-dist-dot" style="background:${e.color}"></span>
        <span class="sp-legend-label">${esc(e.label)}</span>
        <span class="sp-legend-val">${fmt(e.area)} m²</span>
        <span class="sp-legend-pct">${pctOf(e.area)}%</span>
      </div>
    `).join("");

  document.getElementById("sp-legend-container").innerHTML = legendHtml;
}

function applyAggColorsToMap() {
  const mode = AGGREGATION_MODES[currentAggMode];
  updateLandcoverColors(mode.colorFn);
}

/** Bauzonen breakdown list in the summary's "Weitere Kennzahlen" section — totals
 *  per zone type across all parcels (no donut). Only renders when the opt-in
 *  Bauzonen analysis was run (the bauzonen_<zone>_m2 columns exist). */
function renderBauzonenList() {
  const el = document.getElementById("sp-bauzonen-container");
  if (!el) return;

  const totals = {};
  for (const p of processedResults.parcels) {
    for (const k in p) {
      if (k.startsWith("bauzonen_") && k.endsWith("_m2") && k !== "bauzonen_m2") {
        const name = k.slice(9, -3); // strip "bauzonen_" … "_m2"
        totals[name] = (totals[name] || 0) + (parseFloat(p[k]) || 0);
      }
    }
  }

  const entries = Object.entries(totals).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length) { el.innerHTML = ""; return; }

  const total = entries.reduce((s, [, v]) => s + v, 0);
  const fmt = (n) => fmtNum(n, 1);
  const rows = entries.map(([name, v]) => `
    <div class="sp-legend-row">
      <span class="sp-dist-dot" style="background:var(--gray-400)"></span>
      <span class="sp-legend-label">${esc(name)}</span>
      <span class="sp-legend-val">${fmt(v)} m²</span>
      <span class="sp-legend-pct">${total > 0 ? ((v / total) * 100).toFixed(1) : "0"}%</span>
    </div>`).join("");

  el.innerHTML = `<div class="sp-bauzonen-title">${esc(t("col.bauzonen"))}</div>${rows}`;
}

function showResults() {
  showState("results");
  updateSummaryPanel();

  const isMobile = window.innerWidth <= 767;
  const isCompact = window.innerWidth <= 1280;
  const isShortScreen = window.innerHeight <= 800;

  // On compact/mobile: collapse summary to give map more space
  if (isMobile || isCompact) {
    document.getElementById("summary-panel").classList.add("collapsed");
    setSummaryToggleVisible(true);
  } else {
    document.getElementById("summary-panel").classList.remove("collapsed");
    setSummaryToggleVisible(false);
  }

  initTable(document.getElementById("results-table-container"), {
    onParcelSelect: (index) => highlightParcel(index),
    onLandcoverSelect: (lcIndex) => highlightLandcover(lcIndex),
  });
  populateTable(processedResults.parcels, processedResults.landcover);

  // On mobile or short screens: start with table collapsed so map gets full space
  if (isMobile || isShortScreen) {
    const tablePanel = document.getElementById("results-table-container");
    const tblBtn = document.getElementById("tbl-toggle");
    tablePanel.classList.add("collapsed");
    tblBtn.classList.add("collapsed");
  }

  // Show search bar + header buttons
  document.getElementById("search-wrapper").hidden = false;
  document.getElementById("btn-download").hidden = false;
  document.getElementById("btn-new").hidden = false;
  setSearchData(processedResults.parcels);

  requestAnimationFrame(async () => {
    showMapSpinner();
    try {
      // Load the empty basemap first, then layer the results on top.
      await initMap("results-map", {
        onParcelSelect: (index) => highlightRow(index),
        onLandcoverSelect: (lcIndex) => highlightLcRow(lcIndex),
      });
      plotResults(processedResults);
      applyAggColorsToMap();
    } catch (err) {
      console.error("Map initialization failed:", err);
      showToast(t("toast.map.failed"));
    } finally {
      hideMapSpinner();
    }
  });
}

