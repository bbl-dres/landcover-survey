# Data Model — Inputs & Outputs

What goes in, what comes out. For *how* each land cover type is classified, see
**[CLASSIFICATION.md](CLASSIFICATION.md)**; for *how* the processing works, see
**[ARCHITECTURE.md](ARCHITECTURE.md)**.

All geometry is in **EPSG:2056** (CH1903+ / LV95). Outputs are alphanumeric only —
no geometry column is exported (it is used internally for clipping and area
calculation, then dropped).

---

## Modes of operation

### Mode 1 — User-provided parcel list
You provide a CSV/Excel file with at minimum `ID` and `EGRID`. Extra columns are
preserved and carried through to all outputs, prefixed `input_`. EGRIDs not found
in the AV data still appear in the Parcels output with an error in `Check_EGRID`.

### Mode 2 — Full survey processing
All parcels from the official survey GeoPackage (`resf` table) are processed; no
user input file is needed. (Python CLI only.)

---

## Input — User parcel list (Mode 1)

| Attribute | Format | Required | Description |
|-----------|--------|----------|-------------|
| `ID` | `varchar` | Yes | User-defined feature identifier |
| `EGRID` | `varchar(14)` | Yes | Federal parcel identifier — foreign key to the AV data (e.g. `CH427760110057`) |
| *(other columns)* | *(varies)* | No | Passed through to all outputs, prefixed `input_` (e.g. `Address` → `input_Address`) |

## Input — Official survey GeoPackage (AV)

**Source:** `av_2056.gpkg` — EPSG:2056. Download: https://www.geodienste.ch/services/av
(The web app fetches the equivalent data live from swisstopo + the geodienste.ch WFS instead.)

### Table `resf` — Parcels (Liegenschaften and SDR)

Contains both *Liegenschaften* (real property) and *selbständige und dauernde
Rechte* (SDR / independent permanent rights, e.g. Baurecht). Both carry an EGRID
and are processed uniformly.

| Attribute | Format | Description |
|-----------|--------|-------------|
| `fid` | `integer` | Internal GeoPackage feature ID |
| `EGRIS_EGRID` | `varchar(14)` | Federal parcel identifier |
| `Nummer` | `varchar` | Official parcel number |
| `NBIdent` | `varchar` | Surveying office identifier |
| `BFSNr` | `integer` | Federal municipality number |
| `Flaechenmass` | `integer` | Legal area in m² (may be missing; may differ from the calculated area — see note below) |
| `GWR_EGID` | `integer` | Federal building register ID (optional) |
| `geom` | `MULTIPOLYGON` | Parcel polygon geometry (used internally, not exported) |

### Table `lcsf` — Land cover surfaces (Bodenabdeckung)

| Attribute | Format | Description |
|-----------|--------|-------------|
| `fid` | `integer` | Internal GeoPackage feature ID |
| `Art` | `varchar` | Land cover type (BBArt domain — see [CLASSIFICATION.md](CLASSIFICATION.md)) |
| `BFSNr` | `integer` | Federal municipality number |
| `GWR_EGID` | `integer` | Federal building register ID (optional) |
| `geom` | `MULTIPOLYGON` | Land cover polygon geometry (used internally, not exported) |

> **Official vs. calculated area.** `Flaechenmass` is the *legal* area and may
> differ from the computed polygon area due to projection reductions or rounding
> (VAV Art. 16). Small discrepancies (sub-m² for small parcels, a few m² for large
> ones) are normal. The calculated `parcel_area_m2` is for QA comparison and as a
> fallback when `Flaechenmass` is missing.
>
> **Duplicate EGRIDs.** A single EGRID can map to multiple `fid` entries (ongoing
> mutations, overlapping SDR/Baurecht). All matching geometries are dissolved into
> one polygon per EGRID; this is flagged in `Check_EGRID`.

---

## Output — Parcels (`{input}_parcels_{timestamp}.csv`)

One row per parcel. Exported by default (Python: disable with `--no-parcels`).
Aggregation columns are included by default (Python: `--no-aggregate` to omit).

