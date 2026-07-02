"""
Landcover Survey
================
Aggregate land cover usage (m²) per Swiss cadastral parcel.

Two sources (``--source``):

- ``api`` (default) — **web parity**: fetches parcels + land cover + overlays live
  from the same geo.admin.ch / geodienste.ch services the web app uses, in
  EPSG:4326 with the Turf area port, and exports GeoJSON + Excel (+ CSV). Input is
  one or more EGRIDs (``--egrid``) or an optional CSV/Excel list (``--input``).
- ``gpkg`` — offline batch from a local AV GeoPackage (Shapely / exact planar
  areas, full cantonal coverage). CSV output. The original CLI behaviour.

Usage
-----
    # API path (default): single parcel or a list
    python main.py --egrid CH427760110057
    python main.py --egrid CH427760110057,CH690292570744 --output-dir ./out
    python main.py --input parcels.csv                    # CSV/Excel with ID, EGRID

    # GeoPackage path (offline)
    python main.py --source gpkg --input parcels.csv
    python main.py --source gpkg --mode 2 --limit 5

Run  python main.py --help  for all options.
"""

from __future__ import annotations

import argparse
import logging
from datetime import datetime
from pathlib import Path

from config import DEFAULT_GPKG_PATH


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="landcover-survey",
        description="Aggregate land cover usage (m²) per Swiss cadastral parcel.",
    )

    parser.add_argument(
        "--source", choices=["api", "gpkg"], default="api",
        help="Data source: 'api' (default, web-parity live services) or 'gpkg' (local GeoPackage)",
    )

    # --- Input ---
    parser.add_argument(
        "--egrid", dest="egrid",
        help="(api) One or more EGRIDs, comma-separated (e.g. CH427760110057,CH690292570744)",
    )
    parser.add_argument(
        "--input", dest="input_path",
        help="Path to a CSV/Excel with ID + EGRID columns (api: optional list; gpkg Mode 1: required)",
    )
    parser.add_argument(
        "--output-dir", default=None,
        help="Output directory (default: input file's dir, else ./data)",
    )
    parser.add_argument(
        "--limit", type=int, default=None,
        help="Process only the first N rows (api / gpkg Mode 1) or N municipalities (gpkg Mode 2)",
    )

    # --- GeoPackage source options ---
    parser.add_argument(
        "--gpkg", default=str(DEFAULT_GPKG_PATH),
        help=f"(gpkg) Path to the AV GeoPackage (default: {DEFAULT_GPKG_PATH})",
    )
    parser.add_argument(
        "--mode", type=int, choices=[1, 2], default=1,
        help="(gpkg) 1 = user parcel list, 2 = all parcels (default: 1)",
    )
    parser.add_argument(
        "--chunk-size", type=int, default=10000,
        help="(gpkg) Mode 1: rows per processing chunk (default: 10000)",
    )
    parser.add_argument("--bauzonen", action="store_true", help="(gpkg) Intersect with Bauzonen")
    parser.add_argument("--habitat", action="store_true", help="(gpkg) Intersect with BAFU Lebensraumkarte")
    parser.add_argument("--no-aggregate", action="store_true", help="(gpkg) Skip area aggregation on parcels")
    parser.add_argument("--no-parcels", action="store_true", help="(gpkg) Skip parcels CSV export")
    parser.add_argument("--no-landcover", action="store_true", help="(gpkg) Skip land cover CSV export")

    # --- API source options (overlays default ON, matching the web app) ---
    parser.add_argument("--no-bauzonen", action="store_true", help="(api) Disable the Bauzonen overlay")
    parser.add_argument("--no-habitat", action="store_true", help="(api) Disable the BAFU habitat overlay")
    parser.add_argument("--no-synthetic", action="store_true", help="(api) Disable the synthetic-AV fallback")
    parser.add_argument("--no-geojson", action="store_true", help="(api) Skip the GeoJSON export")
    parser.add_argument("--no-xlsx", action="store_true", help="(api) Skip the Excel export")
    parser.add_argument("--no-csv", action="store_true", help="(api) Skip the parcels/land-cover CSV export")

    parser.add_argument("--verbose", "-v", action="store_true", help="Enable DEBUG logging")

    args = parser.parse_args(argv)

    # --- Validate input per source ---
    if args.source == "api":
        if not args.egrid and not args.input_path:
            parser.error("--source api requires --egrid <EGRID[,EGRID…]> or --input <file>")
    else:  # gpkg
        if args.mode == 1 and args.input_path is None:
            parser.error("--source gpkg --mode 1 requires --input <path to CSV or Excel file>")

    # --- Resolve output directory ---
    if args.output_dir is not None:
        output_dir = Path(args.output_dir)
    elif args.input_path is not None:
        output_dir = Path(args.input_path).resolve().parent
    else:
        output_dir = Path("./data")
    output_dir.mkdir(parents=True, exist_ok=True)

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    prefix = Path(args.input_path).stem + "_" if args.input_path else ""

    # --- Logging (console + file) ---
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-8s %(name)s — %(message)s",
        datefmt="%H:%M:%S",
        handlers=[
            logging.StreamHandler(),
            logging.FileHandler(output_dir / f"{prefix}{ts}.log", mode="w", encoding="utf-8"),
        ],
    )
    logger = logging.getLogger(__name__)
    logger.info("Landcover Survey started — source=%s, output=%s%s",
                args.source, output_dir, f", limit={args.limit}" if args.limit else "")

    if args.source == "api":
        _run_api(args, output_dir, ts, prefix, logger)
    else:
        _run_gpkg(args, output_dir, ts)


