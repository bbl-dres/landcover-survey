// Logic tests for the dashboard (node:test, no dependencies; run with `npm test` from the repo root).
//
// dashboard/js/dashboard.js is one browser script. It is evaluated here exactly as shipped, in a context that
// has `window` (with the generated reference tables of js/data.js) but no `document`: the script then takes its
// test hook (the block in front of boot()), hands out its pure functions as window.DASHBOARD_CORE and stops
// before anything touches a page. So these tests run the REAL code of readGeojson, the allowlist, the
// aggregation, the Datenqualität rules and the URL validators — not a copy and not an extract of the source.
//
// One test (at least) per fixed finding of the 2026-11 review; each of them fails on the behaviour before the fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const src = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const ctx = { window: {}, console };
vm.createContext(ctx);
vm.runInContext(src("../js/data.js"), ctx, { filename: "data.js" });
vm.runInContext(src("../js/dashboard.js"), ctx, { filename: "dashboard.js" });
const C = ctx.window.DASHBOARD_CORE;
const ART = Object.keys(ctx.window.DASHBOARD_DATA.landcover.types);
const plain = (v) => JSON.parse(JSON.stringify(v)); // objects built inside the vm context have another realm's prototypes

// ---- fixtures ----
const AREAS = { sia416_ggf_m2: 200, sia416_buf_m2: 300, sia416_uuf_m2: 500, greenspace_m2: 600, sealed_m2: 400,
                av_produktiv_m2: 600, av_unproduktiv_m2: 400, av_typ1_m2: 100, av_typ2_m2: 500 };
const GEOM = { type: "Polygon", coordinates: [[[7.4, 46.9], [7.41, 46.9], [7.41, 46.91], [7.4, 46.9]]] };
let seq = 0;
/** A resolved parcel of 1000 m² with complete land cover (60 % green, 40 % sealed). */
const found = (over = {}) => ({ id: "P" + (++seq), egrid: "CH" + String(100000000000 + seq), check_egrid: "found", check_wfs: "ok", check_geom: "ok",
                                parcel_area_m2: 1000, _geom: GEOM, ...AREAS, ...over });
/** The same parcel after a failed land-cover request; `cell` is what the export wrote into the area columns. */
const failed = (cell, over = {}) => {
  const p = found({ check_wfs: "wfs_error", lc_source: "", ...over });
  for (const k of Object.keys(AREAS)) { if (cell === undefined) delete p[k]; else p[k] = cell; }
  return p;
};
/** A row whose E-GRID was not resolved: no geometry, no area. */
const unresolved = (status = "invalid", over = {}) => ({ id: "E" + (++seq), egrid: "-", check_egrid: status, check_wfs: "", check_geom: "",
                                                         parcel_area_m2: "", ...over });
const agg = (rows) => C.aggregateRows(rows, C.datasetSchema(rows));
const rules = (rows) => C.checkRules(rows, C.datasetSchema(rows));
const fc = (features) => JSON.stringify({ type: "FeatureCollection", features });
const feat = (properties, geometry = null) => ({ type: "Feature", geometry, properties });

test("test hook: the shipped script hands out its core without a DOM and does not boot", () => {
  assert.equal(typeof C, "object");
  for (const fn of ["readGeojson", "allowlist", "aggregateRows", "checkRules", "readSet"]) assert.equal(typeof C[fn], "function", fn);
  assert.equal(C.RULE_DEFS.length, 8);
});

// ── Finding 1: a failed request is unknown, not 0 ────────────────────────────────────────────────────────
test("1 · a parcel whose land-cover request failed is left out of the denominator of the shares", () => {
  for (const cell of ["", 0, null, undefined]) { // current exports write "", older ones 0: the check_wfs flag decides, not the cell
    const a = agg([found(), failed(cell)]);
    assert.equal(a.totals.parcelArea, 2000, "its area is part of the GSF");
    assert.equal(a.totals.lcUnknownArea, 1000);
    assert.equal(a.nLcUnknown, 1);
    assert.equal(a.lcKnownArea, 1000);
    assert.equal(C.pct(a.totals.Green, a.lcKnownArea), 60, `green share with cell ${JSON.stringify(cell)} (was 30: the failed parcel counted as 0 % green)`);
    assert.equal(C.pct(a.totals.Sealed, a.lcKnownArea), 40);
    assert.equal(a.withData, 1);
    assert.equal(a.nNoCover, 0, "unknown is not «ohne Bodenbedeckung»");
  }
});

