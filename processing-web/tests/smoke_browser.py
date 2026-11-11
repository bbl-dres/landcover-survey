"""Browser smoke test of the web app — the things node:test cannot see.

    python processing-web/tests/smoke_browser.py

Drives the real app in headless Chromium (Playwright for Python: ``pip install
playwright`` + ``playwright install chromium``) against the live services, with the
eight-parcel list of the parity fixture: two analyses in a row (menus must still
work on the second), the column toggle across a tab switch, the GeoJSON and report
downloads, leaving a run in progress, and opening the downloaded report on its own.
Not part of ``npm test``: it needs a browser and the internet and takes a minute.
Prints one line per check and exits 1 when one fails.

Optional arguments: ``<base-url>`` of an already running static server for the
repository root (otherwise one is started on a free port), ``<parcels.csv>``.
"""
import functools
import http.server
import json
import sys
import tempfile
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parents[2]
CSV = str(Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else REPO / "processing-cli/tests/fixtures/live/parcels.csv")
OUT = Path(tempfile.mkdtemp(prefix="landcover-smoke-"))


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


if len(sys.argv) > 1:
    BASE = sys.argv[1].rstrip("/")
else:
    _srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(_Quiet, directory=str(REPO)))
    threading.Thread(target=_srv.serve_forever, daemon=True).start()
    BASE = f"http://127.0.0.1:{_srv.server_address[1]}"

results = []


def check(name, ok, detail=""):
    results.append(ok)
    print(("OK   " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))


def run_analysis(page):
    page.click("#mode-tab-batch")
    page.set_input_files("#file-input", CSV)
    page.wait_for_selector("#state-results:not([hidden])", timeout=180_000)
    page.wait_for_function("document.querySelectorAll('#tab-parcels tbody tr').length > 0", timeout=60_000)
    page.wait_for_timeout(2500)   # map load + layers


