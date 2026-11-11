/**
 * User parcel-list reader — the pure part of the upload (no DOM), mirrored function
 * for function by processing-cli/src/user_input.py so one file behaves the same in
 * the browser and in the CLI:
 *
 * - .csv / .tsv / .txt: UTF-8 (BOM stripped), else Windows-1252. An Excel `sep=<d>`
 *   hint line wins; otherwise the delimiter is detected from the header line
 *   (`;` / tab / `,`). Quoted fields may hold the delimiter, quotes (`""`) and line
 *   breaks. Cells are trimmed, blank lines dropped; a row shorter than the header is
 *   padded, cells beyond the header are dropped;
 * - an SAP «Dynamische Listenausgabe» .txt (pipe-framed table whose header row starts
 *   with `|BuKr`): `id` = BuKr/WE/Grundstk, `egrid` = E-GRID, every other named column
 *   passed through;
 * - Excel: first sheet (read in upload.js, SheetJS is a browser global), cells
 *   stringified by excelCellStr;
 * - headers are lowercased + trimmed, the required `id` / `egrid` columns matched
 *   case-insensitively, a duplicate header lets the last column win; the EGRID is
 *   canonicalised (normalizeEgrid).
 *
 * Nothing is interpreted: a cell reading `NA` or `null` stays that text.
 * processing-cli/tests/test_parity_js.py runs both readers on the same texts.
 */
import { normalizeEgrid } from "./config.js";
import { t } from "./i18n.js";

export const REQUIRED_COLUMNS = ["id", "egrid"];

/** An error whose message is already written for the user (shown as is). */
export class InputError extends Error {}

/** Bytes of a text file → string: UTF-8 (BOM stripped), else Windows-1252 (what Excel
 *  and SAP write on a German Windows). Mirror of _decode_text(). */
export function decodeText(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("windows-1252").decode(buffer);
  }
}

/**
 * Detect the delimiter from the header line (the first non-blank one). Heuristic:
 * counts raw `;`, `,`, tab — it does not account for a delimiter inside a quoted
 * header cell (rare for ID/EGRID lists). Semicolon only wins outright, tab beats
 * comma, ties fall back to comma.
 */
