/**
 * App state machine: upload → processing → results
 */
import { initUpload, resetUploadView } from "./upload.js";
import { processRows, cancelProcessing } from "./processor.js";
import { initMap, plotResults, highlightParcel, highlightLandcover, highlightBauzonen, highlightHabitat, onSummaryToggle, setSummaryToggleVisible, updateLandcoverColors, setOverlayLayerVisible, showMapSpinner, hideMapSpinner, teardownMap } from "./map.js";
import { showToast } from "./toast.js";
import { initTable, populateTable, highlightRow, highlightLcRow } from "./table.js";
import { downloadParcelCSV, downloadLandcoverCSV, downloadXLSX, downloadGeoJSON } from "./export.js";
import { downloadReportHTML } from "./report.js";
import { initSearch, setSearchData } from "./search.js";
import { ART_LABELS, ART_COLORS, CATEGORY_COLORS, isFound, esc, fmtNum,
         bauzoneColor, habitatColor, habitatL1Label, BRAND,
         getAreaUnit, setAreaUnit, onAreaUnitChange, areaUnitLabel, stripAreaUnit, fmtArea, fmtAreaValue } from "./config.js";
import { t, applyI18nDOM, setLang, getLang, getLocale, onLangChange } from "./i18n.js";

let processedResults = null;
let currentFilename = "";
let currentRunTime = null; // captured once per analysis so re-renders (e.g. a live language switch) keep the original time