with sync_playwright() as pw:
    browser = pw.chromium.launch()
    ctx = browser.new_context(accept_downloads=True, viewport={"width": 1600, "height": 1000})
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)

    page.goto(BASE + "/processing-web/index.html?lang=de")
    page.wait_for_selector("#state-upload:not([hidden])")

    # --- first analysis
    run_analysis(page)
    rows = page.locator("#tab-parcels tbody tr").count()
    check("first run shows 8 parcel rows", rows == 8, f"{rows} rows")

    def accordion_opens():
        hdr = page.locator("#geokatalog-accordion .accordion-header")
        before = hdr.evaluate("h => h.classList.contains('active')")
        hdr.click()
        page.wait_for_timeout(300)
        after = hdr.evaluate("h => h.classList.contains('active')")
        hdr.click()            # restore
        page.wait_for_timeout(200)
        return before != after

    def basemap_opens():
        page.click("#style-switcher-btn")
        page.wait_for_timeout(200)
        shown = page.evaluate("document.getElementById('style-panel').classList.contains('show')")
        if shown:
            page.click("#style-switcher-btn")
        return shown

    if page.evaluate("document.getElementById('accordion-panel').classList.contains('collapsed')"):
        page.click("#menu-toggle")
    check("layer menu toggles (run 1)", accordion_opens())
    check("basemap panel opens (run 1)", basemap_opens())

    # --- hidden column survives a tab switch (header and body stay aligned)
    def visible_counts():
        return page.evaluate("""() => {
          const vis = (el) => el.style.display !== 'none';
          const th = [...document.querySelectorAll('#tab-parcels thead th')].filter(vis).length;
          const td = [...document.querySelectorAll('#tab-parcels tbody tr:first-child td')].filter(vis).length;
          return [th, td];
        }""")
    th0, td0 = visible_counts()
    page.click("#columns-dropdown-btn")
    page.locator("#columns-list input[type=checkbox]:checked").nth(2).click()
    page.keyboard.press("Escape")
    page.click("body", position={"x": 5, "y": 5})
    page.click(".table-tab[data-tab='landcover']")
    page.wait_for_timeout(200)
    page.click(".table-tab[data-tab='parcels']")
    page.wait_for_timeout(200)
    th1, td1 = visible_counts()
    check("hidden column stays hidden in header and body after a tab switch", th1 == td1 == th0 - 1 and td0 == th0,
          f"before th/td {th0}/{td0}, after {th1}/{td1}")

    # --- report download
    page.click("#btn-download")
    with page.expect_download(timeout=120_000) as dl:
        page.click("#dl-report")
    report = OUT / "report.html"
    dl.value.save_as(report)
    check("report downloaded", report.stat().st_size > 100_000, f"{report.stat().st_size} bytes")
    page.wait_for_timeout(500)
    if page.locator("#download-overlay:not([hidden])").count():
        page.click("#dl-close")

    # --- GeoJSON download parses and is compact
    page.click("#btn-download")
    with page.expect_download(timeout=60_000) as dl:
        page.click("#dl-geojson")
    gj = OUT / "export.geojson"
    dl.value.save_as(gj)
    fc = json.loads(gj.read_text(encoding="utf-8"))
    parcels = [f["properties"] for f in fc["features"] if f["properties"]["layer"] == "parcel"]
    check("GeoJSON export parses, 8 parcels", len(parcels) == 8, f"{gj.stat().st_size} bytes, {len(fc['features'])} features")
    err_rows = [p for p in parcels if p["check_egrid"] not in ("found", "merged")]
    zone_keys = [k for k in parcels[0] if k.startswith("bauzonen_") and k.endswith("_m2") and k != "bauzonen_m2"]
    check("error rows have empty overlay columns", bool(err_rows) and all(p.get(k) == "" for p in err_rows for k in zone_keys),
          f"{len(err_rows)} error rows, {len(zone_keys)} zone columns")
    page.wait_for_timeout(300)
    if page.locator("#download-overlay:not([hidden])").count():
        page.click("#dl-close")

    # --- second analysis: the menu and basemap picker must still work
    page.click("#btn-new")
    page.wait_for_selector("#state-upload:not([hidden])")
    run_analysis(page)
    check("second run shows 8 parcel rows", page.locator("#tab-parcels tbody tr").count() == 8)
    if page.evaluate("document.getElementById('accordion-panel').classList.contains('collapsed')"):
        page.click("#menu-toggle")
    check("layer menu toggles (run 2)", accordion_opens())
    check("basemap panel opens (run 2)", basemap_opens())

    # --- leaving a run in progress must not pop the results view back up
    page.click("#btn-new")
    page.wait_for_selector("#state-upload:not([hidden])")
    page.click("#mode-tab-batch")
    page.set_input_files("#file-input", CSV)
    page.wait_for_selector("#state-processing:not([hidden])", timeout=20_000)
    page.click(".header-left")
    page.wait_for_timeout(6000)
    state = page.evaluate("[...document.querySelectorAll('.app-state')].filter(e => !e.hidden).map(e => e.id)")
    check("abandoned run does not reopen the results", state == ["state-upload"], str(state))

    check("no page errors in the app", not errors, "; ".join(errors[:4])[:400])

    # --- the downloaded report boots on its own
    rpage = ctx.new_page()
    rerrors = []
    rpage.on("pageerror", lambda e: rerrors.append(str(e)))
    rpage.goto(report.as_uri())
    try:
        rpage.wait_for_selector("#state-results:not([hidden])", timeout=60_000)
        rpage.wait_for_function("document.querySelectorAll('#tab-parcels tbody tr').length > 0", timeout=30_000)
        n = rpage.locator("#tab-parcels tbody tr").count()
        check("report opens into the results view", n == 8, f"{n} rows")
    except Exception as e:  # noqa: BLE001
        check("report opens into the results view", False, str(e)[:200])
    check("no page errors in the report", not rerrors, "; ".join(rerrors[:3])[:400])
    browser.close()

print(f"{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
