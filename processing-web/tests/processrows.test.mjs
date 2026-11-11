// processRows against fake services: what a failed query leaves behind, the retry
// rounds, and how often a parcel is reported. The same scenarios run against the
// Python port in processing-cli/tests/test_robustness.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installBrowserStubs, bbox, boxPolygon } from "./stubs.mjs";

// A turf that is exact for the axis-aligned boxes used here (the real one is a
// browser global). Areas are in arbitrary units; only "> 0" and equality matter.
const feature = (geometry) => ({ type: "Feature", geometry, properties: {} });
globalThis.turf = {
  bbox,
  feature,
  featureCollection: (features) => ({ type: "FeatureCollection", features }),
  area: (f) => { const [a, b, c, d] = bbox(f.geometry || f); return (c - a) * (d - b) * 1e10; },
  intersect: (fc) => {
    const [A, B] = fc.features.map((f) => bbox(f.geometry));
    const x0 = Math.max(A[0], B[0]), y0 = Math.max(A[1], B[1]), x1 = Math.min(A[2], B[2]), y1 = Math.min(A[3], B[3]);
    return x0 < x1 && y0 < y1 ? feature(boxPolygon(x0, y0, x1, y1)) : null;
  },
  union: (fc) => fc.features[0],
  difference: () => null,
};
installBrowserStubs();
const geoapi = await import("../js/geoapi.js");
const proc = await import("../js/processor.js");
proc.setRetryPauseMs(0);

const GEOM = { CH000000000001: boxPolygon(7.4, 46.9, 7.401, 46.901), CH000000000002: boxPolygon(7.5, 46.9, 7.501, 46.901) };
const FAIL = { fail: true }; // answered with HTTP 400: not retried by fetchWithRetry, so the tests stay fast
const egridAt = (lon) => Object.keys(GEOM).find((e) => Math.abs(bbox(GEOM[e])[0] - lon) < 1e-9);

/** Fake services keyed by parcel: `landcover[egrid]` / `bauzonen[egrid]` / `bafu[egrid]`
 *  are feature lists, FAIL, or a function returning one of the two (called per request). */
function install({ landcover = {}, bauzonen = {}, bafu = {} }) {
  geoapi.clearParcelCache();
  const give = (v) => (typeof v === "function" ? v() : v);
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    let data;
    if (u.pathname.endsWith("/find")) {
      const g = GEOM[u.searchParams.get("searchText")];
      data = { results: g ? [{ geometry: g, properties: { number: "1" } }] : [] };
    } else if (u.searchParams.has("TYPENAMES")) {
      const [minLat, minLon] = u.searchParams.get("BBOX").split(",").map(Number);
      const v = give(landcover[egridAt(minLon)]);
      // Like the server: the page after the last one is empty.
      data = v === FAIL ? FAIL : { features: u.searchParams.get("STARTINDEX") === "0" ? v : [] };
      void minLat;
    } else {
      const lon = Number(u.searchParams.get("geometry").split(",")[0]);
      const table = u.searchParams.get("layers").includes("bauzonen") ? bauzonen : bafu;
      const v = give(table[egridAt(lon)]);
      data = v === FAIL ? FAIL : { results: v || [] };
    }
    if (data === FAIL) return { ok: false, status: 400, headers: { get: () => null }, json: async () => ({}) };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => data };
  };
}

const lc = (egrid, art = "Gebaeude") => [{ type: "Feature", geometry: GEOM[egrid], properties: { Art: art, BFSNr: 351 } }];
const zone = (egrid, name) => [{ featureId: 3, geometry: GEOM[egrid], properties: { ch_bez_d: name, ch_code_hn: "11" } }];
const ROWS = [{ id: "A", egrid: "CH000000000001" }, { id: "B", egrid: "CH000000000002" },
  { id: "C", egrid: "CH000000000009" }, { id: "D", egrid: "" }];
const run = (rows, options, onProgress = () => {}) => proc.processRows(rows, onProgress, options);

