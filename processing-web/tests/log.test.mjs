// Processing log: severity + message classification of finished parcels (pure part of log.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { installBrowserStubs } from "./stubs.mjs";

installBrowserStubs();
const log = await import("../js/log.js");

const found = (extra = {}) => ({
  id: "1086/1/1", egrid: "CH1", check_egrid: "found", errors: [], check_wfs: "ok", check_geom: "ok",
  lc_synthetic: "", _landcover: [{}, {}, {}], check_bauzonen: "ok", check_habitat: "ok", ...extra,
});
const keys = (r) => r.parts.map((p) => p.key || (p.status !== undefined ? `status:${p.status}` : p.errors ? "errors" : `raw:${p.raw}`));

test("unresolved parcels are errors, labelled by their status code", () => {
  assert.deepEqual(keys(log.classifyParcel(found({ check_egrid: "invalid" }))), ["status:invalid"]);
  assert.equal(log.classifyParcel(found({ check_egrid: "not_found" })).sev, "err");
  assert.equal(log.classifyParcel(found({ check_egrid: "error:boom" })).sev, "err");
});

test("a failed WFS is an error even though the parcel resolved", () => {
  const r = log.classifyParcel(found({ errors: ["Land cover unavailable (WFS)"], check_wfs: "wfs_error", _landcover: [] }));
  assert.equal(r.sev, "err");
  assert.deepEqual(keys(r), ["errors"]);
});

test("quality notes make a warning, in a stable order", () => {
  const r = log.classifyParcel(found({
    check_egrid: "merged", lc_synthetic: "yes", check_wfs: "truncated", check_geom: "2_skipped",
    check_bauzonen: "partial", check_habitat: "estimated",
  }));
  assert.equal(r.sev, "warn");
  assert.deepEqual(keys(r), ["log.w.merged", "log.w.synthetic", "log.w.wfs", "log.w.geom", "log.w.bz.partial", "log.w.hb.estimated"]);
  assert.deepEqual(r.parts[3].params, { n: 2 });
});

test("no AV land cover without synthetic fallback is a warning", () => {
  assert.deepEqual(keys(log.classifyParcel(found({ _landcover: [] }))), ["log.w.nolc"]);
});

test("unknown overlay states are shown raw rather than dropped", () => {
  assert.deepEqual(keys(log.classifyParcel(found({ check_habitat: "weird" }))), ["raw:Habitat: weird"]);
});

test("a clean parcel lists its pieces and the overlays that ran", () => {
  const r = log.classifyParcel(found());
  assert.equal(r.sev, "ok");
  assert.deepEqual(keys(r), ["log.ok.pieces", "log.ok.bauzonen", "log.ok.habitat"]);
  assert.deepEqual(r.parts[0].params, { n: 3 });
  // overlays off → only the piece count
  assert.deepEqual(keys(log.classifyParcel(found({ check_bauzonen: undefined, check_habitat: undefined }))), ["log.ok.pieces"]);
});

test("partsText joins translated parts", () => {
  const txt = log.partsText([{ key: "log.ok.pieces", params: { n: 3 } }, { raw: "x" }]);
  assert.ok(txt.includes("3") && txt.endsWith(" · x"), txt);
});
