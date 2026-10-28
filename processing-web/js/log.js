/**
 * Processing log («Protokoll»): one line per parcel as it finishes — resolved,
 * resolved with a quality note, or failed and why. Everything is derived from the
 * parcel's own check_* flags and errors (classifyParcel), so the processor needs
 * no extra state; the lines keep their translation inputs and are re-rendered on
 * a language switch.
 *
 * The same panel lives below the progress card while processing and, collapsed,
 * above the results table afterwards (mountLog). Collapsed by default: the header
 * carries the ✓ / ⚠ / ✕ counts, and the expanded view shows warnings + errors
 * unless the user switches to "Alle". Rendering is capped (MAX_RENDERED) so a run
 * of thousands of parcels stays smooth; older lines load on demand.
 */
import { t, onLangChange } from "./i18n.js";
import { esc, isFound, statusLabel, errorsLabel, STATUS } from "./config.js";
import { showToast } from "./toast.js";

/** Lines rendered at once; older ones are added in steps of this size on demand. */
export const MAX_RENDERED = 500;

const GLYPH = { ok: "✓", warn: "⚠", err: "✕" };
const BZ_NOTE = { partial: "log.w.bz.partial", truncated: "log.w.bz.truncated", error: "log.w.bz.error" };
const HB_NOTE = { estimated: "log.w.hb.estimated", partial: "log.w.hb.partial", truncated: "log.w.hb.truncated", error: "log.w.hb.error" };

/* ── Classification (pure; unit-tested) ── */

/**
 * Severity + message parts for one finished parcel. Parts are translation inputs
 * — `{ key, params }` for t(), `{ status }` for statusLabel(), `{ errors }` for
 * errorsLabel(), `{ raw }` as is — joined with " · " at render time.
 *   err  — the parcel could not be resolved, or has no land cover because the WFS failed
 *   warn — resolved, but a quality note applies (synthetic AV, merged EGRID, skipped
 *          geometries, truncated / partial / estimated overlays, no AV land cover)
 *   ok   — resolved cleanly; the message lists the piece count and the overlays that ran
 */
export function classifyParcel(p) {
  if (!isFound(p.check_egrid)) return { sev: "err", parts: [{ status: p.check_egrid }] };
  const errors = Array.isArray(p.errors) ? p.errors.filter(Boolean) : (p.errors ? [p.errors] : []);
  if (errors.length) return { sev: "err", parts: [{ errors }] };

  const notes = [];
  if (p.check_egrid === STATUS.MERGED) notes.push({ key: "log.w.merged" });
  if (p.lc_synthetic === "yes") notes.push({ key: "log.w.synthetic" });
  else if (!(p._landcover || []).length) notes.push({ key: "log.w.nolc" });
  if (p.check_wfs === "truncated") notes.push({ key: "log.w.wfs" });
  const skipped = /^(\d+)_skipped$/.exec(p.check_geom || "");
  if (skipped) notes.push({ key: "log.w.geom", params: { n: Number(skipped[1]) } });
  if (p.check_bauzonen && p.check_bauzonen !== "ok") {
    notes.push(BZ_NOTE[p.check_bauzonen] ? { key: BZ_NOTE[p.check_bauzonen] } : { raw: `Bauzonen: ${p.check_bauzonen}` });
  }
  if (p.check_habitat && p.check_habitat !== "ok") {
    notes.push(HB_NOTE[p.check_habitat] ? { key: HB_NOTE[p.check_habitat] } : { raw: `Habitat: ${p.check_habitat}` });
  }
  if (notes.length) return { sev: "warn", parts: notes };

  const parts = [{ key: "log.ok.pieces", params: { n: (p._landcover || []).length } }];
  if (p.check_bauzonen === "ok") parts.push({ key: "log.ok.bauzonen" });
  if (p.check_habitat === "ok") parts.push({ key: "log.ok.habitat" });
  return { sev: "ok", parts };
}

/** Render message parts to text in the current language. */
export function partsText(parts) {
  return parts.map((part) => {
    if (part.status !== undefined) return statusLabel(part.status);
    if (part.errors) return errorsLabel(part.errors);
    if (part.raw !== undefined) return part.raw;
    return t(part.key, part.params);
  }).join(" · ");
}

/* ── State ── */

let entries = [];                       // { sev, parcel, parts } in completion order
let counts = { ok: 0, warn: 0, err: 0 };
let filter = "issues";                  // "issues" (warn + err) | "all"
let expanded = false;
let extraOlder = 0;                     // extra lines revealed via "Ältere anzeigen"
let finished = null;                    // { elapsedMs, cancelled, processed, total }
let selectHandler = null;
let autoscroll = true;
const el = {};                          // DOM refs (initLog)

