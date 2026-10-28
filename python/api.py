"""Live-service clients — the exact requests the web app fires (web/js/geoapi.js).

Three anonymous, read-only geo.admin.ch / geodienste.ch endpoints, all in
**EPSG:4326** so the geometry matches the web byte-for-byte:

- :func:`fetch_parcel_geometry` — geo.admin.ch ``find`` (parcel by EGRID, duplicates
  unioned);
- :func:`fetch_landcover` — geodienste.ch WFS ``ms:LCSF``, paged via ``STARTINDEX``
  until an **empty** page (the only reliable end signal) and deduplicated;
- :func:`fetch_identify` — geo.admin.ch ``identify``, bbox **quadtree** so that every
  request is a single page (``offset`` paging is lossy on this endpoint); keeps the
  null-geometry "dropped" features the server omits above a size cap.

These are pure fetch functions returning shapely geometries; caching and the
per-parcel pipeline live in :mod:`processor_web`. Requests, params, page sizes,
tiling, dedupe and sort order mirror the web constants so results cross-check.
"""

from __future__ import annotations

import json
import logging
import math
import urllib.error
import urllib.parse
import urllib.request

import geom_wgs84 as geom

logger = logging.getLogger(__name__)

# --- Endpoints (config.js API) ---
PARCEL_FIND = "https://api3.geo.admin.ch/rest/services/all/MapServer/find"
IDENTIFY = "https://api3.geo.admin.ch/rest/services/all/MapServer/identify"
# Fixed to the German (deu) WFS endpoint: the ms:LCSF `Art` values are the German
# BBArt enumeration codes the classifier keys on (Gebaeude, Strasse_Weg, …). The
# web app pins this endpoint too (web/js/config.js API.WFS_AV).
WFS_AV = "https://geodienste.ch/db/av_0/deu"

# --- Tunables (mirror web/js/geoapi.js) ---
WFS_PAGE = 1000
WFS_MAX_FEATURES = 10000
IDENTIFY_PAGE = 200              # geo.admin.ch documented hard max per request
IDENTIFY_MAX_DEPTH = 8           # quadtree depth cap (never reached in practice)
BAFU_LAYER_ID = "ch.bafu.lebensraumkarte-schweiz"
BAUZONEN_LAYER_ID = "ch.are.bauzonen"
BAFU_MAX_FEATURES = 5000
BAUZONEN_MAX_FEATURES = 2000
# Green inventory (Grünflächeninventar der Bundesgärtnerei): the public parcel list the
# optional --green-inventory join reads (web/js/config.js GREEN_INVENTORY.PARCELS_URL).
GREEN_INVENTORY_URL = "https://bbl-dres.github.io/green-inventory/prototype-main/data/land_parcels.geojson"

FETCH_TIMEOUT_S = 15
MAX_RETRIES = 3
BASE_DELAY_MS = 500
USER_AGENT = "landcover-survey/1.0"


# ---------------------------------------------------------------------------
# HTTP with timeout + exponential backoff (port of fetchWithRetry)
# ---------------------------------------------------------------------------

def _sleep_ms(ms: float) -> None:
    import time
    time.sleep(ms / 1000.0)


def _fetch_json(url: str) -> dict:
    """GET *url* and parse JSON, retrying on 429/5xx and network/timeout errors.

    Retries up to ``MAX_RETRIES`` with exponential backoff (honouring
    ``Retry-After`` on 429/5xx, capped at 10 s). Non-retryable HTTP statuses
    (e.g. 4xx other than 429) raise immediately, matching the web.
    """
    last_err: Exception | None = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            last_err = e
            if (e.code == 429 or e.code >= 500) and attempt < MAX_RETRIES:
                retry_after = e.headers.get("Retry-After") if e.headers else None
                if retry_after and str(retry_after).strip().isdigit():
                    delay_ms = min(int(retry_after) * 1000, 10000)
                else:
                    delay_ms = BASE_DELAY_MS * (2 ** attempt)
                _sleep_ms(delay_ms)
                continue
            raise
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as e:
            last_err = e
            if attempt < MAX_RETRIES:
                _sleep_ms(BASE_DELAY_MS * (2 ** attempt))
                continue
    raise last_err  # type: ignore[misc]


