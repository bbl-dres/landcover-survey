"""Per-parcel pipeline — a faithful port of ``processRows`` in processing-web/js/processor.js.

For each EGRID it reproduces the web app's exact steps, in EPSG:4326 with the Turf
area port (:mod:`geom_wgs84`); the live requests live in :mod:`api` (the port of
processing-web/js/geoapi.js):

1. resolve parcel geometry (:mod:`api`, duplicate EGRIDs unioned);
2. clip AV land cover, classify + aggregate (:mod:`classify_web`);
3. synthesize AV land cover from BAFU where AV cover < 5 % (``TYPOCH_BBART``);
4. overlay Bauzonen (+ "Ohne Bauzone" remainder) and BAFU habitat (+ gap-fill);
5. set the ``status`` / ``check_*`` / ``lc_source`` / ``lc_synthetic`` flags.

A value whose query failed is left **empty**, never 0: an empty cell means "not
known", a 0 means "asked, nothing there". Parcels with a failed query are asked
again at the end of the run (:data:`RETRY_ROUNDS`).

Function names follow processor.js (``processOne`` ⇄ ``_process_one``,
``makeLandcoverRow`` ⇄ ``_make_landcover_row``, ``aggregateLandCover`` ⇄
``_aggregate_landcover`` …) — see docs/ARCHITECTURE.md §Web ⇄ CLI name map.

Output rows are plain dicts with the same keys (and same insertion order) the web
builds, incl. internal ``_``-prefixed keys (``_geometry`` etc.) that
:mod:`export_web` uses and strips. :func:`process_rows` returns
``{parcels, landcover, bauzonen, habitat}`` ready for export.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import api
import classify_web as C
import geom_wgs84 as geom
from config import (
    SIA416,
    SLIVER_THRESHOLD,
    VBS_KATEGORIE_LABELS,
    VBS_PRODUKTIV_LABELS,
    VBS_TYP_LABELS,
    to_fixed_1,
)

logger = logging.getLogger(__name__)

# --- Tunables (mirror processing-web/js/processor.js) ---
CONCURRENCY = 8
MIN_AV_COVER_FRAC = 0.05     # below this AV share, synthesize land cover from BAFU
OHNE_BAUZONE_MIN_AREA = 1    # m² — min zone-free remainder worth a row
HABITAT_GAP_MIN_FRAC = 0.01  # min parcel share a dropped habitat feature must cover to gap-fill

# The services answer 502 in bursts that outlast the per-request retries, so parcels
# with a failed query are processed again after the first pass (as in processor.js).
RETRY_ROUNDS = 2
RETRY_PAUSE_S = 20
# CLI only: a row the run did not reach before Ctrl-C (the web drops such rows).
NOT_PROCESSED = "error:Not processed (run interrupted)"

# The fixed aggregation columns of a parcel, in output order (aggregateLandCover).
LANDCOVER_AGG_KEYS = (
    "sia416_ggf_m2", "sia416_buf_m2", "sia416_uuf_m2",
    "din277_bf_m2", "din277_uf_m2",
    "sealed_m2", "greenspace_m2",
    "av_produktiv_m2", "av_unproduktiv_m2",
    "av_kat_a_m2", "av_kat_b_m2", "av_kat_c_m2", "av_kat_d_m2",
    "av_typ1_m2", "av_typ2_m2",
)

STATUS = {"FOUND": "found", "MERGED": "merged", "NOT_FOUND": "not_found", "INVALID": "invalid"}
ERR_MSG = {
    "invalidEgrid": "Invalid EGRID",
    "egridNotFound": "EGRID not found in AV",
    "wfsUnavailable": "Land cover unavailable (WFS)",
}
ERR_RUNTIME_PREFIX = "Error: "

def _js_round(x: float) -> float:
    """JS ``Math.round`` — nearest int, ties toward +∞. Areas here are ≥ 0."""
    return math.floor(x + 0.5)


def round2(n: float) -> float:
    """Match the web's ``round2`` = ``Math.round(n*100)/100``."""
    return _js_round(n * 100) / 100


