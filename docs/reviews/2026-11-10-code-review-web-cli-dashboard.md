# Code review — web app, Python CLI and dashboard

**Date:** 2026-11-10 · **Scope:** `processing-web/` (all modules), `processing-cli/`
(both sources: `api` and `gpkg`) and `dashboard/` · **Goal:** errors, bugs and
robustness; and that the web app and the CLI are built alike and give the same
results. The three tools stay independent: nothing in this change set makes one
import from another.

Topics added as domain review: what a failed query leaves in the output; whether the
same list gives the same numbers on every run; double counting (repeated parcels,
parcels in two municipalities, Baurecht on top of a Liegenschaft); completeness
(parcels without EGRID, the SDR layer); the size limit of the exchange file; what the
dashboard does with values it should not trust.

**Result in one paragraph.** The arithmetic of a successful run was sound and is
unchanged: the web app and the CLI still agree on eight live parcels at zero
tolerance, and the GeoPackage path reproduces its earlier output byte for byte on
5,888 parcels. The defects were around it: what happens when a request fails, when a
list is slightly off, when the user does a second thing, and when numbers are summed
downstream. 71 findings; 59 are fixed here, 12 are listed as open with the reason.

## Summary

| Area | Findings | High | Fixed | Open |
|---|---|---|---|---|
| [A. Processing rules shared by web app and CLI](#a-processing-rules-shared-by-web-app-and-cli) | 6 | 3 | 6 | 0 |
| [B. Web app ⇄ CLI alignment](#b-web-app--cli-alignment) | 8 | 1 | 8 | 0 |
| [C. Web app: upload, run, map, table, report](#c-web-app-upload-run-map-table-report) | 20 | 2 | 17 | 3 |
| [D. CLI, GeoPackage source](#d-cli-geopackage-source) | 18 | 3 | 15 | 3 |
| [E. Dashboard](#e-dashboard) | 13 | 2 | 12 | 1 |
| [F. Cross-cutting](#f-open-points) | 6 | — | 1 | 5 |
| **Total** | **71** | **11** | **59** | **12** |

The highest-impact ones:

| # | Finding | Where |
|---|---|---|
| A1 | A failed land-cover request gave 0 m² in every area column, or silently replaced the cadastral land cover with modelled BAFU habitat | web, CLI |
| B1 | The CLI's CSV reader shifted every column when rows ended with a delimiter: the ID became the EGRID | CLI |
| C1 | The downloaded HTML report did not open | web |
| C2 | A run the user had left could reopen the results view, or show one list's results under another list's name | web |
| D1 | Building-zone and habitat overlays were silently empty for every parcel with a hole or several parts (0.5 % of parcels, 20 % of the area in a sample) | CLI gpkg |
| D2 | A full run dropped about 55,000 parcels without EGRID or municipality number | CLI gpkg |
| D3 | A list in which no EGRID was valid processed the whole country | CLI gpkg |
| E1 | The dashboard counted a parcel with a failed request as 0 % green and reported «keine Abweichungen» | dashboard |
| E2 | Rows with the same EGRID were summed twice in every total | dashboard |

## Method

1. **Four independent readings.** I read the processing core myself, the web
   modules and the Python port side by side. Three reviewers who had not seen that
   reading each took one part end to end: the dashboard, the web app's other
   modules, and the CLI's GeoPackage path. Their findings were checked before
   anything was changed.
2. **Every finding reproduced first**: with a script against the real code, against
   the live services (parcel lookup, identify), against the real GeoPackage
   (`av_2056.gpkg`, 3.04 million parcels) or in a browser. Findings that rest on
   reading alone are marked *traced*.
3. **A failing test per fix**, then the fix.
4. **Before / after on real data** for everything that produces numbers (below,
   [Verification](#verification)).

---

## A. Processing rules shared by web app and CLI

### A1 — A failed request produced numbers (High, fixed)

When the land-cover WFS failed for a parcel, `aggregateLandCover([])` filled every
area column with 0. Worse, a parcel with 0 m² of land cover is exactly what the
synthetic fallback looks for, so the tool then built the land cover from BAFU habitat
polygons and flagged the parcel `lc_synthetic = yes` — the flag that means "this
canton has no cadastral land cover". The processing log showed «Bodenbedeckung aus
BAFU-Lebensräumen abgeleitet (keine AV-Daten)». The same parcel gave cadastral
numbers on one run and modelled ones on the next, depending on a 502.
`ARCHITECTURE.md` already said a failed request is flagged "rather than silently
zero"; the code did the opposite.

The overlays had the same shape: after a failed Bauzonen or habitat request, and for
rows whose EGRID was never found, the flatten pass wrote `0` into every per-zone and
per-habitat column.

**Rule now, in both tools:** empty means unknown, 0 means "asked, nothing there".

| Situation | Before | Now |
|---|---|---|
| Land-cover request failed | 0 in 15 columns, or BAFU substitute | columns empty, `check_wfs = wfs_error`, `errors` set, no substitute |
| Overlay request failed | per-type columns 0 | per-type columns empty, `check_* = error` |
| EGRID invalid / not found | per-type overlay columns 0 | empty |
| Service answered, nothing there | 0 | 0 |

The GeoPackage path and the dashboard follow the same rule (D6, E1).

### A2 — A failed request was never asked again (Medium, fixed)

Each request is retried four times within about four seconds; the services answer
HTTP 502 in bursts that last longer. Parcels with a failed query are now processed
again after the first pass (two rounds, 20 s apart) in **both** tools, with the same
function names (`needsRetry` / `needs_retry`). A retry never replaces a partial
result with a worse one. A parcel is reported once, with its final result. The web
app's progress line says «n Grundstück(e) mit fehlgeschlagener Abfrage – neuer
Versuch…» while it waits.

### A3 — The parcel lookup matched substrings (High, fixed earlier today)

See [the CLI review of the same day](2026-11-10-processing-cli-review.md). The
single-parcel picker of the web app had the same request without the exact-match
flag (C8).

### A4 — EGRIDs written in groups were "not found" (Medium, fixed)

map.geo.admin.ch shows an EGRID as `CH 3735 8957 4684`. `normalizeEgrid` only
trimmed and upper-cased, and the lookup is exact. Both sides now remove blanks
(including no-break and zero-width spaces). Checked live: the grouped form returns
no parcel, the cleaned one does.

### A5 — Repeated EGRIDs went unmentioned (Medium, fixed as a note)

A parcel listed twice is processed per row and carries its full areas in each. The
web app's log now adds «E-GRID steht n× in der Liste», the CLI warns at the end of
the run, and the dashboard counts such a parcel once (E2). The rows themselves are
unchanged.

### A6 — Exchange file near the browser's limit (High, fixed)

Both exporters wrote indented GeoJSON. The newest real export is 437 MB for 2,129
parcels; the dashboard reads the file as one string, and a string in Chrome or Edge
ends at about 512 MB. A list a fifth larger could not have been loaded. Both now
write compact JSON with one feature per line (`buildGeoJSON` / `build_geojson`),
about a third of the size (the eight-parcel fixture: 200,846 → 81,789 bytes). The
dashboard refuses an oversized file with a message that names the cause (E12). A
`NaN` can no longer reach the file (Python wrote the bare token, which no parser
accepts).

---

## B. Web app ⇄ CLI alignment

The two are independent implementations of one pipeline. They are kept in step by
names and by tests; `docs/ARCHITECTURE.md` now has the name map.

### B1 — The CLI read lists differently from the web app (High, fixed)

The CLI used `pandas.read_csv`. Four differences, all reproduced:

| Input | Web app | CLI before |
|---|---|---|
| Data rows end with a delimiter (`A1;CH…;`) | read correctly | first column taken as index: **`id` = the EGRID, `egrid` empty**, every parcel invalid |
| A cell reads `NA`, `null`, `None`, `nan` | kept | emptied |
| Windows-1252 file | read (umlauts garbled) | refused |
| A row has more cells than the header | extra cells dropped | whole file refused |
| SAP list export | read (`id` = BuKr/WE/Grundstk) | refused |

**Fix.** `user_input.py` is now a port of the web reader, function for function.
The web reader moved out of `upload.js` into the DOM-free `userinput.js` so that both
can be run by one test. `test_parity_js.py` feeds 26 awkward texts to both and
requires identical rows, or a refusal from both.

### B2 — Reader defects on both sides (Medium, fixed in both)

- A quote in the middle of a field (`Halle 3" breit`) opened a quoted field that
  swallowed the rest of the file: 1 parcel instead of 3, no message. A quote now
  opens a field only at its start; a quote that is never closed is an error with its
  line number.
- An SAP row with a `|` inside a value was skipped (too few cells) or read with
  shifted columns (too many). It now stops the read with its line number.
- A leading blank line broke delimiter detection; a file with CR-only line ends was
  "only a header"; a header row ending with a delimiter created a column `input_`.
- Windows-1252 files are decoded as such on both sides.

### B3 — Same names, same structure (Maintainability, fixed)

| Before | Now |
|---|---|
| `_lc_row(id, egrid, art, bfsnr, gwr, fid, area, geom, cls, …)` ⇄ `makeLandcoverRow(id, egrid, art, {…}, area, geom)` | `_make_landcover_row`, same arguments, classifies inside as the web does |
| parcel cache in `processor_web.py` ⇄ in `geoapi.js` | in `api.py`, `clear_parcel_cache` ⇄ `clearParcelCache` |
| `fetch_green_inventory` ⇄ `loadGreenInventory` | `load_green_inventory` |
| aggregate columns listed twice on each side | one `LANDCOVER_AGG_KEYS` on each side, compared by a test |
| GeoJSON built inline in the download / write function | `buildGeoJSON` ⇄ `build_geojson` |
| web: `resp.json()` outside the retry; Python: retried | `fetchJson` ⇄ `_fetch_json`: a cut-off or non-JSON body is a failed attempt on both sides |

### B4 — Different results under failure (fixed by A1, A2)

Before, the CLI retried failed parcels and the web app did not; now both do.

### B5 — The live comparison failed for the wrong reason (Medium, fixed)

`compare.py` summed land-cover areas in feature order. The WFS serves surfaces in no
fixed order, so two identical sets could differ in the last bit and fail at zero
tolerance. It sums with `math.fsum` now.

### B6 — The web side of the comparison needed a browser (fixed)

`processing-cli/tests/web_export.mjs` runs the web app's own modules and the Turf
build pinned in `index.html` in Node. Its output for the fixture list is identical to
the export a browser had made, except for the cells A1 changes.

### B7 — Excel export (Low, fixed earlier today)

The CLI's Excel export turned a text starting with `=` into a formula and stopped
on a control character; the web export did neither. See
[the CLI review of the same day](2026-11-10-processing-cli-review.md), P4.

### B8 — What still differs, on purpose

Cancelling: the web app drops unfinished rows, the CLI keeps them as error rows.
Module split: one `config.js` ⇄ `config.py` + `classify_web.py`.

---

## C. Web app: upload, run, map, table, report

Checked in headless Chromium with `processing-web/tests/smoke_browser.py`, a new
script that drives the real app against the live services. **On the last commit 7 of
its 14 checks pass, on this change set all 14.**

| # | Finding | Sev. | Status |
|---|---|---|---|
| C1 | **The HTML report did not open.** Its modules are bundled as `data:` URLs; `explainer.js` resolves a relative path against `import.meta.url` at load, which throws there, so `main.js` never ran. Verified in the browser: «Failed to construct 'URL'». | High | fixed: each bundled module gets its original address |
| C2 | **No run identity.** Clicking the header during a run showed the start screen, then the results view came back by itself with partial data. Starting a second analysis un-cancelled the first; both wrote to the same progress bar and log, and the slower one's results appeared under the other's file name. | High | fixed: run sequence in `main.js` and `processor.js` |
| C3 | Cancelling recorded up to eight in-flight parcels as service failures (`wfs_error`, ✕ in the log, in the exports). | Medium | fixed: a parcel not finished at the cancel is dropped |
| C4 | **Second analysis: layer menu and basemap picker dead.** `initMap` runs per analysis and bound the static menu elements again, so each click toggled twice. Context-menu «Teilen» shared twice. | Medium | fixed: static elements wired once |
| C5 | Any map error before `load` — one failed tile — aborted the results map. *Traced.* | Medium | fixed: only a style-level error is fatal |
| C6 | A `$&`, `$'` or `$$` in an ID or a cell corrupted the report's embedded data (`String.replace` with a replacement string). Same pattern in `t()`. | Medium | fixed: replacer functions |
| C7 | The report showed the time it was opened as the analysis time. | Low | fixed; it also records whether the run was cancelled |
| C8 | Single-parcel search accepted a shortened EGRID, selected the parcel, and the analysis then reported it not found. | Medium | fixed: exact match, the service's EGRID is used |
| C9 | The same file could not be picked again after an error (no `change` event). | Medium | fixed |
| C10 | Reference layers ticked in one analysis stayed ticked but were missing on the next map; a basemap switch reset layer visibility against the checkboxes; «Grundstücke» re-showed labels whose own box was off. | Medium | fixed: `applyLayerToggles`, layers restored on the new map |
| C11 | **Hide a column, switch tab and back: header and body one column apart.** | Medium | fixed: hidden columns kept per tab |
| C12 | A map click, log line or search hit could not reach a row on another table page or hidden by the table search. | Medium | fixed: the table goes to the row's page |
| C13 | Header search: a slow earlier response overwrote a newer list or reopened a closed one. | Low | fixed: token |
| C14 | A toast created while the tab was in the background never went away. *Traced.* | Low | fixed |
| C15 | Drop zone is `role="button"` but ignored Enter and Space. | Low | fixed |
| C16 | `esc()` did not escape quotes but is used inside attribute values with service-provided text. | Low | fixed |
| C17 | 3D state and the previous run's map data survived a new analysis; `localStorage` unguarded in the basemap switch; Excel read errors shown as «undefined»; report name `Nr-report.html` for «Nr. 112». | Low | fixed |
| C18 | Picker: a late default-parcel fetch can overwrite the user's pick; a failed identify leaves the previous parcel selected under the new pin. *Traced.* | Low | **open** |
| C19 | Identify popups have no sequence guard; sort indicator out of step after a language switch; a reference-layer toggle racing its own load; export failures only in the console. | Low | **open** |
| C20 | No row cap: every geometry goes into one map source and one download string. Not measured beyond 2,133 rows. | Low | **open** |

Checked and found sound: no string from the user's file reaches the page unescaped;
the remote legend sanitiser; null geometries and MultiPolygons on the map; all four
languages carry the same keys.

---

## D. CLI, GeoPackage source

Reviewed and then fixed by a reviewer with the real GeoPackage at hand. Results for
ordinary parcels are unchanged ([Verification](#verification)).

| # | Finding | Sev. | Status |
|---|---|---|---|
| D1 | **Overlays empty for parcels with a hole or several parts.** The parcel was sent as a multi-ring polygon; geo.admin.ch answers that with HTTP 400, which the code treated as "nothing there". Three real parcels: 14,532 m² Zentrumszone, 7,438 m² Wohnzone and 10 m² reported as none. In 44,982 sampled parcels 0.48 % are affected, holding 19.7 % of the area. | High | fixed: envelope query, local clip; a failed request is flagged |
| D2 | **Mode 2 dropped parcels without `BFSNr` or EGRID**: 55,229 in the 2026 file (1.8 %), mostly TI, with no log line. Parcels with an empty-string EGRID would have been dissolved into one. | High | fixed: extra batch; such parcels are processed singly, `check_egrid = no_egrid`; rows read vs. parcels written are logged |
| D3 | **A list without one valid EGRID read all 3 million parcels** (`rows=0` means "no limit" in pyogrio). Found while fixing. | High | fixed |
| D4 | Baurecht (SDR) EGRIDs were always `not_found`: they are in a layer `dprsf` the pipeline never read. | Medium | fixed for Mode 1 |
| D5 | Mode 2 counted the land cover of an EGRID lying in two municipalities under both rows (13 such EGRIDs; 63,210 m² twice in one pair). | Medium | fixed: dissolved across municipalities |
| D6 | A `not_found` parcel had `0.0` in every area column. | Medium | fixed: empty |
| D7 | `bfsnr` and `flaeche` were written `4436.0` / `429.0` whenever one row was not found. | Medium | fixed |
| D8 | A merged parcel reported the `flaeche` and `nummer` of its first part (422,081 for a parcel of 572,126 m²). | Medium | fixed: sum, all numbers |
| D9 | Habitat: a level-1-only label landed in a column `habitat__m2` and was missing from the list; features without id collapsed into one. Occurs in live data. | Medium | fixed |
| D10 | An invalid land-cover polygon could clip to a wrong area without an error (100 m² → 800 m² in a synthetic case). | Medium | fixed: repaired before the clip |
| D11 | Overlay piece areas were rounded before summing. | Low | fixed |
| D12 | Four parcels in the file have a lower-case EGRID and could never be matched. | Low | fixed |
| D13 | Ctrl-C during the overlay fetch still ran every queued request, then wrote nothing. A failure in chunk N lost chunks 1 … N−1. | Medium | fixed: finished part is written, exit 1 |
| D14 | A missing GeoPackage in Mode 2 created an empty file and failed with "no such table". `--limit 0`, `--chunk-size 0` and a header-only list ended in tracebacks. | Low | fixed |
| D15 | 500 EGRIDs per table scan (22 s cold each). | Low | fixed: 5,000 |
| D16 | A nationwide Mode 2 run holds everything in memory until the end (about 22 GB without overlays by extrapolation). | Medium | **open**: geometries are no longer kept without overlays; streaming output is not done |
| D17 | No retry rounds for failed overlay requests; a malformed EGRID is `not_found`, not `invalid`; CRLF line ends and unrounded areas, unlike the `api` source. | Low | **open** |
| D18 | Mode 2 scans the parcel table once per municipality (no attribute index). | Low | **open** |

One observation, not a defect of the tool: in the batch of parcels without `BFSNr`,
the land cover of nine parcels sums to 73,458 m² more than the parcel areas. The
surfaces appear to overlap in the source data; not checked further.

---

## E. Dashboard

| # | Finding | Sev. | Status |
|---|---|---|---|
| E1 | **A failed query read as "nothing there".** The parcel's area stayed in the denominator of the KPI shares (one good parcel at 60 % plus one failed parcel of equal size: 30 %); every quality rule passed; the Bauzonen table called the missing part «Ohne Bauzone»; Excel wrote a numeric 0. | High | fixed: unknown is shown as «–» / «nicht abrufbar», left out of the KPI denominators, listed as its own table row, and fails a new rule «Bodenbedeckung abgerufen» |
| E2 | **Rows with the same EGRID were summed twice** and drawn twice. | High | fixed: counted once, «n Grundstücke mehrfach geführt (x ha nicht doppelt gezählt)» |
| E3 | «E-GRID eindeutig» mostly counted rows without a valid EGRID: 587 deviations in the real export, 565 of them the same placeholder. | Medium | fixed: resolved parcels only (22) |
| E4 | «Im Mittel je Grundstück» divided by rows that have no area (72.8 % of the true mean without the default filters). | Medium | fixed |
| E5 | «Ohne Bodenbedeckung» mixed unresolved EGRIDs with found parcels that have none. | Medium | fixed: three separate counts |
| E6 | «Biologisch produktiv»: the table and the filter of that name used different rules (1,341 vs. 1,345). | Low | fixed |
| E7 | Every filter change re-sent all three hidden overlay layers to the map: about 119 MB of JSON per click on the real export. | Medium | fixed: 0.3 MB; a layer is filled when switched on |
| E8 | URL parameters accepted `constructor`, `toString` and the like as values. | Low | fixed |
| E9 | The picker blamed «Features ohne bekannten Layer» for habitat features without geometry; accepted any GeoJSON as a parcel list; threw on malformed properties. | Low | fixed |
| E10 | «In Tabelle anzeigen» used a substring search and could show several rows; an empty `id` was stored as a selection. | Low | fixed: exact-id filter |
| E11 | The allowlist dropped columns silently and matched names byte for byte. | Low | fixed: the picker lists them; names compared in NFC lower case |
| E12 | An oversized file failed with a generic parse error; LV95 coordinates produced a blank map; a second file picked during the first read could win. | Low | fixed |
| E13 | The PDF garbles characters outside Windows-1252 (Łódź, Cyrillic). No such row today. | Low | **open**: needs an embedded font |

The dashboard had no test of its own arithmetic. `dashboard.js` now runs without a
DOM up to `boot()` and hands its pure functions to `tests/logic.test.mjs` (19 tests).

**Effect on the real exports, default filters:**

| Export | Parcels counted | GSF | Green share | Sealed share | Rule deviations |
|---|---|---|---|---|---|
| 2026-06-18 | 1,114 → 1,108 | 99.38 % of before | 53.87 → 53.92 % | 14.19 → 14.21 % | 76 → 69 |
| 2026-07-10 | 1,116 → 1,109 | 99.16 % | 79.79 → 79.95 % | 16.86 → 16.94 % | 120 → 115 |
| 2026-08-06 | 1,118 → 1,112 | 99.38 % | 79.72 → 79.93 % | 16.93 → 16.96 % | 109 → 104 |

Every change comes from E2 (six or seven repeated rows no longer summed) and E3. E1
changes nothing in these files: none of them holds a failed query.

Two behaviours to know: the Bodenbedeckung filter «Ohne» now means a found parcel
without land cover (an old link `cov=without` returns fewer rows), and filter-facet
counts and the pager count rows while KPIs and tables count parcels.

---

## F. Open points

| # | Point | Why open |
|---|---|---|
| F1 | **Fels, Gletscher, Geröll (codes 21–23): AV Typ.** BAFU's definition (email of 9 Nov) makes them Typ 2; the tools classified them as unproductive, without Typ. | **Decided and implemented** after the review: the green area is every type except codes 0–7 and 24, so the three are productive, Typ 2, in the web app and both CLI sources (and the habitat class 3 with them). Typ 1 + Typ 2 = produktiv still holds. See [CLASSIFICATION.md](../CLASSIFICATION.md). Exports made before carry the old values until the parcels are processed again. |
| F2 | **Overlapping parcels.** A Baurecht and the Liegenschaft under it can both be in a list; their areas then overlap and both are summed. | Needs a parcel-against-parcel overlay. D4 makes it more likely to occur in the GeoPackage path, since SDR are now found. |
| F3 | **Internal names still say `vbs`** (`VBS_KATEGORIE`, `_vbsTyp`, URL parameters `vbsp` / `vbst`) while the output says `av_`. | Consistent across all three tools; renaming touches share links. |
| F4 | **A text starting with `=`** is written unchanged into the CSV exports of both tools. Excel evaluates it on opening. | The usual remedy alters the data; to be decided for both sides. |
| F5 | **CLI `api`: no checkpoint / resume.** Ctrl-C keeps what is finished; continuing means running again. | The result rows hold geometries; `test-naturnah` shows the pattern. |
| F6 | **Spherical vs. planar areas** between the `api` and `gpkg` sources (about 0.3 %). | By design; documented. |

---

## Verification

| Check | Before | After |
|---|---|---|
| `python -m pytest processing-cli -q` | 69 passed, 1 skipped | **132 passed, 1 skipped** |
| `npm test` (web app + dashboard) | 23 passed | **51 passed** |
| `python -m pytest test-naturnah/tests -q` | 20 passed | 20 passed |
| Web app in headless Chromium (`smoke_browser.py`) | 7 of 14 | **14 of 14** |
| Web ⇄ CLI, eight live parcels, zero tolerance | failed (summation order) | **identical** |
| Web app's stored export vs. the app now | — | identical except the 32 cells A1 changes |
| GeoPackage path, Mode 2, 5,888 real parcels | — | byte-identical parcel and land-cover CSV |
| GeoPackage path, Mode 1 example list | — | differs only by D6, D7, D9, D11 and the new check columns |
| Dashboard, three real exports, headless | — | load without errors; figures above |

Not verified: the web app in Firefox or Safari; the dashboard's PDF layout by eye; a
real file above 512 MB; a nationwide Mode 2 run; the picker and popup races (C18,
C19), which were read, not reproduced.

New test files: `processing-web/tests/processrows.test.mjs`, `classification.test.mjs`, `smoke_browser.py`;
`processing-cli/tests/test_gpkg_pipeline.py`, `test_gpkg_overlay.py`, `test_classification.py`,
`web_export.mjs` (and additions to `test_robustness.py`, `test_user_input.py`,
`test_parity_js.py`); `dashboard/tests/logic.test.mjs`.
