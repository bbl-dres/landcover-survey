"""Per-parcel pipeline — a faithful port of ``processRows`` in web/js/processor.js.

For each EGRID it reproduces the web app's exact steps, in EPSG:4326 with the Turf
area port (:mod:`geom_wgs84`):

1. resolve parcel geometry (:mod:`api`, duplicate EGRIDs unioned);
2. clip AV land cover, classify + aggregate (:mod:`classify_web`);
3. synthesize AV land cover from BAFU where AV cover < 5 % (``TYPOCH_BBART``);
4. overlay Bauzonen (+ "Ohne Bauzone" remainder) and BAFU habitat (+ gap-fill);
5. set the ``status`` / ``check_*`` / ``lc_source`` / ``lc_synthetic`` flags.

Output rows are plain dicts with the same keys (and same insertion order) the web
builds, incl. internal ``_``-prefixed keys (``_geometry`` etc.) that
:mod:`export_web` uses and strips. :func:`process_rows` returns
``{parcels, landcover, bauzonen, habitat}`` ready for export.
"""

from __future__ import annotations

import logging
import math
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

import api
import classify_web as C
import geom_wgs84 as geom
from config import (
    SLIVER_THRESHOLD,
    VBS_KATEGORIE_LABELS,
    VBS_PRODUKTIV_LABELS,
    VBS_TYP_LABELS,
)

logger = logging.getLogger(__name__)

# --- Tunables (mirror web/js/processor.js) ---
CONCURRENCY = 8
MIN_AV_COVER_FRAC = 0.05     # below this AV share, synthesize land cover from BAFU
OHNE_BAUZONE_MIN_AREA = 1    # m² — min zone-free remainder worth a row
HABITAT_GAP_MIN_FRAC = 0.01  # min parcel share a dropped habitat feature must cover to gap-fill

STATUS = {"FOUND": "found", "MERGED": "merged", "NOT_FOUND": "not_found", "INVALID": "invalid"}
ERR_MSG = {
    "invalidEgrid": "Invalid EGRID",
    "egridNotFound": "EGRID not found in AV",
    "wfsUnavailable": "Land cover unavailable (WFS)",
}
ERR_RUNTIME_PREFIX = "Error: "

# EGRID → parcel-geometry cache, shared across worker threads (value None = negative cache).
_egrid_cache: dict[str, dict | None] = {}
_cache_lock = threading.Lock()


def clear_cache() -> None:
    with _cache_lock:
        _egrid_cache.clear()


def _js_round(x: float) -> float:
    """JS ``Math.round`` — nearest int, ties toward +∞. Areas here are ≥ 0."""
    return math.floor(x + 0.5)


def round2(n: float) -> float:
    """Match the web's ``round2`` = ``Math.round(n*100)/100``."""
    return _js_round(n * 100) / 100


def is_found(code: str) -> bool:
    return code == STATUS["FOUND"] or code == STATUS["MERGED"]


# ---------------------------------------------------------------------------
# Parcel geometry cache
# ---------------------------------------------------------------------------

def _cached_parcel_geometry(egrid: str) -> dict | None:
    with _cache_lock:
        if egrid in _egrid_cache:
            return _egrid_cache[egrid]
    result = api.fetch_parcel_geometry(egrid)  # network; outside the lock
    with _cache_lock:
        _egrid_cache[egrid] = result
    return result


# ---------------------------------------------------------------------------
# Row builders
# ---------------------------------------------------------------------------

def _vbs_labels(cls: dict) -> dict:
    """Map classify() codes → the stable English output labels (blank Typ when None)."""
    return {
        "vbs_kategorie": VBS_KATEGORIE_LABELS.get(cls["vbsKategorie"], ""),
        "vbs_produktiv": VBS_PRODUKTIV_LABELS.get(cls["vbsProduktiv"], ""),
        "vbs_typ": VBS_TYP_LABELS.get(cls["vbsTyp"], "") if cls["vbsTyp"] else "",
    }


