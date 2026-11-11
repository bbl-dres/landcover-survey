"""Read/write CSV, Excel, and GeoPackage layers."""

from __future__ import annotations

import logging
import re
import sqlite3
from contextlib import closing
from functools import lru_cache
from pathlib import Path

import geopandas as gpd
import pandas as pd
from geopandas import GeoDataFrame
from pandas import DataFrame

from config import (
    CRS_EPSG,
    EGRID_BATCH_SIZE,
    LAYER_LANDCOVER,
    LAYER_PARCELS,
)

# Compiled once — validates Swiss EGRID format (e.g. CH123456789012). Used with
# ``fullmatch`` (``match`` + ``$`` would accept a trailing newline); this is the
# guard that keeps the string-built ``IN (…)`` list below free of quotes.
_EGRID_RE = re.compile(r"CH[0-9A-Za-z]+")

logger = logging.getLogger(__name__)


def is_valid_egrid(egrid) -> bool:
    """True for a text that looks like an EGRID (``CH`` + letters / digits only)."""
    return isinstance(egrid, str) and _EGRID_RE.fullmatch(egrid) is not None


# ---------------------------------------------------------------------------
# User input
# ---------------------------------------------------------------------------

def read_user_input(path: str | Path) -> DataFrame:
    """Read a CSV/Excel parcel list via the shared reader (:mod:`user_input`) —
    the same contract as the web upload and the api path: delimiter
    auto-detection + ``sep=`` hint, UTF-8 BOM, case-insensitive required
    ``id``/``egrid`` columns. Returns a DataFrame with canonical ``ID``/``EGRID``
    columns; every other column keeps its lowercased id (so the ``input_<col>``
    output columns match the web's)."""
    from user_input import read_dataframe

    path = Path(path)
    df = read_dataframe(path)
    logger.info("Read %d rows from %s", len(df), path.name)
    return df


# ---------------------------------------------------------------------------
# GeoPackage: SQLite access (always read-only)
# ---------------------------------------------------------------------------

def connect_readonly(gpkg_path: str | Path) -> sqlite3.Connection:
    """Open the GeoPackage with SQLite, read-only. The caller closes it.

    ``sqlite3.connect(path)`` creates a missing file, which turned a mistyped
    path into an empty ``.gpkg`` and a misleading "no such table" error — so the
    file must exist, and it is opened with ``mode=ro``.
    """
    path = Path(gpkg_path)
    if not path.is_file():
        raise FileNotFoundError(f"GeoPackage not found: {path}")
    try:
        conn = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
        conn.execute("SELECT 1 FROM sqlite_master LIMIT 1")  # forces the open
        return conn
    except sqlite3.Error:
        # A path SQLite's URI parser does not take (e.g. a UNC share). The file
        # exists, so a plain connect cannot create one; we only ever read.
        return sqlite3.connect(str(path))


def list_layers(gpkg_path: str | Path) -> list[str]:
    """Names of the feature tables in the GeoPackage."""
    with closing(connect_readonly(gpkg_path)) as conn:
        try:
            rows = conn.execute("SELECT table_name FROM gpkg_contents").fetchall()
        except sqlite3.DatabaseError as e:
            raise ValueError(f"{gpkg_path} is not a readable GeoPackage ({e}).") from e
    return [r[0] for r in rows]


def layer_exists(gpkg_path: str | Path, layer: str) -> bool:
    return layer in list_layers(gpkg_path)


def validate_gpkg(gpkg_path: str | Path) -> None:
    """Fail early and clearly: ``FileNotFoundError`` when the file is missing,
    ``ValueError`` when it is not a GeoPackage or lacks the two layers we read."""
    layers = list_layers(gpkg_path)
    missing = [name for name in (LAYER_PARCELS, LAYER_LANDCOVER) if name not in layers]
    if missing:
        raise ValueError(
            f"GeoPackage {gpkg_path} has no layer {', '.join(missing)} "
            f"(found: {', '.join(sorted(layers)) or 'none'})."
        )


# ---------------------------------------------------------------------------
# GeoPackage readers
# ---------------------------------------------------------------------------

def ensure_fid_column(gdf: GeoDataFrame) -> GeoDataFrame:
    """Ensure ``fid`` is a regular column (not just the index)."""
    if "fid" not in gdf.columns:
        if hasattr(gdf.index, "name") and gdf.index.name == "fid":
            gdf["fid"] = gdf.index
            gdf = gdf.reset_index(drop=True)
    return gdf


def validate_crs(gdf: GeoDataFrame, layer: str) -> None:
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
    with closing(connect_readonly(gpkg_path)) as conn:
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


def _normalize_egrid_column(gdf: GeoDataFrame) -> GeoDataFrame:
    """Canonical EGRID spelling (trimmed, upper-cased) — the same normalisation the
    input reader applies, so a lower-case EGRID in the AV data still joins. Missing
    values stay missing."""
    if "EGRIS_EGRID" in gdf.columns and len(gdf):
        gdf["EGRIS_EGRID"] = gdf["EGRIS_EGRID"].map(
            lambda v: v.strip().upper() if isinstance(v, str) else v
        )
    return gdf