test("a failed land-cover request leaves the areas empty and is not replaced by BAFU", async () => {
  const habitat = (egrid) => [{ featureId: 7, geometry: GEOM[egrid], properties: { typoch_de: "6.3.1 Buchenwald" } }];
  install({ landcover: { CH000000000001: FAIL, CH000000000002: lc("CH000000000002") },
    bafu: { CH000000000001: habitat("CH000000000001"), CH000000000002: habitat("CH000000000002") } });
  const res = await run(ROWS.slice(0, 2), { bauzonen: false, habitat: false, synthLandcover: true });
  const [a, b] = res.parcels;
  assert.equal(a.check_wfs, "wfs_error"); assert.deepEqual(a.errors, ["Land cover unavailable (WFS)"]);
  assert.equal(a.lc_synthetic, ""); assert.equal(a.lc_source, ""); // unknown ≠ absent: no BAFU substitute
  assert.deepEqual(proc.LANDCOVER_AGG_KEYS.map((k) => a[k]), proc.LANDCOVER_AGG_KEYS.map(() => ""));
  assert.ok(a.parcel_area_m2 > 0); // the parcel itself was found
  assert.equal(b.check_wfs, "ok"); assert.ok(b.sia416_ggf_m2 > 0); assert.equal(b.greenspace_m2, 0); // asked: really 0
  assert.deepEqual(res.landcover.map((r) => r.id), ["B"]);
});

test("overlay columns are empty where the overlay did not answer", async () => {
  install({ landcover: { CH000000000001: lc("CH000000000001"), CH000000000002: lc("CH000000000002") },
    bauzonen: { CH000000000001: zone("CH000000000001", "Wohnzonen"), CH000000000002: FAIL } });
  let [a, b, c, d] = (await run(ROWS, { bauzonen: true, habitat: false, synthLandcover: false })).parcels;
  assert.equal(a.check_bauzonen, "ok"); assert.ok(a.bauzonen_wohnzonen_m2 > 0);
  assert.equal(b.check_bauzonen, "error"); assert.equal(b.bauzonen_wohnzonen_m2, ""); // the request failed: unknown
  assert.equal(c.check_egrid, "not_found"); assert.equal(c.bauzonen_wohnzonen_m2, ""); // no parcel: nothing asked
  assert.equal(d.check_egrid, "invalid"); assert.equal(d.bauzonen_wohnzonen_m2, "");

  install({ landcover: { CH000000000001: lc("CH000000000001"), CH000000000002: lc("CH000000000002") },
    bauzonen: { CH000000000001: zone("CH000000000001", "Wohnzonen"), CH000000000002: zone("CH000000000002", "Arbeitszonen") } });
  [a, b] = (await run(ROWS.slice(0, 2), { bauzonen: true, habitat: false, synthLandcover: false })).parcels;
  assert.equal(a.bauzonen_arbeitszonen_m2, 0); assert.equal(b.bauzonen_wohnzonen_m2, 0); // asked, not in that zone
});

test("a failed query is asked again, and each parcel is reported once with its final result", async () => {
  let calls = 0;
  install({ landcover: { CH000000000001: () => (calls++ === 0 ? FAIL : lc("CH000000000001")) } });
  const seen = [];
  const res = await run([ROWS[0], ROWS[2], ROWS[3]], { bauzonen: false, habitat: false, synthLandcover: false },
    (p) => { if (p.parcel) seen.push([p.processed, p.parcel.id, p.parcel.check_wfs]); });
  assert.deepEqual(seen.map((s) => s[1]).sort(), ["A", "C", "D"]); // once each
  assert.deepEqual(seen.map((s) => s[0]), [1, 2, 3]);
  assert.ok(seen.some((s) => s[1] === "A" && s[2] === "ok")); // the retried result, not the failed one
  assert.equal(res.parcels[0].check_wfs, "ok"); assert.ok(res.parcels[0].sia416_ggf_m2 > 0);
});

test("a query that keeps failing stays flagged after the retry rounds", async () => {
  let calls = 0;
  install({ landcover: { CH000000000001: () => { calls++; return FAIL; } } });
  const res = await run(ROWS.slice(0, 1), { bauzonen: false, habitat: false, synthLandcover: false });
  assert.equal(res.parcels[0].check_wfs, "wfs_error"); assert.ok(proc.needsRetry({ parcel: res.parcels[0] }));
  assert.equal(calls, 1 + proc.RETRY_ROUNDS); // first pass + the retry rounds
});
