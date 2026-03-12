"""Main processing orchestration."""

from __future__ import annotations

import logging
import time
from pathlib import Path

import geopandas as _gpd
import pandas as pd
from geopandas import GeoDataFrame
from pandas import DataFrame

from config import (
    COL_FLAECHE,
    DEFAULT_GREEN_SPACE,
    GREEN_SPACE,
    MSG_EGRID_FOUND,
    MSG_EGRID_MERGED,
    MSG_EGRID_NOT_FOUND,
)
from geometry import clean_geometries, filter_clip_results
from data_io import (
    get_bfsnr_list,
    read_landcover,
    read_parcels,
    read_user_input,
    write_excel,
)

logger = logging.getLogger(__name__)


def _fmt_eta(elapsed: float, done: int, total: int) -> str:
    """Format an ETA string from elapsed time and progress."""
    if done == 0:
        return "ETA: --:--"
    remaining = elapsed / done * (total - done)
    mins, secs = divmod(int(remaining), 60)
    hours, mins = divmod(mins, 60)
    if hours > 0:
        return f"ETA: {hours}h{mins:02d}m"
    return f"ETA: {mins}m{secs:02d}s"


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def run(
    mode: int,
    input_path: str | None,
    gpkg_path: str,
    output_dir: str,
    limit: int | None = None,
) -> None:
    """Run the landcover survey pipeline.

    Parameters
    ----------
    mode : int
        1 = user-provided parcel list, 2 = all parcels from GeoPackage.
    input_path : str | None
        Path to CSV/Excel (Mode 1 only).
    gpkg_path : str
        Path to the AV GeoPackage.
    output_dir : str
        Directory for output Excel files.
    limit : int | None
        Limit processing for testing. Mode 1: first N rows. Mode 2: first N municipalities.
    """
    t0 = time.time()
    output_dir = Path(output_dir)

    # Step 1 — Load parcel identifiers
    user_df = _load_parcel_identifiers(mode, input_path, limit)

    if mode == 1:
        parcels_out, lc_out = _run_mode1(user_df, gpkg_path)
    else:
        parcels_out, lc_out = _run_mode2(gpkg_path, limit)

    # Export
    logger.info("Step 9/9 — Exporting results")
    write_excel(parcels_out, output_dir / "parcels.xlsx")
    write_excel(lc_out, output_dir / "landcover.xlsx")

    elapsed = time.time() - t0
    mins, secs = divmod(int(elapsed), 60)
    logger.info(
        "Done in %dm%02ds — %d parcels, %d land cover rows → %s",
        mins, secs, len(parcels_out), len(lc_out), output_dir,
    )


# ---------------------------------------------------------------------------
# Mode dispatchers
# ---------------------------------------------------------------------------

def _run_mode1(
    user_df: DataFrame,
    gpkg_path: str,
) -> tuple[DataFrame, DataFrame]:
    """Mode 1: process user-provided EGRID list."""
    egrids = user_df["EGRID"].dropna().unique().tolist()
    logger.info("Step 1/9 — Loaded %d unique EGRIDs from user input", len(egrids))

    # Step 2 — Look up parcel geometries
    logger.info("Step 2/9 — Looking up parcel geometries in AV data")
    parcels_gdf = _lookup_parcel_geometries(egrids, gpkg_path)

    # Step 3 — Clean & calculate parcel area
    logger.info("Step 3/9 — Cleaning parcel geometries & calculating area")
    parcels_gdf = _process_parcels(parcels_gdf)

    # Left-join user data onto parcel results (preserve all user rows)
    parcels_out = _merge_user_parcels(user_df, parcels_gdf)

    # Steps 4-8 — Land cover processing
    found = parcels_gdf[parcels_gdf.geometry.notna() & ~parcels_gdf.geometry.is_empty]
    if found.empty:
        logger.warning("No parcel geometries found — skipping land cover processing")
        lc_out = _empty_landcover_df()
    else:
        lc_out = _process_landcover(found, gpkg_path)

    return parcels_out, lc_out


def _run_mode2(gpkg_path: str, limit: int | None = None) -> tuple[DataFrame, DataFrame]:
    """Mode 2: process all parcels, batched by BFSNr."""
    bfsnr_list = get_bfsnr_list(gpkg_path)
    if limit is not None:
        bfsnr_list = bfsnr_list[:limit]
        logger.info("Mode 2: processing %d municipalities (limited from full set)", len(bfsnr_list))
    else:
        logger.info("Mode 2: processing %d municipalities", len(bfsnr_list))

    all_parcels: list[DataFrame] = []
    all_lc: list[DataFrame] = []
    t0 = time.time()

    for i, bfsnr in enumerate(bfsnr_list, 1):
        eta = _fmt_eta(time.time() - t0, i - 1, len(bfsnr_list))
        logger.info("Processing BFSNr %d (%d/%d) — %s", bfsnr, i, len(bfsnr_list), eta)

        parcels_gdf = read_parcels(gpkg_path, bfsnr=bfsnr)
        if parcels_gdf.empty:
            continue

        # Generate ID and EGRID columns for Mode 2
        parcels_gdf["EGRID"] = parcels_gdf["EGRIS_EGRID"]
        parcels_gdf["ID"] = parcels_gdf["EGRIS_EGRID"]

        # Handle duplicate EGRIDs within this municipality
        parcels_gdf = _dissolve_duplicate_egrids(parcels_gdf)

        # Clean & calculate area
        parcels_gdf = _process_parcels(parcels_gdf)

        # Build parcels output
        parcels_out = _build_parcels_output(parcels_gdf)
        all_parcels.append(parcels_out)

        # Land cover
        found = parcels_gdf[
            parcels_gdf.geometry.notna() & ~parcels_gdf.geometry.is_empty
        ]
        if not found.empty:
            lc = _process_landcover(found, gpkg_path)
            all_lc.append(lc)

    parcels_result = pd.concat(all_parcels, ignore_index=True) if all_parcels else _empty_parcels_df()
    lc_result = pd.concat(all_lc, ignore_index=True) if all_lc else _empty_landcover_df()

    return parcels_result, lc_result


