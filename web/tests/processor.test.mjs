// Pure parts of processor.js: rounding, row shapes, aggregation, bfsnr derivation.
// (Cross-implementation parity of the same functions is asserted by
// python/tests/test_parity_js.py, which evaluates them through tests/js_dump.mjs.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { installBrowserStubs, installFakeFetch } from "./stubs.mjs";

installBrowserStubs();
installFakeFetch(() => { throw new Error("no network in unit tests"); });
const cfg = await import("../js/config.js");
const proc = await import("../js/processor.js");
await cfg.ensureTypoch(); // reads data/typoch.json from disk via the file: fetch stub

test("round2 rounds half up at the second decimal", () => {
  assert.equal(proc.round2(1.005), 1); // binary 1.005 is just below 1.005
  assert.equal(proc.round2(2.675), 2.68); // 2.675 * 100 is exactly 267.5 in binary
  assert.equal(proc.round2(0.125), 0.13);
  assert.equal(proc.round2(0), 0);
});

test("land-cover rows: AV and synthetic share one shape, synthetic keeps its typoch", () => {
  const av = proc.makeLandcoverRow("P", "CH1", "Gebaeude", { fid: "7", bfsnr: 3203, gwrEgid: "1" }, 10.004, null);
  assert.deepEqual(Object.keys(av).slice(0, 7), ["id", "egrid", "fid", "art", "bfsnr", "gwr_egid", "check_greenspace"]);
  assert.equal(av.lc_source, "AV"); assert.equal(av.area_m2, 10); assert.equal(av._rawArea, 10.004);
  assert.equal(av.vbs_kategorie, "A. Settlement area"); assert.equal(av.vbs_typ, "");
  const synth = proc.makeLandcoverRow("P", "CH1", "Acker_Wiese_Weide", { lcSource: "BAFU", typoch: "4.5 Fettwiesen" }, 5, null);
  assert.deepEqual(Object.keys(synth).slice(0, 6), ["id", "egrid", "fid", "art", "typoch", "bfsnr"]);
  assert.equal(synth.lc_source, "BAFU"); assert.equal(synth.vbs_typ, "Type 2 - Other green spaces");
});

test("aggregateLandCover sums unrounded areas and rounds once", () => {
  const rows = [
    proc.makeLandcoverRow("P", "CH1", "Gebaeude", {}, 0.004, null),
    proc.makeLandcoverRow("P", "CH1", "Gebaeude", {}, 0.004, null),
    proc.makeLandcoverRow("P", "CH1", "Gartenanlage", {}, 100.001, null),
  ];
  const agg = proc.aggregateLandCover(rows);
  assert.equal(agg.sia416_ggf_m2, 0.01); // 0.008 → rounds up only when summed first
  assert.equal(agg.av_gebaeude_m2, 0.01);
  assert.equal(agg.sealed_m2, 0.01);
  assert.equal(agg.greenspace_m2, 100);
  assert.equal(agg.vbs_typ1_m2, 100); assert.equal(agg.vbs_typ2_m2, 0);
  assert.equal(agg.vbs_kat_b_m2, 100); assert.equal(agg.vbs_kat_a_m2, 0.01);
});

test("dominantBfsnr picks the largest share, ties to the smaller value, keeps the type", () => {
  const r = (bfsnr, area) => ({ bfsnr, _rawArea: area });
  assert.equal(proc.dominantBfsnr([r(3203, 10), r(351, 20), r(3203, 15)]), 3203);
  assert.equal(proc.dominantBfsnr([r("351", 5), r("3203", 5)]), "3203"); // "3203" < "351" lexicographically
  assert.equal(proc.dominantBfsnr([r("", 5), r(null, 5), r(undefined, 1)]), "");
  assert.equal(proc.dominantBfsnr([]), "");
});

test("aggregateHabitat groups by TypoCH code at level 1 and 2 with level-2 labels", () => {
  const rows = [
    proc.makeHabitatRow("P", "CH1", "6.3.1 Ahorn-Schluchtwald", "", "1", 100, null),
    proc.makeHabitatRow("P", "CH1", "6.3.2 Buchenwald", "", "2", 50, null),
    proc.makeHabitatRow("P", "CH1", "9221 Gründach", "", "3", 1, null),
  ];
  const agg = proc.aggregateHabitat(rows);
  assert.deepEqual(agg.typesL1, { "6": 150, "9221": 1 });
  assert.deepEqual(agg.typesL2, { "6.3": 150, "9221": 1 });
  assert.equal(agg.habitat, "6.3 Andere Laubwälder; 9221 Gründach");
  assert.equal(agg.habitat_m2, "150.0; 1.0");
});

test("aggregateBauzonen lists zones largest first", () => {
  const rows = [
    proc.makeBauzoneRow("P", "CH1", "Wohnzonen", "11", "1", 10.04, null),
    proc.makeBauzoneRow("P", "CH1", "Ohne Bauzone", "", "", 25.5, null),
    proc.makeBauzoneRow("P", "CH1", "Wohnzonen", "11", "2", 0.01, null),
  ];
  const agg = proc.aggregateBauzonen(rows);
  assert.equal(agg.bauzonen, "Ohne Bauzone; Wohnzonen");
  assert.equal(agg.bauzonen_m2, "25.5; 10.0"); // toFixed(1) of the raw sum 10.049999…
  assert.deepEqual(agg.zones, { "Ohne Bauzone": 25.5, Wohnzonen: 10.05 });
});
