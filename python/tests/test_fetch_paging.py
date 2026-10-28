"""Fetch robustness against the two server behaviours that silently lose features.

Fake services reproduce what the live endpoints do:

- geo.admin.ch ``identify`` returns at most 200 results per request in an order that
  changes from request to request, so ``offset`` paging overlaps and omits features
  → the clients tile the bbox as a quadtree (every request a single page).
- geodienste.ch WFS applies ``COUNT`` to its spatial-index candidates before the
  exact bbox test, so a non-final page holds fewer than ``COUNT`` features and
  consecutive pages overlap by one → the client pages until an EMPTY page and
  deduplicates.

The same scenarios run against the web client in web/tests/geoapi.test.mjs.
"""

from __future__ import annotations

import json
import random
import urllib.parse

import pytest
from shapely.geometry import box, mapping

import api
import swisstopo

BBOX = (9.30, 47.40, 9.40, 47.48)  # lon/lat


def _grid(n_cols, n_rows, bbox=BBOX, first_id=1):
    """n_cols × n_rows squares tiling *bbox* (adjacent squares share edges, so a tile
    boundary always cuts through features — the dedupe case)."""
    minx, miny, maxx, maxy = bbox
    w, h = (maxx - minx) / n_cols, (maxy - miny) / n_rows
    feats = []
    for r in range(n_rows):
        for c in range(n_cols):
            fid = first_id + r * n_cols + c
            g = box(minx + c * w, miny + r * h, minx + (c + 1) * w, miny + (r + 1) * h)
            feats.append({"id": fid, "geometry": mapping(g), "bbox": g.bounds})
    return feats


def _overlaps(b, env):
    return b[0] <= env[2] and b[2] >= env[0] and b[1] <= env[3] and b[3] >= env[1]


class FakeIdentify:
    """identify: bbox hits in a per-request random order, sliced by limit/offset."""

    def __init__(self, feats, dropped=()):
        self.feats, self.dropped, self.calls = feats, set(dropped), 0

    def __call__(self, url):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        env = [float(v) for v in q["geometry"][0].split(",")]
        limit, offset = int(q["limit"][0]), int(q["offset"][0])
        hits = [f for f in self.feats if _overlaps(f["bbox"], env)]
        random.Random(self.calls).shuffle(hits)  # order differs per request, as on the live server
        self.calls += 1
        return {"results": [
            {"featureId": f["id"], "id": f["id"], "layerBodId": "x",
             "geometry": None if f["id"] in self.dropped else f["geometry"],
             "properties": {"typoch_de": f"6 Wald {f['id']}"}}
            for f in hits[offset:offset + limit]
        ]}


class FakeWFS:
    """WFS: COUNT applies to index candidates (some fail the exact test), pages
    overlap by one, STARTINDEX walks the candidate list."""

    def __init__(self, feats, false_every=10):
        self.feats, self.false_every, self.calls = feats, false_every, 0

    def exact(self):
        return [f for f in self.feats if f["id"] % self.false_every != 0]

    def __call__(self, url):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        count, start = int(q["COUNT"][0]), int(q["STARTINDEX"][0])
        self.calls += 1
        lo = max(0, start - (1 if start else 0))
        page = [f for f in self.feats[lo:lo + count] if f["id"] % self.false_every != 0]
        return {"type": "FeatureCollection", "features": [
            {"type": "Feature", "id": None, "geometry": f["geometry"], "properties": {"Art": "Gebaeude", "BFSNr": 1}}
            for f in page
        ]}


@pytest.fixture
def parcel():
    return box(*BBOX)


# --- identify ------------------------------------------------------------------

def test_identify_quadtree_fetches_every_feature(monkeypatch, parcel):
    world = _grid(30, 30)  # 900 features, far more than one page
    fake = FakeIdentify(world, dropped={5})
    monkeypatch.setattr(api, "_fetch_json", fake)
    r = api.fetch_identify("layer", parcel, 5000)
    ids = sorted(str(f["id"]) for f in r["features"]) + [str(d["id"]) for d in r["dropped"]]
    assert sorted(ids) == sorted(str(f["id"]) for f in world)
    assert [f["id"] for f in r["dropped"]] == [5]
    assert r["total"] == 900 and r["truncated"] is False
    assert fake.calls > 4
    # Deterministic output order regardless of the server's order: sorted by key.
    assert [f["key"] for f in r["features"]] == sorted(f["key"] for f in r["features"])


def test_identify_single_page_needs_one_request(monkeypatch, parcel):
    fake = FakeIdentify(_grid(3, 3))
    monkeypatch.setattr(api, "_fetch_json", fake)
    r = api.fetch_identify("layer", parcel, 5000)
    assert fake.calls == 1 and r["total"] == 9 and not r["truncated"]


