"""Read/write CSV, Excel, and GeoPackage layers."""

from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

import geopandas as gpd
import pandas as pd
from geopandas import GeoDataFrame
from pandas import DataFrame

from config import (
    CRS_EPSG,
    LAYER_LANDCOVER,
    LAYER_PARCELS,
    SQL_BATCH_SIZE,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# User input
# ---------------------------------------------------------------------------

def read_user_input(path: str | Path) -> DataFrame:
    """Read a CSV or Excel file.  Validate that ``ID`` and ``EGRID`` columns exist."""
    path = Path(path)
    suffix = path.suffix.lower()
    if suffix == ".csv":
        df = pd.read_csv(path, dtype=str)
    elif suffix in (".xlsx", ".xls"):
        df = pd.read_excel(path, dtype=str)
    else:
        raise ValueError(f"Unsupported file format: {suffix}  (expected .csv or .xlsx)")

    missing = {"ID", "EGRID"} - set(df.columns)
    if missing:
        raise ValueError(f"Input file is missing required columns: {missing}")

    logger.info("Read %d rows from %s", len(df), path.name)
    return df


# ---------------------------------------------------------------------------
# GeoPackage readers
# ---------------------------------------------------------------------------

def _validate_crs(gdf: GeoDataFrame, layer: str) -> None:
    """Raise if the CRS is not EPSG:2056."""
    if gdf.crs is None:
        raise ValueError(f"Layer '{layer}' has no CRS defined.")
    if gdf.crs.to_epsg() != CRS_EPSG:
        raise ValueError(
            f"Layer '{layer}' CRS is {gdf.crs} — expected EPSG:{CRS_EPSG} (CH1903+ / LV95)."
        )


def _read_gpkg(gpkg_path: str, layer: str, **kwargs) -> GeoDataFrame:
    """Read a GeoPackage layer and expose the ``fid`` as a regular column."""
    gdf = gpd.read_file(gpkg_path, layer=layer, **kwargs)
    # fid lives in the GeoPackage but geopandas doesn't load it as a column.
    # Re-read with fid_as_index to get the fid values.
    if "fid" not in gdf.columns and not gdf.empty:
        gdf_fid = gpd.read_file(gpkg_path, layer=layer, fid_as_index=True, **kwargs)
        gdf["fid"] = gdf_fid.index.values
    return gdf


def read_parcels(
    gpkg_path: str | Path,
    egrids: list[str] | None = None,
    bfsnr: int | None = None,
) -> GeoDataFrame:
    """Read the ``resf`` layer from *gpkg_path*.

    Parameters
    ----------
    egrids : list[str] | None
        If provided, filter by ``EGRIS_EGRID`` using SQL WHERE (batched).
    bfsnr : int | None
        If provided, filter by ``BFSNr`` (used for Mode 2 batching).
    """
    gpkg_path = str(gpkg_path)

    if egrids is not None:
        # Batch the SQL IN clause to avoid very long queries
        frames: list[GeoDataFrame] = []
        for i in range(0, len(egrids), SQL_BATCH_SIZE):
            batch = egrids[i : i + SQL_BATCH_SIZE]
            values = ", ".join(f"'{e}'" for e in batch)
            where = f"EGRIS_EGRID IN ({values})"
            gdf = _read_gpkg(gpkg_path, layer=LAYER_PARCELS, where=where)
            frames.append(gdf)
        if frames:
            crs = frames[0].crs
            geom_col = frames[0].geometry.name
            gdf = pd.concat(frames, ignore_index=True)
            gdf = GeoDataFrame(gdf, geometry=geom_col, crs=crs)
        else:
            gdf = gpd.read_file(gpkg_path, layer=LAYER_PARCELS, rows=0)
    elif bfsnr is not None:
        where = f"BFSNr = {bfsnr}"
        gdf = _read_gpkg(gpkg_path, layer=LAYER_PARCELS, where=where)
    else:
        gdf = _read_gpkg(gpkg_path, layer=LAYER_PARCELS)

    _validate_crs(gdf, LAYER_PARCELS)
    logger.info("Read %d parcels from %s", len(gdf), LAYER_PARCELS)
    return gdf


def read_landcover(
    gpkg_path: str | Path,
    bbox: tuple[float, float, float, float] | None = None,
) -> GeoDataFrame:
    """Read the ``lcsf`` layer with an optional bounding-box pre-filter."""
    gpkg_path = str(gpkg_path)

    if bbox is not None:
        gdf = _read_gpkg(gpkg_path, layer=LAYER_LANDCOVER, bbox=bbox)
    else:
        gdf = _read_gpkg(gpkg_path, layer=LAYER_LANDCOVER)

    _validate_crs(gdf, LAYER_LANDCOVER)
    logger.info("Read %d land cover features from %s", len(gdf), LAYER_LANDCOVER)
    return gdf


def get_bfsnr_list(gpkg_path: str | Path) -> list[int]:
    """Return all distinct BFSNr values from the ``resf`` layer.

    Uses a raw SQL query to avoid loading full geometries.
    """
    gpkg_path = str(gpkg_path)
    with sqlite3.connect(gpkg_path) as conn:
        rows = conn.execute(
            f"SELECT DISTINCT BFSNr FROM {LAYER_PARCELS} ORDER BY BFSNr"
        ).fetchall()
    return [r[0] for r in rows if r[0] is not None]


# ---------------------------------------------------------------------------
# Output writers
# ---------------------------------------------------------------------------

def write_excel(df: DataFrame, path: str | Path) -> None:
    """Write *df* to an Excel ``.xlsx`` file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_excel(path, index=False, engine="openpyxl")
    logger.info("Wrote %d rows to %s", len(df), path.name)
