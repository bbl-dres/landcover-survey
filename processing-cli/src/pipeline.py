"""Main processing orchestration (``gpkg`` source).

Output rule, the same as in the ``api`` source: an **empty** cell means "not
known / not asked" (the parcel was not found, a request failed, the run was
interrupted), ``0`` means "asked, nothing there".
"""

from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import closing
from datetime import datetime
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd
import shapely
from geopandas import GeoDataFrame
from pandas import DataFrame

from config import (
    COL_FLAECHE,
    COL_VBS_KATEGORIE,
    COL_VBS_PRODUKTIV,
    COL_VBS_TYP,
    CRS_STRING,
    DEFAULT_GREEN_SPACE,
    DEFAULT_VBS_KATEGORIE,
    DEFAULT_VBS_PRODUKTIV,
    DEFAULT_VBS_TYP,
    DIN277,
    GREEN_SPACE,
    LAYER_LANDCOVER,
    LAYER_SDR,
    MSG_EGRID_FOUND,
    MSG_EGRID_MERGED,
    MSG_EGRID_NO_EGRID,
    MSG_EGRID_NOT_FOUND,
    NO_EGRID_KEY_PREFIX,
    SIA416,
    SQL_BATCH_SIZE,
    VBS_KATEGORIE,
    VBS_KATEGORIE_BY_ART,
    VBS_PRODUKTIV,
    VBS_PRODUKTIV_BY_ART,
    VBS_TYP,
    VBS_TYP_BY_ART,
    VERSIEGELT_ARTS,
    slugify,
    to_fixed_1,
    typoch_l1_label,
    typoch_l2_label,
)
from geometry import clean_geometries, extract_polygons, filter_clip_results
from swisstopo import LayerConfig, fetch_features_with_status, intersect_with_features
from bauzonen import BAUZONEN_CONFIG
from habitat import HABITAT_CONFIG
from data_io import (
    connect_readonly,
    ensure_fid_column,
    get_bfsnr_counts,
    get_cross_batch_egrids,
    get_rtree_table,
    is_valid_egrid,
    layer_exists,
    read_landcover,
    read_parcels,
    read_user_input,
    validate_crs,
    validate_gpkg,
    write_csv,
)

logger = logging.getLogger(__name__)


class PipelineError(Exception):
    """A problem the user has to fix (unreadable input list, missing GeoPackage,
    bad argument). The CLI prints the message and exits 1 — no traceback."""


# check_egrid of the input rows a Mode 1 run did not reach (Ctrl-C, or a chunk
# that failed). Same text as the api source (processor_web.NOT_PROCESSED).
NOT_PROCESSED = "error:Not processed (run interrupted)"

# check_<overlay> values — the vocabulary of the api source.
CHECK_OK = "ok"                # the service answered; the values are complete
CHECK_PARTIAL = "partial"      # a feature came without geometry and could not be clipped
CHECK_TRUNCATED = "truncated"  # the tiling hit its depth cap; features may be missing
CHECK_ERROR = "error"          # the request failed; the overlay columns stay empty
_CHECK_ANSWERED = (CHECK_OK, CHECK_PARTIAL, CHECK_TRUNCATED)