const isShown = (e) => filter === "all" || e.sev !== "ok";

/* ── Public API ── */

/** Build the panel once. `onSelect(parcel)` is called when a line is clicked in the results view. */
export function initLog({ onSelect } = {}) {
  selectHandler = onSelect || null;
  el.root = document.getElementById("proc-log");
  if (!el.root) return;
  el.root.innerHTML = `
    <button type="button" class="pl-head" aria-expanded="false" aria-controls="proc-log-body">
      <span class="material-symbols-outlined pl-chev" aria-hidden="true">chevron_right</span>
      <span class="pl-title"></span>
      <span class="pl-counts">
        <span class="pl-count ok"><span aria-hidden="true">${GLYPH.ok}</span> <span class="pl-n" data-sev="ok">0</span></span>
        <span class="pl-count warn"><span aria-hidden="true">${GLYPH.warn}</span> <span class="pl-n" data-sev="warn">0</span></span>
        <span class="pl-count err"><span aria-hidden="true">${GLYPH.err}</span> <span class="pl-n" data-sev="err">0</span></span>
      </span>
      <span class="pl-done"></span>
    </button>
    <div id="proc-log-body" class="pl-body" hidden>
      <div class="pl-toolbar">
        <div class="pl-filter" role="group">
          <button type="button" data-filter="issues" aria-pressed="true"></button>
          <button type="button" data-filter="all" aria-pressed="false"></button>
        </div>
        <div class="pl-tools">
          <button type="button" class="pl-copy"></button>
          <button type="button" class="pl-download"></button>
        </div>
      </div>
      <button type="button" class="pl-older" hidden></button>
      <div class="pl-list" role="log" aria-live="off"></div>
      <div class="pl-empty" hidden></div>
    </div>`;
  el.head = el.root.querySelector(".pl-head");
  el.body = el.root.querySelector(".pl-body");
  el.list = el.root.querySelector(".pl-list");
  el.done = el.root.querySelector(".pl-done");
  el.older = el.root.querySelector(".pl-older");
  el.empty = el.root.querySelector(".pl-empty");
  el.title = el.root.querySelector(".pl-title");
  el.filterBtns = [...el.root.querySelectorAll(".pl-filter button")];
  el.copy = el.root.querySelector(".pl-copy");
  el.download = el.root.querySelector(".pl-download");

  el.head.addEventListener("click", () => setExpanded(!expanded));
  el.filterBtns.forEach((b) => b.addEventListener("click", () => setFilter(b.dataset.filter)));
  el.older.addEventListener("click", () => { extraOlder += MAX_RENDERED; renderList(); });
  el.copy.addEventListener("click", copyLog);
  el.download.addEventListener("click", downloadLog);
  // Stop auto-scrolling while the user reads older lines; resume at the bottom.
  el.list.addEventListener("scroll", () => {
    autoscroll = el.list.scrollTop + el.list.clientHeight >= el.list.scrollHeight - 8;
  });
  // A line selects its parcel in the results view (click or Enter / Space).
  const activate = (target) => {
    const line = target.closest(".pl-line");
    if (!line || el.root.dataset.mode !== "results" || !selectHandler) return;
    const entry = entries[Number(line.dataset.i)];
    if (entry) selectHandler(entry.parcel);
  };
  el.list.addEventListener("click", (e) => activate(e.target));
  el.list.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(e.target); }
  });

  onLangChange(() => { renderStatic(); renderList(); });
  renderStatic();
}

/** Forget the previous run and move the panel back under the progress card. */
export function resetLog() {
  entries = [];
  counts = { ok: 0, warn: 0, err: 0 };
  filter = "issues";
  extraOlder = 0;
  finished = null;
  autoscroll = true;
  if (!el.root) return;
  el.filterBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.filter === filter)));
  setExpanded(false);
  mountLog("processing");
  el.list.innerHTML = "";
  renderHead();
}

/** Record one finished parcel (called from the progress callback). */
export function logParcel(parcel) {
  const { sev, parts } = classifyParcel(parcel);
  const entry = { sev, parcel, parts };
  entries.push(entry);
  counts[sev]++;
  if (!el.root) return;
  if (el.root.hidden) el.root.hidden = false;
  renderHead();
  if (expanded && isShown(entry)) appendLine(entry, entries.length - 1);
}

/** Mark the run as finished (or cancelled) — shown in the header. */
export function finishLog({ elapsedMs = 0, cancelled = false, processed = 0, total = 0 } = {}) {
  finished = { elapsedMs, cancelled, processed, total };
  renderHead();
}

/** Move the panel to its slot: below the progress card ("processing") or above the
 *  results table ("results"). Stays hidden while there is nothing to show (e.g. an
 *  embedded report, which never processed anything here). */
