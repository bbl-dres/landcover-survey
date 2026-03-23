"""Generic Swisstopo REST API client with caching and intersection logic.

Provides reusable building blocks for fetching features from any
geo.admin.ch MapServer layer and intersecting them locally with
parcel / green-space geometries.
"""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any

import geopandas as gpd
import pandas as pd
import shapely
from geopandas import GeoDataFrame
from pandas import DataFrame
from shapely.geometry import MultiPolygon, Polygon, shape

from config import CRS_EPSG, CRS_STRING, SLIVER_THRESHOLD

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# API constants
# ---------------------------------------------------------------------------
IDENTIFY_URL = "https://api3.geo.admin.ch/rest/services/ech/MapServer/identify"
API_LIMIT = 200   # max features per request
API_PAUSE = 0.2   # seconds between paginated / grouped requests
API_MAX_RETRIES = 3   # retries on transient HTTP errors
API_MAX_PAGES = 50    # safety cap to prevent infinite pagination loops


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

    cache: dict[str, GeoDataFrame] = field(default_factory=dict, repr=False)
    """Per-BFSNr fetch cache (populated at runtime)."""

    def clear_cache(self) -> None:
        self.cache.clear()


# ---------------------------------------------------------------------------
# API helpers
# ---------------------------------------------------------------------------

def _build_params(
    geometry_json: str,
    geometry_type: str,
    bbox: tuple[float, float, float, float],
    layer_id: str,
    offset: int = 0,
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
        "offset": str(offset),
        "lang": "de",
    }


def _geom_to_esri_json(geom) -> str:
    """Convert a shapely Polygon/MultiPolygon to Esri JSON polygon string."""
    if isinstance(geom, MultiPolygon):
        rings = []
        for poly in geom.geoms:
            rings.append([[x, y] for x, y in poly.exterior.coords])
            for interior in poly.interiors:
                rings.append([[x, y] for x, y in interior.coords])
    elif isinstance(geom, Polygon):
        rings = [[[x, y] for x, y in geom.exterior.coords]]
        for interior in geom.interiors:
            rings.append([[x, y] for x, y in interior.coords])
    else:
        raise ValueError(f"Cannot convert {type(geom).__name__} to Esri polygon")
    return json.dumps({"rings": rings})


def _fetch_page(
    geometry_json: str,
    geometry_type: str,
    bbox: tuple[float, float, float, float],
    layer_id: str,
    offset: int = 0,
) -> list[dict[str, Any]]:
    params = _build_params(geometry_json, geometry_type, bbox, layer_id, offset=offset)
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

def _fetch_and_parse(
    geometry_json: str,
    geometry_type: str,
    bbox: tuple[float, float, float, float],
    cfg: LayerConfig,
) -> GeoDataFrame:
    """Fetch all features (paginated) and parse into a GeoDataFrame."""
    all_features: list[dict[str, Any]] = []
    offset = 0
    seen_ids: set = set()

    for _page_num in range(API_MAX_PAGES):
        page = _fetch_page(geometry_json, geometry_type, bbox, cfg.layer_id, offset=offset)
        if not page:
            break
        # Detect stuck pagination: if all IDs were already seen, stop
        new_ids = {f.get("id") or f.get("featureId") for f in page}
        if new_ids <= seen_ids:
            logger.warning("  Pagination returned duplicate page — stopping at offset %d", offset)
            break
        seen_ids.update(new_ids)
        all_features.extend(page)
        if len(page) < API_LIMIT:
            break
        offset += len(page)
        time.sleep(API_PAUSE)
    else:
        logger.warning("  Pagination hit safety cap (%d pages) for %s", API_MAX_PAGES, cfg.layer_id)

    if not all_features:
        return _empty_gdf(cfg)

    rows: list[dict[str, Any]] = []
    for feat in all_features:
        geom_dict = feat.get("geometry")
        props = feat.get("properties", {})
        if geom_dict is None:
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
    logger.debug("  Fetched %d %s features from API", len(gdf), cfg.layer_id)
    return gdf


MAX_URL_COORDS = 200  # simplify polygons with more vertices than this


def fetch_features_for_polygon(
    geom,
    cfg: LayerConfig,
) -> GeoDataFrame:
    """Fetch all features of *cfg.layer_id* intersecting a polygon geometry.

    Uses ``esriGeometryPolygon`` for a tighter spatial filter than a
    bounding box, reducing false positives and pagination pressure.
    Simplifies complex geometries to stay within URL length limits.
    """
    # Fall back to bounding box for complex polygons to avoid HTTP 414 (URI too long)
    n_coords = shapely.get_num_coordinates(geom)
    if n_coords > MAX_URL_COORDS:
        logger.debug("Geometry has %d coords — falling back to bbox", n_coords)
        return fetch_features_for_bbox(geom.bounds, cfg)

    geom_json = _geom_to_esri_json(geom)
    bbox = geom.bounds
    return _fetch_and_parse(geom_json, "esriGeometryPolygon", bbox, cfg)


def fetch_features_for_bbox(
    bbox: tuple[float, float, float, float],
    cfg: LayerConfig,
) -> GeoDataFrame:
    """Fetch all features of *cfg.layer_id* intersecting *bbox* (paginated).

    Returns a GeoDataFrame with columns defined in *cfg* plus ``geometry``.
    """
    minx, miny, maxx, maxy = bbox
    geom_json = f"{minx},{miny},{maxx},{maxy}"
    return _fetch_and_parse(geom_json, "esriGeometryEnvelope", bbox, cfg)


def fetch_features_cached(
    parcels_gdf: GeoDataFrame,
    cfg: LayerConfig,
) -> GeoDataFrame:
    """Fetch features for all parcels, cached by BFSNr.

    One API call per municipality using the convex hull of all parcels
    in that group (tighter than a bounding box, reduces false positives).
    """
    if parcels_gdf.empty:
        return _empty_gdf(cfg)

    if "BFSNr" in parcels_gdf.columns:
        groups = parcels_gdf.groupby("BFSNr")
    else:
        groups = [("all", parcels_gdf)]

    frames: list[GeoDataFrame] = []
    for bfsnr, group in groups:
        cache_key = str(bfsnr)
        if cache_key in cfg.cache:
            logger.debug("  Cache hit for BFSNr %s (%s)", bfsnr, cfg.layer_id)
            frames.append(cfg.cache[cache_key])
            continue

        hull = group.union_all().convex_hull
        bounds = hull.bounds
        logger.debug("  Fetching %s for BFSNr %s (polygon, bbox: %.0f,%.0f,%.0f,%.0f)",
                      cfg.layer_id, bfsnr, *bounds)
        gdf = fetch_features_for_polygon(hull, cfg)
        cfg.cache[cache_key] = gdf
        frames.append(gdf)
        time.sleep(API_PAUSE)

    if not frames:
        return _empty_gdf(cfg)

    all_gdf = pd.concat(frames, ignore_index=True)
    all_gdf = GeoDataFrame(all_gdf, geometry="geometry", crs=CRS_STRING)
    all_gdf = all_gdf.drop_duplicates(subset=cfg.id_column).reset_index(drop=True)
    return all_gdf


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

        # Ensure candidate geometries are valid, then intersect
        valid_candidates = shapely.make_valid(candidates.geometry.values)
        clipped = shapely.intersection(valid_candidates, feature_geom)
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