def is_found(code: str) -> bool:
    return code == STATUS["FOUND"] or code == STATUS["MERGED"]


# ---------------------------------------------------------------------------
# Row builders
# ---------------------------------------------------------------------------

def _vbs_labels(cls: dict) -> dict:
    """Map classify() codes → the stable English output labels (blank Typ when None)."""
    return {
        "av_kategorie": VBS_KATEGORIE_LABELS.get(cls["vbsKategorie"], ""),
        "av_produktiv": VBS_PRODUKTIV_LABELS.get(cls["vbsProduktiv"], ""),
        "av_typ": VBS_TYP_LABELS.get(cls["vbsTyp"], "") if cls["vbsTyp"] else "",
    }


# BBArt values outside the known domain are classified with the fallbacks (UUF / UF /
# not green / kat_d / unproduktiv) — warned once per value per run, as in the web, so a
# data-model change (e.g. the DMAV migration) is noticed rather than silently absorbed.
_warned_arts: set[str] = set()
_warn_lock = threading.Lock()


def _warn_unknown_art(art) -> None:
    if art in SIA416:
        return
    with _warn_lock:
        if art in _warned_arts:
            return
        _warned_arts.add(art)
    logger.warning('Unknown land-cover Art "%s" — classified with the fallback categories', art)


def _dominant_bfsnr(rows):
    """BFS municipality number of a parcel from its AV land-cover pieces: the ``bfsnr``
    value whose pieces cover the largest area (ties → the smaller value), keeping the
    value as served (int or str). ``""`` when no piece carries one. Mirror of
    the web's dominantBfsnr()."""
    area: dict[str, float] = {}
    value: dict[str, object] = {}
    for r in rows:
        key = str(r.get("bfsnr") if r.get("bfsnr") is not None else "").strip()
        if not key:
            continue
        if key not in area:
            value[key] = r["bfsnr"]
        area[key] = area.get(key, 0.0) + r["_rawArea"]
    best, best_area = "", -1.0
    for key, a in area.items():
        if a > best_area or (a == best_area and key < best):
            best, best_area = key, a
    return value[best] if best else ""


