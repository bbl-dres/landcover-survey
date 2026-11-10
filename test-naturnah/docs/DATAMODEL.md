# Data model — test-naturnah

What goes in, which layers are joined, and what comes out. For how to run the
tool and how to read the numbers, see [README.md](../README.md).

All geometry is **EPSG:4326** (WGS84); areas are spherical, in m², rounded to
two decimals. The same dictionary is written to the «Datenmodell» sheet of every
output workbook (source: `src/sources.py`).

```
input list (EGRID + any other columns)
      │
      ▼
parcel geometry  ◄── ch.kantone.cadastralwebmap-farbe (by EGRID, once per distinct EGRID)
      │
      ├─ clip ── ch.blw.landwirtschaftliche-nutzungsflaechen  (filter: lnf_code)
      ├─ clip ── ch.bafu.bundesinventare-trockenwiesen_trockenweiden
      ├─ clip ── ch.bafu.bundesinventare-hochmoore
      ├─ clip ── ch.bafu.bundesinventare-flachmoore
      └─ clip ── ch.bafu.bundesinventare-auen
      │
      ▼
Parzellen (1 row per input row)  ──n:1── EGRID ──1:n──  Details (1 row per clipped object)
```

---

## Column prefixes

Every column of the outputs starts with one of two prefixes:

| Prefix | Meaning |
|---|---|
| `in_` | Taken unchanged from the input list: every input column as `in_<attribute>`. |
| `out_` | Produced by this tool: fetched from a layer or computed. |

Which layer an `out_` column comes from is listed below and in the «Quellen»
and «Datenmodell» sheets.

---

## Input — parcel list

| Column | Required | Description |
|---|---|---|
| `EGRID` (or `E-GRID`) | Yes | Federal parcel identifier, e.g. `CH409635764678`. Join key. Trimmed and upper-cased. |
| *(any other column)* | No | Kept and carried to the result. |

Nothing but the EGRID column is fixed: the other columns can differ from list
to list and all of them are kept, in input order. The attribute name is derived
from the header (`slug` in `src/inputs.py`): lower case, umlauts written out, every other
character replaced by `_`. The output adds `in_`.

| Header (examples) | Attribute in the output |
|---|---|
| `E-GRID`, `EGRID` | `in_egrid` |
| `ID` | `in_id` |
| `Bez. Grundstück` | `in_bez_grundstueck` |
| `Haus-Nr.` | `in_haus_nr` |
| `L/R` | `in_l_r` |

Two headers that give the same name get a number appended.

Formats (`src/inputs.py`):

- **SAP list export** («Dynamische Listenausgabe», `.txt`): the table whose rows
  start and end with `|`; title and separator lines are skipped.
- **CSV / Excel**: delimiter detection as in the main CLI.

Only a complete EGRID (`CH` + 12 characters) is looked up. The parcel lookup of
geo.admin.ch is a substring search, so an empty or shortened value would return
other parcels.

---

## Source layers

All layers are queried per parcel through the geo.admin.ch `identify` service
(`https://api3.geo.admin.ch/rest/services/all/MapServer/identify`). The attribute
lists below are what the service returned in November 2026. "Used as" names the
output column; attributes without an entry are not exported.

### `ch.kantone.cadastralwebmap-farbe` — parcel

Looked up by EGRID. Delivers the parcel polygon and the parcel number (`number`
→ `out_nummer`).

### `ch.blw.landwirtschaftliche-nutzungsflaechen` — BLW Nutzungsflächen

Agricultural land-use polygons (MultiPolygon), one per cultivated unit. Rows 3–6
and 8–13 of the BAFU list. Filtered by Kultur-Code.

