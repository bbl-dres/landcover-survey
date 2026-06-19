# Landcover Dashboard (offline)

A German-language dashboard for exploring a `landcover-parcels.geojson` export.
The **source** is split for maintenance (`index.html` shell + `css/` + `js/` +
inline font); the **deliverable** is a single self-contained HTML file the builder
produces by inlining those assets and embedding the data.

Open `index.html`, pick a GeoJSON, and it renders the dashboard live; a **Download**
menu then saves the self-contained HTML (runs fully offline by double-click — no
data file, no server, no CDN) or the current table as Excel. The saved HTML is what
you distribute via ActaNova.

> Producing the **HTML download** inlines `css/` + `js/` via `fetch`, which browsers
> block on `file://` — so build it from a local web server (one command, below). The
> dashboard *renders* fine from `file://`; only the HTML download needs the server.
> This is the same model as the [web app](../web/README.md) and its report export.

> The committed `index.html` (and `css/`, `js/`) is the **data-less template** (no
> parcels, no personal data). A *built* deliverable embeds parcel data including
> personal fields — don't commit it.

The visual design follows the **Swiss Confederation Corporate Design** (default
skin): the Confederation logo lockup, federal red `#d8232a` and slate
`#2f4356`/`#46596b`, the purple focus ring, small radii, and **Noto Sans** (the
federal font) embedded directly in `index.html` as a base64 woff2 subset so it
renders offline.

## Layout

- **KPI cards** — Grundstücke (with data-coverage %), Grundstücksfläche,
  Grünfläche, Versiegelte Fläche, Gebäude (GGF). The green/sealed/GGF percentages
  are relative to the classified land cover (GGF+BUF+UUF), since some parcels
  return no land cover; the footer states the classified-cover base in ha.
- **Charts** (CSS bars, no library) — Bodenbedeckung nach Art (top 10 + Übrige),
  SIA 416 (GGF/BUF/UUF), and Grünfläche · Versiegelung · VBS.
- **Filter** (button in the header → right drawer) — Kanton, Bodenbedeckung
  vorhanden, Enthält Bodenbedeckungsart, Eigentumsart, and an **Ausschliessen
  (Bezeichnung)** group. Filtering is live and recomputes the **whole dashboard**
  (KPIs, charts and table). A badge on the button and a "gefiltert" flag show when
  any filter is active.
- **Active-filter pills** — a row under the header lists every active filter as a
  pill with an ✕ to remove it, ending in an "Alle Filter zurücksetzen" link.
- **Click-to-filter** — clicking a bar in **any** of the three charts adds an
  *Enthält* filter (the bar is outlined when active): *Bodenbedeckung nach Art* →
  the BBArt type; *SIA 416* → GGF/BUF/UUF; *Grün·Versiegelung·VBS* → that category.
  All *Enthält* filters select **Grundstücke that contain** the category — they do
  **not** hide the other land cover of those parcels (the analysis stays per-parcel).
- **EGRID link** — each E-GRID in the table links to map.geo.admin.ch (ÖREB
  cadastre on the colour basemap), centred on that parcel via `swisssearch`.
- **Explicit shareable URLs** — every active filter is its own query parameter, so
  removing a filter drops its parameter:
  `?excl=ABGA,LÖVM,PP&status=found&eig=1&cov=with&kanton=GR&art=…&has=…&q=…`.
  A completely empty URL (first visit) applies the defaults and stamps them in;
  any URL with parameters is taken literally (no hidden defaults).
- **Table** — all parcels with search, sortable columns (↕ on hover), a column
  picker, a **Total** row summing the filtered set, and pagination.
- **Print / PDF** — Ctrl-P hides the controls, expands to all filtered rows, and
  keeps the header, active-filter pills and Total row for a report-ready page.

### Default-active filters

On load (and after "Alle Filter zurücksetzen") the dashboard starts with these
filters already active (an empty URL = this state, stamped into the URL):

- **Ausschluss** `ABGA*` / `LÖVM*` / `PP*` (see below)
- **EGRID-Status: Gefunden** — only parcels with a found EGRID (`status=…`;
  invalid / not-found parcels have no land-cover data)
