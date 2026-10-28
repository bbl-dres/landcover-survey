# Dashboard code review — `dashboard/`

**Date:** 2026-10-28
**Scope:** the offline dashboard — `dashboard/js/dashboard.js` (one IIFE: picker, allowlist,
deliverable builder, filters, tables, charts, Datenqualität rules, map, search, external maps,
download dialog, PDF report), `dashboard/index.html`, `dashboard/css/*.css`, the shared
references it embeds (`data/landcover.json`, `data/typoch.json`, `data/countries.json`) and
the dashboard README.
**Role:** senior developer + domain reviewer (AV land cover, TypoCH habitats, ARE Bauzonen,
SIA 416 / VBS figures), looking for bugs, robustness gaps and avoidable complexity.
**Method:** full read of the module; the inline reference tables were diffed programmatically
against the shared JSON files and the web app's `config.js`; every change was exercised with the
existing Playwright smoke test (`run.js`: picker → map → basemaps → search → external maps →
popup → selection → table → download dialog → Excel / GeoJSON / HTML / PDF → Datenqualität →
mobile → print → the saved deliverable opened from `file://`), the Auswertung-map check
(`ovmap_check.js`) and the green-inventory check (`run_gi.js`), plus `npm test`.

## Verdict

The dashboard is in good shape: the risky parts (PII allowlist with a defence-in-depth regex,
`</script>` and U+2028/2029 escaping in the embedded data, the sanitised geo.admin legend
documents, the focus trap and `inert` background of the dialogs, the one-map-moved-between-tabs
design) are done carefully and hold up under test. No correctness bug affecting a shown number
was found. The findings are about **maintainability and robustness**: four hand-copied reference
tables (about 600 entries) with "keep in sync" comments — one of which had already drifted
through a flawed source file —, dead computation, the same formula and label logic written twice,
silent handling of unexpected input files, and avoidable network noise. All of them are
implemented below.

---

## Findings

Severity: **High** = wrong output or data loss; **Medium** = real maintenance or robustness
risk; **Low** = clean-up. Status: everything marked *Fixed* is in this change set.

