"""Bauzonen (building zones) layer — fetch, cache, intersect.

Thin wrapper around :mod:`swisstopo` configured for ``ch.are.bauzonen``.
"""

from __future__ import annotations

from geopandas import GeoDataFrame
from pandas import DataFrame

from swisstopo import LayerConfig, fetch_features_cached, fetch_features_for_bbox, intersect_with_features

# ---------------------------------------------------------------------------
# Layer configuration
# ---------------------------------------------------------------------------

BAUZONEN_CONFIG = LayerConfig(
    layer_id="ch.are.bauzonen",
    column_map={
        "ch_bez_d": "bz_bezeichnung",
        "ch_code_hn": "bz_nutzung",
    },
    id_column="bz_id",
)


# ---------------------------------------------------------------------------
# Convenience wrappers (keep existing call sites working)
# ---------------------------------------------------------------------------

def fetch_bauzonen_for_bbox(bbox: tuple[float, float, float, float]) -> GeoDataFrame:
    return fetch_features_for_bbox(bbox, BAUZONEN_CONFIG)


def fetch_bauzonen_cached(parcels_gdf: GeoDataFrame) -> GeoDataFrame:
    return fetch_features_cached(parcels_gdf, BAUZONEN_CONFIG)


def intersect_with_bauzonen(
    geom_gdf: GeoDataFrame,
    bauzonen_gdf: GeoDataFrame,
    id_cols: list[str],
) -> DataFrame:
    return intersect_with_features(geom_gdf, bauzonen_gdf, BAUZONEN_CONFIG, id_cols)


def clear_cache() -> None:
    BAUZONEN_CONFIG.clear_cache()