# ---------------------------------------------------------------------------
# Step 1 — Load parcel identifiers
# ---------------------------------------------------------------------------

def _load_parcel_identifiers(
    mode: int,
    input_path: str | None,
    limit: int | None = None,
) -> DataFrame | None:
    """Load EGRID list from user file (Mode 1) or return None (Mode 2)."""
    if mode == 1:
        if input_path is None:
            raise ValueError("Mode 1 requires --input path to a CSV or Excel file.")
        df = read_user_input(input_path)
        if limit is not None:
            logger.info("Limiting to first %d rows (of %d)", limit, len(df))
            df = df.head(limit)
        return df
    return None


# ---------------------------------------------------------------------------
# Step 2 — Look up parcel geometries & handle duplicates
# ---------------------------------------------------------------------------

def _lookup_parcel_geometries(
    egrids: list[str],
    gpkg_path: str,
) -> GeoDataFrame:
    """Query resf by EGRID, dissolve duplicates, set Check_EGRID."""
    raw = read_parcels(gpkg_path, egrids=egrids)
    return _dissolve_duplicate_egrids(raw)


def _dissolve_duplicate_egrids(gdf: GeoDataFrame) -> GeoDataFrame:
    """Dissolve multiple fid entries per EGRIS_EGRID into one row.

    Sets ``Check_EGRID`` with the appropriate status message.
    """
    if gdf.empty:
        gdf["Check_EGRID"] = pd.Series(dtype=str)
        return gdf

    counts = gdf.groupby("EGRIS_EGRID").size()

    # For EGRIDs with a single entry, keep as-is
    single_egrids = counts[counts == 1].index
    singles = gdf[gdf["EGRIS_EGRID"].isin(single_egrids)].copy()
    singles["Check_EGRID"] = MSG_EGRID_FOUND

    # For EGRIDs with multiple entries, dissolve geometries
    multi_egrids = counts[counts > 1].index
    if len(multi_egrids) == 0:
        return singles

    logger.warning(
        "%d EGRIDs have multiple entries — dissolving: %s",
        len(multi_egrids),
        list(multi_egrids[:5]),
    )

    multis = gdf[gdf["EGRIS_EGRID"].isin(multi_egrids)].copy()
    non_geom = [c for c in gdf.columns if c != gdf.geometry.name and c != "EGRIS_EGRID"]
    agg = {c: "first" for c in non_geom}
    dissolved = multis.dissolve(by="EGRIS_EGRID", aggfunc=agg).reset_index()

    dissolved["Check_EGRID"] = dissolved["EGRIS_EGRID"].map(
        lambda e: MSG_EGRID_MERGED.format(n=counts[e])
    )

    result = pd.concat([singles, dissolved], ignore_index=True)
    result = GeoDataFrame(result, geometry=gdf.geometry.name, crs=gdf.crs)
    return result


# ---------------------------------------------------------------------------
# Step 3 — Clean parcel geometries & calculate area
# ---------------------------------------------------------------------------

def _process_parcels(parcels_gdf: GeoDataFrame) -> GeoDataFrame:
    """Clean geometries and calculate ``parcel_area_m2``."""
    if parcels_gdf.empty:
        parcels_gdf["parcel_area_m2"] = pd.Series(dtype=float)
        return parcels_gdf

    parcels_gdf = clean_geometries(parcels_gdf, group_col="EGRIS_EGRID")
    parcels_gdf["parcel_area_m2"] = parcels_gdf.geometry.area
    return parcels_gdf


# ---------------------------------------------------------------------------
# Steps 4–8 — Land cover processing
# ---------------------------------------------------------------------------

