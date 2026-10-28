// Test helpers: the browser globals the app modules touch at import time, a
// minimal `turf` (only what geoapi.js needs: bbox), and a fake fetch().
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export function installBrowserStubs() {
  globalThis.window = { location: { search: "" } };
  globalThis.document = { documentElement: {}, title: "", querySelectorAll: () => [], getElementById: () => null,
    createElement: () => ({ textContent: "", get innerHTML() { return this.textContent; } }) };
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  globalThis.turf = globalThis.turf || { bbox };
}

/** [minLon, minLat, maxLon, maxLat] of a GeoJSON geometry (turf.bbox equivalent). */
export function bbox(geom) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (c) => {
    if (typeof c[0] === "number") {
      if (c[0] < b[0]) b[0] = c[0]; if (c[1] < b[1]) b[1] = c[1];
      if (c[0] > b[2]) b[2] = c[0]; if (c[1] > b[3]) b[3] = c[1];
    } else for (const x of c) walk(x);
  };
  walk(geom.coordinates);
  return b;
}

/** Route every fetch() through `handler(url: URL) → JSON`; file: URLs read from disk. */
export function installFakeFetch(handler) {
  globalThis.fetch = async (url) => {
    const u = url instanceof URL ? url : new URL(String(url));
    if (u.protocol === "file:") {
      const txt = await readFile(fileURLToPath(u), "utf8");
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => JSON.parse(txt) };
    }
    const data = handler(u);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => data };
  };
}

/** GeoJSON box polygon. */
export function boxPolygon(minx, miny, maxx, maxy) {
  return { type: "Polygon", coordinates: [[[minx, miny], [maxx, miny], [maxx, maxy], [minx, maxy], [minx, miny]]] };
}

/** n×m squares tiling bbox; id = row*n + col + first. */
export function grid(nCols, nRows, [minx, miny, maxx, maxy], first = 1) {
  const w = (maxx - minx) / nCols, h = (maxy - miny) / nRows, feats = [];
  for (let r = 0; r < nRows; r++) for (let c = 0; c < nCols; c++) {
    const id = first + r * nCols + c;
    const b = [minx + c * w, miny + r * h, minx + (c + 1) * w, miny + (r + 1) * h];
    feats.push({ id, bbox: b, geometry: boxPolygon(...b) });
  }
  return feats;
}

export const overlaps = (b, e) => b[0] <= e[2] && b[2] >= e[0] && b[1] <= e[3] && b[3] >= e[1];

/** Deterministic per-call shuffle (mulberry32). */
export function shuffle(arr, seed) {
  let a = seed >>> 0;
  const rnd = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}
