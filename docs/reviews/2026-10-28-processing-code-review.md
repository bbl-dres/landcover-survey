# Processing code review — web app and Python CLI

**Date:** 2026-10-28 · **Scope:** the processing code of the web app
(`processing-web/js/processor.js`, `upload.js`, `config.js`, `export.js`) and the Python CLI
(`processing-cli/api.py`, `processor_web.py`, `geom_wgs84.py`, `classify_web.py`,
`export_web.py`, `user_input.py`, `compare.py`, `pipeline.py`, `swisstopo.py`,
`geometry.py`, `data_io.py`, `main.py`) · **Goal:** bugs, robustness,
complexity, maintainability, performance — and proof that the web app and the
Python `api` source produce the same results.

Every finding below was verified empirically (against the live services, with
Node and Python side by side) before a fix was written. All recommendations marked
*implemented* are in this change set; the rest are listed with a reason.

## Summary

| # | Finding | Severity | Where | Status |
|---|---------|----------|-------|--------|
| F1 | geo.admin.ch `identify` offset paging silently loses features | **High** | web, api, gpkg | implemented (bbox quadtree) |
| F2 | WFS paging stops at the first short page, which is not the end | **High** | web, api | implemented (page until empty + dedupe) |
| F3 | gpkg overlay run crashes when green-space land covers exist | **High** | gpkg | implemented |
| F4 | GEOS and Turf disagree on self-intersecting polygons (0.014 m²) | Medium | api | implemented (`make_valid(method="structure")`) |
| F5 | Area port follows Turf 6's formula and the platform `sin` | Medium | api | implemented (Turf 7 formula + fdlibm `sin`; Turf pinned) |
| F6 | `bfsnr` holds the cadastral numbering area, not the BFS number | Medium | web, api, docs | implemented (`bfsnr` from AV, new `nbident`) |
| F7 | Input EGRIDs are neither trimmed nor upper-cased; Excel cells untrimmed | Medium | web, api | implemented |
| F8 | gpkg `intersect_with_features` aborts the whole run on one GEOS error | Medium | gpkg | implemented |
| F9 | One malformed WFS geometry turns the whole parcel into `wfs_error` | Medium | api | implemented |
| F10 | `identify` dedupe key collides when a result has no id | Low | web, api | implemented |
| F11 | gpkg CSV dialect differs from the web / api export | Low | gpkg | implemented (semicolon + BOM) |
| F12 | Unknown `Art` values are classified silently | Low | web, api | implemented (warn once) |
| F13 | `compare.py` keys parcels by EGRID only; detail diffs unattributable | Low | tooling | implemented (id + egrid, per-fid) |
| F14 | Three near-identical row builders in `processor.js` | Maintainability | web | implemented (`makeLandcoverRow`) |
| F15 | `processor.js` (964 lines) mixes transport and processing | Maintainability | web | implemented (`geoapi.js` split, mirrors `api.py`) |
| F16 | Turf loaded from an unpinned major range (`@turf/turf@7`) | Robustness | web | implemented (pinned 7.4.0) |
| F17 | No automated tests at all | Maintainability | all | implemented (73 tests, see below) |
| R1–R8 | Recommendations not implemented | — | — | see [Not implemented](#not-implemented-recommendations) |

**Parity result:** 20 diverse parcels (found / merged / synthetic AV / habitat
gap-fill / partial Bauzonen / invalid / not found, 1'434 m² to 48.9 ha) exported
by the web app and by `python main.py --source api` compare **with zero
differences at zero tolerance** (`compare.py --rtol 0 --atol 0`): every parcel
column, every one of 1'300+ detail features. Before this change set the 48.9 ha
parcel differed in 15 values (habitat areas off by up to 24'274 m²) because of F1.

---

## Method

1. Read every module listed above end to end; cross-read the web and Python
   twins side by side (`processor.js` ⇄ `processor_web.py`, the fetch code ⇄
   `api.py`, `config.js` ⇄ `config.py` / `classify_web.py`, `export.js` ⇄
   `export_web.py`, `upload.js` ⇄ `user_input.py`).
2. Probed the live services with small scripts (Python `urllib` and Node `fetch`)
   wherever the code made an assumption about server behaviour: paging, result
   order, response counts, attribute names, SORTBY support, `RESULTTYPE=hits`.
3. Built a parity harness: a 20-parcel set chosen from the real portfolio export
   to cover every `check_*` state, run through the web app with Playwright and
   through the CLI, compared with `compare.py` at zero tolerance. The same
   harness was re-run after every change.
4. Where the two sides still differed, isolated the feature (per-fid diff) and
   reproduced the computation in Node (Turf 7.4.0) and Python until the cause
   was a single library call.

---

## Findings

### F1 — `identify` offset paging silently loses features (High)

**What.** Both pipelines fetch the Bauzonen and BAFU habitat overlays per parcel
from geo.admin.ch `identify`, which returns at most 200 results per request, and
page past that with `offset`. The server does not return results in a stable
order: for the same bbox, Python received 544 distinct ids over three pages,
Node 475, and a brute-force tiling of single-page requests 556. Pages overlap and
omit features, differently per client, and the gpkg path (`swisstopo.py`) pages
the same way.

**Impact.** Any parcel whose bbox holds more than 200 overlay features (the
48.9 ha parcel CH927796875952 holds 556 habitat polygons) gets an incomplete
overlay. The habitat gap-fill then attributes the missing area to the one
dropped feature, so the per-type areas are wrong without any flag: the road type
was overstated by 8'199 m², meadows understated by 24'274 m², and web and Python
disagreed because they lost different features.

**Fix (implemented, identical in `geoapi.js`, `api.py`, `swisstopo.py`).** The
bbox is tiled as a quadtree: a request whose result is a full page (≥ 200) is
replaced by its four quadrants, recursively (depth cap 8, in practice 1–10
requests per parcel), so every request is a single page that is complete by
construction. Results are deduplicated by feature id (a feature on a tile
boundary is returned by both tiles) and **sorted by id**, so the output no longer
depends on tile or server order. Validated: adaptive tiling (10 tiles) equals a
forced 64-tile tiling for both layers; the depth cap sets `truncated`.
`swisstopo.py` keeps its polygon filter by clipping the query polygon to each
quadrant.

### F2 — WFS paging stops at a short page that is not the end (High)

**What.** `fetchLandCover` / `fetch_landcover` page the geodienste.ch `ms:LCSF`
WFS with `COUNT=1000` / `STARTINDEX` and stop at the first page shorter than
`COUNT`. Measured on a dense bbox (`RESULTTYPE=hits` → `numberMatched=5905`):
page 0 returned **923** features, page 1 962, page 2 959 … page 6 152, page 7
empty. The server applies `COUNT` to its spatial-index candidates before the
exact bbox test, so a non-final page is routinely short, and consecutive pages
overlap by one feature. `SORTBY` is rejected (HTTP 400) and the GeoJSON output
carries no `numberMatched`.

**Impact.** Any parcel bbox with more than ~900 land-cover candidates lost all
land cover beyond the first page, with `check_wfs = ok`. Large urban parcels are
affected; the 20-parcel set happened not to contain one.

**Fix (implemented, both sides).** Page until an **empty** page and deduplicate
by (geometry, properties). Validated: 8 requests, 5'910 raw → 5'905 unique =
`numberMatched`. Cost: one extra (empty) request per parcel. The 10'000 safety
cap still sets `check_wfs = truncated`.

### F3 — gpkg overlay run crashes on green-space land covers (High)

**What.** `pipeline._run_layer_analysis` calls `_aggregate_layer_results(raw,
["EGRID", "fid"], …)` for the land-cover phase, but the function only accepted a
single string key: `raw[[group_key, …]]` nested a list and pandas raised
`TypeError: unhashable type: 'list'`. Reproduced with `--source gpkg --bauzonen
--habitat` on five parcels.

**Fix (implemented).** `_aggregate_layer_results` accepts a string or a list of
keys. The smoke run now completes (5 parcels, 178 land-cover rows, Bauzonen +
habitat columns filled).

### F4 — GEOS and Turf clip self-intersecting polygons differently (Medium)

**What.** BAFU serves self-intersecting polygons (e.g. feature 33164235, a
3'965-vertex road). `geom_wgs84.intersect` repaired inputs with the default
`make_valid` (linework) and clipped the feature to 12'912.25 m²; Turf's
polyclip-ts clipped it to 12'912.27 m². `make_valid(method="structure")`
reproduces Turf exactly (12'912.2662 m² on both; also 15'054.1420 m² on feature
33120505). Requires shapely ≥ 2.1 (`pyproject.toml` updated).

**Fix (implemented).** `geom_wgs84.intersect` uses `method="structure"`. Valid
geometries are unaffected (repair is a no-op), so the previously matching parcels
stay bit-identical.

### F5 — The Turf area port differs from Turf 7 at the last bits (Medium)

**What.** `geom_wgs84._ring_area` was a port of Turf 6.5's `ringArea`. Turf 7
(what the CDN serves — `@turf/turf@7` currently resolves to 7.4.0) rewrote it:
it skips the closing vertex, wraps indices modulo `coords.length - 1`, converts
degrees with a precomputed `PI_OVER_180` and scales by a precomputed `R²/2`. The
sums are mathematically equal but round differently (~1e-12 relative). After
porting the statement order, a residual 1e-11 remained: V8's `Math.sin` (fdlibm)
and the C runtime's `sin` differ by less than one ulp on **247 of the 3'965**
latitudes of that ring, and summed over thousands of near-cancelling terms that
moves a 29'000 m² area by 1e-6 m² — enough to flip an exported 0.01 m² now and then.

**Fix (implemented).** `_ring_area` is now a statement-for-statement port of
`@turf/area` 7.x, and `processing-cli/fdlibm.py` ports fdlibm's `sin` (the algorithm V8
uses). Validated bit for bit against Node on 200'011 random arguments (the
platform `sin` differed on 6'361 of them); 0.9 µs per call. The web app now pins
`@turf/turf@7.4.0` so the two cannot drift apart silently; bump both together.
Result: areas of identical geometries are **bit-identical** (asserted with `==`
in the tests). Clipped pieces still come from two different clippers (GEOS vs
polyclip-ts), whose intersection vertices differ in the last bits — measured
≤ 2e-5 m² on the largest piece, i.e. agreement to ~1e-8 relative (see R6).

### F6 — `bfsnr` is not the BFS municipality number (Medium, data)

**What.** The geo.admin.ch `find` service returns `ak, number, identnd,
egris_egrid, realestate_type, geoportal_url, label` — no BFS number. The web app
and the api source wrote `identnd` (the cadastral numbering-area id, e.g.
`BE0200000042`, `SG0200320300`) into `bfsnr`, which DATAMODEL.md documents as the
integer federal municipality number; the gpkg path writes the real number.
Downstream grouping by municipality would silently mix the two.

**Fix (implemented, both sides).** The AV land-cover surfaces carry `BFSNr`;
the parcel's `bfsnr` is now the number covering the largest share of its AV
pieces (ties → the smaller value; empty when no AV piece carries one, e.g.
synthetic-AV parcels and canton TI). The former value is exported as the new
column `nbident`. Verified on the 20-parcel set (6621 Genève, 2703 Basel, 3203
St. Gallen, 351 Bern …). DATAMODEL.md updated.

### F7 — Input normalisation differs between the two sides (Medium)

**What.** `user_input.py` trims cells; `upload.js` trims CSV cells but not Excel
cells, and neither side normalised the EGRID. ` ch4277…` resolved on one side
and was `invalid` on the other; a lower-case EGRID is never found.

**Fix (implemented).** `normalizeEgrid()` / `normalize_egrid()` (trim +
upper-case) at every input boundary (upload, CSV/Excel reader, `--egrid`), and
every cell is trimmed on both sides.

### F8 — gpkg clip aborts on one degenerate overlay feature (Medium)

`swisstopo.intersect_with_features` ran one vectorised `shapely.intersection`
with no fallback; a `GEOSException` on one feature aborted the run.
`_clip_single_parcel` already had the per-feature retry. **Implemented:** the same
fallback — the failing features are dropped with a warning.

### F9 — One malformed WFS geometry fails the whole parcel (Medium)

`api._norm_feature` called `shape()` eagerly inside the WFS try block, so a
single unparseable geometry produced `wfs_error` and no land cover, whereas the
web skips that feature (`check_geom = 1_skipped`). **Implemented:** the geometry
becomes `None` and counts as skipped, like the web.

### F10 — `identify` dedupe key collision (Low)

`r.featureId ?? r.id` with both absent gave `"undefined"` / `"None"`, so every
id-less result after the first was dropped. **Implemented:** id-less results key
on their serialized geometry + attributes.

### F11 — CSV dialect (Low)

The gpkg path wrote comma-delimited CSV without BOM; the web and api exports
write semicolon + BOM (what a Swiss-locale Excel opens directly). **Implemented:**
`data_io.write_csv` uses the same dialect. README updated.

### F12 — Unknown `Art` classified silently (Low)

The web classified any unknown BBArt with the fallbacks without a trace; the gpkg
path warned. **Implemented:** both the web and the api source warn once per
unknown value per run (the DMAV migration will rename values).

### F13 — `compare.py` (Low, tooling)

Parcels were matched by EGRID, so invalid rows (`0000000000`) collided and the
20-parcel set compared as 18. Detail diffs were only per `art`. **Implemented:**
key = `id` + `egrid`; detail layers also compared per feature `fid` (names the
missing or differently clipped piece).

### F14 / F15 — Maintainability of `processor.js`

`clipLandCover`, `makeSynthLandcoverRow` and `makeHabitatRow` repeated the same
25-key row literal; Python already had `_lc_row`. **Implemented:** one
`makeLandcoverRow` (key order preserved — it is the export header order — and
asserted by a test), shared `vbsLabels`. The 964-line module is split: `geoapi.js`
holds every live request (the twin of `api.py`), `processor.js` the clipping,
classification and aggregation (the twin of `processor_web.py`). The offline
report bundler discovers the new module automatically (import scan).

### F16 — Unpinned Turf (Robustness)

`https://unpkg.com/@turf/turf@7/turf.min.js` floats within the major range; the
area formula changed within 7.x once already. **Implemented:** pinned to 7.4.0
with a comment pointing at the Python port.

### F17 — No tests

See [Test layer](#test-layer).

---

## Not implemented (recommendations)

- **R1 `flaeche` is always empty on the web / api path** — the `find` service has
  no official area. Kept for schema stability; documented. Dropping the column
  from those exports is a one-line change if preferred.
- **R2 Overlapping Bauzonen** — when two zones overlap, `covered > parcel_area`
  and no `Ohne Bauzone` row is emitted; the zone sum exceeds the parcel area. Rare;
  a `check_bauzonen = overlap` flag would make it visible.
- **R3 Per-parcel request parallelism in the web** — WFS, BAFU and Bauzonen are
  fetched sequentially per parcel (8 parcels in parallel). Firing them together
  would cut wall time by roughly half for overlay runs but triples in-flight
  requests (24) and the risk of 429s; not changed.
- **R4 gpkg QA flags** — the gpkg path still has no `check_wfs` / `check_geom` /
  `check_habitat` / `check_bauzonen`, "Ohne Bauzone" remainder or habitat
  gap-fill (processing-cli/TODO.md). The tiling fix (F1) and the crash fix (F3) apply to
  it; parity of the gpkg path was not a goal here.
- **R5 Classification tables exist three times** (`config.js`, `config.py`,
  `data/landcover.json`). They are now guarded by tests that fail on any
  divergence; generating both code tables from the JSON would remove the
  duplication but changes the module load order of the web app.
- **R6 Clipper residual** — GEOS and polyclip-ts compute intersection vertices
  with different arithmetic. Clip areas agree to ~1e-8 relative (≤ 2e-5 m²
  measured); at the exported 0.01 m² precision a last-digit difference on a
  large piece is possible but was not observed on 1'300 features. Removing it
  would mean porting polyclip-ts (≈1'500 lines); not worth it.
- **R7 Land-cover `fid` is empty on the web / api path** — the WFS serves no
  feature ids (the gpkg path has them). Documented; per-fid comparison therefore
  applies to the overlay layers only.
- **R8 Habitat gap-fill heuristic** — attributes the uncovered area to the single
  dropped (null-geometry) feature. With complete fetching (F1) it is now applied
  to the right gap; a second dropped feature still yields `partial`.

---

## Parity verification

### Harness

- Parcel set: 20 parcels from the portfolio export covering every state —
  8 plain `found`, 3 synthetic AV (`lc_synthetic = yes`), 3 habitat `estimated`,
  2 Bauzonen `partial`, 3 `invalid`, 1 `not_found`; 1'434 m² to 48.9 ha
  (CH927796875952, 556 habitat features in its bbox).
- Web: Playwright drives the real app (upload, overlays + green inventory on,
  GeoJSON download). Python: `python main.py --input … --green-inventory`.
- `python compare.py web.geojson python.geojson --rtol 0 --atol 0`.

### Results

| Stage | Result |
|-------|--------|
| Before (committed code) | 15 differences, all on CH927796875952: 150 vs 156 habitat features, `habitat_l1_4_m2` 190'479.89 vs 214'753.85, `habitat_l2_9_3_m2` 42'632.32 vs 34'432.93, … |
| After F1 + F2 + F4 (tiling, page-until-empty, structure repair) | **MATCH — 20 / 20 parcels, zero tolerance** (habitat 157 features on both sides, `check_habitat` `estimated` → `ok`) |
| After F5 (Turf 7 formula + fdlibm sin) | **MATCH — 20 / 20 parcels, zero tolerance**; the Turf golden tests pass with `==` |
| Live fixture test (8 parcels, overlays on, green inventory off) | `LANDCOVER_LIVE=1 pytest tests/test_live_parity.py` → passed |

What "exact" means after this change set:

- parcel columns, flags, labels and every aggregated area: identical strings and
  doubles;
- areas of identical geometries (parcel area, feature areas): bit-identical;
- clipped-piece areas: identical at the exported precision, ~1e-8 relative at
  full precision (R6).

### How to re-run

```bash
# 1. export the parcel list from the web app (Download → GeoJSON) → web.geojson
# 2. python main.py --input parcels.csv --output-dir out   (same options as the web run)
# 3. python compare.py web.geojson out/<run>.geojson --rtol 0 --atol 0
```

---

## Test layer

| Suite | Runs with | What it pins down |
|-------|-----------|-------------------|
| `processing-cli/tests/test_parity_js.py` | `pytest` (+ Node) | Every classification table, `classify` / `classifyBafu` / `typochToBBArt`, TypoCH labels and codes, slugs and column keys, `toFixed(1)` / `round2`, `normalizeEgrid`, row shapes **and key order**, `aggregateLandCover` / `aggregateHabitat` / `aggregateBauzonen`, `dominantBfsnr` — evaluated in the browser modules via `tests/js_dump.mjs` and compared with the Python modules on `fixtures/parity_cases.json` |
| `test_geom_wgs84.py` | `pytest` | Turf 7.4.0 golden areas (bit-identical) and clips (to the exported digit), incl. two self-intersecting BAFU polygons |
| `test_fdlibm.py` | `pytest` | `fdlibm.sin` ≡ V8 `Math.sin` on 5'012 golden samples |
| `test_fetch_paging.py` | `pytest` | Fake services reproducing the server quirks: identify quadtree completeness, dedupe, depth cap, feature cap; WFS page-until-empty, short pages, overlap, cap, malformed geometry; gpkg tiled fetch |
| `test_user_input.py`, `test_export_web.py` | `pytest` | Upload contract (BOM, `sep=`, delimiter detection, trimming, EGRID normalisation, Excel numerics), CSV / GeoJSON serialisation |
| `test_live_parity.py` | `LANDCOVER_LIVE=1 pytest` | End-to-end: the Python api source reproduces a committed web export bit for bit |
| `processing-web/tests/*.test.mjs` | `npm test` (node:test, no dependencies) | `fetchIdentify` / `fetchLandCover` against the same fake services; `round2`, row builders, aggregations, `dominantBfsnr` |

Totals: 60 Python tests (+1 live), 13 JS tests.

---

## Behaviour changes to be aware of

- **`bfsnr`** on the web / api path is now the BFS municipality number (derived
  from the AV surfaces; empty where none carry it). The previous value is in the
  new **`nbident`** column. The gpkg path is unchanged.
- **Overlay fetching**: 1 request per parcel as before when a bbox holds < 200
  features, up to ~10 for very large parcels; results are sorted by feature id
  (detail-row order changes, values do not — except where features were lost).
- **Land-cover fetching**: +1 (empty) WFS request per parcel.
- **gpkg CSV**: semicolon-delimited, UTF-8 BOM.
- **Dependencies**: shapely ≥ 2.1; the web pins `@turf/turf@7.4.0`.
- **Inputs**: EGRIDs are trimmed and upper-cased on both sides.

---

## Post-review changes in the same change set

Done after the review at the owner's request; listed here so the diff reads as one.

- **Folders renamed** `web/` → `processing-web/`, `python/` → `processing-cli/`
  (consistent "what it is" naming next to `dashboard/`). Every path reference in
  docs, code, tests and the Claude settings was rewritten; a redirect stub stays at
  `web/index.html` so the old GitHub Pages URL keeps working (query string and
  hash are forwarded). The review text above uses the new paths.
- **Header**: logo removed; two-line title "Bundesamt für Bauten und Logistik /
  Auswertung Bodenbedeckung" in one style; the title stays visible on phones in
  the results view as the click-to-home control.
- **Processing log («Protokoll»)**, `processing-web/js/log.js`: one line per parcel
  from its `check_*` flags, collapsed below the progress card and above the results
  table, filters, copy / text export, completion toast. The processor's progress
  callback now carries the finished parcel (`progress.parcel`) and the result the
  `cancelled` flag — additive, the Python port is unaffected.
- **F18 (found while testing the log, pre-existing): "Neue Analyse" aborted when a
  map popup was open** — `map.remove()` fires the popup's `close` event after the
  style is gone and `clearIdentifyHighlight()` threw on `getLayer`, so the reset
  stopped half-way. Guarded in `map.js`.
- **Explainer («Kurz erklärt»)**, `processing-web/js/explainer.js`: eight
  CSS-animated SVG scenes on one real parcel (aerial excerpts, boundary, land cover,
  clip, classify, figures, result) with captions in the UI language below the upload
  card, start page only. Rebuilt twice after a separate review, see
  [2026-10-28-explainer-review.md](2026-10-28-explainer-review.md).
- **Dashboard map**: the Karte tab zooms with the plain mouse wheel (cooperative
  gestures were on for the single map); the Auswertung tab got its map back (the
  same map moves into a fixed-height slot with the simple legend, Karte-only
  controls hidden, cooperative gestures on because that page scrolls); the control
  stack is fullscreen · zoom · compass · home, all built-in buttons drawn with the
  Lucide icon set via CSS masks; MapLibre's control tooltips and gesture hint in German.
