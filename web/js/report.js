/**
 * Self-contained HTML report export.
 *
 * Bundles the whole web app into a single .html file: every local JS module
 * (inlined as `data:` URLs behind an import map), the app CSS, and the shell
 * from index.html — with the processed results embedded as JSON. Third-party
 * libraries (MapLibre, Turf, fonts) stay as CDN links, so the file is one
 * document that needs an internet connection but no server. Opening it boots
 * straight into the results view (map + table + summary); "Neue Analyse" still
 * works (it re-processes live, online).
 *
 * Requires a browser that supports import maps + module scripts from data: URLs
 * (Chrome 89+, Firefox 108+, Safari 16.4+) — the same modern baseline the app
 * already targets (ES modules, MapLibre 4).
 */

/** Resolve a path against the app root (web/), wherever the app is deployed. */
const appUrl = (p) => new URL(p, new URL("../", import.meta.url)).href;

async function fetchText(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Report build: fetch failed (${resp.status}) for ${url}`);
  return resp.text();
}

/** Strip JS comments so import discovery never matches a specifier mentioned in
 *  prose (e.g. this file's own docs). Used only for scanning — never for the
 *  bundled output. The `[^:]` guard keeps `https://` URLs intact. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/gm, "$1");
}

/** Recursively fetch the entry module and every local module it imports.
 *  Returns a Map of basename → source text. */
async function fetchModuleGraph(entry = "main.js") {
  const jsBase = new URL("./", import.meta.url); // .../web/js/
  const sources = new Map();
  const queue = [entry];
  const importRe = /\b(?:from|import)\s+["']\.\/([\w.\-/]+\.js)["']/g;
  while (queue.length) {
    const name = queue.shift();
    if (sources.has(name)) continue;
    const src = await fetchText(new URL(name, jsBase).href);
    sources.set(name, src);
    for (const m of stripComments(src).matchAll(importRe)) {
      if (!sources.has(m[1])) queue.push(m[1]);
    }
  }
  return sources;
}

/** Rewrite relative module specifiers like `./config.js` to bare (`config.js`)
 *  so they resolve through the import map regardless of the importing module's
 *  (data:) base URL — bare specifiers always resolve via the import map. */
function toBareSpecifiers(src) {
  return src.replace(/(\b(?:from|import)\s+["'])\.\/([\w.\-/]+\.js)(["'])/g, "$1$2$3");
}

function jsToDataUrl(src) {
  return "data:text/javascript;charset=utf-8," + encodeURIComponent(toBareSpecifiers(src));
}

/** Neutralize `</script>` / `<!--` inside embedded JSON by escaping `<`. */
function safeJson(obj) {
  return JSON.stringify(obj).replace(/</g, "\\u003c");
}

function reportFilename(inputName) {
  const base = (inputName || "").replace(/\.[^.]+$/, "").trim();
  return (base ? `${base}-report` : "landcover-report") + ".html";
}

function saveBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/**
 * Build and download a single-file HTML report from the processed results.
 * @param {{parcels: object[], landcover: object[]}} results
 * @param {{filename?: string, lang?: string}} meta
 * @param {string} [filename] explicit output name (defaults to <input>-report.html)
 */
export async function downloadReportHTML(results, meta = {}, filename) {
  // 1. App shell.
  let html = await fetchText(appUrl("index.html"));

  // 2. Inline local stylesheets (skip CDN <link>s, which we keep as-is).
  for (const m of [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*href=["'](?!https?:)([^"']+)["'][^>]*>/g)]) {
    const css = await fetchText(appUrl(m[1]));
    html = html.replace(m[0], `<style>\n${css}\n</style>`);
  }

  // 3. Bundle every local JS module behind an import map of data: URLs.
  const modules = await fetchModuleGraph("main.js");
  const importMap = { imports: {} };
  for (const [name, src] of modules) importMap.imports[name] = jsToDataUrl(src);

  // 4. Absolutize remaining local asset refs (../assets, ../data, …) so the
  //    upload screen still renders when the file is opened elsewhere.
  html = html.replace(/\b(src|href)=["'](\.\.?\/[^"']+)["']/g, (_full, attr, path) => `${attr}="${appUrl(path)}"`);

  // 5. Embed only `parcels` (each carries its _landcover); the flat landcover
  //    array is reconstructed at load — it equals parcels.flatMap(p => _landcover).
  const payload = safeJson({ parcels: results.parcels });
  const metaJson = safeJson({ filename: meta.filename || "", generated: new Date().toISOString() });
  const lang = JSON.stringify(meta.lang || "de");

  const boot =
    `<script type="application/json" id="__embedded_results__">${payload}</scr` + `ipt>\n` +
    `  <script>window.__EMBEDDED_LANG__=${lang};window.__EMBEDDED_META__=${metaJson};</scr` + `ipt>\n` +
    `  <script type="importmap">${JSON.stringify(importMap)}</scr` + `ipt>\n` +
    `  <script type="module">import "main.js";</scr` + `ipt>`;

  // 6. Replace the app's module entry point with the bundle.
  html = html.replace(
    /<script[^>]+type=["']module["'][^>]*src=["'][^"']*main\.js["'][^>]*>\s*<\/script>/,
    boot
  );

  saveBlob(
    new Blob([html], { type: "text/html;charset=utf-8" }),
    filename || reportFilename(meta.filename)
  );
}
