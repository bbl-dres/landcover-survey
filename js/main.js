/**
 * App state machine: upload → processing → results
 */
import { initUpload } from "./upload.js";
import { processRows, cancelProcessing } from "./processor.js";
import { initMap, plotResults, highlightParcel, resizeMap, onSummaryToggle, setSummaryToggleVisible } from "./map.js";
import { initTable, populateTable, highlightRow } from "./table.js";
import { downloadParcelCSV, downloadLandcoverCSV, downloadXLSX, downloadGeoJSON } from "./export.js";
import { initSearch, setSearchData } from "./search.js";
import { initPanel, populatePanel } from "./panel.js";
import { ART_LABELS, CATEGORY_COLORS } from "./config.js";

let processedResults = null;
let currentFilename = "";

document.addEventListener("DOMContentLoaded", () => {
  initUpload(onStartProcessing);
  initSearch();
  initPanel();

  // Cancel
  document.getElementById("btn-cancel").addEventListener("click", () => cancelProcessing());

  // Reset
  function resetToUpload() {
    cancelProcessing();
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
    setTimeout(() => resizeMap(), 280);
  });
  onSummaryToggle(() => {
    document.getElementById("summary-panel").classList.remove("collapsed");
    setSummaryToggleVisible(false);
    setTimeout(() => resizeMap(), 280);
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
  document.getElementById("dl-xlsx").addEventListener("click", () => {
    if (processedResults) downloadXLSX(processedResults.parcels, processedResults.landcover);
    closeDownloadModal();
  });
  document.getElementById("dl-geojson").addEventListener("click", () => {
    if (processedResults) downloadGeoJSON(processedResults.parcels);
    closeDownloadModal();
  });
});

function showState(state) {
  document.querySelectorAll(".app-state").forEach((el) => {
    el.hidden = el.id !== `state-${state}`;
  });
  if (state === "results") setTimeout(() => resizeMap(), 100);
}

async function onStartProcessing(parsedData) {
  showState("processing");
  currentFilename = parsedData.filename || "";
  const startTime = Date.now();

  processedResults = await processRows(parsedData.rows, (progress) => {
    updateProgress(progress, startTime);
  });

  document.getElementById("progress-bar-fill").style.width = "100%";
  document.querySelector(".progress-bar").setAttribute("aria-valuenow", "100");

  showResults();
}

function updateProgress(progress, startTime) {
  const { processed, total, succeeded, failed } = progress;
  const pct = total > 0 ? ((processed / total) * 100).toFixed(1) : 0;

  document.getElementById("progress-bar-fill").style.width = `${pct}%`;
  document.querySelector(".progress-bar").setAttribute("aria-valuenow", Math.round(pct));
  document.getElementById("progress-text").textContent = `Parzelle ${processed} von ${total} — ${pct}%`;

  const elapsed = Date.now() - startTime;
  const perItem = processed > 0 ? elapsed / processed : 0;
  const remaining = perItem * (total - processed);
  const etaSeconds = Math.ceil(remaining / 1000);
  const etaMin = Math.floor(etaSeconds / 60);
  const etaSec = etaSeconds % 60;
  document.getElementById("progress-eta").textContent =
    processed < total ? `Noch ca. ${etaMin} Min ${etaSec} Sek` : "Wird abgeschlossen...";
  document.getElementById("progress-stats").textContent = `Gefunden: ${succeeded} · Fehler: ${failed}`;
}

function updateSummaryPanel() {
  if (!processedResults) return;
  const parcels = processedResults.parcels;
  const total = parcels.length;
  const found = parcels.filter((r) => r.check_egrid === "EGRID gefunden").length;
  const notFound = total - found;

  let totalArea = 0, totalGGF = 0, totalBUF = 0, totalUUF = 0, totalSealed = 0, totalGreen = 0;
  for (const p of parcels) {
    totalArea += parseFloat(p.parcel_area_m2) || 0;
    totalGGF += parseFloat(p.GGF_m2) || 0;
    totalBUF += parseFloat(p.BUF_m2) || 0;
    totalUUF += parseFloat(p.UUF_m2) || 0;
    totalSealed += parseFloat(p.Sealed_m2) || 0;
    totalGreen += parseFloat(p.GreenSpace_m2) || 0;
  }

  const fmt = (n) => n.toLocaleString("de-CH", { maximumFractionDigits: 1 });
  const pctOf = (part) => totalArea > 0 ? ((part / totalArea) * 100).toFixed(1) : "0";

  const donutRadius = 54, donutStroke = 10;
  const donutCirc = 2 * Math.PI * donutRadius;
  const ggfArc = (totalArea > 0 ? totalGGF / totalArea : 0) * donutCirc;
  const bufArc = (totalArea > 0 ? totalBUF / totalArea : 0) * donutCirc;
  const uufArc = (totalArea > 0 ? totalUUF / totalArea : 0) * donutCirc;
  const ggfOffset = donutCirc * 0.25;
  const bufOffset = ggfOffset - ggfArc;
  const uufOffset = bufOffset - bufArc;

  // File meta in summary panel
  const now = new Date();
  document.getElementById("sp-meta").innerHTML = `
    <div class="sp-meta-row">
      <span class="sp-meta-filename">${escHtml(currentFilename)}</span>
      <span class="sp-meta-sep">&middot;</span>
      <span>${now.toLocaleDateString("de-CH", { dateStyle: "medium" })}, ${now.toLocaleTimeString("de-CH", { timeStyle: "short" })}</span>
    </div>
  `;

  document.getElementById("sp-body").innerHTML = `
    <div class="sp-donut-wrap">
      <svg class="sp-donut" viewBox="0 0 128 128">
        <circle cx="64" cy="64" r="${donutRadius}" fill="none" stroke="var(--gray-200)" stroke-width="${donutStroke}" />
        <circle cx="64" cy="64" r="${donutRadius}" fill="none" stroke="${CATEGORY_COLORS.GGF}" stroke-width="${donutStroke}" stroke-dasharray="${ggfArc} ${donutCirc - ggfArc}" stroke-dashoffset="${ggfOffset}" />
        <circle cx="64" cy="64" r="${donutRadius}" fill="none" stroke="${CATEGORY_COLORS.BUF}" stroke-width="${donutStroke}" stroke-dasharray="${bufArc} ${donutCirc - bufArc}" stroke-dashoffset="${bufOffset}" />
        <circle cx="64" cy="64" r="${donutRadius}" fill="none" stroke="${CATEGORY_COLORS.UUF}" stroke-width="${donutStroke}" stroke-dasharray="${uufArc} ${donutCirc - uufArc}" stroke-dashoffset="${uufOffset}" />
      </svg>
      <div class="sp-donut-text">
        <div class="sp-donut-value">${fmt(totalArea)}</div>
        <div class="sp-donut-label">m² Total</div>
      </div>
    </div>
    <div class="sp-divider"></div>
    <div class="sp-section">
      <div class="sp-section-header"><span class="sp-section-title">SIA 416 Aufteilung</span><span class="sp-section-count">${total} Parzellen</span></div>
      <div class="sp-dist-row"><span class="sp-dist-dot" style="background:${CATEGORY_COLORS.GGF}"></span><span class="sp-dist-label">GGF (Gebäude)</span><span class="sp-dist-val">${fmt(totalGGF)} m² (${pctOf(totalGGF)}%)</span></div>
      <div class="sp-dist-row"><span class="sp-dist-dot" style="background:${CATEGORY_COLORS.BUF}"></span><span class="sp-dist-label">BUF (Bearbeitet)</span><span class="sp-dist-val">${fmt(totalBUF)} m² (${pctOf(totalBUF)}%)</span></div>
      <div class="sp-dist-row"><span class="sp-dist-dot" style="background:${CATEGORY_COLORS.UUF}"></span><span class="sp-dist-label">UUF (Unbearbeitet)</span><span class="sp-dist-val">${fmt(totalUUF)} m² (${pctOf(totalUUF)}%)</span></div>
    </div>
    <div class="sp-divider"></div>
    <div class="sp-section">
      <div class="sp-section-title">Weitere Kennzahlen</div>
      <div class="sp-kpi-grid">
        <div class="sp-kpi"><div class="sp-kpi-value">${fmt(totalSealed)}</div><div class="sp-kpi-label">Versiegelt m²</div></div>
        <div class="sp-kpi"><div class="sp-kpi-value">${fmt(totalGreen)}</div><div class="sp-kpi-label">Grünfläche m²</div></div>
        <div class="sp-kpi"><div class="sp-kpi-value sp-color-good">${found}</div><div class="sp-kpi-label">Gefunden</div></div>
        <div class="sp-kpi"><div class="sp-kpi-value sp-color-poor">${notFound}</div><div class="sp-kpi-label">Nicht gefunden</div></div>
      </div>
    </div>
  `;
}

function showResults() {
  showState("results");
  updateSummaryPanel();

  document.getElementById("summary-panel").classList.remove("collapsed");
  setSummaryToggleVisible(false);

  initTable(document.getElementById("results-table-container"), (index) => highlightParcel(index));
  populateTable(processedResults.parcels, processedResults.landcover);

  // Show search bar + header buttons
  document.getElementById("search-wrapper").hidden = false;
  document.getElementById("btn-download").hidden = false;
  document.getElementById("btn-new").hidden = false;
  setSearchData(processedResults.parcels);

  // Populate left panel
  populatePanel(processedResults);

  requestAnimationFrame(async () => {
    await initMap("results-map", (index) => highlightRow(index));
    plotResults(processedResults);
  });
}

function escHtml(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}
