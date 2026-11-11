# Data model — test-naturnah

The tool takes a list of Grundstücke and reports, for each one, how much of its
area lies in the near-natural (*naturnah*) elements of the BAFU list «M5 Übersicht
Datenquellen naturnahe Flächen». This page describes what goes in, which data it
is compared with, and what comes out. How to run the tool is in the
[README](../README.md).

```
list of Grundstücke (EGRID)
        │  look up the boundary of each Grundstück
        ▼
cut the six data sources to that boundary and measure the areas
        │
        ▼
Excel      «Grundstücke»  one row per row of the list, areas in m²
           «Datenmodell»  explains every column
GeoJSON    the Grundstücke and the areas found on them, for a map
```

| Term | Meaning |
|---|---|
| **Grundstück** | A plot of land in the official cadastral survey. |
| **EGRID** | Its nationwide identifier, e.g. `CH409635764678`. |
| **Element** | One line of the BAFU list, e.g. «Streueflächen». Each element the tool can measure is one column. |
| **Kultur-Code** | The number the agricultural data uses for a type of use, e.g. 611 = extensively used meadow. |
| **Bundesinventar** | A federal inventory of protected habitats of national importance (dry meadows, bogs, fens, alluvial zones). |

All areas are in m², rounded to two decimals, and measured on the part of an
object that lies inside the Grundstück.

---

## 1. Input

A list with one row per Grundstück: an SAP list export («Dynamische
Listenausgabe»), a CSV or an Excel file.

- **Only the EGRID column is required** (headed `EGRID` or `E-GRID`).
- **Every other column is kept** and appears in the result with the prefix `in_`.
  The name is the header in lower case without special characters:
  `Bez. Grundstück` → `in_bez_grundstueck`, `Haus-Nr.` → `in_haus_nr`.
- An EGRID is looked up only when it is complete (`CH` + 12 characters). Rows
  without one, or with a placeholder such as `0000000000`, stay in the result with
  empty values and a note in `out_error`.

Everything the tool adds carries the prefix `out_`.

---

## 2. Data sources

Six datasets, read live from the federal geodata service geo.admin.ch. Names,
owners and dates are the ones the service reported on 10 Nov 2026.

