"""Main processing orchestration."""

from __future__ import annotations

import logging
import sqlite3
import time
from datetime import datetime
from pathlib import Path

import geopandas as gpd
import pandas as pd
import shapely
from geopandas import GeoDataFrame
from pandas import DataFrame

from config import (
    COL_FLAECHE,
    CRS_EPSG,
    CRS_STRING,
    DEFAULT_GREEN_SPACE,
    DIN277,
    GREEN_SPACE,
    LAYER_LANDCOVER,
    MSG_EGRID_FOUND,
    MSG_EGRID_MERGED,
    MSG_EGRID_NOT_FOUND,
    SIA416,
    SLIVER_THRESHOLD,
    SQL_BATCH_SIZE,
    VERSIEGELT_ARTS,
)
from geometry import clean_geometries, filter_clip_results
from swisstopo import LayerConfig, intersect_with_features
from bauzonen import BAUZONEN_CONFIG
from habitat import HABITAT_CONFIG
from data_io import (
    ensure_fid_column,
    get_bfsnr_list,
    get_rtree_table,
    read_landcover,
    read_parcels,
    read_user_input,
    validate_crs,
    write_csv,
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
    chunk_size: int = 10000,
    ts: str | None = None,
    aggregate: bool = True,
    export_parcels: bool = True,
    export_landcover: bool = True,
    bauzonen: bool = False,
    habitat: bool = False,
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
        Directory for output CSV files.
    limit : int | None
        Limit processing for testing. Mode 1: first N rows. Mode 2: first N municipalities.
    chunk_size : int
        Mode 1: number of rows per processing chunk (default 1000).
    ts : str | None
        Timestamp string for output filenames. Generated if not provided.
    aggregate : bool
        If True (default), add per-parcel land cover area summary columns
        (GGF_m2, BUF_m2, UUF_m2) to the parcels output.
    export_parcels : bool
        If True (default), export the parcels CSV.
    export_landcover : bool
        If True (default), export the land cover CSV.
    bauzonen : bool
        If True, intersect parcels and green spaces with Swisstopo Bauzonen.
    habitat : bool
        If True, intersect parcels and green spaces with BAFU Lebensraumkarte.
    """
    t0 = time.time()
    output_dir = Path(output_dir)
    if ts is None:
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")

    user_df = _load_parcel_identifiers(mode, input_path, limit)
    prefix = Path(input_path).stem + "_" if input_path else ""

    # Prefix user-provided columns (except ID and EGRID) for clarity in output
    if user_df is not None:
        rename = {c: f"input_{c}" for c in user_df.columns if c not in ("ID", "EGRID")}
        if rename:
            user_df = user_df.rename(columns=rename)
            logger.debug("Prefixed %d user columns: %s", len(rename), list(rename.values()))

    # Build user extra-columns lookup (Mode 1 only: all cols except ID + EGRID)
    user_extra = _build_user_extra(user_df)

    if mode == 1:
        parcels_out, lc_out, parcels_gdf = _run_mode1(user_df, gpkg_path, output_dir, ts, chunk_size, prefix)
    else:
        parcels_out, lc_out, parcels_gdf = _run_mode2(gpkg_path, limit)

    # Aggregate land cover areas onto parcels
    if aggregate:
        parcels_out = _aggregate_landcover(parcels_out, lc_out)

    # Join user extra columns onto landcover output
    lc_out = _join_user_extra(lc_out, user_extra)

    # Drop geometry early if no layer analysis needs it (saves memory)
    if not (bauzonen or habitat) and "geometry" in lc_out.columns:
        lc_out = lc_out.drop(columns=["geometry"])

    # Optional Swisstopo layer analyses — aggregate onto parcels_out and lc_out
    if bauzonen or habitat:
        if parcels_gdf is not None and not parcels_gdf.empty:
            # Ensure parcels_gdf has ID and EGRID columns for layer analysis
            if "EGRID" not in parcels_gdf.columns:
                parcels_gdf["EGRID"] = parcels_gdf["EGRIS_EGRID"]
            if "ID" not in parcels_gdf.columns:
                id_map = parcels_out.drop_duplicates(subset="EGRID").set_index("EGRID")["ID"]
                parcels_gdf["ID"] = parcels_gdf["EGRID"].map(id_map).fillna(parcels_gdf["EGRID"])

            if bauzonen:
                parcels_out, lc_out = _run_layer_analysis(
                    BAUZONEN_CONFIG, "bauzonen",
                    parcels_gdf, parcels_out, lc_out,
                )
            if habitat:
                parcels_out, lc_out = _run_layer_analysis(
                    HABITAT_CONFIG, "habitat",
                    parcels_gdf, parcels_out, lc_out,
                )
        else:
            logger.warning("No parcel geometries available — skipping layer analyses")

    # Export final results (drop geometry columns before CSV export)
    logger.info("Exporting final results")
    if export_parcels:
        write_csv(parcels_out, output_dir / f"{prefix}parcels_{ts}.csv")
    if export_landcover:
        lc_export = lc_out.drop(columns=["geometry"], errors="ignore")
        write_csv(lc_export, output_dir / f"{prefix}landcover_{ts}.csv")

    elapsed = time.time() - t0
    mins, secs = divmod(int(elapsed), 60)
    logger.info(
        "Done in %dm%02ds — %d parcels, %d land cover rows → %s",
        mins, secs, len(parcels_out), len(lc_out), output_dir,
    )


# ---------------------------------------------------------------------------
# Mode 1 — chunked processing
# ---------------------------------------------------------------------------

def _run_mode1(
    user_df: DataFrame,
    gpkg_path: str,
    output_dir: Path,
    ts: str,
    chunk_size: int = 10000,
    prefix: str = "",
) -> tuple[DataFrame, DataFrame, GeoDataFrame]:
    """Mode 1: process user-provided EGRID list in chunks."""
    total_rows = len(user_df)
    n_chunks = -(-total_rows // chunk_size)  # ceiling division

    logger.info(
        "Loaded %d rows — processing in %d chunk(s) of %d",
        total_rows, n_chunks, chunk_size,
    )

    # Single chunk — process directly, no intermediate files
    if n_chunks == 1:
        return _process_mode1_chunk(user_df, gpkg_path)

    all_parcels: list[DataFrame] = []
    all_lc: list[DataFrame] = []
    all_gdf: list[GeoDataFrame] = []
    t0 = time.time()

    for chunk_idx in range(n_chunks):
        start = chunk_idx * chunk_size
        end = min(start + chunk_size, total_rows)
        chunk_df = user_df.iloc[start:end].copy()

        eta = _fmt_eta(time.time() - t0, chunk_idx, n_chunks)
        logger.info(
            "— Chunk %d/%d (rows %d–%d) %s",
            chunk_idx + 1, n_chunks, start + 1, end, eta,
        )

        parcels_out, lc_out, parcels_gdf = _process_mode1_chunk(chunk_df, gpkg_path)
        all_parcels.append(parcels_out)
        all_lc.append(lc_out)
        if not parcels_gdf.empty:
            all_gdf.append(parcels_gdf)

    logger.info("Merging %d chunks", n_chunks)
    parcels_merged = pd.concat(all_parcels, ignore_index=True)
    lc_merged = pd.concat(all_lc, ignore_index=True)
    gdf_merged = pd.concat(all_gdf, ignore_index=True) if all_gdf else GeoDataFrame()

    return parcels_merged, lc_merged, gdf_merged


def _process_mode1_chunk(
    user_df: DataFrame,
    gpkg_path: str,
) -> tuple[DataFrame, DataFrame, GeoDataFrame]:
    """Process a single chunk of Mode 1 user input."""
    egrids = user_df["EGRID"].dropna().unique().tolist()
    if not egrids:
        logger.warning("  No valid EGRIDs in chunk — skipping")
        return _merge_user_parcels(user_df, GeoDataFrame()), _empty_landcover_df(), GeoDataFrame()

    logger.info("  Looking up %d unique EGRIDs", len(egrids))

    # Look up parcel geometries & dissolve duplicates
    parcels_gdf = _lookup_parcel_geometries(egrids, gpkg_path)

    # Clean parcels & calculate area
    parcels_gdf = _process_parcels(parcels_gdf)

    # Attach user's ID
    egrid_to_id = user_df.drop_duplicates(subset="EGRID").set_index("EGRID")["ID"]
    if not parcels_gdf.empty:
        parcels_gdf["ID"] = parcels_gdf["EGRIS_EGRID"].map(egrid_to_id)
        parcels_gdf["EGRID"] = parcels_gdf["EGRIS_EGRID"]

    # Left-join user data onto parcel results
    parcels_out = _merge_user_parcels(user_df, parcels_gdf)

    # Land cover processing
    found = parcels_gdf[parcels_gdf.geometry.notna() & ~parcels_gdf.geometry.is_empty]
    if found.empty:
        logger.warning("  No parcel geometries found — skipping land cover")
        lc_out = _empty_landcover_df()
    else:
        lc_out = _process_landcover(found, gpkg_path)

    return parcels_out, lc_out, parcels_gdf


# ---------------------------------------------------------------------------
# Mode 2 — batched by municipality
# ---------------------------------------------------------------------------

def _run_mode2(gpkg_path: str, limit: int | None = None) -> tuple[DataFrame, DataFrame, GeoDataFrame]:
    """Mode 2: process all parcels, batched by BFSNr."""
    bfsnr_list = get_bfsnr_list(gpkg_path)
    if limit is not None:
        bfsnr_list = bfsnr_list[:limit]
        logger.info("Mode 2: processing %d municipalities (limited from full set)", len(bfsnr_list))
    else:
        logger.info("Mode 2: processing %d municipalities", len(bfsnr_list))

    all_parcels: list[DataFrame] = []
    all_lc: list[DataFrame] = []
    all_gdf: list[GeoDataFrame] = []
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
        all_gdf.append(parcels_gdf)

        # Land cover
        found = parcels_gdf[
            parcels_gdf.geometry.notna() & ~parcels_gdf.geometry.is_empty
        ]
        if not found.empty:
            lc = _process_landcover(found, gpkg_path)
            all_lc.append(lc)

    parcels_result = pd.concat(all_parcels, ignore_index=True) if all_parcels else _empty_parcels_df()
    lc_result = pd.concat(all_lc, ignore_index=True) if all_lc else _empty_landcover_df()
    gdf_result = pd.concat(all_gdf, ignore_index=True) if all_gdf else GeoDataFrame()

    return parcels_result, lc_result, gdf_result


# ---------------------------------------------------------------------------
# Load parcel identifiers
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
# Look up parcel geometries & handle duplicates
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
# Clean parcel geometries & calculate area
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
# Land cover processing (matches FME: read → clip → clean results → area)
# ---------------------------------------------------------------------------

def _process_landcover(
    parcels_gdf: GeoDataFrame,
    gpkg_path: str,
) -> DataFrame:
    """Batch-read LC features via R-tree, then clip per parcel.

    Opens a single sqlite3 connection for R-tree queries and performs
    one bulk gpd.read_file call, avoiding per-parcel file open overhead.
    Falls back to per-parcel reads when no R-tree index is available.
    """
    n = len(parcels_gdf)
    logger.info("  Clipping land cover for %d parcels", n)

    gpkg_str = str(gpkg_path)
    rtree = get_rtree_table(gpkg_str, LAYER_LANDCOVER)

    if rtree is None:
        logger.debug("No R-tree index — falling back to per-parcel reads")
        return _process_landcover_no_rtree(parcels_gdf, gpkg_path)

    # Phase 1: Collect fids per parcel from R-tree (single connection)
    parcel_fids: dict[int, set[int]] = {}  # row index -> set of fids
    all_fids: set[int] = set()

    with sqlite3.connect(gpkg_str) as conn:
        for idx, parcel in parcels_gdf.iterrows():
            minx, miny, maxx, maxy = parcel.geometry.bounds
            rows = conn.execute(
                f'SELECT id FROM "{rtree}" '
                "WHERE minx <= ? AND maxx >= ? AND miny <= ? AND maxy >= ?",
                (maxx, minx, maxy, miny),
            ).fetchall()
            fids = {r[0] for r in rows}
            parcel_fids[idx] = fids
            all_fids.update(fids)

    if not all_fids:
        return _empty_landcover_df()

    # Phase 2: Bulk-read all LC features (batched to stay within SQL limits)
    fid_list = sorted(all_fids)
    frames: list[GeoDataFrame] = []
    for i in range(0, len(fid_list), SQL_BATCH_SIZE):
        batch = fid_list[i : i + SQL_BATCH_SIZE]
        fid_csv = ", ".join(str(f) for f in batch)
        sql = f'SELECT * FROM "{LAYER_LANDCOVER}" WHERE fid IN ({fid_csv})'
        gdf = gpd.read_file(gpkg_str, sql=sql, fid_as_index=True)
        gdf = ensure_fid_column(gdf)
        frames.append(gdf)

    if not frames or all(f.empty for f in frames):
        return _empty_landcover_df()

    crs = frames[0].crs
    geom_col = frames[0].geometry.name
    lcsf_all = pd.concat(frames, ignore_index=True)
    lcsf_all = GeoDataFrame(lcsf_all, geometry=geom_col, crs=crs)

    if not lcsf_all.empty:
        validate_crs(lcsf_all, LAYER_LANDCOVER)

    # Index by fid for fast subset selection
    lcsf_all = lcsf_all.set_index("fid", drop=False)
    all_fid_set = set(lcsf_all.index)

    # Phase 3: Clip per parcel using vectorised shapely.intersection
    chunks: list[DataFrame] = []
    for idx, parcel in parcels_gdf.iterrows():
        fids = parcel_fids.get(idx, set())
        if not fids:
            continue
        valid_fids = list(fids & all_fid_set)
        if not valid_fids:
            continue
        lcsf = lcsf_all.loc[valid_fids].copy().reset_index(drop=True)
        if lcsf.empty:
            continue
        lc = _clip_single_parcel(lcsf, parcel)
        if not lc.empty:
            chunks.append(lc)

    total_lc = sum(len(c) for c in chunks)
    logger.info("  Clipped %d land cover rows from %d parcels", total_lc, n)

    if not chunks:
        return _empty_landcover_df()
    return pd.concat(chunks, ignore_index=True)


def _process_landcover_no_rtree(
    parcels_gdf: GeoDataFrame,
    gpkg_path: str,
) -> DataFrame:
    """Fallback: per-parcel LC read when no R-tree index is available."""
    chunks: list[DataFrame] = []
    for _, parcel in parcels_gdf.iterrows():
        bbox = tuple(parcel.geometry.bounds)
        lcsf = read_landcover(gpkg_path, bbox=bbox)
        if lcsf.empty:
            continue
        lc = _clip_single_parcel(lcsf, parcel)
        if not lc.empty:
            chunks.append(lc)

    if not chunks:
        return _empty_landcover_df()
    return pd.concat(chunks, ignore_index=True)


def _clip_single_parcel(
    lcsf: GeoDataFrame,
    parcel: pd.Series,
) -> DataFrame:
    """Clip LC features against one parcel using vectorised shapely.intersection."""
    parcel_geom = parcel.geometry
    if not parcel_geom.is_valid:
        parcel_geom = shapely.make_valid(parcel_geom)

    # Vectorised intersection (replaces gpd.overlay for single-parcel case)
    clipped_geoms = shapely.intersection(lcsf.geometry.values, parcel_geom)

    result = lcsf.copy()
    result[result.geometry.name] = clipped_geoms
    result = GeoDataFrame(result, geometry=result.geometry.name, crs=lcsf.crs)

    # Repair clipped geometries
    result.geometry = shapely.make_valid(result.geometry.values)

    # Filter out non-polygon results and slivers
    result = filter_clip_results(result)

    if result.empty:
        return _empty_landcover_df()

    # Add parcel identifiers
    for col in ("EGRID", "ID"):
        if col in parcel.index:
            result[col] = parcel[col]
    if "EGRID" not in result.columns and "EGRIS_EGRID" in parcel.index:
        result["EGRID"] = parcel["EGRIS_EGRID"]
    if "ID" not in result.columns:
        result["ID"] = result.get("EGRID", "")

    # Calculate clipped area
    result["area_m2"] = result.geometry.area

    # Classify green space
    result["Check_GreenSpace"] = result["Art"].map(GREEN_SPACE).fillna(DEFAULT_GREEN_SPACE)

    # Build output (keep geometry for optional layer analyses; dropped at CSV export)
    output_cols = ["ID", "EGRID", "fid", "Art", "BFSNr", "GWR_EGID", "Check_GreenSpace", "area_m2", "geometry"]
    output_cols = [c for c in output_cols if c in result.columns]
    return result[output_cols].reset_index(drop=True)


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

_SIA416_CATEGORIES = ("GGF", "BUF", "UUF")
_DIN277_CATEGORIES = ("BF", "UF")


def _aggregate_landcover(
    parcels_df: DataFrame,
    lc_df: DataFrame,
) -> DataFrame:
    """Add per-parcel land cover area summary columns to the parcels output.

    Columns added:
    - ``GGF_m2``, ``BUF_m2``, ``UUF_m2`` — SIA 416 area breakdown
    - ``Sealed_m2`` — sealed area (GGF + befestigt)
    - ``GreenSpace_m2`` — green space area (humusiert + bestockt)
    - One column per ``Art`` value present (e.g. ``Gebaeude_m2``)
    """
    sia_cols = [f"{c}_m2" for c in _SIA416_CATEGORIES]
    din_cols = [f"DIN277_{c}_m2" for c in _DIN277_CATEGORIES]
    fixed_cols = sia_cols + din_cols + ["Sealed_m2", "GreenSpace_m2"]

    if lc_df.empty:
        for col in fixed_cols:
            parcels_df[col] = 0.0
        return parcels_df

    lc = lc_df[["EGRID", "Art", "area_m2"]].copy()

    # --- SIA 416 pivot (GGF / BUF / UUF) ---
    lc["SIA416"] = lc["Art"].map(SIA416)
    unmapped = lc.loc[lc["SIA416"].isna(), "Art"].unique()
    if len(unmapped) > 0:
        logger.warning("Unknown Art values defaulting to UUF: %s", list(unmapped))
    lc["SIA416"] = lc["SIA416"].fillna("UUF")

    sia_pivot = (
        lc.groupby(["EGRID", "SIA416"])["area_m2"]
        .sum()
        .unstack(fill_value=0.0)
    )
    for cat in _SIA416_CATEGORIES:
        if cat not in sia_pivot.columns:
            sia_pivot[cat] = 0.0
    sia_pivot = sia_pivot[list(_SIA416_CATEGORIES)]
    sia_pivot.columns = sia_cols
    sia_pivot = sia_pivot.reset_index()

    # --- DIN 277 pivot (BF / UF) ---
    lc["DIN277"] = lc["Art"].map(DIN277).fillna("UF")

    din_pivot = (
        lc.groupby(["EGRID", "DIN277"])["area_m2"]
        .sum()
        .unstack(fill_value=0.0)
    )
    for cat in _DIN277_CATEGORIES:
        if cat not in din_pivot.columns:
            din_pivot[cat] = 0.0
    din_pivot = din_pivot[list(_DIN277_CATEGORIES)]
    din_pivot.columns = din_cols
    din_pivot = din_pivot.reset_index()

    # --- Versiegelt (sealed = GGF + befestigt) ---
    lc["is_versiegelt"] = lc["Art"].isin(VERSIEGELT_ARTS)
    versiegelt = (
        lc[lc["is_versiegelt"]]
        .groupby("EGRID")["area_m2"]
        .sum()
        .reset_index()
        .rename(columns={"area_m2": "Sealed_m2"})
    )

    # --- Green space ---
    lc["green"] = lc["Art"].map(GREEN_SPACE)
    green = (
        lc[lc["green"].notna()]
        .groupby("EGRID")["area_m2"]
        .sum()
        .reset_index()
        .rename(columns={"area_m2": "GreenSpace_m2"})
    )

    # --- Per-Art pivot ---
    art_pivot = (
        lc.groupby(["EGRID", "Art"])["area_m2"]
        .sum()
        .unstack(fill_value=0.0)
    )
    art_pivot.columns = [f"{a}_m2" for a in art_pivot.columns]
    art_pivot = art_pivot.reset_index()

    # --- Merge all onto parcels ---
    result = parcels_df
    result = result.merge(sia_pivot, on="EGRID", how="left")
    result = result.merge(din_pivot, on="EGRID", how="left")
    result = result.merge(versiegelt, on="EGRID", how="left")
    result = result.merge(green, on="EGRID", how="left")
    result = result.merge(art_pivot, on="EGRID", how="left")

    # Fill NaN for parcels with no LC data
    fill = {col: 0.0 for col in result.columns if col.endswith("_m2")}
    result = result.fillna(fill)

    logger.info("Aggregated land cover areas onto %d parcels", len(result))
    return result


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


def _build_user_extra(user_df: DataFrame | None) -> DataFrame | None:
    """Extract extra user columns (everything except ID + EGRID), keyed by EGRID.

    Returns a DataFrame with EGRID + extra columns (one row per EGRID),
    or None if there are no extra columns or no user input.
    """
    if user_df is None:
        return None
    extra_cols = [c for c in user_df.columns if c not in ("ID", "EGRID")]
    if not extra_cols:
        return None
    subset = user_df[["EGRID"] + extra_cols]
    deduped = subset.drop_duplicates(subset="EGRID")
    # Detect EGRIDs that appear with differing extra-column values
    n_total_dup = subset["EGRID"].duplicated().sum()
    n_exact_dup = len(subset) - len(subset.drop_duplicates())
    n_conflicting = n_total_dup - n_exact_dup
    if n_conflicting > 0:
        logger.warning(
            "Duplicate EGRIDs with differing extra columns detected — "
            "keeping first occurrence for %d EGRIDs",
            n_conflicting,
        )
    return deduped


def _join_user_extra(df: DataFrame, user_extra: DataFrame | None) -> DataFrame:
    """Left-join user extra columns onto *df* via EGRID."""
    if user_extra is None or df.empty or "EGRID" not in df.columns:
        return df
    return df.merge(user_extra, on="EGRID", how="left")


def _empty_parcels_df() -> DataFrame:
    return DataFrame(columns=["ID", "EGRID", "Nummer", "BFSNr", "Check_EGRID",
                               COL_FLAECHE, "parcel_area_m2"])


def _empty_landcover_df() -> DataFrame:
    return DataFrame(columns=["ID", "EGRID", "fid", "Art", "BFSNr",
                               "GWR_EGID", "Check_GreenSpace", "area_m2",
                               "geometry"])


# ---------------------------------------------------------------------------
# Swisstopo layer analysis (Bauzonen, Habitat, …)
# ---------------------------------------------------------------------------



API_MAX_WORKERS = 10


def _fetch_for_parcel(
    geom,
    egrid: str,
    cfg: LayerConfig,
) -> GeoDataFrame:
    """Fetch API features for one parcel geometry (thread-safe)."""
    from swisstopo import fetch_features_for_polygon

    if geom is None or geom.is_empty:
        return GeoDataFrame()
    if not geom.is_valid:
        geom = shapely.make_valid(geom)

    try:
        return fetch_features_for_polygon(geom, cfg, context=egrid)
    except Exception as e:
        logger.error("%s — API error for EGRID %s: %s", cfg.layer_id, egrid, e)
        return GeoDataFrame()


def _run_layer_analysis(
    cfg: LayerConfig,
    label: str,
    parcels_gdf: GeoDataFrame,
    parcels_out: DataFrame,
    lc_out: DataFrame,
) -> tuple[DataFrame, DataFrame]:
    """Intersect parcels and green spaces with a Swisstopo layer.

    Phase 1: Parallel API fetch per parcel → cache by EGRID.
    Phase 2: Local intersection of parcels with cached features.
    Phase 3: Local intersection of green-space land covers with cached features
             (grouped by EGRID to avoid per-row GeoDataFrame overhead).
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    n_parcels = len(parcels_gdf)
    name_col = list(cfg.column_map.values())[0]

    # --- Phase 1: Fetch layer features per parcel (parallel API calls) ---
    logger.info("%s — Step 1/3: Fetching %s features for %d parcels …",
                label, cfg.layer_id, n_parcels)
    t0 = time.time()

    egrid_features: dict[str, GeoDataFrame] = {}
    futures: dict = {}
    with ThreadPoolExecutor(max_workers=API_MAX_WORKERS) as pool:
        for _, row in parcels_gdf.iterrows():
            egrid = row.get("EGRID", "")
            fut = pool.submit(_fetch_for_parcel, row.geometry, egrid, cfg)
            futures[fut] = egrid

        done = 0
        for fut in as_completed(futures):
            done += 1
            egrid = futures[fut]
            egrid_features[egrid] = fut.result()
            if done % 50 == 0 or done == n_parcels:
                eta = _fmt_eta(time.time() - t0, done, n_parcels)
                logger.info("%s — Step 1/3: Fetched %d/%d parcels (%s)",
                            label, done, n_parcels, eta)

    # --- Phase 2: Intersect parcels with cached features (local) ---
    logger.info("%s — Step 2/3: Intersecting %d parcels …", label, n_parcels)

    parcel_results: list[dict] = []
    for _, row in parcels_gdf.iterrows():
        egrid = row.get("EGRID", "")
        features = egrid_features.get(egrid)
        if features is None or features.empty:
            continue
        row_gdf = GeoDataFrame(
            [{col: row[col] for col in row.index} | {"geometry": row.geometry}],
            geometry="geometry", crs=CRS_STRING,
        )
        hits = intersect_with_features(row_gdf, features, cfg, id_cols=["ID", "EGRID"])
        parcel_results.extend(h.to_dict() for _, h in hits.iterrows())

    raw_parcels = DataFrame(parcel_results) if parcel_results else DataFrame()
    parcel_agg = _aggregate_layer_results(raw_parcels, "EGRID", name_col, label)
    parcels_out = parcels_out.merge(parcel_agg, on="EGRID", how="left")
    parcels_out[f"{label}"] = parcels_out[f"{label}"].fillna("")
    parcels_out[f"{label}_m2"] = parcels_out[f"{label}_m2"].fillna("")

    # --- Phase 3: Intersect green-space land covers with CACHED features ---
    has_geometry = "geometry" in lc_out.columns
    green_lc = lc_out[lc_out["Check_GreenSpace"] != "Not green space"].copy() if has_geometry else DataFrame()

    if green_lc.empty or "fid" not in green_lc.columns or not has_geometry:
        lc_out[f"{label}"] = ""
        lc_out[f"{label}_m2"] = ""
    else:
        green_gs_gdf = GeoDataFrame(
            green_lc[["ID", "EGRID", "fid", "Art", "Check_GreenSpace", "geometry"]],
            geometry="geometry", crs=CRS_STRING,
        )
        green_gs_gdf = green_gs_gdf[
            green_gs_gdf.geometry.notna() & ~green_gs_gdf.geometry.is_empty
        ]
        n_green = len(green_gs_gdf)

        if n_green == 0:
            lc_out[f"{label}"] = ""
            lc_out[f"{label}_m2"] = ""
        else:
            logger.info("%s — Step 3/3: Intersecting %d land covers (green space) …",
                        label, n_green)
            t1 = time.time()

            # Group by EGRID to batch intersections and avoid per-row GeoDataFrame overhead
            green_results: list[dict] = []
            groups = green_gs_gdf.groupby("EGRID")
            done_lc = 0
            for egrid, group in groups:
                features = egrid_features.get(egrid)
                if features is None or features.empty:
                    done_lc += len(group)
                    continue
                hits = intersect_with_features(
                    group, features, cfg,
                    id_cols=["ID", "EGRID", "fid", "Art", "Check_GreenSpace"],
                )
                green_results.extend(h.to_dict() for _, h in hits.iterrows())
                done_lc += len(group)
                if done_lc % 500 == 0:
                    eta = _fmt_eta(time.time() - t1, done_lc, n_green)
                    logger.info("%s — Step 3/3: Land covers %d/%d (%s)",
                                label, done_lc, n_green, eta)

            logger.info("%s — Step 3/3: Land covers %d/%d done", label, n_green, n_green)

            raw_green = DataFrame(green_results) if green_results else DataFrame()
            lc_agg = _aggregate_layer_results(raw_green, ["EGRID", "fid"], name_col, label)
            lc_out = lc_out.merge(lc_agg, on=["EGRID", "fid"], how="left")
            lc_out[f"{label}"] = lc_out[f"{label}"].fillna("")
            lc_out[f"{label}_m2"] = lc_out[f"{label}_m2"].fillna("")

    logger.info("%s complete", label)
    return parcels_out, lc_out


def _aggregate_layer_results(
    raw: DataFrame,
    group_key: str | list[str],
    name_col: str,
    label: str,
) -> DataFrame:
    """Aggregate intersection results into semicolon-separated arrays.

    Groups by *group_key* and produces two columns:
    - ``{label}`` — semicolon-separated feature names
    - ``{label}_m2`` — semicolon-separated intersection areas
    """
    if raw.empty:
        if isinstance(group_key, str):
            group_key = [group_key]
        return DataFrame(columns=group_key + [label, f"{label}_m2"])

    def _join_names(s):
        return "; ".join(str(v) for v in s)

    def _join_areas(s):
        return "; ".join(f"{v:.1f}" for v in s)

    grouped = raw.groupby(group_key, sort=False).agg(
        **{
            label: (name_col, _join_names),
            f"{label}_m2": ("intersection_area_m2", _join_areas),
        }
    ).reset_index()

    return grouped


