#!/usr/bin/env python3
"""Build the explainer's real-parcel sample: processing-web/js/explainer-sample.js + two aerial excerpts.

The explainer («Kurz erklärt») below the upload card walks through one real parcel —
Zollikofen, Parzelle 112, EGRID CH834682352690 — exactly the way the app processes it:
the aerial view, the cadastral boundary from swisstopo, the AV land cover from
geodienste.ch, clip, classify, figures. This script fetches that parcel through the
CLI's own api module (parity with the web app), projects everything into the explainer's
640 × 300 viewBox, and writes:

  processing-web/js/explainer-sample.js            ES module: parcel path, land-cover surfaces,
                                                   label anchors, figures, frame metadata
  processing-web/assets/explainer/zollikofen-112-wide.jpg   SWISSIMAGE excerpt, 1.5 km (scene «Wo?»)
  processing-web/assets/explainer/zollikofen-112.jpg        SWISSIMAGE excerpt, 430 m (every other scene)

Both frames share one centre, so the wide frame zooms onto the tight one with a plain
CSS scale. Aerial imagery: swisstopo SWISSIMAGE (free geodata, source to be named:
«© swisstopo»). Figures come from a CLI run (processing-cli/main.py --source api).

Usage (repo root, network required):
    python scripts/build_explainer_sample.py [--preview out.png]
"""
from __future__ import annotations

import argparse
import csv
import glob
import io
import json
import math
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "processing-cli"))
import api  # noqa: E402  (the CLI's live-service client — same fetches as the web app)
from shapely.geometry import box, mapping, shape  # noqa: E402
from shapely.ops import unary_union  # noqa: E402

EGRID = "CH834682352690"
LABEL = {"gemeinde": "Zollikofen", "kanton": "BE", "nummer": "112"}
VIEW_W, VIEW_H = 640, 300          # the explainer stage's viewBox
TIGHT_H_M, WIDE_H_M = 200.0, 700.0 # frame heights on the ground (width = height × 640/300)
OFFSET_E_M = 80.0                  # frame centre east of the parcel centre → parcel sits left, labels right
PAD_FRAME = 0.06                   # keep surfaces slightly beyond the tight frame (the zoom never shows them)
WMS = "https://wms.geo.admin.ch/?"
ASSETS = ROOT / "processing-web" / "assets" / "explainer"
OUT_JS = ROOT / "processing-web" / "js" / "explainer-sample.js"
# Which surfaces get a name in the «Bodenbedeckung» scene (AV Art → i18n key explainer.lc.<key>).
LABEL_ARTS = {"Gebaeude": "building", "uebrige_befestigte": "paved", "Gartenanlage": "garden",
              "Acker_Wiese_Weide": "meadow", "Gewaesser_stehendes": "pond", "Strasse_Weg": "road"}

R = 6378137.0


