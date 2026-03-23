"""Lebensraumkarte (habitat map) layer — fetch, cache, intersect.

Thin wrapper around :mod:`swisstopo` configured for
``ch.bafu.lebensraumkarte-schweiz``.
"""

from __future__ import annotations

from geopandas import GeoDataFrame
from pandas import DataFrame

from swisstopo import LayerConfig, fetch_features_cached, fetch_features_for_bbox, intersect_with_features

# ---------------------------------------------------------------------------
# Layer configuration
# ---------------------------------------------------------------------------

HABITAT_CONFIG = LayerConfig(
    layer_id="ch.bafu.lebensraumkarte-schweiz",
    column_map={
        "typoch_de": "habitat_typ",
        "prob_de": "habitat_wahrscheinlichkeit",
    },
    id_column="habitat_id",
)


# ---------------------------------------------------------------------------
# Convenience wrappers
# ---------------------------------------------------------------------------

def fetch_habitat_for_bbox(bbox: tuple[float, float, float, float]) -> GeoDataFrame:
    return fetch_features_for_bbox(bbox, HABITAT_CONFIG)


def fetch_habitat_cached(parcels_gdf: GeoDataFrame) -> GeoDataFrame:
    return fetch_features_cached(parcels_gdf, HABITAT_CONFIG)


def intersect_with_habitat(
    geom_gdf: GeoDataFrame,
    habitat_gdf: GeoDataFrame,
    id_cols: list[str],
) -> DataFrame:
    return intersect_with_features(geom_gdf, habitat_gdf, HABITAT_CONFIG, id_cols)


def clear_cache() -> None:
    HABITAT_CONFIG.clear_cache()
