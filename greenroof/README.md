# Green Roof Prototype (experimental)

Estimate the **vegetated ("green") roof area** of a parcel's buildings from
aerial imagery — a remote-sensing complement to the geometry-based land cover
aggregation elsewhere in this repo.

> [!NOTE]
> **Experimental / research track**, like [`alphaearth/`](../alphaearth/). Not
> part of the web app or the Python CLI.

## Workflow

```
EGRID ─▶ parcel polygon (geo.admin.ch find, LV95)
      ─▶ AV Bodenbedeckung via geodienste.ch WFS, keep Art = "Gebaeude", clip to parcel
      ─▶ SWISSIMAGE 10 COG tiles via STAC (data.geo.admin.ch), read only the pixel
         window around the buildings (HTTP range requests — no download, no backend)
      ─▶ vegetation index per pixel  (NDVI when a NIR band exists, RGB fallback until then)
      ─▶ threshold within the building footprints → green-roof mask
      ─▶ area (pixel count × pixel area, LV95 planar), per-building stats,
         vectorised outline (marching squares) → GeoJSON export
```

Everything runs client-side in the browser, in LV95 (EPSG:2056) — same
zero-backend model as [`web/`](../web/).

## The NIR situation (verified 2026-07-03)

| Source | Bands | Status |
|---|---|---|
| [SWISSIMAGE 10](https://www.swisstopo.admin.ch/en/orthoimage-swissimage-10) releases ≤ 2025 | **3 (RGB)**, 8-bit, JPEG-in-COG | Free, on STAC (`ch.swisstopo.swissimage-dop10`) — header-checked: 2024 & 2025 tiles are 3-band |
| SWISSIMAGE 10 **2026 release** | RGB + **NIR** (announced) | **Not yet published** — no 2026 STAC items as of 2026-07-03; the 2026 flight season is ongoing and tiles typically appear months later |
| [SWISSIMAGE RS](https://www.swisstopo.admin.ch/en/orthoimage-swissimage-rs) | 4 (R,G,B,NIR) | Paid product (quote pending); delivered as files — testable here via drag & drop |

Consequences for the prototype:

- **Today** it computes an **RGB vegetation index** — GLI (default) or VARI — as
  a stand-in for NDVI. Noisier (no NIR, JPEG artifacts), but the *entire*
  pipeline (footprints → index → threshold → polygon → area) is real and tuned.
- It reads the **band count from the GeoTIFF itself** — the moment 4-band 2026
  tiles appear on STAC, the same page computes true NDVI with no code change.
- A **local GeoTIFF with NIR** (LV95) can be dropped onto the page and replaces
  the remote imagery — so an RS sample can be evaluated the day it arrives. The
  band switch covers `R,G,B,NIR`, `NIR,R,G,B`, and 3-band **CIR (NIR,R,G)** —
  the false-colour layout most cantonal infrared orthophotos ship as (no blue
  band, so GLI/VARI are disabled and NDVI is used).

Infrastructure verified: `data.geo.admin.ch` serves the COGs with
`Access-Control-Allow-Origin: *` and honours HTTP range requests, so
[geotiff.js](https://geotiffjs.github.io/) reads just the needed window
(typically a few MB) straight from the browser.

### Open NIR imagery available today (drag & drop)

True NDVI can be tested **now** with open cantonal infrared orthophotos —
they are LV95 GeoTIFFs, so they drop straight onto the page over real parcels:

| Dataset | Res. | Bands | Access |
|---|---|---|---|
| **Kanton Zürich** Orthofoto Frühjahr/Sommer RGB + Infrarot (OGD) | ~10 cm | CIR | [geolion.zh.ch](https://geolion.zh.ch/geodatensatz/3029) / [maps.zh.ch download](https://www.stadt-zuerich.ch/geodaten/download/542) — covers the demo parcel |
| **Genève SITG** Orthophotos proche infrarouge (IRC), vintages up to 2021 | 20 cm | CIR | [sitg.ge.ch](https://sitg.ge.ch/donnees/image-aerienne-ortho-irc-2018-07) tile extraction / WMS |

Foreign open RGBI sets (method testing only — different CRS, no Swiss parcels):
**NRW** 10 cm RGBI ([opengeodata.nrw](https://www.opengeodata.nrw.de/produkte/geobasis/lusat/akt/dop/dop_jp2_f10/),
JPEG2000 → convert: `gdal_translate -of COG in.jp2 out.tif`), **Berlin** 20 cm
RGBI + the [Gründächer ground-truth layer](https://daten.berlin.de/datensaetze/gr%C3%BCnd%C3%A4cher-geb%C3%A4udefl%C3%A4chen-umweltatlas-wfs),
**Austria BEV** [DOP RGBI](https://data.bev.gv.at/geonetwork/srv/api/records/f2e11a84-cdc7-4cfa-b048-da3675d58704) (open since 2024).

The full dataset screening — federal / cantonal / EU sources, ground-truth
datasets, verification log, and the recommended pilot path — is in
**[RESEARCH-NIR-IMAGERY.md](RESEARCH-NIR-IMAGERY.md)**.

## Run it

Plain static files, no build step — serve the repo root (same as the web app):

```bash
cd landcover-survey
python -m http.server 8080
# open http://localhost:8080/greenroof/
```

Try a parcel with large industrial roofs (Otelfingen ZH area, 2025 imagery):

```
http://localhost:8080/greenroof/?egrid=CH789283950753
```

Then:

1. **Threshold slider** — watch the overlay and the m² update live; the cursor
   readout shows the index value under the mouse to help pick a cut-off.
2. **View switch** — orthophoto / index heatmap / green-roof overlay.
3. **Imagery year** — compare releases (a parcel can span two 1-km tiles with
   different latest years; tiles missing the pinned year show as no-data).
4. **Download GeoJSON** — parcel + buildings (with `greenroof_m2`,
   `greenroof_pct`) + the vectorised green-roof MultiPolygon, in WGS84.

## Vegetation indexes

| Index | Formula | Needs | Default threshold |
|---|---|---|---|
| **NDVI** | (NIR − R) / (NIR + R) | NIR band | 0.20 |
| **GLI** | (2G − R − B) / (2G + R + B) | RGB | 0.10 |
| **VARI** | (G − R) / (G + R − B) | RGB | 0.10 |

Thresholds are judgment calls — extensive sedum roofs sit much lower than lawn.
Calibrate against parcels with known green roofs before trusting absolute
numbers; the defaults are conservative starting points.

## Files

| File | Purpose |
|---|---|
| `index.html` | UI shell (controls, canvas, stats table) + CDN pins |
| `greenroof.js` | The whole pipeline (fetch, COG window read, index, mask, stats, export) |
| `RESEARCH-NIR-IMAGERY.md` | Dataset screening: NIR imagery sources (CH federal/cantonal, EU), ground truth, verification log |

Dependencies (CDN, pinned like `web/`): Turf.js 7 (parcel/building clipping),
geotiff.js 2 (COG reader), d3-contour 4 (mask → polygon).

## Caveats

- **Overhanging trees count as green** — the index sees vegetation over the
  footprint, not on the roof. Cross-check suspicious hits on the orthophoto view.
- **Shadows and dry/brown vegetation** can fall below the threshold
  (false negatives); JPEG compression adds speckle (the 3×3 majority filter
  suppresses most of it).
- **RGB indexes are a stand-in.** Treat pre-2026 results as indicative; the
  method is designed for NDVI.
- Building footprints are the AV roof projection **clipped to the parcel** — a
  building straddling the boundary is only evaluated inside it.
- Areas are pixel counts × pixel area (10 cm ⇒ 0.01 m²/px) on LV95; the GeoJSON
  export converts to WGS84 with swisstopo's approximate formulas (~1 m), the
  analysis itself is not affected.
- Imagery vintage varies by region (3-year cycle); the year(s) actually used are
  shown under the results and stamped into the export.

## Possible next steps

- Validate thresholds against parcels with known green roofs (e.g. municipal
  green-roof registers), per index.
- Batch mode (CSV of EGRIDs) and integration into the web app as an optional
  per-parcel metric (`greenroof_m2` next to the existing KPIs).
- Python parity port (the pipeline is deliberately structured like
  `processor_web.py`), enabling cantonal-scale runs from bulk-downloaded COGs.
- Once SWISSIMAGE RS pricing is known: compare RS NDVI vs SWISSIMAGE-10-2026
  NDVI vs RGB fallback on the same parcels.
