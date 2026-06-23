# Documentation

Land Cover Survey — aggregate land cover area (m²) per Swiss cadastral parcel from
official Amtliche Vermessung (AV) data.

## Which doc do I want?

| I want to… | Read |
|------------|------|
| **Use the web app** (pick a parcel or upload a CSV, read results) | **[MANUAL.md](MANUAL.md)** — multilingual guide + FAQ |
| **Know what a land cover type maps to** (SIA 416, green space, sealed, VBS) | **[CLASSIFICATION.md](CLASSIFICATION.md)** — mappings + decision trees ★ |
| **Understand the input/output columns** | **[DATAMODEL.md](DATAMODEL.md)** — inputs, outputs, modes |
| **Understand how it works / extend it** | **[ARCHITECTURE.md](ARCHITECTURE.md)** — pipeline, implementation, limits |
| **Find other land cover / land use / habitat data sources** | **[DATA-SOURCES.md](DATA-SOURCES.md)** — screening reference (global → EU → DACH → CH) |

> ★ Most people are here for the **AV layer mappings** — start with
> [CLASSIFICATION.md](CLASSIFICATION.md).

## Standards & references

- [SIA 416:2003](https://www.sia.ch/de/dienstleistungen/sia-norm/geodaten/) — building surfaces and volumes (GGF / BUF / UUF)
- [DIN 277:2021](https://www.beuth.de/de/norm/din-277/343199925) — floor areas and building volumes (BF / UF)
- [TVAV (SR 211.432.21)](https://www.fedlex.admin.ch/eli/cc/2023/530/de) — Technical Ordinance on the Official Cadastral Survey (Art. 14–19: land cover categories)
- [GeoIG (SR 510.62)](https://www.fedlex.admin.ch/eli/cc/2008/388/de) — Federal Act on Geoinformation
- [DM.01-AV-CH](https://www.cadastre-manual.admin.ch/) — INTERLIS data model for the official cadastral survey (replaced by DMAV by 2027-12-31)
- [Survey data download](https://www.geodienste.ch/services/av) — AV GeoPackage

---

## Glossary

| Term | EN | DE | Description |
|------|----|----|-------------|
| AV | Official Cadastral Survey | Amtliche Vermessung | Official cadastral survey of Switzerland |
| BBArt | Land Cover Type | Bodenabdeckungsart | Land cover type domain (26 values) in DM.01-AV-CH |
| BFSNr | BFS Municipality Number | BFS-Nummer | Federal municipality number (Swiss Federal Statistical Office) |
| BUF | Developed Surrounding Area | Bearbeitete Umgebungsfläche | Sealed + soil-covered surfaces around buildings (SIA 416) |
| CRS | Coordinate Reference System | Koordinatenreferenzsystem | This project uses EPSG:2056 (LV95) |
| DMAV | AV Data Model (new) | Datenmodell der AV | New model replacing DM.01-AV-CH (deadline 2027-12-31) |
| DM.01-AV-CH | AV Data Model (current) | Datenmodell der AV | Current INTERLIS data model for the official cadastral survey |
| EGRID | Federal Parcel Identifier | E-GRID | 14-char string (e.g. `CH427760110057`) uniquely identifying a parcel |
| EGRIS | Land Register Information System | EGRIS | Swiss land register information system (source of EGRIDs) |
| Flaechenmass | Official Area | Flächenmass | Official legal area of a parcel (may differ from calculated area) |
| GeoPackage | GeoPackage | — | SQLite-based geospatial format (OGC standard, `.gpkg`) |
| GGF | Building Footprint Area | Gebäudegrundfläche | Building footprint area (SIA 416) |
| GWR_EGID | Federal Building ID | GWR-EGID | Federal building register ID (GWR) |
| INTERLIS | INTERLIS | — | Swiss standard for geodata description and transfer (SN 612030) |
| lcsf | Land Cover Surfaces | — | GeoPackage table for land cover surfaces (Bodenabdeckungsflächen) |
| LV95 | National Survey 1995 | Landesvermessung 1995 | Swiss national coordinate system (EPSG:2056, CH1903+) |
| Nummer | Parcel Number | Grundstücknummer | Official parcel number within a municipality |
| resf | Real Estate Surfaces | — | GeoPackage table for parcels (Liegenschaften and SDR) |
| SDR | Independent Permanent Rights | Selbständige und dauernde Rechte | E.g. building rights (Baurecht) — a type of parcel |
| SIA 416 | SIA 416 | — | Swiss area standard: GSF = GGF + UF, UF = BUF + UUF |
| UF | Surrounding Area | Umgebungsfläche | Surrounding area = BUF + UUF (SIA 416) |
| UUF | Undeveloped Surrounding Area | Unbearbeitete Umgebungsfläche | Water + wooded + unvegetated surfaces (SIA 416) |
| VAV | Cadastral Survey Ordinance | Verordnung über die amtliche Vermessung | Ordinance on the official cadastral survey (SR 211.432.2) |
| VBS | Federal Dept. of Defence | Eidg. Departement für Verteidigung | VBS / arImmo near-natural area classification |
