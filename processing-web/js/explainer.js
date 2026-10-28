/**
 * Explainer («Kurz erklärt»): a script-driven animation below the upload card for
 * people new to the topic. It follows one real parcel — Zollikofen, Parzelle 112,
 * EGRID CH834682352690 (js/explainer-sample.js, generated) — the way a user would meet
 * it: the aerial view and a search, the cadastral boundary, the land cover, the two
 * processing steps (clip, classify), the figures, the result and the exports.
 *
 * No video file and no audio: eight inline-SVG scenes over two SWISSIMAGE excerpts,
 * animated with CSS, captions from i18n (a language switch re-captions a running scene),
 * a proportional scene timeline with play / pause / replay, and a poster (the end frame
 * of the parcel scene under a veil) until the user presses play. Honours
 * prefers-reduced-motion (scenes switch to their end frames; the user steps through
 * them). Lives inside the upload state, so it is only visible on the start page; main.js
 * pauses it when the state changes and resets it on "Neue Analyse".
 *
 * Rules that came out of the reviews (docs/reviews/2026-10-28-explainer-review.md):
 * every caption ≤ 14 words, no sentence inside the SVG, nothing in the SVG below 13 px
 * (the stage renders at ~0.5× on phones), one idea per scene, the same parcel in every
 * scene, the colours of the real result map, text over the aerial always with a halo.
 */
import { t, onLangChange } from "./i18n.js";
import { SAMPLE } from "./explainer-sample.js";

/** Scene order + duration (ms). */
const SCENES = [
  { id: "place", ms: 6000 },
  { id: "parcel", ms: 5500 },
  { id: "cover", ms: 5500 },
  { id: "clip", ms: 4000 },
  { id: "classify", ms: 5000 },
  { id: "figures", ms: 5500 },
  { id: "result", ms: 5000 },
  { id: "cta", ms: 2500 },
];
// ≈ 39 s in total; the length is deliberately not advertised anywhere in the UI.
const POSTER_SCENE = 1;     // the parcel on the aerial — the frame under the poster veil
const COUNT_MS = 1200;      // KPI count-up length
const FADE_MS = 250;        // stage cross-fade between scenes
const END_FRAME_DELAY = "-60s"; // negative delay → every CSS animation at its end frame

const reducedMotion = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

let root, stage, caption, playBtn, segs, poster;
let current = -1;        // active scene index
let playing = false;
let timer = null;        // scene advance
let sceneStart = 0, sceneElapsed = 0;
let raf = null;

/* ── Scene material (640 × 300 viewBox; geometry from explainer-sample.js) ── */

const IMG = { tight: new URL(SAMPLE.images.tight, import.meta.url).href, wide: new URL(SAMPLE.images.wide, import.meta.url).href };
const [OX, OY] = SAMPLE.origin;                 // the parcel's centre — the zoom target
const F = SAMPLE.figures;
/** AV main group → the class the film talks about. */
const CLASS_OF = { gebaeude: "built", befestigt: "sealed", humusiert: "green", bestockt: "green", gewaesser: "water", vegetationslos: "sealed" };
/** Order in which the land-cover surfaces appear in the «Bodenbedeckung» scene. */
const MAIN_DELAY = { befestigt: 0.4, gebaeude: 0.9, humusiert: 1.4, bestockt: 1.9, gewaesser: 1.9, vegetationslos: 1.9 };

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
const fmtM2 = (n) => `${Math.round(n).toLocaleString("de-CH").replace(/[’  ]/g, "'")} m²`;
const aerial = (which, extra = "") => `<image href="${IMG[which]}" x="0" y="0" width="640" height="300" preserveAspectRatio="xMidYMid slice"${extra}/>`;
const credit = () => `<text x="632" y="292" class="ex-credit ex-right">${esc(t("explainer.credit"))}</text>`;
const surfaces = (cls) => SAMPLE.surfaces.map((s) => `<path d="${s.d}" class="ex-surf ${cls(s)}"/>`).join("");
const byMain = (s) => `ex-lc-${s.main}`;
const byClass = (s) => `ex-cls-${CLASS_OF[s.main] || "sealed"}`;
const CLIP_DEFS = `<defs><clipPath id="ex-clip"><path d="${SAMPLE.parcel}"/></clipPath></defs>`;
const outline = (cls, style) => `<path class="ex-parcel ${cls}" pathLength="1" d="${SAMPLE.parcel}" style="${style}"/>`;
const placeLabel = () => `${SAMPLE.label.gemeinde} · ${t("explainer.parcel.no")} ${SAMPLE.label.nummer}`;
const egridSpaced = SAMPLE.egrid.replace(/^(CH)(\d{4})(\d{4})(\d{4})$/, "$1 $2 $3 $4"); // the search result's spelling