def _norm_feature(f: dict) -> dict:
    """GeoJSON feature → ``{geometry: shapely|None, properties: dict, id}``.

    A geometry that cannot be parsed becomes ``None``: the clip then counts the
    feature as skipped (``check_geom``), exactly as the web does when Turf throws on
    it — one malformed surface must not turn the whole WFS result into an error.
    """
    g = f.get("geometry")
    shp = None
    if g:
        try:
            shp = geom.from_geojson(g)
        except Exception as e:  # noqa: BLE001 — malformed GeoJSON geometry
            logger.debug("Unparseable land-cover geometry %s: %s", f.get("id"), e)
    return {
        "geometry": shp,
        "properties": f.get("properties") or {},
        "id": f.get("id"),
    }


# ---------------------------------------------------------------------------
# Parcel geometry — geo.admin.ch find (fetchParcelGeometry)
# ---------------------------------------------------------------------------

def fetch_parcel_geometry(egrid: str) -> dict | None:
    """Resolve an EGRID to a parcel geometry. ``None`` when the EGRID isn't found.

    A single EGRID can map to several features (mutations, overlapping SDR /
    Baurecht); all matching geometries are unioned into one polygon (mirrors the
    Python GeoPackage "dissolve by EGRID"). Returns
    ``{geometry, properties: {egrid, number, nbident, area, mergedCount}}``.
    """
    params = urllib.parse.urlencode({
        "layer": "ch.kantone.cadastralwebmap-farbe",
        "searchText": egrid,
        "searchField": "egris_egrid",
        "returnGeometry": "true",
        "geometryFormat": "geojson",
        "sr": "4326",
    })
    data = _fetch_json(f"{PARCEL_FIND}?{params}")
    results = [r for r in (data.get("results") or []) if r.get("geometry")]
    if not results:
        return None

    geoms = [geom.from_geojson(r["geometry"]) for r in results]
    merged_count = len(results)
    parcel_geom = geoms[0]
    if len(geoms) > 1:
        try:
            u = geom.union(geoms)
            if u is not None:
                parcel_geom = u
        except Exception as e:  # noqa: BLE001 — mirror the web's "use first on failure"
            logger.warning("Union failed for %s (%d parts), using first: %s", egrid, len(geoms), e)

    props = results[0].get("properties") or results[0].get("attributes") or {}
    return {
        "geometry": parcel_geom,
        "properties": {
            "egrid": egrid,
            "number": props.get("number") or "",
            # The find service returns the cadastral numbering-area id (NBIdent, e.g.
            # "BE0200000042"), not the BFS municipality number — the parcel's bfsnr
            # is derived from its AV land cover in processor_web.
            "nbident": props.get("identnd") or "",
            "area": "",  # find doesn't return Flaechenmass → empty, as in the web
            "mergedCount": merged_count,
        },
    }


# ---------------------------------------------------------------------------
# Land cover — geodienste.ch WFS ms:LCSF (fetchLandCover)
# ---------------------------------------------------------------------------

def _landcover_key(f: dict) -> str:
    """Dedupe key of a raw WFS feature (the layer serves no ids): geometry + attributes."""
    return json.dumps([f.get("geometry"), f.get("properties")], sort_keys=True, separators=(",", ":"))