test("1 · summary tables split the remainder: «nicht abrufbar» (unknown) apart from «Ohne Bodenbedeckung»", () => {
  const a = agg([found(), failed(""), found({ ...Object.fromEntries(Object.keys(AREAS).map((k) => [k, 0])) })]); // + one found parcel that truly has no cover
  const items = [{ name: "Versiegelt", value: a.totals.Sealed }, { name: "Unversiegelt", value: a.classified - a.totals.Sealed }];
  const rows = plain(C.withRemainder(items, a.totals.parcelArea, null, a.nNoCover, { label: "Bodenbedeckung nicht abrufbar", area: a.totals.lcUnknownArea, n: a.nLcUnknown }));
  assert.deepEqual(rows.map((r) => [r.name, r.value]), [["Versiegelt", 400], ["Unversiegelt", 600], ["Bodenbedeckung nicht abrufbar", 1000], ["Ohne Bodenbedeckung", 1000]]);
  assert.equal(rows.reduce((s, r) => s + r.value, 0), a.totals.parcelArea, "the table still sums to the GSF");
  // Bauzonen: the area of a parcel whose request failed must not be claimed as «Ohne Bauzone».
  const b = agg([found({ check_bauzonen: "ok", bauzonen_wohnzonen_m2: 700, bauzonen_ohne_bauzone_m2: 300 }), found({ check_bauzonen: "error", bauzonen_wohnzonen_m2: "" })]);
  assert.equal(b.totals.bzUnknownArea, 1000);
  const bz = plain(C.withRemainder([{ name: "Wohnzonen", value: b.byBauzone.wohnzonen }], b.totals.parcelArea, "Ohne Bauzone", null, { label: "Bauzonen nicht abrufbar", area: b.totals.bzUnknownArea, n: b.nBzUnknown }));
  assert.deepEqual(bz.map((r) => [r.name, r.value]), [["Wohnzonen", 700], ["Bauzonen nicht abrufbar", 1000], ["Ohne Bauzone", 300]]);
  // No remainder row out of float noise.
  assert.equal(C.withRemainder([{ name: "x", value: 999.9999999 }], 1000, null, 0, null).length, 1);
});

test("1 · Datenqualität: a failed request is a deviation (land cover, Bauzonen, Lebensräume), not a skipped check", () => {
  const p = failed(""), bz = found({ check_bauzonen: "error" }), hb = found({ check_habitat: "error" });
  const R = rules([found(), p, bz, hb]);
  assert.equal(R.lcFetch.fail, 1, "rule «Bodenbedeckung abgerufen»");
  assert.equal(R.lcFetch.pass, 3);
  assert.equal(R.lcFetch.fails[0].p, p);
  assert.equal(R.bzCover.fail, 1); assert.equal(R.bzCover.fails[0].p, bz);
  assert.equal(R.hbCover.fail, 1); assert.equal(R.hbCover.fails[0].p, hb);
  const S = C.datasetSchema([p, bz, hb]);
  assert.equal(C.devValues("lcFetch", p, {}, S).ist, "nicht abrufbar");
  assert.equal(C.devValues("bzCover", bz, {}, S).ist, "nicht abrufbar");
  assert.equal(C.devValues("hbCover", hb, {}, S).ist, "nicht abrufbar");
  assert.equal(rules([unresolved()]).lcFetch.pass + rules([unresolved()]).lcFetch.fail, 0, "only resolved parcels are asked");
  // An older export that substituted modelled cover after a failed request: the rule reports it, the areas stay in.
  const legacy = found({ check_wfs: "wfs_error", lc_synthetic: "yes" });
  assert.equal(C.lcFailed(legacy), false);
  assert.equal(rules([legacy]).lcFetch.fail, 1);
});