def merc(lon: float, lat: float) -> tuple[float, float]:
    return math.radians(lon) * R, math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * R


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--preview", help="write a PNG with the surfaces drawn over the tight aerial (alignment check)")
    args = ap.parse_args()
    from PIL import Image  # Pillow (processing-cli dependency)

    # ── 1. The parcel and the raw land cover around it (the same services the app uses) ──
    parcel = api.fetch_parcel_geometry(EGRID)
    if not parcel:
        sys.exit(f"{EGRID}: no geometry")
    pg = parcel["geometry"]
    minx, miny, maxx, maxy = pg.bounds
    cx, cy = (minx + maxx) / 2, (miny + maxy) / 2
    k = 1 / math.cos(math.radians(cy))           # mercator scale at this latitude
    mcx, mcy = merc(cx, cy)
    mcx += OFFSET_E_M * k                         # shift the frame centre east (ground metres → mercator)
    frames = {}
    for name, ground_h in (("tight", TIGHT_H_M), ("wide", WIDE_H_M)):
        ground_w = ground_h * VIEW_W / VIEW_H
        hx, hy = ground_w * k / 2, ground_h * k / 2
        frames[name] = (mcx - hx, mcy - hy, mcx + hx, mcy + hy)
    # raw land cover for the wide frame's bbox in WGS84 (generous: the tight frame is what we keep)
    tx0, ty0, tx1, ty1 = frames["tight"]
    inv = lambda x, y: (math.degrees(x / R), math.degrees(2 * math.atan(math.exp(y / R)) - math.pi / 2))
    lon0, lat0 = inv(tx0 - (tx1 - tx0) * PAD_FRAME, ty0 - (ty1 - ty0) * PAD_FRAME)
    lon1, lat1 = inv(tx1 + (tx1 - tx0) * PAD_FRAME, ty1 + (ty1 - ty0) * PAD_FRAME)
    raw = api.fetch_landcover([lon0, lat0, lon1, lat1])
    feats = raw["features"] if isinstance(raw, dict) and "features" in raw else raw
    print(f"parcel {EGRID}: {len(feats)} raw land-cover features in the frame")

    # ── 2. Figures from a CLI run (parity with the web app's numbers) ──
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run([sys.executable, str(ROOT / "processing-cli" / "main.py"), "--source", "api", "--egrid", EGRID,
                        "--output-dir", tmp, "--no-bauzonen", "--no-habitat", "--no-geojson", "--no-xlsx"],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        rows = list(csv.DictReader(io.open(glob.glob(tmp + "/parcels_*.csv")[0], encoding="utf-8-sig"), delimiter=";"))
    r = rows[0]
    num = lambda key: float(r.get(key) or 0)
    area = num("parcel_area_m2")
    figures = {
        "area_m2": round(area), "sealed_m2": round(num("sealed_m2")), "green_m2": round(num("greenspace_m2")),
        "ggf_m2": round(num("sia416_ggf_m2")), "water_m2": round(num("av_gewaesser_stehendes_m2")),
        "pct_sealed": round(num("sealed_m2") / area * 100), "pct_green": round(num("greenspace_m2") / area * 100),
        "pct_water": round(num("av_gewaesser_stehendes_m2") / area * 100),
    }
    print("figures:", figures)

    # ── 3. Project into the tight frame's viewBox ──
    fx0, fy0, fx1, fy1 = frames["tight"]
    sx, sy = VIEW_W / (fx1 - fx0), VIEW_H / (fy1 - fy0)

    def to_view(lon: float, lat: float) -> tuple[float, float]:
        mx, my = merc(lon, lat)
        return (mx - fx0) * sx, (fy1 - my) * sy

    def project(geom):
        from shapely.ops import transform
        return transform(lambda xs, ys: tuple(zip(*[to_view(x, y) for x, y in zip(xs, ys)])), geom)

    def path(geom) -> str:
        polys = [geom] if geom.geom_type == "Polygon" else list(geom.geoms) if geom.geom_type == "MultiPolygon" else []
        parts = []
        for poly in polys:
            for ring in [poly.exterior, *poly.interiors]:
                pts = list(ring.coords)[:-1]
                if len(pts) < 3:
                    continue
                parts.append("M " + " L ".join(f"{x:.1f} {y:.1f}" for x, y in pts) + " Z")
        return " ".join(parts)

    pv = project(pg).simplify(0.2, preserve_topology=True)
    frame_box = box(-VIEW_W * PAD_FRAME, -VIEW_H * PAD_FRAME, VIEW_W * (1 + PAD_FRAME), VIEW_H * (1 + PAD_FRAME))
    landcover = json.loads((ROOT / "data" / "landcover.json").read_text(encoding="utf-8"))
    main_of = {t["key"]: t["maingroup"] for t in landcover["types"]}
    surfaces, by_art_inside = [], {}
    for f in feats:
        g = f.get("geometry")
        g = shape(g) if isinstance(g, dict) else g
        art = (f.get("properties") or {}).get("Art") or (f.get("properties") or {}).get("art") or ""
        if g is None or g.is_empty or art not in main_of:
            continue
        v = project(g).intersection(frame_box).simplify(0.3, preserve_topology=True)
        if v.is_empty or v.area < 2:
            continue
        surfaces.append({"art": art, "main": main_of[art], "d": path(v)})
        inside = v.intersection(pv)
        if not inside.is_empty:
            by_art_inside.setdefault(art, []).append(inside)
    surfaces.sort(key=lambda s: ({"gebaeude": 1}.get(s["main"], 0)))  # buildings drawn last (on top)
    labels = []
    for art, key in LABEL_ARTS.items():
        pieces = by_art_inside.get(art)
        if not pieces:
            continue
        biggest = max(pieces, key=lambda g: g.area)
        p = biggest.representative_point()
        labels.append({"key": key, "x": round(p.x, 1), "y": round(p.y, 1), "area": round(unary_union(pieces).area, 1)})
    labels.sort(key=lambda l: -l["area"])
    origin = project(pg).centroid
    print(f"surfaces kept: {len(surfaces)}, labels: {[l['key'] for l in labels]}, zoom origin: ({origin.x:.0f}, {origin.y:.0f})")

    # ── 4. Aerial excerpts (SWISSIMAGE via the geo.admin WMS), resized + recompressed ──
    ASSETS.mkdir(parents=True, exist_ok=True)
    images = {}
    for name, size, quality, fname in (("tight", (1280, 600), 76, "zollikofen-112.jpg"), ("wide", (960, 450), 70, "zollikofen-112-wide.jpg")):
        bb = frames[name]
        q = urllib.parse.urlencode({"SERVICE": "WMS", "VERSION": "1.3.0", "REQUEST": "GetMap", "LAYERS": "ch.swisstopo.swissimage",
                                    "STYLES": "", "CRS": "EPSG:3857", "BBOX": "%f,%f,%f,%f" % bb, "WIDTH": 1280, "HEIGHT": 600,
                                    "FORMAT": "image/jpeg"})
        data = urllib.request.urlopen(WMS + q, timeout=120).read()
        im = Image.open(io.BytesIO(data)).convert("RGB")
        if im.size != size:
            im = im.resize(size, Image.LANCZOS)
        im.save(ASSETS / fname, "JPEG", quality=quality, optimize=True, progressive=True)
        images[name] = fname
        print(f"{fname}: {im.size[0]}x{im.size[1]}, {(ASSETS / fname).stat().st_size // 1024} KB")

    # ── 5. The module ──
    sample = {
        "egrid": EGRID, "label": LABEL, "figures": figures,
        "zoom": round(WIDE_H_M / TIGHT_H_M, 2), "origin": [round(origin.x, 1), round(origin.y, 1)],
        "images": {"tight": "../assets/explainer/" + images["tight"], "wide": "../assets/explainer/" + images["wide"]},
        "parcel": path(pv), "labels": labels, "surfaces": surfaces,
    }
    header = (
        "/* Generated by scripts/build_explainer_sample.py — do not edit by hand.\n"
        f" * One real parcel for the explainer: {LABEL['gemeinde']} (BE), Parzelle {LABEL['nummer']}, EGRID {EGRID}.\n"
        " * Boundary: amtliche Vermessung via the swisstopo API; land cover (BBArt) via geodienste.ch WFS —\n"
        " * the same services the app uses; figures from processing-cli (--source api). Coordinates are\n"
        " * in the explainer's 640 × 300 viewBox of the tight frame (web-mercator excerpt, see the script).\n"
        " * Aerial excerpts: SWISSIMAGE, © swisstopo (free geodata; the source is named on the stage). */\n"
    )
    body = json.dumps(sample, ensure_ascii=False, indent=1)
    OUT_JS.write_text(header + "export const SAMPLE = " + body + ";\n", encoding="utf-8", newline="\n")
    print(f"wrote {OUT_JS.relative_to(ROOT)} ({OUT_JS.stat().st_size // 1024} KB)")

    if args.preview:
        from PIL import ImageDraw
        im = Image.open(ASSETS / images["tight"]).convert("RGB").resize((VIEW_W * 2, VIEW_H * 2))
        dr = ImageDraw.Draw(im, "RGBA")
        colour = {"gebaeude": (51, 51, 51, 150), "befestigt": (128, 128, 128, 150), "humusiert": (252, 140, 29, 150),
                  "gewaesser": (13, 116, 252, 150), "bestockt": (98, 175, 57, 150), "vegetationslos": (154, 170, 179, 150)}
        for s in surfaces:
            for part in s["d"].split("Z"):
                pts = [tuple(float(v) * 2 for v in p.split()) for p in part.replace("M", "").split(" L ") if p.strip()]
                if len(pts) >= 3:
                    dr.polygon(pts, fill=colour[s["main"]])
        for part in sample["parcel"].split("Z"):
            pts = [tuple(float(v) * 2 for v in p.split()) for p in part.replace("M", "").split(" L ") if p.strip()]
            if len(pts) >= 3:
                dr.line(pts + [pts[0]], fill=(26, 54, 93, 255), width=5)
        for l in labels:
            dr.ellipse([l["x"] * 2 - 6, l["y"] * 2 - 6, l["x"] * 2 + 6, l["y"] * 2 + 6], fill=(216, 35, 42, 255))
        im.save(args.preview)
        print("preview:", args.preview)


if __name__ == "__main__":
    main()