def test_identify_depth_cap_flags_truncation(monkeypatch, parcel):
    # 250 features stacked on the same footprint can never be separated by tiling.
    stacked = [{"id": i, "geometry": mapping(box(9.35, 47.44, 9.351, 47.441)), "bbox": (9.35, 47.44, 9.351, 47.441)}
               for i in range(1, 251)]
    fake = FakeIdentify(stacked)
    monkeypatch.setattr(api, "_fetch_json", fake)
    r = api.fetch_identify("layer", parcel, 5000)
    assert r["truncated"] is True
    assert r["total"] >= api.IDENTIFY_PAGE  # the tiles that hit the cap each keep one page


def test_identify_max_features_cap(monkeypatch, parcel):
    monkeypatch.setattr(api, "_fetch_json", FakeIdentify(_grid(30, 30)))
    r = api.fetch_identify("layer", parcel, 300)
    assert r["truncated"] is True and r["total"] >= 300


# --- WFS ------------------------------------------------------------------------

def test_landcover_pages_until_empty_and_dedupes(monkeypatch):
    world = _grid(50, 50)  # 2500 index candidates → pages of 1000 with 10 % exact-test failures
    fake = FakeWFS(world)
    monkeypatch.setattr(api, "_fetch_json", fake)
    r = api.fetch_landcover(list(BBOX))
    assert r["error"] is False and r["truncated"] is False
    got = [json.dumps(f["properties"]) + json.dumps(mapping(f["geometry"])) for f in r["features"]]
    assert len(got) == len(set(got)) == len(fake.exact())
    assert fake.calls == 4  # 3 data pages + the empty page that ends the loop


def test_landcover_short_page_is_not_the_end(monkeypatch):
    """The regression that motivated the change: page 0 is short (candidates fail
    the exact test) but page 1 still has data."""
    fake = FakeWFS(_grid(40, 40))  # 1600 candidates
    monkeypatch.setattr(api, "_fetch_json", fake)
    r = api.fetch_landcover(list(BBOX))
    assert len(r["features"]) == len(fake.exact()) == 1440
    assert fake.calls == 3


def test_landcover_cap_flags_truncation(monkeypatch):
    monkeypatch.setattr(api, "WFS_MAX_FEATURES", 2000)  # → 2 pages
    monkeypatch.setattr(api, "_fetch_json", FakeWFS(_grid(50, 50)))
    r = api.fetch_landcover(list(BBOX))
    assert r["truncated"] is True and len(r["features"]) < 2250


def test_landcover_malformed_geometry_is_skipped_not_fatal(monkeypatch):
    def fake(url):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        if int(q["STARTINDEX"][0]) > 0:
            return {"features": []}
        return {"features": [
            {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": "garbage"}, "properties": {"Art": "Gebaeude"}},
            {"type": "Feature", "geometry": mapping(box(9.31, 47.41, 9.32, 47.42)), "properties": {"Art": "Gebaeude"}},
        ]}
    monkeypatch.setattr(api, "_fetch_json", fake)
    r = api.fetch_landcover(list(BBOX))
    assert r["error"] is False
    assert [f["geometry"] is None for f in r["features"]] == [True, False]


# --- gpkg path (swisstopo.py) ---------------------------------------------------

def test_swisstopo_tiled_fetch_is_complete(monkeypatch):
    world = _grid(30, 30, bbox=(2600000, 1200000, 2601000, 1201000))

    def fake_page(geometry_json, geometry_type, bbox, layer_id):
        hits = [f for f in world if _overlaps(f["bbox"], bbox)]
        random.Random(len(geometry_json)).shuffle(hits)
        return [{"featureId": f["id"], "id": f["id"], "geometry": f["geometry"], "properties": {"ch_bez_d": "Wohnzonen", "ch_code_hn": "11"}}
                for f in hits[:swisstopo.API_LIMIT]]

    monkeypatch.setattr(swisstopo, "_fetch_page", fake_page)
    monkeypatch.setattr(swisstopo, "API_PAUSE", 0)
    cfg = swisstopo.LayerConfig("ch.are.bauzonen", {"ch_bez_d": "bz_bezeichnung", "ch_code_hn": "bz_nutzung"}, id_column="bz_id")
    gdf = swisstopo.fetch_features_for_bbox((2600000, 1200000, 2601000, 1201000), cfg)
    assert sorted(gdf["bz_id"].tolist()) == sorted(f["id"] for f in world)
    assert list(gdf.columns) == ["bz_id", "bz_bezeichnung", "bz_nutzung", "geometry"]
