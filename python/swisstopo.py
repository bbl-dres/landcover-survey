"""Generic Swisstopo REST API client with intersection logic (GeoPackage path).

Provides reusable building blocks for fetching features from any
geo.admin.ch MapServer layer and intersecting them locally with
parcel / green-space geometries. Works in LV95 (EPSG:2056) and returns
GeoDataFrames; the EPSG:4326 web-parity client lives in :mod:`api`.

Fetching tiles the query geometry as a **quadtree** (a tile that returns a full
page is split into four) so every request is a single page. The identify
endpoint's ``offset`` paging is not reliable — the server returns results in a
client-dependent order, so consecutive pages overlap and omit features — and
the same tiling is used by the web app and the ``api`` source.
"""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

import shapely
from geopandas import GeoDataFrame
from pandas import DataFrame
from shapely.geometry import MultiPolygon, Polygon, box, shape

from config import CRS_EPSG, CRS_STRING, SLIVER_THRESHOLD
from geometry import extract_polygons

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# API constants
# ---------------------------------------------------------------------------
# Same endpoint as the web app and the api-path client (api.py). This client
# differs from api.py deliberately: it works in LV95 (EPSG:2056) and returns
# GeoDataFrames for the GeoPackage pipeline, and uses a longer timeout suited
# to unattended bulk runs.
IDENTIFY_URL = "https://api3.geo.admin.ch/rest/services/all/MapServer/identify"
API_LIMIT = 200   # max features per request (documented hard cap)
API_PAUSE = 0.2   # seconds between requests
API_MAX_RETRIES = 3   # retries on transient HTTP errors
API_MAX_DEPTH = 8     # quadtree depth cap for tiles that still return a full page


# ---------------------------------------------------------------------------
# Layer configuration
# ---------------------------------------------------------------------------

@dataclass
class LayerConfig:
    """Describes how to fetch and map a single Swisstopo layer."""

    layer_id: str
    """Technical layer name, e.g. ``ch.are.bauzonen``."""

    column_map: dict[str, str]
    """Maps *API property name* → *output column name*.

    Example: ``{"ch_bez_d": "bz_bezeichnung", "ch_code_hn": "bz_nutzung"}``
    Only listed properties are kept; everything else is dropped.
    """

    id_field: str = "featureId"
    """API response field used as feature-level unique id."""

    id_column: str = "feature_id"
    """Output column name for the feature id."""


# ---------------------------------------------------------------------------
# API helpers
# ---------------------------------------------------------------------------

def _build_params(
    geometry_json: str,
    geometry_type: str,
    bbox: tuple[float, float, float, float],
    layer_id: str,
) -> dict[str, str]:
    minx, miny, maxx, maxy = bbox
    return {
        "geometry": geometry_json,
        "geometryType": geometry_type,
        "layers": f"all:{layer_id}",
        "tolerance": "0",
        "mapExtent": f"{minx},{miny},{maxx},{maxy}",
        "imageDisplay": "100,100,96",
        "sr": str(CRS_EPSG),
        "returnGeometry": "true",
        "geometryFormat": "geojson",
        "limit": str(API_LIMIT),
        "offset": "0",
        "lang": "de",
    }


def _geom_to_esri_json(geom) -> str:
    """Convert a shapely Polygon/MultiPolygon to Esri JSON polygon string.

    Rounds coordinates to 3 decimal places (mm precision in EPSG:2056)
    to reduce URL length.
    """
    if isinstance(geom, MultiPolygon):
        rings = []
        for poly in geom.geoms:
            rings.append([[round(x, 3), round(y, 3)] for x, y in poly.exterior.coords])
            for interior in poly.interiors:
                rings.append([[round(x, 3), round(y, 3)] for x, y in interior.coords])
    elif isinstance(geom, Polygon):
        rings = [[[round(x, 3), round(y, 3)] for x, y in geom.exterior.coords]]
        for interior in geom.interiors:
            rings.append([[round(x, 3), round(y, 3)] for x, y in interior.coords])
    else:
        raise ValueError(f"Cannot convert {type(geom).__name__} to Esri polygon")
    return json.dumps({"rings": rings})


