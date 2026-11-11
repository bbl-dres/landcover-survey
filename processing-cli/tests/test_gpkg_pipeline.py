"""gpkg source — pipeline, GeoPackage reading and CLI error handling.

Offline and synthetic: every test writes a tiny AV-like GeoPackage (``resf`` /
``lcsf`` / optionally ``dprsf``, EPSG:2056) into ``tmp_path``. The numbers in
brackets are the findings of the 2026-11-10 gpkg review each test pins down.
"""

from __future__ import annotations

import logging
import sqlite3

import geopandas as gpd
import pandas as pd
import pytest
from shapely.geometry import Polygon, box

import cli
import config
import data_io
import pipeline

X, Y = 2600000.0, 1200000.0


def sq(i, j=0, w=10, h=10):
    """A w × h m rectangle at offset (i, j) in LV95."""
    return box(X + i, Y + j, X + i + w, Y + j + h)


def _frame(rows, int_cols):
    df = pd.DataFrame([{k: v for k, v in r.items() if k != "geometry"} for r in rows])
    for c in int_cols:
        if c in df.columns:
            df[c] = pd.array(list(df[c]), dtype="Int64")   # integer column that may hold NULL
    return gpd.GeoDataFrame(df, geometry=[r["geometry"] for r in rows], crs="EPSG:2056")


def make_gpkg(path, parcels, landcover=None, sdr=None):
    """Write an AV-like GeoPackage. One building covers everything by default."""
    if landcover is None:
        landcover = [{"BFSNr": 1, "Art": "Gebaeude", "GWR_EGID": "1", "geometry": sq(-100, -100, 1000, 300)}]
    _frame(parcels, ["BFSNr", "Flaeche"]).to_file(path, layer="resf", driver="GPKG")
    _frame(landcover, ["BFSNr"]).to_file(path, layer="lcsf", driver="GPKG")
    if sdr is not None:
        _frame(sdr, ["BFSNr", "Flaeche"]).to_file(path, layer="dprsf", driver="GPKG")
    return str(path)


def parcel(egrid, i, bfsnr=1, nummer=None, flaeche=100, **kw):
    return {"BFSNr": bfsnr, "Nummer": nummer or str(i), "EGRIS_EGRID": egrid, "Flaeche": flaeche,
            "geometry": kw.get("geometry", sq(i))}


def write_list(tmp_path, text, name="list.csv"):
    p = tmp_path / name
    p.write_text(text, encoding="utf-8")
    return str(p)


def read_out(tmp_path, kind, ts):
    files = list((tmp_path / "out").glob(f"*{kind}_{ts}.csv"))
    assert len(files) == 1, files
    return pd.read_csv(files[0], sep=";", dtype=str, keep_default_na=False, encoding="utf-8-sig")


def run(tmp_path, ts, **kw):
    return pipeline.run(output_dir=str(tmp_path / "out"), ts=ts, **kw)


AREA_COLS = ["sia416_ggf_m2", "sia416_buf_m2", "sia416_uuf_m2", "din277_bf_m2", "din277_uf_m2",
             "sealed_m2", "greenspace_m2", "av_produktiv_m2", "av_kat_a_m2", "av_typ1_m2", "av_gebaeude_m2"]


# --- [6] [7] empty = not known, 0 = asked and nothing there -----------------------

