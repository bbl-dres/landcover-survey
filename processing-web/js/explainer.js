/**
 * Explainer («Kurz erklärt»): a script-driven animation below the upload card for
 * people new to the topic. It follows one real parcel — Zollikofen, Parzelle 112,
 * EGRID CH834682352690 (js/explainer-sample.js, generated) — the way a user meets it:
 * the question on the aerial view, the search, the cadastral boundary, the land cover,
 * the two processing steps (clip, classify), the figures, the result and the exports.
 *
 * No video file and no audio: eight inline-SVG scenes over one SWISSIMAGE excerpt,
 * animated with CSS, captions from i18n (a language switch re-captions a running scene),
 * a proportional scene timeline with play / pause / replay, and a poster (the end frame
 * of the first scene — the question on the parcel — under a veil) until the user presses
 * play. Scene changes are dissolves: the outgoing frame is frozen and faded over the new
 * one, and what stays on stage (the aerial, the boundary, the surfaces) does not animate
 * again. Honours prefers-reduced-motion (scenes jump to their end frames; the user steps
 * through them). Lives inside the upload state, so it is only visible on the start page;
 * main.js pauses it when the state changes and resets it on "Neue Analyse".
 *
 * Rules that came out of the reviews (docs/reviews/2026-10-28-explainer-review.md):
 * one channel per fact — nouns that are in the picture stay on stage, the caption
 * carries the verb (≤ 10 words DE, ≤ 13 FR / IT / EN, never repeating a word on stage);
 * no sentence inside the SVG (a short line at most); nothing explanatory below 16 px
 * (the stage renders at ~0.5× on phones); one idea per scene; the same parcel in every
 * scene; the colours of the real result map; text over the aerial always with a halo.
 */
import { t, onLangChange } from "./i18n.js";
import { SAMPLE } from "./explainer-sample.js";

/** Scene order + duration (ms). */
const SCENES = [
  { id: "what", ms: 3000 },
  { id: "parcel", ms: 4000 },
  { id: "cover", ms: 3500 },
  { id: "clip", ms: 2500 },
  { id: "classify", ms: 3000 },
  { id: "figures", ms: 4500 },
  { id: "result", ms: 3000 },
  { id: "cta", ms: 2500 },
];
// 26 s in total; the length is deliberately not advertised anywhere in the UI.
const POSTER_SCENE = 0;     // the question on the parcel — the frame under the poster veil
const COUNT_MS = 900;       // KPI count-up length
const FADE_MS = 300;        // dissolve between scenes
const END_FRAME_DELAY = "-60s"; // negative delay → every CSS animation at its end frame

const reducedMotion = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

let root, stage, caption, playBtn, segs, poster;
let current = -1;        // active scene index
let playing = false;
let timer = null;        // scene advance
let sceneStart = 0, sceneElapsed = 0;
let raf = null;          // playback clock
let previewRaf = null;   // a scene picked while paused: its animations run, so do the counters

/* ── Scene material (640 × 300 viewBox; geometry from explainer-sample.js) ── */