| Attribute | Format | Description |
|-----------|--------|-------------|
| `ID` | `varchar` | User-defined identifier (Mode 1) or generated from AV (Mode 2) |
| `EGRID` | `varchar(14)` | Federal parcel identifier |
| `Nummer` | `varchar` | Official parcel number from AV |
| `BFSNr` | `integer` | Federal municipality number |
| `Check_EGRID` | `varchar` | EGRID status: found / *n* entries merged / not in AV |
| `Flaeche` | `integer` | Legal area from AV (may be missing) |
| `parcel_area_m2` | `float` | Calculated 2D planar area of the cleaned parcel polygon |
| `GGF_m2` | `float` | Building footprint area (SIA 416 GGF) |
| `BUF_m2` | `float` | Developed surrounding area (SIA 416 BUF) |
| `UUF_m2` | `float` | Undeveloped surrounding area (SIA 416 UUF) |
| `DIN277_BF_m2` | `float` | Built-up area — buildings (DIN 277 BF) |
| `DIN277_UF_m2` | `float` | Non-built-up area — everything else (DIN 277 UF) |
| `Sealed_m2` | `float` | Sealed area (GGF + all *befestigt*) |
| `GreenSpace_m2` | `float` | Total green space (soil-covered + wooded) |
| `VBS_Produktiv_m2` | `float` | Biologically productive area (VBS) |
| `VBS_Unproduktiv_m2` | `float` | Biologically unproductive area (VBS) |
| `VBS_Kat_A_m2` … `VBS_Kat_D_m2` | `float` | Area per VBS Kategorie (A. Siedlung, B. Landwirtschaft, C. bestockt, D. unproduktiv) |
| `VBS_Typ1_m2`, `VBS_Typ2_m2` | `float` | Area per VBS Typ — biologically productive only |
| `lc_source` | `varchar` | Land cover source for the parcel — always `AV` (the authoritative cadastral surface). Web app only. The optional Bauzonen and BAFU habitat overlays are **separate** detail layers, not the parcel's land-cover source |
| `{Art}_m2` | `float` | One column per land cover type present (e.g. `Gebaeude_m2`, `Strasse_Weg_m2`). AV parcels only |
| `bauzonen`, `bauzonen_m2` | `varchar` | Building zones intersecting the parcel + areas, semicolon-joined (Python `--bauzonen`; web app: opt-in checkbox) |
| `bauzonen_{zone}_m2` | `float` | **Web app (opt-in):** one column per building-zone type with its area in the parcel (e.g. `bauzonen_Wohnzonen_m2`, `bauzonen_Zentrumszonen_m2`); 0 where the zone is absent. Pivot-friendly since a parcel can span several zones |
| `habitat`, `habitat_m2` | `varchar` | Habitat types intersecting the parcel + areas (Python `--habitat`) |
| `input_*` | *(varies)* | User-provided columns, prefixed `input_` (Mode 1) |

> The sum of `GGF_m2 + BUF_m2 + UUF_m2` should approximate `parcel_area_m2` (small
> differences are expected from topology gaps in the source data).

---

## Output — Land Cover (`{input}_landcover_{timestamp}.csv`)

One row per clipped land cover piece per parcel. Exported by default (Python:
disable with `--no-landcover`).

| Attribute | Format | Description |
|-----------|--------|-------------|
| `ID` | `varchar` | Parcel identifier (same as Parcels output) |
| `EGRID` | `varchar(14)` | Parcel identifier (links to Parcels output) |
| `fid` | `integer` | Land cover feature ID from AV |
| `Art` | `varchar` | Land cover type ([CLASSIFICATION.md](CLASSIFICATION.md)) |
| `BFSNr` | `integer` | Federal municipality number |
| `GWR_EGID` | `integer` | Federal building register ID (may be empty) |
| `Check_GreenSpace` | `varchar` | `Green space (soil-covered)` / `Green space (wooded)` / `Not green space` |
| `VBS Kategorie` | `varchar` | `A. Settlement area` / `B. Agricultural area` / `C. Wooded area` / `D. Unproductive area` |
| `VBS Biologisch produktiv` | `varchar` | `1 Biologically productive` / `2 Biologically unproductive` |
| `VBS Typ` | `varchar` | `Type 1 - …` / `Type 2 - …`; **blank** for biologically unproductive types |
| `area_m2` | `float` | Calculated 2D planar area of the clipped land cover polygon |
| `lc_source` | `varchar` | Always `AV` (Amtliche Vermessung) in this layer. Web app only. The optional Bauzonen / BAFU habitat overlays are **separate** detail layers (own Excel sheet + GeoJSON `layer`) carrying `lc_source` = `Bauzonen` / `BAFU` |
| `prob` | `varchar` | BAFU model probability (`prob_de`) for `BAFU` rows; empty for `AV` rows. Web app only |
| `bauzonen`, `bauzonen_m2` | `varchar` | Building zones intersecting this green-space feature + areas (Python `--bauzonen`, green spaces only) |
| `habitat`, `habitat_m2` | `varchar` | Habitat types intersecting this green-space feature + areas (Python `--habitat`, green spaces only) |

> **Column values are stable English codes**, translated for display in the web
> app and written verbatim to CSV/Excel. Column **headers** for the VBS classification
> follow the source document (German): `VBS Kategorie`, `VBS Biologisch produktiv`,
> `VBS Typ`. See [CLASSIFICATION.md](CLASSIFICATION.md) for the rules behind the values.

---

## Enumerations (coded values)

Columns whose values come from a fixed set. **Code** = the value written verbatim
to the output; **EN** / **DE** = the labels the web app shows for it.

### `Check_EGRID` (Parcels)

