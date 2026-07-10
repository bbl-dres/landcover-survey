# NIR Imagery for Green-Roof Detection — Screening & Research Reference

**Scope:** imagery with a near-infrared band at roof-resolving resolution (≲ 0.5 m),
Switzerland first (federal → cantonal/city), then EU/foreign open datasets for
method testing; plus green-roof ground-truth datasets and the coarse products that
do *not* fit. Supports the [`greenroof/`](README.md) prototype.
**Compiled:** 2026-07-03. Facts marked **✅ verified** were checked against the live
services on that date (STAC queries, GeoTIFF header parses, HTTP header probes);
everything else is labelled with its confidence. Re-verify licence/endpoint
specifics against the linked primary source before operational use.

---

## 1. The requirement

Delineating vegetated roof area needs **NDVI = (NIR − R) / (NIR + R)** — RGB-only
indexes (GLI, VARI) are usable stand-ins but noisier (chlorophyll reflects NIR far
more distinctly than green). Two hard constraints follow:

- **NIR band present** — rules out most standard RGB orthophotos.
- **Pixel ≪ roof.** A 10 m satellite pixel is 100 m² — a typical green roof is one
  *mixed* pixel. Even a 20'000 m² hall yields ~dozens of pure 10 m pixels. Roof
  delineation needs decimetre imagery; 10 m products are for regional monitoring,
  not per-building mapping.

Useful secondary criteria: LV95/EPSG:2056 delivery (drops into the prototype with
no reprojection), GeoTIFF (browser-readable via geotiff.js; JPEG2000 is not),
open licence, and repeat cadence (for change monitoring later).

---

## 2. Switzerland — federal (swisstopo)