const IMG = new URL(SAMPLE.images.tight, import.meta.url).href;
const F = SAMPLE.figures;
/** AV main group → the class the film talks about. */
const CLASS_OF = { gebaeude: "built", befestigt: "sealed", humusiert: "green", bestockt: "green", gewaesser: "water", vegetationslos: "sealed" };
/** Order in which the land-cover surfaces appear in the «Bodenbedeckung» scene. */
const MAIN_DELAY = { befestigt: 0.3, gebaeude: 0.6, humusiert: 0.9, bestockt: 1.2, gewaesser: 1.2, vegetationslos: 1.2 };

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
const fmtM2 = (n) => `${Math.round(n).toLocaleString("de-CH").replace(/[’  ]/g, "'")} m²`;
// Every scene carries both clip paths, so a frozen outgoing frame (dissolve) still finds them.
const DEFS = `<defs><clipPath id="ex-clip"><path d="${SAMPLE.parcel}"/></clipPath><clipPath id="ex-map-clip"><rect x="0" y="0" width="469" height="300"/></clipPath></defs>`;
const aerial = () => `<image href="${IMG}" x="0" y="0" width="640" height="300" preserveAspectRatio="xMidYMid slice"/>`;
const credit = () => `<text x="632" y="292" class="ex-credit ex-right">${esc(t("explainer.credit"))}</text>`;
const surfaces = (cls) => SAMPLE.surfaces.map((s) => `<path d="${s.d}" class="ex-surf ${cls(s)}"/>`).join("");
const byMain = (s) => `ex-lc-${s.main}`;
const byClass = (s) => `ex-cls-${CLASS_OF[s.main] || "sealed"}`;
/** The boundary; without classes it is simply there (carried over from the previous scene). */
const outline = (cls = "", style = "") => `<path class="ex-parcel${cls ? " " + cls : ""}" pathLength="1" d="${SAMPLE.parcel}"${style ? ` style="${style}"` : ""}/>`;
const placeLabel = () => `${SAMPLE.label.gemeinde} · ${t("explainer.parcel.no")} ${SAMPLE.label.nummer}`;
const egridSpaced = SAMPLE.egrid.replace(/^(CH)(\d{4})(\d{4})(\d{4})$/, "$1 $2 $3 $4"); // the search result's spelling
/** Pill-shaped chip with a 16 px label; width from the text length (all four languages). */
const chipW = (txt) => Math.round(txt.length * 8.8 + 30);
const chip = (x, y, txt, delay, swatch) =>
  `<g class="ex-pop" style="--d:${delay}s"><rect x="${x}" y="${y}" width="${chipW(txt) + (swatch ? 22 : 0)}" height="30" rx="15" class="ex-chip-s"/>` +
  (swatch ? `<rect x="${x + 12}" y="${y + 8}" width="14" height="14" rx="3" class="${swatch} ex-sw"/>` : "") +
  `<text x="${x + (swatch ? 34 : 15)}" y="${y + 20}" class="ex-chip-s-txt">${esc(txt)}</text></g>`;
/** A centred row of chips. */
const chipRow = (texts, y, delay0, step) => {
  const widths = texts.map(chipW), total = widths.reduce((a, b) => a + b, 0) + (texts.length - 1) * 12;
  let x = Math.round((640 - total) / 2);
  return texts.map((txt, i) => { const c = chip(x, y, txt, delay0 + i * step); x += widths[i] + 12; return c; }).join("");
};

/* ── Scenes ── */

function sceneWhat() {
  // The hook: the boundary draws itself on the aerial, the question stands top-right. Also the poster.
  return `${DEFS}
  <g class="ex-scene" data-scene="what">
    ${aerial()}
    ${outline("ex-draw ex-pulse", "--d:.3s;--p:1.1s")}
    <text x="624" y="62" class="ex-headline ex-right ex-pop" style="--d:1.2s">${esc(t("explainer.headline1"))}</text>
    <text x="624" y="98" class="ex-headline ex-right ex-pop" style="--d:1.5s">${esc(t("explainer.headline2"))}</text>
    ${credit()}
  </g>`;
}

function sceneParcel() {
  // The search as map.geo.admin.ch and the app's own field show it; the boundary stays from scene 1.
  const q = "Zollikofen 112";
  return `${DEFS}
  <g class="ex-scene" data-scene="parcel">
    ${aerial()}
    ${outline()}
    <g class="ex-pop" style="--d:.3s">
      <rect x="24" y="20" width="300" height="40" rx="8" class="ex-search"/>
      <circle cx="46" cy="40" r="6.5" class="ex-glyph"/><path d="M 51 45 L 56 50" class="ex-glyph"/>
      <text x="66" y="46" class="ex-search-txt">${esc(q)}</text>
      <rect x="66" y="26" width="${q.length * 9.4}" height="28" class="ex-type" style="--d:.5s"/>
    </g>
    <g class="ex-pop" style="--d:1.3s">
      <rect x="24" y="64" width="300" height="36" rx="8" class="ex-hit"/>
      <path d="M 40 76 L 52 74 L 54 86 L 42 89 Z" class="ex-hit-glyph"/>
      <text x="66" y="87" class="ex-hit-txt">Zollikofen 112 (${esc(egridSpaced)})</text>
    </g>
    <text x="24" y="288" class="ex-on-air-big ex-pop" style="--d:1.8s">${esc(placeLabel())}</text>
    <text x="632" y="262" class="ex-on-air ex-right ex-fade" style="--d:2.6s">${esc(t("explainer.privacy"))}</text>
    ${credit()}
  </g>`;
}