# A wall-to-wall overlay (habitat) is only "partial" when the dropped feature
# leaves more than this share of the parcel uncovered (api: HABITAT_GAP_MIN_FRAC).
OVERLAY_GAP_MIN_FRAC = 0.01


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
    greeninv: bool | str = False,
) -> bool:
    """Run the landcover survey pipeline.

    Returns ``True`` when the run is complete. ``False`` means it stopped part-way
    (Ctrl-C, or an exception in a later chunk / municipality / overlay): what was
    finished is written, and the log says what is missing.

    Raises :class:`PipelineError` for problems the user has to fix (input list,
    GeoPackage path, arguments) — before anything is processed.

    Parameters
    ----------
    mode : int
        1 = user-provided parcel list, 2 = all parcels from GeoPackage.
    input_path : str | None
        Path to CSV/Excel (Mode 1 only; ignored in Mode 2 except as file-name prefix).
    gpkg_path : str
        Path to the AV GeoPackage.
    output_dir : str
        Directory for output CSV files.
    limit : int | None
        Limit processing for testing. Mode 1: first N rows. Mode 2: first N municipalities.
    chunk_size : int
        Mode 1: number of input rows per processing chunk (default 10000). The
        result does not depend on it; when a later chunk fails or the run is
        interrupted, the finished chunks are still written.
    ts : str | None
        Timestamp string for output filenames. Generated if not provided.
    aggregate : bool
        If True (default), add per-parcel land cover area summary columns
        (sia416_*, din277_*, sealed_m2, greenspace_m2, av_*, av_<art>_m2)
        to the parcels output.
    export_parcels : bool
        If True (default), export the parcels CSV.
    export_landcover : bool
        If True (default), export the land cover CSV.
    bauzonen : bool
        If True, intersect parcels and green spaces with Swisstopo Bauzonen
        (adds ``bauzonen``, ``bauzonen_m2``, ``check_bauzonen``, ``bauzonen_<zone>_m2``).
    habitat : bool
        If True, intersect parcels and green spaces with BAFU Lebensraumkarte
        (adds ``habitat``, ``habitat_m2``, ``check_habitat``, ``habitat_<group>_m2``).
    greeninv : bool | str
        If truthy, add a ``greeninv`` column (``yes`` / ``no``) by matching parcels
        against the green inventory parcel list: ``True`` reads the public file, a
        string is a URL or local GeoJSON path.
    """
    t0 = time.time()
    output_dir = Path(output_dir)
    if ts is None:
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")

    if chunk_size < 1:
        raise PipelineError(f"chunk_size must be at least 1 (got {chunk_size}).")
    if limit is not None and limit < 0:
        raise PipelineError(f"limit must not be negative (got {limit}).")

    try:
        user_df = _load_parcel_identifiers(mode, input_path, limit)
    except (ValueError, OSError) as e:
        raise PipelineError(str(e)) from e
    try:
        validate_gpkg(gpkg_path)
    except (FileNotFoundError, ValueError) as e:
        raise PipelineError(str(e)) from e

    prefix = Path(input_path).stem + "_" if input_path else ""

    # Prefix user-provided columns (except ID and EGRID) for clarity in output
    if user_df is not None:
        rename = {c: f"input_{c}" for c in user_df.columns if c not in ("ID", "EGRID")}
        if rename:
            user_df = user_df.rename(columns=rename)
            logger.debug("Prefixed %d user columns: %s", len(rename), list(rename.values()))

    # Build user extra-columns lookup (Mode 1 only: all cols except ID + EGRID)
    user_extra = _build_user_extra(user_df)

    # Geometries are only needed by the overlay analyses; without them they are
    # dropped chunk by chunk (they are most of the memory of a large run).
    keep_geometry = bool(bauzonen or habitat)

    if mode == 1:
        parcels_out, lc_out, parcels_gdf, complete = _run_mode1(
            user_df, gpkg_path, chunk_size, keep_geometry=keep_geometry)
    else:
        parcels_out, lc_out, parcels_gdf, complete = _run_mode2(
            gpkg_path, limit, keep_geometry=keep_geometry)

    # Aggregate land cover areas onto parcels
    if aggregate:
        parcels_out = _aggregate_landcover(parcels_out, lc_out)

    # Join user extra columns onto landcover output
    lc_out = _join_user_extra(lc_out, user_extra)

    # Optional Swisstopo layer analyses — aggregate onto parcels_out and lc_out
    if (bauzonen or habitat) and not complete:
        logger.error("The run is incomplete — the overlay analyses are skipped.")
    elif bauzonen or habitat:
        if parcels_gdf is not None and not parcels_gdf.empty:
            # Ensure parcels_gdf has ID and EGRID columns for layer analysis
            if "EGRID" not in parcels_gdf.columns:
                parcels_gdf["EGRID"] = parcels_gdf["EGRIS_EGRID"]
            if "ID" not in parcels_gdf.columns:
                id_map = parcels_out.drop_duplicates(subset="EGRID").set_index("EGRID")["ID"]
                parcels_gdf["ID"] = parcels_gdf["EGRID"].map(id_map).fillna(parcels_gdf["EGRID"])

            overlays = []
            if bauzonen:
                # Bauzonen names are already the harmonised Hauptnutzung categories.
                overlays.append((BAUZONEN_CONFIG, "bauzonen", {}))
            if habitat:
                # Group TypoCH labels to level 2 (names + per-type columns); a zone
                # layer is not wall-to-wall, the habitat map is.
                overlays.append((HABITAT_CONFIG, "habitat",
                                 {"name_fn": _habitat_group_label, "wall_to_wall": True}))
            for cfg, label, kwargs in overlays:
                try:
                    parcels_out, lc_out = _run_layer_analysis(
                        cfg, label, parcels_gdf, parcels_out, lc_out, **kwargs)
                except KeyboardInterrupt:
                    logger.error("Interrupted during the %s overlay — it and the overlays "
                                 "after it are left out of the output.", label)
                    complete = False
                    break
                except Exception:  # noqa: BLE001 — keep the finished land-cover result
                    logger.exception("The %s overlay failed — it and the overlays after it "
                                     "are left out of the output.", label)
                    complete = False
                    break
        else:
            logger.warning("No parcel geometries available — skipping layer analyses")

    # Final output schema: no geometry, integer codes, lowercase column ids.
    parcels_out = _finalize_output(parcels_out)
    lc_out = _finalize_output(lc_out)

    # Optional green-inventory join: one column, greeninv = yes / no (EGRID first, else the SAP key = id).
    if greeninv:
        parcels_out = _join_green_inventory(parcels_out, None if greeninv is True else str(greeninv))

    logger.info("Exporting final results")
    if export_parcels:
        write_csv(parcels_out, output_dir / f"{prefix}parcels_{ts}.csv")
    if export_landcover:
        write_csv(lc_out, output_dir / f"{prefix}landcover_{ts}.csv")

    elapsed = time.time() - t0
    mins, secs = divmod(int(elapsed), 60)
    if complete:
        logger.info(
            "Done in %dm%02ds — %d parcels, %d land cover rows → %s",
            mins, secs, len(parcels_out), len(lc_out), output_dir,
        )
    else:
        logger.error(
            "INCOMPLETE run after %dm%02ds — wrote what was finished: %d parcel rows, "
            "%d land cover rows → %s", mins, secs, len(parcels_out), len(lc_out), output_dir,
        )
    return complete


# ---------------------------------------------------------------------------
# Mode 1 — chunked processing
# ---------------------------------------------------------------------------

