/**
 * Upload view: drop zone, file input, mode toggle, demo file. The reading itself —
 * CSV / SAP list / header + EGRID normalisation — is the pure module userinput.js
 * (mirrored by processing-cli/src/user_input.py); only Excel is read here, because
 * SheetJS is a browser global loaded on demand.
 */
import { loadScript } from "./config.js";
import { t } from "./i18n.js";
import { initParcelPicker, resetParcelPicker } from "./parcelpicker.js";
import { InputError, decodeText, parseText, excelCellStr, normalizeParsed } from "./userinput.js";

let onReady = null;

/** Analysis options shared by both modes (batch + single parcel). */
export function getUploadOptions() {
  return {
    bauzonen: !!document.getElementById("opt-bauzonen")?.checked,
    habitat: !!document.getElementById("opt-habitat")?.checked,
    greeninv: !!document.getElementById("opt-greeninv")?.checked,
  };
}

export function initUpload(callback) {
  onReady = callback;
  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("file-input");
  initModeToggle();

  dropZone.addEventListener("click", () => fileInput.click());
  // The zone is role="button": Enter / Space must open the file dialog too.
  dropZone.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    fileInput.click();
  });
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener("change", () => {
    if (!fileInput.files.length) return;
    const file = fileInput.files[0];
    // Clear the selection: the browser fires no `change` when the same file is picked
    // again, e.g. after a "missing columns" error was fixed and saved under the same name.
    fileInput.value = "";
    handleFile(file);
  });

  const demoLink = document.getElementById("load-demo");
  if (demoLink) {
    demoLink.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      loadDemoFile();
    });
  }

  // Establish the default mode (single-parcel picker), which also eagerly builds
  // the picker map. Skip it when a downloaded report boots straight into results:
  // the upload view isn't shown there until "Neue Analyse" (which calls
  // resetUploadView and inits the picker then).
  if (!document.getElementById("__embedded_results__")) setMode(DEFAULT_MODE);
}

/* ── Mode toggle: single-parcel picker (default) vs batch CSV upload ── */

const DEFAULT_MODE = "single";
let pickerInited = false;

function initModeToggle() {
  const tabBatch = document.getElementById("mode-tab-batch");
  const tabSingle = document.getElementById("mode-tab-single");
  if (!tabBatch || !tabSingle) return;
  tabBatch.addEventListener("click", () => setMode("batch"));
  tabSingle.addEventListener("click", () => setMode("single"));
}

function setMode(mode) {
  const single = mode === "single";
  const tabBatch = document.getElementById("mode-tab-batch");
  const tabSingle = document.getElementById("mode-tab-single");
  tabBatch?.classList.toggle("active", !single);
  tabSingle?.classList.toggle("active", single);
  tabBatch?.setAttribute("aria-selected", String(!single));
  tabSingle?.setAttribute("aria-selected", String(single));

  const batch = document.getElementById("mode-batch");
  const singleEl = document.getElementById("mode-single");
  const analyze = document.getElementById("single-analyze");
  if (batch) batch.hidden = single;
  if (singleEl) singleEl.hidden = !single;     // shown before init so the map sizes correctly
  if (analyze) analyze.hidden = !single;
  hideError();

  if (single && !pickerInited) {
    pickerInited = true;
    initParcelPicker({ onAnalyze: (data) => onReady && onReady(data), getOptions: getUploadOptions });
  }
}

/** Return the upload view to its default state: default tab, default parcel
 *  re-selected, and the analysis options back to their defaults (overlays on, green
 *  inventory off). */
export function resetUploadView() {
  resetParcelPicker();
  setMode(DEFAULT_MODE);
  const bz = document.getElementById("opt-bauzonen");
  const hb = document.getElementById("opt-habitat");
  const gi = document.getElementById("opt-greeninv");
  if (bz) bz.checked = true;
  if (hb) hb.checked = true;
  if (gi) gi.checked = false;
}

async function loadDemoFile() {
  try {
    const response = await fetch("../data/example.csv");
    if (!response.ok) throw new Error("Could not load demo file");
    const text = await response.text();
    const blob = new Blob([text], { type: "text/csv" });
    const file = new File([blob], "example.csv", { type: "text/csv" });
    handleFile(file);
  } catch (err) {
    console.error("Failed to load demo file:", err);
    showError(t("upload.error.demo"));
  }
}

async function handleFile(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  hideError();

  try {
    let parsedData;

    if (ext === "csv" || ext === "tsv" || ext === "txt") {
      parsedData = parseText(decodeText(await readFileBuffer(file)));
    } else if (ext === "xlsx" || ext === "xls") {
      parsedData = await parseExcel(file);
    } else {
      showError(t("upload.error.format"));
      return;
    }

    // Required columns, lowercase headers, trimmed cells, canonical EGRID.
    parsedData = normalizeParsed(parsedData);
    parsedData.filename = file.name;
    parsedData.options = getUploadOptions();
    if (onReady) onReady(parsedData);
  } catch (err) {
    if (err instanceof InputError) { showError(err.message); return; }
    console.error("File parse error:", err);
    showError(t("upload.error.read", { error: err?.message || String(err) }));
  }
}

function showError(msg) {
  const el = document.getElementById("upload-error");
  el.textContent = msg;
  el.hidden = false;
}

function hideError() {
  const el = document.getElementById("upload-error");
  el.textContent = "";
  el.hidden = true;
}

function readFileBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = () => reject(new Error(reader.error?.message || "FileReader"));
    reader.readAsArrayBuffer(file);
  });
}

/** First sheet of an Excel file → { headers, rows }, every cell a string. */
async function parseExcel(file) {
  if (!window.XLSX) {
    try {
      await loadScript("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js");
    } catch {
      throw new Error(t("export.xlsx.error")); // the library could not be loaded (offline / blocked CDN)
    }
  }
  const wb = XLSX.read(await readFileBuffer(file), { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const jsonData = XLSX.utils.sheet_to_json(ws, { defval: "" });
  if (!jsonData.length) throw new Error(t("upload.error.sheet"));
  const headers = Object.keys(jsonData[0]);
  const rows = jsonData.map((row) => {
    const clean = {};
    headers.forEach((h) => (clean[h] = excelCellStr(row[h])));
    return clean;
  });
  return { headers, rows };
}
