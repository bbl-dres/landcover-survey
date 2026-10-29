# Dashboard code review, second round (2026-10-29)

Scope: `dashboard/` as of 2026-10-29 after the UX round and the owner follow-ups (info card, identify on
external maps, detail page, layout fix, KPI clean-up). Read in full: `js/dashboard.js` (3'500 lines),
`index.html`, `css/tokens.css`, `css/styles.css`, `js/data.js` (generated), `scripts/build_dashboard_data.mjs`,
`tests/data.test.mjs`, `package.json`, `README.md`. Three independent read-only reviewers covered the data half
(filters, tables, exports, PDF, dialogs), the map half (basemaps, card, identify, detail page, external maps) and
the cross-cutting part (markup, styles, build, security); every finding below was re-verified against the code
before it was fixed. Findings from the first round (2026-10-28) are not repeated.

Method for the fixes: patch scripts with exact-match assertions, `node --check`, the unit tests and the
data-build check, then the eight Playwright suites of the session (map, overview map, green inventory,
follow-ups, KPI cards, page layout, detail page, identify) at 1440 / 1024 / 390 px.

## Findings

Status: **Fixed** = implemented in this round; **Recommended** = documented, not implemented (reason given).

| # | Sev. | Area | Finding | Status |
|---|------|------|---------|--------|
| H1 | High | Map | No `map.on("error")` handler: a basemap style that cannot be downloaded (offline deliverable, a network that blocks the CARTO / Esri CDNs) left a blank map that never fired `load`; the parcels (local data) were never drawn, clicks were ignored, and switching the basemap tore a working map down. | Fixed: the style document's failure falls back to an empty inline style, so `style.load` → `addAppLayers` still runs; a note says the background is missing. Tile / sprite / glyph errors are left to MapLibre (only the style URL counts). |
| M1 | Medium | PDF | Section tables had no row cap: 24 TypoCH classes ran through the footer and off the A3 page. | Fixed: at most 12 rows per table, the tail becomes «Übrige (n)»; the remainder line still makes the Total 100 %. |
| M2 | Medium | Perf | `computeRules` ran up to three times per interaction (the KPI hint line of the time, the Datenqualität tab, each tab switch), with two closures allocated per row. | Fixed: `rulesFor(rows)` memoises on the row-set identity; the helpers are hoisted out of the loop (the hint later became the «Datenqualität» KPI card). |
| M3 | Medium | A11y | Keyboard activation destroyed the focused element: Space on a row checkbox, Enter on a sortable header, a summary-table header, a tree group, a Prüfregel row, the accordion, the layer widget or the basemap toggle re-rendered the container with `innerHTML`, and focus fell back to `<body>`. | Fixed: `setHTMLKeepFocus(el, html)` re-finds the focused descendant by id or its first `data-*` attribute after the re-render; applied to the table head and body, the summary and rules tables, the accordion, the layer widget and the basemap switcher. |
| M4 | Medium | Boot | A failed `boot()` let the picker boot a second time on the same document; the first set of document-level listeners stayed alive (double sort toggles, double `commit()`). | Fixed: the picker disables «Dashboard anzeigen» and asks for a reload. |
| M5 | Medium | Print | `beforeprint` rendered the full filtered set (≈ 2.6 M DOM nodes at 260k rows). | Fixed: `PRINT_ROWS = 2000`, the Total row says «gedruckt: die ersten 2'000». |
| M6 | Medium | Security | `sanitizeHtml` was bypassable by mutation XSS on the legend path: the sanitised `DOMParser` document was re-serialised with `innerHTML` and re-parsed in the live page (`<noscript>` is elements in one, raw text in the other). Scheme obfuscation (`java&#9;script:`) and `style` / SMIL attributes passed as well. | Fixed: `noscript/noembed/noframes/template/xmp/animate/set/…` removed; URL attributes restricted to http(s)/mailto/tel or scheme-less after stripping control characters; `style` and `srcdoc` dropped; the info dialog and the identify card insert cloned nodes, never strings. |
| M7 | Medium | Identify | A slow identify request overwrote a parcel card opened afterwards, and the amber preview of an earlier identify lingered under a parcel card; a basemap switch reset `_identOpen` without invalidating the pending request. | Fixed: every map click and `openParcelCard` call `clearIdentify()` (bumps the request sequence); the style rebuild uses the same. |
| M8 | Medium | A11y | The closed phone drawer was only translated off-screen: all its controls stayed in the Tab order; opening the drawer at ≤ 900 px and widening the window left a stale scroll lock. | Fixed: `inert` + `visibility: hidden` while closed on phones; a `matchMedia` change handler closes the drawer and clears the lock. |
| M9 | Medium | CSS | On phones the Karte tab was framed: the phone `.tab-panel` padding beat `.panel-map { padding: 0 }`. | Fixed: `.tab-panel.panel-map { padding: 0 }` in the phone block. |
| M10 | Medium | Security | MapLibre, SheetJS and jsPDF were version-pinned but loaded without Subresource Integrity; the deliverable and the detail page inherit this. | Fixed: sha384 hashes for the four files in one `CDN` table (dynamic loaders, the MapLibre link and the detail page). |
| L1 | Low | Table | The collator was not numeric («10» before «9» in ID, Grundstück-Nr., PLZ and summary categories). | Fixed: `Intl.Collator("de", { numeric: true })`. |
| L2 | Low | PDF | Parcels without geometry (E-GRID not found) printed «Kartenbild nicht verfügbar (Internet?)». | Fixed: «Keine Geometrie (E-GRID nicht gefunden)». |
| L3 | Low | Dialog | A second «PDF-Bericht» request while one ran was swallowed. | Fixed: «Ein Bericht läuft bereits.» |
| L4 | Low | Table | Empty-state cell spanned one column too few; the Total label vanished when the first visible column was numeric. | Fixed: `colspan = vis.length + 1`; the label goes to the first text column, else the checkbox cell. |
| L5 | Low | Filters | `commit()` wrote the URL before `update()` and dropped the promise, so a failed update left a wrong address bar and a silent rejection. | Fixed: the URL follows a successful update; errors are logged and the overlay hidden. |
| L6 | Low | Import | `overlays[layer]` was a prototype-polluted lookup (`layer: "constructor"` threw and failed the import). | Fixed: `hasOwnProperty`. |
| L7 | Low | Dead code | `hasCounts` (a per-parcel loop at boot), `activeGroups()`, `urlMigrated`, `est`, the guarded lookups of `flag-kpi` / `f-count` / `f-reset`. | Fixed: removed. |
| L8 | Low | A11y | The download and info dialogs focused the close button; progress and hint texts were not announced; the progress bar had no role; KPI tooltips were mouse-only; tooltip hosts had no `aria-describedby`. | Fixed: focus on the dialog itself, `aria-live="polite"` on both texts, `role="progressbar"` with `aria-valuenow`, KPI labels focusable, `aria-describedby="tip"` set while a tooltip shows. |
| L9 | Low | Excel | Teilportfolio, Eigentumsart and Status went out as raw codes next to the labelled Grüninventar. | Fixed: columns carry a `text()` for the export (the label the table shows); the dialog row says so. |
| L10 | Low | Map | Escape in the global search box also cleared the marked parcel (the input hid its dropdown before the document handler looked). | Fixed: `stopPropagation` when the dropdown was open. |
| L11 | Low | Identify | The card could receive a nested `<body>` (a popup without `.htmlpopup-content`), which the app's `body` rule styled as a viewport-tall flex box. | Fixed: child nodes are moved into a `<div>`. |
| L12 | Low | Map | Parcel polygons kept the raw `id` type while every filter compares strings (a numeric id from a CSV source would never be outlined); unused `ort/egrid/area` properties travelled to the worker on every `setData`. | Fixed: `id: String(…)`, other properties dropped. |
| L13 | Low | Detail | The embedded JSON config escaped only `</`; `<!--<script` in a raw column would swallow the MapLibre tag. | Fixed: `jsonSafe()` (escapes `<`). |
| L14 | Low | Perf | Every style (re)load parsed the full dataset twice: sources were created with all data and replaced by `renderMap` right after. | Fixed: sources start empty; `renderMap` fills them once. |
| L15 | Low | Detail | Blob URLs were revoked after 60 s: a reload of an older detail tab showed a blocked page. | Fixed: kept for the session, revoked on `pagehide`. |
| L16 | Low | Map | Card and highlight drifted apart: a filter change cleared the overlay highlight but left its card; the card's × left an overlay outline without a card. | Fixed: `renderMap` hides the card with the highlight; × clears the highlight too. |
| L17 | Low | Map | A failed MapLibre download was final until a page reload. | Fixed: «Erneut versuchen» re-runs `ensureMap()`. |
| L18 | Low | geo.admin | Identify asked for full geometries without a limit; no request had a deadline, so «Wird abgefragt…» could hang. | Fixed: `limit=6` per map, 12 s deadline via `AbortController` on identify and htmlPopup. |
| L19 | Low | Map | Single-parcel fits were capped at zoom 16 while the detail page zooms to 17.5. | Fixed: `fitMap` takes a `maxZoom`; the table / search / label fit uses 17.5. |
| L20 | Low | Perf | `renderMap` sent four `setData` payloads on every filter commit even while the map's tab was hidden. | Fixed: a dirty flag; the deferred pass runs when the Karte or Auswertung tab is shown (after `resize`). |
| L21 | Low | CSS | KPI values overflowed the card in m² mode («10'000'000 m²» at 25 px). | Fixed: `overflow-wrap: anywhere` and a smaller size while the unit is m². |
| L22 | Low | CSS | The print map-height rule lost to the viewport-fill and overview-mode heights; `main` lost to `#main`; the info card was not in the print hide list. | Fixed: selectors with enough specificity; `.map-card` hidden in print. |
| L23 | Low | CSS | The phone `.bm-thumb` rule did not reach the option thumbnails, so the basemap panel was cut off on a 360 px overview map. | Fixed: `.bm-opt .bm-thumb` 44 × 32 px on phones. |
| L24 | Low | Build | A `BAUZONE_LABELS` slug missing from `BAUZONE_CODE` silently got the grey fallback colour; no `engines`; `--check` only reachable by hand. | Fixed: the build throws; `engines.node >= 21`; `npm run check:dashboard-data`. The check immediately found one: `weitere_bauzonen` had no code and got the grey fallback; it now carries ARE code 19 (the colour table has no entry for it, so the generated file is unchanged). |
| L25 | Low | Deliverable | The template snapshot kept a second copy of the data for the session; `inlineAssets` neutralised `</script` but not `<!--`. | Fixed: the data block is blanked in the snapshot; `<!--` is escaped in inlined scripts. |
| L26 | Low | Boot | A script error before the first dispatch (missing `js/data.js`) left the loading overlay spinning with no message. | Fixed: a `window` error handler names the error on the overlay. |
| L27 | Low | Markup | Buttons without `type="button"`; mixed quote styles („…“ and »…« next to «…»). | Fixed. |
| L28 | Low | Docs | README said the deliverable needs «no CDN». | Fixed: the libraries still come from a CDN; the About tab was already right. |

## Recommendations (not implemented in this round)

- **Split the IIFE** along its six section comments (core helpers, filters + URL, tables, quality, exports + PDF,
  map) into one namespace object, and extract the pure parts (`num`/`fmt`/`pct`, `readGeojson`, `allowlist`,
  the filter predicate, `aggregate`, `computeRules`, the URL codec, `jsonSafe`, `inlineAssets`, `sanitizeHtml`)
  into `dashboard/js/core.js` loaded before `dashboard.js` — the deliverable builder inlines every local script,
  so the offline file is unaffected. That would make a double boot impossible by construction and allow a
  `node:test` suite: the thresholds of `pct`/`pctLabel`, Feature vs FeatureCollection import, the PII allowlist,
  «count(filter = v) === facet count v» for every facet, the aggregate invariants (Typ 1 + Typ 2 = produktiv,
  GGF + BUF + UUF = classified), the rules on fixtures, a `readURL` → `writeURL` round trip and the sanitizer on
  the known mXSS vectors. Deferred: a ≈ 3'000-line move with regression risk, better done as its own change
  with the harnesses green before and after.
- **Vendor the three libraries** (MapLibre, SheetJS, jsPDF) into the deliverable: it is already ~20 MB, the SRI
  question disappears and «offline» becomes literally true. `xlsx@0.18.5` carries two CVEs on the read path
  the dashboard never uses, but scanners will flag the file.
- **One `mapKit`** for what the dashboard map and the detail-page map now duplicate (basemap switcher, layer
  widget, bounds walk, print snapshot), serialised with the same `toString` trick the detail page already uses.
- **One `fmtPct(part, whole)`** for KPIs, tables, the PDF and `_devDelta` (today «51%», «12 %», «< 1 %» and
  «+5.3 %» coexist), and a note that `fmtHa` rounds per row so a Total in ha may differ from the displayed sum.
- Upgrade MapLibre (4.7.1 is several majors behind) once the harnesses exist for the new version.

## Verification

- `node --check`, `npm test` (22 tests) and `npm run check:dashboard-data` pass.
- Playwright: the eight suites of the session re-run after the fixes, all green with no console or page
  errors (map, overview map, green inventory, follow-ups, KPI cards, page layout, detail page, identify).
- `review_check.js` (new): with `basemaps.cartocdn.com` blocked, the map still shows the 180 parcels of the
  default filter on the inline fallback style with the note visible, and a basemap switch while blocked keeps
  the layers; Space on a row checkbox, Enter on a sortable header and Space on a layer-widget checkbox keep
  focus on that control; the ID column sorts numeric-aware; the phone drawer is `inert` and `visibility:
  hidden` while closed and the lock clears when the window widens; an identify request superseded by a
  parcel click leaves the parcel card and no amber preview.
