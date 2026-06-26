# Measuring the Federal 30 % Near-Natural Green-Space Target on BBL Building Parcels

## Methods Review and Monitoring Architecture for the Swiss Confederation

*Working paper · BBL · June 2026 · Switzerland-first, EPSG:2056*

---

## Abstract

Measure M5, “Vorbildfunktion der öffentlichen Hand”, of the second phase of the Swiss Biodiversity Strategy Action Plan requires that, by 2030, at least 30 % of green areas owned by the Confederation or under its direct influence be managed near-naturally. BBL is one of the named federal property partners. For BBL, the practical question is not whether biodiversity should be promoted, but how the near-natural share of green area on building parcels can be measured credibly, repeatedly and with known uncertainty.

This paper reviews the operational definition problem, the remote-sensing and ecological methods available for detecting green-space management, and the Swiss and European datasets that can be used directly or with further development. The key finding is that “near-natural” is primarily a management property, not a land-cover class. A lawn cut twelve times per year, an extensive meadow cut twice per year and an abandoned grassland patch may look similar in single-date imagery, but they have different management and ecological meanings. Therefore, a defensible metric cannot rely on land cover alone.

For large grassland cores, reusable methods and data already exist. Mowing-event detection from Sentinel-2 and Landsat time series is mature enough for a first approximation, and the Switzerland-wide Weber et al. grassland-use-intensity dataset for 2018–2021 is the most directly reusable product. For small, fragmented urban lawns, verges and amenity green spaces—the parcel type likely to dominate an administrative building portfolio—there is no validated off-the-shelf dataset that detects near-natural management. This part must be built and validated.

The recommended architecture is a staged hybrid. It uses existing satellite mowing-event products for larger grassland cores, very-high-resolution orthophotos and LiDAR-derived height data for small parcels, and field or audit labels to validate what remote sensing cannot observe directly. The naturalness metric should remain configurable until federal implementation guidelines for M5 are fixed.

---

## 1. Introduction

### 1.1 Policy driver and measurement problem

The Confederation has committed itself to a public-sector role model function for biodiversity. Under Measure M5 of the Swiss Biodiversity Strategy Action Plan, by 2030 at least 30 % of green areas owned by the Confederation or under direct federal influence should be managed near-naturally. BBL is one of the federal property actors concerned by this measure.

For a building-portfolio owner, this creates a concrete monitoring problem. BBL must be able to identify the relevant green area, decide which parts are managed near-naturally, calculate the share per parcel or site, and repeat the measurement over time. The difficulty is that the relevant signal—low-intensity mowing, no fertiliser or biocides, native planting, habitat structure and ecological quality—is not directly visible in most existing geodata.

The task is therefore not a simple land-cover overlay. It is a measurement-design problem under definitional uncertainty.

### 1.2 Research questions

This paper addresses three questions:

**RQ1 — Definition.** What does “near-natural management” mean operationally for federal green areas, and which existing standard can be used as an interim anchor until federal implementation guidance is fixed?

**RQ2 — Method.** Which published methods can estimate green-space management intensity and near-naturalness, and which parts are reusable for BBL?

**RQ3 — Data.** Which datasets can be overlaid with BBL parcels directly, which supporting data are missing, and at what parcel size does each source remain useful?

### 1.3 Main contribution

The paper distinguishes three things that are often conflated:

1. **Green extent**: where vegetation or green open space exists.
2. **Management intensity**: how often and how intensively it is maintained.
3. **Near-natural quality**: whether the area supports biodiversity-oriented functions such as low-input management, native vegetation, structural diversity and habitat value.

This distinction is essential. Existing datasets can locate green areas reasonably well. Some satellite methods can estimate mowing events on larger grassland areas. But no ready dataset can reliably classify small urban amenity green spaces as near-natural or not near-natural without validation.

---

## 2. Operational interpretation of “near-natural”

### 2.1 “Naturnah bewirtschaftet” is a management concept

