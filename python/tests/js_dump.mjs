// Evaluate the web app's classification tables, pure helpers and aggregation on the
// shared parity cases (tests/fixtures/parity_cases.json) and print the results as
// JSON — tests/test_parity_js.py compares them with the Python modules.
//
//   node python/tests/js_dump.mjs python/tests/fixtures/parity_cases.json
//
// The app modules are browser ES modules; the few browser globals they touch at
// import time (window.location, document, localStorage) are stubbed here, and
// fetch() of a file: URL (the shared data/typoch.json reference) reads from disk.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

globalThis.window = { location: { search: "" } };
globalThis.document = { documentElement: {}, title: "", querySelectorAll: () => [], getElementById: () => null,
  createElement: () => ({ textContent: "", get innerHTML() { return this.textContent; } }) };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = url instanceof URL ? url : new URL(String(url));
  if (u.protocol === "file:") {
    const txt = await readFile(fileURLToPath(u), "utf8");
    return { ok: true, status: 200, json: async () => JSON.parse(txt), text: async () => txt };
  }
  return nativeFetch(url, opts);
};

const here = path.dirname(fileURLToPath(import.meta.url));
const webJs = pathToFileURL(path.join(here, "..", "..", "web", "js") + path.sep).href;
const cfg = await import(webJs + "config.js");
const proc = await import(webJs + "processor.js");
await cfg.ensureTypoch();

const cases = JSON.parse(await readFile(process.argv[2], "utf8"));
const mapOf = (keys, fn) => Object.fromEntries(keys.map((k) => [k, fn(k)]));
const stripColor = (table) => Object.fromEntries(Object.entries(table).map(([k, v]) => {
  const { color, ...rest } = v; return [k, rest];
}));
/** Public view of a row: every key except the geometry, in insertion order. */
const rowView = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== "_geometry"));

const lcRows = cases.landcover_rows.map(([art, area, bfsnr]) =>
  proc.makeLandcoverRow("P1", "CH1", art, { fid: "", bfsnr, gwrEgid: "" }, area, null));
const synthRow = proc.makeLandcoverRow("P1", "CH1", "Gebaeude", { lcSource: "BAFU", typoch: "9.2 Bauten" }, 12.345, null);
const hbRows = cases.habitat_rows.map(([typoch, area], i) => proc.makeHabitatRow("P1", "CH1", typoch, "", String(100 + i), area, null));
const bzRows = cases.bauzonen_rows.map(([name, code, area], i) => proc.makeBauzoneRow("P1", "CH1", name, code, name === "Ohne Bauzone" ? "" : String(200 + i), area, null));

const out = {
  tables: {
    SIA416: cfg.SIA416,
    GREEN_SPACE: cfg.GREEN_SPACE,
    VBS_KATEGORIE: cfg.VBS_KATEGORIE,
    VBS_PRODUKTIV: cfg.VBS_PRODUKTIV,
    VBS_TYP: cfg.VBS_TYP,
    SEALED: [...cfg.SEALED].sort(),
    VBS_KATEGORIE_LABELS: cfg.VBS_KATEGORIE_LABELS,
    VBS_PRODUKTIV_LABELS: cfg.VBS_PRODUKTIV_LABELS,
    VBS_TYP_LABELS: cfg.VBS_TYP_LABELS,
    BAFU_TYPOCH_L1: stripColor(cfg.BAFU_TYPOCH_L1),
    BAFU_TYPOCH_REFINE: cfg.BAFU_TYPOCH_REFINE,
    TYPOCH_BBART: cfg.TYPOCH_BBART,
    STATUS: cfg.STATUS,
    ERR_MSG: cfg.ERR_MSG,
    ERR_RUNTIME_PREFIX: cfg.ERR_RUNTIME_PREFIX,
  },
  classify: mapOf(cases.arts, (a) => cfg.classify(a)),
  classifyBafu: mapOf(cases.typoch, (t) => cfg.classifyBafu(t)),
  typochToBBArt: mapOf(cases.typoch, (t) => cfg.typochToBBArt(t)),
  labels: mapOf(cases.typoch, (t) => ({
    l1: cfg.typochL1Label(t), l2: cfg.typochL2Label(t), l3: cfg.typochL3Label(t),
    c1: cfg.typochCodeAtLevel(t, 1), c2: cfg.typochCodeAtLevel(t, 2), c3: cfg.typochCodeAtLevel(t, 3),
    code: cfg.typochCode(t), l1digit: cfg.typochL1(t),
  })),
  slugify: mapOf(cases.slugs, (s) => cfg.slugify(s)),
  bauzoneAreaKey: mapOf(cases.slugs, (s) => cfg.bauzoneAreaKey(s)),
  habitatKeys: mapOf(cases.habitat_codes, (c) => ({ l1: cfg.habitatAreaKeyL1(c), l2: cfg.habitatAreaKeyL2(c) })),
  numbers: cases.numbers.map((x) => ({ x, toFixed1: x.toFixed(1), round2: proc.round2(x) })),
  normalizeEgrid: mapOf([" ch4277 ", "CH1", "", "  "], (s) => cfg.normalizeEgrid(s)),
  landcover: { rows: lcRows.map(rowView), synth: rowView(synthRow), agg: proc.aggregateLandCover(lcRows), bfsnr: proc.dominantBfsnr(lcRows) },
  habitat: { rows: hbRows.map(rowView), agg: proc.aggregateHabitat(hbRows) },
  bauzonen: { rows: bzRows.map(rowView), agg: proc.aggregateBauzonen(bzRows) },
};
process.stdout.write(JSON.stringify(out));