test("1 · table, sort, Excel and PDF show an unknown value as unknown, never as 0", () => {
  const ok = found(), zero = found({ greenspace_m2: 0 }), bad = failed(0), err = unresolved();
  const col = { key: "greenspace_m2", num: true, lc: true }, area = { key: "parcel_area_m2", num: true };
  assert.equal(C.valueKnown(ok, "greenspace_m2", true), true);
  assert.equal(C.valueKnown(zero, "greenspace_m2", true), true, "a real zero is known");
  assert.equal(C.valueKnown(bad, "greenspace_m2", true), false, "0 from an older export, but the request failed");
  assert.equal(C.valueKnown(failed(""), "greenspace_m2", true), false);
  assert.equal(C.valueKnown(bad, "parcel_area_m2", false), true, "the parcel area itself is known");
  assert.equal(C.valueKnown(err, "parcel_area_m2", false), false);
  // Excel: an empty cell (null), not the number 0.
  assert.equal(C.exportCell(ok, col), 600);
  assert.equal(C.exportCell(zero, col), 0);
  assert.equal(C.exportCell(bad, col), null);
  assert.equal(C.exportCell(failed(""), col), null);
  assert.equal(C.exportCell(err, area), null);
  // Sort: unknown after every known value, ascending and descending.
  for (const dir of [1, -1]) {
    const order = [bad, ok, zero].sort((a, b) => C.numCompare(a, b, "greenspace_m2", true, dir));
    assert.equal(order[2], bad, `unknown last (dir ${dir})`);
    assert.equal(order[0], dir === 1 ? zero : ok);
  }
  // PDF contents page / parcel card.
  assert.equal(C.greenShareText(ok), "60%");
  assert.equal(C.greenShareText(zero), "0%");
  assert.equal(C.greenShareText(bad), "–");
  assert.equal(C.greenShareText(err), "–");
  assert.equal(C.areaText(err.parcel_area_m2), "–");
  assert.equal(C.areaText(1000), "0.1 ha"); // number and unit are joined by a no-break space
});

// ── Finding 4: one parcel listed twice counts once ──────────────────────────────────────────────────────
test("4 · the same found E-GRID under two ids counts once in every total, and is drawn once", () => {
  const a1 = found({ egrid: "CH111111111111", input_tpf: "1" }), a2 = { ...a1, id: "second-id", input_tpf: "2" }, b = found();
  const rows = [a1, b, a2], rep = C.egridRepeats(rows);
  assert.equal(rep.size, 1);
  assert.equal(rep.get(a2), a1, "the first row counts, the repeat points to it");
  const a = C.aggregateRows(rows, C.datasetSchema(rows), rep);
  assert.equal(a.len, 3, "rows stay rows");
  assert.equal(a.n, 2, "two parcels");
  assert.equal(a.totals.parcelArea, 2000, "was 3000");
  assert.equal(a.totals.Green, 1200);
  assert.equal(a.dupRows, 1);
  assert.equal(a.dupArea, 1000);
  assert.equal(a.nT2, 2, "counts by the 10 % rule are per parcel as well");
  const drawn = plain(C.rowsToFC(rows, rep)).features.map((f) => f.properties.id);
  assert.deepEqual(drawn, [a1.id, b.id], "one polygon per parcel");
  assert.equal(C.rowsToFC(rows).features.length, 3, "without the repeat map every row is drawn (single-parcel views)");
  // Sorting the table must not change which row counts: with the dataset position, the earliest row wins.
  const pos = new Map([[a1, 0], [b, 1], [a2, 2]]), sorted = [a2, b, a1];
  assert.equal(C.egridRepeats(sorted, (p) => pos.get(p)).get(a2), a1);
  assert.equal(C.egridRepeats(sorted).get(a1), a2, "without positions: the first row of the row set");
  // Rows without a resolved E-GRID are never merged, whatever text they share.
  assert.equal(C.egridRepeats([unresolved(), unresolved(), unresolved("not_found")]).size, 0);
});

// ── Finding 5: «E-GRID eindeutig» ────────────────────────────────────────────────────────────────────────
test("5 · «E-GRID eindeutig» judges resolved parcels only", () => {
  const a1 = found({ egrid: "CH222222222222" }), a2 = { ...a1, id: "dup" };
  const R = rules([a1, a2, found(), unresolved(), unresolved(), unresolved("not_found")]); // three unresolved rows share the text "-"
  assert.equal(R.egridUnique.fail, 2, "the two rows of the duplicated parcel (was 5: the unresolved rows counted too)");
  assert.equal(R.egridUnique.pass, 1);
  const counts = C.egridCounts([found({ egrid: "constructor" }), found({ egrid: "toString" }), unresolved()]);
  assert.equal(counts.constructor, 1, "a prototype-free counter");
  assert.equal(counts.toString, 1);
  assert.equal(Object.keys(counts).length, 2);
});

