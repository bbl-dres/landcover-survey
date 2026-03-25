/**
 * File parsing and validation — CSV with ID + EGRID columns
 */

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
    const response = await fetch("data/example.csv");
    if (!response.ok) throw new Error("Could not load demo file");
    const text = await response.text();
    const blob = new Blob([text], { type: "text/csv" });
    const file = new File([blob], "example.csv", { type: "text/csv" });
    handleFile(file);
  } catch (err) {
    console.error("Failed to load demo file:", err);
    showError("Beispieldaten konnten nicht geladen werden.");
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
      showError("Nicht unterstütztes Dateiformat. Bitte CSV oder XLSX hochladen.");
      return;
    }

    if (!parsedData.headers.length || !parsedData.rows.length) {
      showError("Die Datei ist leer oder enthält keine Datenzeilen.");
      return;
    }

    const lowerHeaders = parsedData.headers.map((h) => h.toLowerCase().trim());
    const missing = REQUIRED_COLUMNS.filter((c) => !lowerHeaders.includes(c));
    if (missing.length > 0) {
      showError(`Fehlende Spalten: ${missing.join(", ")}. Gefunden: ${parsedData.headers.join(", ")}`);
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
    showError("Fehler beim Lesen der Datei: " + err.message);
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
      const firstLine = text.split("\n")[0];
      const semicolons = (firstLine.match(/;/g) || []).length;
      const commas = (firstLine.match(/,/g) || []).length;
      const tabs = (firstLine.match(/\t/g) || []).length;
      let delimiter = ",";
      if (semicolons > commas && semicolons > tabs) delimiter = ";";
      else if (tabs > commas) delimiter = "\t";

      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) return reject(new Error("Datei enthält nur eine Kopfzeile."));

      const headers = parseLine(lines[0], delimiter);
      const rows = [];
      for (let i = 1; i < lines.length; i++) {
        const values = parseLine(lines[i], delimiter);
        if (values.some((v) => v.trim())) {
          const row = {};
          headers.forEach((h, idx) => (row[h] = values[idx] || ""));
          rows.push(row);
        }
      }
      resolve({ headers, rows });
    };
    reader.onerror = reject;
    reader.readAsText(file, "utf-8");
  });
}

function parseLine(line, delimiter) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        result.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
  }
  result.push(current.trim());
  return result;
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
        if (!jsonData.length) return reject(new Error("Leeres Arbeitsblatt."));
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

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}