def _run_mode1(
    user_df: DataFrame,
    gpkg_path: str,
    chunk_size: int = 10000,
    keep_geometry: bool = True,
) -> tuple[DataFrame, DataFrame, GeoDataFrame, bool]:
    """Mode 1: process the user-provided EGRID list in chunks.

    Returns ``(parcels, land cover, parcel geometries, complete)``. When chunk N
    fails or the run is interrupted, the chunks before it are kept and the rows
    from chunk N on are returned with ``check_egrid`` = :data:`NOT_PROCESSED`
    (``complete`` is False). A failure in the very first chunk is raised — there
    is nothing to save. Parcel geometries are only collected with *keep_geometry*.
    """
    total_rows = len(user_df)
    if total_rows == 0:
        logger.warning("The parcel list has no rows — nothing to process")
        return _merge_user_parcels(user_df, GeoDataFrame()), _empty_landcover_df(), GeoDataFrame(), True

    n_chunks = -(-total_rows // chunk_size)  # ceiling division

    logger.info(
        "Loaded %d rows — processing in %d chunk(s) of %d",
        total_rows, n_chunks, chunk_size,
    )

    all_parcels: list[DataFrame] = []
    all_lc: list[DataFrame] = []
    all_gdf: list[GeoDataFrame] = []
    t0 = time.time()
    complete = True

    for chunk_idx in range(n_chunks):
        start = chunk_idx * chunk_size
        end = min(start + chunk_size, total_rows)
        chunk_df = user_df.iloc[start:end].copy()

        if n_chunks > 1:
            eta = _fmt_eta(time.time() - t0, chunk_idx, n_chunks)
            logger.info(
                "— Chunk %d/%d (rows %d–%d) %s",
                chunk_idx + 1, n_chunks, start + 1, end, eta,
            )

        try:
            parcels_out, lc_out, parcels_gdf = _process_mode1_chunk(chunk_df, gpkg_path)
        except (KeyboardInterrupt, Exception) as e:  # noqa: BLE001
            if chunk_idx == 0:
                raise  # nothing finished, nothing to save
            if isinstance(e, KeyboardInterrupt):
                logger.error("Interrupted in chunk %d/%d — keeping the %d finished chunk(s); "
                             "rows %d–%d are marked '%s'.",
                             chunk_idx + 1, n_chunks, chunk_idx, start + 1, total_rows, NOT_PROCESSED)
            else:
                logger.exception("Chunk %d/%d failed — keeping the %d finished chunk(s); "
                                 "rows %d–%d are marked '%s'.",
                                 chunk_idx + 1, n_chunks, chunk_idx, start + 1, total_rows, NOT_PROCESSED)
            rest = _merge_user_parcels(user_df.iloc[start:].copy(), GeoDataFrame())
            rest["Check_EGRID"] = NOT_PROCESSED
            all_parcels.append(rest)
            complete = False
            break

        if not keep_geometry:
            lc_out = lc_out.drop(columns=["geometry"], errors="ignore")
        all_parcels.append(parcels_out)
        all_lc.append(lc_out)
        if keep_geometry and not parcels_gdf.empty:
            all_gdf.append(parcels_gdf)

    if n_chunks > 1:
        logger.info("Merging %d chunks", len(all_lc))
    parcels_merged = pd.concat(all_parcels, ignore_index=True)
    lc_merged = pd.concat(all_lc, ignore_index=True)
    gdf_merged = pd.concat(all_gdf, ignore_index=True) if all_gdf else GeoDataFrame()

    # An EGRID appearing in more than one chunk (duplicate user rows straddling a
    # chunk boundary) is looked up and clipped once per chunk — drop the repeated
    # land-cover rows and parcel geometries so the per-EGRID aggregation and the
    # overlay analyses don't double-count.
    if not lc_merged.empty and {"EGRID", "fid"} <= set(lc_merged.columns):
        n_before = len(lc_merged)
        lc_merged = lc_merged.drop_duplicates(subset=["EGRID", "fid"], ignore_index=True)
        if len(lc_merged) < n_before:
            logger.info("Dropped %d duplicate land cover rows from cross-chunk EGRIDs",
                        n_before - len(lc_merged))
    if not gdf_merged.empty and "EGRIS_EGRID" in gdf_merged.columns:
        gdf_merged = gdf_merged.drop_duplicates(subset="EGRIS_EGRID", ignore_index=True)

    return parcels_merged, lc_merged, gdf_merged, complete


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

def _run_mode2(
    gpkg_path: str,
    limit: int | None = None,
    keep_geometry: bool = True,
) -> tuple[DataFrame, DataFrame, GeoDataFrame, bool]:
    """Mode 2: process all parcels, batched by BFSNr.

    Every ``resf`` row ends in exactly one output parcel:

    - parcels without a ``BFSNr`` are a last batch of their own (no ``--limit``);
    - a parcel without an EGRID is kept as a single (``check_egrid`` =
      ``no_egrid``, ``id`` = ``fid:<fid>``, empty ``egrid``);
    - an EGRID whose rows sit in several municipalities is taken out of the
      municipality batches and dissolved across them in a final batch, exactly as
      Mode 1 does — one ``merged`` row, land cover counted once.

    Returns ``(parcels, land cover, parcel geometries, complete)``; when a batch
    fails or the run is interrupted the finished batches are kept (``complete``
    is False). Parcel geometries are only collected with *keep_geometry*.
    """
    counts = get_bfsnr_counts(gpkg_path)
    n_null_bfsnr = counts.get(None, 0)
    batches: list[int | None] = sorted(k for k in counts if k is not None)
    n_municipalities = len(batches)
    if limit is not None:
        batches = batches[:limit]
        logger.info("Mode 2: processing %d municipalities (limited from %d)", len(batches), n_municipalities)
        if n_null_bfsnr:
            logger.info("Mode 2: --limit leaves out the %d parcels without a BFSNr", n_null_bfsnr)
    else:
        logger.info("Mode 2: processing %d municipalities", len(batches))
        if n_null_bfsnr:
            logger.info("Mode 2: plus %d parcels without a BFSNr, as a last batch", n_null_bfsnr)
            batches.append(None)

    cross_egrids = get_cross_batch_egrids(gpkg_path)
    if cross_egrids:
        logger.info("Mode 2: %d EGRIDs occur in more than one municipality — they are "
                    "dissolved across municipalities at the end", len(cross_egrids))

    all_parcels: list[DataFrame] = []
    all_lc: list[DataFrame] = []
    all_gdf: list[GeoDataFrame] = []
    deferred: set[str] = set()
    n_rows_in = 0
    complete = True
    t0 = time.time()

    def process(raw: GeoDataFrame) -> None:
        parcels_out, lc, parcels_gdf = _process_parcel_batch(raw, gpkg_path)
        all_parcels.append(parcels_out)
        if lc is not None:
            all_lc.append(lc if keep_geometry else lc.drop(columns=["geometry"], errors="ignore"))
        if keep_geometry:
            all_gdf.append(parcels_gdf)

    # The deferred cross-municipality EGRIDs are one more step after the batches.
    steps: list[tuple[str, int | None]] = [("batch", b) for b in batches] + [("deferred", None)]
    for i, (kind, bfsnr) in enumerate(steps, 1):
        try:
            if kind == "batch":
                eta = _fmt_eta(time.time() - t0, i - 1, len(batches))
                if bfsnr is None:
                    logger.info("Processing parcels without BFSNr (%d/%d) — %s", i, len(batches), eta)
                    raw = read_parcels(gpkg_path, bfsnr_is_null=True)
                else:
                    logger.info("Processing BFSNr %d (%d/%d) — %s", bfsnr, i, len(batches), eta)
                    raw = read_parcels(gpkg_path, bfsnr=bfsnr)
                if cross_egrids and not raw.empty:
                    is_cross = raw["EGRIS_EGRID"].isin(cross_egrids)
                    if is_cross.any():
                        deferred.update(raw.loc[is_cross, "EGRIS_EGRID"])
                        raw = raw[~is_cross].copy()
            else:
                if not deferred:
                    continue
                logger.info("Processing %d EGRIDs that span municipalities", len(deferred))
                raw = read_parcels(gpkg_path, egrids=sorted(deferred))
            if raw.empty:
                continue
            n_rows_in += len(raw)
            process(raw)
        except (KeyboardInterrupt, Exception) as e:  # noqa: BLE001
            if not all_parcels:
                raise  # nothing finished, nothing to save
            what = "the EGRIDs that span municipalities" if kind == "deferred" else (
                "the parcels without BFSNr" if bfsnr is None else f"BFSNr {bfsnr}")
            if isinstance(e, KeyboardInterrupt):
                logger.error("Interrupted in %s (step %d/%d) — keeping the %d finished batch(es).",
                             what, i, len(steps), len(all_parcels))
            else:
                logger.exception("%s failed (step %d/%d) — keeping the %d finished batch(es).",
                                 what, i, len(steps), len(all_parcels))
            complete = False
            break

    parcels_result = pd.concat(all_parcels, ignore_index=True) if all_parcels else _empty_parcels_df()
    lc_result = pd.concat(all_lc, ignore_index=True) if all_lc else _empty_landcover_df()
    gdf_result = pd.concat(all_gdf, ignore_index=True) if all_gdf else GeoDataFrame()

    # Input vs. output: every row read must be accounted for.
    check = parcels_result["Check_EGRID"] if "Check_EGRID" in parcels_result.columns else pd.Series(dtype=str)
    logger.info(
        "Mode 2: %d resf rows read → %d parcels (%d of them merged from several rows, "
        "%d without EGRID)",
        n_rows_in, len(parcels_result), int((check == MSG_EGRID_MERGED).sum()),
        int((check == MSG_EGRID_NO_EGRID).sum()),
    )
    if complete and limit is None:
        n_total = sum(counts.values())
        if n_rows_in != n_total:
            logger.warning("Mode 2: the resf layer has %d rows but %d were processed — "
                           "%d rows are missing from the output", n_total, n_rows_in, n_total - n_rows_in)

    return parcels_result, lc_result, gdf_result, complete


def _process_parcel_batch(
    raw: GeoDataFrame,
    gpkg_path: str,
) -> tuple[DataFrame, DataFrame | None, GeoDataFrame]:
    """One Mode 2 batch of raw ``resf`` rows → (parcels output, land cover or None,
    cleaned parcel geometries)."""
    # One row per parcel: duplicates of an EGRID dissolved, rows without EGRID kept
    # as singles under an internal key.
    parcels_gdf = _dissolve_duplicate_egrids(raw)

    # Mode 2 has no user ID: the parcel key serves as ID and (internal) EGRID.
    parcels_gdf["EGRID"] = parcels_gdf["EGRIS_EGRID"]
    parcels_gdf["ID"] = parcels_gdf["EGRIS_EGRID"]

    # Clean & calculate area
    parcels_gdf = _process_parcels(parcels_gdf)

    parcels_out = _build_parcels_output(parcels_gdf)

    found = parcels_gdf[parcels_gdf.geometry.notna() & ~parcels_gdf.geometry.is_empty]
    lc = _process_landcover(found, gpkg_path) if not found.empty else None
    return parcels_out, lc, parcels_gdf


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
    include_sdr: bool = True,
) -> GeoDataFrame:
    """Query ``resf`` by EGRID, dissolve duplicates, set Check_EGRID.

    EGRIDs that ``resf`` does not have are looked up in ``dprsf`` (selbständige
    und dauernde Rechte, e.g. Baurecht) when the GeoPackage has that layer — the
    AV model keeps those parcels in a layer of their own.
    """
    raw = read_parcels(gpkg_path, egrids=egrids)

    if include_sdr:
        have = set(raw["EGRIS_EGRID"].dropna()) if "EGRIS_EGRID" in raw.columns else set()
        missing = [e for e in egrids if is_valid_egrid(e) and e.upper() not in have]
        if missing and layer_exists(gpkg_path, LAYER_SDR):
            sdr = read_parcels(gpkg_path, egrids=missing, layer=LAYER_SDR)
            if not sdr.empty:
                logger.info("  %d EGRID(s) not in resf resolved from %s (SDR / Baurecht)",
                            sdr["EGRIS_EGRID"].nunique(), LAYER_SDR)
                # Same columns as resf (dprsf has an extra ``Art`` = kind of right).
                sdr = sdr[[c for c in sdr.columns if c in raw.columns]]
                geom_col, crs = raw.geometry.name, raw.crs
                raw = sdr if raw.empty else GeoDataFrame(
                    pd.concat([raw, sdr], ignore_index=True), geometry=geom_col, crs=crs)

    return _dissolve_duplicate_egrids(raw)