def read_parcels(
    gpkg_path: str | Path,
    egrids: list[str] | None = None,
    bfsnr: int | None = None,
    *,
    bfsnr_is_null: bool = False,
    layer: str = LAYER_PARCELS,
) -> GeoDataFrame:
    """Read parcels from *layer* (``resf``; ``dprsf`` has the same columns).

    Parameters
    ----------
    egrids : list[str] | None
        If provided, filter by ``EGRIS_EGRID`` using SQL WHERE (batched). The
        match is exact but case-insensitive. Texts that are not an EGRID are
        skipped; with none left the result is empty.
    bfsnr : int | None
        If provided, filter by ``BFSNr`` (used for Mode 2 batching).
    bfsnr_is_null : bool
        Read the parcels without a ``BFSNr`` (the last Mode 2 batch).
    layer : str
        Parcel layer to read.
    """
    gpkg_path = str(gpkg_path)

    if egrids is not None:
        invalid = [e for e in egrids if not is_valid_egrid(e)]
        if invalid:
            logger.warning("Skipping %d invalid EGRIDs: %s", len(invalid), invalid[:5])
            egrids = [e for e in egrids if is_valid_egrid(e)]

        # One scan of the table per batch (no attribute index): large IN lists.
        frames: list[GeoDataFrame] = []
        for i in range(0, len(egrids), EGRID_BATCH_SIZE):
            batch = egrids[i : i + EGRID_BATCH_SIZE]
            values = ", ".join(f"'{e.upper()}'" for e in batch)
            where = f"UPPER(TRIM(EGRIS_EGRID)) IN ({values})"
            gdf = _read_gpkg(gpkg_path, layer=layer, where=where)
            frames.append(gdf)
        if frames:
            crs = frames[0].crs
            geom_col = frames[0].geometry.name
            gdf = pd.concat(frames, ignore_index=True)
            gdf = GeoDataFrame(gdf, geometry=geom_col, crs=crs)
        else:
            # No valid EGRID: an empty frame with the layer's columns. (Not
            # ``rows=0`` — pyogrio reads that as "no limit" and returns the
            # whole table.)
            gdf = _read_gpkg(gpkg_path, layer=layer, where="1=0")
    elif bfsnr_is_null:
        gdf = _read_gpkg(gpkg_path, layer=layer, where="BFSNr IS NULL")
    elif bfsnr is not None:
        where = f"BFSNr = {int(bfsnr)}"
        gdf = _read_gpkg(gpkg_path, layer=layer, where=where)
    else:
        gdf = _read_gpkg(gpkg_path, layer=layer)

    validate_crs(gdf, layer)
    gdf = _normalize_egrid_column(gdf)
    logger.info("Read %d parcels from %s", len(gdf), layer)
    return gdf


def read_landcover(
    gpkg_path: str | Path,
    bbox: tuple[float, float, float, float] | None = None,
) -> GeoDataFrame:
    """Read the ``lcsf`` layer with an optional bounding-box pre-filter (GDAL
    applies it through the layer's spatial index when there is one)."""
    gpkg_path = str(gpkg_path)

    if bbox is not None:
        gdf = _read_gpkg(gpkg_path, layer=LAYER_LANDCOVER, bbox=bbox)
    else:
        gdf = _read_gpkg(gpkg_path, layer=LAYER_LANDCOVER)
        logger.info("Read %d land cover features from %s", len(gdf), LAYER_LANDCOVER)

    if not gdf.empty:
        validate_crs(gdf, LAYER_LANDCOVER)
    return gdf


def get_bfsnr_counts(gpkg_path: str | Path) -> dict[int | None, int]:
    """Number of ``resf`` rows per ``BFSNr`` — the key ``None`` holds the rows
    without one. One scan, no geometries."""
    with closing(connect_readonly(gpkg_path)) as conn:
        rows = conn.execute(
            f'SELECT BFSNr, COUNT(*) FROM "{LAYER_PARCELS}" GROUP BY BFSNr'
        ).fetchall()
    return {r[0]: r[1] for r in rows}


def get_bfsnr_list(gpkg_path: str | Path) -> list[int]:
    """Return all distinct (non-null) BFSNr values from the ``resf`` layer, sorted."""
    return sorted(k for k in get_bfsnr_counts(gpkg_path) if k is not None)


def get_cross_batch_egrids(gpkg_path: str | Path) -> set[str]:
    """EGRIDs whose ``resf`` rows sit in more than one Mode 2 batch (several
    ``BFSNr``, or one with and one without). Mode 2 dissolves these across the
    batches, as Mode 1 does, instead of reporting each part with the land cover
    of all parts."""
    with closing(connect_readonly(gpkg_path)) as conn:
        rows = conn.execute(
            f'SELECT UPPER(TRIM(EGRIS_EGRID)) AS e FROM "{LAYER_PARCELS}" '
            "WHERE EGRIS_EGRID IS NOT NULL AND TRIM(EGRIS_EGRID) <> '' "
            "GROUP BY e HAVING COUNT(DISTINCT IFNULL(BFSNr, -1)) > 1"
        ).fetchall()
    return {r[0] for r in rows}


# ---------------------------------------------------------------------------
# Output writers
# ---------------------------------------------------------------------------

def write_csv(df: DataFrame, path: str | Path) -> None:
    """Write *df* to a CSV file — semicolon-delimited, UTF-8 with BOM, the same
    dialect the web app and the ``api`` source export (opens correctly in a Swiss /
    German-locale Excel without an import wizard)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(path, index=False, sep=";", encoding="utf-8-sig")
    logger.info("Wrote %d rows to %s", len(df), path.name)
