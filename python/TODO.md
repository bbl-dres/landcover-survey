# Python pipeline — TODO

Bring the Python CLI to parity with the web app's overlay data-quality handling.
The web app (`web/js/processor.js`) is the reference implementation. Goal: **web
and Python produce matching per-parcel results**, with every wall-to-wall layer
summing to the parcel area — the QS invariant **Σ AV land cover ≈ Σ BAFU habitat
≈ Σ Bauzonen ≈ parcel area**.

## Background

Both pipelines fetch the two overlay layers (BAFU habitat, ARE Bauzonen) from the
geo.admin.ch **Identify** API, which has two limits that bite:

- **Null geometry for oversized features.** geo.admin.ch returns `geometry: null`
  for features whose geometry exceeds a server-side size cap — e.g. the
  city-scale `9.3.2 Asphalt- und Betonstrasse` habitat polygon. Both pipelines
  silently drop null-geometry features (`swisstopo.py` `_fetch_and_parse`,
  ~line 204: `if geom_dict is None: continue`), so habitat under-counts and
  `Σ habitat < parcel area`.
- **200-feature cap + latency.** Max 200 features/request; the BAFU habitat layer
  is also slow (~0.3–1 s/parcel, multi-second spikes) — the main timeout risk.

The web app already works around these (per-parcel habitat gap-fill + an
"Ohne Bauzone" remainder). The Python pipeline does **not** yet.

## Tasks

### 1. BAFU habitat — prefer the STAC file download over Identify

`ch.bafu.lebensraumkarte-schweiz` is available via the file-based **STAC API**
(`https://data.geo.admin.ch/api/stac/v1/collections/ch.bafu.lebensraumkarte-schweiz`
→ HTTP 200, downloadable zip), which geo.admin.ch recommends for bulk use.
Downloading the layer and intersecting locally **solves three problems at once**:
no per-parcel latency/timeout, no 200-feature cap, and **full geometry** (no
null-geometry drop → no gap-fill needed). Python already reads parcels from a
local GeoPackage, so a local habitat layer fits the architecture.

- [ ] Confirm the STAC asset format (vector polygons vs. raster). If raster, use
      zonal statistics (rasterio/rasterstats) per parcel; if vector, intersect
      like the AV layer.
- [ ] Wire it as the habitat source (download/cache the tiles covering the
      parcels), replacing the `fetch_habitat_*` Identify calls.
- [ ] Result: habitat sums to the parcel area with no gap-fill.

Fallback if STAC is impractical: mirror the web gap-fill — capture the dropped
null-geometry features and attribute the parcel's uncovered area to the dropped
type. Wrinkle: Python fetches habitat **per municipality** (convex hull), so the
dropped-feature → parcel association is coarser than the web app's per-parcel
Identify.

### 2. Bauzonen — emit an "Ohne Bauzone" remainder

`ch.are.bauzonen` is **not** on STAC (404), but Identify is fast (~10 ms), so keep
it. Mirror `processor.js`: after clipping zones, emit an `Ohne Bauzone` detail row
= `parcel − covered` (exact area) with best-effort geometry (`parcel −
union(zones)`), so `Σ Bauzonen = parcel area`.

- [ ] Emit the `bauzonen_ohne_bauzone_m2` column / detail feature.
- [ ] Guard with a quality flag when a zone was dropped (null geometry) or the
      result was truncated (≥ 200) — don't let a missing zone pass as zone-free.

### 3. Quality-flag parity

- [ ] Add `check_habitat` / `check_bauzonen` statuses matching the web app
      (`ok` / `estimated` / `partial` / `truncated` / `error`).

### 4. Verify parity

- [ ] Spot-check that web and Python produce matching per-parcel areas and that
      each wall-to-wall layer sums to the parcel area. Worked example
      (CH813590469881): habitat and AV both 100 %; Bauzonen 95 % zones + 5 %
      Ohne Bauzone.

## Reference

- Web implementation: `web/js/processor.js` — `fetchIdentify` (dropped-feature
  handling), `makeHabitatRow` (habitat gap-fill), `ohneBauzoneGeometry` /
  `makeBauzoneRow` (Ohne Bauzone).
- Limitations summary: root `README.md` → *Known limitations*.
