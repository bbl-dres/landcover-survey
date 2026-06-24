"""Classify a small sample of Swiss parcels with AlphaEarth Foundations embeddings.

End-to-end Google Earth Engine workflow: sample the 64-dimensional AlphaEarth
satellite embeddings inside a few labeled parcels, train a Random Forest,
classify, and reduce a dominant land-cover class per parcel. Kept deliberately
small so it runs in seconds and prints its results.

Prerequisites:
    pip install earthengine-api
    earthengine authenticate          # one-time, opens a browser

Run:
    # Pass your Google Cloud project (Earth Engine is project-scoped):
    python classify_parcels.py --project my-ee-project

    # ...or set it once in the environment:
    export EARTHENGINE_PROJECT=my-ee-project   # PowerShell: $env:EARTHENGINE_PROJECT="my-ee-project"
    python classify_parcels.py

See README.md for background and tips.
"""

import argparse
import os
import sys

import ee

# Native resolution of the AlphaEarth embeddings (meters).
SCALE = 10
# All 64 embedding axes, A00 through A63. Keep them all (see README).
EMBEDDING_BANDS = [f"A{i:02d}" for i in range(64)]

# Tiny labeled sample. In production, load the official AV-Daten parcel
# geometries instead of these hand-drawn demo boxes (see README).
LABEL_NAMES = {1: "Cropland", 2: "Vineyard"}
SAMPLE_PARCELS = [
    # ~Bern arable land
    ([[7.435, 46.948], [7.445, 46.948], [7.445, 46.955], [7.435, 46.955]], 1),
    # ~Lavaux vineyards (Lake Geneva)
    ([[6.650, 46.520], [6.660, 46.520], [6.660, 46.530], [6.650, 46.530]], 2),
]


def initialize(project: str) -> None:
    """Initialize Earth Engine, authenticating on first run if needed."""
    try:
        ee.Initialize(project=project)
    except Exception:
        # Not authenticated yet (or token expired) — run the one-time flow.
        ee.Authenticate()
        ee.Initialize(project=project)


def build_parcels() -> ee.FeatureCollection:
    """Build the labeled sample FeatureCollection from SAMPLE_PARCELS."""
    features = [
        ee.Feature(ee.Geometry.Polygon([ring]), {"land_cover_class": label})
        for ring, label in SAMPLE_PARCELS
    ]
    return ee.FeatureCollection(features)


def classify(parcels: ee.FeatureCollection, year: int):
    """Train on the embeddings inside `parcels` and return per-parcel classes."""
    # Load the AlphaEarth annual embeddings for the target year and mosaic them.
    analysis_image = (
        ee.ImageCollection("GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL")
        .filterDate(f"{year}-01-01", f"{year}-12-31")
        .mosaic()
        .select(EMBEDDING_BANDS)
    )

    # Sample the 64-D vectors inside the labeled parcels to build training data.
    # One sample per 10 m pixel, so each parcel yields many training points.
    training_samples = analysis_image.sampleRegions(
        collection=parcels,
        properties=["land_cover_class"],
        scale=SCALE,
    )

    # Train a lightweight Random Forest on the embeddings.
    classifier = ee.Classifier.smileRandomForest(numberOfTrees=50).train(
        features=training_samples,
        classProperty="land_cover_class",
        inputProperties=EMBEDDING_BANDS,
    )

    # Classify, then reduce to the dominant (most frequent) class per parcel.
    classified = analysis_image.classify(classifier)
    parcel_classes = classified.reduceRegions(
        collection=parcels,
        reducer=ee.Reducer.mode(),
        scale=SCALE,
    )
    return training_samples, parcel_classes


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--project",
        default=os.environ.get("EARTHENGINE_PROJECT"),
        help="Google Cloud project registered for Earth Engine "
        "(or set EARTHENGINE_PROJECT).",
    )
    parser.add_argument("--year", type=int, default=2024, help="Embedding year.")
    args = parser.parse_args()

    if not args.project:
        parser.error(
            "no Earth Engine project given; pass --project or set "
            "EARTHENGINE_PROJECT (Earth Engine is project-scoped)."
        )

    initialize(args.project)
    parcels = build_parcels()
    training_samples, parcel_classes = classify(parcels, args.year)

    # Pull results back to the client so we can see that it worked.
    n_train = training_samples.size().getInfo()
    print(f"Trained on {n_train} pixel samples across {len(SAMPLE_PARCELS)} parcels.\n")

    print("Per-parcel dominant class:")
    for i, feature in enumerate(parcel_classes.getInfo()["features"]):
        props = feature["properties"]
        truth = props["land_cover_class"]
        predicted = props.get("mode")
        name = LABEL_NAMES.get(predicted, "?")
        print(
            f"  parcel {i}: predicted={predicted} ({name}), "
            f"label={truth} ({LABEL_NAMES.get(truth, '?')})"
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
