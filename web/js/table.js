/**
 * Table widget with tabs (Parcels / Land Covers), toolbar with search,
 * sortable headers, pagination, column visibility dropdown, resize handle
 */
import { ART_LABELS, STATUS, statusLabel, greenSpaceLabel, esc, fmtNum } from "./config.js";
import { t } from "./i18n.js";

/* ── State ── */

let parcelsData = [];
let landcoverData = [];
let activeTab = "parcels";
let onParcelRowClick = null;
let onLcRowClick = null;
let container = null;

// Per-tab view state (sort / search / pagination)
const tabState = {
  parcels: { sortField: "id", sortAsc: true, search: "", page: 1, pageSize: 50 },
  landcover: { sortField: "id", sortAsc: true, search: "", page: 1, pageSize: 50 },
};

/* ── Column definitions ── */

function getParcelCols() {
  return [
    { key: "id", label: t("col.id"), cls: "col-p-id" },
    { key: "egrid", label: t("col.egrid"), cls: "col-p-egrid" },
    { key: "nummer", label: t("col.nummer"), cls: "col-p-nummer" },
    { key: "bfsnr", label: t("col.bfsnr"), cls: "col-p-bfsnr" },
    { key: "check_egrid", label: t("col.status"), cls: "col-p-status", fmt: statusLabel },
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
    { key: "check_greenspace", label: t("col.greenspace"), cls: "col-lc-green", fmt: greenSpaceLabel },
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
  // Shallow-copy so we can attach view-only fields (_idx, art_label) without
  // mutating the shared result objects held by main.js / used for export.
  parcelsData = (parcels || []).map((p, i) => ({ ...p, _idx: i }));
  landcoverData = (landcover || []).map((lc, i) => ({ ...lc, _idx: i, art_label: ART_LABELS[lc.art] || lc.art }));
  for (const st of Object.values(tabState)) { st.page = 1; st.search = ""; }
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
      tabState.parcels.search = "";
      tabState.landcover.search = "";
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
      const st = tabState[activeTab];
      st.search = searchInput.value.toLowerCase().trim();
      st.page = 1;
      renderActiveTab();
    }, 200);
  });
  searchClear.addEventListener("click", () => {
    searchInput.value = "";
    searchClear.hidden = true;
    const st = tabState[activeTab];
    st.search = "";
    st.page = 1;
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
  renderHeaders("parcels-header-row", getParcelCols(), "parcels");
  renderHeaders("lc-header-row", getLcCols(), "landcover");
  updateColumnsDropdown();
}

/* ── Headers ── */

function renderHeaders(rowId, cols, tabName) {
  const row = container.querySelector(`#${rowId}`);
  row.innerHTML = cols.map((c) =>
    `<th class="${c.cls} sortable" data-key="${c.key}" role="columnheader" aria-sort="none" tabindex="0">
      ${esc(c.label)} <span class="material-symbols-outlined sort-icon">unfold_more</span>
    </th>`
  ).join("");

  const sortBy = (key) => {
    const st = tabState[tabName];
    if (st.sortField === key) st.sortAsc = !st.sortAsc;
    else { st.sortField = key; st.sortAsc = true; }
    renderTab(tabName);
    updateSortIndicators(rowId, key, st.sortAsc);
  };

  row.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => sortBy(th.dataset.key));
    th.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); sortBy(th.dataset.key); }
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
      th.setAttribute("aria-sort", asc ? "ascending" : "descending");
    } else {
      icon.textContent = "unfold_more";
      icon.style.color = "";
      th.setAttribute("aria-sort", "none");
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

/** Static per-tab configuration shared by the unified renderer below. */
const TAB_CONFIG = {
  parcels: {
    getCols: getParcelCols,
    getData: () => parcelsData,
    bodyId: "parcels-body",
    paginationId: "parcels-pagination",
    rowAttr: "data-index",
    label: () => t("table.label.parcels"),
    searchText: (r) => `${r.id} ${r.egrid} ${r.nummer} ${r.check_egrid}`,
    rowClass: (r) => (r.check_egrid === STATUS.FOUND ? "" : "row-error"),
    onRowClick: (idx) => { if (onParcelRowClick) onParcelRowClick(idx); },
  },
  landcover: {
    getCols: getLcCols,
    getData: () => landcoverData,
    bodyId: "lc-body",
    paginationId: "lc-pagination",
    rowAttr: "data-lc-index",
    label: () => t("table.label.landcover"),
    searchText: (r) => `${r.id} ${r.egrid} ${r.art} ${r.art_label} ${r.check_greenspace}`,
    rowClass: () => "",
    onRowClick: (idx) => { if (onLcRowClick) onLcRowClick(idx); },
  },
};

function renderActiveTab() {
  renderTab(activeTab);
}

/** Natural, locale-aware comparison so e.g. TEST-2 sorts before TEST-10. */
function compareValues(va, vb, numeric, asc) {
  if (numeric) {
    const na = parseFloat(va) || 0;
    const nb = parseFloat(vb) || 0;
    return asc ? na - nb : nb - na;
  }
  const cmp = String(va ?? "").localeCompare(String(vb ?? ""), undefined, { numeric: true, sensitivity: "base" });
  return asc ? cmp : -cmp;
}

/** Unified tab renderer: filter → sort → paginate → render → wire row events. */
function renderTab(tabName) {
  const cfg = TAB_CONFIG[tabName];
  const st = tabState[tabName];
  const cols = cfg.getCols();

  let data = cfg.getData();
  data = st.search
    ? data.filter((r) => cfg.searchText(r).toLowerCase().includes(st.search))
    : [...data];

  const col = cols.find((c) => c.key === st.sortField);
  data.sort((a, b) => compareValues(a[st.sortField], b[st.sortField], col?.numeric, st.sortAsc));

  const total = data.length;
  const totalPages = Math.max(1, Math.ceil(total / st.pageSize));
  if (st.page > totalPages) st.page = totalPages;
  const start = (st.page - 1) * st.pageSize;
  const page = data.slice(start, start + st.pageSize);

  const body = container.querySelector(`#${cfg.bodyId}`);
  if (total === 0) {
    body.innerHTML = `<tr><td colspan="${cols.length}" class="empty-cell">
      <span class="material-symbols-outlined">search_off</span> ${esc(t("table.empty"))}
    </td></tr>`;
  } else {
    body.innerHTML = page.map((row) => {
      const cls = cfg.rowClass(row);
      return `<tr ${cfg.rowAttr}="${row._idx}" class="${cls}" tabindex="0">
        ${cols.map((c) => `<td class="${c.cls} ${c.numeric ? "num" : ""}">${fmtCell(row[c.key], c.numeric, c.fmt)}</td>`).join("")}
      </tr>`;
    }).join("");
  }

  body.querySelectorAll(`tr[${cfg.rowAttr}]`).forEach((tr) => {
    tr.addEventListener("click", () => {
      const idx = parseInt(tr.getAttribute(cfg.rowAttr), 10);
      clearAllActiveRows();
      tr.classList.add("row-active");
      cfg.onRowClick(idx);
    });
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); tr.click(); }
    });
  });

  renderPagination(cfg.paginationId, st.page, totalPages, total, st.pageSize, cfg.label(),
    (p) => { st.page = p; renderTab(tabName); },
    (s) => { st.pageSize = s; st.page = 1; renderTab(tabName); }
  );

  // Re-apply hidden columns after re-render
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
  const MAX_FRAC = 0.70;

  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    container.style.transition = "none";
    container.style.maxHeight = "none";
    const startY = e.clientY;
    const startH = container.getBoundingClientRect().height;

    function onMove(ev) {
      const delta = startY - ev.clientY;
      const maxH = window.innerHeight * MAX_FRAC;
      container.style.height = Math.min(maxH, Math.max(MIN_H, startH + delta)) + "px";
      // Map auto-resizes via its ResizeObserver (see initMap) as the panel height changes.
    }

    function onUp() {
      handle.classList.remove("dragging");
      container.style.transition = "";
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("lostpointercapture", onUp);
    }

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("lostpointercapture", onUp);
  });
}

/* ── Helpers ── */

function fmtCell(val, numeric, fmt) {
  if (val === null || val === undefined || val === "") return "\u2013";
  if (numeric) return fmtNum(val, 2);
  if (fmt) return esc(fmt(val));
  return esc(String(val));
}