def test_not_found_parcel_has_empty_area_cells_and_integers_stay_integers(tmp_path):
    g = make_gpkg(tmp_path / "av.gpkg", [parcel("CH000000000001", 0)], landcover=[
        {"BFSNr": 1, "Art": "Gebaeude", "GWR_EGID": "1", "geometry": sq(0)},
        {"BFSNr": 1, "Art": "Gartenanlage", "GWR_EGID": None, "geometry": sq(500)},   # elsewhere
    ])
    inp = write_list(tmp_path, "ID,EGRID\na,CH000000000001\nb,CH999999999999\nc,not-an-egrid\n")
    assert run(tmp_path, "t", mode=1, input_path=inp, gpkg_path=g) is True
    p = read_out(tmp_path, "parcels", "t").set_index("id")

    assert p.loc["a", "check_egrid"] == "found"
    assert float(p.loc["a", "sia416_ggf_m2"]) == pytest.approx(100.0)
    assert p.loc["a", "greenspace_m2"] == "0.0"          # found, no green space: a real zero

    for row in ("b", "c"):
        assert p.loc[row, "check_egrid"] == "not_found"
        assert p.loc[row, "parcel_area_m2"] == ""
        assert [p.loc[row, c] for c in AREA_COLS] == [""] * len(AREA_COLS)   # not 0.0

    # an unfound row must not turn the integer columns of the others into floats
    assert p.loc["a", "bfsnr"] == "1"
    assert p.loc["a", "flaeche"] == "100"
    assert p.loc["b", "bfsnr"] == "" and p.loc["b", "flaeche"] == ""


# --- [8] merged parcel ------------------------------------------------------------

def test_merged_parcel_sums_flaeche_and_lists_every_nummer(tmp_path):
    g = make_gpkg(tmp_path / "av.gpkg", [
        parcel("CH000000000006", 0, nummer="6.B", flaeche=100),
        parcel("CH000000000006", 30, nummer="6.A", flaeche=30, geometry=sq(30, 0, 3, 10)),
        parcel("CH000000000001", 60),
    ])
    inp = write_list(tmp_path, "ID,EGRID\nm,CH000000000006\ns,CH000000000001\n")
    run(tmp_path, "t", mode=1, input_path=inp, gpkg_path=g)
    p = read_out(tmp_path, "parcels", "t").set_index("id")
    assert p.loc["m", "check_egrid"] == "merged"
    assert float(p.loc["m", "parcel_area_m2"]) == pytest.approx(130.0)
    assert p.loc["m", "flaeche"] == "130"                # was 100: the first part only
    assert p.loc["m", "nummer"] == "6.A; 6.B"
    assert (p.loc["s", "check_egrid"], p.loc["s", "flaeche"], p.loc["s", "nummer"]) == ("found", "100", "60")


# --- [15] EGRID spelled in lower case in the AV data --------------------------------

def test_lowercase_egrid_in_the_geopackage_is_found(tmp_path):
    g = make_gpkg(tmp_path / "av.gpkg", [parcel("ch000000000009", 0), parcel("CH000000000001", 20)])
    inp = write_list(tmp_path, "ID,EGRID\nx,ch000000000009\n")     # the reader upper-cases it
    run(tmp_path, "t", mode=1, input_path=inp, gpkg_path=g)
    p = read_out(tmp_path, "parcels", "t")
    assert p.loc[0, "check_egrid"] == "found"
    assert p.loc[0, "egrid"] == "CH000000000009"
    lc = read_out(tmp_path, "landcover", "t")
    assert set(lc["egrid"]) == {"CH000000000009"}


# --- a list without a single valid EGRID must not read the whole table --------------

def test_no_valid_egrid_reads_no_parcel(tmp_path):
    g = make_gpkg(tmp_path / "av.gpkg", [parcel("CH000000000001", 0), parcel("CH000000000002", 20)])
    assert len(data_io.read_parcels(g, egrids=["00000", "INVALID", ""])) == 0     # rows=0 read everything
    assert len(data_io.read_parcels(g, egrids=[])) == 0

    inp = write_list(tmp_path, "ID,EGRID\na,00000\nb,INVALID\n")
    run(tmp_path, "t", mode=1, input_path=inp, gpkg_path=g)
    assert list(read_out(tmp_path, "parcels", "t")["check_egrid"]) == ["not_found", "not_found"]
    assert len(read_out(tmp_path, "landcover", "t")) == 0      # was: the land cover of every parcel