// ── Finding 6: mean, and who is «ohne Bodenbedeckung» ───────────────────────────────────────────────────
test("6 · the mean parcel area divides by the parcels that have an area", () => {
  const a = agg([found(), found({ parcel_area_m2: 3000 }), unresolved(), unresolved("not_found")]);
  assert.equal(a.n, 4);
  assert.equal(a.nArea, 2);
  assert.equal(a.totals.parcelArea / a.nArea, 2000, "was 1000: the two rows without a parcel diluted it");
});

test("6 · unresolved E-GRIDs, failed requests and found-but-uncovered parcels are three different things", () => {
  const none = found(Object.fromEntries(Object.keys(AREAS).map((k) => [k, 0])));
  assert.equal(C.coverState(found()), "with");
  assert.equal(C.coverState(none), "without");
  assert.equal(C.coverState(failed("")), "unknown");
  assert.equal(C.coverState(unresolved()), "unresolved");
  assert.equal(C.coverState(unresolved("error:timeout")), "unresolved");
  const a = agg([found(), none, failed(""), unresolved(), unresolved()]);
  assert.deepEqual([a.withData, a.nNoCover, a.nLcUnknown, a.nUnresolved], [1, 1, 1, 2], "«ohne Bodenbedeckung» was 4");
});

// ── Finding 7 ────────────────────────────────────────────────────────────────────────────────────────────
test("7 · «biologisch produktiv» counts by one rule in the table and in the filter", () => {
  const p = found({ av_typ1_m2: 60, av_typ2_m2: 70, av_produktiv_m2: 130, av_unproduktiv_m2: 870 }); // 6 % + 7 % = 13 % productive
  assert.equal(C.vbsHas(p, "av_produktiv_m2"), true, "the filter facet's rule");
  const a = agg([p]);
  assert.equal(a.nP, 1, "the table's count (was 0: neither type alone reaches 10 %)");
  assert.deepEqual([a.nT1, a.nT2], [0, 0]);
});

