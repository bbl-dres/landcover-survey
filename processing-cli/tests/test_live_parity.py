"""End-to-end parity against a web-app export (live services — opt in).

tests/fixtures/live/web-export.geojson is a GeoJSON export of the web app for the
parcel list in tests/fixtures/live/parcels.csv (Bauzonen + habitat on, synthetic
AV on, green inventory off). The Python ``api`` source must reproduce it
bit-for-bit (``compare.py --rtol 0 --atol 0``).

Run with::

    LANDCOVER_LIVE=1 python -m pytest tests/test_live_parity.py -q

It hits geo.admin.ch / geodienste.ch, so it is skipped by default. The cadastral
data behind it changes over time (mutations, new surveys): when the test fails on
*data* differences rather than *code* differences, re-export the parcel list from
the web app (Upload → parcels.csv, Download → GeoJSON) and replace the fixture.
"""

from __future__ import annotations

import os

import pytest

from conftest import FIXTURES

pytestmark = pytest.mark.live

LIVE_DIR = FIXTURES / "live"


@pytest.mark.skipif(os.environ.get("LANDCOVER_LIVE") != "1", reason="set LANDCOVER_LIVE=1 to run against the live services")
def test_python_reproduces_web_export(tmp_path):
    import compare
    import export_web
    import processor_web
    from user_input import read_rows

    rows = read_rows(LIVE_DIR / "parcels.csv")
    results = processor_web.process_rows(rows, {"bauzonen": True, "habitat": True, "synthLandcover": True})
    out = tmp_path / "python.geojson"
    export_web.write_geojson(results, out)
    rc = compare.main([str(LIVE_DIR / "web-export.geojson"), str(out), "--rtol", "0", "--atol", "0"])
    assert rc == 0, "web and Python exports differ — see the printed diff"
