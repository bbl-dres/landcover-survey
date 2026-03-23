"""
Landcover Survey
================
Aggregate land cover usage (m²) per Swiss cadastral parcel
from official survey data (Amtliche Vermessung).

Usage
-----
    python main.py --input parcels.csv
    python main.py --input parcels.csv --bauzonen --habitat
    python main.py --input parcels.csv --bauzonen --habitat --limit 10 -v
    python main.py --mode 2 --limit 5

Required input columns: ID, EGRID.  All other columns are passed through.

Outputs (written next to the input file):
    {input}_parcels_{timestamp}.csv   — per-parcel breakdown (SIA 416, DIN 277)
    {input}_landcover_{timestamp}.csv — per land-cover-clip detail rows

Optional analyses (require internet):
    --bauzonen   Intersect with building zones (ch.are.bauzonen)
    --habitat    Intersect with BAFU habitat map (ch.bafu.lebensraumkarte-schweiz)

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

    # --- Input / output ---
    parser.add_argument(
        "--input", dest="input_path",
        help="Path to user CSV or Excel file (required for Mode 1)",
    )
    parser.add_argument(
        "--gpkg", default=str(DEFAULT_GPKG_PATH),
        help=f"Path to the AV GeoPackage (default: {DEFAULT_GPKG_PATH})",
    )
    parser.add_argument(
        "--output-dir", default=None,
        help="Output directory (default: same as input file, or ./data for Mode 2)",
    )

    # --- Processing options ---
    parser.add_argument(
        "--mode", type=int, choices=[1, 2], default=1,
        help="1 = user-provided parcel list, 2 = all parcels from GeoPackage (default: 1)",
    )
    parser.add_argument(
        "--limit", type=int, default=None,
        help="Process only first N rows (Mode 1) or N municipalities (Mode 2)",
    )
    parser.add_argument(
        "--chunk-size", type=int, default=10000,
        help="Mode 1: rows per processing chunk (default: 10000)",
    )

    # --- Optional analyses ---
    parser.add_argument(
        "--bauzonen", action="store_true",
        help="Intersect with Swisstopo Bauzonen (requires internet)",
    )
    parser.add_argument(
        "--habitat", action="store_true",
        help="Intersect with BAFU Lebensraumkarte (requires internet)",
    )

    # --- Output control ---
    parser.add_argument("--no-aggregate", action="store_true", help="Skip area aggregation on parcels")
    parser.add_argument("--no-parcels", action="store_true", help="Skip parcels CSV export")
    parser.add_argument("--no-landcover", action="store_true", help="Skip land cover CSV export")
    parser.add_argument("--verbose", "-v", action="store_true", help="Enable DEBUG logging")

    args = parser.parse_args(argv)

    if args.mode == 1 and args.input_path is None:
        parser.error("Mode 1 requires --input <path to CSV or Excel file>")

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
    logger.info(
        "Landcover Survey started — mode=%d, output=%s%s",
        args.mode, output_dir,
        f", limit={args.limit}" if args.limit else "",
    )

    # --- Run pipeline ---
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