| # | Sev. | Finding | Status |
|---|------|---------|--------|
| D1 | Medium | **Hand-copied reference tables.** `ART_LABELS` + `ART_MAIN` (26 BBArt types), `MAIN_COLORS`, `HABITAT_L1_COLORS`, `TYPOCH_NAMES` (322 codes), `COUNTRY_LABELS` (250), `BAUZONE_LABELS` + `BAUZONE_COLORS` were inlined in `dashboard.js` with comments asking to keep them in sync with `data/landcover.json`, `data/typoch.json`, `data/countries.json` and `processing-web/js/config.js`. Diffing them showed the TypoCH copy carrying the source's typos and a duplicate code (D2); nothing would have flagged the next drift. | Fixed — one generated file `dashboard/js/data.js` (`scripts/build_dashboard_data.mjs`, `npm run build:dashboard-data`) built from the four sources, loaded before `dashboard.js` and inlined into the deliverable like any local script; `dashboard/tests/data.test.mjs` (`npm test`) fails while it is stale or a reference breaks its contract. About 190 lines of tables left `dashboard.js`. |
| D2 | Medium | **`data/typoch.json` was inconsistent.** The code `4.2.1.1` appeared three times (ids 4211, 42111, 42112: «Inneralpine Felsensteppe», «… der Westalpen», «… der Ostalpen»), so every consumer that builds a code → name map (the dashboard, `ensureTypoch()` in the web app, `_load_typoch()` in the CLI) silently kept the **last** one and labelled the generic class as «… der Ostalpen». Four German names had typos: «Schneefleder», «Subatlantsiche», «Kriche», «Versiegeleter». | Fixed — the two variants are now `4.2.1.1.1` / `4.2.1.1.2`, level 5 (the ids 42111 / 42112 already encoded that; `_meta.levels` documents the extra level); typos corrected. The CLI tests (60) and web tests still pass; the generated table is unique by code. |
| D3 | Low | **Two names for the same habitat class.** The map legend (print) listed the Lebensräume with the legacy slug labels («Ufer & Feuchtgebiete», «Gebäude / Anlagen») while the layer-info dialog and the Auswertung pivot used the TypoCH names («2 Ufer und Feuchtgebiete», «9 Bauten, Anlagen»). | Fixed — one source: the TypoCH level-1 names everywhere; the legacy slug table is only used to map an old export's column names to their digit. |
| D4 | Low | **Dead computation in `parcelStats`.** Six of the eight cached fields (`bzSum`, `hbNat`, `nLc`, `nHb`, `bzDom`, `bzDomSlug`) and the `HABITAT_NAT_DIGIT` table were computed for every parcel and read nowhere. | Fixed — the function computes the two sums the quality rules use. |
| D5 | Low | **Duplicated logic.** The WGS84 → LV95 formula existed twice (`wgs84ToLv95` for the PDF report, inline again in `geoAdminUrl`); the «Hauptgruppe · BBArt» label was built in two places with slightly different code (`reportLandcover`, the detail page); `readURL` repeated the same split-filter-collect line twelve times; three icon sets (`ICON`, `CTX_ICON`, the hand-drawn house in `HomeControl`) carried the same Lucide style. | Fixed — `geoAdminUrl` calls `wgs84ToLv95`; `artFullLabel()`; `readSet()`; `ICON.copy` / `ICON.share` / `ICON.alert` and `ICON.sz("house", 17)`. |
| D6 | Low | **Unexpected GeoJSON files were handled silently.** `readGeojson` accepted anything with a `features` array; a file that is not a FeatureCollection, or a multi-layer export with no `parcel` features, produced «0 Grundstücke … geladen» with the *Dashboard anzeigen* button enabled; features with an unknown `layer` value or overlay features without geometry were dropped without a trace. | Fixed — a single Feature is accepted as a one-element collection, anything else without a feature array is an error; no parcel features is an error (button stays disabled); skipped features are counted and shown in the picker status («… · 3 Features ohne bekannten Layer übersprungen»). |
| D7 | Low | **Avoidable requests and console errors.** `resolveExtTitle` fetched the geo.admin legend document for every external map restored from a link, including the ones whose titles the app already holds in `EXT_RECOMMENDED` / `EXT_SUGGEST`; layers without a legend (e.g. `ch.swisstopo.pixelkarte-farbe`) answered 404 and left a console error in every smoke-test run. | Fixed — known ids resolve locally (and offline); only unknown ids ask geo.admin. |
| D8 | Low | **A typo in a hand-written link emptied the dashboard.** `readURL` accepted any `art=` value; an unknown BBArt code can never match, so the page showed no parcels behind a pill. (`has`, `vbsp`, `vbst`, `gi`, `excl` were already validated.) | Fixed — `art` is checked against the 26 types. Data-driven facets (canton, country, Teilportfolio, status, Bauzonen) deliberately keep accepting any value: the pill shows what the link asked for. |
| D9 | Low | `pageRows()` trusted `state.page`; every caller resets it today, but the function is the one place the table's current page is defined. The allowlist comment said «these six» for seven keys. | Fixed — `pageRows` clamps; comment corrected. |
| D10 | Info | **Reviewed and found sound** (no change): the PII allowlist (`KEEP_INPUT` + `PII_RE`) applied at import so nothing personal reaches a saved file; `jsonSafe` (`<`, U+2028/2029) and the `</script` neutralisation in `inlineAssets`; the sanitised legend `Document` (scripts, frames, forms, styles, event handlers, `javascript:` URLs removed); the download dialog's focus trap and `inert` background; the `WeakMap` statistics cache; the reused `Intl.Collator`; `getClusterExpansionZoom` handling both the promise and the callback API; the Datenqualität rules (±1 % tolerance, E-GRID uniqueness judged over the filtered set). |
| D11 | Info | **Behaviour to be aware of after D1**: the land-cover main groups now carry the names of the shared reference («Befestigte Flächen», «Humusierte Flächen», «Bestockte Flächen», «Vegetationslose Flächen» instead of the short forms) in the chart, the legends and the «Hauptgruppe · BBArt» labels, and the legend order follows the reference (Gewässer before Bestockt). The Lebensräume legend shows the TypoCH names (D3). Nothing changes in the numbers, exports or the URL contract. |

