# Code review — processing-cli: the same issues as in test-naturnah?

**Date:** 2026-11-10 · **Scope:** `processing-cli/` (`src/api.py`,
`src/processor_web.py`, `src/export_web.py`, `src/cli.py`; the `gpkg` path only
for the EGRID lookup) and, where the code is mirrored, the web app
(`processing-web/js/geoapi.js`, `processor.js`, `export.js`) · **Question:** does
the main tool have the bugs found in `test-naturnah/` the same day
([review](2026-11-10-test-naturnah-code-review.md))?

Short answer: one of the three serious ones in a milder form, one in full, one
partly. The first is fixed, the second is left for a decision because it
changes what the web app and the dashboard show.

## Summary

| # | Issue (number in the test-naturnah review) | In processing-cli? | Also in the web app? | Status |
|---|---|---|---|---|
| P1 | A shortened EGRID returns other parcels (F1) | **Yes**, for texts starting with `CH`. Empty and non-`CH` values were already rejected. | Yes | implemented in both (exact match) |
| P2 | A run can be lost; failed queries are never asked again (F2) | **Partly.** One parcel's error never stopped the run, but Ctrl-C lost everything and a failed query stayed failed. | No retry either; the browser keeps results on cancel | implemented in the CLI (retry rounds, interrupt-safe) |
| P3 | A failed query still gives numbers (F3) | **Yes.** A failed land-cover request gives 0 m² in every area column. | Yes, identical | **not implemented**, see below |
| P4 | Excel export: `=` texts and control characters (F9) | **Yes** | No (SheetJS writes text) | implemented in the CLI |
| P5 | Repeated EGRIDs are counted several times (F6) | **Yes**, without any flag | Yes | not implemented, see below |
| P6 | No single error column (F7) | Mostly fine: `errors` exists, but leaves out failed overlays | Same | not implemented |
| — | Rejected requests retried (F8) | No. 4xx is not retried. | No | — |
| — | Sequential processing (F11), no tests (F12) | No. Eight parcels in parallel; 60 tests before, 69 now. | — | — |

The `gpkg` source is not affected by P1: it selects parcels from the local
GeoPackage with an exact SQL comparison and validates the EGRIDs first.

---

## P1 — The parcel lookup matched substrings (High, implemented)

`fetch_parcel_geometry` asks the geo.admin.ch `find` service, which searches for
the text *inside* the EGRID unless told otherwise. The guard in `_process_one`
(`not egrid or not egrid.startswith("CH")`) stopped empty values and
placeholders like `0000000000`, but not a short text that starts with `CH`:

| Search text | Parcels returned before | With `contains=false` |
|---|---|---|
| `CH385146357691` (complete) | 1 | 1 |
| `CH38514635769` (last digit missing) | 1, reported as found | 0 |
| `CH12` | 201 unrelated parcels | 0 |
| `CH` | 201 unrelated parcels | 0 |

The 201 parcels were unioned into one geometry and reported as
`check_egrid = merged`, with land cover from all of them. A truncated EGRID
(a cut-off cell, a lost digit) came back as the real parcel under the wrong
identifier.

**Fix.** `contains=false` in the request, in `src/api.py` and in
`processing-web/js/geoapi.js`. The match is now exact; such rows end as
`not_found`. Exact matching is case-sensitive, which is safe because both sides
upper-case the EGRID on input. Tests on both sides run the lookup against a fake
service that behaves like the real one.

Checked live: the eight parcels of the parity fixture resolve exactly as before
(same output with and without the change).

## P2 — Failed queries stayed failed; Ctrl-C lost the run (Medium, implemented in the CLI)

What was already right: `_process_one` catches every exception, so one bad
parcel becomes an error row and the run goes on.

What was missing:

- Each request is retried four times within about four seconds. The services
  answer HTTP 502 in bursts that last longer (seen repeatedly on 10 Nov). A
  parcel hit by one stayed at `check_wfs = wfs_error` or `check_habitat = error`,
  and the only remedy was to run the whole list again.
- The exports are written after the last parcel. Ctrl-C lost everything.

**Fix** (`processor_web.process_rows`, CLI only; values of successful parcels
are unchanged, so web parity is not touched):

- After the first pass, parcels with a failed query are processed again, up to
  two rounds with a 20 s pause. A retry never replaces a partial result with a
  worse one.
- On Ctrl-C the finished parcels are kept, the remaining rows become error rows
  (`Not processed (run interrupted)`), and the exports are written.