def test_egrid_guard_rejects_quotes_and_trailing_newline():
    assert data_io.is_valid_egrid("CH427760110057")
    for bad in ("CH1'; DROP TABLE resf; --", "CH1\n", " CH1", "", None, "XX123", "CH"):
        assert not data_io.is_valid_egrid(bad)


# --- [16] one table scan per 5'000 EGRIDs, not per 500 -------------------------------

def test_egrid_lookup_uses_large_batches(tmp_path, monkeypatch):
    g = make_gpkg(tmp_path / "av.gpkg", [parcel("CH000000000001", 0), parcel("CH000000000002", 20)])
    calls = []
    real = data_io._read_gpkg
    monkeypatch.setattr(data_io, "_read_gpkg", lambda *a, **k: calls.append(k.get("where")) or real(*a, **k))
    egrids = ["CH000000000001", "CH000000000002"] + [f"CH{n:012d}" for n in range(100, 1300)]
    found = data_io.read_parcels(g, egrids=egrids)
    assert sorted(found["EGRIS_EGRID"]) == ["CH000000000001", "CH000000000002"]
    assert len(calls) == 1                                    # 1'202 EGRIDs: one scan (was three)
    assert config.EGRID_BATCH_SIZE >= 5000
    # ... and the statement stays far below SQLite's default 1 MB limit
    assert config.EGRID_BATCH_SIZE * len("'CH000000000000', ") < 500_000

    monkeypatch.setattr(data_io, "EGRID_BATCH_SIZE", 1)       # batching itself still complete
    assert len(data_io.read_parcels(g, egrids=egrids[:3])) == 2


# --- [11] missing GeoPackage -----------------------------------------------------------

def test_missing_geopackage_is_a_clear_error_and_no_file_is_created(tmp_path):
    missing = tmp_path / "nope" / "av_2056.gpkg"
    missing.parent.mkdir()
    with pytest.raises(pipeline.PipelineError, match="GeoPackage not found"):
        run(tmp_path, "t", mode=2, input_path=None, gpkg_path=str(missing))
    with pytest.raises(FileNotFoundError):
        data_io.get_bfsnr_list(str(missing))
    assert not missing.exists()                               # sqlite3.connect() used to create it


def test_sqlite_access_is_read_only(tmp_path):
    g = make_gpkg(tmp_path / "av.gpkg", [parcel("CH000000000001", 0)])
    conn = data_io.connect_readonly(g)
    try:
        assert conn.execute('SELECT COUNT(*) FROM "resf"').fetchone() == (1,)
        with pytest.raises(sqlite3.OperationalError):
            conn.execute("CREATE TABLE x (a)")
    finally:
        conn.close()


def test_geopackage_without_the_av_layers_is_a_clear_error(tmp_path):
    path = tmp_path / "other.gpkg"
    gpd.GeoDataFrame({"a": [1]}, geometry=[sq(0)], crs="EPSG:2056").to_file(path, layer="something", driver="GPKG")
    with pytest.raises(pipeline.PipelineError, match="no layer resf, lcsf"):
        run(tmp_path, "t", mode=2, input_path=None, gpkg_path=str(path))


# --- [12] trivial input states: clean error, exit status, no traceback ------------------

@pytest.fixture
def cli_logging():
    """cli.main() installs root log handlers (one of them a file in the output
    directory); remove them again so the temp directory can be deleted."""
    root = logging.getLogger()
    before = list(root.handlers)
    yield
    for h in list(root.handlers):
        if h not in before:
            root.removeHandler(h)
            h.close()


def test_cli_header_only_list_exits_1_without_traceback(tmp_path, cli_logging):
    g = make_gpkg(tmp_path / "av.gpkg", [parcel("CH000000000001", 0)])
    inp = write_list(tmp_path, "ID,EGRID\n")
    with pytest.raises(SystemExit) as exc:               # was: ValueError traceback
        cli.main(["--source", "gpkg", "--input", inp, "--gpkg", g, "--output-dir", str(tmp_path / "out")])
    assert exc.value.code == 1
    assert not list((tmp_path / "out").glob("*.csv"))


