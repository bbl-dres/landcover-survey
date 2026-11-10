# Code review — test-naturnah (near-natural sample analysis)

**Date:** 2026-11-10 · **Scope:** `test-naturnah/` (`src/cli.py`, formerly `main.py`;
`src/sources.py`; the use of the copied `api.py` / `geom_wgs84.py` / `user_input.py`) and the real
input list `in/BBL Grundstücke 2026-11.txt` · **Goal:** bugs and errors before
the first run on the whole BBL portfolio. Added topics: robustness of a long run
against a flaky service, correctness of the numbers when something fails,
input handling, data protection, performance, tests.

Every finding was checked against the live service or the real list before a
fix was written. Findings marked *implemented* are in this change set. The full
list has **not** been run yet; only its first 120 rows, as a smoke test.

## Summary

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| F1 | An empty or shortened EGRID returns *other* parcels and is reported as "EGRID found" | **High** | implemented (only a complete EGRID is looked up) |
| F2 | Any crash or Ctrl-C loses the whole run; a service outage makes it run for days | **High** | implemented (checkpoint, `--resume`, automatic stop) |
| F3 | When a layer fails, category and total still show a number | **High** | implemented (dependent values stay empty) |
| F4 | Kultur-Codes 921–924 do not exist in the BLW layer: two columns are always 0 | Medium | implemented (columns removed, listed as not covered) |
| F5 | The real list cannot be read (SAP list format, no ID column) | Medium | implemented (`inputs.py`; only EGRID is required) |
| F6 | The same EGRID in several rows is queried and counted several times | Medium | implemented (queried once, `out_egrid_count`) |
| F7 | No single place shows what is wrong with a row; the service's error text is lost | Medium | implemented (`out_error`) |
| F8 | A request the service rejects (HTTP 4xx) is retried with 10 s pauses | Low | implemented |
| F9 | An input value starting with `=` becomes an Excel formula; a control character aborts the export | Low | implemented |
| F10 | A typo in the element table surfaces as a `KeyError` in the middle of a run | Low | implemented (`check_sources`) |
| F11 | Parcels are processed one after the other | Performance | implemented (4 in parallel) |
| F12 | No automated tests | Maintainability | implemented (20 offline tests) |
| R1–R9 | Open points and recommendations not implemented | — | see [Not implemented](#not-implemented) |

---

## Method

1. Read the CLI module and `sources.py` end to end, and the copied modules for
   the assumptions the CLI makes about them.
2. Profiled the real list: 2,133 rows, 21 columns.
3. Probed geo.admin.ch wherever the code assumed something about the service:
   how `find` matches its search text, which Kultur-Codes the BLW layer holds,
   whether the fallback for objects without geometry works.
4. Wrote a failing test for each bug, then the fix.

## The input list

| | Rows |
|---|---|
| Total | 2,133 |
| Complete EGRID (`CH` + 12 characters) | 1,558 |
| Placeholder `0000000000` | 561 |
| Empty EGRID | 14 |
| Distinct complete EGRIDs | 1,543 |
| Rows whose EGRID occurs more than once | 28 (12 EGRIDs twice, one four times) |

Of the 561 placeholder rows, 305 are properties abroad (FR, PK, US, DE, IT, …)
and 256 are in Switzerland. No row abroad has a real EGRID.

---

## Findings

### F1 — An empty or shortened EGRID returns other parcels (High)

`api.fetch_parcel_geometry` looks a parcel up with the `find` service, which is
a **substring** search. Probes:

| Search text | Parcels returned |
|---|---|
| `CH385146357691` (complete) | 1 |
| `CH3851463576` (two characters short) | 1, the same parcel |
| `8514635769` (digits from the middle) | 1, the same parcel |
| *(empty)* | 201 arbitrary parcels |

The CLI passed every row to the lookup. The 14 rows with an empty EGRID would
each have come back as 201 unrelated parcels, unioned into one geometry, with
`check_egrid = "EGRID found"` and areas from all over the country. The
placeholder `0000000000` returns nothing today, but only because no EGRID
happens to contain ten zeros.

**Fix.** `EGRID_RE = ^CH[0-9A-Z]{12}$`. Only a complete EGRID reaches the
service; a 14-character text cannot match a different 14-character EGRID. Other
rows stay in the result with `EGRID missing` / `Invalid EGRID` and empty values.
`api.py` is unchanged; the main CLI already guards this case
(`processor_web.py`, `not egrid or not egrid.startswith("CH")`).

### F2 — A long run can be lost, or never end (High)

The outputs were written once, after the last parcel. An unexpected exception in
one parcel (a GEOS error in the union, a malformed answer) or Ctrl-C lost
everything before it.

The opposite case: when the service is down, each layer of each parcel runs
through all retries. Worst case per layer is 3 attempts × (4 requests × 15 s
timeout + backoff) + 2 × 10 s pause ≈ 3.5 minutes, so about 17 minutes per
parcel and more than two weeks for 1,543 parcels.

**Fix.**

- `safe_process`: an unexpected error costs one parcel (`out_error` says which).
- Checkpoint `naturnah_<ts>.jsonl`: every finished EGRID is appended at once.
- `--resume <checkpoint>` reuses what is complete and queries only what failed
  or is missing. A cut-off last line (killed while writing) is skipped. A
  checkpoint written with a different element table is not reused.
- After 10 failed parcels in a row the run stops, tells parcels still in flight
  to give up, and writes the outputs. Rows it did not reach say `Not processed`.
- Ctrl-C does the same.

### F3 — A failed layer still gave a category and a total (High)

When a layer could not be queried, its element column was empty (correct), but
the category and `naturnah_total_m2` were computed from the layers that did
answer. With every layer failing, a parcel showed total 0 and share 0 %, which
reads as "queried, nothing there". The README called this a lower bound and
pointed to the check column. Nobody reads a check column after summing 2,000
rows.

**Fix.** A value is empty as soon as one layer it depends on failed: the
elements of that layer, every category they belong to, the total and the share.
Values that do not depend on it stay. `--resume` fills the gaps.

Not changed: a layer that answered but hit the 5,000-object limit, or delivered
an object without geometry that could not be fetched, keeps its number and is
flagged in `out_error`. Neither case occurred in any test.

### F4 — Kultur-Codes 921–924 are not in the layer (Medium)

The BAFU list gives codes 921–923 for Hochstammobstgärten (row 8) and 924 for
Einzelbäume (row 9). Searching the BLW layer by `lnf_code`:

| Code | Objects | Name in the layer |
|---|---|---|
| 611, 612, 851, 852, 556, 557, 905 | 201 each (the service's cap) | as in the list |
| 921, 922, 923, 924 | **0** | — |

Trees are presumably recorded as a count, not as an area. The two columns were
0 for every parcel in the country, and 0 means "queried, nothing there".

**Fix.** Both elements and category 3 are removed from the output and listed
under «Nicht abgedeckt» in the «Quellen» sheet with the reason.

### F5 — The real list could not be read (Medium)

The list is a SAP «Dynamische Listenausgabe»: a title block, then a table framed
with `|`. `user_input.read_rows` took the `.txt` for a CSV and stopped with
"missing required column(s): id, egrid". The list has no ID column at all, and
its EGRID column is headed `E-GRID`.

**Fix.** New `src/inputs.py`:

- reads the SAP list (title and separator lines skipped, a repeated page header
  too; a row with a different number of cells stops the run with its line
  number), CSV and Excel;
- requires **only an EGRID column** (`EGRID` or `E-GRID`);
- knows no other column. Every column is carried to the result as
  `in_<attribute>`, the name derived from the header (`Bez. Grundstück` →
  `in_bez_grundstueck`). For the BBL list that is 21 `in_` columns, checked
  against the output of the smoke run.

### F6 — Repeated EGRIDs (Medium)

1,558 rows hold 1,543 distinct EGRIDs. Each repeat cost a second round of
requests, and both rows carried the full area, so a column sum counted the
parcel twice without any hint.

**Fix.** Each distinct EGRID is queried once. «Parzellen» keeps one row per
input row; `out_egrid_count` and `out_error` (`EGRID mehrfach in der Liste
(n×)`) mark the repeats. «Details» and the clipped pieces in the GeoJSON exist
once per EGRID.

### F7 — No single error column (Medium)

Problems were spread over `check_egrid`, `check_naturnah` and the log, and the
text the service answered with (`HTTP Error 502: Bad Gateway`) was only in the
log.

**Fix.** `out_error`, the first `out_` column: everything wrong with the row,
empty when it is fine. It covers a missing, invalid, repeated or unknown EGRID,
a failed parcel lookup and each failed or incomplete layer, the last two with
the service's answer. The full list of entries is in
`test-naturnah/docs/DATAMODEL.md`.

### F8 — Rejected requests were retried (Low)

`clip_layer` retried on every exception. An HTTP 400 (the service rejects the
layer or the request) was asked three times with 10 s pauses, per parcel.

**Fix.** 4xx other than 429 is not retried.

### F9 — Excel export and input values (Low)

openpyxl stores a text starting with `=` as a formula and raises
`IllegalCharacterError` on a control character. Input columns are now written
to the workbook unchanged, so a cell such as `=…` in the list would become a
live formula in the result, and one stray control character would abort the
export after the whole run.

**Fix.** `_append` removes control characters and keeps such texts as text.

### F10 — Element table consistency (Low)

An element pointing to a category missing from `KATEGORIEN`, or to a layer
missing from `LAYERS`, raised a `KeyError` only when the first parcel was
processed.

**Fix.** `check_sources()` runs before anything is fetched.

### F11 — Sequential processing (Performance)

**Fix.** Distinct EGRIDs run four at a time (`--workers`). Measured on the
first 120 rows of the list: 90 parcels, five layers each, in 8 seconds with the
service healthy. The whole list should take a few minutes on a good day.

### F12 — No tests (Maintainability)

**Fix.** `test-naturnah/tests/test_naturnah.py`, 20 tests, no network (the two
`api` calls are replaced by a fake service). They cover the input formats, the
EGRID gate, overlap and code filter, a failed layer, the geometry fallback,
resume, the automatic stop, `out_error` and the exports. Four of them fail when
a copied module (`api.py`, `geom_wgs84.py`, `fdlibm.py`, `user_input.py`)
differs from its original in `processing-cli/src/`.

---

## Not implemented

| # | Point | Why not |
|---|-------|---------|
| R1 | **Codes the list does not mention.** The layer has 906 «Trockenmauern» next to 905 «Ruderalflächen, Steinhaufen und -wälle»; the list puts Trockensteinmauern (row 13) under 905. It also has 857 and 858, two further hedge types, next to 852. | A decision for BAFU. Nothing is lost meanwhile: «Details» lists every code on a parcel. |
| R2 | **Personal data.** `in_verantw` carries SAP user IDs (14 different ones) into the workbook. | All input columns were asked for. Remove the column before the result leaves BBL. `in/` and `out/` are gitignored. |
| R3 | **Overlapping parcels.** A Baurecht and the parcel it lies on can both be in the list; their areas then overlap. | Detecting it needs a parcel-against-parcel overlay. Noted in the workbook. |
| R4 | **Coordinates in the list.** `Koordinaten` is written as latitude, longitude in 1,530 rows and as longitude, latitude in 28; 2 rows are neither; 573 are empty. | The tool does not use the column. Worth reporting to the owner of the SAP data. |
| R5 | **Spherical areas.** Areas follow the web app (spherical). For the Auen object «Belper Giessen» that gives 4,164,249 m² against 4,175,464 m² in the layer's own `shape_area` (0.27 % less). | Consistent with the main tool by design; stated in the README. |
| R6 | **Local join instead of the API.** Downloading the layers once would make the run independent of the service. | Not needed at this size (F11), and the run can now be resumed (F2). |
| R7 | **Copied modules.** Importing from `processing-cli/` would avoid the copies. | The copy was the chosen setup for an experiment; drift is caught by a test. |
| R8 | **Two copies of the data dictionary.** `src/sources.py` (German, feeds the «Datenmodell» sheet) and `docs/DATAMODEL.md` (English). | A test checks that every `out_` column is described in the sheet; the Markdown is kept by hand. |
| R9 | **Mixed languages.** `out_check_egrid` is English (as in the main tool), `out_check_naturnah` and `out_error` are German. | Cosmetic; changing `out_check_egrid` would break the likeness to the main tool. |

Not verified: whether the BLW layer covers every canton equally. A parcel in a
canton without data would show 0, not empty.

---

## Verification

- `python -m pytest test-naturnah/tests -q`: 20 passed.
- `python -m pytest processing-cli -q`: 60 passed, 1 skipped (untouched, run to
  confirm the copies still match).
- Seven EGRIDs used before the review (six in the layers, one unknown): same
  areas as before to the cent, the unknown one `EGRID not found`.
- First 120 rows of the BBL list: 96 rows with a complete EGRID, 90 distinct,
  all 90 found, none incomplete; 24 rows `EGRID ungültig`; 10 rows flagged as
  repeats; all 21 input columns present as `in_`.

---

## Follow-up — folder layout

Done in the same change set, for `test-naturnah/` and `processing-cli/` alike:

```
<tool>/
├── main.py   entry point, only starts src/cli.py
├── src/      the code
├── tests/
├── docs/     DATAMODEL.md (test-naturnah) · TODO.md (processing-cli)
├── in/       input lists (gitignored)
└── out/      results (gitignored)
```

- Imports are unchanged: `main.py` and the test setup put `src/` on the path.
- `processing-cli` now writes to `out/` by default. Before, it wrote next to the
  input file, or to `./data` when started with `--egrid`.
- `processing-cli/pyproject.toml` pointed its module folder at a path that does
  not exist (`processing-cli/processing-cli`); it now points at `src/`, with
  `cli:main` as the console script.
- Paths in comments and docs follow (`processing-cli/src/…`,
  `processing-cli/docs/TODO.md`). The review of 2026-10-28 keeps the old paths,
  as a record of that date.
- Both READMEs list the required packages in one table.