def _assign_parcel_keys(gdf: GeoDataFrame) -> tuple[GeoDataFrame, pd.Series]:
    """Give every row a parcel key in ``EGRIS_EGRID``.

    A row without an EGRID (NULL or blank — about 18'500 parcels in the national
    AV data, most of them in TI) gets the internal key ``fid:<fid>``, so it stays a
    parcel of its own: grouping by a missing key would drop it, grouping by ``""``
    would dissolve all such parcels of a municipality into one. The key is turned
    back into an empty ``egrid`` when the output is written.

    Returns the frame and the mask of the rows that had no EGRID.
    """
    egrid = gdf["EGRIS_EGRID"]
    no_egrid = egrid.isna() | (egrid.astype(str).str.strip() == "")
    if no_egrid.any():
        gdf = gdf.copy()
        if not (pd.api.types.is_object_dtype(egrid) or pd.api.types.is_string_dtype(egrid)):
            gdf["EGRIS_EGRID"] = gdf["EGRIS_EGRID"].astype(object)  # an all-NULL column
        fids = gdf.loc[no_egrid, "fid"] if "fid" in gdf.columns else gdf.index[no_egrid]
        gdf.loc[no_egrid, "EGRIS_EGRID"] = [f"{NO_EGRID_KEY_PREFIX}{f}" for f in fids]
    return gdf, no_egrid


def _sum_or_missing(values: pd.Series):
    """Sum, staying missing when every value is missing."""
    return values.sum(min_count=1)


