"""The Turf port: spherical areas must reproduce Turf 7 bit for bit; clipped
pieces to the last exported digit.

tests/fixtures/turf_golden.json holds geometries with the areas / clip areas Turf
7.4.0 computed for them (a real parcel + BAFU habitat polygons, two of them
self-intersecting — the case where GEOS needs make_valid(method="structure") to
agree with Turf's clipper).

- ``area``: same formula, same sin (fdlibm) → identical doubles, asserted with ``==``.
- ``intersect``: the intersection *vertices* come from two different clippers
  (GEOS vs polyclip-ts), each computing the crossing points with its own arithmetic,
  so clip areas agree to ~1e-8 relative (≤ 2e-5 m² on the largest piece here) — far
  inside the 0.01 m² the exports carry, which is what is asserted.
"""

from __future__ import annotations

import json
import math

import pytest
from shapely.geometry import shape

import geom_wgs84 as geom
from conftest import FIXTURES
from processor_web import round2

GOLDEN = json.loads((FIXTURES / "turf_golden.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", GOLDEN["areas"], ids=[c["name"] for c in GOLDEN["areas"]])
def test_area_matches_turf(case):
    area = geom.area(shape(case["geometry"]))
    assert area == case["area"], (area, case["area"])  # bit-identical: same formula, same sin
    assert round2(area) == round2(case["area"])


@pytest.mark.parametrize("case", GOLDEN["clips"], ids=[f"bafu {c['id']}" for c in GOLDEN["clips"]])
def test_clip_matches_turf(case):
    parcel = shape(GOLDEN["parcel"])
    feature = shape(case["geometry"])
    inter = geom.intersect(parcel, feature)
    area = geom.area(inter) if inter is not None else 0.0
    assert math.isclose(area, case["clip_area"], rel_tol=1e-7, abs_tol=0.0), (case["id"], area, case["clip_area"])
    assert round2(area) == round2(case["clip_area"])
    if case["clip_type"] is None:
        assert inter is None


def test_self_intersecting_features_are_present_in_golden():
    """Guard: the fixture must keep covering invalid input (that is what the
    structure-repair in geom_wgs84.intersect exists for)."""
    invalid = [c["id"] for c in GOLDEN["clips"] if not shape(c["geometry"]).is_valid]
    assert invalid, "fixture lost its self-intersecting features"


def test_bbox_is_lon_lat_order():
    g = shape({"type": "Polygon", "coordinates": [[[9.1, 47.2], [9.3, 47.2], [9.3, 47.4], [9.1, 47.4], [9.1, 47.2]]]})
    assert geom.bbox(g) == [9.1, 47.2, 9.3, 47.4]


def test_polygons_only_drops_lines_and_points():
    from shapely.geometry import GeometryCollection, LineString, Point, Polygon
    poly = Polygon([(0, 0), (1, 0), (1, 1), (0, 1)])
    gc = GeometryCollection([poly, LineString([(0, 0), (2, 2)]), Point(5, 5)])
    assert geom.polygons_only(gc).equals(poly)
    assert geom.polygons_only(GeometryCollection([LineString([(0, 0), (2, 2)])])) is None
    assert geom.polygons_only(None) is None