| Attribute | Type | Description | Used as |
|---|---|---|---|
| `lnf_code` | integer | Kultur-Code of the unit (e.g. 611). Filter for the elements. | `out_kultur_code` |
| `nutzung_de`, `_fr`, `_it` | text | Name of the land use for the Kultur-Code | `out_bezeichnung` (de) |
| `hauptkategorie_de`, `_fr`, `_it` | text | Main category (Ackerfläche, Dauerwiesen, …) | |
| `bff_qualitaet_1` | text | Biodiversitätsförderfläche quality level I (`"1"` yes, `"0"` no) | `out_bff_qualitaet_1` |
| `bezugsjahr` | integer | Reference date as YYYYMMDD (e.g. 20250101) | `out_bezugsjahr` |
| `flaeche_m2` | integer | Area of the whole object according to the source (not clipped) | |
| `bewirtschaftungsgrad` | integer | Share of the unit that is managed, in % | |
| `nutzungsidentifikator` | text | Identifier of the unit in the cantonal system | |
| `bur_nr` | text | BUR number of the farm. Identifies a business; deliberately not exported. | |
| `t_id`, `label` | text | Technical object identifier | |

### `ch.bafu.bundesinventare-trockenwiesen_trockenweiden` — TWW

Federal inventory of dry meadows and pastures (MultiPolygon, one per
Teilobjekt). Row 2. No filter.

| Attribute | Type | Description | Used as |
|---|---|---|---|
| `name` | text | Object name | `out_bezeichnung` |
| `objnummer` | integer | Object number in the inventory | `out_objnummer` |
| `teilobjnummer` | text | Number of the Teilobjekt (e.g. `BE2130018`) | |
| `bewertung` | integer | Rating of the Teilobjekt | |
| `singularitaet` | text | Singularity (Ja / Nein) | |
| `shape_area` | float | Area of the whole object in m² (not clipped) | |
| `refobjblat` | URL | Object sheet (PDF) | |

### `ch.bafu.bundesinventare-hochmoore` — Hochmoore

Federal inventory of raised bogs (Polygon, one per mapping unit, so one object
number has several polygons). Row 17. No filter.

| Attribute | Type | Description | Used as |
|---|---|---|---|
| `name` | text | Object name | `out_bezeichnung` |
| `objnummer` | integer | Object number in the inventory | `out_objnummer` |
| `hochmoore_type_de`, `_fr`, `_it` | text | Type (e.g. Primäre Hochmoorfläche) | |
| `hm_ke`, `unit_de`, `_fr`, `_it` | integer / text | Mapping unit (e.g. Birken- und Fichtenmoore) | |
| `shape_area` | float | Area of the polygon in m² (not clipped) | |
| `refobjblat` | URL | Object sheet (PDF) | |

### `ch.bafu.bundesinventare-flachmoore` — Flachmoore

Federal inventory of fens (MultiPolygon). Row 18. No filter.

| Attribute | Type | Description | Used as |
|---|---|---|---|
| `name` | text | Object name | `out_bezeichnung` |
| `objnummer` | integer | Object number in the inventory | `out_objnummer` |
| `shape_area` | float | Area of the whole object in m² (not clipped) | |
| `refobjblat` | URL | Object sheet (PDF) | |

### `ch.bafu.bundesinventare-auen` — Auen

Federal inventory of alluvial zones (MultiPolygon). Row 20. No filter.

| Attribute | Type | Description | Used as |
|---|---|---|---|
| `name` | text | Object name | `out_bezeichnung` |
| `objnummer` | integer | Object number in the inventory | `out_objnummer` |
| `auen_type`, `auen_type_de`, `_fr`, `_it` | integer / text | Type of alluvial zone (e.g. Fliessgewässer) | |
| `shape_area` | float | Area of the whole object in m² (not clipped) | |
| `refobjblat` | URL | Object sheet (PDF) | |

---

## Output — sheet «Parzellen»

One row per input row, in input order, also when the EGRID is missing, invalid
or not found.