def _join_unique(values: pd.Series) -> str:
    """The distinct non-missing values, sorted and joined with ``; ``."""
    return "; ".join(sorted({str(v) for v in values.dropna()}))


def _dissolve_duplicate_egrids(gdf: GeoDataFrame) -> GeoDataFrame:
    """Dissolve multiple fid entries per EGRIS_EGRID into one row.

    Sets ``Check_EGRID`` with the appropriate status message. In a merged parcel
    the official area (``Flaeche``) is the **sum** of its rows and ``Nummer`` lists
    every distinct parcel number — the AV data carries both per row (per part);
    the other attributes are taken from the first row. Rows without an EGRID are
    never dissolved (see :func:`_assign_parcel_keys`).
    """
    if gdf.empty:
        gdf["Check_EGRID"] = pd.Series(dtype=str)
        return gdf

    gdf, no_egrid = _assign_parcel_keys(gdf)
    no_egrid_keys = set(gdf.loc[no_egrid, "EGRIS_EGRID"])

    counts = gdf.groupby("EGRIS_EGRID").size()

    # For EGRIDs with a single entry, keep as-is
    single_egrids = counts[counts == 1].index
    singles = gdf[gdf["EGRIS_EGRID"].isin(single_egrids)].copy()
    singles["Check_EGRID"] = MSG_EGRID_FOUND
    if no_egrid_keys:
        singles.loc[singles["EGRIS_EGRID"].isin(no_egrid_keys), "Check_EGRID"] = MSG_EGRID_NO_EGRID

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
    agg: dict = {c: "first" for c in non_geom}
    if COL_FLAECHE in agg:
        agg[COL_FLAECHE] = _sum_or_missing
    if "Nummer" in agg:
        agg["Nummer"] = _join_unique
    dissolved = multis.dissolve(by="EGRIS_EGRID", aggfunc=agg).reset_index()

    dissolved["Check_EGRID"] = MSG_EGRID_MERGED

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

    with closing(connect_readonly(gpkg_str)) as conn:
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

    parcel_id = parcel.get("EGRID", parcel.get("EGRIS_EGRID", "?"))

    # Repair the invalid land-cover features first (valid ones are not touched).
    # GEOS does not reliably refuse an invalid input: a self-intersecting ring can
    # raise — or return a geometry with a wrong area, silently (a 100 m² polygon
    # with a zero-width spike clipped to 800 m²).
    lc_geoms = np.array(lcsf.geometry.values, dtype=object)
    invalid = ~shapely.is_valid(lc_geoms) & ~shapely.is_missing(lc_geoms)
    if invalid.any():
        for i in np.flatnonzero(invalid):
            lc_geoms[i] = extract_polygons(shapely.make_valid(lc_geoms[i]))
        logger.warning("  %d invalid land cover feature(s) of parcel %s repaired before clipping",
                       int(invalid.sum()), parcel_id)

    # Vectorised intersection (replaces gpd.overlay for single-parcel case).
    # Fail-soft: a GEOS error on one land-cover feature must drop only that
    # feature, not abort the run — retry per feature on failure.
    try:
        clipped_geoms = shapely.intersection(lc_geoms, parcel_geom)
    except Exception:  # noqa: BLE001 — GEOSException on degenerate input
        clipped_geoms = []
        n_failed = 0
        for g in lc_geoms:
            try:
                clipped_geoms.append(shapely.intersection(g, parcel_geom))
            except Exception:  # noqa: BLE001
                clipped_geoms.append(None)  # dropped by filter_clip_results
                n_failed += 1
        logger.warning("  Clip failed for %d land cover feature(s) of parcel %s — dropped",
                       n_failed, parcel_id)

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

    # Classify VBS (Kategorie a–d, biological productivity, Typ 1/2). Typ is only
    # assigned within biologically productive area — unproductive rows stay blank.
    result[COL_VBS_KATEGORIE] = result["Art"].map(VBS_KATEGORIE_BY_ART).fillna(DEFAULT_VBS_KATEGORIE)
    result[COL_VBS_PRODUKTIV] = result["Art"].map(VBS_PRODUKTIV_BY_ART).fillna(DEFAULT_VBS_PRODUKTIV)
    result[COL_VBS_TYP] = result["Art"].map(VBS_TYP_BY_ART).fillna(DEFAULT_VBS_TYP)

    # Build output (keep geometry for optional layer analyses; dropped at CSV export)
    output_cols = ["ID", "EGRID", "fid", "Art", "BFSNr", "GWR_EGID", "Check_GreenSpace",
                   COL_VBS_KATEGORIE, COL_VBS_PRODUKTIV, COL_VBS_TYP, "area_m2", "geometry"]
    output_cols = [c for c in output_cols if c in result.columns]
    return result[output_cols].reset_index(drop=True)


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

def _join_green_inventory(df: DataFrame, source: str | None) -> DataFrame:
    """Add ``greeninv`` (``yes`` / ``no``) by matching ``egrid`` then ``id`` against the
    green inventory parcel list (public URL by default, or a URL / local GeoJSON).
    The column stays empty when the list cannot be loaded."""
    import api

    try:
        index = api.load_green_inventory(source)
    except Exception as e:  # network / parse error: degrade, do not abort the run
        logger.warning("Green inventory unavailable (%s): the greeninv column stays empty", e)
        df["greeninv"] = ""
        return df
    blank = pd.Series([""] * len(df), index=df.index)
    ids = df["id"].fillna("").astype(str) if "id" in df.columns else blank
    egs = df["egrid"].fillna("").astype(str) if "egrid" in df.columns else blank
    df["greeninv"] = [api.green_inventory_flag(index, i, e) for i, e in zip(ids, egs)]
    logger.info("Green inventory: %d of %d parcels covered", int((df["greeninv"] == "yes").sum()), len(df))
    return df


