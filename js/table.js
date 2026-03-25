/**
 * Table widget with tabs (Parcels / Land Covers), toolbar with search,
 * sortable headers, pagination, column visibility dropdown, resize handle
 */
import { ART_LABELS, STATUS, esc, fmtNum } from "./config.js";
import { resizeMap } from "./map.js";
import { t } from "./i18n.js";

/* ── State ── */

let parcelsData = [];
let landcoverData = [];
let activeTab = "parcels";
let onParcelRowClick = null;
let onLcRowClick = null;
let container = null;

// Parcel tab state
let pSortField = "id";
let pSortAsc = true;
let pSearch = "";
let pPage = 1;
let pPageSize = 50;

// Landcover tab state
let lcSortField = "id";
let lcSortAsc = true;
let lcSearch = "";
let lcPage = 1;
let lcPageSize = 50;

/* ── Column definitions ── */

function getParcelCols() {
  return [
    { key: "id", label: t("col.id"), cls: "col-p-id" },
    { key: "egrid", label: t("col.egrid"), cls: "col-p-egrid" },
    { key: "nummer", label: t("col.nummer"), cls: "col-p-nummer" },
    { key: "bfsnr", label: t("col.bfsnr"), cls: "col-p-bfsnr" },
    { key: "check_egrid", label: t("col.status"), cls: "col-p-status" },
    { key: "parcel_area_m2", label: t("col.parcel_area"), cls: "col-p-area", numeric: true },
    { key: "GGF_m2", label: t("col.ggf"), cls: "col-p-ggf", numeric: true },
    { key: "BUF_m2", label: t("col.buf"), cls: "col-p-buf", numeric: true },
    { key: "UUF_m2", label: t("col.uuf"), cls: "col-p-uuf", numeric: true },
    { key: "Sealed_m2", label: t("col.sealed"), cls: "col-p-sealed", numeric: true },
    { key: "GreenSpace_m2", label: t("col.green"), cls: "col-p-green", numeric: true },
  ];
}

function getLcCols() {
  return [
    { key: "id", label: t("col.parcel_id"), cls: "col-lc-id" },
    { key: "egrid", label: t("col.egrid"), cls: "col-lc-egrid" },
    { key: "fid", label: t("col.fid"), cls: "col-lc-fid" },
    { key: "art", label: t("col.art"), cls: "col-lc-art" },
    { key: "art_label", label: t("col.type"), cls: "col-lc-type" },
    { key: "bfsnr", label: t("col.bfsnr"), cls: "col-lc-bfsnr" },
    { key: "gwr_egid", label: t("col.gwr_egid"), cls: "col-lc-gwregid" },
    { key: "check_greenspace", label: t("col.greenspace"), cls: "col-lc-green" },
    { key: "area_m2", label: t("col.area"), cls: "col-lc-area", numeric: true },
  ];
}

/* ── Init ── */

export function initTable(el, { onParcelSelect, onLandcoverSelect } = {}) {
  container = el;
  onParcelRowClick = onParcelSelect || null;
  onLcRowClick = onLandcoverSelect || null;
}

export function populateTable(parcels, landcover) {
  parcelsData = (parcels || []).map((p, i) => { p._idx = i; return p; });
  landcoverData = (landcover || []).map((lc, i) => {
    lc._idx = i;
    lc.art_label = ART_LABELS[lc.art] || lc.art;
    return lc;
  });
  pPage = 1;
  lcPage = 1;
  pSearch = "";
  lcSearch = "";
  activeTab = "parcels";
  renderShell();
  renderActiveTab();
  initResizeHandle();
}