def fetch_landcover(bbox: list) -> dict:
    """Fetch AV land-cover surfaces in *bbox* = ``[minLon, minLat, maxLon, maxLat]``.

    Paged with ``STARTINDEX`` (1000/page) until an **empty** page, up to the 10'000
    safety cap. An empty page is the only reliable end signal: the server applies
    ``COUNT`` to its spatial-index candidates before the exact bbox test, so a
    non-final page routinely holds fewer than ``COUNT`` features (observed: 923 of
    1000 with five more pages behind it) and consecutive pages can overlap by a few
    features. Paging until empty and deduplicating by (geometry, properties)
    reproduces the server's own ``numberMatched`` exactly. Returns
    ``{features, error, truncated}`` so callers distinguish "no land cover" from
    "WFS failed".
    """
    min_lon, min_lat, max_lon, max_lat = bbox
    max_pages = max(1, math.ceil(WFS_MAX_FEATURES / WFS_PAGE))
    seen: set[str] = set()
    raw: list[dict] = []
    truncated = False
    try:
        for page in range(max_pages):
            params = urllib.parse.urlencode({
                "SERVICE": "WFS",
                "REQUEST": "GetFeature",
                "VERSION": "2.0.0",
                "TYPENAMES": "ms:LCSF",
                # urn CRS ⇒ lat,lon axis order for the BBOX filter (as in the web).
                "BBOX": f"{min_lat},{min_lon},{max_lat},{max_lon},urn:ogc:def:crs:EPSG::4326",
                "SRSNAME": "urn:ogc:def:crs:EPSG::4326",
                "OUTPUTFORMAT": "geojson",
                "COUNT": str(WFS_PAGE),
                "STARTINDEX": str(page * WFS_PAGE),
            })
            data = _fetch_json(f"{WFS_AV}?{params}")
            batch = data.get("features") or []
            if not batch:                  # drained
                break
            for f in batch:
                key = _landcover_key(f)
                if key in seen:
                    continue
                seen.add(key)
                raw.append(f)
            if page == max_pages - 1:      # still receiving features at the cap → more may remain
                truncated = True
        return {"features": [_norm_feature(f) for f in raw], "error": False, "truncated": truncated}
    except Exception as e:  # noqa: BLE001
        logger.warning("WFS fetch failed after retries: %s", e)
        return {"features": [], "error": True, "truncated": False}


# ---------------------------------------------------------------------------
# Overlays — geo.admin.ch identify (fetchIdentify)
# ---------------------------------------------------------------------------

def _identify_key(r: dict) -> str:
    """Dedupe/sort key of an identify result: its feature id as a string, else the
    serialized geometry + attributes (an id-less result can't be deduped by id)."""
    fid = r.get("featureId")
    if fid is None:
        fid = r.get("id")
    if fid is not None:
        return str(fid)
    return json.dumps([r.get("geometry"), r.get("properties") or r.get("attributes") or None],
                      sort_keys=True, separators=(",", ":"))


def fetch_identify(layer_id: str, parcel_geom, max_features: int) -> dict:
    """Fetch all *layer_id* features intersecting the parcel bbox via identify.

    The endpoint caps a request at 200 results, and paging past that with
    ``offset`` is **not** reliable: the server returns results in a client-dependent
    order, so consecutive pages overlap and omit features (observed: 475 of 556 from
    Node, 544 from Python, for the same bbox). Instead the bbox is tiled as a
    quadtree — a tile that returns a full page is split into four — so every request
    is a single page that is complete by construction. Results are deduplicated by
    feature id (a feature on a tile boundary is returned by both tiles) and sorted
    by id so the output is independent of tile order and server order. Null-geometry
    features (the server omits geometry above a size cap, e.g. city-scale roads) are
    kept aside in ``dropped``. Returns ``{features, dropped, total, truncated}``. May raise.
    """
    seen: set[str] = set()
    features: list[dict] = []
    dropped: list[dict] = []
    total = 0
    truncated = False
    stack: list[tuple[list, int]] = [(geom.bbox(parcel_geom), 0)]

    while stack:
        (min_lon, min_lat, max_lon, max_lat), depth = stack.pop()
        envelope = f"{min_lon},{min_lat},{max_lon},{max_lat}"
        params = urllib.parse.urlencode({
            "geometry": envelope,
            "geometryType": "esriGeometryEnvelope",
            "geometryFormat": "geojson",
            "layers": f"all:{layer_id}",
            "sr": "4326",
            "tolerance": "0",
            "mapExtent": envelope,
            "imageDisplay": "100,100,96",
            "returnGeometry": "true",
            "limit": str(IDENTIFY_PAGE),
            "offset": "0",
            "lang": "de",
        })
        data = _fetch_json(f"{IDENTIFY}?{params}")
        results = data.get("results") or []

        if len(results) >= IDENTIFY_PAGE:
            if depth < IDENTIFY_MAX_DEPTH:
                # Full page → the tile may hold more than one page: subdivide instead.
                mid_lon, mid_lat = (min_lon + max_lon) / 2, (min_lat + max_lat) / 2
                stack.append(([min_lon, min_lat, mid_lon, mid_lat], depth + 1))
                stack.append(([mid_lon, min_lat, max_lon, mid_lat], depth + 1))
                stack.append(([min_lon, mid_lat, mid_lon, max_lat], depth + 1))
                stack.append(([mid_lon, mid_lat, max_lon, max_lat], depth + 1))
                continue
            truncated = True  # depth cap reached while still full — keep this page's results

        for r in results:
            key = _identify_key(r)
            if key in seen:
                continue
            seen.add(key)
            total += 1
            fid = r.get("featureId")
            if fid is None:
                fid = r.get("id")
            props = r.get("properties") or r.get("attributes") or {}
            g = r.get("geometry")
            if g:
                features.append({"key": key, "geometry": geom.from_geojson(g), "properties": props, "id": fid})
            else:
                dropped.append({"key": key, "properties": props, "id": fid})
        if total >= max_features:
            truncated = True
            break

    features.sort(key=lambda f: f["key"])
    dropped.sort(key=lambda f: f["key"])
    return {"features": features, "dropped": dropped, "total": total, "truncated": truncated}