/* ── Scenes ── */

function scenePlace() {
  // The wide aerial, a search typed into a field, the hit, and the map zooming onto the parcel.
  // Both frames share one centre, so scaling the wide image about the frame centre lands exactly
  // on the tight frame; the pin starts where the parcel is in the wide frame and rides along.
  const q = "Zollikofen 112";
  const px = 320 + (OX - 320) / SAMPLE.zoom, py = 150 + (OY - 150) / SAMPLE.zoom;
  return `
  <g class="ex-scene" data-scene="place">
    <g class="ex-zoom" style="--d:2.6s;--z:${SAMPLE.zoom};transform-origin:320px 150px">${aerial("wide")}</g>
    <g class="ex-pin" style="--d:2.2s;--m:2.6s;--dx:${(OX - px).toFixed(1)}px;--dy:${(OY - py).toFixed(1)}px">
      <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="9" class="ex-dot-ring" style="--d:2.6s"/><circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="6" class="ex-dot"/></g>
    <g class="ex-pop" style="--d:.3s">
      <rect x="24" y="20" width="300" height="40" rx="8" class="ex-search"/>
      <circle cx="46" cy="40" r="6.5" class="ex-glyph"/><path d="M 51 45 L 56 50" class="ex-glyph"/>
      <text x="66" y="46" class="ex-search-txt">${esc(q)}</text>
      <rect x="66" y="26" width="${q.length * 9.4}" height="28" class="ex-type" style="--d:.8s"/>
    </g>
    <g class="ex-pop" style="--d:2s">
      <rect x="24" y="64" width="300" height="36" rx="8" class="ex-hit"/>
      <path d="M 40 76 L 52 74 L 54 86 L 42 89 Z" class="ex-hit-glyph"/>
      <text x="66" y="87" class="ex-hit-txt">Zollikofen 112 (${esc(egridSpaced)})</text>
    </g>
    <text x="24" y="288" class="ex-on-air ex-fade" style="--d:4.4s">${esc(t("explainer.place.ways"))}</text>
    ${credit()}
  </g>`;
}

function sceneParcel() {
  // The tight aerial; the boundary draws itself; name, EGRID, source; the privacy line where the EGRID is sent.
  return `
  <g class="ex-scene" data-scene="parcel">
    ${aerial("tight")}
    ${outline("ex-draw ex-pulse", "--d:.3s;--p:1.4s")}
    <text x="24" y="38" class="ex-on-air-big ex-pop" style="--d:1.4s">${esc(placeLabel())}</text>
    <g class="ex-pop" style="--d:1.8s"><rect x="24" y="50" width="214" height="34" rx="17" class="ex-chip"/><text x="131" y="73" class="ex-chip-txt">${esc(SAMPLE.egrid)}</text></g>
    <text x="24" y="288" class="ex-on-air ex-fade" style="--d:2.6s">${esc(t("explainer.parcel.source"))}</text>
    <text x="632" y="262" class="ex-on-air ex-right ex-fade" style="--d:3.6s">${esc(t("explainer.privacy"))}</text>
    ${credit()}
  </g>`;
}

function sceneCover() {
  // The AV land cover appears over the whole aerial, group by group, then the names inside the parcel.
  const lbl = (l, i) => `<text x="${l.x}" y="${l.y + 5}" class="ex-on-air ex-center ex-pop" style="--d:${(2.4 + i * 0.3).toFixed(1)}s">${esc(t("explainer.lc." + l.key))}</text>`;
  const groups = Object.keys(MAIN_DELAY).map((m) =>
    `<g class="ex-fade" style="--d:${MAIN_DELAY[m]}s">${SAMPLE.surfaces.filter((s) => s.main === m).map((s) => `<path d="${s.d}" class="ex-surf ex-lc-${m}"/>`).join("")}</g>`).join("");
  return `
  <g class="ex-scene" data-scene="cover">
    ${aerial("tight")}<rect x="0" y="0" width="640" height="300" class="ex-veil ex-fade" style="--d:.3s"/>
    ${groups}
    ${outline("ex-fade", "--d:.25s")}
    ${SAMPLE.labels.map(lbl).join("")}
    <text x="24" y="288" class="ex-on-air ex-fade" style="--d:4.3s">${esc(t("explainer.cover.source"))}</text>
    ${credit()}
  </g>`;
}

