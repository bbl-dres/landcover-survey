# test-naturnah — sample analysis of near-natural areas

Experimental. Spatial join between cadastral parcels (EGRID) and the data sources
of the BAFU list «M5 Übersicht Datenquellen naturnahe Flächen» (version of
3 Nov 2026). It answers: how much area of each listed element lies on each parcel?

This is a sample analysis ("stichprobenmässig"), not a measurement of the 30 %
target. The layers show where an inventory or a subsidised agricultural use is
registered, not how an area is actually managed.

## Requirements

Python 3.10 or newer, internet access, and:

| Package | Needed for |
|---|---|
| `shapely` >= 2.1 | geometry (clip, union) |
| `pandas`, `openpyxl` | reading CSV / Excel lists, writing the workbook |
| `pytest` | tests only |

```bash
pip install shapely pandas openpyxl pytest
```

## Run

```bash
cd test-naturnah
python main.py --egrid CH409635764678
python main.py --input "in/BBL Grundstücke 2026-11.txt"
python -m pytest tests -q          # offline tests
```

| Option | Meaning |
|---|---|
| `--input <file>` | SAP list export (`.txt`), CSV or Excel. See [Input](#input). |
| `--egrid <EGRID,…>` | One or more EGRIDs instead of a file. |
| `--output-dir <dir>` | Default `./out`. |
| `--limit <n>` | Only the first *n* input rows. |
| `--resume <file.jsonl>` | Checkpoint of an earlier run: reuse what is complete, query the rest. |
| `--workers <n>` | Parcels in parallel (default 4). |

## Layout

```
test-naturnah/
├── main.py     entry point (the only script in the main folder)
├── src/        the code (see Files)
├── tests/      offline tests
├── docs/       DATAMODEL.md
├── in/         your input lists (gitignored)
└── out/        results (gitignored, created on the first run)
```

`in/` and `out/` are gitignored: the parcel list and the results are portfolio
data and do not belong in the repository.

## Input

Only one column is required: **EGRID** (header `EGRID` or `E-GRID`). All other
columns are free, can differ from list to list, and are carried to the result
as `in_<attribute>`. The attribute name is the header in lower case without
special characters: `Bez. Grundstück` → `in_bez_grundstueck`, `Haus-Nr.` →
`in_haus_nr`, `E-GRID` → `in_egrid`.

Formats: a SAP list export («Dynamische Listenausgabe», `.txt`, the `|`-framed
table), CSV or Excel.

An EGRID is only looked up when it is complete (`CH` + 12 characters). Rows
without one, or with a placeholder such as `0000000000`, stay in the result with
empty values. The same EGRID in several rows is queried once; `out_egrid_count`
shows how often it occurs.

Whatever is wrong with a row is written to `out_error`: missing, invalid,
repeated or unknown EGRID, and failed queries with the answer of the service.
An empty `out_error` means the row is fine.

## Output

Outputs go to `./out`, timestamped:

- `naturnah_<ts>.xlsx` with two sheets (attributes: [docs/DATAMODEL.md](docs/DATAMODEL.md)):
  - **Grundstücke**: one row per input row, all `in_` columns, `out_error`, one
    `out_<element>_m2` column per element, the totals per category (`out_kat<n>_m2`),
    `out_naturnah_total_m2`, `out_naturnah_anteil_pct` (share of the area of the
    Grundstück) and `out_blw_total_m2`.
  - **Datenmodell**: every attribute of the workbook and of the GeoJSON with its
    format, description and source (layer, Kultur-Code, row of the BAFU list).
- `naturnah_<ts>.geojson`, for QGIS: the Grundstücke (`layer` = `grundstueck`) and
  the clipped objects on them (`layer` = `naturnah`). The objects include every BLW
  area on a Grundstück, also those whose Kultur-Code is not in the list, so missing
  codes can be spotted.
- `naturnah_<ts>.jsonl`: checkpoint, one line per finished EGRID (for `--resume`).
- `naturnah_<ts>.log`

## Sources in this first sample

All layers come live from the geo.admin.ch API (`identify`), per parcel.

| Column | Rows of the list | Layer | Filter |
|---|---|---|---|
| `out_tww_m2` | 2 | `ch.bafu.bundesinventare-trockenwiesen_trockenweiden` | all |
| `out_magerwiesen_611_m2` | 3 | `ch.blw.landwirtschaftliche-nutzungsflaechen` | `lnf_code` 611 |
| `out_wenig_intensiv_612_m2` | 4 | same | 612 |
| `out_streue_851_m2` | 5 | same | 851 |
| `out_hecken_852_m2` | 6 | same | 852 |
| `out_brachen_556_557_m2` | 10 | same | 556, 557 |
| `out_ruderal_stein_mauer_905_m2` | 11–13 | same | 905 |
| `out_hochmoor_m2` | 17 | `ch.bafu.bundesinventare-hochmoore` | all |
| `out_flachmoor_m2` | 18 | `ch.bafu.bundesinventare-flachmoore` | all |
| `out_auen_m2` | 20 | `ch.bafu.bundesinventare-auen` | all |

The element table is `src/sources.py`; adding a layer or a code is one entry there.

## How to read the numbers

- Areas are clipped to the parcel boundary and computed like in the web app
  (spherical, EPSG:4326).
- Overlapping objects count once per element, per category and in the total. The
  total can therefore be smaller than the sum of the element columns (a Flachmoor
  that is also a Streuefläche).
- An empty cell means not queried; `0` means queried, no area. When a layer could
  not be queried, its elements, their categories and the total stay empty and
  `out_check_naturnah` names the layer. Re-run with `--resume` to fill them.
- Summing a column over all rows counts a parcel twice when its EGRID is listed
  twice (`out_egrid_count` > 1). A Baurecht and the parcel it lies on can overlap
  too.
- Values of a few cm² to m² are edge slivers from objects on the neighbouring
  parcel.

## When the service fails

geo.admin.ch answers HTTP 502 in bursts. Requests are retried; what still fails
is marked and the run goes on. Every finished parcel is written to the
checkpoint at once, so nothing is lost on a crash or Ctrl-C. After ten failed
parcels in a row the run stops by itself and writes what it has. In all these
cases the log ends with the command to continue:

```bash
python main.py --input "in/BBL Grundstücke 2026-11.txt" --resume out/naturnah_<ts>.jsonl
```

## Known limits

- Rows 8 and 9 of the list (Kultur-Codes 921–924, trees) have no column: the BLW
  layer holds no object with these codes.
- Rows 11–13 of the list share Kultur-Code 905, so they are one column. The layer
  names 905 «Ruderalflächen, Steinhaufen und -wälle» and has a separate code 906
  «Trockenmauern», which the list does not mention.
- Not covered yet: rows 7, 14, 15, 16, 19, 21–25 and the Lebensraumkarte Gehölze
  (reasons in [docs/DATAMODEL.md](docs/DATAMODEL.md#3-what-is-measured), «Not measured»). The Bestockungskarte cannot be queried through
  `identify`.
- The BLW layer covers agricultural land with direct payments only; building
  parcels will mostly return nothing from it.
- Areas are spherical, as in the web app. They differ from the planar LV95 area
  of the official survey by up to about 0.3 %.

## Files

| File | Role |
|---|---|
| `main.py` | Entry point; only starts `src/cli.py` |
| `src/cli.py` | CLI, per-parcel join, checkpoint, Excel / GeoJSON export |
| `src/inputs.py` | Input reader (SAP list export, CSV, Excel) |
| `src/sources.py` | Element table (layer, Kultur-Codes, category) and data dictionary |
| `src/api.py`, `geom_wgs84.py`, `fdlibm.py`, `user_input.py` | Unchanged copies from `processing-cli/src/` (a test fails when they drift) |
| `tests/` | Offline tests |
| `docs/DATAMODEL.md` | Input, data sources, what is measured, the output columns and how to read them |