/** Highlight a parcel row (called from map click). Switches to parcels tab if needed. */
export function highlightRow(index) {
  if (!container) return;
  switchToTab("parcels");
  clearAllActiveRows();
  const row = container.querySelector(`tr[data-index="${index}"]`);
  if (row) {
    row.classList.add("row-active");
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

/** Highlight a landcover row (called from map click). Switches to landcover tab if needed. */
export function highlightLcRow(lcIndex) {
  if (!container) return;
  switchToTab("landcover");
  clearAllActiveRows();
  const row = container.querySelector(`tr[data-lc-index="${lcIndex}"]`);
  if (row) {
    row.classList.add("row-active");
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function clearAllActiveRows() {
  if (!container) return;
  container.querySelectorAll("tr.row-active").forEach((r) => r.classList.remove("row-active"));
}

function switchToTab(tabName) {
  if (!container || activeTab === tabName) return;
  activeTab = tabName;
  container.querySelectorAll(".table-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === activeTab);
    t.setAttribute("aria-selected", t.dataset.tab === activeTab);
  });
  container.querySelector("#tab-parcels")?.classList.toggle("active", activeTab === "parcels");
  container.querySelector("#tab-landcover")?.classList.toggle("active", activeTab === "landcover");
  updateColumnsDropdown();
  renderActiveTab();
}

/* ── Shell (toolbar + tab content containers) ── */

function renderShell() {
  container.innerHTML = `
    <div class="tbl-resize-handle" id="tbl-resize-handle" title="${esc(t("table.resize"))}"></div>
    <div class="list-table-container">
      <div class="toolbar">
        <div class="table-tabs" role="tablist">
          <button class="table-tab active" data-tab="parcels" role="tab" aria-selected="true">${esc(t("table.tab.parcels"))}</button>
          <button class="table-tab" data-tab="landcover" role="tab" aria-selected="false">${esc(t("table.tab.landcover"))}</button>
        </div>
        <div class="toolbar-search">
          <span class="material-symbols-outlined">search</span>
          <input type="text" id="tbl-search-input" placeholder="${esc(t("table.search"))}" autocomplete="off">
          <button class="toolbar-search-clear" id="tbl-search-clear" type="button" hidden>
            <span class="material-symbols-outlined">close</span>
          </button>
        </div>
        <div class="toolbar-actions">
          <div class="dropdown-container">
            <button class="dropdown-btn" id="columns-dropdown-btn">
              <span class="material-symbols-outlined">view_column</span> ${esc(t("table.columns"))}
              <span class="material-symbols-outlined">expand_more</span>
            </button>
            <div class="dropdown-menu columns-dropdown" id="columns-dropdown-menu">
              <div class="dropdown-menu-header">${esc(t("table.columns.show"))}</div>
              <div class="dropdown-menu-toggle-row">
                <button class="dropdown-toggle-btn" id="col-toggle-all">${esc(t("table.columns.all"))}</button>
                <button class="dropdown-toggle-btn" id="col-toggle-none">${esc(t("table.columns.none"))}</button>
              </div>
              <div class="columns-list" id="columns-list"></div>
            </div>
          </div>
        </div>
      </div>
      <div class="table-tab-content active" id="tab-parcels">
        <div class="list-table-wrapper">
          <table class="base-table list-table" id="parcels-table">
            <thead><tr id="parcels-header-row"></tr></thead>
            <tbody id="parcels-body"></tbody>
          </table>
        </div>
        <div class="pagination-footer" id="parcels-pagination"></div>
      </div>
      <div class="table-tab-content" id="tab-landcover">
        <div class="list-table-wrapper">
          <table class="base-table list-table" id="lc-table">
            <thead><tr id="lc-header-row"></tr></thead>
            <tbody id="lc-body"></tbody>
          </table>
        </div>
        <div class="pagination-footer" id="lc-pagination"></div>
      </div>
    </div>
  `;

  // Tab switching
  container.querySelectorAll(".table-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      activeTab = tab.dataset.tab;
      container.querySelectorAll(".table-tab").forEach((t) => {
        t.classList.toggle("active", t.dataset.tab === activeTab);
        t.setAttribute("aria-selected", t.dataset.tab === activeTab);
      });
      container.querySelector("#tab-parcels").classList.toggle("active", activeTab === "parcels");
      container.querySelector("#tab-landcover").classList.toggle("active", activeTab === "landcover");
      const input = container.querySelector("#tbl-search-input");
      input.value = "";
      container.querySelector("#tbl-search-clear").hidden = true;
      pSearch = "";
      lcSearch = "";
      updateColumnsDropdown();
      renderActiveTab();
    });
  });

  // Search
  let debounce = null;
  const searchInput = container.querySelector("#tbl-search-input");
  const searchClear = container.querySelector("#tbl-search-clear");
  searchInput.addEventListener("input", () => {
    searchClear.hidden = !searchInput.value;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (activeTab === "parcels") { pSearch = searchInput.value.toLowerCase().trim(); pPage = 1; }
      else { lcSearch = searchInput.value.toLowerCase().trim(); lcPage = 1; }
      renderActiveTab();
    }, 200);
  });
  searchClear.addEventListener("click", () => {
    searchInput.value = "";
    searchClear.hidden = true;
    pSearch = ""; lcSearch = "";
    pPage = 1; lcPage = 1;
    renderActiveTab();
    searchInput.focus();
  });

  // Columns dropdown
  const colBtn = container.querySelector("#columns-dropdown-btn");
  const colMenu = container.querySelector("#columns-dropdown-menu");
  colBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    colMenu.classList.toggle("show");
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#columns-dropdown-menu") && !e.target.closest("#columns-dropdown-btn")) {
      colMenu.classList.remove("show");
    }
  });
  container.querySelector("#col-toggle-all").addEventListener("click", () => toggleAllCols(true));
  container.querySelector("#col-toggle-none").addEventListener("click", () => toggleAllCols(false));

  // Build headers
  renderHeaders("parcels-header-row", getParcelCols(), "p");
  renderHeaders("lc-header-row", getLcCols(), "lc");
  updateColumnsDropdown();
}

