// Run the web app's own processing on a parcel list — without a browser — and write
// the GeoJSON it would download. Used to (re)create the web side of the live parity
// fixture (tests/fixtures/live/web-export.geojson) and for ad-hoc cross-checks:
//
//   node processing-cli/tests/web_export.mjs <parcels.csv> <out.geojson>
//
// It imports the real browser modules (userinput.js → processor.js → geoapi.js →
// export.js) and the Turf build index.html pins, fetched from the same CDN; only the
// browser globals the modules touch at import time are stubbed. Node and Chrome share
// the V8 engine, so the numbers (incl. Math.sin, which the area formula depends on)
// are the ones the browser produces. Needs Node >= 21 and internet access.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const [, , listPath, outPath] = process.argv;
if (!listPath || !outPath) {
  console.error("usage: node web_export.mjs <parcels.csv> <out.geojson>");
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, "..", "..", "processing-web");
const webJs = pathToFileURL(path.join(webDir, "js") + path.sep).href;

// Browser globals touched at import time (same stubs as js_dump.mjs).
globalThis.window = { location: { search: "" } };
globalThis.document = { documentElement: {}, title: "", querySelectorAll: () => [], getElementById: () => null,
  createElement: () => ({ textContent: "", get innerHTML() { return this.textContent; } }) };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = url instanceof URL ? url : new URL(String(url));
  if (u.protocol === "file:") {
    const txt = await readFile(fileURLToPath(u), "utf8");
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => JSON.parse(txt), text: async () => txt };
  }
  return nativeFetch(url, opts);
};

// The Turf build the app loads — read the pinned URL from index.html so the two cannot drift.
const indexHtml = await readFile(path.join(webDir, "index.html"), "utf8");
const turfUrl = /<script src="(https:\/\/[^"]*@turf\/turf@[^"]+)"/.exec(indexHtml)?.[1];
if (!turfUrl) throw new Error("no pinned Turf <script> found in processing-web/index.html");
const turfResp = await nativeFetch(turfUrl);
if (!turfResp.ok) throw new Error(`Turf download failed: HTTP ${turfResp.status}`);
vm.runInThisContext(await turfResp.text(), { filename: "turf.min.js" });
if (!globalThis.turf?.area) throw new Error("Turf did not register as a global");

const ui = await import(webJs + "userinput.js");
const proc = await import(webJs + "processor.js");
const exp = await import(webJs + "export.js");

const { rows } = ui.normalizeParsed(ui.parseText(ui.decodeText(await readFile(listPath))));
const results = await proc.processRows(rows, () => {}, { bauzonen: true, habitat: true, synthLandcover: true });
await writeFile(outPath, exp.buildGeoJSON(results), "utf8");
const found = results.parcels.filter((p) => p.status === "found").length;
console.error(`web export: ${results.parcels.length} parcels (${found} found), ${results.landcover.length} land-cover, ` +
  `${results.bauzonen.length} bauzonen, ${results.habitat.length} habitat rows → ${outPath} (Turf: ${turfUrl})`);