function sceneCover() {
  // The AV land cover appears over the whole aerial, group by group, then the names inside the parcel.
  const lbl = (l, i) => `<text x="${l.x}" y="${l.y + 6}" class="ex-on-air-lbl ex-center ex-pop" style="--d:${(1.5 + i * 0.2).toFixed(1)}s">${esc(t("explainer.lc." + l.key))}</text>`;
  const groups = Object.keys(MAIN_DELAY).map((m) =>
    `<g class="ex-fade" style="--d:${MAIN_DELAY[m]}s">${SAMPLE.surfaces.filter((s) => s.main === m).map((s) => `<path d="${s.d}" class="ex-surf ex-lc-${m}"/>`).join("")}</g>`).join("");
  return `${DEFS}
  <g class="ex-scene" data-scene="cover">
    ${aerial()}<rect x="0" y="0" width="640" height="300" class="ex-veil ex-fade" style="--d:.2s"/>
    ${groups}
    ${outline()}
    ${SAMPLE.labels.map(lbl).join("")}
    ${credit()}
  </g>`;
}

function sceneClip() {
  // Everything outside the boundary fades to a ghost at the cut; the inside stays. Nothing is rebuilt.
  return `${DEFS}
  <g class="ex-scene" data-scene="clip">
    ${aerial()}
    <g class="ex-ghost-only" style="--g:.6s">${surfaces(byMain)}</g>
    <g clip-path="url(#ex-clip)">${surfaces(byMain)}</g>
    ${outline("ex-pulse-only", "--p:.5s")}
    ${credit()}
  </g>`;
}

function sceneClassify() {
  // The class colours wipe across the clipped surfaces; a chip legend on the free right side.
  const legend = (y, d, cls, key) => chip(436, y, t("explainer.cls." + key), d, "ex-cls-" + cls);
  return `${DEFS}
  <g class="ex-scene" data-scene="classify">
    ${aerial()}
    <g clip-path="url(#ex-clip)">${surfaces(byMain)}</g>
    <g clip-path="url(#ex-clip)"><g class="ex-wipe" style="--d:.3s">${surfaces(byClass)}</g></g>
    ${outline()}
    ${legend(40, 1.0, "built", "built")}
    ${legend(76, 1.25, "sealed", "sealed")}
    ${legend(112, 1.5, "green", "green")}
    ${legend(148, 1.75, "water", "water")}
    ${credit()}
  </g>`;
}

function sceneFigures() {
  // The parcel's real figures count up beside the classified parcel; a compact comparison below them.
  const tile = (y, d, key, val, cls) => `
    <g class="ex-pop" style="--d:${d}s"><text x="420" y="${y}" class="ex-kpi-air ${cls}" data-count="${val}">0</text><text x="420" y="${y + 22}" class="ex-kpi-lbl-air">${esc(t(key))}</text></g>`;
  const w = (pct) => Math.round(156 * pct / 100);
  const bar = (y, d, label, parts, strong) => {
    let x = 462;
    const segsHtml = parts.map(([cls, width], i) => { const r = `<rect x="${x}" y="${y}" width="${width}" height="10" rx="3" class="ex-bar ex-cls-${cls}" style="--d:${(d + 0.1 + i * 0.15).toFixed(2)}s"/>`; x += width; return r; }).join("");
    return `<g class="ex-fade" style="--d:${d}s"><text x="454" y="${y + 9}" class="ex-leg-s ex-right${strong ? " ex-strong" : ""}">${esc(label)}</text><rect x="462" y="${y}" width="156" height="10" rx="3" class="ex-bar-bg"/>${segsHtml}</g>`;
  };
  return `${DEFS}
  <g class="ex-scene" data-scene="figures">
    ${aerial()}
    <g clip-path="url(#ex-clip)">${surfaces(byClass)}</g>
    ${outline()}
    <rect x="404" y="24" width="228" height="258" rx="8" class="ex-panel-air ex-fade" style="--d:.2s"/>
    ${tile(66, 0.3, "explainer.kpi.sealed", `${F.pct_sealed}%`, "ex-c-grey")}
    ${tile(122, 0.7, "explainer.kpi.green", `${F.pct_green}%`, "ex-c-green")}
    ${tile(178, 1.1, "explainer.kpi.ggf", fmtM2(F.ggf_m2), "ex-c-blue")}
    <text x="420" y="232" class="ex-leg-b ex-fade" style="--d:2s">${esc(t("explainer.compare"))}</text>
    ${bar(244, 2.2, SAMPLE.label.nummer, [["sealed", w(F.pct_sealed)], ["green", w(F.pct_green)], ["water", w(F.pct_water)]], true)}
    ${bar(258, 2.45, "A", [["sealed", 111], ["green", 45]])}
    ${bar(272, 2.7, "B", [["sealed", 24], ["green", 132]])}
    ${credit()}
  </g>`;
}

