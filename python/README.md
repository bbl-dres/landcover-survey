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

- Python >= 3.10
- `api` source: `shapely >= 2.0` (+ `pandas`, `openpyxl` for `--input` / Excel export). Internet access.
- `gpkg` source: `geopandas`, `pandas`, `shapely >= 2.0`, `openpyxl`, and an AV GeoPackage (`av_2056.gpkg`) from [geodienste.ch](https://www.geodienste.ch/services/av).

## Install

```bash
cd python
pip install geopandas pandas shapely openpyxl
```

## Usage

```bash
cd python

# --- api source (default): live services, GeoJSON + Excel + CSV ---
python main.py --egrid CH427760110057                       # single parcel
python main.py --egrid CH427760110057,CH690292570744        # a few parcels
python main.py --input ../data/example.csv --output-dir ./out   # CSV/Excel list of ID,EGRID
python main.py --egrid CH427760110057 --no-bauzonen --no-habitat  # AV land cover only

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

## Data sources & modes

| | `api` (default) | `gpkg` |
|--|-----------------|--------|
| Parcel + land cover | geo.admin.ch `find` + geodienste.ch WFS `ms:LCSF` | Local AV GeoPackage (`resf` / `lcsf`) |
| Overlays | Bauzonen + BAFU habitat, **on by default** (per-parcel `identify`) | `--bauzonen` / `--habitat` (opt-in) |
| Synthetic-AV fallback | on by default (`--no-synthetic` to disable) | none |
| Geometry / area | Shapely in EPSG:4326, **Turf-spherical** area | Shapely in EPSG:2056, exact planar area |
| Coverage | 20 of 26 cantons via public WFS | all cantons |
| Input | `--egrid` list or optional `--input` | `--input` (Mode 1) or all parcels (`--mode 2`) |
| Output | GeoJSON · Excel · CSV | CSV |

The `gpkg` source keeps its two modes: **Mode 1** (`--input` parcel list) and
**Mode 2** (`--mode 2`, all parcels, batched by municipality).

## Cross-check vs. the web app

`compare.py` verifies that an `api`-source export matches the web app's export for
the same parcels:

```bash
# 1. export the same EGRIDs from the web app (Download → GeoJSON) → web.geojson
# 2. run the api source for those EGRIDs → e.g. out/20260701_...geojson
python compare.py web.geojson out/<python>.geojson --rtol 1e-4 --atol 0.02
```

It matches parcels by EGRID (every KPI / flag), then the detail layers per parcel
(feature count + area per `art`), reporting any difference above tolerance. Exit 0 =
match. Because the `api` source ports `turf.area` exactly and clips in the same CRS,
parcel areas agree to floating-point precision for typical parcels.

## Outputs

**`api` source** (written to `--output-dir`, timestamped):

1. **GeoJSON** (`{prefix}{ts}.geojson`) — one `FeatureCollection`; every feature
   tagged `layer` (`parcel` | `landcover` | `bauzonen` | `habitat`). Skip with `--no-geojson`.
2. **Excel** (`{prefix}{ts}.xlsx`) — one sheet per layer. Skip with `--no-xlsx`.
3. **CSV** (`{prefix}parcels_{ts}.csv`, `{prefix}landcover_{ts}.csv`) — semicolon-delimited,
   UTF-8 BOM, matching the web export. Skip with `--no-csv`.

**`gpkg` source** (written next to the input file, timestamped):

1. **Parcels** (`{input}_parcels_{ts}.csv`) — one row per parcel. Disable with `--no-parcels`.
2. **Land Cover** (`{input}_landcover_{ts}.csv`) — one row per clipped piece. Disable with `--no-landcover`.
   Add overlay columns with `--bauzonen` / `--habitat`.

## CLI arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--source {api,gpkg}` | `api` | Data source |
| `--egrid CH…[,CH…]` | — | (api) one or more EGRIDs, comma-separated |
| `--input PATH` | — | CSV/Excel with `ID`,`EGRID` (api: optional; gpkg Mode 1: required) |
| `--output-dir PATH` | *(input dir, else ./data)* | Output directory |
| `--limit N` | *(all)* | First N parcels (api / gpkg Mode 1) or N municipalities (gpkg Mode 2) |
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

| Module | Responsibility |
|--------|----------------|
| `main.py` | CLI: parse args, route to the `api` or `gpkg` path |
| `geom_wgs84.py` | (api) EPSG:4326 geometry — `turf.area` port, clip / union / difference |
| `classify_web.py` | (api) `classify()` + BAFU TypoCH maps (`classify_bafu`, `typoch_to_bbart`) |
| `api.py` | (api) live-service clients (`find`, WFS `ms:LCSF`, `identify`) |
| `processor_web.py` | (api) per-parcel pipeline — port of the web app's `processRows` |
| `export_web.py` | (api) GeoJSON / Excel / CSV writers |
| `compare.py` | cross-check two GeoJSON exports (web vs. Python) |
| `config.py` | shared classification maps + constants |
| `pipeline.py`, `geometry.py`, `data_io.py`, `swisstopo.py`, `bauzonen.py`, `habitat.py` | (gpkg) GeoPackage pipeline |

## Tech stack

| Library | Version | Purpose |
|---------|---------|---------|
| [Shapely](https://shapely.readthedocs.io) | >= 2.0 | Geometry operations (clip, union, `make_valid`) |
| [GeoPandas](https://geopandas.org) | >= 0.14 | (gpkg) GeoPackage I/O, spatial operations |
| [pandas](https://pandas.pydata.org) | >= 2.0 | Tabular data, CSV/Excel I/O |
| [openpyxl](https://openpyxl.readthedocs.io) | — | Excel (.xlsx) read/write |

For the land cover classification, see [CLASSIFICATION](../docs/CLASSIFICATION.md); for inputs/outputs, [DATAMODEL](../docs/DATAMODEL.md); for the processing pipeline, [ARCHITECTURE](../docs/ARCHITECTURE.md). ([docs index](../docs/README.md))