def _lc_row(id_, egrid, art, bfsnr, gwr_egid, fid, area, geometry, cls, *, lc_source="AV", prob="", typoch=None):
    """Build one land-cover detail row (AV clip or synthetic), matching clipLandCover."""
    vbs = _vbs_labels(cls)
    row = {
        "id": id_, "egrid": egrid, "fid": fid, "art": art,
    }
    if typoch is not None:
        row["typoch"] = typoch  # provenance of a synthetic row (GeoJSON only; not a CSV/XLSX header)
    row.update({
        "bfsnr": bfsnr, "gwr_egid": gwr_egid,
        "check_greenspace": cls["greenSpace"],
        "vbs_kategorie": vbs["vbs_kategorie"], "vbs_produktiv": vbs["vbs_produktiv"], "vbs_typ": vbs["vbs_typ"],
        "lc_source": lc_source, "prob": prob,
        "area_m2": round2(area),
        "_rawArea": area, "_geometry": geometry,
        "_sia416": cls["sia416"], "_din277": cls["din277"], "_sealed": cls["sealed"],
        "_vbsKategorie": cls["vbsKategorie"], "_vbsProduktiv": cls["vbsProduktiv"], "_vbsTyp": cls["vbsTyp"],
    })
    return row


def _make_bauzone_row(id_, egrid, name, code, fid, area, geometry):
    return {
        "id": id_, "egrid": egrid, "fid": fid,
        "art": name, "bauzone_code": code, "lc_source": "Bauzonen",
        "area_m2": round2(area), "_rawArea": area, "_geometry": geometry,
    }


def _make_habitat_row(id_, egrid, typoch, prob, fid, area, geometry):
    cls = C.classify_bafu(typoch)
    vbs = _vbs_labels(cls)
    return {
        "id": id_, "egrid": egrid, "fid": fid, "art": typoch,
        "bfsnr": "", "gwr_egid": "",
        "check_greenspace": cls["greenSpace"],
        "vbs_kategorie": vbs["vbs_kategorie"], "vbs_produktiv": vbs["vbs_produktiv"], "vbs_typ": vbs["vbs_typ"],
        "lc_source": "BAFU", "prob": prob,
        "area_m2": round2(area), "_rawArea": area, "_geometry": geometry,
        "_sia416": None, "_din277": None, "_sealed": None,
        "_vbsKategorie": cls["vbsKategorie"], "_vbsProduktiv": cls["vbsProduktiv"], "_vbsTyp": cls["vbsTyp"],
    }


def _make_error_parcel(id_, egrid, row, message):
    parcel = {
        "id": id_, "egrid": egrid, "nummer": "", "bfsnr": "",
        "status": "not_found", "check_egrid": message,
        "check_wfs": "", "check_geom": "", "errors": [_egrid_error_message(message)],
        "lc_source": "", "lc_synthetic": "", "flaeche": "", "parcel_area_m2": "",
        "_geometry": None, "_landcover": [], "_bauzonen": [], "_habitat": [],
    }
    for k, v in row.items():
        if k not in ("id", "egrid"):
            parcel[f"input_{k}"] = v
    return parcel


def _egrid_error_message(message):
    if message == STATUS["INVALID"]:
        return ERR_MSG["invalidEgrid"]
    if message == STATUS["NOT_FOUND"]:
        return ERR_MSG["egridNotFound"]
    if isinstance(message, str) and message.startswith("error:"):
        return ERR_RUNTIME_PREFIX + message[len("error:"):]
    return message


# ---------------------------------------------------------------------------
# Clipping
# ---------------------------------------------------------------------------

def _clip_features(parcel_geom, features, on_piece) -> int:
    """Clip each feature to the parcel; call ``on_piece(f, geometry, area)`` per piece
    above the sliver threshold. Returns the count of features whose clip failed
    (mirrors clipFeatures — Turf/GEOS has no make_valid here)."""
    skipped = 0
    for f in features:
        try:
            fg = f["geometry"]
            if fg is None:
                skipped += 1
                continue
            inter = geom.intersect(parcel_geom, fg)
            if inter is None:
                continue
            area = geom.area(inter)
            if area < SLIVER_THRESHOLD:
                continue
            on_piece(f, inter, area)
        except Exception as e:  # noqa: BLE001 — a failed clip is skipped + flagged, as in the web
            skipped += 1
            logger.debug("Clip error for feature %s: %s", f.get("id"), e)
    return skipped