document.addEventListener("DOMContentLoaded", () => {
  // Apply i18n to static DOM elements
  applyI18nDOM();
  initLangSelector();

  // Close the mobile overflow (☰) menu — shared by the language/unit/share/new items.
  const closeHeaderMenu = () => {
    const hm = document.getElementById("header-menu");
    if (hm) hm.hidden = true;
    document.getElementById("header-menu-btn")?.setAttribute("aria-expanded", "false");
  };

  // Language now switches live (no reload), so the processed results survive.
  // applyI18nDOM (run inside setLang) handles the static chrome; here we re-render
  // the dynamically-built, language-dependent views and refresh the language UI.
  onLangChange((lang) => {
    const cur = document.getElementById("lang-current");
    if (cur) cur.textContent = lang.toUpperCase();
    document.querySelectorAll("#lang-dropdown .lang-option").forEach((o) => o.classList.toggle("active", o.dataset.lang === lang));
    document.getElementById("lang-dropdown")?.classList.remove("show");
    closeHeaderMenu();
    rerenderResults();
  });

  // Area-unit toggle (ha / m²): the header control + the same buttons in the ☰
  // menu both drive setAreaUnit; on change we refresh the active state, close the
  // menu, and re-render the area-bearing views in place (data stays in m²).
  const unitButtons = () => document.querySelectorAll("#unit-toggle .unit-btn, .header-menu-unit");
  const syncUnitUI = () => unitButtons().forEach((b) => b.classList.toggle("active", b.dataset.unit === getAreaUnit()));
  syncUnitUI();
  unitButtons().forEach((b) => b.addEventListener("click", () => setAreaUnit(b.dataset.unit)));
  onAreaUnitChange(() => { syncUnitUI(); closeHeaderMenu(); rerenderResults(); });

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
    resetUploadView();
    processedResults = null;
    currentFilename = "";
    currentRunTime = null;
    currentAggMode = "landcover"; // reset Flächenanalyse layer selection for the next run
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

  // Share the current view via the system share sheet (mobile + supported desktop
  // browsers); fall back to copying the link where the Web Share API is absent.
  async function shareApp() {
    const url = location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: t("app.title"), url });
      } else {
        await navigator.clipboard.writeText(url);
        showToast(t("share.copied"));
      }
    } catch (err) {
      if (err?.name === "AbortError") return; // user dismissed the share sheet
      try { await navigator.clipboard.writeText(url); showToast(t("share.copied")); } catch { /* clipboard blocked */ }
    }
  }
  document.getElementById("btn-share")?.addEventListener("click", shareApp);

  // Mobile overflow menu (☰): folds Language, Share and New Analysis. The
  // individual header buttons are hidden via CSS on mobile; these items reuse
  // their handlers, so there is one source of truth per action.
  const headerMenuBtn = document.getElementById("header-menu-btn");
  const headerMenu = document.getElementById("header-menu");
  if (headerMenuBtn && headerMenu) {
    const openHeaderMenu = () => {
      // "Neue Analyse" only applies once results exist — mirror the header button.
      document.getElementById("menu-new").hidden = document.getElementById("btn-new").hidden;
      headerMenu.querySelectorAll(".header-menu-lang").forEach((b) => b.classList.toggle("active", b.dataset.lang === getLang()));
      headerMenu.hidden = false;
      headerMenuBtn.setAttribute("aria-expanded", "true");
    };
    headerMenuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      headerMenu.hidden ? openHeaderMenu() : closeHeaderMenu();
    });
    headerMenu.querySelectorAll(".header-menu-lang").forEach((b) => {
      b.addEventListener("click", () => setLang(b.dataset.lang)); // switches language live (no reload)
    });
    document.getElementById("menu-share").addEventListener("click", () => { closeHeaderMenu(); shareApp(); });
    document.getElementById("menu-new").addEventListener("click", () => { closeHeaderMenu(); resetToUpload(); });
    document.addEventListener("click", (e) => { if (!e.target.closest("#header-menu-wrap")) closeHeaderMenu(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !headerMenu.hidden) closeHeaderMenu(); });
  }

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
        await downloadXLSX(processedResults.parcels, processedResults.landcover, processedResults.bauzonen, processedResults.habitat);
      } catch (err) {
        console.error("XLSX export failed:", err);
      }
    }
    closeDownloadModal();
  });
  document.getElementById("dl-geojson").addEventListener("click", () => {
    if (processedResults) downloadGeoJSON(processedResults);
    closeDownloadModal();
  });
  document.getElementById("dl-report").addEventListener("click", async () => {
    if (processedResults) {
      const toast = showToast(t("download.report.generating"), { duration: 60000 });
      try {
        await downloadReportHTML(processedResults, { filename: currentFilename, lang: getLang() });
      } catch (err) {
        console.error("Report export failed:", err);
        showToast(t("toast.report.failed"));
      } finally {
        toast?.remove();
      }
    }
    closeDownloadModal();
  });

  // Embedded-report mode: a downloaded report bakes the results in as JSON and
  // boots straight into the results view (no upload/processing step).
  const embeddedEl = document.getElementById("__embedded_results__");
  if (embeddedEl) {
    try {
      const data = JSON.parse(embeddedEl.textContent);
      // Each flat detail array equals its per-parcel _array concatenated in order
      // (see processRows flatten), so rebuild them instead of embedding twice.
      data.landcover = data.parcels.flatMap((p) => p._landcover || []);
      data.bauzonen = data.parcels.flatMap((p) => p._bauzonen || []);
      data.habitat = data.parcels.flatMap((p) => p._habitat || []);
      processedResults = data;
      currentFilename = window.__EMBEDDED_META__?.filename || "";
      // A report can't regenerate itself (no source files to fetch) — hide that option.
      document.getElementById("dl-report")?.setAttribute("hidden", "");
      showResults();
    } catch (err) {
      console.error("Embedded report failed to load:", err);
    }
  }
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
      for (const f of lc) { if (f._sia416 == null) continue; map[f._sia416] += f.area_m2; }
      return [
        { label: t("agg.ggf"), area: map.GGF, color: CATEGORY_COLORS.GGF, key: "GGF" },
        { label: t("agg.buf"), area: map.BUF, color: CATEGORY_COLORS.BUF, key: "BUF" },
        { label: t("agg.uuf"), area: map.UUF, color: CATEGORY_COLORS.UUF, key: "UUF" },
      ];
    },
    colorFn(props) {
      if (!props.sia416) return "#cccccc"; // unclassified (e.g. BAFU): SIA 416 n/a
      return CATEGORY_COLORS[props.sia416] || "#888";
    },
  },
  din277: {
    get label() { return t("agg.din277"); },
    getEntries(lc) {
      const map = { BF: 0, UF: 0 };
      for (const f of lc) { if (f._din277 == null) continue; map[f._din277] += f.area_m2; }
      return [
        { label: t("agg.bf"), area: map.BF, color: "#c0392b", key: "BF" },
        { label: t("agg.uf"), area: map.UF, color: "#2980b9", key: "UF" },
      ];
    },
    colorFn(props) {
      if (!props.din277) return "#cccccc";
      return props.din277 === "BF" ? "#c0392b" : "#2980b9";
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
      for (const f of lc) { if (f._sealed == null) continue; if (f._sealed) sealed += f.area_m2; else unsealed += f.area_m2; }
      return [
        { label: t("agg.sealed.yes"), area: sealed, color: "#c0392b", key: "sealed" },
        { label: t("agg.sealed.no"), area: unsealed, color: "#27ae60", key: "unsealed" },
      ];
    },
    colorFn(props) {
      if (!props.sealed) return "#cccccc";
      return props.sealed === "yes" ? "#c0392b" : "#27ae60";
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
  // Overlay-layer modes. These read their own result array (mode.source) instead
  // of the land cover, and have no colorFn — their map layer keeps its per-type
  // colours (set in plotResults). Shown in the dropdown only when data exists.
  bauzonen: {
    source: "bauzonen",
    available: () => (processedResults?.bauzonen?.length || 0) > 0,
    get label() { return t("agg.bauzonen"); },
    getEntries(rows) {
      const map = {};
      for (const f of rows) {
        if (!map[f.art]) map[f.art] = { area: 0, code: f.bauzone_code };
        map[f.art].area += f.area_m2;
      }
      return Object.entries(map)
        .map(([k, v]) => ({ label: k, area: v.area, color: bauzoneColor(v.code), key: k }))
        .sort((a, b) => b.area - a.area);
    },
  },
  habitat: {
    source: "habitat",
    available: () => (processedResults?.habitat?.length || 0) > 0,
    get label() { return t("agg.habitat"); },
    getEntries(rows) {
      const map = {};
      for (const f of rows) {
        const key = habitatL1Label(f.art);
        if (!map[key]) map[key] = { area: 0, color: habitatColor(f.art) };
        map[key].area += f.area_m2;
      }
      return Object.entries(map)
        .map(([k, v]) => ({ label: k, area: v.area, color: v.color, key: k }))
        .sort((a, b) => b.area - a.area);
    },
  },
};

// The Flächenanalyse dropdown offers one entry per analysis layer; selecting one
// drives the donut/legend AND which result layer is shown on the map.
const LAYER_MODES = ["landcover", "bauzonen", "habitat"];
let currentAggMode = "landcover";

function updateSummaryPanel() {
  if (!processedResults) return;
  // Reset to the default layer if the selected one is invalid or now unavailable
  // (e.g. a new analysis without that overlay).
  if (!LAYER_MODES.includes(currentAggMode)) currentAggMode = "landcover";
  const m = AGGREGATION_MODES[currentAggMode];
  if (m?.available && !m.available()) currentAggMode = "landcover";
  const parcels = processedResults.parcels;
  const landcover = processedResults.landcover;
  const total = parcels.length;
  const found = parcels.filter((r) => isFound(r.check_egrid)).length;
  const notFound = total - found;

  let totalSealed = 0, totalGreen = 0;
  for (const p of parcels) {
    totalSealed += parseFloat(p.sealed_m2) || 0;
    totalGreen += parseFloat(p.greenspace_m2) || 0;
  }

  const now = currentRunTime || new Date();
  const locale = getLocale();
  const fmt = (n) => fmtNum(n, 1);

  // Build dropdown options
  const modeOptions = LAYER_MODES
    .filter((k) => { const v = AGGREGATION_MODES[k]; return !v.available || v.available(); })
    .map((k) =>
      `<option value="${k}" ${k === currentAggMode ? "selected" : ""}>${esc(AGGREGATION_MODES[k].label)}</option>`
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
          <div class="sp-kpi"><div class="sp-kpi-value">${fmtArea(totalSealed)}</div><div class="sp-kpi-label">${esc(stripAreaUnit(t("summary.sealed")))}</div></div>
          <div class="sp-kpi"><div class="sp-kpi-value">${fmtArea(totalGreen)}</div><div class="sp-kpi-label">${esc(stripAreaUnit(t("summary.green")))}</div></div>
        </div>
        <div class="sp-subsection">
          <div class="sp-subsection-title">${esc(t("agg.greenspace"))}</div>
          <div id="sp-green-container" class="sp-breakdown-list"></div>
        </div>
        <div class="sp-subsection">
          <div class="sp-subsection-title">${esc(t("agg.sia416"))}</div>
          <div id="sp-sia-container" class="sp-breakdown-list"></div>
          <div class="sp-footnote">${esc(t("summary.gsf.note"))}</div>
        </div>
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

  // Layer dropdown — drives the donut/legend and which result layer is on the map.
  document.getElementById("sp-agg-mode")?.addEventListener("change", (e) => {
    currentAggMode = e.target.value;
    renderDonutAndLegend();
    applyAggColorsToMap();
    syncLayerSelection(currentAggMode);
  });

  renderDonutAndLegend();
  // Static breakdowns under "Weitere Kennzahlen" — always the land cover analysis.
  renderBreakdownList("sp-green-container", AGGREGATION_MODES.greenspace.getEntries(landcover));
  renderBreakdownList("sp-sia-container", AGGREGATION_MODES.sia416.getEntries(landcover),
    { total: { label: t("agg.gsf"), color: BRAND.blue } });
}

/** Show only the selected analysis layer on the map and sync its accordion
 *  checkbox; the other two result layers are hidden. */
function syncLayerSelection(selected) {
  const cbIds = { landcover: "layer-toggle-landcover", bauzonen: "layer-toggle-bauzonen-result", habitat: "layer-toggle-habitat-result" };
  for (const key of LAYER_MODES) {
    const on = key === selected;
    setOverlayLayerVisible(key, on);
    const cb = document.getElementById(cbIds[key]);
    if (cb) cb.checked = on;
  }
}

/** Render a static breakdown (coloured dot · label · m² · %) into a container.
 *  `opts.total` prepends an emphasised 100% row whose value is the sum of the
 *  entries (e.g. SIA 416's GSF = whole parcel = GGF + BUF + UUF). */
function renderBreakdownList(containerId, entries, opts = {}) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const list = entries.filter((e) => e.area > 0);
  const total = list.reduce((s, e) => s + e.area, 0);
  const fmt = (n) => fmtNum(n, 1);
  const pct = (a) => (total > 0 ? ((a / total) * 100).toFixed(1) : "0");
  const row = (color, label, area, p, cls = "") => `
    <div class="sp-legend-row ${cls}">
      <span class="sp-dist-dot" style="background:${color}"></span>
      <span class="sp-legend-label">${esc(label)}</span>
      <span class="sp-legend-val">${fmtArea(area)}</span>
      <span class="sp-legend-pct">${p}%</span>
    </div>`;
  let html = "";
  if (opts.total && total > 0) html += row(opts.total.color || "var(--gray-500)", opts.total.label, total, "100.0");
  html += list.map((e) => row(e.color, e.label, e.area, pct(e.area))).join("");
  el.innerHTML = html;
}

function renderDonutAndLegend() {
  const mode = AGGREGATION_MODES[currentAggMode];
  const data = processedResults[mode.source || "landcover"] || [];
  const entries = mode.getEntries(data);
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
      hitArcs += `<circle class="donut-hit" cx="64" cy="64" r="${R}" fill="none" stroke="transparent" stroke-width="${HIT_SW}" stroke-dasharray="${arc} ${C - arc}" stroke-dashoffset="${offset}" data-label="${esc(e.label)}" data-value="${fmtArea(e.area)}" data-pct="${pctOf(e.area)}%" data-color="${e.color}"><title>${esc(e.label)}: ${fmtArea(e.area)} (${pctOf(e.area)}%)</title></circle>`;
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
        <div class="sp-donut-value" id="sp-donut-val">${fmtAreaValue(totalArea)}</div>
        <div class="sp-donut-label" id="sp-donut-lbl">${esc(areaUnitLabel())} ${esc(stripAreaUnit(t("summary.total")))}</div>
      </div>
      <div class="sp-donut-tooltip" id="sp-donut-tooltip" hidden></div>
    </div>
  `;

  // Hover: update center text with segment info
  const centerVal = document.getElementById("sp-donut-val");
  const centerLbl = document.getElementById("sp-donut-lbl");
  const defaultVal = fmtAreaValue(totalArea);
  const defaultLbl = `${areaUnitLabel()} ${stripAreaUnit(t("summary.total"))}`;

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
        <span class="sp-legend-val">${fmtArea(e.area)}</span>
        <span class="sp-legend-pct">${pctOf(e.area)}%</span>
      </div>
    `).join("");

  document.getElementById("sp-legend-container").innerHTML = legendHtml;
}