function sceneResult() {
  // The app window: map (aerial + classified parcel), the summary donut drawing the real split, table; export chips.
  const seg = (pct, off, cls, d) => `<circle cx="280" cy="121" r="24" pathLength="100" class="ex-donut ex-cls-${cls}" style="--len:${pct};--off:${off};--d:${d}s"/>`;
  const chips = ["Excel", "CSV", "GeoJSON"];
  let x = 372;
  const exportChips = chips.map((c, i) => { const h = chip(x, 104, c, 1.6 + i * 0.1); x += chipW(c) + 8; return h; }).join("");
  return `${DEFS}
  <g class="ex-scene" data-scene="result">
    <g class="ex-pop" style="--d:.25s">
      <rect x="40" y="40" width="300" height="200" rx="8" class="ex-browser"/><rect x="40" y="40" width="300" height="18" rx="8" class="ex-browser-bar"/>
      <g transform="translate(48 66) scale(.367)" clip-path="url(#ex-map-clip)">
        ${aerial()}
        <g clip-path="url(#ex-clip)">${surfaces(byClass)}</g>
        <path d="${SAMPLE.parcel}" class="ex-parcel-mini"/>
      </g>
      <rect x="228" y="66" width="104" height="110" rx="4" class="ex-panel"/>
      <circle cx="280" cy="121" r="24" class="ex-donut-bg"/>
      ${seg(F.pct_sealed, 0, "sealed", 0.7)}${seg(F.pct_green, F.pct_sealed, "green", 0.85)}${seg(F.pct_water, F.pct_sealed + F.pct_green, "water", 1.0)}
    </g>
    <g class="ex-fade" style="--d:1.1s"><rect x="48" y="184" width="284" height="48" rx="4" class="ex-panel"/>
      <line x1="56" y1="196" x2="324" y2="196" class="ex-row"/><line x1="56" y1="208" x2="324" y2="208" class="ex-row"/><line x1="56" y1="220" x2="324" y2="220" class="ex-row"/></g>
    <text x="372" y="90" class="ex-note ex-fade" style="--d:1.5s">${esc(t("explainer.export"))}</text>
    ${exportChips}
  </g>`;
}

function sceneCta() {
  return `${DEFS}
  <g class="ex-scene" data-scene="cta">
    <text x="320" y="96" class="ex-cta ex-center ex-pop" style="--d:.2s">${esc(t("explainer.cta.title"))}</text>
    ${chipRow([t("explainer.cta.chip1"), t("explainer.cta.chip2"), t("explainer.cta.chip3")], 122, 0.5, 0.2)}
    <path d="M 320 250 L 320 190 M 300 210 L 320 190 L 340 210" class="ex-arrow ex-arrow-big ex-draw" pathLength="1" style="--d:.9s"/>
  </g>`;
}