“Naturnah bewirtschaftet” should be interpreted as biodiversity-oriented management, not as abandonment. Typical elements include low mowing frequency, removal of cuttings where ecologically appropriate, no fertiliser or biocides on near-natural areas, herbicide avoidance, native or site-appropriate planting, structural diversity and habitat features.

This must be distinguished from “naturbelassen”. Many valuable open habitats in Switzerland and Central Europe depend on extensive management. A meadow that is cut once or twice per year may be ecologically valuable; a formerly managed grassland that is left unmanaged may gradually become species-poor, shrub-encroached or dominated by competitive species. Therefore, “few mowing events” is not automatically equivalent to “near-natural”.

### 2.2 Interim operational anchor

Until federal implementation guidance for M5 is fixed, BBL needs a defensible working definition. The most practical interim anchor is the Stiftung Natur & Wirtschaft “naturnahes Areal” standard, because it is designed for built and institutional sites rather than agricultural subsidy areas. It also aligns numerically with the 30 % target.

For BBL, this standard should be used as a reference framework, not as a legal definition. It is useful because it translates “near-natural” into auditable site criteria such as near-natural share, native planting, low-input management and biodiversity-oriented maintenance. Before formal publication, the exact certification criteria and current fee/validity details should be verified against the latest official Stiftung documents.

### 2.3 Why BFF is not enough

Agricultural Biodiversitätsförderflächen (BFF) are conceptually useful. They show how Swiss agricultural policy operationalises extensive use, low input and biodiversity quality. However, BFF datasets mainly cover direct-payment-relevant agricultural land. They do not provide a usable inventory of near-natural green spaces on urban or administrative building parcels.

BFF is therefore a typological reference and an agricultural context layer, not the main monitoring dataset for BBL.

### 2.4 Working classification for BBL

A pragmatic interim classification should use three levels:

| Class                                  | Meaning                                                                                     | Example evidence                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Confirmed near-natural**             | Meets agreed management and habitat criteria                                                | Field audit, maintenance records, certification, validated habitat features |
| **Probable near-natural**              | Remote-sensing and context evidence suggest low-intensity, structurally valuable vegetation | Low mowing count, structural diversity, suitable habitat context            |
| **Not confirmed / conventional green** | Green area exists, but near-natural management is not demonstrated                          | Amenity lawn, sports field, intensively cut verge, unclear management       |

This avoids overclaiming. Remote sensing can support classification, but it should not be treated as definitive for small parcels without validation.

---

## 3. Methods review

### 3.1 Mowing-event detection from optical satellite time series

A mowing event usually removes green biomass and produces an abrupt drop in vegetation indices such as NDVI or EVI, followed by regrowth. Time-series algorithms detect these drops and count mowing events per growing season. This gives a proxy for management intensity.

This method family is mature for larger grassland parcels. Schwieder et al. developed a transferable rule-based approach using Sentinel-2 and Landsat time series. Griffiths et al. demonstrated national-scale use-intensity mapping. Kolecka et al. applied Sentinel-2 mowing-frequency mapping in Canton Aargau and is a relevant Swiss precedent.

For BBL, the main strength is reusability. The main weakness is spatial support. At 10 m resolution, a single pixel represents 100 m², and a robust time-series signal needs several clean pixels. This creates a practical floor around larger, relatively homogeneous grassland cores. It is not reliable for small lawns fragmented by buildings, trees, paths, shadows and narrow verges.

### 3.2 Switzerland-wide grassland-use-intensity data

The most directly reusable dataset is the Switzerland-wide grassland-use-intensity product by Weber et al., covering annual grassland management events for 2018–2021. It is important because BBL does not need to develop a first large-parcel mowing-event product from scratch.

However, the dataset must be used with its validation limits. The reported signal is stronger for detected events than for missed events: when events are detected, they are often real, but actual events may be omitted. Grazing, high-elevation sites, cloudy periods and fragmented areas remain difficult. This means the dataset is useful for screening and first estimates, but not sufficient as a final compliance metric.