/* ── Headers ── */

function renderHeaders(rowId, cols, prefix) {
  const row = container.querySelector(`#${rowId}`);
  row.innerHTML = cols.map((c) =>
    `<th class="${c.cls} sortable" data-key="${c.key}" data-prefix="${prefix}">
      ${esc(c.label)} <span class="material-symbols-outlined sort-icon">unfold_more</span>
    </th>`
  ).join("");

  row.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (prefix === "p") {
        if (pSortField === key) pSortAsc = !pSortAsc;
        else { pSortField = key; pSortAsc = true; }
      } else {
        if (lcSortField === key) lcSortAsc = !lcSortAsc;
        else { lcSortField = key; lcSortAsc = true; }
      }
      renderActiveTab();
      updateSortIndicators(rowId, key, prefix === "p" ? pSortAsc : lcSortAsc);
    });
  });
}

function updateSortIndicators(rowId, activeKey, asc) {
  const row = container.querySelector(`#${rowId}`);
  row.querySelectorAll("th.sortable").forEach((th) => {
    const icon = th.querySelector(".sort-icon");
    if (th.dataset.key === activeKey) {
      icon.textContent = asc ? "expand_less" : "expand_more";
      icon.style.color = "var(--swiss-red)";
    } else {
      icon.textContent = "unfold_more";
      icon.style.color = "";
    }
  });
}

/* ── Columns dropdown ── */

function updateColumnsDropdown() {
  const list = container.querySelector("#columns-list");
  const cols = activeTab === "parcels" ? getParcelCols() : getLcCols();
  list.innerHTML = cols.map((c) =>
    `<label class="dropdown-menu-item">
      <input type="checkbox" checked data-column="${c.cls}"> ${esc(c.label)}
    </label>`
  ).join("");

  list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", () => toggleCol(cb));
  });
}

function toggleCol(checkbox) {
  const cls = checkbox.dataset.column;
  const show = checkbox.checked;
  container.querySelectorAll(`.${cls}`).forEach((el) => {
    el.style.display = show ? "" : "none";
  });
}