function sceneClip() {
  // Everything outside the boundary fades to a ghost at the cut; the inside stays.
  return `${CLIP_DEFS}
  <g class="ex-scene" data-scene="clip">
    ${aerial("tight")}
    <g class="ex-fade ex-ghost" style="--d:.25s;--g:1.3s">${surfaces(byMain)}</g>
    <g clip-path="url(#ex-clip)" class="ex-fade" style="--d:1.3s">${surfaces(byMain)}</g>
    ${outline("ex-draw ex-pulse", "--d:.3s;--p:1.2s")}
    <text x="24" y="36" class="ex-on-air-big ex-fade" style="--d:.25s">${esc(t("explainer.step.clip"))}</text>
    ${credit()}
  </g>`;
}

function sceneClassify() {
  // The clipped surfaces take the colour of their class; legend and norms on the free right side.
  const row = (y, d, cls, key) => `
    <g class="ex-pop" style="--d:${d}s"><rect x="446" y="${y - 12}" width="16" height="16" rx="3" class="ex-cls-${cls} ex-sw"/><text x="470" y="${y + 1}" class="ex-leg">${esc(t("explainer.cls." + key))}</text></g>`;
  return `${CLIP_DEFS}
  <g class="ex-scene" data-scene="classify">
    ${aerial("tight")}
    <g clip-path="url(#ex-clip)" class="ex-fade" style="--d:.25s">${surfaces(byMain)}</g>
    <g clip-path="url(#ex-clip)" class="ex-fade" style="--d:.9s">${surfaces(byClass)}</g>
    ${outline("ex-fade", "--d:.25s")}
    <text x="24" y="36" class="ex-on-air-big ex-fade" style="--d:.25s">${esc(t("explainer.step.classify"))}</text>
    <rect x="430" y="56" width="200" height="226" rx="8" class="ex-panel-air ex-fade" style="--d:1.1s"/>
    ${row(92, 1.3, "built", "built")}
    ${row(122, 1.6, "sealed", "sealed")}
    ${row(152, 1.9, "green", "green")}
    ${row(182, 2.2, "water", "water")}
    <g class="ex-fade" style="--d:2.9s">
      <text x="446" y="226" class="ex-sub">${esc(t("explainer.norms1"))}</text>
      <text x="446" y="245" class="ex-sub">${esc(t("explainer.norms2"))}</text>
      <text x="446" y="264" class="ex-sub">${esc(t("explainer.norms3"))}</text>
    </g>
    ${credit()}
  </g>`;
}

function sceneFigures() {
  // The parcel's real figures count up; then three parcels as stacked bars — the comparison made visible.
  const tile = (x, d, key, val, cls) => `
    <g class="ex-pop" style="--d:${d}s"><rect x="${x}" y="40" width="160" height="104" rx="8" class="ex-tile"/>
      <text x="${x + 80}" y="92" class="ex-kpi ${cls}" data-count="${val}">0</text>
      <text x="${x + 80}" y="122" class="ex-kpi-lbl">${esc(t(key))}</text></g>`;
  const bar = (y, d, label, parts) => {
    let x = 90;
    const segs = parts.map(([cls, w], i) => { const r = `<rect x="${x}" y="${y}" width="${w}" height="14" rx="4" class="ex-bar ex-cls-${cls}" style="--d:${(d + 0.1 + i * 0.2).toFixed(2)}s"/>`; x += w; return r; }).join("");
    return `<g class="ex-fade" style="--d:${d}s"><text x="82" y="${y + 11}" class="ex-leg ex-right">${label}</text><rect x="90" y="${y}" width="490" height="14" rx="4" class="ex-bar-bg"/>${segs}</g>`;
  };
  const w = (pct) => Math.round(490 * pct / 100);
  return `
  <g class="ex-scene" data-scene="figures">
    ${tile(60, 0.3, "explainer.kpi.sealed", `${F.pct_sealed}%`, "ex-c-grey")}
    ${tile(240, 0.7, "explainer.kpi.green", `${F.pct_green}%`, "ex-c-green")}
    ${tile(420, 1.1, "explainer.kpi.ggf", fmtM2(F.ggf_m2), "ex-c-blue")}
    ${bar(186, 2.2, esc(SAMPLE.label.nummer), [["sealed", w(F.pct_sealed)], ["green", w(F.pct_green)], ["water", w(F.pct_water)]])}
    ${bar(210, 2.6, "B", [["sealed", 348], ["green", 142]])}
    ${bar(234, 3.0, "C", [["sealed", 74], ["green", 416]])}
    <text x="90" y="278" class="ex-note ex-fade" style="--d:3.6s">${esc(t("explainer.why.note"))}</text>
  </g>`;
}