### 3.3 Sentinel-1 SAR and optical/SAR fusion

Sentinel-1 radar can observe through clouds and can supplement optical time series. SAR is useful where cloud gaps reduce Sentinel-2 usability. However, radar alone is generally a weaker mowing signal than optical vegetation-index change. Optical/SAR fusion can improve event timing and robustness but does not solve the core problem of near-natural versus abandoned vegetation.

### 3.4 Machine learning and fertilisation proxies

Machine-learning approaches can use time-series shape, spectral features, weather and parcel context to infer management intensity. Red-edge indices such as NDRE or CIred-edge may provide indirect signals related to biomass and nitrogen status. These features are relevant because near-natural management includes low input, not just low mowing frequency.

However, fertilisation cannot be inferred robustly without training data and validation. Red-edge information should be treated as an ancillary covariate, not as proof of fertiliser absence.

### 3.5 Very-high-resolution urban segmentation

Very-high-resolution aerial imagery, including SWISSIMAGE and SWISSIMAGE RS, can segment small lawns, shrubs, tree cover, paved surfaces and other parcel elements. Deep-learning methods such as U-Net, transformer models or segmentation foundation models can support green-space delineation below the Sentinel-2 pixel floor.

The limitation is fundamental: these methods map extent and structure, not management history. A well-segmented lawn polygon is not automatically near-natural. Small-parcel segmentation is therefore necessary, but not sufficient.

### 3.6 Height and structure from LiDAR

LiDAR-derived products such as swissSURFACE3D, swissSURFACE3D Raster and swissALTI3D are valuable for vegetation structure. Terrain-normalised height can help distinguish short mown vegetation, taller herbaceous vegetation, shrubs, hedges and woody encroachment.

This helps address one of the central open problems: extensive near-natural meadow and abandoned grassland may both show few mowing events, but they may differ in height, texture, shrub encroachment and structural pattern. Height data does not solve naturalness classification alone, but it is an important discriminator.

### 3.7 Habitat and biotope scoring

Habitat maps and biotope valuation schemes can provide ecological context. The Swiss Lebensraumkarte can support broad habitat interpretation, though it is weaker in settlement areas. German biotope valuation approaches, such as the BKompV point system, can serve as a conceptual scoring scaffold, but they should not be imported as a legal basis for Switzerland.

For BBL, a pragmatic approach is to map available evidence onto a configurable scoring model: mowing intensity, fertilisation proxy, structural diversity, habitat context, native planting and audit labels.

### 3.8 Summary of method maturity

| Method                          |                       Reusable now? | Best use                            | Main limitation                           |
| ------------------------------- | ----------------------------------: | ----------------------------------- | ----------------------------------------- |
| Rule-based mowing detection     |                                High | Larger grassland cores              | 10 m resolution, cloud gaps, mixed pixels |
| Switzerland-wide Weber dataset  |                                High | First screening for large parcels   | Historical years, recall/omission limits  |
| Sentinel-1 / optical-SAR fusion |                              Medium | Cloud-gap support                   | Weak standalone mowing signal             |
| ML use-intensity models         |                              Medium | Research/pilot extension            | Needs labelled training data              |
| Red-edge fertilisation proxies  |                          Low–medium | Ancillary signal                    | Indirect, not proof of no fertiliser      |
| VHR urban segmentation          | High for extent, low for management | Small-parcel green delineation      | Maps cover, not near-naturalness          |
| LiDAR height/structure          |                         Medium–high | Abandoned vs mown structure support | Not a management record                   |
| Field audits / certification    |                                High | Ground truth                        | Costly, sample-based                      |
| Maintenance records             |               Potentially very high | Direct management evidence          | Internal availability and quality unclear |

---

## 4. Data inventory

### 4.1 Data principle

The data inventory should not only list remote-sensing products. Because the target is about management, internal operational data and validation data are as important as external geodata.

