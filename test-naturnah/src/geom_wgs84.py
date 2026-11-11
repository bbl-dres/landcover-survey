"""Geometry primitives in EPSG:4326 that mirror Turf.js.

The web app works in lon/lat (EPSG:4326) throughout and computes areas with
``turf.area`` — a **spherical** approximation (Earth radius 6'378'137 m), not a
planar area. To make the Python API path reproduce the web app's numbers
bit-for-bit, this module:

- ports ``turf.area`` exactly (:func:`area`) — every area the API path reports,
  including the sliver test, MUST go through this, never shapely's ``.area``
  (which on lon/lat input would return degrees²);
- runs clip / union / difference in lon/lat via shapely (:func:`intersect`,
  :func:`union`, :func:`difference`) — GEOS computes the same planar polygon
  overlap that Turf's clipper does on the raw coordinates.

Inputs and outputs are shapely geometries; :func:`from_geojson` builds one from a
GeoJSON geometry dict. Nothing here reprojects — the API path stays in 4326.
"""

from __future__ import annotations

import math

import shapely

import fdlibm
from shapely.geometry import MultiPolygon, Polygon, shape
from shapely.geometry.base import BaseGeometry

# Must match Turf's earth radius exactly. Turf 7's @turf/area uses
# @turf/helpers `earthRadius = 6371008.8` (mean radius) — NOT the WGS84 equatorial
# 6378137 that older Turf used. Getting this wrong biases every area by ~0.22%.
_RADIUS = 6371008.8
# Turf 7 precomputes both constants and multiplies by them — the *order* of the
# floating-point operations is part of the port (a mathematically equal
# `x * pi / 180` rounds differently at the 1e-12 level, enough to flip a 2-dp area).
_FACTOR = _RADIUS * _RADIUS / 2
_PI_OVER_180 = math.pi / 180


def from_geojson(geom_dict: dict) -> BaseGeometry:
    """Build a shapely geometry from a GeoJSON geometry dict (lon/lat)."""
    return shape(geom_dict)


# ---------------------------------------------------------------------------
# turf.area — spherical polygon area (port of @turf/area)
# ---------------------------------------------------------------------------

def _ring_area(ring: list) -> float:
    """Signed spherical area of one ring — statement-for-statement port of
    ``ringArea`` in @turf/area 7.x (7.2.0 … 7.4.0 are identical):

    - ``coordsLength = coords.length - 1`` (the closing vertex is skipped),
    - ``middle`` / ``upper`` wrap modulo ``coordsLength``,
    - degrees → radians by multiplying with the precomputed ``PI_OVER_180``,
    - ``sin`` is the JavaScript engine's own (:mod:`fdlibm`), not the platform libm —
      the two differ by an ulp on ~3 % of inputs, enough to move a summed area by
      ~1e-6 m² and flip the last exported decimal now and then,
    - the sum is scaled by the precomputed ``FACTOR = R² / 2``.

    ``ring`` is a list of ``[lon, lat]`` positions (a closed GeoJSON ring, i.e.
    first == last). Winding order determines the sign; callers take ``abs()``.
    """
    n = len(ring) - 1
    if n <= 2:
        return 0.0
    total = 0.0
    i = 0
    while i < n:
        lower = ring[i]
        middle = ring[0 if i + 1 == n else i + 1]
        upper = ring[(i + 2) % n if i + 2 >= n else i + 2]
        lower_x = lower[0] * _PI_OVER_180
        middle_y = middle[1] * _PI_OVER_180
        upper_x = upper[0] * _PI_OVER_180
        total += (upper_x - lower_x) * fdlibm.sin(middle_y)  # V8's Math.sin, not the platform libm
        i += 1
    return total * _FACTOR


def _polygon_area_coords(rings: list) -> float:
    """Spherical area of a polygon given GeoJSON coords — turf's ``polygonArea``.

    ``rings[0]`` is the exterior; ``rings[1:]`` are holes. Result = |exterior|
    minus the sum of |hole| areas.
    """
    if not rings:
        return 0.0
    total = abs(_ring_area(rings[0]))
    for hole in rings[1:]:
        total -= abs(_ring_area(hole))
    return total