function sceneResult() {
  // The app window: map (aerial + classified parcel), summary donut with the real split, table; export chips.
  const C = 2 * Math.PI * 26, seg = (pct, offset, cls) =>
    `<circle cx="309" cy="121" r="26" class="ex-donut ex-cls-${cls}" style="stroke-dasharray:${(C * pct / 100).toFixed(1)} ${C.toFixed(1)};stroke-dashoffset:${(-C * offset / 100).toFixed(1)}"/>`;
  return `${CLIP_DEFS}<defs><clipPath id="ex-map-clip"><rect x="0" y="0" width="545" height="300"/></clipPath></defs>
  <g class="ex-scene" data-scene="result">
    <g class="ex-pop" style="--d:.25s">
      <rect x="40" y="40" width="330" height="200" rx="8" class="ex-browser"/><rect x="40" y="40" width="330" height="18" rx="8" class="ex-browser-bar"/>
      <g transform="translate(48 66) scale(.367)" clip-path="url(#ex-map-clip)">
        ${aerial("tight")}
        <g clip-path="url(#ex-clip)">${surfaces(byClass)}</g>
        <path d="${SAMPLE.parcel}" class="ex-parcel-mini"/>
      </g>
      <rect x="256" y="66" width="106" height="110" rx="4" class="ex-panel"/>
      <circle cx="309" cy="121" r="26" class="ex-donut-bg"/>
      <g class="ex-fade" style="--d:1s">${seg(F.pct_sealed, 0, "sealed")}${seg(F.pct_green, F.pct_sealed, "green")}${seg(F.pct_water, F.pct_sealed + F.pct_green, "water")}</g>
    </g>
    <g class="ex-fade" style="--d:1.4s"><rect x="48" y="184" width="314" height="48" rx="4" class="ex-panel"/>
      <line x1="56" y1="196" x2="354" y2="196" class="ex-row"/><line x1="56" y1="208" x2="354" y2="208" class="ex-row"/><line x1="56" y1="220" x2="354" y2="220" class="ex-row"/></g>
    <g class="ex-pop" style="--d:2.4s"><text x="410" y="90" class="ex-note">${esc(t("explainer.export"))}</text>
      <rect x="410" y="104" width="68" height="28" rx="14" class="ex-chip-s"/><text x="444" y="123" class="ex-chip-s-txt">Excel</text>
      <rect x="486" y="104" width="56" height="28" rx="14" class="ex-chip-s"/><text x="514" y="123" class="ex-chip-s-txt">CSV</text>
      <rect x="550" y="104" width="84" height="28" rx="14" class="ex-chip-s"/><text x="592" y="123" class="ex-chip-s-txt">GeoJSON</text></g>
  </g>`;
}

function sceneCta() {
  return `
  <g class="ex-scene" data-scene="cta">
    <text x="320" y="128" class="ex-cta ex-center ex-pop" style="--d:.2s">${esc(t("explainer.cta.line1"))}</text>
    <text x="320" y="158" class="ex-note ex-center ex-fade" style="--d:.5s">${esc(t("explainer.cta.line2"))}</text>
    <path d="M 320 250 L 320 190 M 300 210 L 320 190 L 340 210" class="ex-arrow ex-arrow-big ex-draw" pathLength="1" style="--d:.5s"/>
  </g>`;
}

const SCENE_SVG = { place: scenePlace, parcel: sceneParcel, cover: sceneCover, clip: sceneClip, classify: sceneClassify, figures: sceneFigures, result: sceneResult, cta: sceneCta };

/* ── Public API ── */