A defensible monitoring system requires four data groups:

1. **Portfolio and perimeter data**: Which parcels and green areas are in scope?
2. **Green extent data**: Where is vegetation or green open space?
3. **Management and naturalness evidence**: How is the area maintained, and does it have near-natural quality?
4. **Validation data**: How will the model be checked against reality?

### 4.2 Revised ranked data table

| Priority | Dataset / source                                                    | Spatial / temporal support                                                         | Direct role                                                                     | Key caveat                                                                         |
| -------: | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
|        0 | **BBL parcel, ownership and control perimeter**                     | Internal vector data                                                               | Defines denominator and scope                                                   | Must distinguish ownership, lease, operational influence and building parcel logic |
|        0 | **Internal maintenance records and contracts**                      | Internal records, site-specific                                                    | Direct evidence of mowing frequency, fertiliser/biocide rules and Pflege regime | May be incomplete, unstructured or contractor-specific                             |
|        1 | **Weber et al. grassland-use-intensity maps**                       | 10 m, Switzerland, 2018–2021                                                       | Best reusable mowing-event source for large grassland cores                     | Historical period; omission/recall limits; weak for small parcels                  |
|        2 | **SWISSIMAGE**                                                      | 10 cm in lowlands and major Alpine valleys, 25 cm in Alps; 3-year cycle            | Visual backbone for small-parcel segmentation                                   | RGB only; not a management signal                                                  |
|        3 | **SWISSIMAGE RS**                                                   | Four bands: NIR, red, green, blue; 2005–2025                                       | Better vegetation segmentation and spectral training labels than RGB alone      | Archive product; source record and coverage details to verify per site             |
|        4 | **swissEO S2-SR**                                                   | Sentinel-2 surface reflectance; 10 m RGBN, 20 m red-edge/SWIR; current time series | Run current-year time series and parcel-level observation completeness          | Cloud dependence; mixed pixels below practical size threshold                      |
|        5 | **swissEO quality layers**                                          | Cloud probability, cloud/shadow and terrain-shadow masks                           | Required for defensible time-series completeness                                | Should be reported per parcel and growing season                                   |
|        6 | **swissSURFACE3D point cloud**                                      | Airborne LiDAR point cloud                                                         | Detailed 3D structure and object classes                                        | Not a regular raster; processing effort high                                       |
|        7 | **swissSURFACE3D Raster**                                           | 0.5 m DSM                                                                          | Surface height, vegetation/building structure                                   | No scheduled update; needs DTM for normalised height                               |
|        8 | **swissALTI3D**                                                     | 0.5 m or 2 m DTM; 6-year update cycle                                              | Terrain baseline for normalised height                                          | Terrain only; no vegetation                                                        |
|        9 | **AV Bodenbedeckung / official cadastral survey**                   | Vector, continuously maintained by cantons                                         | Candidate green-area extent and cadastral context                               | “Gartenanlage” and similar classes do not grade naturalness                        |
|       10 | **Lebensraumkarte Schweiz**                                         | Vector habitat context                                                             | Habitat/naturalness context                                                     | Weakest in settlements; exact version and metadata to verify                       |
|       11 | **LWB Nutzungsflächen / BFF QII**                                   | Agricultural vector layers                                                         | Exclude or contextualise farmland; conceptual comparison                        | Not a building-parcel inventory                                                    |
|       12 | **Copernicus HRL Grassland mowing products**                        | Pan-European, 10 m class                                                           | Cross-check mowing events/dates                                                 | Use only as secondary evidence; accuracy for mowing layers must be verified        |
|       13 | **Sentinel-1 SAR time series**                                      | Radar, all-weather                                                                 | Optional support where optical data are cloudy                                  | Weak standalone management signal                                                  |
|       14 | **PlanetScope or similar commercial imagery**                       | Approx. daily, metre-scale                                                         | Optional support for medium parcels and validation campaigns                    | Commercial cost and procurement overhead                                           |
|       15 | **Field audits / Stiftung Natur & Wirtschaft pilot certifications** | Site-level labels                                                                  | Ground truth for near-natural quality and accounting rules                      | Sample-based; requires protocol                                                    |
|       16 | **UAV or contractor site imagery**                                  | Very high resolution, campaign-based                                               | Validation and difficult parcels                                                | Operational overhead; not needed everywhere                                        |