export function detectDelimiter(text) {
  const firstLine = text.split(/\r\n|\n|\r/).find((l) => l.trim() !== "") || "";
  const semicolons = (firstLine.match(/;/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  const tabs = (firstLine.match(/\t/g) || []).length;
  if (semicolons > commas && semicolons > tabs) return ";";
  if (tabs > commas) return "\t";
  return ",";
}

/**
 * Single-pass RFC-4180 tokenizer: splits the whole text into rows of fields,
 * handling quoted fields that contain the delimiter, quotes (`""`) or line breaks.
 * Returns an array of string arrays (one per row).
 *
 * A quote opens a quoted field only at the start of a field (leading blanks
 * allowed). Anywhere else it is an ordinary character — `Halle 3" breit` used to
 * open a quoted field that swallowed the rest of the file. A quoted field that is
 * never closed is an error, not a one-row file.
 */
export function tokenizeDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let quoteLine = 0; // line on which the open quote started (for the error)
  let line = 1;
  let sawAny = false; // did this row have any character (so trailing data flushes)?

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.trim() === "") { inQuotes = true; quoteLine = line; sawAny = true; }
    else if (ch === delimiter) { row.push(field); field = ""; sawAny = true; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++; // CRLF is one line break; a lone CR is one too
      row.push(field); rows.push(row); row = []; field = ""; sawAny = false; line++;
    } else { field += ch; sawAny = true; }
  }
  if (inQuotes) throw new Error(t("upload.error.quote", { line: quoteLine }));
  // Flush the final field/row if the text didn't end with a line break.
  if (sawAny || field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** Delimited text → { headers, rows }. */
export function parseDelimited(raw) {
  let text = raw;
  // Honour a leading Excel "sep=<d>" hint line (written by some locales' CSV exports);
  // otherwise auto-detect.
  const sepHint = /^"?sep=(.)"?(?:\r\n|\n|\r)/i.exec(text);
  const delimiter = sepHint ? sepHint[1] : detectDelimiter(text);
  if (sepHint) text = text.slice(sepHint[0].length);

  const matrix = tokenizeDelimited(text, delimiter)
    .map((cells) => cells.map((c) => c.trim()))
    .filter((cells) => cells.some((c) => c !== "")); // drop blank lines

  if (matrix.length < 2) throw new Error(t("upload.error.header"));

  const headers = matrix[0];
  const rows = matrix.slice(1).map((values) => {
    const row = {};
    headers.forEach((h, idx) => (row[h] = values[idx] || ""));
    return row;
  });
  return { headers, rows };
}

/**
 * Recognise an SAP "Dynamische Listenausgabe" export: a pipe-delimited .txt whose
 * column header row starts with `|BuKr` (banner/metadata lines sit above it).
 */
export function isSapExport(text) {
  return /^\|BuKr\|/m.test(text);
}

/**
 * Parse an SAP "Dynamische Listenausgabe" export into the standard {headers, rows}
 * shape. The report is pipe-delimited with enclosing pipes and banner rows above the
 * header; the dashed rules and page footer are skipped. We synthesize the two required
 * columns — `id` = BuKr/WE/Grundstk and `egrid` = E-GRID — and pass every other named
 * column through unchanged, so the pipeline maps it to input_<name> like any CSV column.
 * A data row with a different number of cells than the header (a `|` inside a value
 * would shift every column after it) stops the read with its line number.
 */
export function parseSAP(text) {
  const lines = text.split(/\r?\n/);
  const hi = lines.findIndex((l) => l.startsWith("|BuKr"));
  if (hi < 0) throw new Error(t("upload.error.sap"));

  // "|a |b  |c|" → ["a","b","c"]: split on the pipe, then drop the empty edge cells
  // produced by the leading and trailing pipes, and trim each field's padding.
  const splitRow = (line) => {
    const cells = line.split("|");
    return cells.slice(1, cells.length - 1).map((c) => c.trim());
  };

  const rawHeaders = splitRow(lines[hi]);
  const colIndex = (name) => rawHeaders.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const iBuKr = colIndex("BuKr"), iWE = colIndex("WE"), iGrundstk = colIndex("Grundstk"), iEgrid = colIndex("E-GRID");
  if (iBuKr < 0 || iWE < 0 || iGrundstk < 0 || iEgrid < 0) throw new Error(t("upload.error.sap"));

  // Pass-through columns: every named column except the id parts + E-GRID (consumed above).
  const consumed = new Set([iBuKr, iWE, iGrundstk, iEgrid]);
  const passCols = rawHeaders
    .map((name, i) => ({ name, i }))
    .filter((c) => c.name !== "" && !consumed.has(c.i));

  const headers = ["id", "egrid", ...passCols.map((c) => c.name)];
  const rows = [];
  for (let i = hi + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\|\s*\d/.test(line)) continue; // skip the dashed rules, blank lines, and the footer
    const cells = splitRow(line);
    if (cells.length !== rawHeaders.length) {
      throw new Error(t("upload.error.sapRow", { line: i + 1, cells: cells.length, expected: rawHeaders.length }));
    }
    const bukr = cells[iBuKr], we = cells[iWE], grundstk = cells[iGrundstk];
    if (!bukr && !we && !grundstk) continue;
    const row = { id: `${bukr}/${we}/${grundstk}`, egrid: cells[iEgrid] };
    passCols.forEach((c) => { row[c.name] = cells[c.i]; });
    rows.push(row);
  }
  return { headers, rows };
}

/** Text of a .csv / .tsv / .txt → { headers, rows }: an SAP list export goes to its
 *  own reader, everything else to the generic delimited parser. */
export function parseText(text) {
  return isSapExport(text) ? parseSAP(text) : parseDelimited(text);
}

/** Stringify an Excel cell value as read by SheetJS (numbers as numbers, dates as
 *  serial numbers): `1086` not `1086.0`, booleans lower-case, empty → "". Mirror of
 *  _excel_cell_str(). */
export function excelCellStr(v) {
  return v === null || v === undefined ? "" : String(v);
}

/**
 * The upload contract: check the required columns, lowercase + trim the headers, trim
 * every cell and canonicalise the EGRID. A column without a header (a trailing
 * delimiter in the header row) is dropped; a duplicate lowercased header lets the last
 * column win. Throws InputError for an empty list or missing columns.
 */
export function normalizeParsed({ headers, rows }) {
  if (!headers.length || !rows.length) throw new InputError(t("upload.error.empty"));

  const lower = headers.map((h) => String(h).toLowerCase().trim());
  const missing = REQUIRED_COLUMNS.filter((c) => !lower.includes(c));
  if (missing.length > 0) {
    throw new InputError(t("upload.error.columns", { missing: missing.join(", "), found: headers.join(", ") }));
  }

  const outRows = rows.map((row) => {
    const normalized = {};
    headers.forEach((h, i) => {
      if (lower[i] !== "") normalized[lower[i]] = String(row[h] ?? "").trim();
    });
    normalized.egrid = normalizeEgrid(normalized.egrid);
    return normalized;
  });
  return { headers: [...new Set(lower.filter((h) => h !== ""))], rows: outRows };
}
