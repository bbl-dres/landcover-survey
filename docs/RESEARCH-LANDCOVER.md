# Land Cover, Land Use & Habitat Data — Screening & Research Reference

**Scope:** Global → EU → DACH → Switzerland. Ready-made products, authoritative/cadastral vector data, computer-vision models/datasets, and habitat/biotope/vegetation mapping. Free, academic, and commercial.
**Compiled:** June 2026.

---

## Purpose

This document is a screening reference for identifying, comparing, and selecting land cover, land use, and habitat data — datasets, ready-made products, and models — for GIS workflows, with a Swiss federal focus. For any given task it is meant to answer one question: *which source is the best fit, given the unavoidable tradeoff between spatial resolution, thematic detail, accuracy, and coverage/currency/cost.* It spans four product families (automated raster maps; authoritative/cadastral vector; computer-vision models and training data; habitat/biotope/vegetation mapping) across four scales (global, EU, DACH, Switzerland), covering free, academic, and commercial options.

Use it to shortlist candidates, then verify the specifics — licence, CRS, currency, access endpoint — against the linked primary source before operational use. Links are provided for every dataset; deep paths on official portals can change over time.

---

## 1. The tradeoff that governs everything

There is no single "best" land cover product. Every option sits somewhere on a tradeoff between five dimensions that cannot all be maximised at once:

- **Spatial resolution** (pixel/polygon size)
- **Thematic detail** (number and granularity of classes)
- **Accuracy** (thematic overall accuracy *and* positional/geometric fidelity — these are separate)
- **Currency / update lag** (how recent the data is, and how fast new features appear in it)
- **Coverage + cost** (how much of the world, free vs paid)

**Currency is its own axis, and it trades against authority.** The most geometrically accurate, legally authoritative sources are often *not* the most current: surveyed cadastral data can lag real ground truth by years, precisely for the features that change (new construction). So "authoritative" and "up to date" must be judged separately — a source can win decisively on geometry while being the wrong choice for detecting what was built last year. See the Swiss currency note in §4.

Four *families* of product map onto different points in that space:

1. **Automated raster maps** (WorldCover, Dynamic World, CLC+, LCFM) — broad coverage, consistent, but coarse thematically and ~74–85% accurate.
2. **Authoritative / cadastral vector** (AV Bodenbedeckung, ALKIS, ATKIS, LBM-DE) — very high positional accuracy and legal authority, fewer "land cover" classes, national only.
3. **Computer-vision models + training datasets** (foundation models, OpenEarthMap, FLAIR) — the route to *your own* high-detail map when no product fits, at the cost of fine-tuning effort.
4. **Habitat / biotope / vegetation mapping** (Habitat Map of Switzerland, Biotopinventare, EUNIS) — ecologically-explicit classes (not generic land cover) and legal-conservation authority; the bridge to biodiversity reporting.

---

## 2. Global products

### 2a. Modern 10 m maps (free)

