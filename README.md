# Landcover Survey
![Landcover Survey](assets/Social1.jpg)

![Python](https://img.shields.io/badge/python-%3E%3D3.10-blue)
![GeoPandas](https://img.shields.io/badge/geopandas-%3E%3D0.14-green)
![License](https://img.shields.io/badge/license-MIT-lightgrey)
![Status](https://img.shields.io/badge/status-alpha-orange)

Aggregate land cover usage (m²) per Swiss cadastral parcel from official survey data (Amtliche Vermessung).

For each parcel, the tool clips every intersecting land cover polygon to the parcel boundary and calculates the 2D planar area of each clipped piece on the LV95 projection (EPSG:2056). This produces a breakdown of how much area of each land cover type exists within each parcel.

The solution is available in two variants that produce the same results:

- **[Python](python/)** — open-source, requires Python >= 3.10 and free dependencies.
- **[FME](fme/)** — requires a licensed copy of [FME Form](https://fme.safe.com/fme-form/).

## Outputs

1. **Parcels** — One row per parcel with identifiers, official and calculated area. In Mode 1, includes user-provided columns and error messages for unresolved EGRIDs. Disable with `--no-parcels`.
2. **Land Cover** — One row per clipped land cover feature per parcel with type, area, EGRID, and green space classification. Disable with `--no-landcover`.

Output files are CSV, named `{input}_parcels_{timestamp}.csv` and `{input}_landcover_{timestamp}.csv` (e.g. `Liegenschaften_parcels_20260312_195209.csv`). In Mode 2 (no input file), the input prefix is omitted. Both outputs are exported by default (no geometry). A log file is written to the output directory.

## Modes of Operation

| Mode | Description | Input |
|------|-------------|-------|
| 1 | User-provided parcel list | CSV or Excel with `ID` and `EGRID` columns |
| 2 | Full survey processing | All parcels from the AV GeoPackage (batched by municipality) |

## Requirements

- Python >= 3.10
- Dependencies: `geopandas`, `pandas`, `shapely >= 2.0`, `openpyxl`
- AV GeoPackage (`av_2056.gpkg`) from [geodienste.ch](https://www.geodienste.ch/services/av)

## Installation

```bash
pip install geopandas pandas shapely openpyxl
```

## Usage

Run from the `python/` directory:

```bash
cd python

# Mode 1: User-provided parcel list
python cli.py --mode 1 --input ../data/test_data.csv

# Mode 1: Test with first 10 parcels
python cli.py --mode 1 --input ../data/test_data.csv --limit 10

# Mode 2: All parcels (batched by BFSNr)
python cli.py --mode 2

# Mode 2: Test with first 5 municipalities
python cli.py --mode 2 --limit 5

# Custom GeoPackage and output directory
python cli.py --mode 1 --input parcels.csv --gpkg D:\AV_lv95\av_2056.gpkg --output-dir ../output

# Verbose logging
python cli.py --mode 1 --input ../data/test_data.csv --limit 10 -v
```

### CLI Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--mode {1,2}` | `1` | Processing mode |
| `--input PATH` | *(required for Mode 1)* | Path to user CSV or Excel file |
| `--gpkg PATH` | `D:\AV_lv95\av_2056.gpkg` | Path to the AV GeoPackage |
| `--output-dir PATH` | *(input file's directory, or `./data` for Mode 2)* | Output directory for results and log file |
| `--limit N` | *(all)* | Limit processing for testing. Mode 1: first N rows. Mode 2: first N municipalities. |
| `--chunk-size N` | `10000` | Mode 1: number of rows per processing chunk |
| `--no-aggregate` | off | Disable land cover area aggregation on parcels output |
| `--no-parcels` | off | Skip exporting the parcels CSV |
| `--no-landcover` | off | Skip exporting the land cover CSV |
| `--verbose`, `-v` | off | Enable DEBUG-level logging |

## Input File Format (Mode 1)

| Column | Required | Description |
|--------|----------|-------------|
| `ID` | Yes | User-defined feature identifier |
| `EGRID` | Yes | E-GRID foreign key to look up the official parcel in AV data |
| *(others)* | No | Additional columns are preserved in the parcels output |

## Output Tables

### Parcels (`{input}_parcels_{timestamp}.csv`)

| Column | Required | Description |
|--------|----------|-------------|
| `ID` | Always | User-defined identifier (Mode 1) or EGRID (Mode 2) |
| `EGRID` | Always | Federal parcel identifier |
| `Nummer` | Always | Official parcel number from AV |
| `BFSNr` | Always | Federal municipality number |
| `Check_EGRID` | Always | EGRID lookup status or error message |
| `Flaeche` | Always | Official legal area from AV (m²) |
| `parcel_area_m2` | Always | Calculated 2D planar area (m²) |
| `GGF_m2` | Optional | Building footprint area — SIA 416 |
| `BUF_m2` | Optional | Developed surrounding area — SIA 416 (sealed + soil-covered) |
| `UUF_m2` | Optional | Undeveloped surrounding area — SIA 416 (water + wooded + unvegetated) |
| `Sealed_m2` | Optional | Sealed area (buildings + all sealed surfaces) |
| `GreenSpace_m2` | Optional | Green space area (soil-covered + wooded) |
| `{Art}_m2` | Optional | One column per land cover type (e.g. `Gebaeude_m2`, `Strasse_Weg_m2`) |
| *(user columns)* | Optional | Additional columns from input file (Mode 1 only) |

> All aggregation columns are included by default. Use `--no-aggregate` to omit them.

### Land Cover (`{input}_landcover_{timestamp}.csv`)

Exported by default; disable with `--no-landcover`.

| Column | Required | Description |
|--------|----------|-------------|
| `ID` | Always | Parcel identifier (same as Parcels output) |
| `EGRID` | Always | Federal parcel identifier |
| `fid` | Always | Land cover feature ID from AV |
| `Art` | Always | Land cover type (BBArt domain) |
| `BFSNr` | Always | Federal municipality number |
| `GWR_EGID` | Always | GWR building register ID (may be empty) |
| `Check_GreenSpace` | Always | Green space classification |
| `area_m2` | Always | Clipped land cover area (m²) |

### Complete Land Cover Type Hierarchy

| AVS Code | Main Category | Sub-category | `Art` Value | EN | DE | SIA 416 | Sealed | Green Space |
|----------|---------------|--------------|-------------|-----|-----|---------|--------|-------------|
| 0 | Buildings (Gebäude) | — | `Gebaeude` | Buildings | Gebäude | GGF | Yes | — |
| 1 | Sealed (Befestigt) | — | `Strasse_Weg` | Road, path | Strasse, Weg | BUF | Yes | — |
| 2 | Sealed (Befestigt) | — | `Trottoir` | Sidewalk | Trottoir | BUF | Yes | — |
| 3 | Sealed (Befestigt) | — | `Verkehrsinsel` | Traffic island | Verkehrsinsel | BUF | Yes | — |
| 4 | Sealed (Befestigt) | — | `Bahn` | Railway | Bahn | BUF | Yes | — |
| 5 | Sealed (Befestigt) | — | `Flugplatz` | Airfield | Flugplatz | BUF | Yes | — |
| 6 | Sealed (Befestigt) | — | `Wasserbecken` | Water basin | Wasserbecken | BUF | Yes | — |
| 7 | Sealed (Befestigt) | — | `uebrige_befestigte` | Other sealed surfaces | Übrige befestigte | BUF | Yes | — |
| 8 | Soil-covered (Humusiert) | — | `Acker_Wiese_Weide` | Arable land, meadow, pasture | Acker, Wiese, Weide | BUF | No | Soil-covered |
| 9 | Soil-covered (Humusiert) | Intensive (Intensivkultur) | `Reben` | Vineyards | Reben | BUF | No | Soil-covered |
| 10 | Soil-covered (Humusiert) | Intensive (Intensivkultur) | `uebrige_Intensivkultur` | Other intensive cultivation | Übrige Intensivkultur | BUF | No | — * |
| 11 | Soil-covered (Humusiert) | — | `Gartenanlage` | Garden area | Gartenanlage | BUF | No | Soil-covered |
| 12 | Soil-covered (Humusiert) | — | `Hoch_Flachmoor` | Raised/flat bog | Hoch-/Flachmoor | BUF | No | Soil-covered |
| 13 | Soil-covered (Humusiert) | — | `uebrige_humusierte` | Other soil-covered | Übrige humusierte | BUF | No | Soil-covered |
| 14 | Water (Gewässer) | — | `stehendes` | Standing water | Stehendes Gewässer | UUF | No | — |
| 15 | Water (Gewässer) | — | `fliessendes` | Flowing water | Fliessendes Gewässer | UUF | No | — |
| 16 | Water (Gewässer) | — | `Schilfguertel` | Reed belt | Schilfgürtel | UUF | No | — |
| 17 | Wooded (Bestockt) | — | `geschlossener_Wald` | Closed forest | Geschlossener Wald | UUF | No | Wooded |
| 18 | Wooded (Bestockt) | Wooded pasture (Wytweide) | `Wytweide_dicht` | Dense wooded pasture | Wytweide dicht | UUF | No | Soil-covered ** |
| 19 | Wooded (Bestockt) | Wooded pasture (Wytweide) | `Wytweide_offen` | Open wooded pasture | Wytweide offen | UUF | No | Soil-covered ** |
| 20 | Wooded (Bestockt) | — | `uebrige_bestockte` | Other wooded | Übrige bestockte | UUF | No | Wooded |
| 21 | Unvegetated (Vegetationslos) | — | `Fels` | Rock | Fels | UUF | No | — |
| 22 | Unvegetated (Vegetationslos) | — | `Gletscher_Firn` | Glacier, firn | Gletscher, Firn | UUF | No | — |
| 23 | Unvegetated (Vegetationslos) | — | `Geroell_Sand` | Scree, sand | Geröll, Sand | UUF | No | — |
| 24 | Unvegetated (Vegetationslos) | — | `Abbau_Deponie` | Extraction, landfill | Abbau, Deponie | UUF | No | — |
| 25 | Unvegetated (Vegetationslos) | — | `uebrige_vegetationslose` | Other unvegetated | Übrige vegetationslose | UUF | No | — |

> **SIA 416 Legend:** **GSF** = Grundstücksfläche / total parcel area = GGF + UF. **GGF** = Gebäudegrundfläche / building footprint. **UF** = Umgebungsfläche / surrounding area = BUF + UUF. **BUF** = Bearbeitete Umgebungsfläche / developed surrounding (sealed + soil-covered). **UUF** = Unbearbeitete Umgebungsfläche / undeveloped surrounding (water + wooded + unvegetated).
> **Sealed area** = GGF + all sealed types (all types with Sealed = Yes).
>
> **Green Space Legend:** **Soil-covered** = green space (humusiert), **Wooded** = green space (bestockt), **—** = not green space.
> \* `uebrige_Intensivkultur` is officially "soil-covered" (humusiert) but classified as not green space — typically managed/sealed horticultural surfaces (orchards, nurseries).
> \*\* `Wytweide_dicht` and `Wytweide_offen` are officially "bestockt" but treated as Humusiert — primarily open pasture with partial tree cover.

## Data Source

Official Swiss cadastral survey data (Amtliche Vermessung), data model DM.01-AV-CH:

- Download: https://www.geodienste.ch/services/av
- Manual: https://www.cadastre-manual.admin.ch/
- CRS: EPSG:2056 (CH1903+ / LV95)

## Project Structure

```
python/                      Python scripts (flat, no package)
  cli.py                     CLI entry point
  config.py                  Constants, BBArt classification, green space mapping
  geometry.py                Geometry cleanup (deaggregate → dissolve → make_valid)
  data_io.py                 Read/write CSV, Excel, GeoPackage
  pipeline.py                Main processing orchestration
data/                        Input and output data
docs/SPECIFICATION.md        Technical specification and data model
fme/                         Original FME workflow (reference only)
```

## Documentation

See [docs/SPECIFICATION.md](docs/SPECIFICATION.md) for the full technical specification including:

- Swiss land cover classification (BBArt) with SIA 416 and green space mappings
- Data model tables and output schemas
- Processing pipeline with Mermaid flowchart
- Architecture and design decisions
- Terminology glossary
- Limitations, error handling, and logging
- Legal framework and references

## License

See [LICENSE](LICENSE).
