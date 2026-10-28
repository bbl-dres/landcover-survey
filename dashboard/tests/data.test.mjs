// dashboard/js/data.js is generated from the shared references (data/*.json, the web app's
// config.js). These tests fail when it is stale or when a reference breaks its own contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildDashboardData, OUT_PATH } from "../../scripts/build_dashboard_data.mjs";

const fresh = await buildDashboardData();
const norm = (s) => s.replace(/\r\n/g, "\n");

test("dashboard/js/data.js is current (else: npm run build:dashboard-data)", () => {
  assert.equal(norm(readFileSync(OUT_PATH, "utf8")), norm(fresh));
});

test("generated tables: shape and integrity", () => {
  const win = {};
  new Function("window", fresh)(win);
  const d = win.DASHBOARD_DATA;
  const hex = /^#[0-9a-f]{6}$/i;

  assert.equal(Object.keys(d.landcover.types).length, 26, "26 canonical BBArt types");
  assert.deepEqual(d.landcover.mainOrder, Object.keys(d.landcover.main));
  assert.equal(d.landcover.mainOrder.length, 6, "6 AV main groups");
  for (const [key, t] of Object.entries(d.landcover.types)) {
    assert.ok(d.landcover.main[t.main], `${key}: main group ${t.main} exists`);
    assert.ok(t.label, `${key}: label`);
  }
  for (const g of Object.values(d.landcover.main)) assert.match(g.color, hex);

  assert.deepEqual(Object.keys(d.typoch.l1Colors), ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  for (const c of Object.values(d.typoch.l1Colors)) assert.match(c, hex);
  assert.ok(Object.keys(d.typoch.names).length >= 320, "TypoCH names");
  assert.equal(d.typoch.names["1"], "Gewässer");
  assert.equal(d.typoch.names["6.3"], "Andere Laubwälder");
  assert.equal(d.typoch.names["4.2.1.1"], "Inneralpine Felsensteppe");
  assert.equal(d.typoch.names["4.2.1.1.2"], "Inneralpine Felsensteppe der Ostalpen");
  for (const code of Object.keys(d.typoch.names)) assert.match(code, /^[1-9](\.\d+)*$/, `TypoCH code ${code}`);

  assert.equal(Object.keys(d.bauzonen).length, 10, "9 ARE zones + Ohne Bauzone");
  assert.equal(d.bauzonen.wohnzonen.label, "Wohnzonen");
  assert.equal(d.bauzonen.ohne_bauzone.label, "Ohne Bauzone");
  for (const b of Object.values(d.bauzonen)) assert.match(b.color, hex);

  assert.ok(Object.keys(d.countries).length >= 240, "countries");
  assert.equal(d.countries.CH, "Schweiz");
});