function toggleAllCols(showAll) {
  container.querySelectorAll("#columns-list input[type='checkbox']").forEach((cb) => {
    cb.checked = showAll;
    toggleCol(cb);
  });
}

/* ── Render active tab ── */

function renderActiveTab() {
  if (activeTab === "parcels") renderParcels();
  else renderLandcover();
}

/* ── Parcels tab ── */

function renderParcels() {
  let data = [...parcelsData];

  if (pSearch) {
    data = data.filter((p) => {
      const s = `${p.id} ${p.egrid} ${p.nummer} ${p.check_egrid}`.toLowerCase();
      return s.includes(pSearch);
    });
  }

  const col = getParcelCols().find((c) => c.key === pSortField);
  data.sort((a, b) => {
    let va = a[pSortField] ?? "";
    let vb = b[pSortField] ?? "";
    if (col?.numeric) { va = parseFloat(va) || 0; vb = parseFloat(vb) || 0; }
    if (va < vb) return pSortAsc ? -1 : 1;
    if (va > vb) return pSortAsc ? 1 : -1;
    return 0;
  });

  const total = data.length;
  const totalPages = Math.max(1, Math.ceil(total / pPageSize));
  if (pPage > totalPages) pPage = totalPages;
  const start = (pPage - 1) * pPageSize;
  const page = data.slice(start, start + pPageSize);

  const body = container.querySelector("#parcels-body");
  if (total === 0) {
    body.innerHTML = `<tr><td colspan="${getParcelCols().length}" class="empty-cell">
      <span class="material-symbols-outlined">search_off</span> ${esc(t("table.empty"))}
    </td></tr>`;
  } else {
    body.innerHTML = page.map((row) => {
      const idx = row._idx;
      const errCls = row.check_egrid === STATUS.FOUND ? "" : "row-error";
      return `<tr data-index="${idx}" class="${errCls}" tabindex="0">
        ${getParcelCols().map((c) => `<td class="${c.cls} ${c.numeric ? 'num' : ''}">${fmtCell(row[c.key], c.numeric)}</td>`).join("")}
      </tr>`;
    }).join("");
  }

  body.querySelectorAll("tr[data-index]").forEach((tr) => {
    tr.addEventListener("click", () => {
      const idx = parseInt(tr.dataset.index, 10);
      clearAllActiveRows();
      tr.classList.add("row-active");
      if (onParcelRowClick) onParcelRowClick(idx);
    });
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); tr.click(); }
    });
  });

  renderPagination("parcels-pagination", pPage, totalPages, total, pPageSize, t("table.label.parcels"),
    (p) => { pPage = p; renderParcels(); },
    (s) => { pPageSize = s; pPage = 1; renderParcels(); }
  );

  container.querySelectorAll("#columns-list input[type='checkbox']").forEach((cb) => {
    if (!cb.checked) toggleCol(cb);
  });
}

/* ── Landcover tab ── */