def _fetch_page(
    geometry_json: str,
    geometry_type: str,
    bbox: tuple[float, float, float, float],
    layer_id: str,
) -> list[dict[str, Any]]:
    """One identify request (a single page of at most ``API_LIMIT`` results)."""
    params = _build_params(geometry_json, geometry_type, bbox, layer_id)
    url = f"{IDENTIFY_URL}?{urllib.parse.urlencode(params)}"

    req = urllib.request.Request(url, headers={"User-Agent": "landcover-survey/1.0"})
    last_err: Exception | None = None
    for attempt in range(1, API_MAX_RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            return data.get("results", [])
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code in (400, 414):
                logger.debug("  HTTP %d for %s — geometry invalid or too complex, skipping", e.code, layer_id)
                return []
            if e.code == 429 or e.code >= 500:
                wait = API_PAUSE * (2 ** attempt)
                logger.warning("  HTTP %d — retrying in %.1fs (attempt %d/%d)",
                               e.code, wait, attempt, API_MAX_RETRIES)
                time.sleep(wait)
                continue
            logger.error("  HTTP %d for %s — not retryable", e.code, layer_id)
            raise
        except (urllib.error.URLError, json.JSONDecodeError, OSError) as e:
            last_err = e
            wait = API_PAUSE * (2 ** attempt)
            logger.warning("  %s — retrying in %.1fs (attempt %d/%d)",
                           type(e).__name__, wait, attempt, API_MAX_RETRIES)
            time.sleep(wait)

    logger.error("  API request failed after %d retries: %s", API_MAX_RETRIES, last_err)
    return []


# ---------------------------------------------------------------------------
# Public fetch functions
# ---------------------------------------------------------------------------

MAX_URL_COORDS = 200  # simplify polygons with more vertices than this
SIMPLIFY_TOLERANCE_M = 5.0  # simplify tolerance + outward buffer (m, LV95)


def _query_geometry(geom) -> tuple[str, str]:
    """The identify request geometry for *geom*: an Esri JSON polygon (a tighter
    spatial filter than a bounding box — fewer false positives, fewer tiles), or
    the envelope when even a simplified polygon would exceed the URL length."""
    # Simplification can pull the boundary inward and silently miss features that
    # only touch the parcel edge, so buffer by the same tolerance to keep the filter
    # a strict superset of the real parcel (false positives are dropped by the local
    # intersection afterwards; false negatives would be unrecoverable).
    n_coords = shapely.get_num_coordinates(geom)
    if n_coords > MAX_URL_COORDS:
        geom = geom.simplify(SIMPLIFY_TOLERANCE_M, preserve_topology=True).buffer(
            SIMPLIFY_TOLERANCE_M, join_style="mitre")
        if shapely.get_num_coordinates(geom) > MAX_URL_COORDS:
            logger.debug("Geometry still has %d coords after simplify — using bbox",
                         shapely.get_num_coordinates(geom))
            minx, miny, maxx, maxy = geom.bounds
            return f"{minx},{miny},{maxx},{maxy}", "esriGeometryEnvelope"
    return _geom_to_esri_json(geom), "esriGeometryPolygon"


def _feature_key(feat: dict[str, Any], cfg: LayerConfig) -> str:
    key = feat.get(cfg.id_field)
    if key is None:
        key = feat.get("id")
    if key is not None:
        return str(key)
    return json.dumps([feat.get("geometry"), feat.get("properties")], sort_keys=True)


def _fetch_tiled(geom, cfg: LayerConfig, context: str = "") -> GeoDataFrame:
    """All *cfg.layer_id* features intersecting *geom* (a Polygon/MultiPolygon in
    LV95) as a GeoDataFrame — quadtree tiling, deduplicated by feature id, sorted by id."""
    ctx = f" [{context}]" if context else ""
    seen: dict[str, dict[str, Any]] = {}
    truncated = False
    n_requests = 0
    stack: list[tuple[Any, int]] = [(geom, 0)]

    while stack:
        g, depth = stack.pop()
        if g is None or g.is_empty:
            continue
        geometry_json, geometry_type = _query_geometry(g)
        if n_requests:
            time.sleep(API_PAUSE)
        page = _fetch_page(geometry_json, geometry_type, g.bounds, cfg.layer_id)
        n_requests += 1

        if len(page) >= API_LIMIT and depth < API_MAX_DEPTH:
            # Full page → the tile may hold more than one page: split it into four
            # quadrants (each clipped to the query polygon, so the filter stays tight).
            minx, miny, maxx, maxy = g.bounds
            mx, my = (minx + maxx) / 2, (miny + maxy) / 2
            for quadrant in (box(minx, miny, mx, my), box(mx, miny, maxx, my),
                             box(minx, my, mx, maxy), box(mx, my, maxx, maxy)):
                try:
                    piece = extract_polygons(shapely.make_valid(g).intersection(quadrant))
                except Exception:  # noqa: BLE001 — degenerate input: fall back to the quadrant itself
                    piece = quadrant
                stack.append((piece, depth + 1))
            continue
        if len(page) >= API_LIMIT:
            truncated = True
        for feat in page:
            seen.setdefault(_feature_key(feat, cfg), feat)

    if truncated:
        logger.warning("%s%s — tiling hit the depth cap with a full page (%d features), results may be incomplete",
                       cfg.layer_id, ctx, len(seen))
    logger.debug("  Fetched %d %s features in %d request(s)%s", len(seen), cfg.layer_id, n_requests, ctx)
    return _parse_features([seen[k] for k in sorted(seen)], cfg)


def _parse_features(all_features: list[dict[str, Any]], cfg: LayerConfig) -> GeoDataFrame:
    """Raw identify results → GeoDataFrame with the configured columns."""
    if not all_features:
        return _empty_gdf(cfg)

    rows: list[dict[str, Any]] = []
    for feat in all_features:
        geom_dict = feat.get("geometry")
        props = feat.get("properties", {})
        if geom_dict is None:
            # The server omits the geometry of oversized features; nothing to clip.
            continue
        try:
            geom = shape(geom_dict)
        except Exception:
            logger.debug("Skipping feature with invalid geometry: %s", feat.get("id"))
            continue

        rec: dict[str, Any] = {
            cfg.id_column: feat.get(cfg.id_field) or feat.get("id"),
        }
        for api_key, out_col in cfg.column_map.items():
            rec[out_col] = props.get(api_key, "")
        rec["geometry"] = geom
        rows.append(rec)

    if not rows:
        return _empty_gdf(cfg)

    gdf = GeoDataFrame(rows, geometry="geometry", crs=CRS_STRING)
    gdf = gdf.drop_duplicates(subset=cfg.id_column).reset_index(drop=True)
    return gdf


def fetch_features_for_polygon(
    geom,
    cfg: LayerConfig,
    context: str = "",
) -> GeoDataFrame:
    """Fetch all features of *cfg.layer_id* intersecting a polygon geometry.

    Uses ``esriGeometryPolygon`` for a tighter spatial filter than a
    bounding box, reducing false positives; complex polygons are simplified to
    stay within URL length limits. Tiled so that every request is a single page.
    """
    return _fetch_tiled(geom, cfg, context=context)


def fetch_features_for_bbox(
    bbox: tuple[float, float, float, float],
    cfg: LayerConfig,
    context: str = "",
) -> GeoDataFrame:
    """Fetch all features of *cfg.layer_id* intersecting *bbox* (tiled).

    Returns a GeoDataFrame with columns defined in *cfg* plus ``geometry``.
    """
    return _fetch_tiled(box(*bbox), cfg, context=context)


# ---------------------------------------------------------------------------
# Intersection
# ---------------------------------------------------------------------------

def intersect_with_features(
    geom_gdf: GeoDataFrame,
    features_gdf: GeoDataFrame,
    cfg: LayerConfig,
    id_cols: list[str],
) -> DataFrame:
    """Intersect *geom_gdf* with *features_gdf* and return area breakdown.

    Returns one row per (input feature × layer feature) intersection.
    Columns: *id_cols* + *cfg.id_column* + mapped columns + ``intersection_area_m2``.
    """
    out_cols = (
        id_cols
        + [cfg.id_column]
        + list(cfg.column_map.values())
        + ["intersection_area_m2"]
    )

    if geom_gdf.empty or features_gdf.empty:
        return DataFrame(columns=out_cols)

    results: list[dict] = []

    for _, row in geom_gdf.iterrows():
        feature_geom = row.geometry
        if feature_geom is None or feature_geom.is_empty:
            continue
        # Ensure input geometry is valid before intersection
        if not feature_geom.is_valid:
            feature_geom = shapely.make_valid(feature_geom)

        # Pre-filter by bbox
        minx, miny, maxx, maxy = feature_geom.bounds
        candidates = features_gdf.cx[minx:maxx, miny:maxy]
        if candidates.empty:
            continue

        # Ensure candidate geometries are valid, then intersect. Fail-soft: a GEOS
        # error on one degenerate layer feature must drop only that feature, not
        # abort the run — retry per feature on failure (as _clip_single_parcel does).
        valid_candidates = shapely.make_valid(candidates.geometry.values)
        try:
            clipped = shapely.intersection(valid_candidates, feature_geom)
        except Exception:  # noqa: BLE001 — GEOSException on degenerate input
            clipped = []
            n_failed = 0
            for g in valid_candidates:
                try:
                    clipped.append(shapely.intersection(g, feature_geom))
                except Exception:  # noqa: BLE001
                    clipped.append(None)
                    n_failed += 1
            logger.warning("  %s — clip failed for %d feature(s) of %s — dropped",
                           cfg.layer_id, n_failed, row.get("EGRID", "?"))
        clipped = shapely.make_valid(clipped)

        for i, (_, feat_row) in enumerate(candidates.iterrows()):
            geom = clipped[i]
            if geom is None or geom.is_empty:
                continue
            area = _extract_poly_area(geom)
            if area < SLIVER_THRESHOLD:
                continue

            rec = {col: row.get(col, "") for col in id_cols}
            rec[cfg.id_column] = feat_row[cfg.id_column]
            for out_col in cfg.column_map.values():
                rec[out_col] = feat_row.get(out_col, "")
            rec["intersection_area_m2"] = round(area, 2)
            results.append(rec)

    if not results:
        return DataFrame(columns=out_cols)
    return DataFrame(results, columns=out_cols)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _extract_poly_area(geom) -> float:
    """Total polygon area, ignoring non-polygon parts."""
    if isinstance(geom, (Polygon, MultiPolygon)):
        return geom.area
    if hasattr(geom, "geoms"):
        return sum(g.area for g in geom.geoms if isinstance(g, (Polygon, MultiPolygon)))
    return 0.0


def _empty_gdf(cfg: LayerConfig) -> GeoDataFrame:
    cols = [cfg.id_column] + list(cfg.column_map.values()) + ["geometry"]
    return GeoDataFrame(columns=cols, geometry="geometry", crs=CRS_STRING)