def _make_landcover_row(id_, egrid, art, area, geometry, *, fid="", bfsnr="", gwr_egid="",
                        lc_source="AV", prob="", typoch=None):
    """Build one land-cover detail row — an AV clip (``lc_source`` "AV") or a synthetic
    piece derived from BAFU (``lc_source`` "BAFU", ``typoch`` keeps the source habitat
    label). Mirror of makeLandcoverRow; the keyword arguments are its options object."""
    _warn_unknown_art(art)
    cls = C.classify(art)
    vbs = _vbs_labels(cls)
    row = {
        "id": id_, "egrid": egrid, "fid": fid, "art": art,
    }
    if typoch is not None:
        row["typoch"] = typoch  # provenance of a synthetic row (GeoJSON only; not a CSV/XLSX header)
    row.update({
        "bfsnr": bfsnr, "gwr_egid": gwr_egid,
        "check_greenspace": cls["greenSpace"],
        "av_kategorie": vbs["av_kategorie"], "av_produktiv": vbs["av_produktiv"], "av_typ": vbs["av_typ"],
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
        # Full TypoCH hierarchy split into its three levels ("<code> <name>"); typoch_l3
        # is "" where the layer only resolved to level-2. Names via data/typoch.json.
        "typoch_l1": C.typoch_l1_label(typoch),
        "typoch_l2": C.typoch_l2_label(typoch),
        "typoch_l3": C.typoch_l3_label(typoch),
        "bfsnr": "", "gwr_egid": "",
        "check_greenspace": cls["greenSpace"],
        "av_kategorie": vbs["av_kategorie"], "av_produktiv": vbs["av_produktiv"], "av_typ": vbs["av_typ"],
        "lc_source": "BAFU", "prob": prob,
        "area_m2": round2(area), "_rawArea": area, "_geometry": geometry,
        "_sia416": None, "_din277": None, "_sealed": None,
        "_vbsKategorie": cls["vbsKategorie"], "_vbsProduktiv": cls["vbsProduktiv"], "_vbsTyp": cls["vbsTyp"],
    }


def _make_error_parcel(id_, egrid, row, message):
    parcel = {
        "id": id_, "egrid": egrid, "nummer": "", "bfsnr": "", "nbident": "",
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
        results.append(_make_landcover_row(id_, egrid, art, area, geometry, fid=fid, bfsnr=bfsnr, gwr_egid=gwr))

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
    return _make_landcover_row(id_, egrid, art, area, geometry, lc_source="BAFU", typoch=typoch)


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------

def _empty_landcover_aggregate() -> dict:
    """The aggregation columns of a parcel whose land-cover request failed: present
    (uniform export header) but empty — the areas are unknown, not 0."""
    return dict.fromkeys(LANDCOVER_AGG_KEYS, "")


def _aggregate_landcover(clipped):
    agg = dict.fromkeys(LANDCOVER_AGG_KEYS, 0.0)
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
            agg["av_produktiv_m2"] += area
        else:
            agg["av_unproduktiv_m2"] += area

        kat = f["_vbsKategorie"] or "kat_d"
        if kat == "kat_a":
            agg["av_kat_a_m2"] += area
        elif kat == "kat_b":
            agg["av_kat_b_m2"] += area
        elif kat == "kat_c":
            agg["av_kat_c_m2"] += area
        else:
            agg["av_kat_d_m2"] += area

        if f["_vbsTyp"] == "typ1":
            agg["av_typ1_m2"] += area
        elif f["_vbsTyp"] == "typ2":
            agg["av_typ2_m2"] += area

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
        "bauzonen_m2": "; ".join(to_fixed_1(a) for _, a in ordered),
        "zones": zones,
    }


def _aggregate_habitat(rows):
    """Aggregate habitat detail rows into parcel columns, by TypoCH **code** at level 1
    and level 2 (level-2 falls back to the level-1 code for L1-only features). Returns the
    readable level-2 label summary + ``typesL1`` / ``typesL2`` (code → area). Mirror of
    the web's aggregateHabitat()."""
    by_l1: dict[str, float] = {}
    by_l2: dict[str, float] = {}
    l2_label: dict[str, str] = {}
    for r in rows:
        area = r.get("_rawArea", r["area_m2"])
        c1 = C.typoch_code_at_level(r["art"], 1)
        c2 = C.typoch_code_at_level(r["art"], 2) or c1  # L1-only features fall back to their L1 code
        if c1:
            by_l1[c1] = by_l1.get(c1, 0.0) + area
        if c2:
            by_l2[c2] = by_l2.get(c2, 0.0) + area
            if c2 not in l2_label:
                l2_label[c2] = r.get("typoch_l2") or C.typoch_l2_label(r["art"]) or C.typoch_l1_label(r["art"])
    if not by_l2:
        return {"habitat": "", "habitat_m2": "", "typesL1": {}, "typesL2": {}}
    ordered_l2 = sorted(by_l2.items(), key=lambda kv: kv[1], reverse=True)
    return {
        "habitat": "; ".join(l2_label[c] for c, _ in ordered_l2),
        "habitat_m2": "; ".join(to_fixed_1(a) for _, a in ordered_l2),
        "typesL1": {c: round2(a) for c, a in by_l1.items()},
        "typesL2": {c: round2(a) for c, a in ordered_l2},
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
        parcel_result = api.fetch_parcel_geometry(egrid)
        if not parcel_result:
            return {"parcel": _make_error_parcel(id_, egrid, row, STATUS["NOT_FOUND"]), "landcover": []}

        parcel_geom = parcel_result["geometry"]
        bbox = geom.bbox(parcel_geom)
        lc_result = api.fetch_landcover(bbox)
        lc_failed = lc_result["error"]   # the request failed: land cover is unknown, not absent
        parcel_area = geom.area(parcel_geom)

        clip = _clip_landcover(parcel_geom, lc_result["features"], id_, egrid)
        clipped = clip["results"]
        av_rows = clipped  # the authoritative AV pieces, kept for the bfsnr even if synthesized below
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

        # Step 3b — synthetic AV land cover where AV is essentially absent. Not after a
        # failed request: then AV is not absent but unknown, and the same parcel would
        # get BAFU-derived numbers on one run and AV numbers on the next.
        av_classified = agg["sia416_ggf_m2"] + agg["sia416_buf_m2"] + agg["sia416_uuf_m2"]
        synth_enabled = options.get("synthLandcover", True) is not False
        if synth_enabled and not lc_failed and parcel_area > 0 and av_classified < parcel_area * MIN_AV_COVER_FRAC:
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
        if lc_failed:
            lc_errors.append(ERR_MSG["wfsUnavailable"])
            agg = _empty_landcover_aggregate()
            lc_source = ""

        merged = parcel_result["properties"]["mergedCount"] > 1
        parcel = {
            "id": id_,
            "egrid": egrid,
            "nummer": parcel_result["properties"].get("number") or "",
            # BFS municipality number: carried by the AV land-cover surfaces (the find
            # service has none) — the number covering the largest share of the parcel.
            "bfsnr": _dominant_bfsnr(av_rows),
            "nbident": parcel_result["properties"].get("nbident") or "",
            "status": "found",
            "check_egrid": STATUS["MERGED"] if merged else STATUS["FOUND"],
            "check_wfs": "wfs_error" if lc_failed else ("truncated" if lc_result["truncated"] else "ok"),
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
                for code, area in hb_agg["typesL1"].items():
                    parcel[C.habitat_area_key_l1(code)] = area
                for code, area in hb_agg["typesL2"].items():
                    parcel[C.habitat_area_key_l2(code)] = area
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

def needs_retry(result) -> bool:
    """True when a query of this parcel failed (a state of the service, not a
    property of the parcel): the lookup or the pipeline raised, or the land-cover,
    Bauzonen or habitat request did not answer. Mirror of needsRetry()."""
    p = result["parcel"]
    return (str(p.get("check_egrid", "")).startswith("error:")
            or p.get("check_wfs") == "wfs_error"
            or p.get("check_bauzonen") == "error"
            or p.get("check_habitat") == "error")


def _better_result(prev, new):
    """The result to keep after a retry: the new one, unless it failed again and
    the earlier one at least resolved the parcel — never trade a partial result
    for an error row. Mirror of betterResult()."""
    if prev is None or not needs_retry(new) or not is_found(prev["parcel"]["check_egrid"]):
        return new
    return prev


def _run_pool(rows, indices, options, on_result) -> bool:
    """Process ``rows[i]`` for *indices* with bounded concurrency, calling
    ``on_result(i, result)`` as each finishes. Returns False when interrupted
    (Ctrl-C); what was finished has been delivered."""
    if not indices:
        return True
    pool = ThreadPoolExecutor(max_workers=min(CONCURRENCY, len(indices)))
    futures = {pool.submit(_process_one, rows[i], options): i for i in indices}
    try:
        for fut in as_completed(futures):
            on_result(futures[fut], fut.result())
    except KeyboardInterrupt:
        pool.shutdown(wait=False, cancel_futures=True)
        return False
    pool.shutdown(wait=True)
    return True


def _overlay_fill(parcel, check_key):
    """Value for an overlay area column the parcel has no entry in: 0 when the
    overlay answered for this parcel, "" when it did not. Mirror of overlayFill()."""
    answered = is_found(parcel.get("check_egrid")) and parcel.get(check_key) not in ("", "error", None)
    return 0 if answered else ""


def process_rows(rows, options=None, on_progress=None):
    """Process rows (each ``{"id","egrid", ...}``) → ``{parcels, landcover, bauzonen, habitat}``.

    Mirrors ``processRows``: bounded-concurrency per-parcel processing, retry
    rounds for parcels with a failed query, then a flatten pass that makes the
    per-zone / per-habitat columns rectangular so exports have a uniform header.

    A parcel is reported to ``on_progress`` once, with its final result. On Ctrl-C
    the finished parcels are returned, the rows not reached as error rows, and the
    result carries ``interrupted = True`` — the caller still writes the exports.
    """
    options = options or {}
    # Optional green-inventory join: one parcel file (public URL or a local path), loaded
    # once; unreachable → the greeninv column stays empty on every parcel.
    green_index = None
    if options.get("greeninv"):
        try:
            green_index = api.load_green_inventory(options.get("greeninv_source"))
        except Exception as e:  # network / parse error: degrade, do not abort the run
            logger.warning("Green inventory unavailable (%s): the greeninv column stays empty", e)
    total = len(rows)
    results: list[dict | None] = [None] * total
    reported: set[int] = set()

    # How often each EGRID stands in the list. A repeated parcel is processed per row
    # and carries its full areas in each — a sum over the parcel table counts it that
    # many times. The count travels on the parcel as ``_egridCount`` (internal, not
    # exported); the CLI warns about it.
    egrid_counts: dict[str, int] = {}
    for r in rows:
        if r.get("egrid"):
            egrid_counts[r["egrid"]] = egrid_counts.get(r["egrid"], 0) + 1
    completed = 0
    succeeded = 0

    def report(i):
        nonlocal completed, succeeded
        reported.add(i)
        completed += 1
        if is_found(results[i]["parcel"]["check_egrid"]):
            succeeded += 1
        if on_progress:
            on_progress({"processed": completed, "total": total, "succeeded": succeeded,
                         "failed": completed - succeeded, "parcel": results[i]["parcel"]})

    # First pass over every row, then up to RETRY_ROUNDS passes over the parcels
    # with a failed query. A parcel that will be asked again is not reported yet.
    pending = list(range(total))
    finished = True
    for attempt in range(RETRY_ROUNDS + 1):
        last = attempt == RETRY_ROUNDS

        def on_result(i, result, last=last):
            result["parcel"]["_egridCount"] = egrid_counts.get(result["parcel"]["egrid"], 1)
            results[i] = _better_result(results[i], result)
            if last or not needs_retry(results[i]):
                report(i)

        finished = _run_pool(rows, pending, options, on_result)
        pending = [i for i in pending if results[i] is not None and needs_retry(results[i])]
        if not finished or not pending or last:
            break
        logger.warning("%d parcel(s) with a failed query — retry %d/%d in %d s",
                       len(pending), attempt + 1, RETRY_ROUNDS, RETRY_PAUSE_S)
        try:
            time.sleep(RETRY_PAUSE_S)
        except KeyboardInterrupt:
            finished = False
            break
    if not finished:
        for i, r in enumerate(results):
            if r is None:
                row = rows[i]
                results[i] = {"parcel": _make_error_parcel(row.get("id") or "", row.get("egrid") or "", row,
                                                           NOT_PROCESSED), "landcover": []}
    for i in range(total):          # held back for a retry that did not happen
        if results[i] is not None and i not in reported:
            report(i)

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
        # Every parcel carries the joined columns and every per-zone / per-habitat
        # column, so the export header is uniform. A column the parcel has no area in
        # is 0 when its overlay answered and empty when it did not (error rows, a
        # failed request): empty = not known, 0 = asked, nothing there.
        if options.get("bauzonen"):
            p.setdefault("bauzonen", "")
            p.setdefault("bauzonen_m2", "")
            p.setdefault("check_bauzonen", "")
            fill = _overlay_fill(p, "check_bauzonen")
            for k in zone_keys:
                p.setdefault(k, fill)
        if options.get("habitat"):
            p.setdefault("habitat", "")
            p.setdefault("habitat_m2", "")
            p.setdefault("check_habitat", "")
            fill = _overlay_fill(p, "check_habitat")
            for k in habitat_keys:
                p.setdefault(k, fill)
        if options.get("greeninv"):
            p["greeninv"] = api.green_inventory_flag(green_index, p.get("id") or "", p.get("egrid") or "")
        parcels.append(p)
        landcover.extend(r.get("landcover") or [])
        bauzonen.extend(r.get("bauzonen") or [])
        habitat.extend(r.get("habitat") or [])

    return {"parcels": parcels, "landcover": landcover, "bauzonen": bauzonen, "habitat": habitat,
            "interrupted": not finished}
