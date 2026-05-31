/**
 * File parsing and validation — CSV with ID + EGRID columns
 */
import { loadScript } from "./config.js";
import { t } from "./i18n.js";

const REQUIRED_COLUMNS = ["id", "egrid"];

let onReady = null;

export function initUpload(callback) {
  onReady = callback;
  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("file-input");

  dropZone.addEventListener("click", () => fileInput.click());
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
    if (fileInput.files.length) handleFile(fileInput.files[0]);
  });

  const demoLink = document.getElementById("load-demo");
  if (demoLink) {
    demoLink.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      loadDemoFile();
    });
  }
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
      parsedData = await parseCSV(file);
    } else if (ext === "xlsx" || ext === "xls") {
      parsedData = await parseExcel(file);
    } else {
      showError(t("upload.error.format"));
      return;
    }

    if (!parsedData.headers.length || !parsedData.rows.length) {
      showError(t("upload.error.empty"));
      return;
    }

    const lowerHeaders = parsedData.headers.map((h) => h.toLowerCase().trim());
    const missing = REQUIRED_COLUMNS.filter((c) => !lowerHeaders.includes(c));
    if (missing.length > 0) {
      showError(t("upload.error.columns", { missing: missing.join(", "), found: parsedData.headers.join(", ") }));
      return;
    }

    // Normalize headers to lowercase
    parsedData.rows = parsedData.rows.map((row) => {
      const normalized = {};
      parsedData.headers.forEach((h) => {
        normalized[h.toLowerCase().trim()] = row[h] ?? "";
      });
      return normalized;
    });
    parsedData.headers = parsedData.headers.map((h) => h.toLowerCase().trim());

    parsedData.filename = file.name;
    if (onReady) onReady(parsedData);
  } catch (err) {
    console.error("File parse error:", err);
    showError(t("upload.error.read", { error: err.message }));
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

function parseCSV(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      const delimiter = detectDelimiter(text);

      const matrix = tokenizeDelimited(text, delimiter)
        .map((cells) => cells.map((c) => c.trim()))
        .filter((cells) => cells.some((c) => c !== "")); // drop blank lines

      if (matrix.length < 2) return reject(new Error(t("upload.error.header")));

      const headers = matrix[0];
      const rows = matrix.slice(1).map((values) => {
        const row = {};
        headers.forEach((h, idx) => (row[h] = values[idx] || ""));
        return row;
      });
      resolve({ headers, rows });
    };
    reader.onerror = reject;
    reader.readAsText(file, "utf-8");
  });
}

/**
 * Detect the delimiter from the first line. Heuristic: counts raw `;`, `,`, tab
 * — it does not account for a delimiter appearing inside a quoted header cell
 * (rare for ID/EGRID lists). Defaults to comma.
 */
function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const semicolons = (firstLine.match(/;/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  const tabs = (firstLine.match(/\t/g) || []).length;
  if (semicolons > commas && semicolons > tabs) return ";";
  if (tabs > commas) return "\t";
  return ",";
}

/**
 * Single-pass RFC-4180 tokenizer: splits the whole text into rows of fields,
 * correctly handling quoted fields that contain the delimiter, quotes (`""`),
 * or newlines. Returns an array of string arrays (one per row).
 */
function tokenizeDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let sawAny = false; // did this row have any character (so trailing data flushes)?

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; sawAny = true; }
    else if (ch === delimiter) { row.push(field); field = ""; sawAny = true; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; sawAny = false; }
    else if (ch === "\r") { /* ignore; LF terminates the row */ }
    else { field += ch; sawAny = true; }
  }
  // Flush the final field/row if the text didn't end with a newline.
  if (sawAny || field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

async function parseExcel(file) {
  if (!window.XLSX) {
    await loadScript("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js");
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json(ws, { defval: "" });
        if (!jsonData.length) return reject(new Error(t("upload.error.sheet")));
        const headers = Object.keys(jsonData[0]);
        const rows = jsonData.map((row) => {
          const clean = {};
          headers.forEach((h) => (clean[h] = String(row[h] ?? "")));
          return clean;
        });
        resolve({ headers, rows });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