def test_cli_missing_geopackage_exits_1(tmp_path, cli_logging):
    inp = write_list(tmp_path, "ID,EGRID\na,CH000000000001\n")
    with pytest.raises(SystemExit) as exc:
        cli.main(["--source", "gpkg", "--input", inp, "--gpkg", str(tmp_path / "missing.gpkg"),
                  "--output-dir", str(tmp_path / "out")])
    assert exc.value.code == 1
    assert not (tmp_path / "missing.gpkg").exists()


@pytest.mark.parametrize("flag, value", [("--chunk-size", "0"), ("--chunk-size", "-5"), ("--limit", "0")])
def test_cli_rejects_chunk_size_and_limit_below_one(tmp_path, flag, value, capsys):
    inp = write_list(tmp_path, "ID,EGRID\na,CH000000000001\n")
    with pytest.raises(SystemExit) as exc:               # was: ZeroDivisionError / "No objects to concatenate"
        cli.main(["--source", "gpkg", "--input", inp, "--gpkg", "unused.gpkg", flag, value,
                  "--output-dir", str(tmp_path / "out")])
    assert exc.value.code == 2                           # argparse usage error
    assert "must be at least 1" in capsys.readouterr().err


def test_pipeline_survives_zero_rows_and_rejects_bad_chunk_size(tmp_path):
    g = make_gpkg(tmp_path / "av.gpkg", [parcel("CH000000000001", 0)])
    inp = write_list(tmp_path, "ID,EGRID\na,CH000000000001\n")
    assert run(tmp_path, "zero", mode=1, input_path=inp, gpkg_path=g, limit=0) is True
    assert len(read_out(tmp_path, "parcels", "zero")) == 0
    with pytest.raises(pipeline.PipelineError, match="chunk_size"):
        run(tmp_path, "bad", mode=1, input_path=inp, gpkg_path=g, chunk_size=0)


# --- [3] SDR / Baurecht parcels live in dprsf ---------------------------------------------

def test_mode1_resolves_sdr_egrid_from_dprsf_and_mode2_leaves_it_out(tmp_path):
    sdr_row = dict(parcel("CH000000000050", 0, nummer="(50)", flaeche=40, geometry=sq(0, 0, 4, 10)),
                   Art="SelbstRecht.Baurecht")
    g = make_gpkg(tmp_path / "av.gpkg", [parcel("CH000000000001", 0)], sdr=[sdr_row])
    inp = write_list(tmp_path, "ID,EGRID\nland,CH000000000001\nbaurecht,CH000000000050\nnone,CH000000000077\n")
    run(tmp_path, "m1", mode=1, input_path=inp, gpkg_path=g)
    p = read_out(tmp_path, "parcels", "m1").set_index("id")
    assert p.loc["baurecht", "check_egrid"] == "found"                 # was not_found
    assert float(p.loc["baurecht", "parcel_area_m2"]) == pytest.approx(40.0)
    assert float(p.loc["baurecht", "sia416_ggf_m2"]) == pytest.approx(40.0)
    assert (p.loc["baurecht", "nummer"], p.loc["baurecht", "flaeche"]) == ("(50)", "40")
    assert p.loc["land", "check_egrid"] == "found" and p.loc["none", "check_egrid"] == "not_found"

    run(tmp_path, "m2", mode=2, input_path=None, gpkg_path=g)
    assert list(read_out(tmp_path, "parcels", "m2")["egrid"]) == ["CH000000000001"]   # SDR overlap the land


def test_mode1_without_dprsf_layer_still_works(tmp_path):
    g = make_gpkg(tmp_path / "av.gpkg", [parcel("CH000000000001", 0)])
    inp = write_list(tmp_path, "ID,EGRID\na,CH000000000001\nb,CH000000000050\n")
    run(tmp_path, "t", mode=1, input_path=inp, gpkg_path=g)
    assert list(read_out(tmp_path, "parcels", "t")["check_egrid"]) == ["found", "not_found"]