def _clip_landcover(parcel_geom, lc_features, id_, egrid):
    results = []

    def on_piece(lc, geometry, area):
        props = lc["properties"]
        art = props.get("art") or props.get("Art") or props.get("ART") or ""
        fid = lc.get("id") or props.get("fid") or ""
        bfsnr = props.get("bfsnr") or props.get("BFSNr") or ""
        gwr = props.get("gwr_egid") or props.get("GWR_EGID") or ""
        results.append(_lc_row(id_, egrid, art, bfsnr, gwr, fid, area, geometry, C.classify(art)))

    skipped = _clip_features(parcel_geom, lc_features, on_piece)
    return {"results": results, "skipped": skipped}


def _clip_habitat(parcel_geom, bafu_features, id_, egrid):
    results = []

    def on_piece(lc, geometry, area):
        props = lc["properties"]
        results.append(_make_habitat_row(
            id_, egrid, props.get("typoch_de") or "", props.get("prob_de") or "",
            lc.get("id") or props.get("polyid") or "", area, geometry,
        ))

    skipped = _clip_features(parcel_geom, bafu_features, on_piece)
    return {"results": results, "skipped": skipped}


def _clip_bauzonen(parcel_geom, features, id_, egrid):
    results = []

    def on_piece(bz, geometry, area):
        props = bz["properties"]
        name = props.get("ch_bez_d") or props.get("bz_bezeichnung") or "?"
        code = props.get("ch_code_hn") or props.get("bz_nutzung") or ""
        fid = bz.get("id") or props.get("fid") or ""
        results.append(_make_bauzone_row(id_, egrid, name, code, fid, area, geometry))

    skipped = _clip_features(parcel_geom, features, on_piece)
    return {"results": results, "skipped": skipped}


def _ohne_bauzone_geometry(parcel_geom, zone_rows):
    """Best-effort zone-free remainder geometry: parcel − union(zones). None on failure."""
    if not zone_rows:
        return parcel_geom
    try:
        feats = [r["_geometry"] for r in zone_rows if r["_geometry"] is not None]
        u = feats[0] if len(feats) == 1 else geom.union(feats)
        diff = geom.difference(parcel_geom, u) if u is not None else None
        return diff
    except Exception:  # noqa: BLE001
        return None


def _make_synth_landcover_row(id_, egrid, art, typoch, area, geometry):
    return _lc_row(id_, egrid, art, "", "", "", area, geometry, C.classify(art),
                   lc_source="BAFU", prob="", typoch=typoch)


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------

def _aggregate_landcover(clipped):
    agg = {
        "sia416_ggf_m2": 0.0, "sia416_buf_m2": 0.0, "sia416_uuf_m2": 0.0,
        "din277_bf_m2": 0.0, "din277_uf_m2": 0.0,
        "sealed_m2": 0.0, "greenspace_m2": 0.0,
        "vbs_produktiv_m2": 0.0, "vbs_unproduktiv_m2": 0.0,
        "vbs_kat_a_m2": 0.0, "vbs_kat_b_m2": 0.0, "vbs_kat_c_m2": 0.0, "vbs_kat_d_m2": 0.0,
        "vbs_typ1_m2": 0.0, "vbs_typ2_m2": 0.0,
    }
    art_areas: dict[str, float] = {}

    for f in clipped:
        area = f["_rawArea"]

        if f["_sia416"] == "GGF":
            agg["sia416_ggf_m2"] += area
        elif f["_sia416"] == "BUF":
            agg["sia416_buf_m2"] += area
        else:
            agg["sia416_uuf_m2"] += area

        if f["_din277"] == "BF":
            agg["din277_bf_m2"] += area
        else:
            agg["din277_uf_m2"] += area

        if f["_sealed"]:
            agg["sealed_m2"] += area

        art_key = f"av_{str(f['art']).lower()}_m2"
        art_areas[art_key] = art_areas.get(art_key, 0.0) + area

        if f["check_greenspace"] != "Not green space":
            agg["greenspace_m2"] += area

        if f["_vbsProduktiv"] == "produktiv":
            agg["vbs_produktiv_m2"] += area
        else:
            agg["vbs_unproduktiv_m2"] += area

        kat = f["_vbsKategorie"] or "kat_d"
        if kat == "kat_a":
            agg["vbs_kat_a_m2"] += area
        elif kat == "kat_b":
            agg["vbs_kat_b_m2"] += area
        elif kat == "kat_c":
            agg["vbs_kat_c_m2"] += area
        else:
            agg["vbs_kat_d_m2"] += area

        if f["_vbsTyp"] == "typ1":
            agg["vbs_typ1_m2"] += area
        elif f["_vbsTyp"] == "typ2":
            agg["vbs_typ2_m2"] += area

    for k in agg:
        agg[k] = round2(agg[k])
    for k in art_areas:
        art_areas[k] = round2(art_areas[k])

    return {**agg, **art_areas}