### 4.3 Minimum parcel-size logic

The monitoring architecture should not pretend that all parcels can be measured with the same method.

| Parcel / green-core type                           | Recommended evidence                                | Expected reliability                                  |
| -------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------- |
| Large homogeneous grassland core, ≥0.25 ha         | Weber dataset, swissEO S2-SR, HRL cross-check       | Good for mowing frequency; limited for naturalness    |
| Medium parcel with several clean Sentinel-2 pixels | swissEO S2-SR, Sentinel-1 optional, SWISSIMAGE/RS   | Moderate; needs parcel-level observation completeness |
| Small urban lawn, verge or courtyard               | SWISSIMAGE/RS, AV, LiDAR height, field/audit labels | Good for extent; management must be validated         |
| Complex shaded site with trees/buildings           | VHR imagery, LiDAR, field visit                     | Remote sensing alone insufficient                     |
| Certified or audited site                          | Audit/certification plus geospatial area accounting | Highest confidence                                    |

### 4.4 Honest answer to RQ3

For large grassland, BBL can reuse existing data and methods. For small administrative building parcels, BBL can reuse high-resolution imagery and height products to delineate green area and structure, but not to prove near-natural management. The missing data are not only remote-sensing data; they are management records, validation labels and a portfolio-specific ground-truth protocol.

---

## 5. Proposed monitoring architecture

### 5.1 Metric design

The metric should remain configurable until M5 implementation guidance is fixed. The recommended interim formula is:

**Near-natural share = confirmed or probable near-natural green area / total in-scope green area**

The denominator should be the in-scope green area on BBL parcels or areas under BBL’s direct operational influence. The numerator should include only areas that meet the agreed criteria or have sufficient evidence.

The metric should store both classification and confidence:

| Output                      | Meaning                                              |
| --------------------------- | ---------------------------------------------------- |
| Area total green            | All in-scope green area                              |
| Area confirmed near-natural | Audit or maintenance evidence confirms criteria      |
| Area probable near-natural  | Remote-sensing/context model suggests criteria       |
| Area not near-natural       | Evidence indicates conventional/intensive management |
| Area unknown                | Green area exists but evidence insufficient          |
| Confidence class            | High / medium / low                                  |

This prevents false precision and allows transparent reporting.

### 5.2 Option 1 — Satellite-only screening

Overlay Weber et al. and, where useful, Copernicus HRL mowing layers on BBL parcels. Use detected mowing frequency to classify large grassland cores.

**Advantages:** fast, cheap, reusable, suitable for a first screening.

**Disadvantages:** does not cover small urban parcels; cannot distinguish near-natural from abandoned vegetation; does not prove no fertiliser or biocides; limited to available years and clean pixels.

**Assessment:** useful as a first layer, insufficient as a compliance architecture.

### 5.3 Option 2 — Staged hybrid architecture

Use a parcel-size-based workflow:

1. Define BBL scope and green-area denominator from internal parcel/perimeter data, AV Bodenbedeckung and VHR segmentation.
2. For larger grassland cores, use Weber and swissEO S2-SR time series to estimate mowing frequency.
3. For smaller sites, use SWISSIMAGE, SWISSIMAGE RS and LiDAR-derived height metrics to segment green area and assess structure.
4. Add internal maintenance records wherever available.
5. Use field audits and selected Stiftung Natur & Wirtschaft certifications to create validation labels.
6. Produce a portfolio-wide result with confidence classes and an “unknown” category.