# --- [2] Mode 2 loses no parcel -------------------------------------------------------------

def test_mode2_keeps_parcels_without_bfsnr_and_without_egrid(tmp_path, caplog):
    g = make_gpkg(tmp_path / "av.gpkg", [
        parcel("CH000000000001", 0),
        parcel(None, 20), parcel(None, 40),             # no EGRID (NULL)
        parcel("", 60), parcel("  ", 80),               # no EGRID (blank)
        parcel("CH000000000008", 100, bfsnr=None),      # no BFSNr
        parcel(None, 120, bfsnr=None),                  # neither
    ])
    with caplog.at_level(logging.INFO, logger="pipeline"):
        assert run(tmp_path, "t", mode=2, input_path=None, gpkg_path=g) is True
    p = read_out(tmp_path, "parcels", "t")

    assert len(p) == 7                                                   # was 3 (one of them a bogus merge)
    assert p["parcel_area_m2"].astype(float).sum() == pytest.approx(700.0)
    assert set(p.loc[p.egrid != "", "egrid"]) == {"CH000000000001", "CH000000000008"}

    no_egrid = p[p.check_egrid == "no_egrid"]
    assert len(no_egrid) == 5
    assert (no_egrid["egrid"] == "").all()
    assert no_egrid["id"].str.fullmatch(r"fid:\d+").all() and no_egrid["id"].is_unique
    assert (no_egrid["parcel_area_m2"].astype(float) == 100.0).all()     # singles, never dissolved together
    assert (no_egrid["sia416_ggf_m2"].astype(float) == 100.0).all()      # each with its own land cover
    assert "merged" not in set(p["check_egrid"])

    lc = read_out(tmp_path, "landcover", "t")
    assert lc["area_m2"].astype(float).sum() == pytest.approx(700.0)
    assert set(lc.loc[lc.egrid == "", "id"]) == set(no_egrid["id"])

    assert "7 resf rows read → 7 parcels (0 of them merged from several rows, 5 without EGRID)" in caplog.text


def test_mode2_limit_leaves_out_the_batch_without_bfsnr(tmp_path):
    g = make_gpkg(tmp_path / "av.gpkg", [
        parcel("CH000000000001", 0, bfsnr=1), parcel("CH000000000002", 20, bfsnr=2),
        parcel("CH000000000008", 40, bfsnr=None),
    ])
    run(tmp_path, "t", mode=2, input_path=None, gpkg_path=g, limit=1)
    assert list(read_out(tmp_path, "parcels", "t")["egrid"]) == ["CH000000000001"]


# --- [4] an EGRID in two municipalities ----------------------------------------------------------

def test_mode2_counts_an_egrid_spanning_municipalities_once(tmp_path):
    g = make_gpkg(tmp_path / "av.gpkg", [
        parcel("CH000000000001", 0, bfsnr=1),
        parcel("CH000000000007", 20, bfsnr=1, nummer="7.1", flaeche=100),
        parcel("CH000000000007", 30, bfsnr=2, nummer="7.2", flaeche=50, geometry=sq(30, 0, 5, 10)),
        parcel("CH000000000002", 60, bfsnr=2),
        parcel("CH000000000009", 80, bfsnr=1),                      # one part with, one without BFSNr
        parcel("CH000000000009", 90, bfsnr=None, flaeche=100),
    ])
    run(tmp_path, "t", mode=2, input_path=None, gpkg_path=g)
    p = read_out(tmp_path, "parcels", "t").set_index("egrid")
    lc = read_out(tmp_path, "landcover", "t")

    assert len(p) == 4 and p.index.is_unique                        # was two rows per spanning EGRID
    assert p.loc["CH000000000007", "check_egrid"] == "merged"
    assert float(p.loc["CH000000000007", "parcel_area_m2"]) == pytest.approx(150.0)
    assert float(p.loc["CH000000000007", "sia416_ggf_m2"]) == pytest.approx(150.0)
    assert (p.loc["CH000000000007", "flaeche"], p.loc["CH000000000007", "nummer"]) == ("150", "7.1; 7.2")
    assert float(p.loc["CH000000000009", "parcel_area_m2"]) == pytest.approx(200.0)
    # the wall-to-wall invariant over the whole run: nothing counted twice
    assert p["sia416_ggf_m2"].astype(float).sum() == pytest.approx(lc["area_m2"].astype(float).sum())
    assert p["sia416_ggf_m2"].astype(float).sum() == pytest.approx(p["parcel_area_m2"].astype(float).sum())


