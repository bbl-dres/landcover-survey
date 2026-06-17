# Python CLI

Open-source command-line tool that computes per-parcel land cover areas locally from the official AV GeoPackage. Exact planar areas (LV95 / EPSG:2056), full cantonal coverage, fully offline.

## Requirements

- Python >= 3.10
- Dependencies: `geopandas`, `pandas`, `shapely >= 2.0`, `openpyxl`
- AV GeoPackage (`av_2056.gpkg`) from [geodienste.ch](https://www.geodienste.ch/services/av)

## Install

```bash
cd python
pip install geopandas pandas shapely openpyxl
```

## Usage

```bash
cd python

# Mode 1: User-provided parcel list
python main.py --mode 1 --input ../data/example.csv

# Mode 1: Test with first 10 parcels
python main.py --mode 1 --input ../data/example.csv --limit 10

# Mode 2: All parcels (batched by BFSNr)
python main.py --mode 2 --limit 5

# With optional analyses
python main.py --mode 1 --input ../data/example.csv --bauzonen --habitat --limit 10 -v
```

## Modes of operation

| Mode | Description | Input |
|------|-------------|-------|
| 1 | User-provided parcel list | CSV or Excel with `ID` and `EGRID` columns |
| 2 | Full survey processing | All parcels from the AV GeoPackage (batched by municipality) |

## CLI arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--mode {1,2}` | `1` | Processing mode |
| `--input PATH` | *(required for Mode 1)* | Path to user CSV or Excel file |
| `--gpkg PATH` | `D:\AV_lv95\av_2056.gpkg` | Path to the AV GeoPackage |
| `--output-dir PATH` | *(input file's directory)* | Output directory |
| `--limit N` | *(all)* | Limit processing for testing |
| `--chunk-size N` | `10000` | Rows per processing chunk (Mode 1) |
| `--no-aggregate` | off | Disable area aggregation columns |
| `--no-parcels` | off | Skip parcels CSV export |
| `--no-landcover` | off | Skip land cover CSV export |
| `--bauzonen` | off | Intersect with [Bauzonen Schweiz](https://map.geo.admin.ch/?layers=ch.are.bauzonen) |
| `--habitat` | off | Intersect with [BAFU Lebensraumkarte](https://map.geo.admin.ch/?layers=ch.bafu.lebensraumkarte-schweiz) |
| `--verbose`, `-v` | off | Enable DEBUG logging |

## Outputs

Written next to the input file, timestamped:

1. **Parcels** (`{input}_parcels_{timestamp}.csv`) — one row per parcel with identifiers, official and calculated area. In Mode 1, includes user-provided columns and error messages for unresolved EGRIDs. Disable with `--no-parcels`.
2. **Land Cover** (`{input}_landcover_{timestamp}.csv`) — one row per clipped land cover feature per parcel, with type, area, EGRID, and green space classification. Disable with `--no-landcover`.
3. **Bauzonen** *(optional, `--bauzonen`)* — adds `bauzonen` and `bauzonen_m2` columns to both outputs.
4. **Habitat** *(optional, `--habitat`)* — adds `habitat` and `habitat_m2` columns to both outputs.

## Tech stack

| Library | Version | Purpose |
|---------|---------|---------|
| [GeoPandas](https://geopandas.org) | >= 0.14 | GeoPackage I/O, spatial operations |
| [Shapely](https://shapely.readthedocs.io) | >= 2.0 | Geometry operations, `make_valid()` |
| [pandas](https://pandas.pydata.org) | >= 2.0 | Tabular data processing, CSV/Excel I/O |
| [openpyxl](https://openpyxl.readthedocs.io) | — | Excel (.xlsx) reading |

For the land cover classification, see [CLASSIFICATION](../docs/CLASSIFICATION.md); for inputs/outputs, [DATAMODEL](../docs/DATAMODEL.md); for the processing pipeline and module responsibilities, [ARCHITECTURE](../docs/ARCHITECTURE.md). ([docs index](../docs/README.md))