| Attribute | Unit | Description |
|---|---|---|
| `in_<attribute>` | | Every column of the input list, unchanged and in input order (see [Input](#input--parcel-list)) |
| `in_egrid` | | Federal parcel identifier; key to «Details» |
| `out_error` | | Everything that is wrong with the row, separated by `; `. Empty = fine. See [Errors](#errors--out_error). |
| `out_check_egrid` | | `EGRID found`, `EGRID not found`, `EGRID missing` (empty), `Invalid EGRID` (not `CH` + 12 characters), `Not processed` (run stopped before) or `Error: …` |
| `out_egrid_count` | | Number of input rows with this EGRID. Above 1 the same parcel is listed several times. |
| `out_nummer` | | Official parcel number |
| `out_parcel_area_m2` | m² | Calculated parcel area |
| `out_check_naturnah` | | `ok`, or the layers that failed (with the answer of the service), were truncated or had objects without geometry. Empty when the parcel was not found. |
| `out_tww_m2` | m² | Trockenwiesen und -weiden (row 2, category 1) |
| `out_magerwiesen_611_m2` | m² | Magerwiesen/-weiden, Kultur-Code 611 (row 3, category 1) |
| `out_wenig_intensiv_612_m2` | m² | Wenig intensiv genutzte Wiesen, 612 (row 4, category 1) |
| `out_streue_851_m2` | m² | Streueflächen, 851 (row 5, category 1) |
| `out_hecken_852_m2` | m² | Hecken, Feld- und Ufergehölz, 852 (row 6, category 2) |
| `out_brachen_556_557_m2` | m² | Bunt- und Rotationsbrachen, 556, 557 (row 10, category 4) |
| `out_ruderal_stein_mauer_905_m2` | m² | Ruderalflächen / Steinhaufen / Trockensteinmauern, 905 (rows 11–13, category 4) |
| `out_hochmoor_m2` | m² | Hochmoore (row 17, category 6) |
| `out_flachmoor_m2` | m² | Flachmoore (row 18, category 6) |
| `out_auen_m2` | m² | Auen (row 20, category 7) |
| `out_kat1_m2` | m² | Category 1: Naturnahe Wiesen & Weiden |
| `out_kat2_m2` | m² | Category 2: Hecken, Feldgehölze, Waldränder |
| `out_kat4_m2` | m² | Category 4: Brachen, Ruderalflächen, Stein-/Kiesflächen, Trockenmauern |
| `out_kat6_m2` | m² | Category 6: Feuchtgebiete |
| `out_kat7_m2` | m² | Category 7: Auen |
| `out_naturnah_total_m2` | m² | Union of all elements on the parcel |
| `out_naturnah_anteil_pct` | % | `out_naturnah_total_m2 / out_parcel_area_m2 × 100` |
| `out_blw_total_m2` | m² | All BLW land on the parcel (every Kultur-Code), as context |

### Errors — `out_error`

The one column to filter on. It collects every problem of a row; the two
`out_check_` columns keep the detail per step.

| Entry | Meaning | Values of the row |
|---|---|---|
| `EGRID fehlt` | The EGRID cell is empty. | empty |
| `EGRID ungültig` | Not `CH` + 12 characters (placeholder, truncated value). | empty |
| `EGRID mehrfach in der Liste (n×)` | The same EGRID stands in *n* rows. | filled, identical in each of these rows |
| `EGRID nicht gefunden` | The cadastral layer has no parcel with this EGRID. | empty |
| `Grundstück konnte nicht abgefragt werden (…)` | The parcel lookup failed; the bracket holds the answer of the service (e.g. `HTTP Error 502: Bad Gateway`). | empty; `--resume` asks again |
| `<layer>: Abfrage fehlgeschlagen (…)` | One layer could not be queried, with the answer of the service. | elements of that layer, their categories and the total empty; `--resume` asks again |
| `<layer>: unvollständig (Limit)` | More objects than the safety limit of 5,000. | filled, too low |
| `<layer>: n Objekt(e) ohne Geometrie` | The service delivered objects without geometry and they could not be fetched one by one. | filled, too low; `--resume` asks again |
| `Nicht verarbeitet (Lauf abgebrochen)` | The run stopped before this parcel. | empty; `--resume` continues |

Rules:

- **Empty vs. 0.** A cell is empty when it was not queried (no valid EGRID,
  parcel not found, layer failed), and `0` when it was queried and nothing lies
  on the parcel.
- **No double counting.** Each element, each category and the total are computed
  on the dissolved (unioned) pieces. A category can be smaller than the sum of
  its elements, and the total smaller than the sum of the categories.
- **No silent lower bounds.** When a layer could not be queried, its elements,
  every category they belong to, the total and the share stay empty;
  `out_check_naturnah` names the layer. A layer that answered but was truncated
  or had an object without geometry keeps its number and is flagged.
- **Duplicates.** The same EGRID in several rows gives the same values in each
  of them. Count such a parcel once when summing (`out_egrid_count`).
- Categories 3, 5 and 8–12 of the BAFU list have no column because no element
  of this sample falls into them. Rows 8 and 9 (Kultur-Codes 921–924, trees)
  were dropped: the BLW layer holds no object with these codes.

## Output — sheet «Details»

One row per source object clipped to a parcel, once per distinct EGRID (not per
input row). Every BLW object is listed, also
those whose Kultur-Code is not in the BAFU list (`out_element` empty).

| Attribute | Unit | Description |
|---|---|---|
| `in_egrid` | | Parcel EGRID; key to «Parzellen» |
| `out_layer` | | geo.admin.ch layer ID the object comes from |
| `out_element` | | Element key (column name without `out_` and `_m2`); empty when the Kultur-Code is not in the list |
| `out_feature_id` | | Object ID in the layer |
| `out_kultur_code` | | BLW: `lnf_code`; otherwise empty |
| `out_bezeichnung` | | BLW: `nutzung_de`; inventories: `name` |
| `out_objnummer` | | Inventories: object number; BLW: empty |
| `out_bff_qualitaet_1` | | BLW: quality level I (`"1"` / `"0"`); otherwise empty |
| `out_bezugsjahr` | | BLW: reference date (YYYYMMDD); otherwise empty |
| `out_area_m2` | m² | Area of the object inside the parcel |

The sum of `out_area_m2` per element can exceed the element column in «Parzellen»,
because overlapping objects are dissolved there. Pieces smaller than 0.001 m²
are dropped.

## Output — sheet «Quellen»

Mapping of each `out_<element>_m2` column to the row(s) of the BAFU list, its
category, data source and layer, followed by the rows not covered (with the
reason), reading notes and the figures of the run (date, input file, number of
rows, rows without or with an invalid EGRID, distinct EGRIDs, found, incomplete).

## Output — sheet «Datenmodell»

This document in table form: `Blatt / Layer`, `Attribut`, `Typ`, `Beschreibung`,
`Verwendet als`.

## Output — GeoJSON

One FeatureCollection in EPSG:4326 with two kinds of features, told apart by the
`layer` property:

| `layer` | Geometry | Properties |
|---|---|---|
| `parcel` | Parcel polygon, one per input row with a found parcel | All columns of «Parzellen» |
| `naturnah` | Clipped object | All columns of «Details»; the source layer ID is in `out_layer` |

## Checkpoint — `naturnah_<ts>.jsonl`

One JSON object per finished EGRID, written as soon as the parcel is done;
`--resume` reads it.

| Key | Content |
|---|---|
| `egrid` | The EGRID |
| `complete` | `false` when the parcel lookup or a layer failed, or an object had no geometry. Only these are queried again. |
| `out` | The `out_` columns of «Parzellen» |
| `details` | The rows of «Details» |
| `geometry` | Parcel geometry (GeoJSON) |
| `pieces` | Clipped geometry of each `details` row (GeoJSON) |
