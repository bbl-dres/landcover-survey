# AlphaEarth Parcel Classification

Classify Swiss cadastral parcels by land cover using **AlphaEarth Foundations**
satellite embeddings in Google Earth Engine — an alternative, machine-learning
approach to the geometry-based aggregation used elsewhere in this repo.

> [!NOTE]
> This is an **experimental / research** track. Unlike the [`web/`](../web/),
> [`python/`](../python/), and [`fme/`](../fme/) solutions — which compute exact
> per-parcel areas by clipping official AV land-cover polygons — this approach
> *predicts* a land-cover class per parcel from learned satellite features. The
> two are complementary: AV gives authoritative areas; AlphaEarth gives a
> data-driven classification that can fill gaps or cross-check the survey.

## What is AlphaEarth Foundations?

Developed by Google DeepMind, AlphaEarth acts as a "virtual satellite." Instead
of manually gathering raw Sentinel-2 optical imagery, masking clouds,
calculating vegetation indices over time, and pairing it with Sentinel-1 radar
backscatter, the model pre-digests petabytes of multi-modal Earth observations
into a ready-to-use **64-dimensional embedding vector** for every 10-meter pixel
on the planet.

The embeddings are exposed as annual composites in Google Earth Engine under the
collection ID `GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL`, with bands `A00`–`A63`.
Because they are normalized to unit length on a hypersphere (magnitude 1), they
can be fed directly into tree-based classifiers or clustering algorithms with no
extra feature scaling.

## Why this matters for Switzerland

Traditional optical remote sensing struggles in Switzerland for three alpine
reasons: **persistent cloud cover**, **deep valley shadows**, and **prolonged
winter snow**.

Because AlphaEarth assimilates Synthetic Aperture Radar (SAR), climate models,
and topographic context into its 64 embedding axes, the resulting vectors are
largely immune to terrain shadows and cloud gaps. A parcel in the cloudy Jura
valleys can be classified with the same feature stability as a sunny parcel in
the Rhône plain.

## Implementation workflow

The end-to-end Earth Engine workflow lives in
[`classify_parcels.py`](classify_parcels.py):

1. Initialize the Earth Engine API.
2. Define / load your Swiss parcels as a `FeatureCollection` (in production, from
   the official AV geometries — see tips below).
3. Load the AlphaEarth annual embeddings, filter to the target year, and select
   all 64 axes.
4. Sample the 64-D vectors inside labeled parcels to build training data.
5. Train a Random Forest classifier on the embeddings.
6. Classify the landscape.
7. Reduce per parcel (mode) to assign each parcel a dominant class.

## Expert tips for Swiss land cover

- **Leverage open swisstopo data.** Don't draw training polygons by hand.
  Import the official **AV-Daten (cadastral survey)** for exact parcel boundary
  geometries, and pair them with the **Bodenbedeckung (swisstopo Area
  Statistics)** to generate thousands of accurate, automated training labels.
  This is the same AV data the rest of this repo already consumes — see
  [`docs/DATAMODEL.md`](../docs/DATAMODEL.md).
- **Keep all 64 dimensions.** Never drop individual `A` bands to save memory.
  The axes do not map to standalone physical traits (like "greenness" or
  "moisture"); they are a single holistic coordinate in DeepMind's latent space.
  Dropping `A42` is the mathematical equivalent of deleting the Z-coordinate
  from a 3D topographic map.
- **Try unsupervised clustering first.** Without labeled ground truth, run
  `ee.Clusterer.wekaKMeans()` directly on the image. AlphaEarth naturally groups
  structurally and phenologically similar pixels, so it cleanly separates alpine
  pastures, orchards, vineyards, and arable crop rotations without a single
  label.

## Prerequisites

- A Google Earth Engine account ([sign up](https://earthengine.google.com/)).
- The `earthengine-api` Python package: `pip install earthengine-api`.
- Authenticate once with `earthengine authenticate`.

## Relationship to the rest of this repo

| | This folder (AlphaEarth) | `web/` · `python/` · `fme/` |
|---|---|---|
| Method | ML classification of learned embeddings | Geometric clipping of AV polygons |
| Output | Predicted dominant class per parcel | Exact m² per land-cover type |
| Authority | Modeled / predicted | Official survey (AV) |
| Coverage | Wherever embeddings exist (global) | Cantonal AV coverage |
| Best for | Gap-filling, cross-checks, classes AV lacks | Authoritative legal/areal reporting |
