"""gpkg source — the Bauzonen / habitat overlays (swisstopo.py + pipeline).

Offline: the identify service is replaced by a fake ``swisstopo._fetch_page`` (or
a fake ``urlopen``) that behaves like the real one where it matters — it answers
HTTP 400 to a polygon with more than one ring. The numbers in brackets are the
findings of the 2026-11-10 gpkg review each test pins down.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.error

import geopandas as gpd
import pandas as pd
import pytest
from shapely.geometry import MultiPolygon, Polygon, box, mapping

import pipeline
import swisstopo
from bauzonen import BAUZONEN_CONFIG
from habitat import HABITAT_CONFIG

X, Y = 2600000.0, 1200000.0


def sq(i, j=0, w=10, h=10):
    return box(X + i, Y + j, X + i + w, Y + j + h)


def _frame(rows, int_cols):
    df = pd.DataFrame([{k: v for k, v in r.items() if k != "geometry"} for r in rows])
    for c in int_cols:
        if c in df.columns:
            df[c] = pd.array(list(df[c]), dtype="Int64")
    return gpd.GeoDataFrame(df, geometry=[r["geometry"] for r in rows], crs="EPSG:2056")


def make_gpkg(path, parcel_geoms, landcover=None):
    """Parcels CH000000000001 … n with the given geometries; one garden covers all."""
    parcels = [{"BFSNr": 1, "Nummer": str(n), "EGRIS_EGRID": f"CH{n:012d}", "Flaeche": round(g.area), "geometry": g}
               for n, g in enumerate(parcel_geoms, 1)]
    if landcover is None:
        landcover = [{"BFSNr": 1, "Art": "Gartenanlage", "GWR_EGID": None, "geometry": sq(-100, -100, 1000, 300)}]
    _frame(parcels, ["BFSNr", "Flaeche"]).to_file(path, layer="resf", driver="GPKG")
    _frame(landcover, ["BFSNr"]).to_file(path, layer="lcsf", driver="GPKG")
    return str(path)


def feature(fid, name, geom, **props):
    """One identify result as the service sends it (both layers' name fields set)."""
    return {"featureId": fid, "id": fid, "geometry": mapping(geom) if geom is not None else None,
            "properties": {"ch_bez_d": name, "ch_code_hn": "11", "typoch_de": name, "prob_de": "hoch", **props}}


class FakeIdentify:
    """Stand-in for ``swisstopo._fetch_page``: returns the features whose bbox
    overlaps the request's, and — like geo.admin.ch — rejects a polygon with more
    than one ring with HTTP 400."""

    def __init__(self, features, fail_where=None):
        self.features = features
        self.fail_where = fail_where        # callable(bbox) -> True: the request fails
        self.requests = []

    def __call__(self, geometry_json, geometry_type, bbox, layer_id):
        self.requests.append((geometry_type, geometry_json))
        if geometry_type == "esriGeometryPolygon" and len(json.loads(geometry_json)["rings"]) != 1:
            raise swisstopo.IdentifyError("HTTP 400 — Please provide a valid geometry", status=400)
        if self.fail_where is not None and self.fail_where(bbox):
            raise swisstopo.IdentifyError("HTTP 502 after 3 attempts", status=502)
        minx, miny, maxx, maxy = bbox
        out = []
        for f in self.features:
            g = f.get("_bbox")
            if g is None or (g[0] < maxx and g[2] > minx and g[1] < maxy and g[3] > miny):
                out.append({k: v for k, v in f.items() if k != "_bbox"})
        return out


def with_bbox(f, geom):
    f["_bbox"] = geom.bounds
    return f


@pytest.fixture(autouse=True)
def no_pause(monkeypatch):
    monkeypatch.setattr(swisstopo, "API_PAUSE", 0)


def run(tmp_path, ts, **kw):
    return pipeline.run(output_dir=str(tmp_path / "out"), ts=ts, mode=1, **kw)


def read_out(tmp_path, kind, ts):
    files = list((tmp_path / "out").glob(f"*{kind}_{ts}.csv"))
    assert len(files) == 1, files
    return pd.read_csv(files[0], sep=";", dtype=str, keep_default_na=False, encoding="utf-8-sig")


def write_list(tmp_path, n, extra=""):
    p = tmp_path / "list.csv"
    p.write_text("ID,EGRID\n" + "".join(f"p{i},CH{i:012d}\n" for i in range(1, n + 1)) + extra, encoding="utf-8")
    return str(p)


# --- [1] only single-ring polygons are sent ---------------------------------------------------

def test_query_geometry_never_has_more_than_one_ring():
    plain = sq(0)
    holed = Polygon(sq(0, 0, 30, 30).exterior.coords, [sq(10, 10, 5, 5).exterior.coords])
    multi = MultiPolygon([sq(0), sq(50)])
    big_holed = Polygon(sq(0, 0, 3000, 3000).buffer(50, quad_segs=80).exterior.coords,     # > 200 vertices
                        [sq(1000, 1000, 500, 500).exterior.coords])

    gj, gt = swisstopo._query_geometry(plain)
    assert gt == "esriGeometryPolygon" and len(json.loads(gj)["rings"]) == 1

    for geom in (holed, multi, big_holed):                 # was: 2 rings → HTTP 400 → silently no features
        gj, gt = swisstopo._query_geometry(geom)
        assert gt == "esriGeometryEnvelope"
        assert [float(v) for v in gj.split(",")] == pytest.approx(list(geom.bounds), abs=6)


def test_parcel_with_a_hole_and_parcel_in_two_parts_get_their_zone(tmp_path, monkeypatch):
    holed = Polygon(sq(0, 0, 30, 30).exterior.coords, [sq(10, 10, 10, 10).exterior.coords])   # 800 m²
    two_parts = MultiPolygon([sq(100), sq(150)])                                              # 200 m²
    g = make_gpkg(tmp_path / "av.gpkg", [holed, two_parts, sq(300)])
    zone = sq(-50, -50, 600, 200)
    fake = FakeIdentify([feature(1, "Wohnzonen", zone)])
    monkeypatch.setattr(swisstopo, "_fetch_page", fake)

    assert run(tmp_path, "t", input_path=write_list(tmp_path, 3), gpkg_path=g, bauzonen=True) is True
    p = read_out(tmp_path, "parcels", "t").set_index("id")
    assert list(p["check_bauzonen"]) == ["ok", "ok", "ok"]
    assert list(p["bauzonen"]) == ["Wohnzonen"] * 3                      # was "" for p1 and p2
    assert [float(v) for v in p["bauzonen_wohnzonen_m2"]] == pytest.approx([800.0, 200.0, 100.0])
    # no request the real service would reject was sent
    assert all(gt == "esriGeometryEnvelope" or len(json.loads(gj)["rings"]) == 1 for gt, gj in fake.requests)


# --- [1] a failed request is an error, never an empty answer --------------------------------------

def _http_error(code):
    return urllib.error.HTTPError("http://x", code, "nope", {}, None)


@pytest.mark.parametrize("code, attempts", [(400, 1), (414, 1), (403, 1), (502, swisstopo.API_MAX_RETRIES)])
def test_fetch_page_raises_instead_of_returning_an_empty_page(monkeypatch, code, attempts):
    calls = []

    def urlopen(req, timeout=None):
        calls.append(1)
        raise _http_error(code)

    monkeypatch.setattr(swisstopo.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(swisstopo.time, "sleep", lambda s: None)
    with pytest.raises(swisstopo.IdentifyError) as exc:               # was: return []
        swisstopo._fetch_page("0,0,1,1", "esriGeometryEnvelope", (0, 0, 1, 1), "ch.are.bauzonen")
    assert exc.value.status == code
    assert len(calls) == attempts


def test_network_failure_raises_after_the_retries(monkeypatch):
    monkeypatch.setattr(swisstopo.urllib.request, "urlopen",
                        lambda req, timeout=None: (_ for _ in ()).throw(urllib.error.URLError("down")))
    monkeypatch.setattr(swisstopo.time, "sleep", lambda s: None)
    with pytest.raises(swisstopo.IdentifyError) as exc:
        swisstopo._fetch_page("0,0,1,1", "esriGeometryEnvelope", (0, 0, 1, 1), "ch.are.bauzonen")
    assert exc.value.status is None


def test_rejected_polygon_is_asked_again_as_envelope(monkeypatch):
    seen = []

    def page(geometry_json, geometry_type, bbox, layer_id):
        seen.append(geometry_type)
        if geometry_type == "esriGeometryPolygon":
            raise swisstopo.IdentifyError("HTTP 414", status=414)
        return [feature(1, "Wohnzonen", sq(0))]

    monkeypatch.setattr(swisstopo, "_fetch_page", page)
    gdf, info = swisstopo.fetch_features_with_status(sq(0), BAUZONEN_CONFIG)
    assert seen == ["esriGeometryPolygon", "esriGeometryEnvelope"]
    assert len(gdf) == 1 and info == {"truncated": False, "dropped": 0}


def test_failed_request_reaches_the_output_and_leaves_the_cells_empty(tmp_path, monkeypatch):
    g = make_gpkg(tmp_path / "av.gpkg", [sq(0), sq(100), sq(200)])
    fake = FakeIdentify([with_bbox(feature(1, "Wohnzonen", sq(0)), sq(0))],
                        fail_where=lambda bbox: bbox[0] >= X + 199)          # p3: the service is down
    monkeypatch.setattr(swisstopo, "_fetch_page", fake)
    inp = write_list(tmp_path, 3, extra="p4,CH999999999999\n")

    assert run(tmp_path, "t", input_path=inp, gpkg_path=g, bauzonen=True) is True
    p = read_out(tmp_path, "parcels", "t").set_index("id")
    cols = ["bauzonen", "bauzonen_m2", "check_bauzonen", "bauzonen_wohnzonen_m2"]
    assert list(p.loc["p1", cols]) == ["Wohnzonen", "100.0", "ok", "100.0"]
    assert list(p.loc["p2", cols]) == ["", "", "ok", "0.0"]        # asked, nothing there
    assert list(p.loc["p3", cols]) == ["", "", "error", ""]        # was indistinguishable from p2
    assert list(p.loc["p4", cols]) == ["", "", "", ""]             # not found: not asked
    # column order: the check sits with its overlay, before the per-type columns
    names = list(p.columns)
    assert names.index("bauzonen_m2") + 1 == names.index("check_bauzonen") < names.index("bauzonen_wohnzonen_m2")

    lc = read_out(tmp_path, "landcover", "t").set_index("id")
    assert lc.loc["p1", "bauzonen"] == "Wohnzonen" and lc.loc["p3", "bauzonen"] == ""


def test_truncated_and_partial_are_flagged(tmp_path, monkeypatch):
    g = make_gpkg(tmp_path / "av.gpkg", [sq(0), sq(100), sq(200), sq(300)])
    # p1: a full page at the depth cap → truncated
    many = [with_bbox(feature(100 + i, "Wohnzonen", sq(0, 0, 10, 10)), sq(0)) for i in range(swisstopo.API_LIMIT)]
    # p2: one zone came without geometry (the server drops oversized ones) → partial
    dropped_bz = with_bbox(feature(2, "Arbeitszonen", None), sq(100))
    fake = FakeIdentify(many + [dropped_bz])
    monkeypatch.setattr(swisstopo, "_fetch_page", fake)
    monkeypatch.setattr(swisstopo, "API_MAX_DEPTH", 0)
    run(tmp_path, "bz", input_path=write_list(tmp_path, 4), gpkg_path=g, bauzonen=True)
    p = read_out(tmp_path, "parcels", "bz").set_index("id")
    assert list(p["check_bauzonen"]) == ["truncated", "partial", "ok", "ok"]

    # habitat is wall-to-wall: a dropped feature only matters when it leaves a gap
    fake = FakeIdentify([
        with_bbox(feature(1, "6.3.1 Buchenwald", sq(0)), sq(0)), with_bbox(feature(2, "9.3.2 Strasse", None), sq(0)),
        with_bbox(feature(3, "6.3.1 Buchenwald", sq(100, 0, 6, 10)), sq(100)), with_bbox(feature(4, "9.3.2 Strasse", None), sq(100)),
    ])
    monkeypatch.setattr(swisstopo, "_fetch_page", fake)
    run(tmp_path, "hb", input_path=write_list(tmp_path, 2), gpkg_path=g, habitat=True)
    p = read_out(tmp_path, "parcels", "hb").set_index("id")
    assert list(p["check_habitat"]) == ["ok", "partial"]             # p1 fully covered, p2 60 of 100 m²


# --- [9] grouping of names -----------------------------------------------------------------------

def test_habitat_level1_label_null_label_and_idless_features(tmp_path, monkeypatch):
    g = make_gpkg(tmp_path / "av.gpkg", [sq(0)])
    strips = [sq(0, 2 * k, 10, 2) for k in range(5)]                 # five 20 m² strips = the parcel
    idless = [{"geometry": mapping(strips[3]), "properties": {"typoch_de": "4.5.1 Fromentalwiese", "prob_de": "x"}},
              {"geometry": mapping(strips[4]), "properties": {"typoch_de": "4.5.2 Goldhaferwiese", "prob_de": "x"}}]
    fake = FakeIdentify([feature(1, "6.3.1 Buchenwald", strips[0]), feature(2, None, strips[1]),
                         feature(3, "6 Wälder", strips[2])] + idless)
    monkeypatch.setattr(swisstopo, "_fetch_page", fake)

    run(tmp_path, "t", input_path=write_list(tmp_path, 1), gpkg_path=g, habitat=True)
    p = read_out(tmp_path, "parcels", "t").iloc[0]
    names = p["habitat"].split("; ")
    areas = [float(v) for v in p["habitat_m2"].split("; ")]
    by_name = dict(zip(names, areas))

    assert sum(areas) == pytest.approx(100.0)                        # was 80: one id-less feature lost
    assert "" not in names                                           # was an unnamed group
    level2 = [n for n in names if n.startswith("4.5")]
    assert len(level2) == 1 and by_name[level2[0]] == pytest.approx(40.0)       # both id-less strips
    level1 = [n for n in names if n.startswith("6 ")]                # the level-1-only label keeps its name
    assert len(level1) == 1 and by_name[level1[0]] == pytest.approx(20.0)
    assert by_name["?"] == pytest.approx(20.0)                       # the feature without a label
    assert "habitat__m2" not in p.index or float(p["habitat__m2"]) == pytest.approx(20.0)   # only "?"
    per_type = {c: float(p[c]) for c in p.index if c.startswith("habitat_") and c != "habitat_m2"}
    assert sum(per_type.values()) == pytest.approx(100.0)
    assert any(c.startswith("habitat_6_") and not c.startswith("habitat_6_3") for c in per_type)


def test_idless_features_are_not_collapsed_into_one():
    feats = [{"geometry": mapping(box(0, 0, 1, 1)), "properties": {"ch_bez_d": "A", "ch_code_hn": "1"}},
             {"geometry": mapping(box(5, 5, 6, 6)), "properties": {"ch_bez_d": "B", "ch_code_hn": "2"}},
             {"geometry": mapping(box(5, 5, 6, 6)), "properties": {"ch_bez_d": "B", "ch_code_hn": "2"}}]   # true duplicate
    gdf = swisstopo._parse_features(feats, BAUZONEN_CONFIG)
    assert list(gdf["bz_bezeichnung"]) == ["A", "B"]                 # was ["A"]
    zero_id = swisstopo._parse_features([{"featureId": 0, "geometry": mapping(box(0, 0, 1, 1)), "properties": {}}],
                                        BAUZONEN_CONFIG)
    assert list(zero_id["bz_id"]) == [0] and list(zero_id["bz_bezeichnung"]) == [""]


def test_zone_without_a_name_is_reported_as_question_mark():
    raw = pd.DataFrame([
        {"EGRID": "CH1", "bz_bezeichnung": "Wohnzonen", "intersection_area_m2": 60.0},
        {"EGRID": "CH1", "bz_bezeichnung": None, "intersection_area_m2": 30.0},
        {"EGRID": "CH1", "bz_bezeichnung": "", "intersection_area_m2": 10.0},
    ])
    joined = pipeline._aggregate_layer_results(raw, "EGRID", "bz_bezeichnung", "bauzonen").iloc[0]
    assert (joined["bauzonen"], joined["bauzonen_m2"]) == ("Wohnzonen; ?", "60.0; 40.0")     # was "Wohnzonen" / "60.0"
    per_type = pipeline._aggregate_layer_pertype(raw, "EGRID", "bz_bezeichnung", "bauzonen").iloc[0]
    assert per_type["bauzonen_wohnzonen_m2"] == 60.0
    assert sum(v for k, v in per_type.items() if k != "EGRID") == pytest.approx(100.0)
    assert not any("nan" in c or "none" in c for c in per_type.index)                        # was bauzonen_nan_m2


# --- [13] sum first, round for output ----------------------------------------------------------------

def test_overlay_pieces_are_summed_before_rounding():
    strip = gpd.GeoDataFrame([{"ID": "1", "EGRID": "CH1", "geometry": box(0, 0, 100, 1.236)}],
                             geometry="geometry", crs="EPSG:2056")
    zones = gpd.GeoDataFrame({"bz_id": range(100), "bz_bezeichnung": ["Wohnzonen"] * 100, "bz_nutzung": ["11"] * 100},
                             geometry=[box(i, 0, i + 1, 2) for i in range(100)], crs="EPSG:2056")
    hits = swisstopo.intersect_with_features(strip, zones, BAUZONEN_CONFIG, ["ID", "EGRID"])
    assert hits["intersection_area_m2"].sum() == pytest.approx(123.6)        # was 124.00 (100 × 1.24)
    joined = pipeline._aggregate_layer_results(hits, "EGRID", "bz_bezeichnung", "bauzonen").iloc[0]
    assert joined["bauzonen_m2"] == "123.6"                                  # was "124.0"
    per_type = pipeline._aggregate_layer_pertype(hits, "EGRID", "bz_bezeichnung", "bauzonen").iloc[0]
    assert per_type["bauzonen_wohnzonen_m2"] == 123.6                        # rounded to 0.01 at the end


# --- [10] Ctrl-C stops the fetch --------------------------------------------------------------------------

def test_ctrl_c_cancels_the_queued_overlay_requests(monkeypatch):
    n = 300
    parcels = gpd.GeoDataFrame({"ID": [f"p{i}" for i in range(n)], "EGRID": [f"CH{i:012d}" for i in range(n)]},
                               geometry=[sq(20 * i) for i in range(n)], crs="EPSG:2056")
    parcels_out = pd.DataFrame({"ID": parcels["ID"], "EGRID": parcels["EGRID"]})
    lc_out = pd.DataFrame(columns=["ID", "EGRID", "fid", "Art", "Check_GreenSpace"])
    started, lock = [], threading.Lock()

    def fetch(geom, egrid, cfg):
        with lock:
            started.append(egrid)
            first = len(started) == 1
        if first:
            raise KeyboardInterrupt            # surfaces in the main thread through fut.result()
        time.sleep(0.05)
        return gpd.GeoDataFrame(), {"error": False, "truncated": False, "dropped": 0}

    monkeypatch.setattr(pipeline, "_fetch_for_parcel", fetch)
    t0 = time.time()
    with pytest.raises(KeyboardInterrupt):
        pipeline._run_layer_analysis(HABITAT_CONFIG, "habitat", parcels, parcels_out, lc_out)
    elapsed = time.time() - t0
    time.sleep(0.2)                            # let the requests that were already running finish
    assert len(started) < n / 2                # was: all 300 ran before the interrupt came through
    assert elapsed < 1.0                       # was: n × 0.05 s / 10 workers = 1.5 s


def test_interrupted_overlay_still_writes_the_land_cover_result(tmp_path, monkeypatch):
    g = make_gpkg(tmp_path / "av.gpkg", [sq(0), sq(100)])
    monkeypatch.setattr(pipeline, "_fetch_for_parcel", lambda *a: (_ for _ in ()).throw(KeyboardInterrupt()))
    assert run(tmp_path, "t", input_path=write_list(tmp_path, 2), gpkg_path=g, bauzonen=True, habitat=True) is False
    p = read_out(tmp_path, "parcels", "t")
    assert list(p["check_egrid"]) == ["found", "found"]
    assert [float(v) for v in p["greenspace_m2"]] == pytest.approx([100.0, 100.0])
    assert not [c for c in p.columns if "bauzonen" in c or "habitat" in c]      # the overlay is left out, not half-filled