def _lowercase_schema(df: DataFrame) -> DataFrame:
    """Final output schema: lowercase every column id except passthrough ``input_*``.

    The aggregate / per-type / detail columns are already produced lowercase; this
    catches the static identifier/QA columns (ID, EGRID, Nummer, BFSNr, Check_EGRID,
    Flaeche, GWR_EGID, Art, Check_GreenSpace) and — by generalizing over *all*
    columns rather than an allowlist — any future capitalized output column too, so
    none can silently ship mis-cased. User passthrough columns keep their original
    casing (only the ``input_`` prefix is lowercase).
    """
    return df.rename(columns={
        c: c.lower() for c in df.columns
        if c != c.lower() and not c.startswith("input_")
    })


def _to_int64(values: pd.Series) -> pd.Series:
    """Whole numbers as nullable integers: a missing value in the column (an EGRID
    that was not found) must not turn every other value into ``4436.0``."""
    return pd.to_numeric(values, errors="coerce").round().astype("Int64")


def _finalize_output(df: DataFrame) -> DataFrame:
    """Parcels / land-cover frame → the frame that is written.

    - geometry dropped;
    - ``BFSNr`` / ``Flaeche`` as integers (empty where missing);
    - the internal ``fid:<fid>`` key of a parcel without EGRID removed from
      ``EGRID`` (it stays in ``ID``);
    - column ids lowercased.
    """
    df = DataFrame(df.drop(columns=["geometry"], errors="ignore"))
    for col in ("BFSNr", COL_FLAECHE):
        if col in df.columns:
            df[col] = _to_int64(df[col])
    if "EGRID" in df.columns and len(df):
        synthetic = df["EGRID"].astype(str).str.startswith(NO_EGRID_KEY_PREFIX)
        if synthetic.any():
            df.loc[synthetic, "EGRID"] = ""
    return _lowercase_schema(df)


_SIA416_CATEGORIES = ("GGF", "BUF", "UUF")
_DIN277_CATEGORIES = ("BF", "UF")
# VBS Kategorie codes → parcel aggregation column names
_VBS_KAT_COLS = {"kat_a": "av_kat_a_m2", "kat_b": "av_kat_b_m2",
                 "kat_c": "av_kat_c_m2", "kat_d": "av_kat_d_m2"}
_VBS_TYP_COLS = {"typ1": "av_typ1_m2", "typ2": "av_typ2_m2"}


def _resolved(parcels_df: DataFrame) -> pd.Series:
    """Mask of the parcel rows that resolved to a geometry. Only these get ``0``
    in an area column they have nothing in; the others (EGRID not found, row not
    processed) keep an empty cell — "not found" is not "0 m²"."""
    if "parcel_area_m2" not in parcels_df.columns:
        return pd.Series(True, index=parcels_df.index)
    return parcels_df["parcel_area_m2"].notna()


def _aggregate_landcover(
    parcels_df: DataFrame,
    lc_df: DataFrame,
) -> DataFrame:
    """Add per-parcel land cover area summary columns to the parcels output.

    Columns added (lowercase, namespaced — matches the web-app schema):
    - ``sia416_ggf_m2`` / ``sia416_buf_m2`` / ``sia416_uuf_m2`` — SIA 416 breakdown
    - ``din277_bf_m2`` / ``din277_uf_m2`` — DIN 277
    - ``sealed_m2`` — sealed (GGF + befestigt); ``greenspace_m2`` — humusiert + bestockt
    - ``av_produktiv_m2`` / ``av_unproduktiv_m2`` / ``av_kat_a_m2``…``d`` / ``av_typ1_m2`` / ``av_typ2_m2``
    - ``av_<art>_m2`` — one column per AV land-cover type present (e.g. ``av_gebaeude_m2``)

    A parcel that was found gets ``0`` where it has no such land cover; a parcel
    that was not found keeps every one of these cells empty.
    """
    sia_cols = [f"sia416_{c.lower()}_m2" for c in _SIA416_CATEGORIES]
    din_cols = [f"din277_{c.lower()}_m2" for c in _DIN277_CATEGORIES]
    av_kat_cols = list(_VBS_KAT_COLS.values())
    av_typ_cols = list(_VBS_TYP_COLS.values())
    fixed_cols = (
        sia_cols + din_cols
        + ["sealed_m2", "greenspace_m2", "av_produktiv_m2", "av_unproduktiv_m2"]
        + av_kat_cols + av_typ_cols
    )

    if lc_df.empty:
        zero_or_empty = np.where(_resolved(parcels_df), 0.0, np.nan)
        for col in fixed_cols:
            parcels_df[col] = zero_or_empty
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
        .rename(columns={"area_m2": "sealed_m2"})
    )

    # --- Green space ---
    lc["green"] = lc["Art"].map(GREEN_SPACE)
    green = (
        lc[lc["green"].notna()]
        .groupby("EGRID")["area_m2"]
        .sum()
        .reset_index()
        .rename(columns={"area_m2": "greenspace_m2"})
    )

    # --- VBS biological productivity ---
    lc["VBS_PRODUKTIV"] = lc["Art"].map(VBS_PRODUKTIV).fillna("unproduktiv")
    av_produktiv = (
        lc[lc["VBS_PRODUKTIV"] == "produktiv"]
        .groupby("EGRID")["area_m2"]
        .sum()
        .reset_index()
        .rename(columns={"area_m2": "av_produktiv_m2"})
    )
    av_unproduktiv = (
        lc[lc["VBS_PRODUKTIV"] == "unproduktiv"]
        .groupby("EGRID")["area_m2"]
        .sum()
        .reset_index()
        .rename(columns={"area_m2": "av_unproduktiv_m2"})
    )

    # --- VBS Kategorie pivot (a–d) ---
    lc["VBS_KAT"] = lc["Art"].map(VBS_KATEGORIE).fillna("kat_d")
    av_kat_pivot = (
        lc.groupby(["EGRID", "VBS_KAT"])["area_m2"]
        .sum()
        .unstack(fill_value=0.0)
    )
    for code in _VBS_KAT_COLS:
        if code not in av_kat_pivot.columns:
            av_kat_pivot[code] = 0.0
    av_kat_pivot = av_kat_pivot[list(_VBS_KAT_COLS)]
    av_kat_pivot.columns = list(_VBS_KAT_COLS.values())
    av_kat_pivot = av_kat_pivot.reset_index()

    # --- VBS Typ pivot (Typ 1 / Typ 2 — biologically productive only) ---
    lc["VBS_TYP_CODE"] = lc["Art"].map(VBS_TYP)  # NaN for unproductive types
    av_typ_only = lc[lc["VBS_TYP_CODE"].notna()]
    av_typ_pivot = (
        av_typ_only.groupby(["EGRID", "VBS_TYP_CODE"])["area_m2"]
        .sum()
        .unstack(fill_value=0.0)
    )
    for code in _VBS_TYP_COLS:
        if code not in av_typ_pivot.columns:
            av_typ_pivot[code] = 0.0
    av_typ_pivot = av_typ_pivot[list(_VBS_TYP_COLS)]
    av_typ_pivot.columns = list(_VBS_TYP_COLS.values())
    av_typ_pivot = av_typ_pivot.reset_index()

    # --- Per-Art pivot ---
    art_pivot = (
        lc.groupby(["EGRID", "Art"])["area_m2"]
        .sum()
        .unstack(fill_value=0.0)
    )
    art_pivot.columns = [f"av_{str(a).lower()}_m2" for a in art_pivot.columns]
    art_pivot = art_pivot.reset_index()

    # --- Merge all onto parcels ---
    result = parcels_df
    result = result.merge(sia_pivot, on="EGRID", how="left")
    result = result.merge(din_pivot, on="EGRID", how="left")
    result = result.merge(versiegelt, on="EGRID", how="left")
    result = result.merge(green, on="EGRID", how="left")
    result = result.merge(av_produktiv, on="EGRID", how="left")
    result = result.merge(av_unproduktiv, on="EGRID", how="left")
    result = result.merge(av_kat_pivot, on="EGRID", how="left")
    result = result.merge(av_typ_pivot, on="EGRID", how="left")
    result = result.merge(art_pivot, on="EGRID", how="left")

    # 0 for a found parcel without that land cover — aggregate columns only, and
    # only where the parcel resolved: an unfound EGRID keeps empty cells here just
    # as in parcel_area_m2 ("not found" ≠ "0 m²"). User passthrough columns
    # (input_*) are never ours to fill.
    agg_cols = [
        col for col in result.columns
        if col.endswith("_m2") and col != "parcel_area_m2" and not col.startswith("input_")
    ]
    found = _resolved(result)
    result.loc[found, agg_cols] = result.loc[found, agg_cols].fillna(0.0)

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
    return DataFrame(out[available].reset_index(drop=True))


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