**Advantages:** covers the full portfolio, reuses existing data, makes uncertainty explicit, and can adapt to future federal guidelines.

**Disadvantages:** requires development and validation; small-parcel classification remains a model-assisted estimate unless supported by management records or field labels.

**Assessment:** recommended.

### 5.4 Option 3 — Full hybrid with recurring UAV/commercial imagery

Add routine UAV multispectral imagery or commercial high-cadence imagery for representative or high-priority sites. This can improve detection of mowing events, vegetation structure and stress on parcels too small for Sentinel-2.

**Advantages:** highest technical capability; useful for difficult or high-value sites.

**Disadvantages:** recurring operational cost, procurement effort, data protection/flight constraints and higher processing burden.

**Assessment:** use selectively after the staged hybrid pilot identifies where standard data are insufficient.

---

## 6. Validation plan

### 6.1 Pilot sample

Run a pilot on approximately 20–30 representative BBL parcels. The sample should be stratified by:

* parcel size;
* green-core size;
* urban / peri-urban / rural context;
* elevation and climate region;
* shadow/tree complexity;
* known conventional versus known biodiversity-oriented maintenance;
* availability of maintenance records.

### 6.2 Ground truth

Use three kinds of reference data:

1. **Field audit labels** using a simple BBL near-natural checklist.
2. **Maintenance records** documenting mowing frequency, fertiliser/biocide rules and contractor obligations.
3. **External calibration** through 2–3 pilot certifications or audits based on Stiftung Natur & Wirtschaft criteria.

### 6.3 Performance metrics

Report performance separately for:

* green-area extent;
* mowing-frequency class;
* near-natural / not-near-natural classification;
* parcel-size class;
* confidence class.

Do not report only one overall accuracy number. Precision and recall should be reported separately. A method that rarely overclaims near-natural area but misses many real near-natural areas has a different management implication from a method that overclaims compliance.

### 6.4 Validation questions

The pilot should answer:

* At what green-core size does Sentinel-2 become useful for BBL parcels?
* How often does mowing-frequency evidence conflict with maintenance records?
* Can LiDAR height and VHR texture distinguish abandoned from extensively managed vegetation?
* How much of the portfolio remains “unknown” without field or maintenance data?
* What minimum evidence should be required for official reporting?

---

## 7. Limitations and open problems

### 7.1 Mowing count is not naturalness

Low mowing frequency is important but not sufficient. A near-natural meadow and abandoned grassland can both show few mowing events. A defensible metric must combine mowing evidence with management records, structural indicators, habitat context and field validation.

### 7.2 Small urban parcels remain unsolved

Remote sensing can delineate small green areas, but it cannot reliably infer management practice or ecological quality on small fragmented urban parcels without labelled examples. BBL should treat this as a development and validation task, not as a simple reuse of an existing product.

### 7.3 Data products have different semantics

Several products must not be merged casually:

* swissEO S2-SR is an analysis-ready reflectance product.
* swissEO VHI is a relative vegetation-health/stress index.
* swissSURFACE3D is a LiDAR point cloud.
* swissSURFACE3D Raster is a digital surface model.
* swissALTI3D is a digital terrain model.
* AV Bodenbedeckung is a cadastral land-cover/ground-cover source, not a naturalness assessment.

The monitoring design must preserve these distinctions.

### 7.4 Definition uncertainty remains

M5 establishes the political target, but the operational measurement rules for BBL are not yet fixed. The architecture should therefore store input evidence and thresholds separately, so that the metric can be recalculated when federal guidelines are finalised.

### 7.5 Formal citation cleanup is still required

Before external publication, all dataset rows and bibliography entries should be tied to exact source records: DOI, official metadata page, product version, licence and access path. Rows marked as “verify source record” should not be treated as citation-ready.

---

## 8. Recommended next steps

