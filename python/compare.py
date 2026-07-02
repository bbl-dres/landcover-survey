"""Cross-check two landcover-survey GeoJSON exports (web app vs. Python API path).

Usage
-----
    python compare.py web.geojson python.geojson [--rtol 1e-4] [--atol 0.02]

Both files are the combined ``FeatureCollection`` (features tagged ``layer``).
The check has two levels:

1. **Parcels** — matched by ``egrid``; every property compared, area/``_m2`` fields
   within tolerance, everything else exact. This is the primary acceptance test:
   all per-parcel KPIs and flags must agree.
2. **Detail layers** — landcover / bauzonen / habitat aggregated per parcel
   (feature count + summed ``area_m2`` per ``art``), so a different piece-splitting
   between GEOS and Turf doesn't cause false diffs while a real area/label
   difference still does.

Exit code 0 = match within tolerance, 1 = differences (printed).
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict

_MISSING = object()


def _load(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)["features"]


def _num(v):
    """Return float(v) if v is numeric-like, else None."""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.strip()
        try:
            return float(s)
        except ValueError:
            return None
    return None


def _close(a, b, rtol, atol):
    return abs(a - b) <= atol + rtol * max(abs(a), abs(b))


def _norm_str(v):
    if v is None or v is _MISSING:
        return ""
    if isinstance(v, list):
        return "; ".join(str(x) for x in v)
    return str(v)


def _parcels(feats):
    return {f["properties"].get("egrid"): f["properties"]
            for f in feats if f["properties"].get("layer") == "parcel"}


def _detail(feats, layer):
    """Per-egrid aggregate for a detail layer: {egrid: {"count": n, "by_art": {art: area}}}."""
    out = defaultdict(lambda: {"count": 0, "by_art": defaultdict(float)})
    for f in feats:
        p = f["properties"]
        if p.get("layer") != layer:
            continue
        e = p.get("egrid")
        out[e]["count"] += 1
        out[e]["by_art"][p.get("art", "")] += _num(p.get("area_m2")) or 0.0
    return out


def compare_parcels(web, py, rtol, atol):
    diffs = []
    for e in sorted(set(web) | set(py)):
        if e not in web:
            diffs.append(f"parcel {e}: present in PYTHON only")
            continue
        if e not in py:
            diffs.append(f"parcel {e}: present in WEB only")
            continue
        pw, pp = web[e], py[e]
        for k in sorted((set(pw) | set(pp)) - {"layer"}):
            vw, vp = pw.get(k, _MISSING), pp.get(k, _MISSING)
            nw, np_ = _num(vw), _num(vp)
            if nw is not None and np_ is not None:
                if not _close(nw, np_, rtol, atol):
                    diffs.append(f"parcel {e}.{k}: web={vw!r} python={vp!r} (Δ={np_ - nw:+.4g})")
            elif _norm_str(vw) != _norm_str(vp):
                diffs.append(f"parcel {e}.{k}: web={vw!r} python={vp!r}")
    return diffs


def compare_detail(web_feats, py_feats, layer, rtol, atol):
    diffs = []
    web, py = _detail(web_feats, layer), _detail(py_feats, layer)
    for e in sorted(set(web) | set(py)):
        w, p = web.get(e), py.get(e)
        if w is None:
            diffs.append(f"{layer} {e}: present in PYTHON only ({p['count']} feats)")
            continue
        if p is None:
            diffs.append(f"{layer} {e}: present in WEB only ({w['count']} feats)")
            continue
        if w["count"] != p["count"]:
            diffs.append(f"{layer} {e}: feature count web={w['count']} python={p['count']}")
        for art in sorted(set(w["by_art"]) | set(p["by_art"])):
            aw, ap = w["by_art"].get(art, 0.0), p["by_art"].get(art, 0.0)
            if not _close(aw, ap, rtol, atol):
                diffs.append(f"{layer} {e} art={art!r}: area web={aw:.2f} python={ap:.2f} (Δ={ap - aw:+.2f})")
    return diffs


def main(argv=None):
    ap = argparse.ArgumentParser(description="Cross-check web vs Python landcover GeoJSON exports.")
    ap.add_argument("web", help="GeoJSON exported by the web app")
    ap.add_argument("python", help="GeoJSON exported by the Python API path")
    ap.add_argument("--rtol", type=float, default=1e-4, help="Relative tolerance for areas (default 1e-4)")
    ap.add_argument("--atol", type=float, default=0.02, help="Absolute tolerance in m² (default 0.02)")
    args = ap.parse_args(argv)

    # Diff lines contain Δ and umlauts; don't die on a cp1252 Windows console.
    if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
        sys.stdout.reconfigure(errors="replace")

    web_feats, py_feats = _load(args.web), _load(args.python)
    web_p, py_p = _parcels(web_feats), _parcels(py_feats)

    diffs = compare_parcels(web_p, py_p, args.rtol, args.atol)
    for layer in ("landcover", "bauzonen", "habitat"):
        diffs += compare_detail(web_feats, py_feats, layer, args.rtol, args.atol)

    n_parcels = len(set(web_p) | set(py_p))
    print(f"Compared {n_parcels} parcel(s), rtol={args.rtol}, atol={args.atol} m²")
    if not diffs:
        print(f"MATCH — no differences (parcels: {len(web_p)} web / {len(py_p)} python)")
        return 0
    print(f"{len(diffs)} DIFFERENCE(S):")
    for d in diffs:
        print("  " + d)
    return 1


if __name__ == "__main__":
    sys.exit(main())
