"""Live-service clients — the exact requests the web app fires (web/js/processor.js).

Three anonymous, read-only geo.admin.ch / geodienste.ch endpoints, all in
**EPSG:4326** so the geometry matches the web byte-for-byte:

- :func:`fetch_parcel_geometry` — geo.admin.ch ``find`` (parcel by EGRID, duplicates
  unioned);
- :func:`fetch_landcover` — geodienste.ch WFS ``ms:LCSF`` (paged via ``STARTINDEX``);
- :func:`fetch_identify` — geo.admin.ch ``identify`` (paged via ``offset``, keeps the
  null-geometry "dropped" features the server omits above a size cap).

These are pure fetch functions returning shapely geometries; caching and the
per-parcel pipeline live in :mod:`processor_web`. Requests, params, page sizes, and
retry/backoff mirror the web constants so results cross-check.
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
# web app defaults to this endpoint too.
WFS_AV = "https://geodienste.ch/db/av_0/deu"

# --- Tunables (mirror web/js/processor.js) ---
WFS_PAGE = 1000
WFS_MAX_FEATURES = 10000
IDENTIFY_PAGE = 200              # geo.admin.ch documented hard max per request
BAFU_LAYER_ID = "ch.bafu.lebensraumkarte-schweiz"
BAUZONEN_LAYER_ID = "ch.are.bauzonen"
BAFU_MAX_FEATURES = 5000
BAUZONEN_MAX_FEATURES = 2000

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
    """GeoJSON feature → ``{geometry: shapely|None, properties: dict, id}``."""
    g = f.get("geometry")
    return {
        "geometry": geom.from_geojson(g) if g else None,
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
    ``{geometry, properties: {egrid, number, bfsnr, area, mergedCount}}``.
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
            # Mirrors the web verbatim: it reads `identnd` for the bfsnr field
            # (the find service doesn't return the true BFSNr), so we do too.
            "bfsnr": props.get("identnd") or "",
            "area": "",  # find doesn't return Flaechenmass → empty, as in the web
            "mergedCount": merged_count,
        },
    }


# ---------------------------------------------------------------------------
# Land cover — geodienste.ch WFS ms:LCSF (fetchLandCover)
# ---------------------------------------------------------------------------

def fetch_landcover(bbox: list) -> dict:
    """Fetch AV land-cover surfaces in *bbox* = ``[minLon, minLat, maxLon, maxLat]``.

    Paged with ``STARTINDEX`` (1000/page) up to the 10'000 safety cap. Returns
    ``{features, error, truncated}`` so callers distinguish "no land cover" from
    "WFS failed".
    """
    min_lon, min_lat, max_lon, max_lat = bbox
    max_pages = max(1, math.ceil(WFS_MAX_FEATURES / WFS_PAGE))
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
            raw.extend(batch)
            if len(batch) < WFS_PAGE:      # short page → bbox drained
                break
            if page == max_pages - 1:      # still full at the cap → more remain
                truncated = True
        return {"features": [_norm_feature(f) for f in raw], "error": False, "truncated": truncated}
    except Exception as e:  # noqa: BLE001
        logger.warning("WFS fetch failed after retries: %s", e)
        return {"features": [], "error": True, "truncated": False}


# ---------------------------------------------------------------------------
# Overlays — geo.admin.ch identify (fetchIdentify)
# ---------------------------------------------------------------------------

def fetch_identify(layer_id: str, parcel_geom, max_features: int) -> dict:
    """Fetch all *layer_id* features intersecting the parcel bbox via identify.

    Pages with ``offset`` past the 200-per-request cap until a short/empty page (or
    ``max_features``). Dedupes by ``featureId`` (multi-table layers return
    overlapping pages) and keeps null-geometry features aside in ``dropped`` — the
    server omits geometry for oversized features (e.g. city-scale roads), which
    callers account for. Returns ``{features, dropped, total, truncated}``. May raise.
    """
    min_lon, min_lat, max_lon, max_lat = geom.bbox(parcel_geom)
    envelope = f"{min_lon},{min_lat},{max_lon},{max_lat}"
    max_pages = max(1, math.ceil((max_features or IDENTIFY_PAGE) / IDENTIFY_PAGE))
    seen: set[str] = set()
    features: list[dict] = []
    dropped: list[dict] = []
    total = 0
    truncated = False

    for page in range(max_pages):
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
            "offset": str(page * IDENTIFY_PAGE),
            "lang": "de",
        })
        data = _fetch_json(f"{IDENTIFY}?{params}")
        results = data.get("results") or []
        fresh = 0
        for r in results:
            fid = r.get("featureId")
            if fid is None:
                fid = r.get("id")
            if str(fid) in seen:
                continue
            seen.add(str(fid))
            fresh += 1
            props = r.get("properties") or r.get("attributes") or {}
            g = r.get("geometry")
            if g:
                features.append({"geometry": geom.from_geojson(g), "properties": props, "id": fid})
            else:
                dropped.append({"properties": props, "id": fid})
        total += fresh
        if len(results) < IDENTIFY_PAGE or fresh == 0:  # bbox drained
            break
        if page == max_pages - 1:                       # still full at cap → more remain
            truncated = True

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