def fetch_landcover_bafu(parcel_geom) -> dict:
    """BAFU Lebensraumkarte features for a parcel — ``{features, dropped, error, truncated}``."""
    try:
        r = fetch_identify(BAFU_LAYER_ID, parcel_geom, BAFU_MAX_FEATURES)
        return {"features": r["features"], "dropped": r["dropped"], "error": False, "truncated": r["truncated"]}
    except Exception as e:  # noqa: BLE001
        logger.warning("BAFU identify failed after retries: %s", e)
        return {"features": [], "dropped": [], "error": True, "truncated": False}


def fetch_bauzonen(parcel_geom) -> dict:
    """Building-zone features for a parcel — ``{features, dropped, truncated}``. May raise."""
    r = fetch_identify(BAUZONEN_LAYER_ID, parcel_geom, BAUZONEN_MAX_FEATURES)
    return {"features": r["features"], "dropped": r["dropped"], "truncated": r["truncated"]}


# ---------------------------------------------------------------------------
# Green inventory — parcel list keyed by EGRID + ERP id (loadGreenInventory)
# ---------------------------------------------------------------------------

def fetch_green_inventory(source: str | None = None) -> dict:
    """Load the green inventory parcel list → ``{"by_egrid": {...}, "by_erp": {...}}``.

    *source* is a URL or a local GeoJSON path; ``None`` reads the public file
    (``GREEN_INVENTORY_URL``). Raises on network / parse errors; the callers degrade
    to an empty ``greeninv`` column.
    """
    src = source or GREEN_INVENTORY_URL
    if src.startswith(("http://", "https://")):
        fc = _fetch_json(src)
    else:
        with open(src, encoding="utf-8") as f:
            fc = json.load(f)
    by_egrid: dict[str, dict] = {}
    by_erp: dict[str, dict] = {}
    for feat in fc.get("features") or []:
        pr = feat.get("properties") or {}
        if pr.get("egrid"):
            by_egrid[str(pr["egrid"]).upper()] = pr
        if pr.get("erp_id"):
            by_erp[str(pr["erp_id"])] = pr
    logger.debug("Green inventory: %d parcels (%d with ERP id)", len(by_egrid), len(by_erp))
    return {"by_egrid": by_egrid, "by_erp": by_erp}


def green_inventory_flag(index: dict | None, id_: str, egrid: str) -> str:
    """``yes`` when the parcel is in the inventory (by EGRID, else by the SAP key = id),
    ``no`` otherwise, ``""`` without an index (join not run / list unreachable)."""
    if not index:
        return ""
    if egrid and str(egrid).upper() in index["by_egrid"]:
        return "yes"
    if id_ and str(id_) in index["by_erp"]:
        return "yes"
    return "no"
