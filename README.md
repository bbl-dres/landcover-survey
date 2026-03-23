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

See [docs/SPECIFICATION.md](docs/SPECIFICATION.md) for a detailed description.

## Outputs

1. **Parcels** — One row per parcel with identifiers, official and calculated area. In Mode 1, includes user-provided columns and error messages for unresolved EGRIDs. Disable with `--no-parcels`.
2. **Land Cover** — One row per clipped land cover feature per parcel with type, area, EGRID, and green space classification. Disable with `--no-landcover`.
3. **Bauzonen** *(optional, `--bauzonen`)* — Adds `bauzonen` and `bauzonen_m2` columns to both Parcels and Land Cover outputs (semicolon-separated building zone names and intersection areas).
4. **Habitat** *(optional, `--habitat`)* — Adds `habitat` and `habitat_m2` columns to both Parcels and Land Cover outputs (semicolon-separated habitat types and intersection areas).

Output files are CSV, named `{input}_parcels_{timestamp}.csv` and `{input}_landcover_{timestamp}.csv` (e.g. `Liegenschaften_parcels_20260312_195209.csv`). In Mode 2 (no input file), the input prefix is omitted. All outputs include user-provided extra columns from the input (Mode 1). A log file is written to the output directory.

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
python main.py --mode 1 --input ../data/test_data.csv

# Mode 1: Test with first 10 parcels
python main.py --mode 1 --input ../data/test_data.csv --limit 10

# Mode 2: All parcels (batched by BFSNr)
python main.py --mode 2

# Mode 2: Test with first 5 municipalities
python main.py --mode 2 --limit 5

# Custom GeoPackage and output directory
python main.py --mode 1 --input parcels.csv --gpkg D:\AV_lv95\av_2056.gpkg --output-dir ../output

# With Bauzonen analysis (requires internet)
python main.py --mode 1 --input ../data/test_data.csv --bauzonen

# With Habitat map analysis (requires internet)
python main.py --mode 1 --input ../data/test_data.csv --habitat

# Both optional analyses combined
python main.py --mode 1 --input ../data/test_data.csv --bauzonen --habitat --limit 10