- The CLI reports how many parcels still have a failed query at the end.

Not added: a checkpoint with `--resume` and an automatic stop during an outage,
as in test-naturnah. The result rows here hold geometries and internal fields,
so a checkpoint is a larger change. For scale: with the service down, each
parcel gives up after about a minute, eight at a time, so 2,133 rows take about
four and a half hours before the retry rounds. Ctrl-C now ends that cleanly.

## P3 — A failed land-cover request reads as 0 m² (High, not implemented)

When the WFS request fails, `fetch_landcover` returns no features and
`error = True`. The parcel row then gets `check_wfs = wfs_error`, and
`_aggregate_landcover([])` fills every area column with `0`: `sia416_*`,
`din277_*`, `sealed_m2`, `greenspace_m2`, all `av_*` columns. `parcel_area_m2`
is filled, because the parcel itself was found. In a sum over the portfolio such
a parcel counts as "no green space, nothing sealed".

The overlays behave better and worse at once: on an error `bauzonen` and
`habitat` stay empty, but the per-zone and per-habitat columns are filled with
`0` for every parcel in the flatten step, including the failed ones.

The web app does exactly the same; the Python code is its port.

**Why not fixed here.** Leaving these cells empty is the right behaviour, but it
has to change in three places at once: `processor.js`, `processor_web.py` and
the dashboard, which reads these columns as numbers. The parity tests compare
the first two value by value. That is a decision about the product, not a
clean-up.

**What limits the damage today.** The retry rounds of P2 make a lasting
`wfs_error` rarer. The row is flagged (`check_wfs`, `errors`), and the dashboard
counts such parcels (`wfsIssues`). The CLI now prints the number of parcels with
a failed query when it ends.

**Recommendation.** Empty instead of 0 for every value whose query failed, in
web app and CLI together, and the dashboard treating empty as "unknown".

## P4 — Excel export (Low, implemented)

As in test-naturnah: openpyxl stores a text starting with `=` as a formula and
raises on a control character. Input columns are passed through as `input_*`,
so one such cell in a list either became a live formula or aborted the export
after the whole run. The web export (SheetJS) writes such a text as text, so
this was also a difference between the two.

**Fix.** `export_web._cell_value` removes control characters; `_append_row`
keeps `=` texts as text.

Not changed: the CSV export writes such a text unchanged, in the web app and in
the CLI alike. Excel evaluates it when the CSV is opened. The usual remedy
(a leading apostrophe) alters the data and would have to be done on both sides.

## P5 — Repeated EGRIDs (Medium, not implemented)

Rows with the same EGRID are processed independently. The parcel geometry is
cached, the land cover and the overlays are fetched again, and each row carries
the full areas. Nothing marks the repeat, so a sum counts the parcel twice. The
BBL list of 10 Nov has 13 such EGRIDs in 28 rows. The web app behaves the same.

**Recommendation.** A count column or an entry in `errors`, on both sides. Not
done because it adds a column the web app must add too.

## P6 — The `errors` column (Low, not implemented)

`errors` holds an invalid or unknown EGRID, a runtime error and a failed
land-cover request (the last only when no land cover at all came back). A failed
Bauzonen or habitat request, a truncated result and skipped geometries are only
in their `check_*` columns. Reading four columns to find the problem rows is
workable; one complete column would be better, again on both sides.

---

## Other observations

- **Live parity test fails.** `LANDCOVER_LIVE=1 pytest tests/test_live_parity.py`
  reports two differences at zero tolerance, both sums of land-cover areas that
  agree to the cent (266.49 and 399.11 m²). The result is the same with and
  without today's changes. The fixture is a web export of an earlier date; the
  README says to re-export it when the cadastral data changes. Not investigated
  further.
- **Packaging.** `pyproject.toml` pointed to a module folder that does not exist.
  Fixed with the new layout (see the test-naturnah review, follow-up section).
  `pip install` was not tried.
- **Input formats.** The CLI needs an `id` and an `egrid` column, as the web
  upload does. A SAP list export is rejected with a clear message. If the CLI
  should read such lists, `test-naturnah/src/inputs.py` does it.

## Verification

- `python -m pytest processing-cli -q`: 69 passed, 1 skipped (9 new in
  `tests/test_robustness.py`).
- `npm test`: 23 passed (1 new, the exact lookup in `geoapi.js`).
- `python -m pytest test-naturnah/tests -q`: 20 passed; its copy of `api.py` was
  updated with the fix.
- One parcel run through the CLI from the new entry point, outputs in `out/`.