def _habitat_group_label(typoch_de) -> str:
    """Habitat group of a TypoCH label: level 2 ('6.3.1 Buchenwald' → '6.3 Andere
    Laubwälder'), or level 1 for a label that has only one level ('9 …') — as the
    api source does. '' when there is no label (reported as '?')."""
    return typoch_l2_label(typoch_de) or typoch_l1_label(typoch_de)


def _group_names(names: pd.Series, name_fn=None) -> pd.Series:
    """Feature names → the group names used for the joined list AND the per-type
    columns (so the two cannot diverge). A missing or empty name becomes ``"?"``
    (as in the api source) — a groupby on a missing key would lose its area."""
    def one(value) -> str:
        text = "" if value is None or (isinstance(value, float) and value != value) else str(value)
        if name_fn is not None:
            text = name_fn(text) or ""
        return text.strip() or "?"
    return names.map(one)


def _fetch_for_parcel(
    geom,
    egrid: str,
    cfg: LayerConfig,
) -> tuple[GeoDataFrame, dict] | None:
    """Fetch API features for one parcel geometry (thread-safe).

    Returns ``None`` when there is nothing to ask (no geometry), else
    ``(features, info)`` with ``info = {"error", "truncated", "dropped"}``. A
    failed request is ``error = True`` with no features — never "no features".
    """
    if geom is None or geom.is_empty:
        return None
    if not geom.is_valid:
        geom = shapely.make_valid(geom)

    try:
        features, info = fetch_features_with_status(geom, cfg, context=egrid)
        return features, {"error": False, **info}
    except Exception as e:  # noqa: BLE001 — IdentifyError, or anything else: flag the parcel
        logger.warning("%s — request failed for EGRID %s: %s", cfg.layer_id, egrid, e)
        return GeoDataFrame(), {"error": True, "truncated": False, "dropped": 0}