const SCENE_SVG = { what: sceneWhat, parcel: sceneParcel, cover: sceneCover, clip: sceneClip, classify: sceneClassify, figures: sceneFigures, result: sceneResult, cta: sceneCta };

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
  // «Kurz erklärt ↓» links (upload card) scroll down to the poster and focus it.
  document.querySelectorAll('a[href="#explainer"]').forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    root.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
    (poster.hidden ? playBtn : poster).focus({ preventScroll: true });
  }));
  document.addEventListener("visibilitychange", () => { if (document.hidden && playing) pause(); });
  onLangChange(() => { renderStatic(); if (current >= 0) showScene(current, { keepProgress: true, silent: !playing }); if (!poster.hidden) renderSegs(0); });

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

/** Poster = the end frame of the first scene under the veil, the timeline empty. */
function showPoster() {
  poster.hidden = false;
  showScene(POSTER_SCENE, { silent: true, endFrame: true });
  renderSegs(0);
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
  if (previewRaf) { cancelAnimationFrame(previewRaf); previewRaf = null; }
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

/** While paused, a scene chosen from the timeline still plays its CSS animations once;
 *  the JS counters and the segment fill follow the same clock until the scene is over. */
function previewScene() {
  if (previewRaf) cancelAnimationFrame(previewRaf);
  const run = () => {
    previewRaf = null;
    if (playing || current < 0) return;
    sceneElapsed = Math.min(performance.now() - sceneStart, SCENES[current].ms);
    renderCounters(sceneElapsed);
    renderSegs();
    if (sceneElapsed < SCENES[current].ms) previewRaf = requestAnimationFrame(run);
  };
  previewRaf = requestAnimationFrame(run);
}

/**
 * Switch to scene `i`: swap the SVG (restarting its CSS animations), dissolve from the
 * outgoing frame, update caption + timeline. `keepProgress` re-renders mid-scene
 * (language switch) and fast-forwards the animations; `endFrame` shows the finished
 * scene (poster, reduced motion).
 */
function showScene(i, { silent = false, keepProgress = false, endFrame = false } = {}) {
  const changed = i !== current;
  current = i;
  const scene = SCENES[i];
  if (!keepProgress) sceneElapsed = endFrame ? scene.ms : 0;
  sceneStart = performance.now() - sceneElapsed;
  // Dissolve: the outgoing scene, frozen on its end frame, fades out over the new one.
  let ghost = null;
  const outgoing = changed && !silent && !reducedMotion() && stage.animate ? stage.querySelector(".ex-scene") : null;
  if (outgoing) {
    ghost = outgoing.cloneNode(true);
    ghost.classList.replace("ex-scene", "ex-scene-out");
    ghost.querySelectorAll("*").forEach((n) => { n.style.animationDelay = END_FRAME_DELAY; n.style.animationPlayState = "paused"; });
  }
  stage.innerHTML = SCENE_SVG[scene.id]();
  if (ghost) {
    stage.appendChild(ghost);
    ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: "ease-in-out" }).onfinish = () => ghost.remove();
  }
  root.querySelector(".ex-stage").classList.toggle("ex-link", scene.id === "cta");
  const jump = endFrame || reducedMotion();
  if (jump) {
    stage.querySelectorAll(".ex-scene *").forEach((n) => { n.style.animationDelay = END_FRAME_DELAY; });
  } else if (keepProgress && sceneElapsed > 0) {
    stage.querySelectorAll(".ex-scene *").forEach((n) => { n.style.animationDelay = `calc(var(--d, 0s) - ${Math.round(sceneElapsed)}ms)`; });
  }
  if (!playing) setAnimState(silent ? "paused" : "running");
  if (previewRaf) { cancelAnimationFrame(previewRaf); previewRaf = null; }
  if (!playing && !silent && !jump) previewScene();
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

/** Timeline fill; `force` (ms) overrides the clock (the poster shows an empty timeline). */
function renderSegs(force) {
  const elapsed = force != null ? force : playing ? performance.now() - sceneStart : sceneElapsed;
  segs.forEach((b, j) => {
    const pct = force != null ? 0 : j < current ? 100 : j > current ? 0 : Math.min(100, (elapsed / SCENES[j].ms) * 100);
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