| Code | EN | DE | Description |
|------|----|----|-------------|
| `found` | Found | Gefunden | Single matching parcel found. The Python CLI writes the message `EGRID found in AV`. |
| `merged` | Found (merged) | Gefunden (zusammengeführt) | Multiple `fid` entries dissolved into one. Python: `EGRID found in AV (N entries merged)`. |
| `not_found` | Not found | Nicht gefunden | EGRID not found in the AV data. Python: `EGRID missing or not in AV`. |
| `invalid` | Invalid EGRID | EGRID ungültig | Malformed EGRID (does not start with `CH`). Web app only. |
| `error:<msg>` | Error: \<msg\> | Fehler: \<msg\> | Unexpected processing error, message appended. Web app only. |

### `check_wfs` (Parcels — web app only)

| Code | EN | DE | Description |
|------|----|----|-------------|
| `ok` | OK | OK | Land cover retrieved successfully |
| `truncated` | Truncated | Abgeschnitten | WFS hit the feature cap (1000); the result may be incomplete |
| `wfs_error` | WFS error | WFS-Fehler | WFS request failed after retries; no land cover for this parcel |

### `check_geom` (Parcels — web app only)

| Code | EN | DE | Description |
|------|----|----|-------------|
| `ok` | OK | OK | All land cover features clipped successfully |
| `N_skipped` | N skipped | N übersprungen | N features could not be clipped (invalid geometry) and were dropped |

### `check_bauzonen` / `check_habitat` (Parcels — web app only)

Present when the matching overlay was analysed (both on by default in the web app).

| Code | EN | DE | Description |
|------|----|----|-------------|
| `ok` | OK | OK | Overlay features retrieved and clipped |
| `truncated` | Truncated | Abgeschnitten | Identify hit the per-bbox feature cap (200); the result may be incomplete |
| `error` | Error | Fehler | Identify request failed; no overlay data for this parcel |

### `lc_source` (Parcels & Land Cover — web app only)

| Code | EN | DE | Description |
|------|----|----|-------------|
| `AV` | AV | AV | Amtliche Vermessung land cover (authoritative cadastral surface) |
| `BAFU` | BAFU | BAFU | BAFU Lebensraumkarte (modeled habitat) — the web app's optional **habitat overlay layer** (not an AV fallback). Only green space + VBS derived; SIA 416 / DIN 277 / sealed blank. See [CLASSIFICATION.md](CLASSIFICATION.md) §BAFU Lebensraumkarte |
| `Bauzonen` | Bauzonen | Bauzonen | Harmonised building zones (`ch.are.bauzonen`) — the web app's optional **building-zone overlay layer**; `art` holds the zone name |

### `Check_GreenSpace` (Land Cover)

| Code | EN | DE | Description |
|------|----|----|-------------|
| `Green space (soil-covered)` | Soil-covered | Humusiert | Humusiert green space: Acker/Wiese/Weide, Reben, Gartenanlage, Hoch-/Flachmoor, übrige humusierte, Wytweide |
| `Green space (wooded)` | Wooded | Bestockt | Bestockt green space: geschlossener Wald, übrige bestockte |
| `Not green space` | Not vegetated | Nicht begrünt | All other types (incl. übrige Intensivkultur, befestigt, Gewässer, vegetationslos, Gebäude) |

### `VBS Kategorie` (Land Cover)

| Code | EN | DE | Description |
|------|----|----|-------------|
| `A. Settlement area` | A. Settlement area | A. Siedlungsfläche | Buildings, all *befestigt* surfaces, and Abbau/Deponie |
| `B. Agricultural area` | B. Agricultural area | B. Landwirtschaftsfläche | *Humusiert* agricultural surfaces incl. Wytweide |
| `C. Wooded area` | C. Wooded area | C. Bestockte Fläche | Forest: geschlossener Wald, übrige bestockte |
| `D. Unproductive area` | D. Unproductive area | D. Unproduktive Fläche | Water, bog, reed, rock, glacier, scree, other unvegetated |

### `VBS Biologisch produktiv` (Land Cover)

| Code | EN | DE | Description |
|------|----|----|-------------|
| `1 Biologically productive` | 1 Biologically productive | 1 Biologisch produktiv | Kategorie B + C + D, **minus** Fels, Gletscher/Firn, Geröll/Sand |
| `2 Biologically unproductive` | 2 Biologically unproductive | 2 Biologisch unproduktiv | Kategorie A, **plus** Fels, Gletscher/Firn, Geröll/Sand |

### `VBS Typ` (Land Cover)

| Code | EN | DE | Description |
|------|----|----|-------------|
| `Type 1 - Green spaces near buildings` | Type 1 — Green spaces near buildings | Typ 1 — Grünflächen in Gebäudeumgebung | Gartenanlage only |
| `Type 2 - Other green spaces` | Type 2 — Other green spaces | Typ 2 — Übrige Grünflächen | All other biologically productive types |
| *(blank)* | — | — | Biologically unproductive types have no Typ |

### `Art` (lcsf input / Land Cover output)

One of the 26 BBArt values (AV enum order 0–25). See the master table in
**[CLASSIFICATION.md](CLASSIFICATION.md)** for each value's code, EN, DE, and all
classification mappings.