# --- [5] a run that stops part-way writes what is finished -------------------------------------------

@pytest.mark.parametrize("error", [KeyboardInterrupt(), RuntimeError("disk on fire")])
def test_mode1_failure_in_a_later_chunk_keeps_the_finished_chunks(tmp_path, monkeypatch, error):
    g = make_gpkg(tmp_path / "av.gpkg", [parcel(f"CH00000000000{n}", 20 * n) for n in (1, 2, 3)])
    inp = write_list(tmp_path, "ID,EGRID,Note\na,CH000000000001,x\nb,CH000000000002,y\nc,CH000000000003,z\n")
    real, calls = pipeline._process_mode1_chunk, []

    def flaky(chunk_df, gpkg_path):
        calls.append(1)
        if len(calls) == 2:
            raise error
        return real(chunk_df, gpkg_path)

    monkeypatch.setattr(pipeline, "_process_mode1_chunk", flaky)
    assert run(tmp_path, "t", mode=1, input_path=inp, gpkg_path=g, chunk_size=1) is False   # was: everything lost

    p = read_out(tmp_path, "parcels", "t").set_index("id")
    assert list(p.index) == ["a", "b", "c"]                          # still one row per input row
    assert p.loc["a", "check_egrid"] == "found" and float(p.loc["a", "sia416_ggf_m2"]) == pytest.approx(100.0)
    for row in ("b", "c"):
        assert p.loc[row, "check_egrid"] == pipeline.NOT_PROCESSED
        assert p.loc[row, "parcel_area_m2"] == "" and p.loc[row, "sia416_ggf_m2"] == ""
    assert p.loc["c", "input_note"] == "z"
    assert set(read_out(tmp_path, "landcover", "t")["id"]) == {"a"}


def test_mode1_failure_in_the_first_chunk_is_raised(tmp_path, monkeypatch):
    g = make_gpkg(tmp_path / "av.gpkg", [parcel("CH000000000001", 0)])
    inp = write_list(tmp_path, "ID,EGRID\na,CH000000000001\n")
    monkeypatch.setattr(pipeline, "_process_mode1_chunk", lambda *a: (_ for _ in ()).throw(RuntimeError("boom")))
    with pytest.raises(RuntimeError, match="boom"):
        run(tmp_path, "t", mode=1, input_path=inp, gpkg_path=g)
    assert not list((tmp_path / "out").glob("*.csv")) if (tmp_path / "out").exists() else True


def test_mode2_interrupt_keeps_the_finished_municipalities(tmp_path, monkeypatch):
    g = make_gpkg(tmp_path / "av.gpkg", [parcel("CH000000000001", 0, bfsnr=1), parcel("CH000000000002", 20, bfsnr=2),
                                         parcel("CH000000000003", 40, bfsnr=3)])
    real = pipeline.read_parcels

    def interrupted(path, *a, **k):
        if k.get("bfsnr") == 2:
            raise KeyboardInterrupt
        return real(path, *a, **k)

    monkeypatch.setattr(pipeline, "read_parcels", interrupted)
    assert run(tmp_path, "t", mode=2, input_path=None, gpkg_path=g) is False
    assert list(read_out(tmp_path, "parcels", "t")["egrid"]) == ["CH000000000001"]
    assert len(read_out(tmp_path, "landcover", "t")) == 1