// ── Finding 8 ────────────────────────────────────────────────────────────────────────────────────────────
test("8 · URL validators accept own keys only", () => {
  const good = { excl: "PP", art: ART[0], has: "Green", vbsp: "produktiv", vbst: "typ1", gi: "yes" };
  for (const [facet, value] of Object.entries(good)) {
    assert.equal(C.URL_VALID[facet](value), true, `${facet}=${value}`);
    for (const k of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf", "nope"]) assert.equal(C.URL_VALID[facet](k), false, `${facet}=${k}`);
  }
  const pr = new URLSearchParams(`art=${ART[0]},constructor,toString&has=Sealed,__proto__,valueOf&kanton=BE,ZH`);
  assert.deepEqual(Object.keys(C.readSet(pr, "art", C.URL_VALID.art)), [ART[0]]);
  assert.deepEqual(Object.keys(C.readSet(pr, "has", C.URL_VALID.has)), ["Sealed"]);
  assert.deepEqual(Object.keys(C.readSet(pr, "kanton")), ["BE", "ZH"], "data-driven facets accept any value");
  assert.deepEqual(Object.keys(C.readSet(pr, "tpf")), []);
  assert.equal(C.greeninvLabel("constructor"), "—", "labels are own-property lookups too");
});

// ── Finding 9 ────────────────────────────────────────────────────────────────────────────────────────────
test("9 · readGeojson: what is skipped is counted by reason", () => {
  const g = C.readGeojson(fc([
    feat({ layer: "parcel", id: 1, egrid: "CH1", parcel_area_m2: 10 }, GEOM),
    feat({ layer: "landcover", id: 1, art: ART[0], area_m2: 4 }, GEOM),
    feat({ layer: "habitat", id: 1, art: "6.3 x" }, null), // a detail row without geometry (estimated habitat)
    feat({ layer: "habitat", id: 1, art: "6.3 x" }, null),
    feat({ layer: "roads", id: 9 }, GEOM),                 // a layer the dashboard does not know
    null, feat("not an object"), feat(null),               // not features with attributes
  ]));
  assert.equal(g.parcels.length, 1);
  assert.equal(g.overlays.landcover.features.length, 1);
  assert.equal(g.skippedGeom, 2, "overlay features without geometry");
  assert.equal(g.skippedLayer, 4, "unknown layer or no attributes (the two used to share one counter and one message)");
  const status = C.pickerStatus({ ...g, dropped: [] }, 1000, "Chrome/140");
  assert.match(status, /4 Features ohne bekannten Layer übersprungen/);
  assert.match(status, /2 Layer-Features ohne Geometrie/);
});

test("9 · readGeojson: a layer-less FeatureCollection must carry parcel columns", () => {
  assert.throws(() => C.readGeojson(fc([feat({ name: "Gemeinde A" }, GEOM), feat({ name: "Gemeinde B" }, GEOM)])), /kein Bodenbedeckungs-Export/);
  assert.throws(() => C.readGeojson(fc([null])), /kein Bodenbedeckungs-Export/, "was: 1 empty «Grundstück»");
  assert.throws(() => C.readGeojson(fc([feat("x")])), /kein Bodenbedeckungs-Export/, "was: TypeError «Cannot use 'in' operator»");
  assert.throws(() => C.readGeojson("[]"), /keine GeoJSON-FeatureCollection/);
  // A legacy parcels-only export (no `layer`) still loads; old vbs_* names are read as av_* (an explicit av_* wins).
  const g = C.readGeojson(fc([feat({ id: 1, egrid: "CH1", parcel_area_m2: 10, vbs_typ1_m2: 5, vbs_kat_a_m2: 3, av_typ1_m2: 7 }, GEOM), feat(null)]));
  assert.equal(g.parcels.length, 1);
  assert.equal(g.skippedLayer, 1, "a feature without attributes is not an empty parcel");
  assert.deepEqual(plain({ ...g.parcels[0], _geom: undefined }), { id: 1, egrid: "CH1", parcel_area_m2: 10, av_typ1_m2: 7, av_kat_a_m2: 3 });
  assert.equal(C.readGeojson(JSON.stringify(feat({ id: 1, egrid: "CH1" }, GEOM))).parcels.length, 1, "a single Feature is a one-element collection");
});

// ── Finding 10 ───────────────────────────────────────────────────────────────────────────────────────────
test("10 · «In Tabelle anzeigen» is an exact-id filter, the search box a substring search", () => {
  const rows = [{ id: "100/1" }, { id: "1100/10" }, { id: "7", egrid: "CH100/1x" }];
  assert.equal(rows.filter((p) => C.rowMatches(p, "100/1", null)).length, 3, "the substring search finds all three");
  assert.deepEqual(rows.filter((p) => C.rowMatches(p, "", "100/1")).map((p) => p.id), ["100/1"], "the id filter exactly one");
  assert.equal(rows.filter((p) => C.rowMatches(p, "", null)).length, 3);
  assert.equal(C.rowMatches({ id: 5 }, "", "5"), true, "numeric ids compare as strings");
});

// ── Finding 12 ───────────────────────────────────────────────────────────────────────────────────────────
test("12 · the allowlist names what it drops and matches input_ columns in their canonical spelling", () => {
  const row = { id: 1, egrid: "CH1", input_ort: "Bern", input_mietermod: "x", "input_straße": "y", owner_name: "z", errors: [], _geom: GEOM };
  const al = C.allowlist([row]);
  assert.deepEqual(Object.keys(al.cleaned[0]).sort(), ["_geom", "egrid", "errors", "id", "input_ort"]);
  assert.deepEqual(plain(al.dropped), ["input_mietermod", "input_straße", "owner_name"]);
  const status = C.pickerStatus({ parcels: al.cleaned, overlays: { landcover: { features: [] }, bauzonen: { features: [] }, habitat: { features: [] } }, skippedLayer: 0, skippedGeom: 0, dropped: al.dropped }, 1000, "");
  assert.match(status, /3 Spalten nicht übernommen \(Datenschutz\): input_mietermod, input_straße, owner_name/);
  // A header in another case, or with a decomposed «ü», is the same column — kept under the name the app reads.
  const nfd = "input_bez. grundstück", nfc = "input_bez. grundstück";
  const v = C.allowlist([{ id: 1, "input_Ort": "Bern", [nfd]: "PP Nord", "Input_L/R": "CH", "INPUT_NAME": "secret" }]);
  assert.deepEqual(plain(v.cleaned[0]), { id: 1, input_ort: "Bern", [nfc]: "PP Nord", "input_l/r": "CH" }, "was: all three dropped without a trace");
  assert.deepEqual(plain(v.dropped), ["INPUT_NAME"]);
  // Two spellings of one column: the canonical one wins, the other is reported.
  const two = C.allowlist([{ input_ort: "Bern", "input_Ort": "Thun" }]);
  assert.equal(two.cleaned[0].input_ort, "Bern");
  assert.deepEqual(plain(two.dropped), ["input_Ort"]);
});

// ── Finding 13 ───────────────────────────────────────────────────────────────────────────────────────────
test("13 · a non-string check_egrid does not stop the boot", () => {
  assert.equal(C.statusKey({ check_egrid: 404 }), "404");
  assert.equal(C.statusKey({ check_egrid: true }), "true");
  assert.equal(C.statusKey({ check_egrid: "error:timeout" }), "error");
  assert.equal(C.statusKey({}), "—");
  assert.equal(C.isFound({ check_egrid: "merged" }), true);
});

test("13 · projected coordinates are rejected with a message that names the problem", () => {
  const lv95 = { type: "Polygon", coordinates: [[[2600000, 1200000], [2600010, 1200000], [2600010, 1200010], [2600000, 1200000]]] };
  assert.throws(() => C.readGeojson(fc([feat({ layer: "parcel", id: 1, egrid: "CH1" }, lv95)])), /nicht in WGS84/);
  const multi = { type: "MultiPolygon", coordinates: [[[[2600000, 1200000], [2600010, 1200000], [2600010, 1200010], [2600000, 1200000]]]] };
  assert.throws(() => C.readGeojson(fc([feat({ layer: "parcel", id: 1, egrid: "CH1" }, multi)])), /nicht in WGS84/);
  assert.equal(C.readGeojson(fc([feat({ layer: "parcel", id: 1, egrid: "CH1" }, { type: "Polygon", coordinates: [] })])).parcels.length, 1, "an empty geometry is not a wrong one");
});

// ── Finding 2 (dashboard side) ───────────────────────────────────────────────────────────────────────────
test("2 · a file the browser cannot read as one string is refused by its size, with a clear message", () => {
  const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";
  const firefox = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0";
  assert.equal(C.STR_MAX, 536870888, "V8's maximum string length");
  assert.equal(C.fileTooBig(C.STR_MAX - 1, chrome), false);
  assert.equal(C.fileTooBig(C.STR_MAX, chrome), true);
  assert.equal(C.fileTooBig(C.STR_MAX, firefox), false, "Firefox reads about twice as much");
  assert.equal(C.fileTooBig(2 * C.STR_MAX, firefox), true);
  assert.match(C.tooBigMsg(600 * 1048576), /^Datei zu gross \(600 MB\)/);
  // Close to the limit the picker says so even though the file still loads.
  const g = { parcels: [{}], overlays: { landcover: { features: [] }, bauzonen: { features: [] }, habitat: { features: [] } }, skippedLayer: 0, skippedGeom: 0, dropped: [] };
  assert.match(C.pickerStatus(g, 0.85 * C.STR_MAX, chrome), /Hinweis: Die Datei belegt 85 % der Grösse/);
  assert.doesNotMatch(C.pickerStatus(g, 0.5 * C.STR_MAX, chrome), /Hinweis/);
});

// ── Schema detection (unchanged behaviour, now testable) ────────────────────────────────────────────────
test("schema: level-2 habitat columns are the leaves; Bauzonen sums include «Ohne Bauzone»", () => {
  const p = found({ check_bauzonen: "ok", check_habitat: "ok", bauzonen_m2: "x", bauzonen_wohnzonen_m2: 700, bauzonen_ohne_bauzone_m2: 300,
                    habitat_m2: "y", habitat_l1_6_m2: 1000, habitat_l2_6_3_m2: 600, habitat_l2_6_m2: 400 });
  const S = C.datasetSchema([p]);
  assert.deepEqual(plain(S.habitatList), ["6_3", "6"], "l1 columns would double count");
  assert.deepEqual(plain(S.bauzoneList), ["wohnzonen", "ohne_bauzone"]);
  const R = C.checkRules([p], S);
  assert.deepEqual([R.bzCover.pass, R.hbCover.pass, R.bbCover.pass, R.lcFetch.pass], [1, 1, 1, 1]);
});