| Product | Res | Classes | Accuracy | Cadence | Links |
|---|---|---|---|---|---|
| **ESA WorldCover** | 10 m | 11 | 74.4% (2020) / 76.7% (2021) | 2020, 2021 only (frozen) | [site](https://esa-worldcover.org/en) · [viewer](https://viewer.esa-worldcover.org/worldcover/) |
| **Esri / Impact Observatory Annual LULC** | 10 m | 9 | >75% (85% in-test) | annual 2017–2024 | [explorer](https://livingatlas.arcgis.com/landcoverexplorer/) · [AWS](https://registry.opendata.aws/io-lulc/) · [IO](https://www.impactobservatory.com/maps-for-good) |
| **Google Dynamic World** | 10 m | 9 | 73.8% | near-real-time (2–5 d) | [app](https://dynamicworld.app/) · [EE](https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_DYNAMICWORLD_V1) |
| **Copernicus LCFM — Global Land Cover** | 10 m | LCCS-based | validation ongoing | annual 2020–2026 | [CLMS](https://land.copernicus.eu/en/products/global-dynamic-land-cover) · [VITO](https://blog.vito.be/remotesensing/copernicus-lcfm) |

### 2b. Most thematically detailed global option

| Product | Res | Classes | Accuracy | Links |
|---|---|---|---|---|
| **GLC_FCS30 / GLC_FCS30D** (Chinese Academy of Sciences) | 30 m | 30–35 fine types | 82.5% (9-cl), 71.4% (16-cl), 68.7% (24-cl) | [ESSD 2024](https://essd.copernicus.org/articles/16/1353/2024/) · [ESSD 2021](https://essd.copernicus.org/articles/13/2753/2021/) |

GLC_FCS30D spans 1985–2022 in 26 steps; free on Zenodo (linked from the ESSD papers). The richest *global* class scheme.

### 2c. Established coarse / legacy global

| Product | Res | Classes | Coverage | Links |
|---|---|---|---|---|
| **ESA CCI Land Cover** | 300 m | 22 | 1992–2020 | [site](https://www.esa-landcover-cci.org/) |
| **Copernicus Global Dynamic Land Cover** | 100 m | ~23 | 2015–2019 (superseded by LCFM) | [CLMS](https://land.copernicus.eu/en/products/global-dynamic-land-cover) |
| **MODIS MCD12Q1** | 500 m | IGBP 17-class | annual since 2001 | [LP DAAC](https://lpdaac.usgs.gov/products/mcd12q1v061/) |
| **GlobeLand30** (NGCC China) | 30 m | 10 | 2000/2010/2020 | [site](https://www.globeland30.org/) |
| **FROM-GLC10** (Tsinghua) | 30 m/10 m | global, academic | one-off | [data portal](http://data.ess.tsinghua.edu.cn/) |

### 2d. The "embedding" route (model output you classify yourself)

| Product | Res | Notes | Links |
|---|---|---|---|
| **AlphaEarth Foundations — Satellite Embedding** (Google/DeepMind) | 10 m | 64-D annual embeddings 2017–2025, multimodal, CC-BY-4.0. Attach a small labelled set, train RF/MLP in CPU minutes — no GPU inference. Best accuracy-per-effort for custom maps. | [EE catalog](https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_SATELLITE_EMBEDDING_V1_ANNUAL) · [DeepMind](https://deepmind.google/blog/alphaearth-foundations-helps-map-our-planet-in-unprecedented-detail/) |
| **TESSERA / Geo-TESSERA** (Univ. Cambridge) | 10 m | Open, reproducible alternative: global, annual embeddings via the GEOTESSERA Python library; habitat-mapping tooling included. | [arXiv](https://arxiv.org/abs/2506.20380) |
| **Major TOM** (ESA Φ-lab + CloudFerro) | varies | Standardised open EO datasets + global dense embeddings (among the largest open global embedding sets by covered surface). | [GitHub](https://github.com/ESA-PhiLab/Major-TOM) · [HF](https://huggingface.co/Major-TOM) |
| **Clay** + **Earth Genome S2 embeddings** | 10 m | Other open embedding datasets (Clay saw NAIP aerial). | [Clay](https://madewithclay.org/) · [Earth Genome](https://www.earthgenome.org/) |

### 2e. Thematic global layers (settlement, buildings, forest, crops)

| Theme | Product | Res | Coverage | Links |
|---|---|---|---|---|
| Settlement | **GHSL** (JRC) — built-up surface/volume, population, 3D | 10–100 m | global, multi-epoch | [portal](https://human-settlement.emergency.copernicus.eu/) |
| Settlement | **World Settlement Footprint** + **WSF-3D** (DLR) | 10 m | global | [DLR geoservice](https://geoservice.dlr.de/) |
| Buildings | **Overture Maps — Buildings** | vector | global (2.3B+) | [guide](https://docs.overturemaps.org/guides/buildings/) · [site](https://overturemaps.org/) |
| Buildings | **Google Open Buildings** | vector | global | [site](https://sites.research.google/gr/open-buildings/) |
| Buildings | **Microsoft Global ML Building Footprints** | vector | near-global | [GitHub](https://github.com/microsoft/GlobalMLBuildingFootprints) |
| Forest | **Hansen Global Forest Change** (UMD) | 30 m | 2000 + annual loss/gain | [GLAD app](https://glad.earthengine.app/view/global-forest-change) · [GFW](https://data.globalforestwatch.org/) |
| Forest | **JRC Tropical Moist Forest (TMF)** | 30 m | 1990–2025 | [JRC](https://forobs.jrc.ec.europa.eu/TMF) |
| Forest | **JRC GFC2020** (EU Deforestation Regulation) | 10 m | year 2020 | [JRC](https://forobs.jrc.ec.europa.eu/GFC) |
| Crops | **ESA WorldCereal** | 10 m | global, seasonal | [site](https://esa-worldcereal.org/) · [ESSD](https://essd.copernicus.org/articles/15/5491/2023/) |
| (US ref.) | **USGS NLCD / Annual NLCD** | 30 m | US | [MRLC](https://www.mrlc.gov/) |

WorldCereal's temporary-crop product reports user's/producer's accuracy of 88.5% / 92.1% (OA 97.8%).

---

## 3. EU / Europe (all cover Switzerland unless noted)

| Product | Res / unit | Classes | Cadence | Links |
|---|---|---|---|---|
| **CORINE Land Cover** | 100 m + vector, MMU 25 ha | 44 (3-level) | 6-yr (1990–2018) | [CLMS](https://land.copernicus.eu/en/products/corine-land-cover) |
| **CLC+ Backbone** | 10 m raster | 11 EAGLE | 2–3-yr | [CLMS](https://land.copernicus.eu/en/products/clc-backbone) |
| **Copernicus HRL** (Imperviousness, Forest, Grassland, Water & Wetness, Small Woody Features) | 10–20 m | thematic per layer | ~3-yr | [CLMS](https://land.copernicus.eu/en/products/high-resolution-layers) |
| **Urban Atlas** | vector, MMU 0.25 ha | ~27 LULC | ~6-yr | [CLMS](https://land.copernicus.eu/en/products/urban-atlas) |
| **LUCAS** (Eurostat) | in-situ points | LC + LU surveys | ~3-yr | [Eurostat](https://ec.europa.eu/eurostat/web/lucas) |
| **S2GLC / ELC10** (academic) | 10 m | 13 / LUCAS-typology | one-off | [S2GLC](http://s2glc.cbk.waw.pl/) |
| **Copernicus Local — Riparian Zones** | VHR vector | up to ~56 MAES classes | per cycle | [CLMS](https://land.copernicus.eu/en/products/riparian-zones) |
| **Copernicus Local — Natura 2000 (N2K)** | VHR vector | LC/LU + change | 2006/12/18 | [CLMS](https://land.copernicus.eu/en/products/n2k) |
| **Copernicus Local — Coastal Zones** | VHR vector | LC/LU | per cycle | [CLMS](https://land.copernicus.eu/en/products/coastal-zones) |
| **EU-Hydro / EU-DEM** | vector / 25 m | reference layers | — | [EU-Hydro](https://land.copernicus.eu/en/products/eu-hydro) · [EU-DEM](https://land.copernicus.eu/en/products/eu-dem) |

**National products worth referencing:**

| Country | Product | Res / classes | Links |
|---|---|---|---|
| France | **Theia OSO / CNES Land Cover** | 10 m, 23 classes, annual | [Theia](https://www.theia-land.fr/en/product/land-cover-map/) |
| France | **IGN OCS GE** (official HR vector, fed by FLAIR) | vector | [IGN](https://geoservices.ign.fr/ocsge) |
| Spain | **SIOSE** (mixed-cover % per polygon) | object/polygon | [SIOSE](https://www.siose.es/) · [IGN](https://www.ign.es/web/ign/portal/siose) |
| UK | **UKCEH Land Cover Map (LCM)** | 10–25 m | [CEH](https://www.ceh.ac.uk/data/ukceh-land-cover-maps) |

---

## 4. DACH national + cadastral

### Germany

| Product | Type / res | Classes | Links |
|---|---|---|---|
| **LBM-DE** (BKG, for UBA) | Vector, MMU 1 ha | 31 LC + 16 LU (latest 2021, pub. Dec 2024) | [GDZ](https://gdz.bkg.bund.de/index.php/default/digitale-geodaten/digitale-landschaftsmodelle/landbedeckungsmodell-fur-deutschland-lbm-de.html) · [BKG news](https://www.bkg.bund.de/SharedDocs/Produktinformationen/BKG/DE/P-2024/241209_LBMDE.html) |
| **Cop4ALL-DE** (BKG + Geobasis NRW) | AI-produced national LC (S2 + DOP + nDOM) | — | [BKG project](https://www.bkg.bund.de/DE/Forschung/Projekte/Cop4All-DE/Cop4All-DE_cont.html) |
| **ATKIS Basis-DLM** (AdV) | Authoritative topographic vector | Bodenbedeckung + Bodennutzung | [AdV](https://www.adv-online.de/AdV-Produkte/Geotopographie/ATKIS/) · [GDZ](https://gdz.bkg.bund.de/index.php/default/digitale-geodaten/digitale-landschaftsmodelle/digitales-basis-landschaftsmodell-ger-basis-dlm.html) |
| **ALKIS – Tatsächliche Nutzung** (cadastre, Länder) | Parcel-level vector | "actual use" + INSPIRE LC/LU | [AdV](https://www.adv-online.de/AdV-Produkte/Liegenschaftskataster/ALKIS/) |
| **IÖR-Monitor** (Leibniz IÖR, Dresden) | indicators (raster + vector) | ~80 indicators | [monitor](https://www.ioer-monitor.de/) |

LBM-DE carries per-object imperviousness and vegetation degree %. ALKIS is part of the AAA model; EPSG:25832; open under Datenlizenz DE; coverage/format varies by Land.

### Austria

| Product | Type / res | Classes | Links |
|---|---|---|---|
| **BEV "Land Cover"** | Raster, 20 cm | 6 (veg high/med/low, buildings, ground, water) | [BEV](https://www.bev.gv.at/) |
| **DLM – Bodenbedeckung** (BEV) | High-precision vector | topographic LC objects | [BEV](https://www.bev.gv.at/) |
| **DKM – Digitale Katastralmappe** (BEV) | Cadastre | parcels + Nutzungsarten | [BEV](https://www.bev.gv.at/) |
| **GeoVille / LISA** — validated S2 land-cover map of Austria | 10 m + VHR | LC/LU | [Copernicus news](https://www.copernicus.eu/en/validated-sentinel-2-based-land-cover-map-austria-released-first-time) |

### Switzerland — authoritative LC / LU

| Product | Type / res | Classes | Links |
|---|---|---|---|
| **AV – Bodenbedeckung** (Amtliche Vermessung; DM.01-AV-CH) | Surveyed vector, cm-level | 6 main / ~20 sub (Gebäude; befestigt; humusiert; Gewässer; bestockt; vegetationslos) | [geodienste](https://www.geodienste.ch/services/av) · [opendata.swiss](https://opendata.swiss/de/dataset/av-bodenbedeckung) |
| **Arealstatistik** (NOAS04 / NOLC04 / NOLU04, BFS GEOSTAT) | Point sample, 100 m grid | 72 base → 27/17; cover (27) & use (46) | [BFS](https://www.bfs.admin.ch/bfs/de/home/dienstleistungen/geostat/geodaten-bundesstatistik/boden-nutzung-bedeckung-eignung/arealstatistik-schweiz.html) · [opendata.swiss](https://opendata.swiss/de/dataset/arealstatistik-der-schweiz) |
| **swissTLM3D** (swisstopo) | Topographic vector | Bodenbedeckung / Areal themes | [swisstopo](https://www.swisstopo.admin.ch/en/landscape-model-swisstlm3d) |
| **GWR / RegBL** (Gebäude- und Wohnungsregister, BFS) | Building register (point + EGID) | Building lifecycle incl. **Baustatus** (projektiert / bewilligt / im Bau / bestehend / abgebrochen), category, use | [BFS RegBL](https://www.housing-stat.ch/) · [opendata.swiss](https://opendata.swiss/de/dataset/eidg-gebaeude-und-wohnungsregister) |

AV Bodenbedeckung is the most spatially accurate authoritative "land cover" in CH (surveyed polygons, WMS/WFS/IFC) — but a legal/cadastral generalisation, not wall-to-wall RS. Arealstatistik is the most thematically rich official CH LC/LU, but spatially coarse (one point per ha); 12-yr cycle (2013/18; 2018/24 in progress). CORINE and CLC+ Backbone also cover Switzerland (EEA38).

#### Currency / update lag (important caveat for new construction)

AV is **not necessarily current**, even though it is authoritative. Two update modes govern it, and both introduce lag:

- **Laufende Nachführung** (event-driven): a new or modified building should be updated within ~6 months — but the *definitive* entry into the AV dataset is gated on the change first being legally registered in the *Grundbuch*. Until then the building may exist only as a *projektiertes Gebäude*, or not yet at all. Cantonal *Meldewesen* and commissioning of the *Nachführungsgeometer* add further variance.
- **Periodische Nachführung** (cyclic): the whole *Bodenbedeckung* layer is also refreshed on a cycle of typically **6 years, extensible to 12** in extensively used areas.

Net effect: a Bodenbedeckung polygon lagging real ground truth by **several years for recent construction is normal**, not a defect — consistent with field observations of ~5-year gaps. Mitigations:

- **GWR / RegBL** (above) — building lifecycle tracked via the building-permit workflow through the *Baustatus* field; the timeliest official signal that a building is projected / under construction / completed (near-real-time relative to AV's definitive entry).
- **AV periodic-updating status** — the *Stand der periodischen Nachführung (PNF)* / "Aktualität der amtlichen Vermessung" layer shows, per area, how current the AV actually is. Check it before trusting AV currency. [cadastre.ch — Nachführung](https://www.cadastre.ch/de/nachfuehrung-der-av)
- **Recent SWISSIMAGE 10 cm** (≤3-yr flight cycle, annually-refreshed mosaic) for visual confirmation, and **ML building footprints** (Microsoft / Google / Overture) or **swissEO / Sentinel change detection** to flag construction not yet in AV.

**Currency at a glance (Swiss sources):**

| Source | Typical recency / lag | Update mode |
|---|---|---|
| **GWR Baustatus** | days–weeks (permit-driven) | continuous, event-based |
| **swissEO S2-SR** | ~5 days | rolling Sentinel-2 |
| **Dynamic World** | 2–5 days | near-real-time |
| **SWISSIMAGE 10 cm** | ≤3 years | 3-yr flight cycle |
| **swissTLM3D** | annual release (imagery-derived) | yearly |
| **AV Bodenbedeckung** | months → 6–12 years | laufende + periodische Nachführung |
| **Arealstatistik** | data ~years old at release | 12-yr (now ~6-yr) cycle |
| **Habitat Map of Switzerland** | snapshot (v1.1 = 2024) | irregular re-issue |

---

## 5. Switzerland — federal raster, imagery & planning

Native EPSG:2056 (CH1903+/LV95) unless noted; mostly free under open swisstopo / opendata.swiss terms (verify per product).

### 5a. swisstopo imagery & 3D

| Product | Type / res | Links |
|---|---|---|
| **SWISSIMAGE 10 cm** | Orthophoto, 10 cm (plains) / 25 cm (Alps), RGB COG | [swisstopo](https://www.swisstopo.admin.ch/en/orthoimage-swissimage-10) · [overview](https://www.swisstopo.admin.ch/en/orthoimages) |
| **SWISSIMAGE RS** | 4-band incl. NIR, 2005–2025 | [overview](https://www.swisstopo.admin.ch/en/orthoimages) |
| **SWISSIMAGE HIST** | B/W from 1926; 1946 "US flight" at 50 cm | [swisstopo](https://www.swisstopo.admin.ch/en/orthoimage-swissimage-hist) |
| **swissSURFACE3D** | Airborne-LiDAR classified point cloud | [swisstopo](https://www.swisstopo.admin.ch/en/height-model-swisssurface3d) |
| **swissSURFACE3D Raster** | DSM derivative | [swisstopo](https://www.swisstopo.admin.ch/en/height-model-swisssurface3d-raster) |
| **swissALTI3D** | High-precision DTM | [swisstopo](https://www.swisstopo.admin.ch/en/height-model-swissalti3d) |
| **swissBATHY3D** | Lakebed model | [overview](https://www.swisstopo.admin.ch/en/height-models) |
| **swissTLMRegio** | Small-scale topographic model (~1:200,000) | [swisstopo](https://www.swisstopo.admin.ch/en/landscape-models) |

### 5b. Vegetation & EO analysis-ready layers

| Product | Res | Links |
|---|---|---|
| **Vegetation Height Model (VHM / VHM NFI)** (WSL + swisstopo) | 1 m canopy height | [EnviDat](https://www.envidat.ch/dataset/vegetation-height-model-nfi) |
| **swissEO S2-SR** (swisstopo) | 10 m | [swisstopo](https://www.swisstopo.admin.ch/en/satelliteimage-swisseo-s2-sr) |
| **swissEO VHI** (Vegetation Health Index) | 10 m | [swisstopo](https://www.swisstopo.admin.ch/en/satelliteimage-swisseo-vhi) |

swissEO S2-SR is Switzerland-harmonised Sentinel-2 surface reflectance (~every 5 days since spring 2017) with custom co-registration and cloud/terrain-shadow masking; NDVIz/NDVIdiff anomaly layers derive from it. VHM is normalised against swissALTI3D with buildings masked via TLM, ~1/6 of CH refreshed yearly.

### 5c. Forest (WSL / National Forest Inventory)

| Product | Res | Links |
|---|---|---|
| **Tree Species Map of Switzerland** (Koch et al. 2024) | 10 m, 15 dominant species | [EnviDat](https://www.envidat.ch/dataset/tree-species-map-of-switzerland) (access on request) |
| **LFI / NFI** (National Forest Inventory) | ~6,500 plots | [LFI](https://www.lfi.ch/) |

Also: NFI broadleaved/coniferous tree-type map (10 m) and MoGLI woody-species potential-distribution maps (25 m), both via WSL/EnviDat.

### 5d. Land use, planning & agriculture

| Product | Authority | Links |
|---|---|---|
| **Bauzonen Schweiz (harmonisiert)** | ARE + cantons | [ARE](https://www.are.admin.ch/are/de/home/raumentwicklung-und-raumplanung/grundlagen-und-daten/bauzonen.html) · [KGK-CGC](https://www.kgk-cgc.ch/geodaten/geodaten-bauzonen-schweiz) |
| **ÖREB-Kataster** (public-law restrictions) | ARE / cadastre.ch | [cadastre.ch](https://www.cadastre.ch/de/oereb.html) |
| **MGDM framework / geodienste.ch** | swisstopo COGIS + offices | [geodienste](https://www.geodienste.ch/) |
| **Fruchtfolgeflächen (FFF)** | ARE / cantons | [ARE](https://www.are.admin.ch/are/de/home/raumentwicklung-und-raumplanung/grundlagen-und-daten/fruchtfolgeflaechen.html) |
| **Landwirtschaftliche Nutzungsflächen** (MGDM ID 153, "LWB") | BLW + cantons | [opendata.swiss](https://opendata.swiss/de/dataset/landwirtschaftliche-nutzungsflachen-schweiz) · [BLW](https://www.blw.admin.ch/) |

The ÖREB cadastre carries 22+ federal restriction themes including Nutzungsplanung/Zonenpläne — the legally-binding land-use layer. The Landwirtschaftliche Nutzungsflächen layer is direct-payment-grade parcel + crop data.

### 5e. Platform & cantonal

| Item | Notes | Links |
|---|---|---|
| **Swiss Data Cube** (UNEP/GRID-Geneva + UNIGE + UZH + WSL; FOEN mandate) | Open-Data-Cube ARD archive of all Landsat 5/7/8 + Sentinel-1/2 over CH, 1984→present | [site](https://www.swissdatacube.org/) · [GitHub](https://github.com/unep-grid/SwissDataCube) |
| **Cantonal / city data** | Zürich, Bern et al. publish VHR zone/land-use + cantonal LiDAR that can locally exceed national detail | [geodienste](https://www.geodienste.ch/) |

---

## 6. Habitat / biotope / vegetation mapping

Ecologically-explicit classes — distinct from generic land cover, and the bridge to biodiversity reporting. The Swiss entry point is the BAFU habitats portal: [bafu.admin.ch/lebensraeume](https://www.bafu.admin.ch/de/lebensraeume).

### 6a. Switzerland

| Product | Type / res | Classes | Links |
|---|---|---|---|
| **Habitat Map of Switzerland** (Lebensraumkarte der Schweiz; WSL, funded by BAFU) | Vector + 1 m raster | 84 habitats / 32 groups / 9 classes (TypoCH, to L2–L3) | [EnviDat](https://www.envidat.ch/dataset/the-habitat-map-of-switzerland-v1-1) · [WSL](https://www.wsl.ch/en/projects/lebensraumkarte-schweiz-1/) · [paper](https://www.mdpi.com/2072-4292/15/3/643) · [opendata.swiss](https://opendata.swiss/en/dataset/lebensraumkarte-der-schweiz) |
| **Biotopinventare** (Hoch-/Flachmoore, Auen, Amphibienlaichgebiete, TWW) + **Moorlandschaften** | Legally-binding vector | habitats of national importance | [BAFU](https://www.bafu.admin.ch/de/biotope) |
| **Wirkungskontrolle Biotopschutz (WBS)** (WSL for FOEN) | Monitoring (plots + aerial) | — | [WSL](https://biotopschutz.wsl.ch/en/) |

The Habitat Map (cite: Price et al. 2024, EnviDat DOI 10.16904/envidat.515; also served on map.geo.admin.ch as `ch.bafu.lebensraumkarte-schweiz`) is a composite remote-sensing product from 1 m orthoimagery (RGB+NIR), Planet 3 m, Sentinel-1/-2, distribution models, and 3D photogrammetry. The five Biotopinventare plus Moorlandschaften cover roughly 6,000–7,000 objects (~2.2% of national area); cite object counts with their reference year. **TypoCH** (Delarze et al.) is the underlying Swiss typology and crosswalks to EUNIS.

### 6b. Europe

| Product | Notes | Links |
|---|---|---|
| **EUNIS Habitat Classification** | Pan-European standard (9 formations) | [EEA datahub](https://www.eea.europa.eu/en/datahub/datahubitem-view/123d0c9a-a6fa-4f2d-b887-5d8e5468faed) · [EUNIS](https://eunis.eea.europa.eu/habitats.jsp) |
| **EEA Ecosystem Type Map** | EUNIS L2, v3.1, 100 m (CORINE-derived) | [EEA](https://www.eea.europa.eu/data-and-maps/data/ecosystem-types-of-europe) |
| **EUNIS habitat map at Level 3** (machine learning, 2025) | 260 habitat types @ 100 m, EEA39 | [Nature Sci Data](https://www.nature.com/articles/s41597-025-06235-7) |

### 6c. Germany & Austria

| Country | Product | Notes | Links |
|---|---|---|---|
| Germany | **FFH-Bericht 2025 / Article 17** (BfN) | 93 habitat types, 201 species + 4 groups; UTM 10×10 km grid | [BfN](https://www.bfn.de/ffh-bericht-2025) |
| Germany | **Rote Liste der Biotoptypen** (BfN, NaBiV 156) | 863 Biotoptypen; §30 BNatSchG protected biotopes per Land | [BfN](https://www.bfn.de/) |
| Austria | **MAES/EUNIS habitat map of Austria, 10 m** (UBA 2021) | national raster, 157 EUNIS types (compiled, not field-mapped) | [PANGAEA](https://doi.pangaea.de/10.1594/PANGAEA.934147) |
| Austria | **Biotoptypen** (Biodiversitäts-Atlas / UBA Rote Liste) | >500 biotope types; no single uniform national typology | [Atlas](https://biodiversityatlas.at/biotoptypen/) |

DACH habitat/biotope mapping is federalized — the 16 Länder / 9 Bundesländer do the field mapping; federal agencies aggregate only for EU reporting. Neither DE nor AT has a single seamless field-mapped national biotope map, in contrast to Switzerland's wall-to-wall Habitat Map.

---

## 7. The computer-vision route (build your own detailed map)

When no ready-made product is detailed enough — e.g. metre-scale LC from swissIMAGE 10 cm — fine-tune a model on labelled imagery.

### 7a. Foundation models / backbones

| Model | Origin | Strength | Links |
|---|---|---|---|
| **Prithvi-EO-2.0** | NASA + IBM | Mature, widely benchmarked | [HF](https://huggingface.co/ibm-nasa-geospatial) |
| **Clay** | Clay community | Largest GFM; aerial-aware (saw NAIP) | [site](https://madewithclay.org/) |
| **TerraMind** | IBM + ESA | Strong on PANGAEA / ecological LULC; any-to-any modality | [HF](https://huggingface.co/ibm-esa-geospatial) |
| **AlphaEarth / TESSERA** | DeepMind / Cambridge | Lowest effort: classify embeddings directly (see §2d) | [EE](https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_SATELLITE_EMBEDDING_V1_ANNUAL) · [arXiv](https://arxiv.org/abs/2506.20380) |
| **SatlasPretrain** | Allen Inst. for AI | 302M labels / 137 categories; powers Satlas | [GitHub](https://github.com/allenai/satlas/blob/main/SatlasPretrain.md) · [Satlas](https://satlas.allen.ai/) |

Other research backbones: SatMAE, Scale-MAE, Presto, DOFA, CROMA, SpectralGPT, SkySense; IBM Granite-Geospatial.

### 7b. Aerial-native training datasets (closest to swissIMAGE)

| Dataset | GSD | Classes | Coverage | Links |
|---|---|---|---|---|
| **FLAIR** (IGN, France) | 20 cm aerial | ~12–13 | Country-scale France + S2 | [site](https://ignf.github.io/FLAIR/) · [arXiv](https://arxiv.org/abs/2310.13336) |
| **OpenEarthMap** | 0.25–0.5 m | 8 | 97 regions / 44 countries | [site](https://open-earth-map.org/) |
| **LoveDA** | 0.3 m | 7 | China urban+rural | [GitHub](https://github.com/Junjue-Wang/LoveDA) |
| **ISPRS Potsdam / Vaihingen** | 5 / 9 cm | 6 | DE | [ISPRS](https://www.isprs.org/education/benchmarks/UrbanSemLab/default.aspx) |
| **Chesapeake** | 1 m | 6 LC / NLCD | US (6 states) | [LILA](https://lila.science/datasets/chesapeakelandcover) |

### 7c. Benchmarks

| Benchmark | Focus | Links |
|---|---|---|
| **GEO-Bench / GEO-Bench-2** | segmentation, regression, change detection | [GitHub](https://github.com/ServiceNow/geo-bench) |
| **PANGAEA** | multi-task GFM benchmark | [GitHub](https://github.com/VMarsocci/pangaea-bench) |
| **PhilEO Bench** | land cover, buildings, roads on global S2 | [GitHub](https://github.com/ESA-PhiLab/PhilEO-Bench) |

---

## 8. Commercial providers

| Provider | Product | Coverage | Links |
|---|---|---|---|
| **ExoLabs** (Zurich, CH) | LC/LU classifiers (99 categories) + snow/land monitoring | CH + beyond | [site](https://www.exolabs.ch/) |
| **GeoVille** (Innsbruck, AT) | Copernicus layers, LISA, LandMonitoring.Earth; LCFM consortium | AT + EU + global | [site](https://www.geoville.com/) · [LandMonitoring](https://www.landmonitoring.earth/) |
| **Ecopia AI** | 2D/3D land cover (vector), 14+ layers, >95% geometric | global, project-based | [site](https://www.ecopiatech.com/) |
| **EarthDefine (SpatialCover)** | LC, impervious, tree, parking, Clutter3D | US only | [site](https://www.earthdefine.com/) |
| **Impact Observatory** | LULC Map-on-Demand (paid tier of Esri/IO maps) | global | [site](https://www.impactobservatory.com/) |
| **Picterra / Planet / Airbus / Nearmap / Vexcel** | imagery + analytics; LC via partners | global / regional | [Picterra](https://picterra.ch/) · [Planet](https://www.planet.com/) · [Airbus](https://www.intelligence-airbus.com/) · [Nearmap](https://www.nearmap.com/) · [Vexcel](https://vexcelgroup.com/) |

---

## 9. Synthesis — most accurate vs most detailed vs most ecological vs most current

**Most thematically detailed (land cover/use)**
- Global: **GLC_FCS30D** (30–35 classes @ 30 m).
- Europe: **CORINE** (44 classes, 25 ha MMU) / **Urban Atlas** in cities.
- Germany: **LBM-DE** (31 LC + 16 LU @ 1 ha).
- Switzerland: **Arealstatistik** (72 categories — but hectare points).

**Most spatially/geometrically accurate (authoritative)**
- Switzerland: **AV Bodenbedeckung** (surveyed, cm-level) — but see currency caveat: authoritative ≠ current.
- Germany: **ALKIS Tatsächliche Nutzung** + **ATKIS**.
- Austria: **BEV Land Cover 20 cm** + **DKM**.
- Commercial: **Ecopia** (>95% geometric).

**Most current for detecting new construction / change**
- Switzerland buildings: **GWR Baustatus** (permit-driven, near-real-time) + recent **SWISSIMAGE 10 cm**; cross-check against AV, which lags.
- Built-up change: **swissEO S2-SR** / **Dynamic World** (days) + **ML building footprints** (Microsoft / Google / Overture).
- Note: AV Bodenbedeckung and Arealstatistik are the *wrong* tools for "what was built recently" — they lag by years.

**Most ecologically explicit (habitat/biotope)**
- Switzerland: **Habitat Map of Switzerland** (84 habitats, wall-to-wall) + the five **Biotopinventare** (legally binding).
- Europe: **EUNIS** L3 ML map (260 types) / EEA Ecosystem-Type Map.
- DACH: AT **UBA EUNIS 10 m** (157 types); DE **FFH / §30** (federalized).

**Best automated wall-to-wall raster over Switzerland**
- **CLC+ Backbone** (10 m, EU-validated) or **Copernicus LCFM** (10 m, post-2020 currency) — both clip onto a swissIMAGE/parcel pipeline.

**Most accurate fully-automated global map**
- The 10 m maps top out at ~74–85% OA; GLC_FCS30 ~82.5% at coarse-class level. None exceed mid-80s% globally.

---

## 10. Recommendation for a Swiss GIS workflow

Pick by use-case rather than chasing a single "best":

1. **Authoritative land cover, off the shelf** → AV Bodenbedeckung (best geometry) + Arealstatistik (thematic richness) + swissTLM3D (crisp boundaries). All free, native EPSG:2056.
2. **Base imagery & height for custom work** → SWISSIMAGE 10 cm (+ RS for NIR) + swissSURFACE3D / swissALTI3D + VHM NFI.
3. **Consistent 10 m raster backdrop / change** → CLC+ Backbone or Copernicus LCFM; swissEO S2-SR for national ARD time-series; Swiss Data Cube for 1984→present.
4. **Ecological / biodiversity** → Habitat Map of Switzerland + the five Biotopinventare + TypoCH→EUNIS crosswalk.
5. **Built-up / impervious** → GHSL/WSF + Overture buildings + Copernicus Imperviousness HRL.
6. **Agriculture** → BLW Nutzungsflächen + FFF + WorldCereal.
7. **Custom high-resolution from swissIMAGE 10 cm** → fine-tune an OpenEarthMap- or FLAIR-trained segmentation model (FLAIR's 20 cm French aerial is the closest domain match), or classify AlphaEarth/Major TOM embeddings for a fast 10 m map with minimal labelling.
8. **Guaranteed sub-metre vector, can pay** → commission Ecopia, or engage ExoLabs (CH) / GeoVille (AT) for Swiss/DACH-tuned LC.

---

## 11. Caveats

- **Accuracy figures are not directly comparable** — different reference sets, class schemes, regions. Spot-check any product against Arealstatistik points or your own labels before trusting a headline number over Switzerland.
- **Cadastral ≠ remote-sensing land cover.** AV Bodenbedeckung, ALKIS, ATKIS are legal/topographic generalisations (e.g. paved parking folded into *befestigt*) — excellent geometry, administrative taxonomy.
- **Authoritative ≠ current.** Surveyed cadastral data lags real ground truth, often by years, for recently changed features. Swiss AV updates via *laufende Nachführung* (~6 months, but gated on *Grundbuch* registration) and *periodische Nachführung* (6–12-yr cycle), so new buildings can be missing or shown only as *projektiert* for several years. For currency on construction use **GWR Baustatus** + recent **SWISSIMAGE**, and check the AV periodic-updating (PNF) status layer (see §4). The same pattern applies to German ALKIS / *Gebäudeeinmessung*.
- **Habitat ≠ land cover.** Habitat Map, Biotopinventare and EUNIS use ecological classes; EEA/AT EUNIS maps are modelled/compiled (not wall-to-wall field surveys) with acknowledged gaps; even the Swiss Habitat Map uses distribution models for habitats not separable from imagery alone.
- **Cantonal/Länder fragmentation.** Swiss AV and German ALKIS are run sub-nationally; coverage, formats (DXF/IFC/NAS), update status vary. DACH habitat data is federalized.
- **WorldCover is frozen at 2021;** use Esri/IO, Dynamic World, or Copernicus LCFM for post-2021 global 10 m currency.
- **Copernicus LCFM is new:** so far only the 2020 Global Land Cover + 2020 pan-tropical Tree Cover Density are public; change/sub-annual layers come through 2026. First-release month differs by source (VITO cites June 2025; CLMS cites Oct 2025) — re-verify.
- **Cop4ALL-DE** nationwide release (planned end-2024/early-2025) — verify current availability.
- **Foundation models are pretrained at 10–30 m,** not 10 cm aerial — for swissIMAGE prefer aerial-native datasets (FLAIR/OpenEarthMap/ISPRS) or Clay/SatlasPretrain over satellite-only GFMs.
- **Licensing.** Several research datasets are access-on-request or restricted (e.g. WSL Tree Species Map, some EnviDat sets) — verify reuse terms before operational use.
- **Biotopinventar object counts** vary (~6,000–7,100) by counting convention and revision year — cite with the reference year.
- **Links** point to official landing/data pages current at compilation; deep paths on agency portals (swisstopo, BKG, BEV, Copernicus) occasionally change.