## Open points (not changed)

- **No in-repo end-to-end test.** The dashboard is one 3.1 k-line IIFE, so its logic is not
  importable by unit tests; the only automated coverage is the new data test. The Playwright
  smoke tests used for this review live outside the repository (session scratchpad). Moving
  them under `tools/e2e/` would add Playwright as a dev dependency and a browser download —
  the owner's call. Splitting the IIFE into modules would make the pure parts (filters, rules,
  aggregation, URL state) unit-testable; it is a larger refactor than this review set out to do.
- **TypoCH level 5.** The two variants were recoded from their ids; the InfoFlora list should
  confirm the codes `4.2.1.1.1` / `4.2.1.1.2` before the next data refresh.
- The dashboard footer still links «Kontakt» (the processing web app's link was removed on
  request today); decide whether the two footers should match.

---

## Verification

- `npm test`: 22 tests (13 web-app unit tests, the dashboard data tests) pass; `node
  scripts/build_dashboard_data.mjs --check` reports the committed `data.js` current.
- `processing-cli`: 60 tests pass, 1 skipped (live) — the TypoCH fix did not change any label
  the parity fixtures carry.
- Smoke test (`run.js`, 1440 × 960 and 390 px): picker → 355 parcels; basemaps light / aerial /
  hybrid / dark with the URL updated; parcel search and popup; external map from the search
  added above the recommended ones; layer-info dialogs (internal legend with the reference
  names, external with the geo.admin legend); selection bar and PDF button; «In Tabelle
  anzeigen» filter; overview KPIs and tables (main groups and TypoCH classes labelled from the
  reference); download dialog scopes; Excel, GeoJSON, HTML deliverable (19.6 MB, every local
  script and stylesheet inlined, five thumbnails as data URIs) and the four-page PDF report;
  Datenqualität; gear menu (ha ↔ m²); mobile map / overview / filter drawer; print view with the
  legend; the saved deliverable opened from `file://` with tab, basemap, external maps and a
  canton filter from the URL. No page or console errors (the legend 404 of D7 is gone).
- `ovmap_check.js`: control stack fullscreen · zoom · compass · home with Lucide masks; the map
  moves into the Auswertung tab with legend and cooperative gestures and back with plain wheel
  zoom.
- `run_gi.js`: green-inventory filter, column, popup / detail links and `gi=` URL filter.

## Files

| File | Change |
|------|--------|
| `dashboard/js/dashboard.js` | Reference tables replaced by `window.DASHBOARD_DATA` (D1), habitat labels (D3), `parcelStats` (D4), `artFullLabel` / `readSet` / `geoAdminUrl` / icons (D5), `readGeojson` + picker status (D6), `resolveExtTitle` (D7), `readURL` validation (D8), `pageRows` (D9) |
| `dashboard/js/data.js` | **New, generated** — do not edit |
| `scripts/build_dashboard_data.mjs` | **New** — generator (`--check` mode for CI) |
| `dashboard/tests/data.test.mjs` | **New** — currency + integrity tests |
| `dashboard/index.html` | `<script src="js/data.js">` before the app |
| `data/typoch.json` | Duplicate code recoded, four typos, `_meta.levels` (D2) |
| `package.json` | `npm test` runs both suites; `npm run build:dashboard-data` |
| `dashboard/README.md`, `scripts/README.md` | File list / generator documented |
