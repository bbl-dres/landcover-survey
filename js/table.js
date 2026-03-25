/**
 * Results table with sorting and pagination
 */
import { ART_LABELS } from "./config.js";

let allResults = [];
let sortField = "id";
let sortAsc = true;
let currentPage = 0;
let pageSize = 25;
let onRowClick = null;
let container = null;

const PARCEL_COLUMNS = [
  { key: "id", label: "ID" },
  { key: "egrid", label: "EGRID" },
  { key: "nummer", label: "Nr." },
  { key: "bfsnr", label: "BFSNr" },
  { key: "check_egrid", label: "Status" },
  { key: "parcel_area_m2", label: "Parzelle m²", numeric: true },
  { key: "GGF_m2", label: "GGF m²", numeric: true },
  { key: "BUF_m2", label: "BUF m²", numeric: true },
  { key: "UUF_m2", label: "UUF m²", numeric: true },
  { key: "Sealed_m2", label: "Versiegelt m²", numeric: true },
  { key: "GreenSpace_m2", label: "Grünfläche m²", numeric: true },
];

export function initTable(el, clickCallback) {
  container = el;
  onRowClick = clickCallback;
}

export function populateTable(results) {
  allResults = results;
  currentPage = 0;
  render();
}

export function highlightRow(index) {
  if (!container) return;
  container.querySelectorAll("tr.highlighted").forEach((r) => r.classList.remove("highlighted"));
  const row = container.querySelector(`tr[data-index="${index}"]`);
  if (row) {
    row.classList.add("highlighted");
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function render() {
  if (!container) return;

  // Sort
  const sorted = [...allResults].sort((a, b) => {
    const col = PARCEL_COLUMNS.find((c) => c.key === sortField);
    let va = a[sortField] ?? "";
    let vb = b[sortField] ?? "";
    if (col?.numeric) {
      va = parseFloat(va) || 0;
      vb = parseFloat(vb) || 0;
    }
    if (va < vb) return sortAsc ? -1 : 1;
    if (va > vb) return sortAsc ? 1 : -1;
    return 0;
  });

  // Paginate
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  if (currentPage >= totalPages) currentPage = totalPages - 1;
  const start = currentPage * pageSize;
  const page = sorted.slice(start, start + pageSize);

  // Detect dynamic Art columns
  const artCols = [];
  const seen = new Set();
  for (const row of allResults) {
    for (const key of Object.keys(row)) {
      if (key.endsWith("_m2") && !PARCEL_COLUMNS.some((c) => c.key === key) && !seen.has(key)) {
        seen.add(key);
        const artName = key.replace(/_m2$/, "");
        artCols.push({ key, label: (ART_LABELS[artName] || artName) + " m²", numeric: true });
      }
    }
  }

  const allCols = [...PARCEL_COLUMNS, ...artCols];

  let html = `
    <div class="table-toolbar">
      <span class="table-count">${allResults.length} Parzellen</span>
      <div class="table-paging">
        <button class="btn btn-sm btn-secondary" id="tbl-prev" ${currentPage === 0 ? "disabled" : ""}>&#9664;</button>
        <span>${currentPage + 1} / ${totalPages}</span>
        <button class="btn btn-sm btn-secondary" id="tbl-next" ${currentPage >= totalPages - 1 ? "disabled" : ""}>&#9654;</button>
      </div>
    </div>
    <div class="table-scroll">
      <table class="results-table">
        <thead>
          <tr>
            ${allCols
              .map(
                (c) =>
                  `<th class="sortable ${sortField === c.key ? (sortAsc ? "sort-asc" : "sort-desc") : ""}" data-key="${c.key}">${esc(c.label)}</th>`
              )
              .join("")}
          </tr>
        </thead>
        <tbody>
          ${page
            .map(
              (row, i) =>
                `<tr data-index="${start + i}" class="${row.check_egrid === 'EGRID gefunden' ? '' : 'row-error'}">
                  ${allCols.map((c) => `<td class="${c.numeric ? 'num' : ''}">${esc(String(row[c.key] ?? ""))}</td>`).join("")}
                </tr>`
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;

  container.innerHTML = html;

  // Event listeners
  container.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (sortField === key) sortAsc = !sortAsc;
      else {
        sortField = key;
        sortAsc = true;
      }
      render();
    });
  });

  container.querySelectorAll("tbody tr").forEach((tr) => {
    tr.addEventListener("click", () => {
      const idx = parseInt(tr.dataset.index, 10);
      if (onRowClick) onRowClick(idx);
      highlightRow(idx);
    });
  });

  const prevBtn = container.querySelector("#tbl-prev");
  const nextBtn = container.querySelector("#tbl-next");
  if (prevBtn) prevBtn.addEventListener("click", () => { currentPage--; render(); });
  if (nextBtn) nextBtn.addEventListener("click", () => { currentPage++; render(); });
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
