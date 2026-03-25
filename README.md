# Land Cover Survey

![Land Cover Survey](assets/Social1.jpg)

![Python](https://img.shields.io/badge/python-%3E%3D3.10-blue)
![GeoPandas](https://img.shields.io/badge/geopandas-%3E%3D0.14-green)
![JavaScript](https://img.shields.io/badge/javascript-ES6+-yellow)
![MapLibre](https://img.shields.io/badge/maplibre-4.7-blue)
![License](https://img.shields.io/badge/license-MIT-lightgrey)
![Status](https://img.shields.io/badge/status-alpha-orange)

Aggregate land cover area (m²) per Swiss cadastral parcel from official survey data (Amtliche Vermessung).

For each parcel, the tool clips every intersecting land cover polygon to the parcel boundary and calculates the area of each clipped piece. This produces a breakdown of how much area of each land cover type exists within each parcel.

The solution is available in three variants:

- **[Web App](index.html)** — Zero-install browser app. Upload a CSV, get results on a map with export to CSV/Excel/GeoJSON.
- **[Python CLI](python/)** — Open-source, requires Python >= 3.10 and free dependencies. Processes locally with exact LV95 areas.
- **[FME](fme/)** — Requires a licensed copy of [FME Form](https://fme.safe.com/fme-form/).

<p align="center">
  <img src="assets/images/preview5.jpg" width="45%" style="vertical-align: top;"/>
  <img src="assets/images/preview6.jpg" width="45%" style="vertical-align: top;"/>
</p>

## Web App

The browser-based version runs entirely client-side — no backend, no installation. Upload a CSV with `ID` and `EGRID` columns and the app will:

1. Look up parcel geometries from [swisstopo](https://api3.geo.admin.ch) (`ch.kantone.cadastralwebmap-farbe`)
2. Fetch land cover polygons from [geodienste.ch](https://geodienste.ch) WFS (`ms:LCSF`)
3. Clip land cover to parcel boundaries using [Turf.js](https://turfjs.org)
4. Classify by SIA 416, DIN 277, green space, and imperviousness
5. Display results on an interactive map with table and summary panel

**Multilingual** — Available in German (DE), French (FR), Italian (IT), and English (EN) via `?lang=` URL parameter.

### Features

- **Interactive Map** — MapLibre GL JS with parcel + land cover polygons, 4 basemaps (CARTO + swisstopo aerial), 3D building extrusions, scale bar
- **Accordion Menu** — Layer toggles, Geokatalog (all swisstopo layers), draw tools (placeholder)
- **Search Bar** — Search parcels by ID/EGRID, Swiss locations, and swisstopo map layers
- **Table Widget** — Tabs for Parcels and Land Covers, sortable columns, search filter, pagination (25/50/100), column visibility dropdown, resizable panel
- **Summary Panel** — Collapsible sections for parcel status, area analysis with donut chart, and key metrics. Aggregation dropdown switches between land cover, SIA 416, DIN 277, green space, and imperviousness — updates chart, legend, and map polygon colors
- **Context Menu** — Right-click to copy coordinates, share, or report issues
- **External Layers** — Toggle official survey and habitat map overlays, or add any swisstopo layer via Geokatalog/search
- **Layer Info** — Click (i) to view swisstopo legend and metadata
- **Export** — Parcels CSV, Land Cover CSV, Excel (both sheets), GeoJSON
- **Privacy** — All data stays in the browser. Only EGRID and bounding box are sent to public APIs
- **Responsive** — Adapts to tablet and mobile screens with map-first layout
- **Accessible** — ARIA roles, keyboard navigation, `<label>` elements, `<noscript>` fallback
- **i18n** — Four languages (DE/FR/IT/EN) with localized SIA 416 terminology

### Limitations vs Python Version

| | Web App | Python CLI |
|---|---|---|
| **Data coverage** | 20 of 26 cantons via public WFS (JU, LU, NE, NW, OW, VD blocked) | All cantons via local GeoPackage |
| **Area calculation** | Spherical (Turf.js), ~0.1–0.5% error | Exact planar (LV95/EPSG:2056) |
| **Data source** | Live API queries per parcel | Local GeoPackage (all cantons at once) |
| **Throughput** | ~5 parcels in parallel, rate-limited | Bulk vectorised processing |
| **Bauzonen analysis** | Not yet | `--bauzonen` flag |
| **Habitat analysis** | Layer overlay only | `--habitat` flag with area intersection |
| **Offline** | Requires internet | Fully offline with local GeoPackage |

> **Data coverage note:** The Web App uses the geodienste.ch WFS, which requires cantonal approval in 6 cantons (JU, LU, NE, NW, OW, VD). Parcels in these cantons are found by EGRID but return 0 m² land cover. Coverage is also incomplete in TI, VS, and NE. See the [User Guide](docs/MANUAL.md) for details.

### Quick Start

Open `index.html` in a browser (requires a local server for ES modules):

```bash
cd landcover-survey
python -m http.server 8080
# Open http://localhost:8080
```

Or deploy to any static hosting (GitHub Pages, Cloudflare Pages, etc.).

### File Structure

```
index.html                   Entry point (GitHub Pages compatible)
css/
  tokens.css                 Design tokens (colors, spacing, typography, shadows)
  styles.css                 Component styles + responsive breakpoints
js/
  main.js                    State machine (upload → processing → results)
  upload.js                  CSV/XLSX parsing with auto-delimiter detection
  processor.js               EGRID lookup + WFS query + Turf.js clipping (5x parallel)
  map.js                     MapLibre map, controls, popups, layer management
  table.js                   Table widget with tabs, sorting, pagination, column toggle
  search.js                  Header search (parcels + locations + layers)
  swisstopo.js               External layer management, Geokatalog, layer info modal
  config.js                  BBArt mappings (SIA 416, DIN 277, green space, sealed)
  export.js                  CSV/XLSX/GeoJSON export
  i18n.js                    Translations (DE, FR, IT, EN)
data/
  example.csv                Demo data (20 parcels with error test cases)
  example-full.csv           Full test set (1000 parcels)
docs/
  MANUAL.md                  Multilingual user guide (DE/FR/IT/EN)
  SPECIFICATION.md           Full technical specification
assets/
  swiss-logo-flag.svg        Swiss coat of arms
```

### APIs Used

| API | Purpose | Auth |
|-----|---------|------|
| `api3.geo.admin.ch/MapServer/find` | Parcel geometry by EGRID | None (CORS) |
| `geodienste.ch/db/av_0/{lang}` WFS | Land cover polygons (ms:LCSF) | None (CORS) |
| `api3.geo.admin.ch/SearchServer` | Location + layer search | None (CORS) |
| `api3.geo.admin.ch/CatalogServer` | Geokatalog tree | None (CORS) |
| `api3.geo.admin.ch/MapServer/{id}/legend` | Layer metadata + legend | None (CORS) |
| `wmts.geo.admin.ch` | swisstopo WMTS tiles | None |
| `wms.geo.admin.ch` | swisstopo WMS fallback | None |

---

## Python CLI

See [docs/SPECIFICATION.md](docs/SPECIFICATION.md) for the full technical specification.

### Outputs

1. **Parcels** — One row per parcel with identifiers, official and calculated area. In Mode 1, includes user-provided columns and error messages for unresolved EGRIDs. Disable with `--no-parcels`.
2. **Land Cover** — One row per clipped land cover feature per parcel with type, area, EGRID, and green space classification. Disable with `--no-landcover`.
3. **Bauzonen** *(optional, `--bauzonen`)* — Adds `bauzonen` and `bauzonen_m2` columns to both Parcels and Land Cover outputs.
4. **Habitat** *(optional, `--habitat`)* — Adds `habitat` and `habitat_m2` columns to both Parcels and Land Cover outputs.

### Modes of Operation

| Mode | Description | Input |
|------|-------------|-------|
| 1 | User-provided parcel list | CSV or Excel with `ID` and `EGRID` columns |
| 2 | Full survey processing | All parcels from the AV GeoPackage (batched by municipality) |

### Requirements

- Python >= 3.10
- Dependencies: `geopandas`, `pandas`, `shapely >= 2.0`, `openpyxl`
- AV GeoPackage (`av_2056.gpkg`) from [geodienste.ch](https://www.geodienste.ch/services/av)

### Installation

```bash
cd python
pip install geopandas pandas shapely openpyxl
```

### Usage

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

### CLI Arguments

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

---

## Land Cover Classification

The 26 land cover types (`Art` / BBArt) are defined in the official survey data model [DM.01-AV-CH](https://www.cadastre-manual.admin.ch/de/datenmodell-der-amtlichen-vermessung-dm01-av-ch). The legal basis for the categories is [TVAV Art. 14–19](https://www.fedlex.admin.ch/eli/cc/2023/530/de) (Technical Ordinance on the Official Cadastral Survey).

| `Art` Code | EN | DE | SIA 416 | DIN 277 | Sealed | Green Space |
|------------|-----|-----|---------|---------|--------|-------------|
| `Gebaeude` | Building | Gebäude | GGF | BF | Yes | — |
| `Strasse_Weg` | Road, path | Strasse, Weg | BUF | UF | Yes | — |
| `Trottoir` | Sidewalk | Trottoir | BUF | UF | Yes | — |
| `Verkehrsinsel` | Traffic island | Verkehrsinsel | BUF | UF | Yes | — |
| `Bahn` | Railway | Bahn | BUF | UF | Yes | — |
| `Flugplatz` | Airfield | Flugplatz | BUF | UF | Yes | — |
| `Wasserbecken` | Water basin | Wasserbecken | BUF | UF | Yes | — |
| `uebrige_befestigte` | Other sealed | Übrige befestigte | BUF | UF | Yes | — |
| `Acker_Wiese_Weide` | Arable, meadow, pasture | Acker, Wiese, Weide | BUF | UF | No | Soil-covered |
| `Reben` | Vineyards | Reben | BUF | UF | No | Soil-covered |
| `uebrige_Intensivkultur` | Other intensive cultivation | Übrige Intensivkultur | BUF | UF | No | — |
| `Gartenanlage` | Garden | Gartenanlage | BUF | UF | No | Soil-covered |
| `Hoch_Flachmoor` | Raised/flat bog | Hoch-/Flachmoor | BUF | UF | No | Soil-covered |
| `uebrige_humusierte` | Other soil-covered | Übrige humusierte | BUF | UF | No | Soil-covered |
| `Gewaesser_stehendes` | Standing water | Stehendes Gewässer | UUF | UF | No | — |
| `Gewaesser_fliessendes` | Flowing water | Fliessendes Gewässer | UUF | UF | No | — |
| `Schilfguertel` | Reed belt | Schilfgürtel | UUF | UF | No | — |
| `geschlossener_Wald` | Dense forest | Geschlossener Wald | UUF | UF | No | Wooded |
| `Wytweide_dicht` | Dense wooded pasture | Wytweide dicht | BUF | UF | No | Soil-covered |
| `Wytweide_offen` | Open wooded pasture | Wytweide offen | BUF | UF | No | Soil-covered |
| `uebrige_bestockte` | Other wooded | Übrige bestockte | UUF | UF | No | Wooded |
| `Fels` | Rock | Fels | UUF | UF | No | — |
| `Gletscher_Firn` | Glacier, firn | Gletscher, Firn | UUF | UF | No | — |
| `Geroell_Sand` | Scree, sand | Geröll, Sand | UUF | UF | No | — |
| `Abbau_Deponie` | Quarry, landfill | Abbau, Deponie | UUF | UF | No | — |
| `uebrige_vegetationslose` | Other unvegetated | Übrige vegetationslose | UUF | UF | No | — |

> **SIA 416:2003** — GSF = GGF + UF, where UF = BUF + UUF. **DIN 277:2021** — GF = BF + UF.

## Data Source

Official Swiss cadastral survey data (Amtliche Vermessung / mensuration officielle), data model DM.01-AV-CH:

- Download: https://www.geodienste.ch/services/av
- Manual: https://www.cadastre-manual.admin.ch/
- CRS: EPSG:2056 (CH1903+ / LV95)

## Documentation

- [User Guide](docs/MANUAL.md) — Multilingual user manual (DE/FR/IT/EN) with FAQ and data coverage
- [Technical Specification](docs/SPECIFICATION.md) — Full specification including processing pipeline, data model, and architecture

## Legal Framework & References

### Area Standards
- **SIA 416:2003** — Flächen und Volumen von Gebäuden / Surfaces et volumes des bâtiments / Superfici e volumi di edifici
- **DIN 277:2021** — Grundflächen und Rauminhalte im Hochbau

### Data Model & Geoinformation Law
- [DM.01-AV-CH](https://www.cadastre-manual.admin.ch/de/datenmodell-der-amtlichen-vermessung-dm01-av-ch) — INTERLIS data model for the official cadastral survey
- [TVAV (SR 211.432.21)](https://www.fedlex.admin.ch/eli/cc/2023/530/de) — Technical Ordinance on the Official Cadastral Survey (Art. 14–19: land cover categories)
- [GeoIG (SR 510.62)](https://www.fedlex.admin.ch/eli/cc/2008/388/de) — Federal Act on Geoinformation
- [VAV (SR 211.432.2)](https://www.fedlex.admin.ch/eli/cc/1992/2446_2446_2446/de) — Ordinance on the Official Cadastral Survey
- [Cadastre Manual](https://www.cadastre-manual.admin.ch/) — Handbuch der Amtlichen Vermessung

## Tech Stack & Credits

### Web App

| Library | Version | Purpose |
|---------|---------|---------|
| [MapLibre GL JS](https://maplibre.org) | 4.7.1 | Interactive vector map rendering |
| [Turf.js](https://turfjs.org) | 7.x | Spatial operations (intersect, area, bbox, centroid) |
| [SheetJS (xlsx)](https://sheetjs.com) | 0.18.5 | Excel import/export (loaded on demand) |
| [Material Symbols](https://fonts.google.com/icons) | — | UI icons (Google Fonts) |
| [Source Sans 3](https://fonts.google.com/specimen/Source+Sans+3) | — | Typography (Google Fonts) |
| [CARTO Basemaps](https://carto.com/basemaps) | — | Positron, Voyager, Dark Matter tiles |
| [swisstopo APIs](https://api3.geo.admin.ch) | — | Parcel lookup, search, WMTS/WMS tiles |
| [geodienste.ch](https://www.geodienste.ch/services/av) | — | Official surveying WFS (land cover) |

### Python CLI

| Library | Version | Purpose |
|---------|---------|---------|
| [GeoPandas](https://geopandas.org) | >= 0.14 | GeoPackage I/O, spatial operations |
| [Shapely](https://shapely.readthedocs.io) | >= 2.0 | Geometry operations, `make_valid()` |
| [pandas](https://pandas.pydata.org) | >= 2.0 | Tabular data processing, CSV/Excel I/O |
| [openpyxl](https://openpyxl.readthedocs.io) | — | Excel (.xlsx) reading |

### Standards

- [SIA 416:2003](https://www.sia.ch/de/dienstleistungen/sia-norm/geodaten/) — Swiss standard for building surfaces and volumes
- [DIN 277:2021](https://www.beuth.de/de/norm/din-277/343199925) — German standard for floor areas and building volumes

## License

See [LICENSE](LICENSE).