| Product | Res | Bands | Cost | Fit for green roofs | Status |
|---|---|---|---|---|---|
| [SWISSIMAGE 10](https://www.swisstopo.admin.ch/en/orthoimage-swissimage-10) releases ≤ 2025 | 10 cm (25 cm alpine) | **3 (RGB)** | free | RGB fallback only | ✅ verified: 2024 + 2025 COG headers are 3-band, 8-bit JPEG, LV95, 1-km tiles |
| SWISSIMAGE 10 **2026 release** | 10 cm | RGB + **NIR** (announced) | free | the target dataset | ✅ verified absent: no 2026 STAC items as of 2026-07-03 (flight season ongoing; publication typically follows months later, by thirds of CH in a 3-year cycle) |
| [SWISSIMAGE RS](https://www.swisstopo.admin.ch/en/orthoimage-swissimage-rs) | 10 cm | 4 (R,G,B,NIR) | **paid** (quote pending) | ideal; file delivery → prototype drag-&-drop | product page; delivery format to confirm with the quote |
| [swissEO NDVIz](https://www.swisstopo.admin.ch/en/satelliteimage-swisseo-ndviz) | 10 m | NDVI **z-score** | free | **not usable** — see below | ✅ verified from product page |
| swissEO S2-SR | 10 m | Sentinel-2 SR incl. NIR | free | too coarse for roofs; candidate for *monitoring vitality of known, very large* green roofs | product docs (not re-verified this session) |

**Why NDVIz is out**, despite the name: it reports the *deviation* of vegetation
vitality from a 1991–2020 reference median (drought/insect/logging anomaly), is
computed **only for fully forest-covered pixels** (Habitat Map category 6 mask —
roofs never enter the product), at 10 m, monthly in summer. Wrong quantity, wrong
mask, wrong scale for "is this roof vegetated?".

**Access path for SWISSIMAGE 10** (what the prototype uses): STAC collection
[`ch.swisstopo.swissimage-dop10`](https://data.geo.admin.ch/api/stac/v0.9/collections/ch.swisstopo.swissimage-dop10)
→ COG assets on data.geo.admin.ch. ✅ verified: `Access-Control-Allow-Origin: *`,
HTTP 206 range requests honoured → browser-side window reads work with no backend.

---

## 3. Switzerland — cantonal / city open NIR orthophotos

The pragmatic near-term source: several cantons fly their own RGB+NIR orthophotos
and publish them as **OGD in LV95** — they drop straight onto the prototype over
real parcels and AV footprints. Typically delivered as 3-band **CIR composites
(NIR, R, G)** — NDVI works; GLI/VARI don't (no blue band); the prototype's `CIR`
band option handles this.

| Canton / city | Product | Res | Access | Status |
|---|---|---|---|---|
| **Zürich (Kanton)** | Orthofoto Frühjahr (laubfrei) + Sommer, RGB & Infrarot, GeoTIFF, OGD | ~10 cm | [geolion](https://geolion.zh.ch/geodatensatz/3029) · [download page](https://www.stadt-zuerich.ch/geodaten/download/542) (direct files via maps.zh.ch/download; GIS-Browser orders capped at 4 km²) | ✅ verified (pages); **covers the demo parcel CH789283950753** |
| **Genève (SITG)** | Orthophotos proche infrarouge (IRC), vintages 2005–2021 | 20 cm | [catalogue](https://sitg.ge.ch/donnees/image-aerienne-ortho-irc-2018-07) · [announcement](https://sitg.ge.ch/actualites/mise-a-disposition-des-orthophotos-infrarouges) — tile extraction + WMS/WMTS, 2021 in open data | ✅ verified (pages) |
| **Basel-Stadt** | free no-registration [Geodaten-Shop](https://shop.geo.bs.ch/); IR ortho product **not confirmed** | — | [geodata catalogue](https://www.bs.ch/bvd/grundbuch-und-vermessungsamt/geo/geodaten) | ⚠ to check (interesting: BS has a green-roof obligation) |
| Other cantons (AG, BE, LU, SG, …) | many fly RGBI; publication as OGD varies | — | check each canton's geoportal / opendata.swiss | ⚠ not screened this session |

> **Scale note:** this is also the answer to "whole Switzerland is too ambitious" —
> a **canton-ZH pilot** needs no new data agreements, no waiting, and the existing
> prototype. City-level (Stadt Zürich publishes the same OGD imagery) is even smaller.

---

## 4. EU / foreign open NIR orthophotos (method testing)

Foreign sets can't feed the prototype directly (different CRS, no Swiss
parcels/EGRIDs — would need a "bring-your-own-footprints" mode: drop a GeoTIFF +
a GeoJSON of building polygons). Their value is (a) proving the NDVI method on
true 4-band data **today**, and (b) ground truth (§5).

| Country / region | Product | Res | Bands | Licence | Access | Status |
|---|---|---|---|---|---|---|
| 🇩🇪 **NRW** | DOP (true ortho since 2018) | **10 cm** | **4 RGBI** | dl-de/**zero** (no conditions) | [opengeodata.nrw](https://www.opengeodata.nrw.de/produkte/geobasis/lusat/akt/dop/dop_jp2_f10/) — JPEG2000! convert: `gdal_translate -of COG in.jp2 out.tif` | ✅ verified |
| 🇩🇪 **Berlin** | DOP RGBI | 20 cm | 4 RGBI | dl-de/by | [Berlin Open Data / FIS-Broker](https://daten.berlin.de/) | high confidence, not re-verified |
| 🇦🇹 **Austria (BEV)** | DOP Farbe + Infrarot (RGBI), open since 2024 | 20 cm | 4 RGBI | CC BY 4.0 | [data.bev.gv.at record](https://data.bev.gv.at/geonetwork/srv/api/records/f2e11a84-cdc7-4cfa-b048-da3675d58704) | ✅ verified (record) |
| 🇧🇪 **Wallonie** | Orthophotos infrarouge 2020/2021 | 25 cm | IR | open | [géoportail catalogue](https://geoportail.wallonie.be/catalogue/78d58f64-3da2-4dcd-a29b-829466451752.html) · [WMS](https://geoportail.wallonie.be/catalogue/5e7e2ee9-696d-4e31-9f01-83b96d9372d4.html) | ✅ verified (records) |
| 🇫🇷 **France (IGN)** | BD ORTHO **IRC** (infrarouge couleur) | 20 cm | CIR | Licence Ouverte | [geoservices.ign.fr](https://geoservices.ign.fr/bdortho) — JP2, departmental | high confidence, not re-verified |
| 🇳🇱 **Netherlands** | Luchtfoto **CIR** (Beeldmateriaal) | 25 cm | CIR | open (CC-BY) | [PDOK](https://www.pdok.nl/) WMS/WMTS + downloads | high confidence, not re-verified |
| 🇩🇰 **Denmark** | GeoDanmark ortho (spring) | 10–12.5 cm | 4 RGBI | open, free token | [dataforsyningen.dk](https://dataforsyningen.dk/) | medium confidence |
| 🇧🇪 Flanders · 🇱🇺 Luxembourg · 🇪🇪 Estonia · 🇫🇮 Finland · 🇪🇸 Spain (PNOA-IRC) · 🇵🇱 Poland | open CIR/false-colour ortho products exist in each | 10–50 cm | CIR | open | national geoportals | leads only — not screened this session |

**EU-wide products don't fit:** Copernicus Sentinel-2 (free, NIR) is 10 m — see
§1. The Copernicus **VHR Image Mosaics** (2 m, 4-band, every 3 years) are
commercial-source data with restricted-use licensing and 2 m is still marginal —
only worth revisiting for a coarse national screening layer, not delineation.

---

## 5. Ground truth for validation

Threshold calibration ("what NDVI/GLI counts as a green roof?") should be
validated against mapped green roofs, not eyeballed:

| Dataset | Content | Access | Status |
|---|---|---|---|
| **Berlin Umweltatlas «Gründächer»** | building-level green-roof mapping incl. **extensive/intensive** categories (2015 basis) | [WFS on daten.berlin.de](https://daten.berlin.de/datensaetze/gr%C3%BCnd%C3%A4cher-geb%C3%A4udefl%C3%A4chen-umweltatlas-wfs) | ✅ verified (dataset page) |
| **NRW Gründachkataster** | state-wide green-roof cadastre (also solar/greening potential) | [opengeodata.nrw](https://www.opengeodata.nrw.de/produkte/umwelt_klima/klima/gruendachkataster/) | ✅ verified (directory) |
| Swiss city green-roof registers (e.g. Basel green-roof statistics, ZH Gründach potential maps) | would allow *domestic* validation | city geoportals | ⚠ to check |

Combining §4 + §5: **Berlin/NRW RGBI imagery + their green-roof cadastres** = a
free, complete benchmark to tune and score the classifier before any Swiss NIR
data arrives.

---

## 6. Technical facts established 2026-07-03 (verification log)

All checked against live services; the prototype is built on these.

- **STAC** `ch.swisstopo.swissimage-dop10`: 1-km LV95 tiles, id pattern
  `swissimage-dop10_<year>_<EEEE>-<NNNN>`, assets at 0.1 m (or 0.25 m alpine)
  + 2 m preview. Latest years vary by region (3-year cycle) — a parcel can span
  two tiles with **different latest years** (e.g. demo parcel: 2024 + 2025).
  No items dated after the 2025 flight year anywhere in CH.
- **COG headers** (2024 + 2025 samples): `SamplesPerPixel = 3`, 8-bit,
  JPEG-in-TIFF (compression 7, YCbCr), 256×256 internal tiles, 10000×10000 px,
  `ModelPixelScale 0.1` — i.e. **no NIR yet**, and JPEG-compressed COGs (readable
  by geotiff.js).
- **data.geo.admin.ch delivery**: HTTP 206 partial content honoured,
  `Access-Control-Allow-Origin: *` → browser range-reads without a backend.
- **geo.admin.ch `find`** accepts `sr=2056` and returns LV95 GeoJSON.
- **geodienste.ch WFS** (`av_0/deu`, `ms:LCSF`) accepts
  `SRSNAME=urn:ogc:def:crs:EPSG::2056` with an **E,N-ordered** BBOX and returns
  LV95 GeoJSON with German `Art` values (`Gebaeude` = building footprints).
- **Band layouts vs indexes** (prototype's band switch):

  | Layout | Example source | NDVI | GLI/VARI |
  |---|---|---|---|
  | RGB (3) | SWISSIMAGE ≤ 2025 | ✗ | ✓ (fallback) |
  | R,G,B,NIR (4) | NRW/Berlin/BEV RGBI, likely SWISSIMAGE 2026 | ✓ | ✓ |
  | NIR,R,G,B (4) | some deliveries | ✓ | ✓ |
  | **CIR: NIR,R,G (3)** | Kanton ZH Infrarot, SITG IRC, IGN IRC | ✓ | ✗ (no blue) |

- **Formats**: geotiff.js reads GeoTIFF/COG (incl. JPEG-compressed) but **not
  JPEG2000** — JP2 sources (NRW, IGN) need one `gdal_translate` first.

---

## 7. Recommended path (smallest first)

1. **Now — ZH pilot:** download the Kanton ZH Infrarot GeoTIFF around the demo
   parcel (Otelfingen), drag-drop into the prototype (`CIR` band option) → true
   NDVI on real AV footprints; compare against the GLI fallback and calibrate the
   threshold. Extend to the ZH parcels in the portfolio (4 km²/order is ample per
   parcel).
2. **When the RS quote arrives:** request a small extract over the same parcels →
   drag-drop → decide whether RS adds enough over the free cantonal CIR.
3. **Optional method benchmark:** Berlin RGBI + Gründächer WFS as ground truth
   (needs the small "bring-your-own-footprints" prototype extension).
4. **2026/2027 — national:** when 4-band SWISSIMAGE 2026 tiles appear on STAC the
   prototype switches to NDVI automatically; only then does a Switzerland-wide
   rollout make sense (subject to the 3-year refresh: full national NIR coverage
   arrives release by release).
