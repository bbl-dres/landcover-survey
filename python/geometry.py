"""Geometry cleanup pipeline — shared by parcel and land cover processing."""

from __future__ import annotations

import logging

import pandas as pd
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
    Only multi-part geometries are exploded/dissolved; single-part rows pass through.
    """
    if gdf.empty:
        return gdf

    non_geom_cols = [c for c in gdf.columns if c != gdf.geometry.name and c != group_col]
    agg = {c: "first" for c in non_geom_cols}

    # Identify groups that need dissolving: any group with >1 row or multi-part geoms
    counts = gdf.groupby(group_col).size()
    geom_types = gdf.geometry.geom_type
    multi_mask = geom_types.isin(["MultiPolygon", "MultiLineString", "GeometryCollection"])
    groups_with_multi = set(gdf.loc[multi_mask, group_col])
    groups_with_dups = set(counts[counts > 1].index)
    groups_to_dissolve = groups_with_multi | groups_with_dups

    if groups_to_dissolve:
        needs_dissolve = gdf[gdf[group_col].isin(groups_to_dissolve)]
        passthrough = gdf[~gdf[group_col].isin(groups_to_dissolve)].copy()

        dissolved = needs_dissolve.explode(index_parts=False)
        dissolved = dissolved.dissolve(by=group_col, aggfunc=agg).reset_index()

        result = pd.concat([passthrough, dissolved], ignore_index=True)
        result = GeoDataFrame(result, geometry=gdf.geometry.name, crs=gdf.crs)
    else:
        result = gdf.copy()

    # Repair invalid geometries (vectorised via shapely 2.0)
    result.geometry = shapely.make_valid(result.geometry.values)

    # Drop any results that ended up empty after repair
    result = result[~result.geometry.is_empty].copy()

    return result


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

    Uses vectorised shapely 2.0 type checks; only falls back to row-by-row
    extraction for GeometryCollections.
    """
    if gdf.empty:
        return gdf

    gdf = gdf.copy()

    # Vectorised type check via shapely 2.0
    # type_id: 3=Polygon, 6=MultiPolygon, 7=GeometryCollection
    type_ids = shapely.get_type_id(gdf.geometry.values)
    is_poly = (type_ids == 3) | (type_ids == 6)
    is_gc = type_ids == 7

    # For GeometryCollections, extract polygon parts row-by-row
    if is_gc.any():
        gc_idx = gdf.index[is_gc]
        gdf.loc[gc_idx, gdf.geometry.name] = gdf.loc[gc_idx].geometry.apply(_extract_polygons)
        # Re-check: successfully extracted polygons are now valid
        extracted_valid = gdf.loc[gc_idx].geometry.notna() & ~gdf.loc[gc_idx].geometry.is_empty
        is_poly = is_poly | (is_gc & extracted_valid.reindex(gdf.index, fill_value=False))

    gdf = gdf[is_poly]

    # Drop slivers
    gdf = gdf[gdf.geometry.area >= threshold]

    return gdf.reset_index(drop=True)