def _aggregate_bauzonen(rows):
    by_zone: dict[str, float] = {}
    for r in rows:
        by_zone[r["art"]] = by_zone.get(r["art"], 0.0) + r.get("_rawArea", r["area_m2"])
    if not by_zone:
        return {"bauzonen": "", "bauzonen_m2": "", "zones": {}}
    ordered = sorted(by_zone.items(), key=lambda kv: kv[1], reverse=True)
    zones = {n: round2(a) for n, a in ordered}
    return {
        "bauzonen": "; ".join(n for n, _ in ordered),
        "bauzonen_m2": "; ".join(f"{a:.1f}" for _, a in ordered),
        "zones": zones,
    }


def _aggregate_habitat(rows):
    by_typ: dict[str, float] = {}
    for r in rows:
        name = C.habitat_l1_label(r["art"])
        by_typ[name] = by_typ.get(name, 0.0) + r.get("_rawArea", r["area_m2"])
    if not by_typ:
        return {"habitat": "", "habitat_m2": "", "types": {}}
    ordered = sorted(by_typ.items(), key=lambda kv: kv[1], reverse=True)
    types = {n: round2(a) for n, a in ordered}
    return {
        "habitat": "; ".join(n for n, _ in ordered),
        "habitat_m2": "; ".join(f"{a:.1f}" for _, a in ordered),
        "types": types,
    }


# ---------------------------------------------------------------------------
# Per-parcel pipeline (processOne)
# ---------------------------------------------------------------------------