- **Eigentumsart 1** (`eig=…` for other codes)

Bodenbedeckung defaults to **Alle** (`cov=with` / `cov=without` to restrict).

### Default exclusions

Grundstücke whose Bezeichnung (`input_bez. grundstück`) starts with a SAP category
prefix are **excluded by default** (not real cadastral parcels for this analysis).
The rules live in `EXCLUDE_RULES` in `js/dashboard.js`:

| Code | Meaning | Match |
|------|---------|-------|
| `ABGA` | Abgang | prefix (Bezeichnung starts with it) |
| `LÖVM` | Löschvermerk | prefix |
| `PP` | Parkplatz | standalone token anywhere, e.g. "Bern, Bollwerk 27, **PP** Miete" (not inside words like Ra**pp**erswil) |

Uncheck them in the filter drawer to include those parcels again. Each rule in
`EXCLUDE_RULES` has a `mode`: `"prefix"` (starts-with) or `"word"` (the code as a
whole token). Edit `EXCLUDE_RULES` to add or change a rule.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Shell: inline font, links to `css/`, body skeleton + file-picker screen, `<script src="js/dashboard.js">`, and the `PARCEL-DATA` markers. The committed copy is data-less. |
| `css/tokens.css` | Design tokens — the `:root` custom properties (Swiss Confederation CD). |
| `css/styles.css` | Component + layout styles, including the builder/picker, Download menu, and print rules. |
| `js/dashboard.js` | The whole app: shared helpers (allowlist, inline-and-embed deliverable), the file picker, the dashboard (`boot`), and the Download menu. |

## Building a dashboard

1. **Serve the folder** so the HTML download can inline `css/` + `js/`:
   ```bash
   cd dashboard
   python -m http.server 8000
   ```
   then open <http://localhost:8000>. (Double-clicking `index.html` renders the
   dashboard too, but the **HTML download** won't work from `file://` — see the note
   at the top.)
2. The **file picker**: pick the `landcover-parcels.geojson` export, then **Dashboard
   anzeigen**. The dashboard renders live — KPIs, charts, filterable table. A
   multi-layer export (parcel + landcover + bauzonen + habitat features) is
   auto-filtered to the parcel rows.
3. Use the **⤓ Herunterladen** menu (top right) to save:
   - **Dashboard (HTML, offline)** — the self-contained deliverable for ActaNova
     (inlines `css/` + `js/` + font, embeds **all** parcels with the title you set).
     Upload it (rename as you like); it then runs offline by double-click.
   - **Tabelle als Excel (.xlsx)** — the current table, respecting the active
     filters and chosen columns.

Everything runs locally in the browser; the picked file never leaves the machine.
The HTML download needs the local server (to inline the assets); the Excel export
loads SheetJS from a CDN, so it needs an internet connection.

### Not-found parcels

A complete export geojson contains **every** input parcel, including those without
a valid EGRID (exported with a `null` geometry) — they show up in the dashboard with
0 m² land cover. Just export a complete geojson; nothing else is needed.

### Column allowlist / PII

Personal data is stripped **on import** (the moment you pick a file), so it never
reaches the in-memory model or any saved file — the dashboard, the HTML deliverable,
and the Excel export all see only the allowlisted columns. All non-`input_` columns
are kept (ids, QA checks, areas, BBArt `*_m2`); of the `input_*` columns only
`input_ort`, `input_plz`, `input_rg`, `input_bez. grundstück`, `input_eigent.art`,
and `input_tpf` (portfolio code) are kept. Everything else — owner id
(`input_verantw.`), coordinates, internal SAP codes — is **dropped**. Adjust the
`KEEP_INPUT` allowlist near the top of `js/dashboard.js` to change this.

> The data is embedded inline (not an ES module / not `fetch`), so the page works
> from `file://` with no server. The BBArt "by type" chart is driven by an
> allowlist (`Object.keys(ART_LABELS)`), so new aggregate columns in a future
> export can't be mistaken for land-cover types.