def _polygon_area(poly: Polygon) -> float:
    rings = [list(poly.exterior.coords)]
    rings.extend(list(interior.coords) for interior in poly.interiors)
    return _polygon_area_coords(rings)


def area(geom: BaseGeometry | None) -> float:
    """Spherical area in m², matching ``turf.area``.

    Polygon / MultiPolygon are summed; any non-polygonal parts (as can appear in a
    GeometryCollection) contribute their polygonal members only. Empty / None → 0.
    """
    if geom is None or geom.is_empty:
        return 0.0
    if isinstance(geom, Polygon):
        return _polygon_area(geom)
    if isinstance(geom, MultiPolygon):
        return sum(_polygon_area(p) for p in geom.geoms)
    # GeometryCollection or other container — sum polygonal parts (defensive; the
    # web only ever passes turf.intersect output, which is polygonal or null).
    if hasattr(geom, "geoms"):
        return sum(area(g) for g in geom.geoms if isinstance(g, (Polygon, MultiPolygon)))
    return 0.0


# ---------------------------------------------------------------------------
# turf.bbox / clip / union / difference
# ---------------------------------------------------------------------------

def bbox(geom: BaseGeometry) -> list:
    """``[minLon, minLat, maxLon, maxLat]`` — matches turf.bbox order."""
    minx, miny, maxx, maxy = geom.bounds
    return [minx, miny, maxx, maxy]


def polygons_only(geom: BaseGeometry | None) -> BaseGeometry | None:
    """Keep only Polygon/MultiPolygon parts; return ``None`` if there are none.

    Mirrors ``turf.intersect`` returning polygonal geometry or ``null``: a shared
    boundary produces a LineString/Point in shapely but carries no area, so it is
    dropped (the web app skips such intersections).
    """
    if geom is None or geom.is_empty:
        return None
    if isinstance(geom, (Polygon, MultiPolygon)):
        return geom
    polys = [g for g in getattr(geom, "geoms", []) if isinstance(g, (Polygon, MultiPolygon))]
    if not polys:
        return None
    if len(polys) == 1:
        return polys[0]
    flat: list[Polygon] = []
    for p in polys:
        flat.extend(p.geoms if isinstance(p, MultiPolygon) else [p])
    return MultiPolygon(flat)


def intersect(a: BaseGeometry, b: BaseGeometry) -> BaseGeometry | None:
    """Polygonal intersection of *a* and *b*, or ``None`` — mirrors ``turf.intersect``.

    Both inputs are repaired with ``make_valid(method="structure")`` first. Turf's
    polygon clipper resolves self-intersections internally, so to match it GEOS
    needs an explicit repair: without it, ``shapely.intersection`` on a
    self-intersecting ring can raise or return garbage (a clipped area *larger* than
    the input feature, observed on BAFU "Naturstrasse" road polygons). The
    ``structure`` method reproduces Turf's result exactly (a self-intersecting BAFU
    road piece clipped to 12912.2662 m² in both; the default ``linework`` method
    gave 12912.2525). Repairing an already-valid geometry is a no-op, so clean
    parcels stay bit-identical. May raise ``GEOSException``; the caller counts the
    feature as skipped.
    """
    return polygons_only(shapely.intersection(shapely.make_valid(a, method="structure"),
                                              shapely.make_valid(b, method="structure")))


def union(geoms: list) -> BaseGeometry | None:
    """Union of *geoms* → Polygon/MultiPolygon (``turf.union``); ``None`` if empty."""
    geoms = [g for g in geoms if g is not None and not g.is_empty]
    if not geoms:
        return None
    if len(geoms) == 1:
        return geoms[0]
    u = shapely.union_all(geoms)
    return None if (u is None or u.is_empty) else u


def difference(a: BaseGeometry, b: BaseGeometry) -> BaseGeometry | None:
    """``a`` minus ``b`` → Polygon/MultiPolygon (``turf.difference``); ``None`` if empty."""
    d = shapely.difference(a, b)
    return None if (d is None or d.is_empty) else d
