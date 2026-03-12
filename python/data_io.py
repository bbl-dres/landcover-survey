"""Read/write CSV, Excel, and GeoPackage layers."""

from __future__ import annotations

import logging
import sqlite3
from functools import lru_cache
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
    gdf = gpd.read_file(gpkg_path, layer=layer, fid_as_index=True, **kwargs)
    if "fid" not in gdf.columns:
        gdf["fid"] = gdf.index
    gdf = gdf.reset_index(drop=True)
    return gdf


@lru_cache(maxsize=None)
def get_rtree_table(gpkg_path: str, layer: str) -> str | None:
    """Return the R-tree spatial index table name, or None if not available."""
    with sqlite3.connect(gpkg_path) as conn:
        row = conn.execute(
            "SELECT column_name FROM gpkg_geometry_columns WHERE table_name = ?",
            (layer,),
        ).fetchone()
        if row is None:
            return None
        rtree_table = f"rtree_{layer}_{row[0]}"
        exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            (rtree_table,),
        ).fetchone()
        return rtree_table if exists else None


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
    """Read the ``lcsf`` layer with an optional bounding-box pre-filter.

    When *bbox* is given and a GeoPackage R-tree spatial index exists,
    uses a direct SQL query against the index (like FME ENVELOPE_INTERSECTS).
    Falls back to geopandas bbox filtering otherwise.
    """
    gpkg_path = str(gpkg_path)

    if bbox is not None:
        rtree = get_rtree_table(gpkg_path, LAYER_LANDCOVER)
        if rtree is not None:
            minx, miny, maxx, maxy = bbox
            sql = (
                f'SELECT * FROM "{LAYER_LANDCOVER}" '
                f"WHERE fid IN ("
                f'SELECT id FROM "{rtree}" '
                f"WHERE minx <= {maxx} AND maxx >= {minx} "
                f"AND miny <= {maxy} AND maxy >= {miny})"
            )
            gdf = gpd.read_file(gpkg_path, sql=sql)
            # Ensure fid is exposed as a column
            if "fid" not in gdf.columns:
                if hasattr(gdf.index, "name") and gdf.index.name == "fid":
                    gdf["fid"] = gdf.index
                    gdf = gdf.reset_index(drop=True)
        else:
            logger.debug("No R-tree index found — falling back to bbox filter")
            gdf = _read_gpkg(gpkg_path, layer=LAYER_LANDCOVER, bbox=bbox)
            logger.info("Read %d land cover features from %s", len(gdf), LAYER_LANDCOVER)
    else:
        gdf = _read_gpkg(gpkg_path, layer=LAYER_LANDCOVER)
        logger.info("Read %d land cover features from %s", len(gdf), LAYER_LANDCOVER)

    if not gdf.empty:
        _validate_crs(gdf, LAYER_LANDCOVER)
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

def write_csv(df: DataFrame, path: str | Path) -> None:
    """Write *df* to a CSV file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False)
    logger.info("Wrote %d rows to %s", len(df), path.name)