1. **Define the denominator.** Establish the authoritative BBL parcel and green-area perimeter, including ownership and direct-influence rules.
2. **Build a small evidence model.** Store green extent, mowing evidence, structure, habitat context, management records and confidence separately.
3. **Run the satellite screen.** Apply Weber and swissEO S2-SR to large grassland cores.
4. **Prototype small-parcel segmentation.** Use SWISSIMAGE, SWISSIMAGE RS and LiDAR products.
5. **Collect validation labels.** Field-audit 20–30 sites and pilot 2–3 external certifications.
6. **Report with confidence.** Publish confirmed, probable, not confirmed and unknown near-natural area separately.
7. **Keep the metric configurable.** Recalculate when M5 implementation guidance becomes binding.

---

## 9. Conclusion

BBL can begin measuring now, but it should avoid claiming more certainty than the data support. For large grassland cores, reusable Swiss mowing-event data and established satellite methods provide a credible first approximation. For small building parcels and urban green spaces, no ready dataset can prove near-natural management. That tier requires a hybrid of VHR imagery, LiDAR-derived structure, maintenance records and field validation.

The central recommendation is therefore a staged hybrid architecture. It reuses existing national and European geodata where they are fit for purpose, adds internal management evidence where remote sensing is blind, and preserves uncertainty through confidence classes. This gives BBL a defensible path toward the 2030 target while remaining adaptable to forthcoming federal implementation guidance.

---

## References and source records to verify before formal publication

BAFU. 2024. *Aktionsplan Strategie Biodiversität Schweiz. Phase 2 / 2025–2030.* Bern.

Stiftung Natur & Wirtschaft. Current certification criteria for “naturnahes Areal”. Verify latest official criteria document before formal citation.

Weber, D., Schwieder, M., et al. 2024. Grassland-use intensity maps for Switzerland based on satellite time series. *Remote Sensing in Ecology and Conservation.* DOI and EnviDat source record to verify.

Schwieder, M., et al. 2022. Mapping grassland mowing events across Germany based on combined Sentinel-2 and Landsat 8 time series. *Remote Sensing of Environment.*

Griffiths, P., et al. 2020. Towards national-scale characterization of grassland use intensity from integrated Sentinel-2 and Landsat time series. *Remote Sensing of Environment.*

Kolecka, N., et al. 2018. Regional-scale mapping of grassland mowing frequency with Sentinel-2 time series. *Remote Sensing.*

Reinermann, S., Asam, S. and Kuenzer, C. 2020. Remote sensing of grassland production and management: a review. *Remote Sensing.*

De Vroey, M., Radoux, J. and Defourny, P. 2021. Grassland mowing detection using Sentinel-1 time series. *Remote Sensing.*

swisstopo. Product documentation for SWISSIMAGE, SWISSIMAGE RS, swissEO S2-SR, swissEO VHI, swissSURFACE3D, swissSURFACE3D Raster and swissALTI3D.

Federal cadastral survey / cadastre.ch. Documentation for official cadastral survey data model DM.01-AV-CH and transition to DMAV.

Copernicus Land Monitoring Service. High Resolution Layer Grasslands, Grassland Mowing Events and Grassland Mowing Dates. Product records and validation statements to verify.

BLW / geo.admin.ch. Agricultural use areas and Biodiversitätsförderflächen layers. Exact layer metadata and yearly version to verify.

BAFU / WSL. Lebensraumkarte Schweiz. Exact metadata record, TypoCH class version and settlement-area limitations to verify.

BKompV. German Bundeskompensationsverordnung biotope valuation method. Use only as conceptual scoring reference, not as Swiss legal basis.

## Appendix A — Code availability and reusable implementations

A curated scan of public GitHub repositories was carried out to identify reusable code for the proposed monitoring architecture. The scan was not exhaustive and repository status should be rechecked before implementation or formal citation.