function applyAggColorsToMap() {
  const mode = AGGREGATION_MODES[currentAggMode];
  // Overlay-layer modes have no colorFn — their map layer keeps its per-type colours.
  if (!mode.colorFn) return;
  updateLandcoverColors(mode.colorFn);
}

/** Re-render the dynamic, locale-/unit-dependent result views in place — used by
 *  the live language and area-unit switches (the data stays in memory). */
function rerenderResults() {
  if (!processedResults) return;
  updateSummaryPanel();
  populateTable(processedResults.parcels, processedResults.landcover, processedResults.bauzonen, processedResults.habitat);
}

function showResults() {
  showState("results");
  currentRunTime = new Date(); // stamp the run once; updateSummaryPanel reuses it across re-renders
  updateSummaryPanel();

  const isMobile = window.innerWidth <= 767;
  const isCompact = window.innerWidth <= 1280;
  const isShortScreen = window.innerHeight <= 800;

  // On compact/mobile: collapse the summary to give the map more space. The toggle
  // control that re-opens it is created in initMap, so its visibility is synced
  // there (below) once it exists — setting it here would act on a not-yet-created control.
  document.getElementById("summary-panel").classList.toggle("collapsed", isMobile || isCompact);

  initTable(document.getElementById("results-table-container"), {
    onParcelSelect: (index) => highlightParcel(index),
    onLandcoverSelect: (lcIndex) => highlightLandcover(lcIndex),
    onBauzonenSelect: (i) => highlightBauzonen(i),
    onHabitatSelect: (i) => highlightHabitat(i),
  });
  populateTable(processedResults.parcels, processedResults.landcover, processedResults.bauzonen, processedResults.habitat);

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

  // Hide the overlay map toggles when their layer wasn't analysed / has no data
  // (keeps the Analyseergebnisse list consistent with the table tabs + dropdown).
  const overlayHas = { "bauzonen-result": processedResults.bauzonen, "habitat-result": processedResults.habitat };
  for (const [key, rows] of Object.entries(overlayHas)) {
    const item = document.querySelector(`[data-internal-layer="${key}"]`);
    if (item) item.hidden = !(rows && rows.length);
  }

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
      syncLayerSelection(currentAggMode);
      // The summary toggle control exists only now — show it iff the panel is
      // collapsed, so there's always a way to re-open the summary on mobile/compact.
      setSummaryToggleVisible(document.getElementById("summary-panel").classList.contains("collapsed"));
    } catch (err) {
      console.error("Map initialization failed:", err);
      showToast(t("toast.map.failed"));
    } finally {
      hideMapSpinner();
    }
  });
}

