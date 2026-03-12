# Landcover Survey

Aggregate land cover usage (m²) per Swiss cadastral parcel from official survey data (Amtliche Vermessung).

For each parcel, the tool clips every intersecting land cover polygon to the parcel boundary and calculates the 2D planar area of each clipped piece on the LV95 projection (EPSG:2056). This produces a breakdown of how much area of each land cover type exists within each parcel.

## Outputs

1. **Parcels** (`parcels.xlsx`) — One row per parcel with identifiers, official and calculated area. In Mode 1, includes user-provided columns and error messages for unresolved EGRIDs.
2. **Land Cover** (`landcover.xlsx`) — One row per clipped land cover feature per parcel with type, area, EGRID, and green space classification.

Both outputs are alphanumeric (no geometry exported).

## Modes of Operation

| Mode | Description | Input |
|------|-------------|-------|
| 1 | User-provided parcel list | CSV or Excel with `ID` and `EGRID` columns |
| 2 | Full survey processing | All parcels from the AV GeoPackage (batched by municipality) |

## Requirements

- Python >= 3.10
- AV GeoPackage (`av_2056.gpkg`) from [geodienste.ch](https://www.geodienste.ch/services/av)

## Installation

```bash
pip install -e .
```

## Usage

```bash
# Mode 1: User-provided parcel list
landcover-survey --mode 1 --input parcels.csv --gpkg D:\AV_lv95\av_2056.gpkg --output-dir ./output

# Mode 2: All parcels (batched by BFSNr)
landcover-survey --mode 2 --gpkg D:\AV_lv95\av_2056.gpkg --output-dir ./output

# Verbose logging
landcover-survey --mode 1 --input parcels.csv -v
```

Or run as a Python module:

```bash
python -m landcover_survey --mode 1 --input parcels.csv
```

## Input File Format (Mode 1)

| Column | Required | Description |
|--------|----------|-------------|
| `ID` | Yes | User-defined feature identifier |
| `EGRID` | Yes | E-GRID foreign key to look up the official parcel in AV data |
| *(others)* | No | Additional columns are preserved in the parcels output |

## Data Source

Official Swiss cadastral survey data (Amtliche Vermessung), data model DM.01-AV-CH:

- Download: https://www.geodienste.ch/services/av
- Manual: https://www.cadastre-manual.admin.ch/
- CRS: EPSG:2056 (CH1903+ / LV95)

## Project Structure

```
python/landcover_survey/     Source package
  cli.py                     CLI argument parsing
  config.py                  Constants, BBArt classification, green space mapping
  geometry.py                Geometry cleanup (deaggregate → dissolve → make_valid)
  io.py                      Read/write CSV, Excel, GeoPackage
  pipeline.py                Main processing orchestration
docs/REQUIREMENTS.md         Detailed requirements and data model
fme/                         Original FME workflow (reference only)
```

## Documentation

See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for the full specification including:

- Swiss land cover classification (BBArt) with SIA 416 and green space mappings
- Data model tables and output schemas
- Processing pipeline with Mermaid flowchart
- Architecture and design decisions
- Legal framework and references

## License

See [LICENSE](LICENSE).
