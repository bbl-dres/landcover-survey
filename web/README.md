# Web App

Browser-based land cover survey: pick a parcel on an interactive map — or upload a CSV for batch analysis — and get a per-parcel land cover breakdown. Runs entirely client-side — no backend, no installation.

**Live app:** https://bbl-dres.github.io/landcover-survey/

## How it works

Choose parcels two ways:

- **Single parcel (default landing)** — click a parcel on the map, or search by EGRID, parcel number, or address.
- **Batch** — upload a CSV with `ID` and `EGRID` columns.

Either way, the app will:

1. Look up parcel geometries from [swisstopo](https://api3.geo.admin.ch) (`ch.kantone.cadastralwebmap-farbe`)
2. Fetch land cover polygons from [geodienste.ch](https://geodienste.ch) WFS (`ms:LCSF`)
3. Clip land cover to parcel boundaries using [Turf.js](https://turfjs.org)
4. Classify by SIA 416, DIN 277, green space, imperviousness, and VBS Kategorie
5. Display results on an interactive map with table and summary panel

Multilingual — German (DE), French (FR), Italian (IT), and English (EN) via the `?lang=` URL parameter.

## Features

- **Single-parcel picker** — The default landing: click a parcel on the map (resolved to an EGRID via swisstopo Identify) or search by EGRID / parcel number / address, then analyse it directly
- **Interactive Map** — MapLibre GL JS with parcel + land cover polygons, 4 basemaps (CARTO + swisstopo aerial), 3D building extrusions, scale bar
- **Accordion Menu** — Layer toggles and Geokatalog (all swisstopo layers)
- **Search Bar** — Search parcels by ID/EGRID, Swiss locations, and swisstopo map layers
- **Table Widget** — Tabs for Parcels and Land Covers, sortable columns, search filter, pagination (25/50/100), column visibility dropdown, resizable panel
- **Summary Panel** — Parcel status, area analysis with donut chart, and key metrics. Aggregation dropdown switches between land cover, SIA 416, DIN 277, green space, imperviousness, VBS Kategorie, VBS Produktivität, and VBS Typ — updating chart, legend, and map colors
- **Context Menu** — Right-click to copy coordinates, share, or report issues
- **External Layers** — Toggle official survey and habitat map overlays, or add any swisstopo layer via Geokatalog/search
- **Export** — Parcels CSV, Land Cover CSV, Excel (one sheet per layer), GeoJSON (all analysed layers in one FeatureCollection, each feature tagged with a `layer` property), and a self-contained HTML report (single file with results embedded — opens straight into the results view)
- **Privacy** — All data stays in the browser. Only EGRID and bounding box are sent to public APIs
- **Responsive & accessible** — Map-first layout on tablet/mobile; ARIA roles, keyboard navigation, `<noscript>` fallback

## Run locally

Plain static files (ES modules, no build step). Serve the repo root with any static server — the root `index.html` redirects here:

```bash
cd landcover-survey
python -m http.server 8080
# Open http://localhost:8080  (redirects to /web/)
```

Or deploy the repo to any static hosting (GitHub Pages, Cloudflare Pages, etc.); the root redirect keeps the published URL clean.

## Limitations vs the Python CLI

| | Web App | Python CLI |
|---|---|---|
| **Data coverage** | 20 of 26 cantons via public WFS (JU, LU, NE, NW, OW, VD blocked) | All cantons via local GeoPackage |
| **Area calculation** | Spherical (Turf.js), ~0.1–0.5% error | Exact planar (LV95/EPSG:2056) |
| **Data source** | Live API queries per parcel | Local GeoPackage (all cantons at once) |
| **Throughput** | ~8 parcels in parallel, rate-limited | Bulk vectorised processing |
| **Invalid geometries** | Skipped (no repair; flagged as `check_geom`) | Repaired with `make_valid()` |
| **Land cover per parcel** | Paged (WFS `STARTINDEX`, 1000/page) up to a 10'000-feature safety cap; only then `check_wfs = truncated` | Unbounded |
| **Habitat per parcel** | Paged (Identify `offset`, 200/page) up to a 5'000-feature safety cap; only then `check_habitat = truncated` | Unbounded |
| **Bauzonen analysis** | Layer overlay only | `--bauzonen` flag |
| **Habitat analysis** | Layer overlay only | `--habitat` flag with area intersection |
| **Offline** | Requires internet | Fully offline with local GeoPackage |

The Parcels output carries QA columns so you can spot where web results may differ
from the authoritative Python run:

- `check_egrid` — `found`, `merged` (one EGRID matched several features, geometries unioned), `not_found`, `invalid`, or an error message
- `check_wfs` — `ok`, `truncated` (still more features past the 10'000-feature paging safety cap — totals may be incomplete), or `wfs_error`
- `check_geom` — `ok` or `<n>_skipped` (land-cover features whose clip failed on invalid geometry and were dropped)

> **Data coverage note:** The geodienste.ch WFS requires cantonal approval in 6 cantons (JU, LU, NE, NW, OW, VD). Parcels in these cantons are found by EGRID but return 0 m² land cover. Coverage is also incomplete in TI, VS, and NE. See the [User Guide](../docs/MANUAL.md) for details.

## APIs used

| API | Purpose | Auth |
|-----|---------|------|
| `api3.geo.admin.ch/MapServer/find` | Parcel geometry by EGRID | None (CORS) |
| `geodienste.ch/db/av_0/{lang}` WFS | Land cover polygons (ms:LCSF) | None (CORS) |
| `api3.geo.admin.ch/SearchServer` | Location + layer search | None (CORS) |
| `api3.geo.admin.ch/MapServer/layersConfig` | Layer render config (wmts/wms) | None (CORS) |
| `api3.geo.admin.ch/MapServer/{id}/legend` | Layer legend + metadata | None (CORS) |
| `wmts.geo.admin.ch` / `wms.geo.admin.ch` | swisstopo raster tiles | None |

## Files

```
index.html      App entry point
css/
  tokens.css    Design tokens (colors, spacing, typography, shadows)
  styles.css    Component styles + responsive breakpoints
js/
  main.js       State machine (upload → processing → results)
  upload.js     CSV/XLSX parsing with auto-delimiter detection
  processor.js  EGRID lookup + WFS query + Turf.js clipping (8x parallel)
  map.js        MapLibre map, controls, popups, layer management
  table.js      Table widget (tabs, sorting, pagination, column toggle)
  search.js     Header search (parcels + locations + layers)
  swisstopo.js  External layer management, Geokatalog, layer info modal
  config.js     BBArt mappings (SIA 416, DIN 277, green space, sealed, VBS)
  export.js     CSV/XLSX/GeoJSON export
  i18n.js       Translations (DE, FR, IT, EN)
```

## Tech stack

| Library | Version | Purpose |
|---------|---------|---------|
| [MapLibre GL JS](https://maplibre.org) | 4.7.1 | Interactive vector map rendering |
| [Turf.js](https://turfjs.org) | 7.x | Spatial operations (intersect, area, bbox, centroid) |
| [SheetJS (xlsx)](https://sheetjs.com) | 0.18.5 | Excel import/export (loaded on demand) |
| [CARTO Basemaps](https://carto.com/basemaps) | — | Positron, Voyager, Dark Matter tiles |
| [swisstopo APIs](https://api3.geo.admin.ch) | — | Parcel lookup, search, WMTS/WMS tiles |
| [geodienste.ch](https://www.geodienste.ch/services/av) | — | Official surveying WFS (land cover) |

For the land cover classification, see [CLASSIFICATION](../docs/CLASSIFICATION.md); for inputs/outputs, [DATAMODEL](../docs/DATAMODEL.md); for the processing pipeline, [ARCHITECTURE](../docs/ARCHITECTURE.md). ([docs index](../docs/README.md))
