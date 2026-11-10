# Python CLI

Command-line tool that computes per-parcel land cover areas. Two data sources:

- **`api` (default) — web parity.** Fetches parcels, land cover, and the Bauzonen /
  BAFU overlays live from the **same geo.admin.ch + geodienste.ch services the web
  app uses**, in EPSG:4326 with a port of Turf's spherical area, and exports
  **GeoJSON + Excel (+ CSV)**. Reproduces the web app's results (see
  [Cross-check](#cross-check-vs-the-web-app)). Input is one or more EGRIDs — no
  local data file required.
- **`gpkg` — offline batch.** Computes exact planar areas (LV95 / EPSG:2056) from a
  local AV GeoPackage: full cantonal coverage, fully offline, CSV output. The
  original CLI behaviour.

## Requirements

Python 3.10 or newer, and:

| Package | Needed for |
|---|---|
| `shapely` >= 2.1 | always (geometry) |
| `pandas` >= 2.0, `openpyxl` | `--input` lists and the Excel export |
| `geopandas` >= 0.14 | `gpkg` source only |
| `pytest` >= 7 | tests only (plus Node.js for the web-parity tests) |

```bash
pip install shapely pandas openpyxl geopandas pytest
```

The `api` source needs internet access. The `gpkg` source needs an AV GeoPackage
(`av_2056.gpkg`) from [geodienste.ch](https://www.geodienste.ch/services/av).

## Layout

```
processing-cli/
├── main.py          entry point (the only script in the main folder)
├── src/             the code (cli.py + modules, see below)
├── tests/           pytest suite
├── docs/            TODO.md
├── in/              your input lists (gitignored)
├── out/             results (gitignored, created on the first run)
└── pyproject.toml   package metadata and dependencies
```


## Usage

```bash
cd processing-cli

# --- api source (default): live services, GeoJSON + Excel + CSV ---
python main.py --egrid CH427760110057                       # single parcel
python main.py --egrid CH427760110057,CH690292570744        # a few parcels
python main.py --input ../data/example.csv                  # CSV/Excel list of ID,EGRID
python main.py --input in/my-parcels.xlsx --output-dir D:/results   # another output folder
python main.py --egrid CH427760110057 --no-bauzonen --no-habitat  # AV land cover only
python main.py --input ../data/example.csv --green-inventory         # + greeninv column (yes/no)

# --- gpkg source: offline, from a local GeoPackage ---
python main.py --source gpkg --input ../data/example.csv        # Mode 1: parcel list
python main.py --source gpkg --input ../data/example.csv --limit 10
python main.py --source gpkg --mode 2 --limit 5                 # Mode 2: all parcels
python main.py --source gpkg --input ../data/example.csv --bauzonen --habitat -v
```

An `--input` CSV/Excel must contain **`id` and `egrid`** columns (matched
case-insensitively — the same required-column check as the web upload); it errors
otherwise. Every other column is optional and passed through as `input_<col>`
(headers lowercased, matching the web). The `api` source also accepts `--egrid` with
one or more comma-separated EGRIDs, so no input file is needed.

Put your own lists into `in/` and find the results in `out/`. Both folders are
gitignored, so parcel data stays out of the repository.

## When a service fails (`api` source)

The services answer HTTP 502 in bursts. Each request is retried; parcels whose
query still failed are processed again at the end of the run (two rounds, 20 s
apart). What fails even then is flagged in `check_egrid`, `check_wfs`,
`check_bauzonen` or `check_habitat`, and the CLI prints how many parcels are
affected. Ctrl-C keeps the finished parcels and writes the exports; the
remaining rows are marked `Not processed`.

An EGRID is matched exactly: a shortened or mistyped one ends as `not_found`.

## Data sources & modes

| | `api` (default) | `gpkg` |
|--|-----------------|--------|
| Parcel + land cover | geo.admin.ch `find` + geodienste.ch WFS `ms:LCSF` | Local AV GeoPackage (`resf` / `lcsf`) |
| Overlays | Bauzonen + BAFU habitat, **on by default** (per-parcel `identify`) | `--bauzonen` / `--habitat` (opt-in) |
| Green inventory join | `--green-inventory` (opt-in): `greeninv` = `yes` / `no` by EGRID, else SAP key | same flag, same column |
| Synthetic-AV fallback | on by default (`--no-synthetic` to disable) | none |
| Geometry / area | Shapely in EPSG:4326, **Turf-spherical** area | Shapely in EPSG:2056, exact planar area |
| Coverage | 20 of 26 cantons via public WFS | all cantons |
| Input | `--egrid` list or optional `--input` | `--input` (Mode 1) or all parcels (`--mode 2`) |
| Output | GeoJSON · Excel · CSV | CSV |

The `gpkg` source keeps its two modes: **Mode 1** (`--input` parcel list) and
**Mode 2** (`--mode 2`, all parcels, batched by municipality).

## Cross-check vs. the web app

`src/compare.py` verifies that an `api`-source export matches the web app's export for
the same parcels:

```bash
# 1. export the same EGRIDs from the web app (Download → GeoJSON) → web.geojson
# 2. run the api source for those EGRIDs → e.g. out/20260701_...geojson
python src/compare.py web.geojson out/<python>.geojson --rtol 1e-4 --atol 0.02
```

It matches parcels by `id` + `egrid` (every KPI / flag), then the detail layers per
parcel (feature count, area per `art`, area per feature `fid`), reporting any
difference above tolerance. Exit 0 = match. The `api` source fires the same
requests (same paging and tiling), ports `turf.area` statement for statement —
including the JavaScript engine's own `sin` (`src/fdlibm.py`) — and clips in the same
CRS with the same geometry repair, so parcel columns and feature areas are
identical to the last exported digit; `--rtol 0 --atol 0` is the acceptance level
used by `tests/test_live_parity.py`. The remaining full-precision difference is
the clipper itself (GEOS vs Turf's polyclip-ts: ~1e-8 relative on clipped pieces);
see [docs/reviews/2026-10-28-processing-code-review.md](../docs/reviews/2026-10-28-processing-code-review.md).

## Tests

```bash
cd processing-cli
python -m pytest -q                      # unit + web-parity tests (Node.js needed for the latter)
LANDCOVER_LIVE=1 python -m pytest -q tests/test_live_parity.py   # live services: reproduce a web export bit for bit
cd .. && npm test                        # processing-web/tests (node:test, no dependencies)
```

`tests/test_parity_js.py` evaluates the browser modules (`processing-web/js/config.js`,
`processor.js`) with Node on `tests/fixtures/parity_cases.json` and compares every
table, classifier, label, number format, row shape and aggregation with the Python
modules. `tests/fixtures/live/` holds a web export of eight parcels (overlays on,
green inventory off) for the end-to-end check; re-export it from the web app when
the cadastral data behind it changes.

## Outputs

Everything is written to `out/` (or `--output-dir`), timestamped.

**`api` source:**

1. **GeoJSON** (`{prefix}{ts}.geojson`) — one `FeatureCollection`; every feature
   tagged `layer` (`parcel` | `landcover` | `bauzonen` | `habitat`). Skip with `--no-geojson`.
2. **Excel** (`{prefix}{ts}.xlsx`) — one sheet per layer. Skip with `--no-xlsx`.
3. **CSV** (`{prefix}parcels_{ts}.csv`, `{prefix}landcover_{ts}.csv`) — semicolon-delimited,
   UTF-8 BOM, matching the web export. Skip with `--no-csv`.

**`gpkg` source** (semicolon-delimited, UTF-8 BOM — the same CSV dialect as the
web / `api` export):

1. **Parcels** (`{input}_parcels_{ts}.csv`) — one row per parcel. Disable with `--no-parcels`.
2. **Land Cover** (`{input}_landcover_{ts}.csv`) — one row per clipped piece. Disable with `--no-landcover`.
   Add overlay columns with `--bauzonen` / `--habitat`.

## CLI arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--source {api,gpkg}` | `api` | Data source |
| `--egrid CH…[,CH…]` | — | (api) one or more EGRIDs, comma-separated |
| `--input PATH` | — | CSV/Excel with `ID`,`EGRID` (api: optional; gpkg Mode 1: required) |
| `--output-dir PATH` | `out/` | Output directory |
| `--limit N` | *(all)* | First N parcels (api / gpkg Mode 1) or N municipalities (gpkg Mode 2) |
| `--green-inventory [URL\|FILE]` | off | Add `greeninv` (`yes` / `no`): parcel in the [green inventory](https://github.com/bbl-dres/green-inventory) parcel list, matched by EGRID, else by the SAP key (`id`). Default source: the public file on GitHub Pages |
| `--no-bauzonen` / `--no-habitat` | off | (api) disable an overlay |
| `--no-synthetic` | off | (api) disable the synthetic-AV fallback |
| `--no-geojson` / `--no-xlsx` / `--no-csv` | off | (api) skip an output format |
| `--gpkg PATH` | `D:\AV_lv95\av_2056.gpkg` | (gpkg) path to the AV GeoPackage |
| `--mode {1,2}` | `1` | (gpkg) processing mode |
| `--chunk-size N` | `10000` | (gpkg) rows per chunk (Mode 1) |
| `--bauzonen` / `--habitat` | off | (gpkg) opt-in overlay intersection |
| `--no-aggregate` / `--no-parcels` / `--no-landcover` | off | (gpkg) output control |
| `--verbose`, `-v` | off | DEBUG logging |

## Modules

`main.py` only starts the CLI; everything else is in `src/`.

| Module | Responsibility |
|--------|----------------|
| `cli.py` | CLI: parse args, route to the `api` or `gpkg` path |
| `geom_wgs84.py` | (api) EPSG:4326 geometry — `turf.area` port, clip / union / difference |
| `classify_web.py` | (api) `classify()` + BAFU TypoCH maps (`classify_bafu`, `typoch_to_bbart`) |
| `api.py` | (api) live-service clients (`find`, WFS `ms:LCSF`, `identify`) |
| `processor_web.py` | (api) per-parcel pipeline — port of the web app's `processRows` |
| `export_web.py` | (api) GeoJSON / Excel / CSV writers |
| `compare.py` | cross-check two GeoJSON exports (web vs. Python) |
| `config.py` | shared classification maps + constants |
| `pipeline.py`, `geometry.py`, `data_io.py`, `swisstopo.py`, `bauzonen.py`, `habitat.py` | (gpkg) GeoPackage pipeline |

Open work on the `gpkg` source: [docs/TODO.md](docs/TODO.md).

For the land cover classification, see [CLASSIFICATION](../docs/CLASSIFICATION.md); for inputs/outputs, [DATAMODEL](../docs/DATAMODEL.md); for the processing pipeline, [ARCHITECTURE](../docs/ARCHITECTURE.md). ([docs index](../docs/README.md))
