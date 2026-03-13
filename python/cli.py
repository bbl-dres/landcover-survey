"""Command-line interface."""

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
        "--mode",
        type=int,
        choices=[1, 2],
        default=1,
        help="1 = user-provided parcel list, 2 = all parcels from GeoPackage (default: 1)",
    )
    parser.add_argument(
        "--input",
        dest="input_path",
        help="Path to user CSV or Excel file (required for Mode 1)",
    )
    parser.add_argument(
        "--gpkg",
        default=str(DEFAULT_GPKG_PATH),
        help=f"Path to the AV GeoPackage (default: {DEFAULT_GPKG_PATH})",
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Output directory for CSV result files (default: same directory as input file, or ./data for Mode 2)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Limit number of parcels to process (for testing). Mode 1: first N rows, Mode 2: first N municipalities.",
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=10000,
        help="Mode 1: number of rows per processing chunk (default: 10000)",
    )
    parser.add_argument(
        "--no-aggregate",
        action="store_true",
        help="Disable land cover area aggregation on the parcels output (aggregation is ON by default)",
    )
    parser.add_argument(
        "--no-parcels",
        action="store_true",
        help="Skip exporting the parcels CSV (exported by default)",
    )
    parser.add_argument(
        "--no-landcover",
        action="store_true",
        help="Skip exporting the land cover CSV (exported by default)",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Enable verbose (DEBUG) logging",
    )

    args = parser.parse_args(argv)

    # Validate Mode 1 requires --input
    if args.mode == 1 and args.input_path is None:
        parser.error("Mode 1 requires --input <path to CSV or Excel file>")

    # Resolve output directory: default to input file's parent (Mode 1) or ./data (Mode 2)
    if args.output_dir is not None:
        output_dir = Path(args.output_dir)
    elif args.input_path is not None:
        output_dir = Path(args.input_path).resolve().parent
    else:
        output_dir = Path("./data")
    output_dir.mkdir(parents=True, exist_ok=True)

    # Single timestamp for all output files (log + CSVs)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    prefix = Path(args.input_path).stem + "_" if args.input_path else ""

    # Configure logging — console + log file in output directory
    level = logging.DEBUG if args.verbose else logging.INFO
    log_format = "%(asctime)s %(levelname)-8s %(name)s — %(message)s"
    date_format = "%H:%M:%S"

    handlers: list[logging.Handler] = [
        logging.StreamHandler(),
        logging.FileHandler(
            output_dir / f"{prefix}{ts}.log",
            mode="w",
            encoding="utf-8",
        ),
    ]

    logging.basicConfig(
        level=level,
        format=log_format,
        datefmt=date_format,
        handlers=handlers,
    )

    logger = logging.getLogger(__name__)
    logger.info(
        "Landcover Survey started — mode=%d, output=%s%s",
        args.mode,
        output_dir,
        f", limit={args.limit}" if args.limit else "",
    )

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
    )


if __name__ == "__main__":
    main()
