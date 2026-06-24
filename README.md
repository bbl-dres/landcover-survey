# Land Cover Survey

Aggregate land cover area (m²) per Swiss cadastral parcel from official survey data (Amtliche Vermessung).

<!-- The hero image is clickable and opens the live app -->
[![Land Cover Survey — click to open the live app](assets/Social1.jpg)](https://bbl-dres.github.io/landcover-survey/)

[![Demo on GitHub Pages](https://img.shields.io/badge/demo-GitHub%20Pages-2ea44f?logo=github&logoColor=white)](https://bbl-dres.github.io/landcover-survey/)
![License](https://img.shields.io/badge/license-MIT-lightgrey)
![Status](https://img.shields.io/badge/status-alpha-orange)

> [!TIP]
> **Try it now — open the live web app:** https://bbl-dres.github.io/landcover-survey/
>
> No installation needed; it runs entirely in your browser.

## What is this?

Aggregate land cover area (m²) per Swiss cadastral parcel from official Amtliche Vermessung (AV) data — supports single-parcel EGRID lookup and full municipal batch processing.

For each parcel, the tool clips every intersecting land cover polygon to the parcel boundary and computes the area of each piece — a per-parcel breakdown of how much area each land cover type covers, classified by SIA 416, DIN 277, green space, imperviousness, and VBS categories.

## Solutions

The same analysis is available three ways. Each has its own README with full details.

### Web App

> [!TIP]
> See related repo: https://github.com/bbl-dres/green-inventory

Zero-install browser app: pick a parcel on an interactive map — or upload a CSV for batch analysis — and explore per-parcel land cover, with export to CSV, Excel, GeoJSON, and a self-contained HTML report. Multilingual (DE/FR/IT/EN).

- **Preview:** https://bbl-dres.github.io/landcover-survey/
- **Source code:** [`web/`](web/)
<p align="center">
  <img src="assets/images/preview5.jpg" width="45%" style="vertical-align: top;"/>
  <img src="assets/images/preview6.jpg" width="45%" style="vertical-align: top;"/>
</p>

---

### Python CLI

Command-line tool for local, offline processing with exact planar (LV95) areas and full cantonal coverage from a local GeoPackage. Optional Bauzonen and habitat analyses.

- **Preview:** command-line tool — run locally (no hosted demo)
- **Source code:** [`python/`](python/)

---

### FME

The original FME Form workspace (`.fmw`) that the other two solutions reproduce.

- **Preview:** requires [FME Form](https://fme.safe.com/fme-form/) (commercial licence)
- **Source code:** [`fme/`](fme/)

---

## Data & Documentation

> **Data coverage note:** The Web App uses the geodienste.ch WFS, which requires cantonal approval in 6 cantons (JU, LU, NE, NW, OW, VD). Parcels in these cantons are found by EGRID but return 0 m² land cover. Coverage is also incomplete in TI, VS, and NE. The Python CLI has full coverage from a local GeoPackage. See the [User Guide](docs/MANUAL.md) for details.

- **Data sources** — land cover from the official Swiss cadastral survey (Amtliche Vermessung, data model [DM.01-AV-CH](https://www.cadastre-manual.admin.ch/)) via [geodienste.ch](https://www.geodienste.ch/services/av); parcel geometry by EGRID from the swisstopo cadastral webmap; and two overlay layers via the [geo.admin.ch Identify API](https://api3.geo.admin.ch) — harmonised building zones (`ch.are.bauzonen`, ARE) and the BAFU habitat map (`ch.bafu.lebensraumkarte-schweiz`). CRS: EPSG:2056 (CH1903+ / LV95).
- **[User Guide](docs/MANUAL.md)** — multilingual manual (DE/FR/IT/EN) with FAQ and data coverage.
- **[Land Cover Classification](docs/CLASSIFICATION.md)** — how each of the 26 BBArt types maps to SIA 416, DIN 277, green space, sealed, and VBS, with decision trees.
- **[Data Model](docs/DATAMODEL.md)** — inputs (CSV, AV `resf`/`lcsf`) and output column dictionaries.
- **[Architecture](docs/ARCHITECTURE.md)** — processing pipeline, implementation, and limitations.
- **[Docs index](docs/README.md)** — start here + glossary.

## Known limitations

- **Land-cover coverage** depends on cantonal WFS approval — see the data
  coverage note above. 6 cantons return 0 m² in the Web App; the Python CLI has
  full coverage from a local GeoPackage.
- **Overlay API caps (geo.admin.ch Identify).** The Bauzonen and BAFU habitat
  layers are fetched per parcel from the Identify API, which returns at most
  **200 features per request** and **omits the geometry of oversized features**
  (e.g. a city-scale `Asphalt- und Betonstrasse` habitat polygon comes back with
  `null` geometry). The **Web App works around this** — it attributes the
  uncovered parcel area to the dropped type so each layer still sums to the
  parcel area, and flags affected parcels via `check_habitat` / `check_bauzonen`
  (`estimated` / `partial` / `truncated`). The **Python CLI does not yet** apply
  these workarounds (see [`python/TODO.md`](python/TODO.md)), so web and Python
  results can differ for parcels with very large overlay features.
- **BAFU habitat latency.** The habitat layer is slow to identify (~0.3–1 s per
  parcel, occasional multi-second spikes) and is the main source of request
  timeouts on large batches. It is available as a bulk
  [STAC](https://data.geo.admin.ch/api/stac/v1/collections/ch.bafu.lebensraumkarte-schweiz)
  download, which the Python pipeline should prefer for large runs.
- **"Ohne Bauzone" geometry is best-effort.** The per-parcel zone-free remainder
  has an exact area, but its polygon may be omitted on complex parcels where the
  geometry difference fails (the area is always correct).

## Standards & References

- [SIA 416:2003](https://www.sia.ch/de/dienstleistungen/sia-norm/geodaten/) — building surfaces and volumes (GGF / BUF / UUF)
- [DIN 277:2021](https://www.beuth.de/de/norm/din-277/343199925) — floor areas and building volumes (BF / UF)
- [TVAV (SR 211.432.21)](https://www.fedlex.admin.ch/eli/cc/2023/530/de) — Technical Ordinance on the Official Cadastral Survey (Art. 14–19: land cover categories)
- [GeoIG (SR 510.62)](https://www.fedlex.admin.ch/eli/cc/2008/388/de) — Federal Act on Geoinformation
- [TypoCH (Delarze et al.)](https://www.infoflora.ch/en/habitats/typoch-(delarze-et-al.).html) — Swiss habitat typology behind the BAFU Lebensraumkarte (used for the synthetic land-cover fallback)

## License

[MIT](LICENSE) — see [LICENSE](LICENSE).
