# FME

The original FME Form workspace (`Landcover Survey FME.fmw`) that the [web app](../web/) and [Python CLI](../python/) reproduce. It clips official land cover (Bodenbedeckung) to cadastral parcels and aggregates the area of each land cover type per parcel.

## Requirements

A licensed copy of [FME Form](https://fme.safe.com/fme-form/) (formerly FME Desktop / Workbench).

## Usage

Open `Landcover Survey FME.fmw` in FME Form, point the readers at your parcel list and the AV data source, and run. Outputs mirror the other solutions: a per-parcel table and a per-land-cover-clip table.

## Notes

- Land cover geometries are clipped raw and repaired afterwards (non-polygon artifacts and slivers < 0.001 m² are dropped) — the behavior the Python pipeline mirrors.
- Unmatched parcels are preserved via a left join, with an error message instead of area.

For the land cover classification, see [CLASSIFICATION](../docs/CLASSIFICATION.md); for inputs/outputs, [DATAMODEL](../docs/DATAMODEL.md); for the processing logic, [ARCHITECTURE](../docs/ARCHITECTURE.md). ([docs index](../docs/README.md))