| Repository                                | Tier                                  | Role in proposed architecture                                                                                                                                                | Reuse assessment / caveat                                                                                                             |
| ----------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `davidfrantz/force-udf`                   | Mowing-detection core                 | Contains the `mowingDetection` user-defined function for dense Sentinel-2 / Landsat vegetation-index time series. Supports the Schwieder-style mowing-event detection logic. | Most relevant reusable mowing-detection code. It is a FORCE plug-in, not a standalone tool.                                           |
| `davidfrantz/force`                       | Mowing-detection engine               | Processing framework to build analysis-ready Sentinel-2 / Landsat time series and execute UDFs at scale.                                                                     | Best open-source route for extending the Weber / Schwieder-style approach to current years. Technically substantial stack.            |
| `Sen4CAP/Sen4CAP`                         | Agricultural monitoring platform      | ESA reference implementation for Sentinel-based agricultural monitoring, including grassland mowing-marker functionality.                                                    | Valuable operational reference, but heavy to deploy and not the default BBL implementation route.                                     |
| `Sen4CAP/sen4cap-client`                  | Agricultural monitoring client        | Python client for the Sen4CAP processing service.                                                                                                                            | Useful as a lightweight service-interface reference. Not a complete monitoring system.                                                |
| `lucas-batier/mowing-detection`           | Research prototype                    | Deep-learning detection of mowing and grazing from Sentinel imagery in the French Alps.                                                                                      | Relevant Alpine method sketch, but small and not production-maintained.                                                               |
| `aleksispi/pib-ml-grazing`                | Research prototype                    | Grazing detection from Sentinel-2 time series using deep learning.                                                                                                           | Useful because grazing is a known weak point of mowing-only detection. Not validated for Swiss administrative parcels.                |
| `opengeos/segment-geospatial`             | Very-high-resolution segmentation     | Geospatial wrapper for SAM / SAM2-style segmentation of raster imagery. Useful for delineating lawns, verges and small vegetation patches from SWISSIMAGE.                   | Strong candidate for small-parcel green-extent delineation. Does not classify management intensity or near-naturalness.               |
| `opengeos/geoai`                          | Geo-AI toolkit                        | Broader geospatial AI package for segmentation, classification and raster/vector workflows.                                                                                  | Useful support package for prototyping and QA. Requires project-specific model design.                                                |
| `opengeos/leafmap`                        | Mapping and QA                        | Interactive mapping and visual inspection of geospatial results.                                                                                                             | Useful for analyst review, field-audit preparation and QA, not a classifier.                                                          |
| `facebookresearch/segment-anything`       | Foundation segmentation model         | Upstream Segment Anything model for promptable image segmentation.                                                                                                           | Useful as model reference or dependency. Not geospatial or biodiversity-specific.                                                     |
| `facebookresearch/sam2`                   | Foundation segmentation model         | Newer SAM model family for images and video.                                                                                                                                 | Relevant upstream model, especially for future UAV or repeated-imagery workflows. Does not infer management.                          |
| `IDEA-Research/Grounded-Segment-Anything` | Promptable detection and segmentation | Combines text-prompted detection with SAM-style segmentation.                                                                                                                | Useful for annotation and segmentation support. Not a production geodata pipeline.                                                    |
| `sentinel-hub/eo-learn`                   | EO time-series framework              | Python framework for spatio-temporal Earth-observation machine learning.                                                                                                     | Useful for a lighter BBL-specific prototype on swissEO Sentinel-2 surface-reflectance data. Does not provide a ready mowing detector. |
| `sentinel-hub/field-delineation`          | EO model design reference             | Field-boundary delineation workflow using Sentinel-2 and deep learning.                                                                                                      | Archived design reference. Relevant for EO pipeline structure, not an active dependency.                                              |

The code landscape supports the main conclusion of this paper: large-parcel mowing-event detection can reuse existing open methods and software, while small-parcel near-naturalness cannot be solved by code reuse alone. Public tools can delineate green extent, process time series and support visual quality assurance, but the “naturnah” decision still requires BBL-specific evidence: maintenance records, field labels, LiDAR-derived structure, habitat context and validation against an agreed operational standard.