| Dataset | Owner | Data as of | Layer (map) | Download |
|---|---|---|---|---|
| [Official survey, CadastralWebMap](https://www.cadastre.ch/de/darstellungsdienst-cadastralwebmap-wms) | Cantons | 9 Nov 2026 | [`ch.kantone.cadastralwebmap-farbe`](https://map.geo.admin.ch/#/map?lang=de&layers=ch.kantone.cadastralwebmap-farbe) | [geodienste.ch](https://www.geodienste.ch/services/av) |
| [Landwirtschaftliche Nutzungsflächen](https://www.blw.admin.ch/blw/de/home/politik/datenmanagement/geografisches-informationssystem-gis/landwirtschaftliche-kulturflaechen.html) | BLW, cantons | 31 Dec 2025 | [`ch.blw.landwirtschaftliche-nutzungsflaechen`](https://map.geo.admin.ch/#/map?lang=de&layers=ch.blw.landwirtschaftliche-nutzungsflaechen) | [geodienste.ch](https://www.geodienste.ch/services/lwb_nutzungsflaechen) |
| [Bundesinventar Trockenwiesen und -weiden (TWW)](https://www.bafu.admin.ch/tww) | BAFU | 1 Dec 2025 | [`ch.bafu.bundesinventare-trockenwiesen_trockenweiden`](https://map.geo.admin.ch/#/map?lang=de&layers=ch.bafu.bundesinventare-trockenwiesen_trockenweiden) | [data.geo.admin.ch](https://data.geo.admin.ch/browser/index.html#/collections/ch.bafu.bundesinventare-trockenwiesen_trockenweiden/items/bundesinventare-trockenwiesen_trockenweiden) |
| [Bundesinventar Hoch- und Übergangsmoore](https://www.bafu.admin.ch/moore) | BAFU | 1 Dec 2025 | [`ch.bafu.bundesinventare-hochmoore`](https://map.geo.admin.ch/#/map?lang=de&layers=ch.bafu.bundesinventare-hochmoore) | [data.geo.admin.ch](https://data.geo.admin.ch/browser/index.html#/collections/ch.bafu.bundesinventare-hochmoore/items/bundesinventare-hochmoore) |
| [Bundesinventar Flachmoore](https://www.bafu.admin.ch/moore) | BAFU | 1 Dec 2025 | [`ch.bafu.bundesinventare-flachmoore`](https://map.geo.admin.ch/#/map?lang=de&layers=ch.bafu.bundesinventare-flachmoore) | [data.geo.admin.ch](https://data.geo.admin.ch/browser/index.html#/collections/ch.bafu.bundesinventare-flachmoore/items/bundesinventare-flachmoore) |
| [Bundesinventar Auengebiete](https://opendata.swiss/de/perma/9d598c5d-11d8-4187-b452-7cea7b993c44@bundesamt-fur-umwelt-bafu) | BAFU | 1 Nov 2017 | [`ch.bafu.bundesinventare-auen`](https://map.geo.admin.ch/#/map?lang=de&layers=ch.bafu.bundesinventare-auen) | [data.geo.admin.ch](https://data.geo.admin.ch/browser/index.html#/collections/ch.bafu.bundesinventare-auen/items/bundesinventare-auen) |

The official survey supplies the boundary and the number of each Grundstück; the
other five are what is measured on it.

Good to know:

- **The Auen inventory on the service is from 2017**, the other three inventories
  from the 2025 revision.
- **The agricultural data covers land that receives direct payments.** Each area
  carries its own reference date. Whether every canton delivers to this dataset
  was not checked: a Grundstück in a canton without data shows 0.
- A registered area says where an inventory or a subsidised use is recorded, not
  how the land is actually managed.

---

## 3. What is measured

One column per element of the BAFU list that one of the datasets can answer.

| Column | Element | BAFU list: row · category | Taken from |
|---|---|---|---|
| `out_tww_m2` | Trockenwiesen und -weiden | 2 · 1 | TWW inventory |
| `out_magerwiesen_611_m2` | Magerwiesen/-weiden (not TWW) | 3 · 1 | Agricultural areas, Kultur-Code 611 |
| `out_wenig_intensiv_612_m2` | Wenig intensiv genutzte Wiesen | 4 · 1 | Kultur-Code 612 |
| `out_streue_851_m2` | Streueflächen | 5 · 1 | Kultur-Code 851 |
| `out_hecken_852_m2` | Hecken, Feld- und Ufergehölz | 6 · 2 | Kultur-Code 852 |
| `out_brachen_556_557_m2` | Bunt- und Rotationsbrachen | 10 · 4 | Kultur-Codes 556, 557 |
| `out_ruderal_stein_mauer_905_m2` | Ruderalflächen, Steinhaufen, Trockensteinmauern | 11–13 · 4 | Kultur-Code 905 (the three elements share it) |
| `out_hochmoor_m2` | Hochmoore | 17 · 6 | Hochmoor inventory |
| `out_flachmoor_m2` | Flachmoore | 18 · 6 | Flachmoor inventory |
| `out_auen_m2` | Auen | 20 · 7 | Auen inventory |

**Not measured.** The remaining rows of the BAFU list have no column:

| Row | Element | Why |
|---|---|---|
| 8, 9 | Hochstammobstgärten; Einzelbäume, Baumgruppen | Kultur-Codes 921–924 do not occur in the agricultural dataset (trees are presumably recorded as a count, not as an area) |
| 15 | Gewässerufer (bewachsen) | the Bestockungskarte cannot be queried through the service |
| 21 | Spezielle Waldstandorte | Waldreservate: not included yet |
| 6, 9 | second source «Lebensraumkarte – Gehölze» | not included yet |
| 14, 19 | Kies-/Mergelplätze; nährstoffreiche Feuchtwiesen | only the REN layers, given as additional information |
| 7, 16, 22–25 | Waldränder; Tümpel und Teiche; Felsen; Sonderstandorte; Dach- und Fassadenbegrünung; versickerungsfähige Wege | no data source, or only a tentative one, in the list |

---

## 4. Result: Excel workbook

### Sheet «Grundstücke»

One row per row of the input list, in the same order — also for rows whose
Grundstück could not be found. The columns, from left to right:

**1. The input columns** (`in_…`), unchanged.

**2. Status**

| Column | Content |
|---|---|
| `out_error` | Everything that is wrong with the row, or empty. **The column to filter on** — see [Errors](#errors). |
| `out_check_egrid` | Result of the lookup: `EGRID found`, `EGRID not found`, `EGRID missing`, `Invalid EGRID`, `Not processed`, `Error: …` |
| `out_egrid_count` | How many rows of the list carry this EGRID. Above 1, the same Grundstück is listed several times. |
| `out_nummer` | Number of the Grundstück in the official survey |
| `out_parcel_area_m2` | Area of the Grundstück, computed from its boundary (not the official Flächenmass; it can differ by up to about 0.3 %) |
| `out_check_naturnah` | `ok`, or which dataset could not be read completely |

**3. One area column per element** — the ten columns of [section 3](#3-what-is-measured).

**4. Sums**

| Column | Content |
|---|---|
| `out_kat1_m2` | Category 1, Naturnahe Wiesen & Weiden: TWW, 611, 612, 851 together |
| `out_kat2_m2` | Category 2, Hecken, Feldgehölze, Waldränder: 852 |
| `out_kat4_m2` | Category 4, Brachen, Ruderalflächen, Stein-/Kiesflächen, Trockenmauern: 556/557, 905 |
| `out_kat6_m2` | Category 6, Feuchtgebiete: Hochmoor and Flachmoor together |
| `out_kat7_m2` | Category 7, Auen |
| `out_naturnah_total_m2` | All elements together: the near-natural area on the Grundstück |
| `out_naturnah_anteil_pct` | That area as a share of the Grundstück, in % |
| `out_blw_total_m2` | For context: all agricultural area on the Grundstück, whatever its Kultur-Code |

Categories 3, 5 and 8–12 of the BAFU list have no column, because none of the
measured elements belongs to them.

### How to read the numbers

- **Empty is not 0.** An empty cell means the value is not known: the Grundstück
  was not found, or a dataset could not be read. `0` means it was read and nothing
  lies on the Grundstück. When a dataset fails, its elements, their category, the
  total and the share all stay empty.
- **Every square metre counts once.** Where objects overlap — a Flachmoor that is
  also a Streuefläche — a category or the total is smaller than the sum of its
  columns.
- **A Grundstück listed twice has its values twice.** Count it once when summing a
  column (`out_egrid_count`). A Baurecht and the Grundstück it lies on can overlap
  as well.
- Values of a few cm² up to about a square metre are slivers of objects on the
  neighbouring Grundstück.

### Errors

`out_error` collects every problem of a row, separated by `; `.

| Entry | Meaning | Values in the row |
|---|---|---|
| `EGRID fehlt` | No EGRID in the list | empty |
| `EGRID ungültig` | Not `CH` + 12 characters, e.g. a placeholder | empty |
| `EGRID nicht gefunden` | The official survey has no Grundstück with this EGRID | empty |
| `EGRID mehrfach in der Liste (n×)` | The same EGRID stands in *n* rows | filled, the same in each |
| `Grundstück konnte nicht abgefragt werden (…)` | The lookup failed; the bracket holds the service's answer | empty |
| `<dataset>: Abfrage fehlgeschlagen (…)` | One dataset could not be read | its elements, their category and the total empty |
| `<dataset>: unvollständig (Limit)` · `n Objekt(e) ohne Geometrie` | The dataset was read only in part | filled, but too low |
| `Nicht verarbeitet (Lauf abgebrochen)` | The run stopped before this row | empty |

Rows with a failed or interrupted query can be completed by running the tool
again with `--resume`.

### Sheet «Datenmodell»

The description of every column of «Grundstücke» and of the GeoJSON, in German.
It is generated together with the workbook, so it always matches it.

| Column | Content |
|---|---|
| `Blatt / Layer` | `Grundstücke`, or the GeoJSON layer |
| `Attribut` | The column name |
| `Format` | Text, whole number, or number with unit |
| `Beschreibung` | What the value means |
| `Quelle` | Where the value comes from, always written as **origin – detail** |
| `Link` | The dataset on map.geo.admin.ch, clickable; empty when the origin is not a single dataset |

The origin in `Quelle` is the input list, a dataset by its name, or «Berechnet»:

| Example | Reads as |
|---|---|
| `Eingabeliste` | taken from the input list |
| `Landwirtschaftliche Nutzungsflächen (BLW) – Kultur-Code 611` | the agricultural areas with that Kultur-Code |
| `Bundesinventar Flachmoore (BAFU) – alle Flächen` | every area of that inventory |
| `Amtliche Vermessung (Kantone) – Attribut «number»` | that attribute of the official survey |
| `Berechnet – aus out_hochmoor_m2, out_flachmoor_m2` | computed from the columns named |

---

## 5. Result: GeoJSON

A map file (coordinates in WGS84) for QGIS or a similar program. Each feature
has a property `layer`:

- **`grundstueck`** — the boundary of a Grundstück with all columns of the sheet
  «Grundstücke». One feature per row of the list whose Grundstück was found.
- **`naturnah`** — one area found on a Grundstück, cut to its boundary. These are
  not in the workbook. They include *every* agricultural area, also those whose
  Kultur-Code is not in the BAFU list; that is where a missing code shows up.

Properties of a `naturnah` feature:

| Property | Content |
|---|---|
| `in_egrid` | EGRID of the Grundstück it lies on |
| `out_layer` | The dataset it comes from (layer ID) |
| `out_element` | The element it counts towards, e.g. `streue_851`; empty when its Kultur-Code is not in the BAFU list |
| `out_bezeichnung` | Name of the use (agricultural areas) or of the inventory object |
| `out_kultur_code` | Kultur-Code — agricultural areas only |
| `out_bff_qualitaet_1` | Biodiversitätsförderfläche quality level I: `1` yes, `0` no — agricultural areas only |
| `out_bezugsjahr` | Reference date of the entry, as YYYYMMDD — agricultural areas only |
| `out_objnummer` | Object number in the inventory — inventories only |
| `out_feature_id` | Technical ID of the object in its dataset |
| `out_area_m2` | Its area inside the Grundstück |

Adding up `out_area_m2` can give more than the column in «Grundstücke», because
overlapping areas are counted once there.

---

## 6. Technical reference

For those who maintain the tool or want to reproduce a number.

**Requests** (`src/api.py`, `src/cli.py`), all under
`https://api3.geo.admin.ch/rest/services/all/MapServer/`:

| Request | Used for |
|---|---|
| `find` | The Grundstück by EGRID, exact match on `egris_egrid`; each distinct EGRID once |
| `identify` | All objects of a dataset in the bounding box of the Grundstück. At most 200 per request, so the box is split until every request is complete. |
| `<layer>/<id>` | The geometry of an object that `identify` returned without one (the service omits very large geometries) |

The dataset names, owners and dates in section 2 come from the service's
[layer metadata](https://docs.geo.admin.ch/explore-data/get-layer-metadata.html).

**Geometry.** Everything stays in WGS84 (EPSG:4326). Areas are spherical, computed
as the main web app does. Objects smaller than 0.001 m² are dropped.

**Source attributes.** What the datasets deliver, and what becomes of it:

| Dataset | Attribute | Exported as |
|---|---|---|
| Official survey | `number` | `out_nummer` |
| Agricultural areas | `lnf_code` (Kultur-Code; selects the element) | `out_kultur_code` |
| | `nutzung_de` | `out_bezeichnung` |
| | `bff_qualitaet_1`, `bezugsjahr` | same name with `out_` |
| | `hauptkategorie_*`, `flaeche_m2`, `bewirtschaftungsgrad`, `nutzungsidentifikator`, `t_id` | not exported |
| | `bur_nr` (identifies the farm business) | deliberately not exported |
| All four inventories | `name` | `out_bezeichnung` |
| | `objnummer` | `out_objnummer` |
| | `shape_area` (area of the whole object), `refobjblat` (object sheet, PDF) | not exported |
| TWW only | `teilobjnummer`, `bewertung`, `singularitaet` | not exported |
| Hochmoore only | `hochmoore_type_*`, `hm_ke`, `unit_*` (one polygon per mapping unit) | not exported |
| Auen only | `auen_type`, `auen_type_*` | not exported |

**Checkpoint** (`naturnah_<ts>.jsonl`). One line per finished EGRID, written at
once; `--resume` reads it and asks again only for the entries with
`complete = false`. Keys: `egrid`, `complete`, `out` (the `out_` columns),
`details` and `pieces` (properties and geometry of the `naturnah` features),
`geometry` (the boundary).

**Where the definitions live.** Elements, Kultur-Codes and categories:
`src/sources.py` (`ELEMENTS`, `KATEGORIEN`); the «Datenmodell» sheet:
`data_model()` in the same file. Adding a dataset or a code is one entry there.