def _process_landcover(
    parcels_gdf: GeoDataFrame,
    gpkg_path: str,
) -> DataFrame:
    """Read LC, clean, clip by parcels, calc area, classify green space."""
    # Step 4 — Read land cover with bbox pre-filter
    logger.info("Step 4/9 — Reading land cover (bbox pre-filter)")
    bbox = tuple(parcels_gdf.total_bounds)
    lcsf = read_landcover(gpkg_path, bbox=bbox)

    if lcsf.empty:
        return _empty_landcover_df()

    # Step 5 — Clean land cover geometries
    logger.info("Step 5/9 — Cleaning %d land cover geometries", len(lcsf))
    lcsf = clean_geometries(lcsf, group_col="fid")

    # Prepare parcel GDF for overlay (only need ID, EGRID, geometry)
    parcel_cols = ["EGRIS_EGRID", "geometry"]
    if "ID" in parcels_gdf.columns:
        parcel_cols.insert(0, "ID")
    if "EGRID" in parcels_gdf.columns:
        parcel_cols.insert(1, "EGRID")
    parcels_for_overlay = parcels_gdf[parcel_cols].copy()

    # Step 6 — Clip land cover by parcels
    logger.info("Step 6/9 — Clipping land cover by %d parcels (overlay)", len(parcels_for_overlay))
    result = _gpd.overlay(lcsf, parcels_for_overlay, how="intersection")

    if result.empty:
        return _empty_landcover_df()

    result = GeoDataFrame(result, geometry=result.geometry.name, crs=lcsf.crs)

    # Filter out non-polygon results and slivers
    n_before = len(result)
    result = filter_clip_results(result)
    n_dropped = n_before - len(result)
    if n_dropped > 0:
        logger.debug("Dropped %d non-polygon/sliver results after clip", n_dropped)

    if result.empty:
        return _empty_landcover_df()

    # Inherit parcel identifiers if not already present from overlay
    if "EGRID" not in result.columns and "EGRIS_EGRID" in result.columns:
        result["EGRID"] = result["EGRIS_EGRID"]
    if "ID" not in result.columns:
        result["ID"] = result.get("EGRID", result.get("EGRIS_EGRID", ""))

    # Step 7 — Calculate clipped area
    logger.info("Step 7/9 — Calculating area for %d clipped features", len(result))
    result["area_m2"] = result.geometry.area

    # Step 8 — Classify green space
    logger.info("Step 8/9 — Classifying green space")
    result["Check_Gruenflaeche"] = result["Art"].map(GREEN_SPACE).fillna(DEFAULT_GREEN_SPACE)

    # Build output (drop geometry)
    output_cols = ["ID", "EGRID", "fid", "Art", "BFSNr", "GWR_EGID", "Check_Gruenflaeche", "area_m2"]
    output_cols = [c for c in output_cols if c in result.columns]
    return result[output_cols].reset_index(drop=True)


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

def _merge_user_parcels(
    user_df: DataFrame,
    parcels_gdf: GeoDataFrame,
) -> DataFrame:
    """Left-join user rows onto AV parcel data.  Unfound EGRIDs get error msg."""
    if parcels_gdf.empty:
        av_cols = pd.DataFrame({
            "EGRID": pd.Series(dtype=str),
            "Nummer": pd.Series(dtype=str),
            "BFSNr": pd.Series(dtype="Int64"),
            "Check_EGRID": pd.Series(dtype=str),
            COL_FLAECHE: pd.Series(dtype="Int64"),
            "parcel_area_m2": pd.Series(dtype=float),
        })
    else:
        av_select = ["EGRIS_EGRID", "Check_EGRID", "parcel_area_m2"]
        for col in ("Nummer", "BFSNr", COL_FLAECHE):
            if col in parcels_gdf.columns:
                av_select.append(col)
        av_cols = parcels_gdf[av_select].copy()
        av_cols = av_cols.rename(columns={"EGRIS_EGRID": "EGRID"})

    merged = user_df.merge(av_cols, on="EGRID", how="left")
    merged["Check_EGRID"] = merged["Check_EGRID"].fillna(MSG_EGRID_NOT_FOUND)

    # Reorder: ID, EGRID, Nummer, BFSNr, Check_EGRID, Flaeche, parcel_area_m2, then user cols
    priority = ["ID", "EGRID", "Nummer", "BFSNr", "Check_EGRID", COL_FLAECHE, "parcel_area_m2"]
    priority = [c for c in priority if c in merged.columns]
    other_cols = [c for c in merged.columns if c not in priority]
    merged = merged[priority + other_cols]

    return merged


def _build_parcels_output(parcels_gdf: GeoDataFrame) -> DataFrame:
    """Build the parcels output table for Mode 2."""
    cols = ["ID", "EGRID", "Nummer", "BFSNr", "Check_EGRID", COL_FLAECHE, "parcel_area_m2"]
    out = parcels_gdf.copy()

    if "EGRID" not in out.columns:
        out["EGRID"] = out["EGRIS_EGRID"]
    if "ID" not in out.columns:
        out["ID"] = out["EGRIS_EGRID"]

    available = [c for c in cols if c in out.columns]
    return out[available].reset_index(drop=True)


def _empty_parcels_df() -> DataFrame:
    return DataFrame(columns=["ID", "EGRID", "Nummer", "BFSNr", "Check_EGRID",
                               COL_FLAECHE, "parcel_area_m2"])


def _empty_landcover_df() -> DataFrame:
    return DataFrame(columns=["ID", "EGRID", "fid", "Art", "BFSNr",
                               "GWR_EGID", "Check_Gruenflaeche", "area_m2"])
