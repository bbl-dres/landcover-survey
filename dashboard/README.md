# Landcover Dashboard (offline)

A German-language dashboard for exploring a `landcover-parcels.geojson` export.
The **source** is split for maintenance (`index.html` shell + `css/` + `js/` +
inline font); the **deliverable** is a single self-contained HTML file the builder
produces by inlining those assets and embedding the data.

Open `index.html`, pick a GeoJSON, and it renders the dashboard live; the
**Herunterladen** dialog then saves the self-contained HTML (runs fully offline by
double-click, no data file, no server, no CDN), Excel, GeoJSON or a PDF report. The
saved HTML is what you distribute via ActaNova.

> Producing the **HTML download** inlines `css/`, `js/` and the basemap thumbnails
> via `fetch`, which browsers block on `file://`, so build it from a local web server
> (one command, below). The dashboard *renders* fine from `file://`; only the HTML
> download needs the server. This is the same model as the [web app](../processing-web/README.md)
> and its report export.

> The committed `index.html` (and `css/`, `js/`, `assets/`) is the **data-less
> template** (no parcels, no personal data). A *built* deliverable embeds parcel data
> including personal fields. Don't commit it.

The visual design follows the **Swiss Confederation Corporate Design** (default
skin): the Confederation logo lockup, federal red `#d8232a` and slate
`#2f4356`/`#46596b`, the purple focus ring, small radii, **Noto Sans** (the federal
font) embedded directly in `index.html` as a base64 woff2 subset so it renders
offline, and [Lucide](https://lucide.dev/) icons inlined as SVG. The design tokens
(`css/tokens.css`) and the shared components (dialog, popover, button, segmented
control, list row, labels) are documented in the design study
`docs/wireframes/261026_Dashboard Background Maps.html`.

## Layout

The header carries the Confederation lockup with the dashboard title, the
**global search**, the **settings** menu (gear), **Neue Datei** and
**Herunterladen**. The left panel holds the filters; the main area has four tabs.

### Tabs

- **Karte** (start view): a full-height map of the filtered parcels with the tools
  accordion (top left), map controls (top right), the basemap switcher (bottom
  right) and a selection bar (bottom left) once parcels are selected for the PDF
  report. Zooming out groups the parcels into clusters; click a cluster to expand it,
  a polygon to open the parcel popup. The page does not scroll here, so the mouse
  wheel zooms the map directly.
- **Auswertung**: KPI cards, Teilportfolio and Region tables (area and parcel
  count), the same map in a fixed-height panel with a simple legend of the visible
  layers (the Karte-only controls stay away; because this page scrolls, zooming
  needs Ctrl + wheel, ⌘ on a Mac, as the map's own hint says), the summary tables (VBS, Bauzonen, SIA 416, Versiegelung, AV land cover
  by type, BAFU habitats) and the parcel table with search, sortable columns, a
  column picker, a Total row, pagination and the checkbox column for the PDF
  report.
- **Datenqualität**: completeness and area-balance rules over the current selection
  (see [docs/CHECKING-RULES.md](../docs/CHECKING-RULES.md)).
- **Über**: data sources, the counting rule and notes.

The active tab is kept in the URL (`tab=map|overview|quality|about`; `map` is the
default and is omitted).

### Global search

One search field in the header, with a scope switch **Alle / Grundstücke / Orte /
Karten**:

- **Grundstücke** (local): matches id, E-GRID, Ort, Kanton and Bezeichnung; shows
  the first five hits and «Alle n Treffer in Tabelle filtern» (sets the table filter
  `q=`). A hit switches to the map and flies to the parcel.
- **Orte** (swisstopo SearchServer): cantons, municipalities, addresses, places.
  A hit fits the map to the location and drops a red marker.
- **Karten** (swisstopo Geokatalog): adds the layer as an external map. With an
  empty field the dropdown lists frequently used maps.

Enter selects the first hit, Esc closes. Orte and Karten need an internet
connection; offline, the dropdown says so and parcel search keeps working. The old
table search is now the «In Tabelle filtern…» field above the table.

### Maps

- **Hintergrund** (bottom right): Light (CARTO Positron, default), Standard
  (Voyager), Luftbild (Esri World Imagery worldwide, swisstopo SWISSIMAGE on top
  within Switzerland), Hybrid (the aerial imagery with Esri's Hybrid Reference
  labels) and Dark (Dark Matter). Switching the basemap keeps the parcels, the
  selection, the overlays and the external maps. The choice is kept in the URL as
  `basemap=light|standard|aerial|aerial-labels|dark`. Thumbnails live in
  `assets/basemaps/` and are inlined into the HTML deliverable.
- **Dargestellte Karten** (accordion, top left): **Interne Karten** (Grundstücke,
  Beschriftung & Cluster, and Bodenbedeckung / Bauzonen / Lebensräume when the
  export carries those layers) and **Externe Karten** (swisstopo WMS layers from the
  Geokatalog). Every row has a checkbox and an info button; external rows can be
  removed. The info dialog shows a description and legend for internal maps and the
  geo.admin legend (sanitized) with an opacity slider for external maps.
- Two recommended external maps are pre-added hidden:
  `ch.bafu.lebensraumkarte-schweiz` and `ch.swisstopo-vd.amtliche-vermessung`.
  Active external maps travel in the URL as `ext=id1,id2` (a `-` prefix marks a
  hidden map), so shared links and the HTML deliverable restore them. Layer ids are
  validated against `^[a-zA-Z0-9._-]+$`.
- **Parcel popup**: Ort, Bezeichnung, ID, E-GRID, Region and Grundstücksfläche with
  the actions **Hinzoomen**, **In Tabelle anzeigen** (switches to Auswertung and
  filters the table to the parcel), **PDF-Bericht erstellen** and a checkbox to add
  the parcel to the PDF selection, plus «Alle Details anzeigen» (full attribute page
  in a new tab).
- **Map controls** (top right, in this order): **Vollbild**, zoom, compass (click =
  north up) and **auf Auswahl zoomen** (home), all drawn with the same Lucide icon
  set as the rest of the UI. Fullscreen expands the map element itself, so the
  accordion, switcher and popups come with it. Right-click opens a context menu
  (copy coordinates, share, report a problem).

### PDF report for a selection

Select up to **50** parcels with the checkboxes in the table (the header checkbox
selects the current page), via «Alle n gefilterten auswählen», or in the map popup.
Selected parcels get a slate inset in the table and a dashed outline on the map; the
table bar and the map bar show «n von max. 50 ausgewählt · Auswahl aufheben» and a
**PDF-Bericht (n)** button. The report is an A3 PDF with an overview page and one
page per parcel (aerial, land cover and habitat sections with tables, locator map,
link to map.geo.admin.ch). It needs an internet connection (swisstopo WMS images,
jsPDF from the CDN). The selection is session state, not part of the URL.

### Download dialog

One scope switch **Alle (N) / Aktive Filter (n) / Ausgewählt (k)** (default:
Ausgewählt if a selection exists, else Aktive Filter) and one list of formats:

| Format | Content |
|--------|---------|
| PDF-Bericht | A3, one page per parcel of the scope (1 to 50 parcels); progress bar and Abbrechen inside the row |
| Excel | the table with the visible columns |
| GeoJSON | parcel geometry (WGS84) with attributes |
| Datenqualität | rules and deviations (Excel, two sheets) |
| Dashboard (HTML) | the self-contained deliverable; always embeds all parcels, whatever the scope |

### Filters

**Filter** (left panel): Ausschliessen (Bezeichnung), E-GRID-Status,
Bodenbedeckung vorhanden, Eigentumsart, Teilportfolio, Land, Kanton, Enthält
Bodenbedeckungsart, Enthält Bauzone, VBS Produktivität and VBS Typ. Filtering is
live and recomputes the whole dashboard (KPIs, tables, map). Every group is a
checklist with the same **alle / keine** toggle in its header (`data-toggle="<facet>"`
→ one delegated handler, see `GROUP_TOGGLES` in `js/dashboard.js`). Active filters
appear as pills with an ✕ and an «Alle Filter zurücksetzen» link.

- **Click-to-filter**: clicking a row in the Teilportfolio, Region, Bauzonen, SIA
  416, Versiegelung or AV land-cover tables toggles the matching «Enthält» filter.
  These filters select **Grundstücke that contain** the category; they do not hide
  the other land cover of those parcels.
- **VBS filters**: Produktivität (produktiv / unproduktiv) and Typ (Typ 1 / Typ 2)
  use the same 10 % rule as the counts (below), so the filter results equal the
  counts. Options inside one group OR, the two groups AND. A legacy `has=VBSp` /
  `has=VBSu` link still resolves and is rewritten to `vbsp=…` on load. Both groups
  hide themselves if the export carries no `vbs_*` columns.
- **Explicit shareable URLs**: every active filter is its own query parameter
  (`?excl=ABGA,LÖVM,PP&status=found&eig=1&cov=with&kanton=GR&art=…&vbsp=…&vbst=…&has=…&q=…`),
  alongside the navigation parameters `tab`, `basemap` and `ext`. A URL without
  filter parameters applies the defaults and stamps them in; any URL with filter
  parameters is taken literally.

#### Default-active filters

On load (and after «Alle Filter zurücksetzen») these filters are active:

- **Ausschluss** `ABGA*` / `LÖVM*` / `PP*` (see below)
- **Eigentumsart 1** (`eig=…` for other codes)
- **Land CH** (`land=…`)

E-GRID-Status and Bodenbedeckung default to **Alle**. Bodenbedeckung is a two-box
checklist where an empty or complete selection means «alle», so `cov` stays
single-valued (`cov=with` / `cov=without`).

#### Default exclusions

Grundstücke whose Bezeichnung (`input_bez. grundstück`) starts with a SAP category
prefix are **excluded by default** (not real cadastral parcels for this analysis).
The rules live in `EXCLUDE_RULES` in `js/dashboard.js`:

| Code | Meaning | Match |
|------|---------|-------|
| `ABGA` | Abgang | prefix (Bezeichnung starts with it) |
| `LÖVM` | Löschvermerk | prefix |
| `PP` | Parkplatz | standalone token anywhere, e.g. "Bern, Bollwerk 27, **PP** Miete" (not inside words like Ra**pp**erswil) |

### Counting rule (parcels per VBS category)

Tables show area **and** number of parcels. A parcel counts in a VBS category when
the category covers at least **10 %** of the parcel area (`VBS_THRESHOLD` in
`js/dashboard.js`; Typ 1 = `vbs_typ1_m2`, Typ 2 = `vbs_typ2_m2`, Unproduktiv =
`vbs_unproduktiv_m2`; Produktiv = Typ 1 or Typ 2). A parcel can count in several
categories, so the counts do not sum to the number of parcels («Mehrfachzählung
möglich»). Teilportfolio and Region count without a threshold (exclusive, sums to
the Total row). The KPI card «Grundstücke mit Typ 1» shows the Typ 2 count as its
subline. The rule is explained in the Über tab.

### Green inventory

Exports produced with the web app option «Grüninventar abgleichen» (or the CLI flag
`--green-inventory`) carry one extra column, `greeninv` = `yes` / `no`: whether the
parcel is in the [Grünflächeninventar der Bundesgärtnerei](https://github.com/bbl-dres/green-inventory)
(matched by EGRID, else by the SAP key). The dashboard then shows a **Grüninventar**
filter group (Erfasst / Nicht erfasst, URL `gi=`), a **Grüninventar** table column, a
row in the map popup and on the detail page, and for covered parcels a link that
opens the [green inventory app](https://bbl-dres.github.io/green-inventory/prototype-main/)
centred on the parcel (`center` + `zoom` from the parcel's visual centre). Exports
without the column show none of this.

### Settings and print

The gear menu in the header switches the area unit (ha / m²); the choice is
remembered in the browser. Ctrl-P hides the panel, accordion, switcher, selection
bar and controls, expands the table to all filtered rows and keeps the map
snapshot with its legend.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Shell: inline font, links to `css/`, body skeleton (header with search and settings, file-picker screen, dialogs, tabs), `<script src="js/dashboard.js">`, and the `PARCEL-DATA` markers. The committed copy is data-less. |
| `css/tokens.css` | Design tokens: the `:root` custom properties (Swiss Confederation CD, radii, shadows, control sizes, z-index scale). |
| `css/styles.css` | Component + layout styles, including the builder/picker, dialogs, popovers, the map widgets and print rules. |
| `js/dashboard.js` | The whole app: shared helpers (allowlist, inline-and-embed deliverable), the file picker, the dashboard (`boot`), map, search, external maps, selection, download dialog. |
| `js/data.js` | **Generated** reference tables (land-cover types and main groups, TypoCH names and level-1 colours, Bauzonen, country names) from `data/*.json` and `processing-web/js/config.js` by `scripts/build_dashboard_data.mjs` — do not edit; `npm run build:dashboard-data` regenerates it. |
| `tests/data.test.mjs` | Fails when `js/data.js` is stale or a reference breaks its contract (`npm test`). |
| `js/ch-map.js` | Simplified Swiss outline for the PDF locator map. |
| `assets/basemaps/*.png` | Basemap thumbnails (rendered from the styles themselves, no API key). |

## Building a dashboard

1. **Serve the folder** so the HTML download can inline `css/`, `js/` and the
   thumbnails:
   ```bash
   cd dashboard
   python -m http.server 8000
   ```
   then open <http://localhost:8000>. (Double-clicking `index.html` renders the
   dashboard too, but the **HTML download** won't work from `file://`; see the note
   at the top.)
2. The **file picker**: pick the `landcover-parcels.geojson` export, then **Dashboard
   anzeigen**. The dashboard renders live. A multi-layer export (parcel + landcover +
   bauzonen + habitat features) is auto-filtered to the parcel rows; the other
   layers become map overlays.
3. Use **Herunterladen** (top right) → **Dashboard (HTML)** to save the
   self-contained deliverable for ActaNova (inlines `css/` + `js/` + font +
   thumbnails, embeds **all** parcels with the title you set). Upload it (rename as
   you like); it then runs offline by double-click.

Everything runs locally in the browser; the picked file never leaves the machine.
The HTML download needs the local server (to inline the assets); the Excel export
loads SheetJS from a CDN, the PDF report loads jsPDF and swisstopo images, and the
map, the Orte/Karten search and the layer info dialogs call CARTO, Esri and
geo.admin services, so those need an internet connection. The deliverable degrades
gracefully offline: tables, filters, parcel search and exports keep working.

### Not-found parcels

A complete export geojson contains **every** input parcel, including those without
a valid EGRID (exported with a `null` geometry). They show up in the dashboard with
0 m² land cover. Just export a complete geojson; nothing else is needed.

### Column allowlist / PII

Personal data is stripped **on import** (the moment you pick a file), so it never
reaches the in-memory model or any saved file. The dashboard, the HTML deliverable,
and the exports all see only the allowlisted columns. All non-`input_` columns are
kept (ids, QA checks, areas, BBArt `*_m2`); of the `input_*` columns only
`input_ort`, `input_plz`, `input_rg`, `input_bez. grundstück`, `input_eigent.art`,
`input_tpf` (portfolio code) and `input_l/r` (country) are kept. Everything else,
owner id (`input_verantw.`), coordinates, internal SAP codes, is **dropped**. Adjust
the `KEEP_INPUT` allowlist near the top of `js/dashboard.js` to change this.

> The data is embedded inline (not an ES module / not `fetch`), so the page works
> from `file://` with no server. The BBArt "by type" table is driven by an allowlist
> (`Object.keys(ART_LABELS)`), so new aggregate columns in a future export can't be
> mistaken for land-cover types.

## Third-party services

| Service | Used for | Terms |
|---------|----------|-------|
| CARTO basemaps (`basemaps.cartocdn.com`) | Light, Standard and Dark styles, glyphs | © CARTO, © OpenStreetMap contributors; free tier, no key |
| swisstopo WMTS (`wmts.geo.admin.ch`) | SWISSIMAGE within Switzerland | © swisstopo |
| Esri World Imagery (`server.arcgisonline.com`) | aerial imagery outside Switzerland (Luftbild, Hybrid) | Esri, Maxar, Earthstar Geographics, and the GIS User Community; free with attribution |
| Esri Hybrid Reference (`arcgis.com`, `basemaps.arcgis.com`) | labels above the imagery (Hybrid) | Esri, TomTom, Garmin, FAO, NOAA, USGS, © OpenStreetMap contributors; public style and tiles |
| swisstopo WMS (`wms.geo.admin.ch`) | external maps from the Geokatalog, PDF report images | © swisstopo and data owners |
| geo.admin API (`api3.geo.admin.ch`) | location and layer search, layer legends | no key required |
| unpkg / jsDelivr | MapLibre GL JS, SheetJS, jsPDF | loaded on demand |
