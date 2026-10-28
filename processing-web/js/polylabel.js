/**
 * Pole of inaccessibility — the interior point of a polygon farthest from its
 * edges (the polygon's "visual center"). This is the same algorithm MapLibre
 * GL JS uses to anchor polygon labels, so deriving the parcel marker from it
 * keeps the dot under the label even on irregular/concave parcels (where a
 * vertex-average centroid drifts toward dense parts of the boundary).
 *
 * Ported from @mapbox/polylabel (ISC License, © Mapbox). Works directly in
 * lng/lat space; precision is derived from the polygon's bounding box so it is
 * unit-independent.
 */

/** Max-heap keyed on cell.max (largest potential distance first). */
class MaxHeap {
  constructor() { this._d = []; }
  get length() { return this._d.length; }
  push(item) {
    const d = this._d;
    d.push(item);
    let pos = d.length - 1;
    while (pos > 0) {
      const parent = (pos - 1) >> 1;
      if (d[parent].max >= d[pos].max) break;
      [d[parent], d[pos]] = [d[pos], d[parent]];
      pos = parent;
    }
  }
  pop() {
    const d = this._d;
    const top = d[0];
    const last = d.pop();
    if (d.length) {
      d[0] = last;
      let pos = 0;
      const n = d.length;
      for (;;) {
        let largest = pos;
        const l = 2 * pos + 1, r = 2 * pos + 2;
        if (l < n && d[l].max > d[largest].max) largest = l;
        if (r < n && d[r].max > d[largest].max) largest = r;
        if (largest === pos) break;
        [d[largest], d[pos]] = [d[pos], d[largest]];
        pos = largest;
      }
    }
    return top;
  }
}

class Cell {
  constructor(x, y, h, polygon) {
    this.x = x;            // cell center x
    this.y = y;            // cell center y
    this.h = h;            // half the cell size
    this.d = pointToPolygonDist(x, y, polygon);  // signed distance from cell center to polygon
    this.max = this.d + this.h * Math.SQRT2;     // max distance to polygon within the cell
  }
}

/** Signed distance from a point to a polygon (negative if outside). */
function pointToPolygonDist(x, y, polygon) {
  let inside = false;
  let minDistSq = Infinity;
  for (const ring of polygon) {
    for (let i = 0, len = ring.length, j = len - 1; i < len; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if ((a[1] > y) !== (b[1] > y) &&
          x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) {
        inside = !inside;
      }
      minDistSq = Math.min(minDistSq, getSegDistSq(x, y, a, b));
    }
  }
  return (inside ? 1 : -1) * Math.sqrt(minDistSq);
}

/** Squared distance from a point to a segment [a, b]. */
function getSegDistSq(px, py, a, b) {
  let x = a[0];
  let y = a[1];
  let dx = b[0] - x;
  let dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = b[0]; y = b[1]; }
    else if (t > 0) { x += dx * t; y += dy * t; }
  }
  dx = px - x;
  dy = py - y;
  return dx * dx + dy * dy;
}

/** Area-weighted centroid of the outer ring, as a seed Cell. */
function getCentroidCell(polygon) {
  let area = 0;
  let x = 0;
  let y = 0;
  const ring = polygon[0];
  for (let i = 0, len = ring.length, j = len - 1; i < len; j = i++) {
    const a = ring[i];
    const b = ring[j];
    const f = a[0] * b[1] - b[0] * a[1];
    x += (a[0] + b[0]) * f;
    y += (a[1] + b[1]) * f;
    area += f * 3;
  }
  if (area === 0) return new Cell(ring[0][0], ring[0][1], 0, polygon);
  return new Cell(x / area, y / area, 0, polygon);
}

/**
 * Returns the pole of inaccessibility of a GeoJSON Polygon coordinate array
 * (`[outerRing, ...holes]`) as `[lng, lat]`.
 */
export function poleOfInaccessibility(polygon, precision) {
  const ring = polygon && polygon[0];
  if (!ring || ring.length === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  const width = maxX - minX;
  const height = maxY - minY;
  const cellSize = Math.min(width, height);
  if (cellSize === 0) return [minX, minY];

  // Derive precision from the polygon size so this works in degrees.
  const p = precision || Math.max(width, height) / 1000;

  let h = cellSize / 2;
  const queue = new MaxHeap();

  // Seed the grid with square cells covering the bounding box.
  for (let x = minX; x < maxX; x += cellSize) {
    for (let y = minY; y < maxY; y += cellSize) {
      queue.push(new Cell(x + h, y + h, h, polygon));
    }
  }

  let best = getCentroidCell(polygon);
  const bboxCell = new Cell(minX + width / 2, minY + height / 2, 0, polygon);
  if (bboxCell.d > best.d) best = bboxCell;

  while (queue.length) {
    const cell = queue.pop();
    if (cell.d > best.d) best = cell;
    // Stop splitting cells that cannot beat the current best by > precision.
    if (cell.max - best.d <= p) continue;
    h = cell.h / 2;
    queue.push(new Cell(cell.x - h, cell.y - h, h, polygon));
    queue.push(new Cell(cell.x + h, cell.y - h, h, polygon));
    queue.push(new Cell(cell.x - h, cell.y + h, h, polygon));
    queue.push(new Cell(cell.x + h, cell.y + h, h, polygon));
  }

  return [best.x, best.y];
}