def _process_one(row, options):
    id_ = row.get("id") or ""
    egrid = row.get("egrid") or ""

    if not egrid or not egrid.startswith("CH"):
        return {"parcel": _make_error_parcel(id_, egrid, row, STATUS["INVALID"]), "landcover": []}

    try:
        parcel_result = _cached_parcel_geometry(egrid)
        if not parcel_result:
            return {"parcel": _make_error_parcel(id_, egrid, row, STATUS["NOT_FOUND"]), "landcover": []}

        parcel_geom = parcel_result["geometry"]
        bbox = geom.bbox(parcel_geom)
        lc_result = api.fetch_landcover(bbox)
        parcel_area = geom.area(parcel_geom)

        clip = _clip_landcover(parcel_geom, lc_result["features"], id_, egrid)
        clipped = clip["results"]
        skipped = clip["skipped"]
        agg = _aggregate_landcover(clipped)
        lc_source, lc_synthetic = "AV", False

        # BAFU fetched at most once per parcel; shared by synth + habitat overlay.
        _bafu_holder: dict = {}

        def get_bafu():
            if "value" in _bafu_holder:
                return _bafu_holder["value"]
            try:
                fr = api.fetch_landcover_bafu(parcel_geom)
                _bafu_holder["value"] = {**fr, "clip": _clip_habitat(parcel_geom, fr["features"], id_, egrid)}
            except Exception as e:  # noqa: BLE001
                logger.warning("BAFU fetch failed for %s: %s", egrid, e)
                _bafu_holder["value"] = None
            return _bafu_holder["value"]

        # Step 3b — synthetic AV land cover where AV is essentially absent.
        av_classified = agg["sia416_ggf_m2"] + agg["sia416_buf_m2"] + agg["sia416_uuf_m2"]
        synth_enabled = options.get("synthLandcover", True) is not False
        if synth_enabled and parcel_area > 0 and av_classified < parcel_area * MIN_AV_COVER_FRAC:
            bafu = get_bafu()
            if bafu and bafu["clip"]["results"]:
                synth = []
                for piece in bafu["clip"]["results"]:
                    art = C.typoch_to_bbart(piece["art"])  # piece.art holds the TypoCH label
                    if art:
                        synth.append(_make_synth_landcover_row(id_, egrid, art, piece["art"], piece["_rawArea"], piece["_geometry"]))
                synth_area = sum(r["_rawArea"] for r in synth)
                if synth and synth_area > av_classified:  # only adopt if it fills more than sparse AV
                    clipped = synth
                    agg = _aggregate_landcover(clipped)
                    lc_source, lc_synthetic = "BAFU", True

        lc_errors = []
        if len(clipped) == 0 and lc_result["error"]:
            lc_errors.append(ERR_MSG["wfsUnavailable"])

        merged = parcel_result["properties"]["mergedCount"] > 1
        parcel = {
            "id": id_,
            "egrid": egrid,
            "nummer": parcel_result["properties"].get("number") or "",
            "bfsnr": parcel_result["properties"].get("bfsnr") or "",
            "status": "found",
            "check_egrid": STATUS["MERGED"] if merged else STATUS["FOUND"],
            "check_wfs": "wfs_error" if lc_result["error"] else ("truncated" if lc_result["truncated"] else "ok"),
            "check_geom": f"{skipped}_skipped" if skipped > 0 else "ok",
            "errors": lc_errors,
            "lc_source": lc_source,
            "lc_synthetic": "yes" if lc_synthetic else "",
            "flaeche": parcel_result["properties"].get("area") or "",
            "parcel_area_m2": round2(parcel_area),
        }
        parcel.update(agg)
        parcel["_geometry"] = parcel_geom
        parcel["_landcover"] = clipped

        for k, v in row.items():
            if k not in ("id", "egrid"):
                parcel[f"input_{k}"] = v

        bauzonen_rows = []
        habitat_rows = []

        if options.get("bauzonen") and parcel_geom is not None:
            try:
                bz = api.fetch_bauzonen(parcel_geom)
                bz_clip = _clip_bauzonen(parcel_geom, bz["features"], id_, egrid)
                bauzonen_rows = bz_clip["results"]
                covered = sum(r["_rawArea"] for r in bauzonen_rows)
                gap = parcel_area - covered
                if gap > OHNE_BAUZONE_MIN_AREA:
                    bauzonen_rows.append(_make_bauzone_row(
                        id_, egrid, "Ohne Bauzone", "", "", gap, _ohne_bauzone_geometry(parcel_geom, bauzonen_rows)))
                bz_agg = _aggregate_bauzonen(bauzonen_rows)
                parcel["bauzonen"] = bz_agg["bauzonen"]
                parcel["bauzonen_m2"] = bz_agg["bauzonen_m2"]
                parcel["check_bauzonen"] = (
                    "truncated" if bz["truncated"]
                    else "partial" if (len(bz["dropped"]) > 0 or bz_clip["skipped"] > 0)
                    else "ok"
                )
                for name, area in bz_agg["zones"].items():
                    parcel[C.bauzone_area_key(name)] = area
            except Exception as e:  # noqa: BLE001
                logger.warning("Bauzonen analysis failed for %s: %s", egrid, e)
                parcel["bauzonen"] = ""
                parcel["bauzonen_m2"] = ""
                parcel["check_bauzonen"] = "error"

        if options.get("habitat") and parcel_geom is not None:
            try:
                bafu = get_bafu()
                if not bafu:
                    raise RuntimeError("BAFU unavailable")
                hb_clip = bafu["clip"]
                habitat_rows = hb_clip["results"]
                covered = sum(r["_rawArea"] for r in habitat_rows)
                gap = parcel_area - covered
                significant_gap = gap > parcel_area * HABITAT_GAP_MIN_FRAC
                trustworthy = (not bafu["truncated"]) and hb_clip["skipped"] == 0
                gap_filled = False
                if trustworthy and len(bafu["dropped"]) == 1 and significant_gap:
                    typoch = (bafu["dropped"][0]["properties"] or {}).get("typoch_de") or ""
                    if typoch:
                        habitat_rows.append(_make_habitat_row(id_, egrid, typoch, "", bafu["dropped"][0]["id"], gap, None))
                        gap_filled = True
                hb_agg = _aggregate_habitat(habitat_rows)
                parcel["habitat"] = hb_agg["habitat"]
                parcel["habitat_m2"] = hb_agg["habitat_m2"]
                parcel["check_habitat"] = (
                    "error" if bafu["error"]
                    else "truncated" if bafu["truncated"]
                    else "estimated" if gap_filled
                    else "partial" if (len(bafu["dropped"]) > 0 and significant_gap)
                    else "ok"
                )
                for name, area in hb_agg["types"].items():
                    parcel[C.habitat_area_key(name)] = area
            except Exception as e:  # noqa: BLE001
                logger.warning("Habitat analysis failed for %s: %s", egrid, e)
                parcel["habitat"] = ""
                parcel["habitat_m2"] = ""
                parcel["check_habitat"] = "error"

        parcel["_bauzonen"] = bauzonen_rows
        parcel["_habitat"] = habitat_rows

        return {"parcel": parcel, "landcover": clipped, "bauzonen": bauzonen_rows, "habitat": habitat_rows}
    except Exception as e:  # noqa: BLE001
        logger.error("Error processing %s: %s", egrid, e)
        return {"parcel": _make_error_parcel(id_, egrid, row, f"error:{e}"), "landcover": []}