export function mountLog(mode) {
  if (!el.root) return;
  const slot = mode === "results" ? document.getElementById("proc-log-slot") : document.querySelector(".processing-container");
  if (slot && el.root.parentElement !== slot) slot.appendChild(el.root);
  el.root.dataset.mode = mode;
  el.root.hidden = entries.length === 0;
  if (mode === "results") setExpanded(false);
}

/** Expand the panel and bring it into view (completion toast). */
export function openLog() {
  if (!el.root || el.root.hidden) return;
  setExpanded(true);
  el.root.scrollIntoView({ block: "nearest" });
}

/** Current ✓ / ⚠ / ✕ counts. */
export function logCounts() {
  return { ...counts };
}

/** Plain-text export (all lines, tab-separated) — what Copy / Download produce. */
export function logText() {
  const header = `${t("log.title")}\t${GLYPH.ok} ${counts.ok}\t${GLYPH.warn} ${counts.warn}\t${GLYPH.err} ${counts.err}`;
  const lines = entries.map((e) => `${GLYPH[e.sev]}\t${e.parcel.id}\t${e.parcel.egrid}\t${partsText(e.parts)}`);
  return [header, ...lines].join("\n");
}

/* ── Rendering ── */

function renderStatic() {
  if (!el.root) return;
  el.root.setAttribute("aria-label", t("log.aria"));
  el.title.textContent = t("log.title");
  el.filterBtns.forEach((b) => { b.textContent = t(b.dataset.filter === "all" ? "log.filter.all" : "log.filter.issues"); });
  el.copy.textContent = t("log.copy");
  el.download.textContent = t("log.download");
  el.empty.textContent = t("log.empty.issues");
  renderHead();
}

function renderHead() {
  if (!el.root) return;
  for (const n of el.root.querySelectorAll(".pl-n")) n.textContent = String(counts[n.dataset.sev]);
  let done = "";
  if (finished) {
    if (finished.cancelled) {
      done = t("log.cancelled", { n: finished.processed, total: finished.total });
    } else {
      const s = Math.round(finished.elapsedMs / 1000);
      done = t("log.done", { min: Math.floor(s / 60), sec: s % 60 });
    }
  }
  el.done.textContent = done;
}

function setExpanded(on) {
  expanded = !!on;
  if (!el.root) return;
  el.root.dataset.expanded = String(expanded);
  el.head.setAttribute("aria-expanded", String(expanded));
  el.body.hidden = !expanded;
  if (expanded) renderList();
}

function setFilter(f) {
  filter = f === "all" ? "all" : "issues";
  extraOlder = 0;
  el.filterBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.filter === filter)));
  renderList();
}

function lineHTML(entry, i) {
  return `<div class="pl-line pl-${entry.sev}" data-i="${i}" role="button" tabindex="0">`
    + `<span class="pl-glyph" aria-hidden="true">${GLYPH[entry.sev]}</span>`
    + `<span class="pl-id">${esc(entry.parcel.id)}</span>`
    + `<span class="pl-egrid">${esc(entry.parcel.egrid)}</span>`
    + `<span class="pl-msg">${esc(partsText(entry.parts))}</span></div>`;
}

function renderList() {
  if (!el.root || !expanded) return;
  const shown = [];
  entries.forEach((e, i) => { if (isShown(e)) shown.push(i); });
  const limit = MAX_RENDERED + extraOlder;
  const start = Math.max(0, shown.length - limit);
  el.older.hidden = start === 0;
  if (start > 0) el.older.textContent = t("log.older", { n: start });
  el.empty.hidden = shown.length > 0;
  el.list.innerHTML = shown.slice(start).map((i) => lineHTML(entries[i], i)).join("");
  el.list.scrollTop = el.list.scrollHeight;
  autoscroll = true;
}

function appendLine(entry, i) {
  el.empty.hidden = true;
  el.list.insertAdjacentHTML("beforeend", lineHTML(entry, i));
  const limit = MAX_RENDERED + extraOlder;
  while (el.list.childElementCount > limit) el.list.removeChild(el.list.firstElementChild);
  const hidden = entries.filter(isShown).length - el.list.childElementCount;
  el.older.hidden = hidden <= 0;
  if (hidden > 0) el.older.textContent = t("log.older", { n: hidden });
  if (autoscroll) el.list.scrollTop = el.list.scrollHeight;
}

/* ── Export ── */

async function copyLog() {
  try {
    await navigator.clipboard.writeText(logText());
    showToast(t("log.copied"));
  } catch {
    downloadLog(); // clipboard blocked (e.g. file://) → offer the file instead
  }
}

function downloadLog() {
  const blob = new Blob([logText()], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  a.href = URL.createObjectURL(blob);
  a.download = `protokoll_${stamp}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