# Verbose logging
python main.py --mode 1 --input ../data/test_data.csv --limit 10 -v
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
| `--bauzonen` | off | Intersect parcels and green spaces with [Bauzonen Schweiz](https://map.geo.admin.ch/?layers=ch.are.bauzonen) (requires internet) |
| `--habitat` | off | Intersect parcels and green spaces with [BAFU Lebensraumkarte](https://map.geo.admin.ch/?layers=ch.bafu.lebensraumkarte-schweiz) (requires internet) |
| `--verbose`, `-v` | off | Enable DEBUG-level logging |

## Input File Format (Mode 1)

| Column | Required | Description |
|--------|----------|-------------|
| `ID` | Yes | User-defined feature identifier |
| `EGRID` | Yes | E-GRID foreign key to look up the official parcel in AV data |
| *(others)* | No | Additional columns are passed through to all outputs, prefixed with `input_` (e.g. `Address` → `input_Address`) |

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
| `BUF_m2` | Optional | Developed surrounding area — SIA 416 (sealed + soil-covered + Wytweide) |
| `UUF_m2` | Optional | Undeveloped surrounding area — SIA 416 (water + forest + unvegetated) |
| `DIN277_BF_m2` | Optional | Built-up area — DIN 277 (Bebaute Fläche) |
| `DIN277_UF_m2` | Optional | Non-built-up area — DIN 277 (Unbebaute Fläche) |
| `Sealed_m2` | Optional | Sealed area (buildings + all sealed surfaces) |
| `GreenSpace_m2` | Optional | Green space area (soil-covered + wooded) |
| `{Art}_m2` | Optional | One column per land cover type (e.g. `Gebaeude_m2`, `Strasse_Weg_m2`) |
| `bauzonen` | Optional | Semicolon-separated building zone names (`--bauzonen`) |
| `bauzonen_m2` | Optional | Semicolon-separated intersection areas per zone (`--bauzonen`) |
| `habitat` | Optional | Semicolon-separated habitat types (`--habitat`) |
| `habitat_m2` | Optional | Semicolon-separated intersection areas per habitat (`--habitat`) |
| `input_*` | Optional | User-provided columns from input file, prefixed with `input_` (Mode 1 only) |

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
| `bauzonen` | Optional | Semicolon-separated building zone names (`--bauzonen`, green spaces only) |
| `bauzonen_m2` | Optional | Semicolon-separated intersection areas (`--bauzonen`, green spaces only) |
| `habitat` | Optional | Semicolon-separated habitat types (`--habitat`, green spaces only) |
| `habitat_m2` | Optional | Semicolon-separated intersection areas (`--habitat`, green spaces only) |
| `input_*` | Optional | User-provided columns from input file, prefixed with `input_` (Mode 1 only) |

### Complete Land Cover Type Hierarchy (`{Art}`)

| AVS Code | `Art` Value | DE | SIA 416 | DIN 277 | Sealed | Green Space | Comment |
|----------|-------------|-----|---------|---------|--------|-------------|---------|
| 0 | `Gebaeude` | Gebäude | GGF | BF | Yes | — | |
| 1 | `Strasse_Weg` | Strasse, Weg | BUF | UF | Yes | — | |
| 2 | `Trottoir` | Trottoir | BUF | UF | Yes | — | |
| 3 | `Verkehrsinsel` | Verkehrsinsel | BUF | UF | Yes | — | |
| 4 | `Bahn` | Bahn | BUF | UF | Yes | — | |
| 5 | `Flugplatz` | Flugplatz | BUF | UF | Yes | — | |
| 6 | `Wasserbecken` | Wasserbecken | BUF | UF | Yes | — | Künstliches Becken (Pool, Brunnen) |
| 7 | `uebrige_befestigte` | Übrige befestigte | BUF | UF | Yes | — | |
| 8 | `Acker_Wiese_Weide` | Acker, Wiese, Weide | BUF | UF | No | Soil-covered | |
| 9 | `Reben` | Reben | BUF | UF | No | Soil-covered | |
| 10 | `uebrige_Intensivkultur` | Übrige Intensivkultur | BUF | UF | No | — | Offiziell humusiert, aber oft versiegelt (Baumschulen, Gewächshäuser) — kein Grünraum \* |
| 11 | `Gartenanlage` | Gartenanlage | BUF | UF | No | Soil-covered | |
| 12 | `Hoch_Flachmoor` | Hoch-/Flachmoor | BUF | UF | No | Soil-covered | Oft geschützt; SIA 416 BUF fragwürdig (eher naturnah), aber offiziell humusiert |
| 13 | `uebrige_humusierte` | Übrige humusierte | BUF | UF | No | Soil-covered | |
| 14 | `Gewaesser_stehendes` | Stehendes Gewässer | UUF | UF | No | — | See, Teich |
| 15 | `Gewaesser_fliessendes` | Fliessendes Gewässer | UUF | UF | No | — | Bach, Fluss |
| 16 | `Schilfguertel` | Schilfgürtel | UUF | UF | No | — | Nicht in Beispieldaten verifiziert |
| 17 | `geschlossener_Wald` | Geschlossener Wald | UUF | UF | No | Wooded | |
| 18 | `Wytweide_dicht` | Wytweide dicht | BUF | UF | No | Soil-covered | Offiziell bestockt, aber bewirtschaftete Weide = bearbeitet (SIA 416 BUF) \*\* |
| 19 | `Wytweide_offen` | Wytweide offen | BUF | UF | No | Soil-covered | Offiziell bestockt, aber bewirtschaftete Weide = bearbeitet (SIA 416 BUF) \*\* |
| 20 | `uebrige_bestockte` | Übrige bestockte | UUF | UF | No | Wooded | |
| 21 | `Fels` | Fels | UUF | UF | No | — | |
| 22 | `Gletscher_Firn` | Gletscher, Firn | UUF | UF | No | — | |
| 23 | `Geroell_Sand` | Geröll, Sand | UUF | UF | No | — | |
| 24 | `Abbau_Deponie` | Abbau, Deponie | UUF | UF | No | — | Menschlich verändert, aber vegetationslos — UUF beibehalten |
| 25 | `uebrige_vegetationslose` | Übrige vegetationslose | UUF | UF | No | — | |

> **SIA 416:2003** — GSF (Grundstücksfläche) = GGF + UF. GGF = Gebäudegrundfläche. UF = Umgebungsfläche = BUF + UUF. BUF = Bearbeitete Umgebungsfläche (Hart- und Grünflächen). UUF = Unbearbeitete Umgebungsfläche.
>
> **DIN 277:2021** — GF (Grundstücksfläche) = BF + UF. BF = Bebaute Fläche (überbaut/unterbaut). UF = Unbebaute Fläche. AF (Außenanlagenfläche) kann nach DIN 276 KG 500 weiter untergliedert werden.
>
> **Sealed** = GGF + alle befestigten Typen (Sealed = Yes).
>
> **Green Space:** Soil-covered = Grünraum (humusiert), Wooded = Grünraum (bestockt), — = kein Grünraum.
>
> \* `uebrige_Intensivkultur` ist offiziell humusiert, wird aber nicht als Grünraum klassifiziert — typischerweise befestigte Nutzflächen (Baumschulen, Gewächshäuser).
>
> \*\* `Wytweide_dicht` und `Wytweide_offen` sind offiziell bestockt (AV-Datenmodell), werden aber als bewirtschaftete Weide = BUF (bearbeitete Umgebungsfläche, SIA 416) und Grünraum (humusiert) behandelt.

## Optional Analyses (Swisstopo API)

The tool can optionally intersect parcels and green spaces with additional spatial datasets from the [Swisstopo REST API](https://api3.geo.admin.ch). These analyses require internet access and are disabled by default.

### Bauzonen (`--bauzonen`)

Intersects parcels and green spaces with harmonised building zones ([Bauzonen Schweiz](https://www.are.admin.ch/bauzonen), `ch.are.bauzonen`). Adds two columns to each output CSV:

- **Parcels**: `bauzonen` (semicolon-separated zone names, e.g. "Wohnzonen; Mischzonen") and `bauzonen_m2` (corresponding intersection areas)
- **Land Cover**: same columns, but only populated for green space features

### Lebensraumkarte (`--habitat`)

Intersects parcels and green spaces with the [BAFU Habitat Map of Switzerland](https://www.bafu.admin.ch/de/biodiversitaet-geodaten) (`ch.bafu.lebensraumkarte-schweiz`). Adds two columns to each output CSV:

- **Parcels**: `habitat` (semicolon-separated habitat types, e.g. "6.2.3 Waldmeister-Buchenwald") and `habitat_m2` (corresponding intersection areas)
- **Land Cover**: same columns, but only populated for green space features

### API Strategy

To minimise API calls, features are fetched once per municipality (BFSNr) using the convex hull of all parcels in that group as a polygon spatial filter (`esriGeometryPolygon`). This is tighter than a bounding box and reduces false positives and pagination pressure from the API. Results are cached in memory so that the same municipality is never queried twice. All spatial intersections are performed locally using Shapely.

> **Note:** The Swisstopo API offers many more potentially relevant datasets — see [BAFU Biodiversität Geodaten](https://www.bafu.admin.ch/de/biodiversitaet-geodaten) for a comprehensive list. The generic API client (`swisstopo.py`) makes it straightforward to add new layers.

## Data Source

Official Swiss cadastral survey data (Amtliche Vermessung), data model DM.01-AV-CH:

- Download: https://www.geodienste.ch/services/av
- Manual: https://www.cadastre-manual.admin.ch/
- CRS: EPSG:2056 (CH1903+ / LV95)

## Project Structure

```
python/                      Python scripts (flat, no package)
  main.py                    Entry point — run this
  config.py                  Constants, BBArt classification, green space mapping
  geometry.py                Geometry cleanup (deaggregate → dissolve → make_valid)
  data_io.py                 Read/write CSV, Excel, GeoPackage
  pipeline.py                Main processing orchestration
  swisstopo.py               Generic Swisstopo REST API client (fetch, cache, intersect)
  bauzonen.py                Bauzonen layer configuration (ch.are.bauzonen)
  habitat.py                 Lebensraumkarte layer configuration (ch.bafu.lebensraumkarte-schweiz)
data/                        Input and output data
docs/SPECIFICATION.md        Technical specification and data model
fme/                         Original FME workflow (reference only)
assets/                      Images (README banner)
pyproject.toml               Package metadata and dependencies
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

## Legal Framework & References

### Area Standards
- **SIA 416:2003** — Flächen und Volumen von Gebäuden (Areas and volumes of buildings). Defines GSF = GGF + UF (BUF + UUF).
- **DIN 277:2021** — Grundflächen und Rauminhalte im Hochbau (Areas and volumes in building construction). Defines GF = BF + UF.
- **DIN 276** — Kosten im Bauwesen. KG 500 (Außenanlagen) for further AF subdivision.

### Data Model
- [DM.01-AV-CH](https://www.cadastre-manual.admin.ch/de/datenmodell-der-amtlichen-vermessung-dm01-av-ch) — Current INTERLIS data model for the official cadastral survey (replaced by DMAV by 2027-12-31)
- [INTERLIS](https://www.interlis.ch/en) (SN 612030) — Swiss standard for geodata description and transfer

### Geoinformation Law
- [Bundesverfassung (SR 101)](https://www.fedlex.admin.ch/eli/cc/1999/404/de) — Art. 75a Vermessung
- [Geoinformationsgesetz, GeoIG (SR 510.62)](https://www.fedlex.admin.ch/eli/cc/2008/388/de) — Federal Act on Geoinformation
- [Geoinformationsverordnung, GeoIV (SR 510.620)](https://www.fedlex.admin.ch/eli/cc/2008/389/de) — Geoinformation Ordinance
- [GeoIV-swisstopo (SR 510.620.1)](https://www.fedlex.admin.ch/eli/cc/2008/390/de) — swisstopo Ordinance on Geoinformation

### Official Cadastral Survey (Amtliche Vermessung)
- [VAV (SR 211.432.2)](https://www.fedlex.admin.ch/eli/cc/1992/2446_2446_2446/de) — Ordinance on the Official Cadastral Survey
- [TVAV / VAV-VBS (SR 211.432.21)](https://www.fedlex.admin.ch/eli/cc/2023/530/de) — Technical Ordinance on the Official Cadastral Survey (Art. 14–19: land cover categories)
- [GeomV (SR 211.432.261)](https://www.fedlex.admin.ch/eli/cc/2008/387/de) — Ordinance on Engineer-Surveyors

### ÖREB-Kataster
- [ÖREBKV (SR 510.622.4)](https://www.fedlex.admin.ch/eli/cc/2009/553/de) — Ordinance on the Cadastre of Public-Law Restrictions on Landownership

### Land Register (Grundbuch)
- [GBV (SR 211.432.1)](https://www.fedlex.admin.ch/eli/cc/2011/667/de) — Land Register Ordinance
- [TGBV (SR 211.432.11)](https://www.fedlex.admin.ch/eli/cc/2013/3/de) — Technical Ordinance on the Land Register

### Online Resources
- [Cadastre Manual](https://www.cadastre-manual.admin.ch/) — Handbuch der Amtlichen Vermessung
- [Legal Framework](https://www.cadastre.ch/de/rechtliche-grundlagen) — Rechtliche Grundlagen
- [Survey Data Download](https://www.geodienste.ch/services/av) — AV GeoPackage download

## License

See [LICENSE](LICENSE).
