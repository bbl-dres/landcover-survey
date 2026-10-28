// Fetch robustness of geoapi.js against the two server behaviours that silently
// lose features (see processing-cli/tests/test_fetch_paging.py for the same scenarios
// against the Python client):
//  - identify returns ≤ 200 results in a request-dependent order → quadtree tiling
//  - WFS applies COUNT before the exact bbox test and overlaps pages → page until empty
import { test } from "node:test";
import assert from "node:assert/strict";
import { installBrowserStubs, installFakeFetch, boxPolygon, grid, overlaps, shuffle } from "./stubs.mjs";

installBrowserStubs();
const geoapi = await import("../js/geoapi.js");

const BBOX = [9.30, 47.40, 9.40, 47.48];
const parcel = boxPolygon(...BBOX);

function fakeIdentify(world, dropped = new Set()) {
  let calls = 0;
  return {
    calls: () => calls,
    handler: (u) => {
      const env = u.searchParams.get("geometry").split(",").map(Number);
      const limit = Number(u.searchParams.get("limit")), offset = Number(u.searchParams.get("offset"));
      const hits = shuffle(world.filter((f) => overlaps(f.bbox, env)), calls++);
      return { results: hits.slice(offset, offset + limit).map((f) => ({
        featureId: f.id, id: f.id, geometry: dropped.has(f.id) ? null : f.geometry, properties: { typoch_de: `6 Wald ${f.id}` },
      })) };
    },
  };
}

function fakeWFS(world, falseEvery = 10) {
  let calls = 0;
  const exact = world.filter((f) => f.id % falseEvery !== 0);
  return {
    calls: () => calls, exact,
    handler: (u) => {
      const count = Number(u.searchParams.get("COUNT")), start = Number(u.searchParams.get("STARTINDEX"));
      calls++;
      const lo = Math.max(0, start - (start ? 1 : 0));
      return { type: "FeatureCollection", features: world.slice(lo, lo + count).filter((f) => f.id % falseEvery !== 0)
        .map((f) => ({ type: "Feature", id: null, geometry: f.geometry, properties: { Art: "Gebaeude", BFSNr: 1 } })) };
    },
  };
}

test("identify: quadtree fetches every feature despite unstable order", async () => {
  const world = grid(30, 30, BBOX);
  const fake = fakeIdentify(world, new Set([5]));
  installFakeFetch(fake.handler);
  const r = await geoapi.fetchIdentify("layer", parcel, 5000);
  const ids = [...r.features.map((f) => String(f.id)), ...r.dropped.map((d) => String(d.id))].sort();
  assert.deepEqual(ids, world.map((f) => String(f.id)).sort());
  assert.deepEqual(r.dropped.map((d) => d.id), [5]);
  assert.equal(r.total, 900); assert.equal(r.truncated, false);
  assert.ok(fake.calls() > 4);
  assert.deepEqual(r.features.map((f) => f.key), [...r.features.map((f) => f.key)].sort());
});

test("identify: a single short page needs one request", async () => {
  const fake = fakeIdentify(grid(3, 3, BBOX));
  installFakeFetch(fake.handler);
  const r = await geoapi.fetchIdentify("layer", parcel, 5000);
  assert.equal(fake.calls(), 1); assert.equal(r.total, 9); assert.equal(r.truncated, false);
});

test("identify: depth cap flags truncation for inseparable stacks", async () => {
  const b = [9.35, 47.44, 9.351, 47.441];
  const stacked = Array.from({ length: 250 }, (_, i) => ({ id: i + 1, bbox: b, geometry: boxPolygon(...b) }));
  installFakeFetch(fakeIdentify(stacked).handler);
  const r = await geoapi.fetchIdentify("layer", parcel, 5000);
  assert.equal(r.truncated, true); assert.ok(r.total >= geoapi.IDENTIFY_PAGE);
});

test("identify: maxFeatures cap flags truncation", async () => {
  installFakeFetch(fakeIdentify(grid(30, 30, BBOX)).handler);
  const r = await geoapi.fetchIdentify("layer", parcel, 300);
  assert.equal(r.truncated, true); assert.ok(r.total >= 300);
});

test("WFS: pages until an empty page and deduplicates", async () => {
  const fake = fakeWFS(grid(50, 50, BBOX));
  installFakeFetch(fake.handler);
  const r = await geoapi.fetchLandCover(BBOX);
  assert.equal(r.error, false); assert.equal(r.truncated, false);
  const keys = r.features.map((f) => JSON.stringify([f.geometry, f.properties]));
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(keys.length, fake.exact.length);
  assert.equal(fake.calls(), 4);
});

test("WFS: a short page is not the end", async () => {
  const fake = fakeWFS(grid(40, 40, BBOX));
  installFakeFetch(fake.handler);
  const r = await geoapi.fetchLandCover(BBOX);
  assert.equal(r.features.length, 1440); assert.equal(fake.calls(), 3);
});

test("WFS: a failed request after retries is reported, not thrown", async () => {
  globalThis.fetch = async () => ({ ok: false, status: 503, headers: { get: () => "0" } });
  const r = await geoapi.fetchLandCover(BBOX);
  assert.deepEqual(r, { features: [], error: true, truncated: false });
});