# ---------------------------------------------------------------------------
# API path
# ---------------------------------------------------------------------------

def _build_rows(args, logger) -> list[dict]:
    """Build ``[{"id","egrid", …extras}]`` rows from --egrid or --input."""
    if args.input_path:
        rows = _read_input_rows(args.input_path)
        if args.limit is not None:
            rows = rows[:args.limit]
        return rows

    egrids = [e.strip() for e in args.egrid.split(",") if e.strip()]
    if args.limit is not None:
        egrids = egrids[:args.limit]
    return [{"id": e, "egrid": e} for e in egrids]


def _read_input_rows(path: str) -> list[dict]:
    """Read an ID/EGRID list via the shared reader (:mod:`user_input`) — the same
    contract as the web upload and the gpkg pipeline: delimiter auto-detection +
    ``sep=`` hint, UTF-8 BOM, case-insensitive required ``id``/``egrid`` columns,
    headers lowercased so the ``input_<col>`` ids line up with the web."""
    from user_input import read_rows

    return read_rows(path)


def _run_api(args, output_dir: Path, ts: str, prefix: str, logger) -> None:
    import processor_web
    import export_web

    try:
        rows = _build_rows(args, logger)
    except ValueError as e:
        logger.error(str(e))
        raise SystemExit(1)
    if not rows:
        logger.error("No EGRIDs to process.")
        raise SystemExit(1)

    options = {
        "bauzonen": not args.no_bauzonen,
        "habitat": not args.no_habitat,
        "synthLandcover": not args.no_synthetic,
    }
    logger.info("Processing %d parcel(s) via live services (bauzonen=%s, habitat=%s, synthetic=%s)",
                len(rows), options["bauzonen"], options["habitat"], options["synthLandcover"])

    def on_progress(p):
        if p["processed"] % 25 == 0 or p["processed"] == p["total"]:
            logger.info("  %d/%d processed (%d found)", p["processed"], p["total"], p["succeeded"])

    results = processor_web.process_rows(rows, options, on_progress=on_progress)

    n_found = sum(1 for p in results["parcels"] if processor_web.is_found(p["check_egrid"]))
    logger.info("Processed %d parcels (%d found); %d land-cover, %d bauzonen, %d habitat rows",
                len(results["parcels"]), n_found, len(results["landcover"]),
                len(results["bauzonen"]), len(results["habitat"]))

    if not args.no_geojson:
        export_web.write_geojson(results, output_dir / f"{prefix}{ts}.geojson")
    if not args.no_xlsx:
        export_web.write_xlsx(results, output_dir / f"{prefix}{ts}.xlsx")
    if not args.no_csv:
        export_web.write_parcels_csv(results["parcels"], output_dir / f"{prefix}parcels_{ts}.csv")
        export_web.write_landcover_csv(results["landcover"], output_dir / f"{prefix}landcover_{ts}.csv")

    logger.info("Done → %s", output_dir)


# ---------------------------------------------------------------------------
# GeoPackage path (original CLI)
# ---------------------------------------------------------------------------

def _run_gpkg(args, output_dir: Path, ts: str) -> None:
    from pipeline import run

    run(
        mode=args.mode,
        input_path=args.input_path,
        gpkg_path=args.gpkg,
        output_dir=str(output_dir),
        limit=args.limit,
        chunk_size=args.chunk_size,
        ts=ts,
        aggregate=not args.no_aggregate,
        export_parcels=not args.no_parcels,
        export_landcover=not args.no_landcover,
        bauzonen=args.bauzonen,
        habitat=args.habitat,
    )


if __name__ == "__main__":
    main()