def test_cli_exit_status_of_an_incomplete_run(tmp_path, monkeypatch, cli_logging):
    g = make_gpkg(tmp_path / "av.gpkg", [parcel("CH000000000001", 0, bfsnr=1), parcel("CH000000000002", 20, bfsnr=2)])
    real = pipeline.read_parcels
    monkeypatch.setattr(pipeline, "read_parcels",
                        lambda path, *a, **k: (_ for _ in ()).throw(KeyboardInterrupt()) if k.get("bfsnr") == 2 else real(path, *a, **k))
    with pytest.raises(SystemExit) as exc:
        cli.main(["--source", "gpkg", "--mode", "2", "--gpkg", g, "--output-dir", str(tmp_path / "out")])
    assert exc.value.code == 1
    assert len(list((tmp_path / "out").glob("parcels_*.csv"))) == 1


def test_geometries_are_only_kept_for_the_overlays(tmp_path):
    g = make_gpkg(tmp_path / "av.gpkg", [parcel("CH000000000001", 0), parcel("CH000000000002", 20, bfsnr=2)])
    user = pd.DataFrame({"ID": ["a"], "EGRID": ["CH000000000001"]})
    for runner, args in ((pipeline._run_mode1, (user, g, 10)), (pipeline._run_mode2, (g, None))):
        parcels, lc, gdf, complete = runner(*args, keep_geometry=False)
        assert complete and len(gdf) == 0 and "geometry" not in lc.columns and len(lc) > 0
        parcels, lc, gdf, complete = runner(*args, keep_geometry=True)
        assert len(gdf) == len(parcels) and "geometry" in lc.columns


def test_chunk_size_does_not_change_the_result(tmp_path):
    g = make_gpkg(tmp_path / "av.gpkg", [parcel(f"CH00000000000{n}", 20 * n) for n in (1, 2, 3)])
    inp = write_list(tmp_path, "ID,EGRID\na,CH000000000001\nb,CH000000000002\nc,CH000000000001\nd,CH000000000009\n")
    run(tmp_path, "one", mode=1, input_path=inp, gpkg_path=g)
    run(tmp_path, "many", mode=1, input_path=inp, gpkg_path=g, chunk_size=1)
    for kind in ("parcels", "landcover"):
        pd.testing.assert_frame_equal(read_out(tmp_path, kind, "one"), read_out(tmp_path, kind, "many"))


# --- [14] an invalid land-cover polygon is repaired, not dropped ------------------------------------------

def test_invalid_landcover_polygon_is_repaired_before_clipping():
    bow_tie = Polygon([(0, 0), (10, 10), (10, 0), (0, 10), (0, 0)])       # self-intersecting, covers 50 m²
    spike = Polygon([(20, 0), (30, 0), (30, 10), (25, 10), (25, 15), (25, 10), (20, 10), (20, 0)])  # 100 m² + a spike
    assert not bow_tie.is_valid and not spike.is_valid
    lcsf = gpd.GeoDataFrame({"fid": [1, 2, 3], "Art": ["Gebaeude", "Gartenanlage", "Strasse_Weg"],
                             "BFSNr": [1, 1, 1], "GWR_EGID": [None, None, None]},
                            geometry=[bow_tie, spike, box(40, 0, 50, 10)], crs="EPSG:2056")
    parcel_row = pd.Series({"EGRID": "CH1", "ID": "a", "geometry": box(0, 0, 60, 20)})
    out = pipeline._clip_single_parcel(lcsf, parcel_row).set_index("fid")
    assert out.loc[1, "area_m2"] == pytest.approx(50.0)                   # was dropped
    assert out.loc[2, "area_m2"] == pytest.approx(100.0)                  # was dropped
    assert out.loc[3, "area_m2"] == pytest.approx(100.0)