def _run_layer_analysis(
    cfg: LayerConfig,
    label: str,
    parcels_gdf: GeoDataFrame,
    parcels_out: DataFrame,
    lc_out: DataFrame,
    name_fn=None,
    wall_to_wall: bool = False,
) -> tuple[DataFrame, DataFrame]:
    """Intersect parcels and green spaces with a Swisstopo layer.

    Phase 1: Parallel API fetch per parcel → cache by EGRID.
    Phase 2: Local intersection of parcels with cached features.
    Phase 3: Local intersection of green-space land covers with cached features
             (grouped by EGRID to avoid per-row GeoDataFrame overhead).

    Adds to the parcels: ``{label}`` / ``{label}_m2`` (joined names / areas),
    ``check_{label}`` and one ``{label}_{slug}_m2`` per group.

    ``check_{label}``: ``ok`` · ``partial`` (a feature came without geometry; for
    a *wall_to_wall* layer only when that leaves a real gap) · ``truncated`` ·
    ``error`` (request failed) · empty (parcel not found — not asked). On
    ``error`` every overlay column of the parcel stays **empty**; ``0`` in a
    per-group column means "asked, nothing there".
    """
    n_parcels = len(parcels_gdf)
    name_col = list(cfg.column_map.values())[0]

    # --- Phase 1: Fetch layer features per parcel (parallel API calls) ---
    logger.info("%s — Step 1/3: Fetching %s features for %d parcels …",
                label, cfg.layer_id, n_parcels)
    t0 = time.time()

    fetched: dict[str, tuple[GeoDataFrame, dict] | None] = {}
    pool = ThreadPoolExecutor(max_workers=API_MAX_WORKERS)
    try:
        futures: dict = {}
        for _, row in parcels_gdf.iterrows():
            egrid = row.get("EGRID", "")
            fut = pool.submit(_fetch_for_parcel, row.geometry, egrid, cfg)
            futures[fut] = egrid

        done = 0
        for fut in as_completed(futures):
            done += 1
            egrid = futures[fut]
            fetched[egrid] = fut.result()
            if done % 50 == 0 or done == n_parcels:
                eta = _fmt_eta(time.time() - t0, done, n_parcels)
                logger.info("%s — Step 1/3: Fetched %d/%d parcels (%s)",
                            label, done, n_parcels, eta)
    except BaseException:
        # Ctrl-C (or any error): do not wait for the queued requests — a plain
        # ``with`` block would run every one of them before leaving.
        pool.shutdown(wait=False, cancel_futures=True)
        raise
    pool.shutdown(wait=True)

    # --- Phase 2: Intersect parcels with cached features (local) ---
    logger.info("%s — Step 2/3: Intersecting %d parcels …", label, n_parcels)

    parcel_results: list[dict] = []
    check: dict[str, str] = {}
    for _, row in parcels_gdf.iterrows():
        egrid = row.get("EGRID", "")
        result = fetched.get(egrid)
        if result is None:
            continue  # no geometry — not asked
        features, info = result
        if info["error"]:
            check[egrid] = CHECK_ERROR
            continue
        covered = 0.0
        if not features.empty:
            row_gdf = GeoDataFrame(
                [{col: row[col] for col in row.index} | {"geometry": row.geometry}],
                geometry="geometry", crs=CRS_STRING,
            )
            hits = intersect_with_features(row_gdf, features, cfg, id_cols=["ID", "EGRID"])
            parcel_results.extend(h.to_dict() for _, h in hits.iterrows())
            covered = float(hits["intersection_area_m2"].sum()) if len(hits) else 0.0
        if info["truncated"]:
            check[egrid] = CHECK_TRUNCATED
        elif info["dropped"] and (
            not wall_to_wall
            or row.geometry.area - covered > row.geometry.area * OVERLAY_GAP_MIN_FRAC
        ):
            check[egrid] = CHECK_PARTIAL
        else:
            check[egrid] = CHECK_OK

    for status in (CHECK_ERROR, CHECK_TRUNCATED, CHECK_PARTIAL):
        n = sum(1 for v in check.values() if v == status)
        if n:
            logger.warning("%s — %d parcel(s) with check_%s = %s", label, n, label, status)

    raw_parcels = DataFrame(parcel_results) if parcel_results else DataFrame()
    parcel_agg = _aggregate_layer_results(raw_parcels, "EGRID", name_col, label, name_fn=name_fn)
    parcels_out = parcels_out.merge(parcel_agg, on="EGRID", how="left")
    parcels_out[f"{label}"] = parcels_out[f"{label}"].fillna("")
    parcels_out[f"{label}_m2"] = parcels_out[f"{label}_m2"].fillna("")
    parcels_out[f"check_{label}"] = parcels_out["EGRID"].map(check).fillna("")

    # Per-type area columns: {label}_{slug}_m2. The slug is derived from the SAME
    # grouping (name_fn) as the joined names above, so the two can't diverge. A
    # parcel whose overlay answered gets 0 where it has no such type; a parcel that
    # was not asked or whose request failed keeps the cell empty.
    pertype = _aggregate_layer_pertype(raw_parcels, "EGRID", name_col, label, name_fn=name_fn)
    pertype_cols = [c for c in pertype.columns if c != "EGRID"]
    if pertype_cols:
        parcels_out = parcels_out.merge(pertype, on="EGRID", how="left")
        answered = parcels_out[f"check_{label}"].isin(_CHECK_ANSWERED)
        parcels_out.loc[answered, pertype_cols] = parcels_out.loc[answered, pertype_cols].fillna(0.0)

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
                result = fetched.get(egrid)
                features = result[0] if result is not None else None
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
            # Land-cover rows carry the features' own names (not grouped by name_fn).
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
    name_fn=None,
) -> DataFrame:
    """Aggregate intersection results into semicolon-separated arrays per parcel
    (*group_key* ``"EGRID"``) or per green-space land cover (``["EGRID", "fid"]``).

    Names are first mapped to their group (:func:`_group_names` — e.g. the habitat
    TypoCH level-2 grouping; identity for Bauzonen), then **deduplicated and
    area-summed per group** so ``{label}`` (names) shares the exact grouping of the
    per-type ``{label}_{slug}_m2`` columns. The exact piece areas are summed and
    only the sums are rounded. Produces, largest area first:
    - ``{label}`` — semicolon-separated group names
    - ``{label}_m2`` — semicolon-separated summed areas (1 decimal)
    """
    keys = [group_key] if isinstance(group_key, str) else list(group_key)
    if raw.empty:
        return DataFrame(columns=keys + [label, f"{label}_m2"])

    df = raw[keys + [name_col, "intersection_area_m2"]].copy()
    df[name_col] = _group_names(df[name_col], name_fn)
    # Sum area per (parcel, group name), largest first.
    by = (
        df.groupby(keys + [name_col])["intersection_area_m2"]
        .sum()
        .reset_index()
        .sort_values(keys + ["intersection_area_m2"], ascending=[True] * len(keys) + [False])
    )

    def _join_names(s):
        return "; ".join(str(v) for v in s)

    def _join_areas(s):
        return "; ".join(to_fixed_1(v) for v in s)

    grouped = by.groupby(keys, sort=False).agg(
        **{
            label: (name_col, _join_names),
            f"{label}_m2": ("intersection_area_m2", _join_areas),
        }
    ).reset_index()

    return grouped


def _aggregate_layer_pertype(
    raw: DataFrame,
    group_key: str,
    name_col: str,
    label: str,
    name_fn=None,
) -> DataFrame:
    """Per-type area columns for an overlay: one ``{label}_{slug}_m2`` per group
    (Bauzonen: the zone name slugified; Habitat: the TypoCH group label slugified —
    the same groups as :func:`_aggregate_layer_results`). The exact piece areas are
    summed, then rounded to 0.01 m².
    """
    if raw.empty:
        return DataFrame(columns=[group_key])
    df = raw[[group_key, name_col, "intersection_area_m2"]].copy()
    df["_key"] = _group_names(df[name_col], name_fn).map(slugify)
    pivot = (
        df.groupby([group_key, "_key"])["intersection_area_m2"]
        .sum()
        .unstack(fill_value=0.0)
        .round(2)
    )
    pivot.columns = [f"{label}_{k}_m2" for k in pivot.columns]
    return pivot.reset_index()