export function initExplainer() {
  root = document.getElementById("explainer");
  if (!root) return;
  root.innerHTML = `
    <div class="ex-head">
      <span class="material-symbols-outlined" aria-hidden="true">smart_display</span>
      <h3 class="ex-title"></h3>
    </div>
    <div class="ex-stage">
      <svg class="ex-svg" viewBox="0 0 640 300" aria-hidden="true"></svg>
      <button type="button" class="ex-poster"><span class="material-symbols-outlined" aria-hidden="true">play_arrow</span><span class="ex-poster-txt"></span></button>
    </div>
    <p class="ex-caption" aria-live="polite"><span class="ex-cap-title"></span><span class="ex-cap-text"></span></p>
    <div class="ex-controls">
      <button type="button" class="ex-play"><span class="material-symbols-outlined" aria-hidden="true">play_arrow</span></button>
      <div class="ex-timeline" role="group">${SCENES.map((s, i) => `<button type="button" class="ex-seg" data-i="${i}" style="flex:${s.ms}"><span class="ex-seg-fill"></span></button>`).join("")}</div>
      <button type="button" class="ex-replay"><span class="material-symbols-outlined" aria-hidden="true">replay</span></button>
    </div>`;
  stage = root.querySelector(".ex-svg");
  caption = { title: root.querySelector(".ex-cap-title"), text: root.querySelector(".ex-cap-text") };
  playBtn = root.querySelector(".ex-play");
  poster = root.querySelector(".ex-poster");
  segs = [...root.querySelectorAll(".ex-seg")];

  poster.addEventListener("click", () => { poster.hidden = true; showScene(0); play(); });
  playBtn.addEventListener("click", () => (playing ? pause() : play()));
  root.querySelector(".ex-replay").addEventListener("click", () => { poster.hidden = true; showScene(0); play(); });
  segs.forEach((b) => b.addEventListener("click", () => { poster.hidden = true; showScene(Number(b.dataset.i)); if (!playing) renderSegs(); }));
  root.querySelector(".ex-timeline").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = Math.max(0, Math.min(SCENES.length - 1, current + (e.key === "ArrowRight" ? 1 : -1)));
    poster.hidden = true; showScene(i); if (!playing) renderSegs(); segs[i].focus();
  });
  // The last scene points at the upload card: clicking the stage takes the viewer there.
  root.querySelector(".ex-stage").addEventListener("click", (e) => {
    if (e.target.closest(".ex-poster") || current < 0 || SCENES[current].id !== "cta") return;
    const card = document.querySelector(".upload-card");
    if (card) card.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
    const input = document.getElementById("parcel-search-input") || document.getElementById("drop-zone");
    if (input && input.focus) input.focus({ preventScroll: true });
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden && playing) pause(); });
  onLangChange(() => { renderStatic(); if (current >= 0) showScene(current, { keepProgress: true, silent: !playing }); });

  renderStatic();
  showPoster();
}

/** Pause when the start page is left (state change). */
export function pauseExplainer() {
  if (playing) pause();
}

/** Back to the poster — "Neue Analyse". */
export function resetExplainer() {
  if (!root) return;
  pause();
  showPoster();
}

/* ── Playback ── */

/** Poster = the end frame of the parcel scene under the veil (every animation jumped to its end). */
function showPoster() {
  poster.hidden = false;
  showScene(POSTER_SCENE, { silent: true, endFrame: true });
}

function play() {
  if (current < 0 || current >= SCENES.length) showScene(0);
  if (current === SCENES.length - 1 && sceneElapsed >= SCENES[current].ms) showScene(0); // replay from the end
  playing = true;
  root.dataset.playing = "true";
  playBtn.querySelector("span").textContent = "pause";
  playBtn.setAttribute("aria-label", t("explainer.pause"));
  sceneStart = performance.now() - sceneElapsed;
  setAnimState("running");
  scheduleAdvance();
  tick();
}

function pause() {
  playing = false;
  root.dataset.playing = "false";
  playBtn.querySelector("span").textContent = "play_arrow";
  playBtn.setAttribute("aria-label", t("explainer.play"));
  if (timer) { clearTimeout(timer); timer = null; }
  if (raf) { cancelAnimationFrame(raf); raf = null; }
  if (current >= 0) sceneElapsed = Math.min(performance.now() - sceneStart, SCENES[current].ms);
  setAnimState("paused");
  renderCounters(sceneElapsed);
  renderSegs();
}