# ---------------------------------------------------------------------------
# Batch driver (processRows)
# ---------------------------------------------------------------------------

def process_rows(rows, options=None, on_progress=None):
    """Process rows (each ``{"id","egrid", ...}``) → ``{parcels, landcover, bauzonen, habitat}``.

    Mirrors ``processRows``: bounded-concurrency per-parcel processing, then a
    flatten pass that makes the per-zone / per-habitat columns rectangular
    (0-filled across every parcel) so exports have a uniform header.
    """
    options = options or {}
    total = len(rows)
    results: list[dict | None] = [None] * total
    completed = 0
    succeeded = 0

    if total:
        with ThreadPoolExecutor(max_workers=min(CONCURRENCY, total)) as pool:
            futures = {pool.submit(_process_one, rows[i], options): i for i in range(total)}
            for fut in as_completed(futures):
                i = futures[fut]
                r = fut.result()
                results[i] = r
                completed += 1
                if r and is_found(r["parcel"]["check_egrid"]):
                    succeeded += 1
                if on_progress:
                    on_progress({"processed": completed, "total": total,
                                 "succeeded": succeeded, "failed": completed - succeeded})

    # Collect every per-zone / per-habitat column seen, first-seen order preserved
    # (dict as an ordered set) so the 0-filled columns match the web's Set order.
    zone_keys: dict[str, None] = {}
    habitat_keys: dict[str, None] = {}
    if options.get("bauzonen"):
        for r in results:
            if r:
                for k in r["parcel"]:
                    if C.is_bauzone_area_key(k):
                        zone_keys.setdefault(k)
    if options.get("habitat"):
        for r in results:
            if r:
                for k in r["parcel"]:
                    if C.is_habitat_area_key(k):
                        habitat_keys.setdefault(k)

    parcels, landcover, bauzonen, habitat = [], [], [], []
    for r in results:
        if not r:
            continue
        p = r["parcel"]
        if options.get("bauzonen"):
            p.setdefault("bauzonen", "")
            p.setdefault("bauzonen_m2", "")
            p.setdefault("check_bauzonen", "")
            for k in zone_keys:
                p.setdefault(k, 0)
        if options.get("habitat"):
            p.setdefault("habitat", "")
            p.setdefault("habitat_m2", "")
            p.setdefault("check_habitat", "")
            for k in habitat_keys:
                p.setdefault(k, 0)
        parcels.append(p)
        landcover.extend(r.get("landcover") or [])
        bauzonen.extend(r.get("bauzonen") or [])
        habitat.extend(r.get("habitat") or [])

    return {"parcels": parcels, "landcover": landcover, "bauzonen": bauzonen, "habitat": habitat}