function renderLandcover() {
  let data = [...landcoverData];

  if (lcSearch) {
    data = data.filter((lc) => {
      const s = `${lc.id} ${lc.egrid} ${lc.art} ${lc.art_label} ${lc.check_greenspace}`.toLowerCase();
      return s.includes(lcSearch);
    });
  }

  const col = getLcCols().find((c) => c.key === lcSortField);
  data.sort((a, b) => {
    let va = a[lcSortField] ?? "";
    let vb = b[lcSortField] ?? "";
    if (col?.numeric) { va = parseFloat(va) || 0; vb = parseFloat(vb) || 0; }
    if (va < vb) return lcSortAsc ? -1 : 1;
    if (va > vb) return lcSortAsc ? 1 : -1;
    return 0;
  });

  const total = data.length;
  const totalPages = Math.max(1, Math.ceil(total / lcPageSize));
  if (lcPage > totalPages) lcPage = totalPages;
  const start = (lcPage - 1) * lcPageSize;
  const page = data.slice(start, start + lcPageSize);

  const body = container.querySelector("#lc-body");
  if (total === 0) {
    body.innerHTML = `<tr><td colspan="${getLcCols().length}" class="empty-cell">
      <span class="material-symbols-outlined">search_off</span> ${esc(t("table.empty"))}
    </td></tr>`;
  } else {
    body.innerHTML = page.map((row) => {
      const lcIdx = row._idx;
      return `<tr data-lc-index="${lcIdx}" tabindex="0">
        ${getLcCols().map((c) => `<td class="${c.cls} ${c.numeric ? 'num' : ''}">${fmtCell(row[c.key], c.numeric)}</td>`).join("")}
      </tr>`;
    }).join("");
  }

  // LC row click handlers
  body.querySelectorAll("tr[data-lc-index]").forEach((tr) => {
    tr.addEventListener("click", () => {
      const idx = parseInt(tr.dataset.lcIndex, 10);
      clearAllActiveRows();
      tr.classList.add("row-active");
      if (onLcRowClick) onLcRowClick(idx);
    });
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); tr.click(); }
    });
  });

  renderPagination("lc-pagination", lcPage, totalPages, total, lcPageSize, t("table.label.landcover"),
    (p) => { lcPage = p; renderLandcover(); },
    (s) => { lcPageSize = s; lcPage = 1; renderLandcover(); }
  );

  container.querySelectorAll("#columns-list input[type='checkbox']").forEach((cb) => {
    if (!cb.checked) toggleCol(cb);
  });
}

/* ── Pagination ── */

function renderPagination(elId, currentPage, totalPages, totalItems, pageSize, label, onPageChange, onPageSizeChange) {
  const el = container.querySelector(`#${elId}`);
  const start = totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, totalItems);

  el.innerHTML = `
    <div class="pagination-info">${t("table.pagination.info", { start, end, total: totalItems, label })}</div>
    <div class="pagination-nav">
      <button class="pagination-btn pg-prev" ${currentPage <= 1 ? "disabled" : ""}>
        <span class="material-symbols-outlined">chevron_left</span>
      </button>
      <span class="pagination-page-info">${t("table.pagination.page", { current: currentPage, total: totalPages })}</span>
      <button class="pagination-btn pg-next" ${currentPage >= totalPages ? "disabled" : ""}>
        <span class="material-symbols-outlined">chevron_right</span>
      </button>
    </div>
    <div class="pagination-rows">
      ${esc(t("table.pagination.rows"))}
      <select class="pg-size">
        ${[25, 50, 100].map((s) => `<option value="${s}" ${s === pageSize ? "selected" : ""}>${s}</option>`).join("")}
      </select>
    </div>
  `;

  el.querySelector(".pg-prev")?.addEventListener("click", () => { if (currentPage > 1) onPageChange(currentPage - 1); });
  el.querySelector(".pg-next")?.addEventListener("click", () => { if (currentPage < totalPages) onPageChange(currentPage + 1); });
  el.querySelector(".pg-size")?.addEventListener("change", (e) => onPageSizeChange(parseInt(e.target.value, 10)));
}

/* ── Resize handle ── */

function initResizeHandle() {
  const handle = container.querySelector("#tbl-resize-handle");
  if (!handle) return;

  const MIN_H = 120;
  const MAX_FRAC = 0.75;

  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    container.style.transition = "none";
    const startY = e.clientY;
    const startH = container.getBoundingClientRect().height;

    function onMove(ev) {
      const delta = startY - ev.clientY;
      const maxH = window.innerHeight * MAX_FRAC;
      container.style.height = Math.min(maxH, Math.max(MIN_H, startH + delta)) + "px";
      resizeMap();
    }

    function onUp() {
      handle.classList.remove("dragging");
      container.style.transition = "";
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("lostpointercapture", onUp);
      resizeMap();
    }

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("lostpointercapture", onUp);
  });
}

/* ── Helpers ── */

function fmtCell(val, numeric) {
  if (val === null || val === undefined || val === "") return "\u2013";
  if (numeric) return fmtNum(val, 2);
  return esc(String(val));
}