function setAnimState(state) {
  stage.querySelectorAll(".ex-scene, .ex-scene *").forEach((n) => { n.style.animationPlayState = state; });
}

function scheduleAdvance() {
  if (timer) clearTimeout(timer);
  const remaining = Math.max(0, SCENES[current].ms - sceneElapsed);
  timer = setTimeout(() => {
    if (current < SCENES.length - 1) { showScene(current + 1); scheduleAdvance(); }
    else { sceneElapsed = SCENES[current].ms; pause(); }
  }, remaining);
}

function tick() {
  if (!playing) return;
  const elapsed = performance.now() - sceneStart;
  renderSegs();
  renderCounters(elapsed);
  raf = requestAnimationFrame(tick);
}

/**
 * Switch to scene `i`: swap the SVG (restarting its CSS animations), cross-fade the
 * stage, update caption + timeline. `keepProgress` re-renders mid-scene (language
 * switch) and fast-forwards the animations; `endFrame` shows the finished scene
 * (poster, reduced motion).
 */
function showScene(i, { silent = false, keepProgress = false, endFrame = false } = {}) {
  const changed = i !== current;
  current = i;
  const scene = SCENES[i];
  if (!keepProgress) sceneElapsed = endFrame ? scene.ms : 0;
  sceneStart = performance.now() - sceneElapsed;
  stage.innerHTML = SCENE_SVG[scene.id]();
  root.querySelector(".ex-stage").classList.toggle("ex-link", scene.id === "cta");
  const jump = endFrame || reducedMotion();
  if (jump) {
    stage.querySelectorAll(".ex-scene *").forEach((n) => { n.style.animationDelay = END_FRAME_DELAY; });
  } else if (keepProgress && sceneElapsed > 0) {
    stage.querySelectorAll(".ex-scene *").forEach((n) => { n.style.animationDelay = `calc(var(--d, 0s) - ${Math.round(sceneElapsed)}ms)`; });
  }
  if (!playing) setAnimState(silent ? "paused" : "running");
  if (changed && !silent && !reducedMotion() && stage.animate) {
    stage.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: "ease-out" });
  }
  caption.title.textContent = t(`explainer.s.${scene.id}.title`);
  caption.text.textContent = t(`explainer.s.${scene.id}.text`);
  segs.forEach((b, j) => {
    const title = t(`explainer.s.${SCENES[j].id}.title`);
    if (j === i) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
    b.setAttribute("aria-label", title); b.title = title;
  });
  renderCounters(jump ? Infinity : sceneElapsed);
  renderSegs();
  if (playing) scheduleAdvance();
}

function renderSegs() {
  const elapsed = playing ? performance.now() - sceneStart : sceneElapsed;
  segs.forEach((b, j) => {
    const pct = j < current ? 100 : j > current ? 0 : Math.min(100, (elapsed / SCENES[j].ms) * 100);
    b.firstElementChild.style.width = `${pct}%`;
  });
}

/** KPI numbers follow the scene clock (freeze on pause): `data-count` = "44%" / "2'542 m²". */
function renderCounters(elapsed) {
  const nodes = stage.querySelectorAll("[data-count]");
  if (!nodes.length) return;
  const fmt = (n, suffix) => `${Math.round(n).toLocaleString("de-CH").replace(/[’  ]/g, "'")}${suffix}`;
  nodes.forEach((el) => {
    const m = /^([\d']+)(.*)$/.exec(el.dataset.count);
    const target = m ? Number(m[1].replace(/'/g, "")) : 0, suffix = m ? m[2] : el.dataset.count;
    const delay = parseFloat(el.parentElement.style.getPropertyValue("--d")) * 1000 || 0;
    const p = Math.min(1, Math.max(0, (elapsed - delay) / COUNT_MS));
    el.textContent = fmt(target * (1 - Math.pow(1 - p, 3)), suffix);
  });
}

function renderStatic() {
  if (!root) return;
  root.setAttribute("aria-label", t("explainer.aria"));
  root.querySelector(".ex-title").textContent = t("explainer.title");
  root.querySelector(".ex-poster-txt").textContent = t("explainer.play");
  root.querySelector(".ex-replay").setAttribute("aria-label", t("explainer.replay"));
  root.querySelector(".ex-timeline").setAttribute("aria-label", t("explainer.scenes"));
  playBtn.setAttribute("aria-label", playing ? t("explainer.pause") : t("explainer.play"));
}
