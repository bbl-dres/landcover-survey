// AV Produktivität and AV Typ follow BAFU's definition of 9 Nov 2026:
//
//   Grünflächen: nach amtlicher Vermessung alle Kategorien ausser 0–7 und 24.
//   Typ 1: Gartenanlagen 11.   Typ 2: 8–23 (ohne 11), plus 25.
//
// The codes are the positions in BAFU's table (= the BBArt enumeration order of
// DM.01-AV-CH). The same lists are asserted for the CLI in
// processing-cli/tests/test_classification.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installBrowserStubs, installFakeFetch } from "./stubs.mjs";

installBrowserStubs();
installFakeFetch(() => { throw new Error("no network in unit tests"); });
const cfg = await import("../js/config.js");
const proc = await import("../js/processor.js");
await cfg.ensureTypoch();

const BAFU_CODES = [
  "Gebaeude", "Strasse_Weg", "Trottoir", "Verkehrsinsel", "Bahn", "Flugplatz", "Wasserbecken",
  "uebrige_befestigte", "Acker_Wiese_Weide", "Reben", "uebrige_Intensivkultur", "Gartenanlage",
  "Hoch_Flachmoor", "uebrige_humusierte", "Gewaesser_stehendes", "Gewaesser_fliessendes",
  "Schilfguertel", "geschlossener_Wald", "Wytweide_dicht", "Wytweide_offen", "uebrige_bestockte",
  "Fels", "Gletscher_Firn", "Geroell_Sand", "Abbau_Deponie", "uebrige_vegetationslose",
];
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const NOT_GREEN = [...range(0, 7), 24];
const TYP1 = [11];
const TYP2 = [...range(8, 23).filter((c) => c !== 11), 25];
const codes = (predicate) => BAFU_CODES.map((art, code) => (predicate(art) ? code : -1)).filter((c) => c >= 0);

test("the code table is the BBArt domain", () => {
  assert.equal(BAFU_CODES.length, 26);
  assert.deepEqual([...BAFU_CODES].sort(), Object.keys(cfg.SIA416).sort());
});

test("Typ follows the BAFU definition", () => {
  assert.deepEqual(codes((a) => cfg.VBS_TYP[a] === "typ1"), TYP1);
  assert.deepEqual(codes((a) => cfg.VBS_TYP[a] === "typ2"), TYP2);
  assert.deepEqual(codes((a) => !(a in cfg.VBS_TYP)), NOT_GREEN);
});

test("the green area is everything but codes 0–7 and 24", () => {
  assert.deepEqual(codes((a) => cfg.VBS_PRODUKTIV[a] === "unproduktiv"), NOT_GREEN);
  assert.deepEqual(codes((a) => cfg.VBS_PRODUKTIV[a] === "produktiv"), [...TYP1, ...TYP2].sort((x, y) => x - y));
  assert.deepEqual(codes((a) => cfg.VBS_KATEGORIE[a] === "kat_a"), NOT_GREEN); // … exactly "outside Kategorie A"
});

test("rock, glacier and scree are Typ 2 (unproductive, without Typ, until 2026-11-10)", () => {
  for (const art of ["Fels", "Gletscher_Firn", "Geroell_Sand"]) {
    const cls = cfg.classify(art);
    assert.deepEqual([cls.vbsProduktiv, cls.vbsTyp, cls.vbsKategorie], ["produktiv", "typ2", "kat_d"]);
  }
  const hab = cfg.classifyBafu("3.4 Felsen"); // the habitat class these correspond to
  assert.deepEqual([hab.vbsProduktiv, hab.vbsTyp], ["produktiv", "typ2"]);
});

test("Typ 1 + Typ 2 is the productive area", () => {
  const rows = BAFU_CODES.map((art) => proc.makeLandcoverRow("P", "CH1", art, {}, 10, null));
  const agg = proc.aggregateLandCover(rows);
  assert.equal(agg.av_typ1_m2 + agg.av_typ2_m2, agg.av_produktiv_m2);
  assert.equal(agg.av_produktiv_m2, 10 * (TYP1.length + TYP2.length));
  assert.equal(agg.av_unproduktiv_m2, 10 * NOT_GREEN.length);
  assert.equal(agg.av_typ1_m2, 10);
});
