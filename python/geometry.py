"""Geometry cleanup pipeline — shared by parcel and land cover processing."""

from __future__ import annotations

import logging

import shapely
from geopandas import GeoDataFrame
from shapely.geometry import MultiPolygon, Polygon
from shapely.geometry.base import BaseGeometry

from config import SLIVER_THRESHOLD

logger = logging.getLogger(__name__)


def clean_geometries(gdf: GeoDataFrame, group_col: str) -> GeoDataFrame:
    """Deaggregate multi-part → dissolve by *group_col* → ``make_valid()``.

    Returns a GeoDataFrame with one clean polygon per unique *group_col* value.
    Non-geometry columns are preserved (first value per group for non-agg cols).
    """
    if gdf.empty:
        return gdf

    # 1. Deaggregate: explode multi-part geometries into single parts
    exploded = gdf.explode(index_parts=False)

    # 2. Dissolve by group_col → merge parts into single polygon per group
    non_geom_cols = [c for c in gdf.columns if c != gdf.geometry.name and c != group_col]
    agg = {c: "first" for c in non_geom_cols}
    dissolved = exploded.dissolve(by=group_col, aggfunc=agg).reset_index()

    # 3. Repair invalid geometries
    dissolved.geometry = shapely.make_valid(dissolved.geometry.values)

    # Drop any results that ended up empty after repair
    dissolved = dissolved[~dissolved.geometry.is_empty].copy()

    return dissolved


def _extract_polygons(geom: BaseGeometry) -> BaseGeometry | None:
    """Extract only Polygon/MultiPolygon parts from a geometry.

    Handles GeometryCollections that result from clip operations
    (which may contain LineStrings or Points from shared boundaries).
    """
    if geom is None or geom.is_empty:
        return None

    if isinstance(geom, (Polygon, MultiPolygon)):
        return geom

    # GeometryCollection — extract polygon parts
    polys = [g for g in geom.geoms if isinstance(g, (Polygon, MultiPolygon))]
    if not polys:
        return None
    if len(polys) == 1:
        return polys[0]
    # Flatten any MultiPolygons within the list
    flat = []
    for p in polys:
        if isinstance(p, MultiPolygon):
            flat.extend(p.geoms)
        else:
            flat.append(p)
    return MultiPolygon(flat)


def filter_clip_results(
    gdf: GeoDataFrame,
    threshold: float = SLIVER_THRESHOLD,
) -> GeoDataFrame:
    """Drop non-polygon geometries and slivers below *threshold* (m²).

    After clipping, shared boundaries can produce LineStrings, Points,
    or GeometryCollections.  This function:
    1. Extracts only Polygon/MultiPolygon parts.
    2. Drops features with area < *threshold*.
    """
    if gdf.empty:
        return gdf

    # Extract polygon parts only
    gdf = gdf.copy()
    gdf.geometry = gdf.geometry.apply(_extract_polygons)

    # Drop rows where no polygon was extracted
    gdf = gdf.dropna(subset=[gdf.geometry.name])
    gdf = gdf[~gdf.geometry.is_empty]

    # Drop slivers
    gdf = gdf[gdf.geometry.area >= threshold]

    return gdf.reset_index(drop=True)
