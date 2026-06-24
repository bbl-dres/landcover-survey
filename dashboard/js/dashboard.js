"use strict";
(function () {
  // ── Shared helpers (used by the picker and the Download menu) ──────────────
  // Snapshot the pristine template BEFORE any DOM mutation, so the HTML download
  // carries a clean shell with data swapped into the PARCEL-DATA markers.
  var TEMPLATE_HTML = "<!doctype html>\n" + document.documentElement.outerHTML;
  // PII allowlist (mirrors the old build_dashboard.py): keep every non-input_
  // column; of input_ keep only these six. The rest never reach a saved file.
  var KEEP_INPUT = { "input_ort":1, "input_plz":1, "input_rg":1, "input_bez. grundstück":1, "input_eigent.art":1, "input_tpf":1 };
  // Anything that looks like personal data is dropped even outside the input_ namespace
  // (defence-in-depth: an alternate/future export schema could carry PII without the prefix).
  var PII_RE = /(^|_)(name|mieter|tenant|e?mail|telefon|phone|adresse|kontakt|person|eigent[uü]mer|owner)(_|$)/i;
  var keepKey = function (k) { return k.indexOf("input_") === 0 ? !!KEEP_INPUT[k] : !PII_RE.test(k); };
  var DATA_MARKERS = /<!-- PARCEL-DATA:START[\s\S]*?PARCEL-DATA:END -->/;
  // Escape `<` (→ no </script> breakout) and U+2028/U+2029 (legal in JSON, but
  // terminate a JS string literal inside an inline <script> → silent corruption).
  var jsonSafe = function (o) { return JSON.stringify(o).replace(new RegExp("[<" + String.fromCharCode(0x2028, 0x2029) + "]", "g"), function (c) { return String.fromCharCode(92) + "u" + ("000" + c.charCodeAt(0).toString(16)).slice(-4); }); };
  var slug = function (s) { return (String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")) || "landcover-dashboard"; };
  var saveBlob = function (data, type, name) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([data], { type: type }));
    a.download = name; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  };
  // SheetJS on demand for the Excel table export (Download menu). Needs internet.
  var _xlsxP = null;
  var loadXlsx = function () {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (!_xlsxP) _xlsxP = new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
      s.onload = function () { res(window.XLSX); };
      s.onerror = function () { _xlsxP = null; rej(new Error("SheetJS konnte nicht geladen werden (Internetverbindung nötig).")); };
      document.head.appendChild(s);
    });
    return _xlsxP;
  };
  // GeoJSON text → { parcels, overlays }. Multi-layer exports tag features with
  // `layer` (parcel/landcover/bauzonen/habitat). Parcel rows carry the data
  // (tables/filters/parcel map layer); the other layers are kept as map overlays
  // (geometry + `art` type only — no PII). Legacy parcels-only exports have no
  // `layer` and yield empty overlays.
  var emptyOverlays = function () {
    return { landcover: { type: "FeatureCollection", features: [] }, bauzonen: { type: "FeatureCollection", features: [] }, habitat: { type: "FeatureCollection", features: [] } };
  };
  var readGeojson = function (text) {
    var feats = ((JSON.parse(text) || {}).features || []);
    var hasLayer = feats.some(function (f) { return f && f.properties && "layer" in f.properties; });
    var parcels = [], overlays = emptyOverlays();
    feats.forEach(function (f) {
      var pr = (f && f.properties) || {};
      var layer = hasLayer ? pr.layer : "parcel";
      if (layer === "parcel") {
        var o = {}; for (var k in pr) { if (k !== "layer") o[k] = pr[k]; }
        if (f && f.geometry) o._geom = f.geometry; // for the map (survives the allowlist)
        parcels.push(o);
      } else if (overlays[layer] && f && f.geometry) {
        overlays[layer].features.push({ type: "Feature", geometry: f.geometry, properties: { id: pr.id || "", art: pr.art || pr.Art || pr.bauzone_code || "", area_m2: +pr.area_m2 || 0 } });
      }
    });
    return { parcels: parcels, overlays: overlays };
  };
  // Strip non-allowlisted (PII) columns → { cleaned, dropped }.
  var allowlist = function (rows) {
    var droppedSet = {};
    var cleaned = rows.map(function (p) {
      var o = {};
      for (var k in p) { if (!Object.prototype.hasOwnProperty.call(p, k)) continue; if (keepKey(k)) o[k] = p[k]; else droppedSet[k] = 1; }
      return o;
    });
    // keepKey now hard-drops PII-looking columns (input_ and non-input_ alike); the dropped
    // set is surfaced to the operator in the picker so nothing leaves silently.
    return { cleaned: cleaned, dropped: Object.keys(droppedSet).sort() };
  };
  // Self-contained deliverable: clean template + embedded (allowlisted) parcels.
  var fetchText = function (url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status + " für " + url); return r.text(); });
  };
  // Inline local <link rel=stylesheet> and <script src> so the saved file is
  // self-contained (same model as the web app's report export). CDN refs (https)
  // are left as-is. Needs http — fetch is blocked on file://. A saved deliverable
  // already has everything inline, so there is nothing to fetch (works offline).
  var inlineAssets = function (html) {
    var jobs = [], m;
    var add = function (tag, url, wrap) { jobs.push(fetchText(url).then(function (t) { return [tag, wrap(t)]; })); };
    var lre = /<link\b[^>]*rel=["']stylesheet["'][^>]*href=["'](?!https?:)([^"']+)["'][^>]*>/g;
    while ((m = lre.exec(html))) add(m[0], m[1], function (css) { return "<style>\n" + css + "\n</style>"; });
    var sre = /<script\b[^>]*src=["'](?!https?:)([^"']+)["'][^>]*><\/script>/g;
    // Neutralize any script-closing sequence the source carries (e.g. inside a comment or string)
    // so the HTML parser can't terminate the inlined module early — backslash-escaped, it stays
    // identical JS (\/ === /) but is no longer a tag the parser recognises.
    while ((m = sre.exec(html))) add(m[0], m[1], function (js) { return "<script>\n" + js.replace(/<(\/script)/gi, function (_m, t) { return "<" + String.fromCharCode(92) + t; }) + "\n<\/script>"; });
    return Promise.all(jobs).then(function (pairs) {
      pairs.forEach(function (pr) { html = html.replace(pr[0], function () { return pr[1]; }); });
      return html;
    });
  };
  var buildDeliverable = function (parcels, overlays, title) {
    var data = "window.DASHBOARD_TITLE = " + jsonSafe(title || "Auswertung Bodenbedeckung") + ";\n" +
               "window.PARCELS = " + jsonSafe(parcels) + ";\n" +
               "window.OVERLAYS = " + jsonSafe(overlays || {}) + ";\n";
    var block = "<!-- PARCEL-DATA:START — generated by the in-browser builder; do not edit by hand -->\n" +
                "<script>\n" + data + "<\/script>\n" +
                "<!-- PARCEL-DATA:END -->";
    return inlineAssets(TEMPLATE_HTML).then(function (html) { return html.replace(DATA_MARKERS, function () { return block; }); });
  };

  // ── Picker: no embedded data → pick a file, allowlist, then render in place ──
  function initPicker() {
    document.body.classList.add("builder-mode"); // .builder-mode shows the picker, hides the dashboard
    var bEl = function (id) { return document.getElementById(id); };
    var fmtN = new Intl.NumberFormat("de-CH");
    var setStatus = function (h) { bEl("b-status").textContent = h; }; // plain text only — avoids injecting a parse-error message containing markup
    var geo = null;
    bEl("b-geojson").addEventListener("change", function (e) {
      var f = e.target.files[0]; if (!f) return;
      setStatus("GeoJSON wird gelesen…");
      f.text().then(function (t) {
        try {
          geo = readGeojson(t);
          var ov = geo.overlays, nOv = ov.landcover.features.length + ov.bauzonen.features.length + ov.habitat.features.length;
          bEl("b-show").disabled = false;
          setStatus(fmtN.format(geo.parcels.length) + " Grundstücke aus GeoJSON geladen" + (nOv ? " (+ " + fmtN.format(nOv) + " Layer-Features für die Karte)" : "") + ".");
        } catch (err) { geo = null; bEl("b-show").disabled = true; setStatus("Fehler beim Lesen der GeoJSON: " + err.message); }
      });
    });
    bEl("b-show").addEventListener("click", function () {
      if (!geo) return;
      var clean = allowlist(geo.parcels).cleaned; // strip PII at import
      document.body.classList.remove("builder-mode"); // hide the picker, reveal the dashboard
      boot(clean, geo.overlays);
    });
  }

  // German labels for BBArt land cover types
  var ART_LABELS = {
    Gebaeude:"Gebäude", Strasse_Weg:"Strasse/Weg", Trottoir:"Trottoir", Verkehrsinsel:"Verkehrsinsel",
    Bahn:"Bahn", Flugplatz:"Flugplatz", Wasserbecken:"Wasserbecken", uebrige_befestigte:"Übrige befestigte",
    Acker_Wiese_Weide:"Acker/Wiese/Weide", Reben:"Reben", uebrige_Intensivkultur:"Übrige Intensivkultur",
    Gartenanlage:"Gartenanlage", Hoch_Flachmoor:"Hoch-/Flachmoor", uebrige_humusierte:"Übrige humusierte",
    Wytweide_dicht:"Wytweide (dicht)", Wytweide_offen:"Wytweide (offen)", Gewaesser_stehendes:"Stehendes Gewässer",
    Gewaesser_fliessendes:"Fliessendes Gewässer", Schilfguertel:"Schilfgürtel", geschlossener_Wald:"Geschlossener Wald",
    uebrige_bestockte:"Übrige bestockte", Fels:"Fels", Gletscher_Firn:"Gletscher/Firn", Geroell_Sand:"Geröll/Sand",
    Abbau_Deponie:"Abbau/Deponie", uebrige_vegetationslose:"Übrige vegetationslose"
  };
  // AV main category (Hauptgruppe) per BBArt type — DM.01-AV-CH, shown as a prefix
  // in the "Bodenbedeckung nach Art" chart to make the AV structure legible.
  var ART_MAIN = {
    Gebaeude:"Gebäude",
    Strasse_Weg:"Befestigt", Trottoir:"Befestigt", Verkehrsinsel:"Befestigt", Bahn:"Befestigt",
    Flugplatz:"Befestigt", Wasserbecken:"Befestigt", uebrige_befestigte:"Befestigt",
    Acker_Wiese_Weide:"Humusiert", Reben:"Humusiert", uebrige_Intensivkultur:"Humusiert",
    Gartenanlage:"Humusiert", Hoch_Flachmoor:"Humusiert", uebrige_humusierte:"Humusiert",
    Gewaesser_stehendes:"Gewässer", Gewaesser_fliessendes:"Gewässer", Schilfguertel:"Gewässer",
    geschlossener_Wald:"Bestockt", Wytweide_dicht:"Bestockt", Wytweide_offen:"Bestockt", uebrige_bestockte:"Bestockt",
    Fels:"Vegetationslos", Gletscher_Firn:"Vegetationslos", Geroell_Sand:"Vegetationslos",
    Abbau_Deponie:"Vegetationslos", uebrige_vegetationslose:"Vegetationslos"
  };
  // The 26 canonical BBArt land-cover types (allowlist for the "by type" chart),
  // derived from ART_LABELS so new aggregate columns in an export can never be
  // mistaken for a land-cover type.
  var ART_KEYS = Object.keys(ART_LABELS);
  // AV land-cover area column for a BBArt value: av_<art>_m2 (lowercase). The
  // ART_* maps stay keyed by the BBArt code (e.g. "Gebaeude"); only the geojson
  // column id is lowercased + av_-prefixed.
  function artCol(a) { return "av_" + String(a).toLowerCase() + "_m2"; }

  // ---- Shared layer colours (map fills + map legend + table category swatches) ----
  // Land cover collapses to the 6 AV main categories (Hauptgruppen) so the map +
  // legend stay legible; each BBArt row's swatch uses its main-category colour.
  var MAIN_COLORS = {
    "Gebäude": "#c0392b", "Befestigt": "#8d99a6", "Humusiert": "#7cb342",
    "Bestockt": "#0d6e54", "Gewässer": "#3498db", "Vegetationslos": "#c9b27c"
  };
  var MAIN_ORDER = ["Gebäude", "Befestigt", "Humusiert", "Bestockt", "Gewässer", "Vegetationslos"];
  function mainColor(a) { return MAIN_COLORS[ART_MAIN[a]] || "#94a3b8"; }
  // Habitat by TypoCH level-1 (digit → colour; mirrors web/js/config.js BAFU_TYPOCH_L1).
  var HABITAT_L1_COLORS = { "1":"#2980b9", "2":"#16a085", "3":"#aab7b8", "4":"#2ecc71", "5":"#82c341", "6":"#1e8449", "7":"#d4ac0d", "8":"#a3d977", "9":"#c0392b" };
  var HABITAT_SLUG_DIGIT = {
    gewaesser:"1", ufer_feuchtgebiete:"2", gletscher_fels_schutt_geroell:"3", gruenland:"4",
    krautsaeume_hochstauden_gebuesche:"5", waelder:"6", pionier_ruderalvegetation:"7",
    pflanzungen_aecker_kulturen:"8", gebaeude_anlagen:"9"
  };
  function habColor(slug) { return HABITAT_L1_COLORS[HABITAT_SLUG_DIGIT[slug]] || "#8e7cc3"; }
  // Harmonised Bauzonen use (ch.are.bauzonen ch_code_hn) → colour, keyed by slug.
  // Mirrors web/js/config.js BAUZONEN_HN_COLORS so a use gets the same colour in
  // the web app, this map, the table swatches and the legend.
  var BAUZONE_COLORS = {
    wohnzonen: "#f4c430", arbeitszonen: "#8e8e8e", mischzonen: "#e08a3c", zentrumszonen: "#b5651d",
    zonen_fuer_oeffentliche_nutzungen: "#6fa8dc", eingeschraenkte_bauzonen: "#7cb342",
    tourismus_und_freizeitzonen: "#c2549d", verkehrszonen_innerhalb_der_bauzonen: "#5d6d7e",
    weitere_bauzonen: "#9e9e9e", ohne_bauzone: "#cbd5e1"
  };
  function bzColor(z) { return BAUZONE_COLORS[z] || "#9e9e9e"; }
  var PARCEL_COLOR = "#6f8aac";
  // SAP codes → Klartext labels (display only; the raw code stays the filter key + in exports).
  var TPF_LABELS = { "1": "Allgemeine Bundesverwaltung", "2": "Ausland", "3": "Zoll", "4": "Gerichte", "5": "Forschungsanstalten", "6": "Kunst und Kultur", "7": "Sport", "8": "Repräsentation Inland", "9": "Infrastruktur" };
  var EIGENTUM_LABELS = { "1": "Eigentum Bund", "3": "Anmiete", "5": "Spezialfall" };
  function codeLabel(map, code) { if (code == null || code === "" || code === "—") return "—"; var k = String(code); return map[k] || map[String(parseInt(k, 10))] || k; }
  function tpfLabel(code) { return codeLabel(TPF_LABELS, code); }
  function eigentumLabel(code) { return codeLabel(EIGENTUM_LABELS, code); }

  // E-GRID resolution status (check_egrid). Default filter = only "found".
  var STATUS_LABELS = { found:"Gefunden", merged:"Gefunden (zusammengeführt)", not_found:"Nicht gefunden", invalid:"Ungültige E-GRID", error:"Fehler" };
  var STATUS_ORDER = ["found", "merged", "not_found", "invalid", "error"];
  function statusKey(p) { var c = p.check_egrid || ""; return c.indexOf("error:") === 0 ? "error" : (c || "—"); }

  // "Name"/Bezeichnung column and prefix codes excluded by default (SAP categories
  // that are not real cadastral parcels for this analysis).
  var NAME_COL = "input_bez. grundstück";
  // mode "prefix" = Bezeichnung starts with the code; mode "word" = the code appears
  // as a standalone token anywhere (e.g. "Bern, Bollwerk 27, PP Miete"), avoiding
  // false hits inside words (Rapperswil, Appenzell, …).
  var EXCLUDE_RULES = [
    { key:"ABGA", label:"Abgang (ABGA*)", mode:"prefix" },
    { key:"LÖVM", label:"Löschvermerk (LÖVM*)", mode:"prefix" },
    { key:"PP",   label:"Parkplatz (*PP*)", mode:"word" }
  ];
  EXCLUDE_RULES.forEach(function (r) {
    var rawK = r.key.toUpperCase();
    if (r.mode === "word") {
      var escK = rawK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      var rx = new RegExp("(^|[^A-Z0-9ÄÖÜ])" + escK + "([^A-Z0-9ÄÖÜ]|$)");
      r.test = function (name) { return rx.test(name); };
    } else {
      r.test = function (name) { return name.indexOf(rawK) === 0; };
    }
  });
  function defaultExclude() { var o = {}; EXCLUDE_RULES.forEach(function (r) { o[r.key] = true; }); return o; }
  function nameMatches(p, rule) {
    return rule.test(String(p[NAME_COL] == null ? "" : p[NAME_COL]).trim().toUpperCase());
  }

  var nf = new Intl.NumberFormat("de-CH");
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
  function fmt(v) { return nf.format(Math.round(v)); }
  function ha(m2) { return m2 / 1e4; }
  function fmtHa(m2) { var h = ha(m2); if (h > 0 && h < 0.01) return "< 0.01"; return nf.format(h >= 100 ? Math.round(h) : h >= 1 ? Math.round(h * 10) / 10 : Math.round(h * 100) / 100); }
  // ---- Area display unit (ha default / m²) — display only; the data stays m² ----
  var areaUnit = "ha";
  try { var _su = localStorage.getItem("dashAreaUnit"); if (_su === "ha" || _su === "m2") areaUnit = _su; } catch (e) { /* file:// may block storage */ }
  function unitLabel() { return areaUnit === "ha" ? "ha" : "m²"; }
  function fmtArea(m2) { return areaUnit === "m2" ? fmt(Math.round(num(m2))) : fmtHa(m2); }
  function fmtAreaU(m2) { return fmtArea(m2) + " " + unitLabel(); }
  function stripM2(s) { return String(s == null ? "" : s).replace(/\s*m²$/, ""); }
  function pct(part, whole) { return whole > 0 ? Math.round(part/whole*100) : 0; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]; }); }
  function isCovered(p) { return num(p.sia416_ggf_m2) + num(p.sia416_buf_m2) + num(p.sia416_uuf_m2) > 0; }


  function boot(PARCELS, OVERLAYS) {
    OVERLAYS = OVERLAYS || {};
  // ---- Precompute filter option counts (over the full dataset) ----
  var cantonCounts = {}, eigentumCounts = {}, artTotal = {}, artParcelCount = {}, covWith = 0, covWithout = 0;
  var excludeCounts = {}, statusCounts = {}, tpfCounts = {}, bauzoneTotal = {}, bauzoneParcelCount = {}, habitatTotal = {}, habitatParcelCount = {};
  var BAUZONE_RE = /^bauzonen_(.+)_m2$/; // bauzonen_<slug>_m2 (the bauzonen_m2 total does not match)
  // Display label per zone slug (ARE harmonised Hauptnutzung) — mirrors web/js/config.js.
  var BAUZONE_LABELS = {
    wohnzonen: "Wohnzonen", arbeitszonen: "Arbeitszonen", mischzonen: "Mischzonen",
    zentrumszonen: "Zentrumszonen", zonen_fuer_oeffentliche_nutzungen: "Zonen für öffentliche Nutzungen",
    eingeschraenkte_bauzonen: "eingeschränkte Bauzonen", tourismus_und_freizeitzonen: "Tourismus- und Freizeitzonen",
    verkehrszonen_innerhalb_der_bauzonen: "Verkehrszonen innerhalb der Bauzonen", weitere_bauzonen: "weitere Bauzonen",
    ohne_bauzone: "Ohne Bauzone" // parcel area no building zone covers (emitted by processing)
  };
  function bzLabel(z) { return BAUZONE_LABELS[z] || String(z).replace(/_/g, " "); }
  var HABITAT_RE = /^habitat_(.+)_m2$/; // habitat_<slug>_m2 (the habitat_m2 total does not match)
  // Display label per habitat slug (TypoCH level-1) — mirrors web/js/config.js.
  var HABITAT_LABELS = {
    gewaesser: "Gewässer", ufer_feuchtgebiete: "Ufer & Feuchtgebiete",
    gletscher_fels_schutt_geroell: "Gletscher, Fels, Schutt, Geröll", gruenland: "Grünland",
    krautsaeume_hochstauden_gebuesche: "Krautsäume, Hochstauden, Gebüsche", waelder: "Wälder",
    pionier_ruderalvegetation: "Pionier-/Ruderalvegetation", pflanzungen_aecker_kulturen: "Pflanzungen, Äcker, Kulturen",
    gebaeude_anlagen: "Gebäude / Anlagen"
  };
  function hbLabel(h) { return HABITAT_LABELS[h] || String(h).replace(/_/g, " "); }
  EXCLUDE_RULES.forEach(function (r) { excludeCounts[r.key] = 0; });
  PARCELS.forEach(function (p) {
    var c = p.input_rg || ""; if (c) cantonCounts[c] = (cantonCounts[c] || 0) + 1;
    var e = p["input_eigent.art"] || ""; if (e) eigentumCounts[e] = (eigentumCounts[e] || 0) + 1;
    var tp = (p.input_tpf == null || p.input_tpf === "") ? "—" : String(p.input_tpf); tpfCounts[tp] = (tpfCounts[tp] || 0) + 1;
    var st = statusKey(p); statusCounts[st] = (statusCounts[st] || 0) + 1;
    if (isCovered(p)) covWith++; else covWithout++;
    EXCLUDE_RULES.forEach(function (r) { if (nameMatches(p, r)) excludeCounts[r.key]++; });
    ART_KEYS.forEach(function (a) {
      var v = num(p[artCol(a)]);
      if (v > 0) { artTotal[a] = (artTotal[a] || 0) + v; artParcelCount[a] = (artParcelCount[a] || 0) + 1; }
    });
    for (var bk in p) {
      var bm = BAUZONE_RE.exec(bk);
      if (bm) { var bv = num(p[bk]); if (bv > 0) { var bz = bm[1]; bauzoneTotal[bz] = (bauzoneTotal[bz] || 0) + bv; bauzoneParcelCount[bz] = (bauzoneParcelCount[bz] || 0) + 1; } }
      var hm = HABITAT_RE.exec(bk);
      if (hm) { var hv = num(p[bk]); if (hv > 0) { var hz = hm[1]; habitatTotal[hz] = (habitatTotal[hz] || 0) + hv; habitatParcelCount[hz] = (habitatParcelCount[hz] || 0) + 1; } }
    }
  });
  var cantonList = Object.keys(cantonCounts).sort(function (a, b) { return cantonCounts[b] - cantonCounts[a]; });
  var artListAll = Object.keys(artTotal).sort(function (a, b) { return artTotal[b] - artTotal[a]; });
  var bauzoneListAll = Object.keys(bauzoneTotal).sort(function (a, b) { return bauzoneTotal[b] - bauzoneTotal[a]; });
  var habitatListAll = Object.keys(habitatTotal).sort(function (a, b) { return habitatTotal[b] - habitatTotal[a]; });
  // Precomputed column-name arrays — built once so the per-parcel aggregate loop
  // doesn't rebuild "av_<a>_m2" / "bauzonen_<z>_m2" / "habitat_<h>_m2" strings every render.
  var artCols = ART_KEYS.map(artCol);
  var bzCols = bauzoneListAll.map(function (z) { return "bauzonen_" + z + "_m2"; });
  var hbCols = habitatListAll.map(function (h) { return "habitat_" + h + "_m2"; });
  var tpfList = Object.keys(tpfCounts).sort(function (a, b) { return tpfCounts[b] - tpfCounts[a]; });
  var eigentumList = Object.keys(eigentumCounts).sort();
  var statusList = STATUS_ORDER.filter(function (s) { return statusCounts[s]; })
    .concat(Object.keys(statusCounts).filter(function (s) { return STATUS_ORDER.indexOf(s) === -1; }));

  // ---- Filter state ----
  // Defaults active on load: ABGA*/LÖVM*/PP* excluded, E-GRID-Status "Gefunden",
  // and Eigentumsart 1 (Bodenbedeckung defaults to "Alle"). The empty URL
  // represents exactly this default state; query params encode deviations from it.
  // Aggregate "Enthält" categories (clickable on the SIA 416 / Grün·Versiegelung·VBS
  // charts). Like the per-Art filter, each selects Grundstücke that *contain* the
  // category (value > 0) — it does not hide the other land cover of those parcels.
  var HAS_METRICS = {
    GGF:    { label:"Gebäudegrundfläche (GGF)", field:"sia416_ggf_m2" },
    BUF:    { label:"Bearbeitete Umgebung (BUF)", field:"sia416_buf_m2" },
    UUF:    { label:"Unbearbeitete Umgebung (UUF)", field:"sia416_uuf_m2" },
    Green:  { label:"Grünfläche", field:"greenspace_m2" },
    Sealed: { label:"Versiegelte Fläche", field:"sealed_m2" },
    VBSp:   { label:"VBS produktiv", field:"vbs_produktiv_m2" },
    VBSu:   { label:"VBS unproduktiv", field:"vbs_unproduktiv_m2" }
  };
  var HAS_KEYS = Object.keys(HAS_METRICS);
  var hasCounts = {};
  HAS_KEYS.forEach(function (m) { hasCounts[m] = 0; });
  PARCELS.forEach(function (p) { HAS_KEYS.forEach(function (m) { if (num(p[HAS_METRICS[m].field]) > 0) hasCounts[m]++; }); });

  function defaultEigentum() { return eigentumCounts["1"] ? { "1": true } : {}; }
  function defaultStatus() { return statusCounts["found"] ? { found: true } : {}; }
  function defaultFilters() {
    return { cantons:{}, coverage:"all", arts:{}, has:{}, bauzonen:{}, tpf:{}, eigentum:defaultEigentum(), status:defaultStatus(), exclude:defaultExclude() };
  }
  var filters = defaultFilters();

  function passesFilters(p) {
    for (var i = 0; i < EXCLUDE_RULES.length; i++) {
      var r = EXCLUDE_RULES[i];
      if (filters.exclude[r.key] && nameMatches(p, r)) return false;
    }
    var st = Object.keys(filters.status);
    if (st.length && !filters.status[statusKey(p)]) return false;
    var cs = Object.keys(filters.cantons);
    if (cs.length && !filters.cantons[p.input_rg || ""]) return false;
    if (filters.coverage === "with" && !isCovered(p)) return false;
    if (filters.coverage === "without" && isCovered(p)) return false;
    var as = Object.keys(filters.arts);
    if (as.length && !as.some(function (a) { return num(p[artCol(a)]) > 0; })) return false;
    var bz = Object.keys(filters.bauzonen);
    if (bz.length && !bz.some(function (z) { return num(p["bauzonen_" + z + "_m2"]) > 0; })) return false;
    var hs = Object.keys(filters.has);
    if (hs.length && !hs.some(function (m) { return num(p[HAS_METRICS[m].field]) > 0; })) return false;
    var es = Object.keys(filters.eigentum);
    if (es.length && !filters.eigentum[p["input_eigent.art"] || ""]) return false;
    var tp = Object.keys(filters.tpf);
    if (tp.length && !filters.tpf[(p.input_tpf == null || p.input_tpf === "") ? "—" : String(p.input_tpf)]) return false;
    return true;
  }
  function activeGroups() {
    var n = 0;
    if (EXCLUDE_RULES.some(function (r) { return filters.exclude[r.key] && excludeCounts[r.key] > 0; })) n++;
    if (Object.keys(filters.cantons).length) n++;
    if (filters.coverage !== "all") n++;
    if (Object.keys(filters.arts).length) n++;
    if (Object.keys(filters.bauzonen).length) n++;
    if (Object.keys(filters.has).length) n++;
    if (Object.keys(filters.tpf).length) n++;
    if (Object.keys(filters.eigentum).length) n++;
    if (Object.keys(filters.status).length) n++;
    return n;
  }

  // ---- Table state & search ----
  var SEARCH_KEYS = ["id", "egrid", "nummer", "input_ort", "input_rg", "input_bez. grundstück"];
  var state = { sort:"parcel_area_m2", dir:-1, search:"", page:1, pageSize:25, rows:PARCELS.slice() };
  var selectedParcelId = null; // parcel highlighted on the map / selected in the table
  var printing = false;

  function getFiltered() {
    var q = state.search.trim().toLowerCase();
    return PARCELS.filter(function (p) {
      if (!passesFilters(p)) return false;
      if (q && !SEARCH_KEYS.some(function (k) { return String(p[k] == null ? "" : p[k]).toLowerCase().indexOf(q) !== -1; })) return false;
      return true;
    });
  }

  // ---- Aggregation over a dataset ----
  function aggregate(rows) {
    var t = { parcelArea:0, GGF:0, BUF:0, UUF:0, Sealed:0, Green:0, VBSp:0, VBSu:0, VBSa:0, VBSb:0, VBSc:0, VBSd:0 }, byArt = {}, byBauzone = {}, byHabitat = {}, withData = 0;
    var wfsIssues = 0, geomIssues = 0;
    rows.forEach(function (p) {
      t.parcelArea += num(p.parcel_area_m2);
      t.GGF += num(p.sia416_ggf_m2); t.BUF += num(p.sia416_buf_m2); t.UUF += num(p.sia416_uuf_m2);
      t.Sealed += num(p.sealed_m2); t.Green += num(p.greenspace_m2);
      t.VBSp += num(p.vbs_produktiv_m2); t.VBSu += num(p.vbs_unproduktiv_m2);
      t.VBSa += num(p.vbs_kat_a_m2); t.VBSb += num(p.vbs_kat_b_m2); t.VBSc += num(p.vbs_kat_c_m2); t.VBSd += num(p.vbs_kat_d_m2);
      if (isCovered(p)) withData++;
      if (p.check_wfs && p.check_wfs !== "ok") wfsIssues++;
      if (p.check_geom && p.check_geom !== "ok") geomIssues++;
      for (var ai = 0; ai < ART_KEYS.length; ai++) { var av = num(p[artCols[ai]]); if (av) byArt[ART_KEYS[ai]] = (byArt[ART_KEYS[ai]] || 0) + av; }
      for (var zi = 0; zi < bauzoneListAll.length; zi++) { var zv = num(p[bzCols[zi]]); if (zv) byBauzone[bauzoneListAll[zi]] = (byBauzone[bauzoneListAll[zi]] || 0) + zv; }
      for (var hi = 0; hi < habitatListAll.length; hi++) { var hv2 = num(p[hbCols[hi]]); if (hv2) byHabitat[habitatListAll[hi]] = (byHabitat[habitatListAll[hi]] || 0) + hv2; }
    });
    return { len:rows.length, withData:withData, totals:t, byArt:byArt, byBauzone:byBauzone, byHabitat:byHabitat, classified:t.GGF + t.BUF + t.UUF,
             wfsIssues:wfsIssues, geomIssues:geomIssues };
  }

  // ---- Summary-table renderer (with an inline proportion bar per row) ----
  function renderValTable(elId, items, total, fmtVal, showTotal, valHeader, anteilHint) {
    var el = document.getElementById(elId); if (!el) return;
    if (!items.length) { el.innerHTML = '<div class="empty-note">Keine Daten</div>'; return; }
    var sum = items.reduce(function (s, it) { return s + it.value; }, 0);
    var maxVal = items.reduce(function (m, it) { return it.muted ? m : Math.max(m, it.value); }, 0) || 1;
    var body = items.map(function (it) {
      var cls = ((it.muted ? "muted-row " : "") + (it.key ? "clickable" : "") + (it.selected ? " selected" : "")).trim();
      var attr = it.key ? ' data-key="' + esc(it.key) + '" tabindex="0" role="button"' : "";
      var tip = it.key ? ' data-tip="' + esc(it.name + " — anklicken zum Filtern") + '"' : "";
      var anteil = total ? pct(it.value, total) + " %" : "";
      var bar = it.muted ? "" : '<span class="sumbar"><i style="width:' + (it.value / maxVal * 100).toFixed(1) + '%"></i></span>';
      var sw = it.swatch ? '<span class="cat-sw" style="background:' + it.swatch + '"></span>' : '';
      return '<tr class="' + cls + '"' + attr + tip + '><td>' + sw + esc(it.name) + '</td>' +
             '<td class="bar-col">' + bar + '</td>' +
             '<td class="num">' + fmtVal(it.value) + '</td><td class="num">' + anteil + '</td></tr>';
    }).join("");
    var totalRow = showTotal ? '<tr class="total"><td>Total</td><td class="bar-col"></td><td class="num">' + fmtVal(sum) + '</td><td class="num">' + (total ? pct(sum, total) + " %" : "") + '</td></tr>' : "";
    var anteilTh = "Anteil" + (anteilHint ? ' <span class="ftip" tabindex="0" role="img" aria-label="' + esc(anteilHint) + '" data-tip="' + esc(anteilHint) + '">ⓘ</span>' : "");
    el.innerHTML = '<table class="sumtbl"><thead><tr><th>Kategorie</th><th class="bar-col"></th><th class="num">' + (valHeader || "") +
                   '</th><th class="num">' + anteilTh + '</th></tr></thead><tbody>' + body + totalRow + '</tbody></table>';
  }

  // ---- Total parcel area grouped by an arbitrary field (Portfolio, Region) → bar items ----
  var BAR_COLOR = "#6f8aac"; // a single calm hue for the Portfolio/Region bars — color reserved for emphasis elsewhere
  function groupBarItems(rows, field, selMap, topN, labelFn) {
    var map = {};
    rows.forEach(function (p) {
      var v = p[field]; var k = (v == null || v === "") ? "—" : String(v);
      map[k] = (map[k] || 0) + num(p.parcel_area_m2);
    });
    var keys = Object.keys(map).filter(function (k) { return map[k] > 0; }).sort(function (a, b) { return map[b] - map[a]; });
    var items = keys.slice(0, topN).map(function (k, i) {
      return { name: labelFn ? labelFn(k) : k, value: map[k], color: BAR_COLOR, key: (k === "—" ? null : k), selected: !!(selMap && selMap[k]) };
    });
    if (keys.length > topN) {
      var rest = keys.slice(topN).reduce(function (s, k) { return s + map[k]; }, 0);
      items.push({ name: "Übrige (" + (keys.length - topN) + ")", value: rest, swatch: "#cbd5e1" });
    }
    return items;
  }

  // ---- Render KPIs + charts + footer from an aggregate ----
  function renderDashboard(rows) {
    var a = aggregate(rows);
    var ofArea = function (v) { return pct(v, a.totals.parcelArea) + "% der Grundstücksfläche"; };
    var ofCover = function (v) { return pct(v, a.classified) + "% der Bodenbedeckung"; };
    var kpis = [
      { label:"Grundstücke", value:fmt(a.len), sub:fmt(a.withData) + " mit Bodenbedeckung (" + pct(a.withData, a.len) + "%)",
        tip:"Anzahl Grundstücke (Liegenschaften und SDR) in der aktuellen Auswahl. Davon " + fmt(a.withData) + " mit Bodenbedeckung. " +
            "Entspricht " + pct(a.len, PARCELS.length) + "% des Datensatzes (" + fmt(PARCELS.length) + " Grundstücke)." },
      { label:"Grundstücksfläche", value:fmtAreaU(a.totals.parcelArea), sub:fmt(a.len) + " Grundstücke",
        tip:"Summe der berechneten Grundstücksflächen (GSF) — 2D-Planfläche auf LV95 (EPSG:2056). " +
            "Klassifizierte Bodenbedeckung: " + fmtAreaU(a.classified) + " (" + ofArea(a.classified) + ")." },
      { label:"Grünfläche", value:fmtAreaU(a.totals.Green), sub:ofCover(a.totals.Green),
        tip:"Humusierte und bestockte Flächen gemäss Grünflächen-Klassifizierung. Aktuell " + ofCover(a.totals.Green) + " bzw. " + ofArea(a.totals.Green) + "." },
      { label:"Versiegelte Fläche", value:fmtAreaU(a.totals.Sealed), sub:ofCover(a.totals.Sealed),
        tip:"Gebäude und befestigte Flächen (versiegelt). Aktuell " + ofCover(a.totals.Sealed) + " bzw. " + ofArea(a.totals.Sealed) + "." },
      { label:"Gebäudegrundfläche (GGF)", value:fmtAreaU(a.totals.GGF), sub:ofCover(a.totals.GGF),
        tip:"Gebäudegrundfläche nach SIA 416 (GGF). Aktuell " + ofCover(a.totals.GGF) + " bzw. " + ofArea(a.totals.GGF) + "." }
    ];
    document.getElementById("kpis").innerHTML = kpis.map(function (k) {
      return '<div class="card"><div class="label tip-term" data-tip="' + esc(k.tip) + '">' + k.label + '</div>' +
             '<div class="value">' + k.value + '</div><div class="sub">' + k.sub + '</div></div>';
    }).join("");

    // Bodenbedeckung nach Art (top 12 + Übrige) as a summary table.
    var artItems = Object.keys(a.byArt).filter(function (k) { return a.byArt[k] > 0; }).map(function (k) {
      var label = ART_LABELS[k] || k, main = ART_MAIN[k] || "";
      return {
        name: (main && main !== label) ? main + " · " + label : label,
        value: a.byArt[k], swatch: mainColor(k), key: k, selected: !!filters.arts[k]
      };
    }).sort(function (x, y) { return y.value - x.value; });
    var artShown = artItems.slice(0, 12);
    if (artItems.length > 12) {
      var artRest = artItems.slice(12).reduce(function (s, it) { return s + it.value; }, 0);
      artShown.push({ name: "Übrige (" + (artItems.length - 12) + ")", value: artRest, swatch: "#cbd5e1" });
    }
    var gsfHint = "Anteil an der gesamten Grundstücksfläche (GSF) der Auswahl.";
    var pa = a.totals.parcelArea;
    // Append a muted "remainder" row so each table sums to 100 % of the Grundstücksfläche;
    // the gap = parcel area the categories don't cover (z. B. ohne Bodenbedeckungsdaten).
    function withMiss(items, label) {
      var s = 0; items.forEach(function (it) { s += it.value; });
      var m = pa - s;
      return m > 0 ? items.concat([{ name: label || "Ohne Bodenbedeckung", value: m, muted: true }]) : items;
    }
    renderValTable("tbl-art", withMiss(artShown), pa, fmtArea, true, unitLabel(), gsfHint);
    renderValTable("tbl-sia", withMiss([
      { name:"GGF · Gebäudegrundfläche", value:a.totals.GGF, key:"GGF", selected:!!filters.has.GGF },
      { name:"BUF · bearbeitete Umgebung", value:a.totals.BUF, key:"BUF", selected:!!filters.has.BUF },
      { name:"UUF · unbearbeitete Umgebung", value:a.totals.UUF, key:"UUF", selected:!!filters.has.UUF }
    ]), pa, fmtArea, true, unitLabel(), gsfHint);
    // "Versiegelung" as the binary AV imperviousness view (CLASSIFICATION.md): versiegelt ja/nein.
    // Versiegelt = Gebäude + befestigt; Unversiegelt = übrige klassifizierte Bodenbedeckung.
    renderValTable("tbl-gsv", withMiss([
      { name:"Versiegelt", value:a.totals.Sealed, key:"Sealed", selected:!!filters.has.Sealed },
      { name:"Unversiegelt", value:Math.max(0, a.classified - a.totals.Sealed) }
    ]), pa, fmtArea, true, unitLabel(), gsfHint);
    renderValTable("tbl-vbs", withMiss([
      { name:"A · Siedlungsfläche", value:a.totals.VBSa },
      { name:"B · Landwirtschaftsfläche", value:a.totals.VBSb },
      { name:"C · Bestockte Fläche", value:a.totals.VBSc },
      { name:"D · Unproduktive Fläche", value:a.totals.VBSd }
    ]), pa, fmtArea, true, unitLabel(), gsfHint);
    renderValTable("tbl-vbsprod", withMiss([
      { name:"VBS produktiv", value:a.totals.VBSp },
      { name:"VBS unproduktiv", value:a.totals.VBSu }
    ]), pa, fmtArea, true, unitLabel(), gsfHint);
    // "Ohne Bauzone" is the zone-free remainder — render it as the muted last row
    // (via withMiss), not as a normal zone, so the table reads like before but now
    // sums to 100 % from real data (processing emits an "Ohne Bauzone" polygon).
    var bzItems = bauzoneListAll.filter(function (z) { return z !== "ohne_bauzone"; })
      .map(function (z) { return { name: bzLabel(z), value: a.byBauzone[z] || 0, swatch: bzColor(z), key: z, selected: !!filters.bauzonen[z] }; })
      .filter(function (it) { return it.value > 0; }).sort(function (x, y) { return y.value - x.value; });
    var bzShown = bzItems.slice(0, 10);
    if (bzItems.length > 10) { var bzRest = bzItems.slice(10).reduce(function (s, it) { return s + it.value; }, 0); bzShown.push({ name: "Übrige (" + (bzItems.length - 10) + ")", value: bzRest, swatch: "#cbd5e1" }); }
    renderValTable("tbl-bauzonen", withMiss(bzShown, "Ohne Bauzone"), pa, fmtArea, true, unitLabel(), gsfHint);
    if (habitatListAll.length) {
      var hbItems = habitatListAll.map(function (h) { return { name: hbLabel(h), value: a.byHabitat[h] || 0, swatch: habColor(h) }; })
        .filter(function (it) { return it.value > 0; }).sort(function (x, y) { return y.value - x.value; });
      renderValTable("tbl-habitat", withMiss(hbItems, "Ohne Lebensraum-Daten"), pa, fmtArea, true, unitLabel(), gsfHint);
    }
    renderValTable("tbl-tpf", groupBarItems(rows, "input_tpf", filters.tpf, 12, tpfLabel), a.totals.parcelArea, fmtArea, true, unitLabel(), gsfHint);
    renderValTable("tbl-rg", groupBarItems(rows, "input_rg", filters.cantons, 12), a.totals.parcelArea, fmtArea, true, unitLabel(), gsfHint);

    var qa = "";
    if (a.wfsIssues || a.geomIssues) {
      var parts = [];
      if (a.wfsIssues) parts.push(fmt(a.wfsIssues) + " mit Datenabruf-Hinweis");
      if (a.geomIssues) parts.push(fmt(a.geomIssues) + " mit Geometrie-Hinweis");
      qa = "Datenqualität: " + parts.join(", ") + ". ";
    }
    document.getElementById("footer-note").innerHTML =
      "Tabellen-Anteile beziehen sich auf die Grundstücksfläche (GSF); die KPI-Anteile oben auf die klassifizierte Bodenbedeckung (" + fmtAreaU(a.classified) + "). " +
      fmt(a.len - a.withData) + " Grundstücke ohne Bodenbedeckung. " + qa;
  }

  // ---- Datenqualität tab (uses the existing check_* / status columns) ----
  var qProblems = [], qState = { page: 1, pageSize: 25 };
  var qAllProblems = [], qRules = {}, qActiveRule = null; // qActiveRule = a clicked Prüfregel → table shows its fails
  function renderQuality(rows) {
    if (!document.getElementById("q-kpis")) return;
    var c = { found:0, merged:0, not_found:0, invalid:0, error:0 }, cOther = 0, withCov = 0, woCov = 0, wfsIssue = 0, geomIssue = 0;
    var problems = [];
    rows.forEach(function (p) {
      var sk = statusKey(p); if (c[sk] != null) c[sk]++; else cOther++; // e.g. empty check_egrid → "—"
      var cov = isCovered(p); if (cov) withCov++; else woCov++;
      var wfs = p.check_wfs && p.check_wfs !== "ok"; if (wfs) wfsIssue++;
      var geom = p.check_geom && p.check_geom !== "ok"; if (geom) geomIssue++;
      var hint = "";
      if (sk === "not_found") hint = "E-GRID nicht gefunden";
      else if (sk === "invalid") hint = "Ungültige E-GRID";
      else if (sk === "error") hint = "Fehler";
      else if (!cov) hint = "0 m² Bodenbedeckung (kein Datenabruf)";
      else if (geom) hint = "Geometrie-Hinweis";
      else if (wfs) hint = "Datenabruf-Hinweis";
      if (hint) problems.push({ p: p, hint: hint });
    });
    var total = rows.length || 1, foundAll = c.found + c.merged;
    var qk = [
      { label:"E-GRID aufgelöst", value:fmt(foundAll) + " / " + fmt(rows.length), sub:(c.merged ? fmt(c.merged) + " zusammengeführt" : "von der Auswahl") },
      { label:"Ohne Bodenbedeckung", value:fmt(woCov), sub:pct(woCov, total) + "% der Auswahl" },
      { label:"Geometrie-Hinweise", value:fmt(geomIssue), sub:fmt(wfsIssue) + " Datenabruf-Hinweise" }
    ];
    document.getElementById("q-kpis").innerHTML = qk.map(function (k) {
      return '<div class="card"><div class="label">' + esc(k.label) + '</div><div class="value">' + k.value + '</div><div class="sub">' + esc(k.sub) + '</div></div>';
    }).join("");
    renderValTable("q-egrid", [
      { name:"Gefunden", value:c.found + c.merged },
      { name:"Nicht gefunden", value:c.not_found + c.error },
      { name:"Ungültige E-GRID", value:c.invalid },
      { name:"Ohne Status", value:cOther }
    ].filter(function (it) { return it.value > 0; }), rows.length, fmt, true, "Anzahl", "Anteil an der Auswahl (Anzahl Grundstücke).");
    qAllProblems = problems;
    qRules = computeRules(rows);
    // Keep the active rule filter across selection changes, unless it no longer has fails.
    if (qActiveRule && !(qRules[qActiveRule] && qRules[qActiveRule].fails.length)) qActiveRule = null;
    renderRulesTable();
    qState.page = 1; // new selection → back to the first page (mirrors the Übersicht table)
    applyQView();
  }
  // Paginate "Auffällige Grundstücke" — same 25/50/100 pager as the Übersicht table.
  function renderQBody() {
    var tb = document.getElementById("q-tbody"); if (!tb) return;
    var pages = Math.max(1, Math.ceil(qProblems.length / qState.pageSize));
    if (qState.page > pages) qState.page = pages;
    if (qState.page < 1) qState.page = 1;
    var start = (qState.page - 1) * qState.pageSize;
    tb.innerHTML = qProblems.length
      ? qProblems.slice(start, start + qState.pageSize).map(function (x) {
          var p = x.p;
          return "<tr><td>" + esc(p.id || "") + "</td><td>" + (p.egrid ? esc(p.egrid) : '<span class="muted">–</span>') +
                 "</td><td>" + esc(p.input_ort || "") + "</td><td>" + esc(x.hint) + "</td></tr>";
        }).join("")
      : '<tr><td colspan="4" class="empty">Keine Auffälligkeiten in der Auswahl.</td></tr>';
    var info = document.getElementById("q-page-info"), prev = document.getElementById("q-prev"), next = document.getElementById("q-next");
    if (info) info.textContent = "Seite " + qState.page + " von " + pages;
    if (prev) prev.disabled = qState.page <= 1;
    if (next) next.disabled = qState.page >= pages;
  }

  // ---- Datenqualität-Prüfregeln (per Grundstück geprüft, als Regel/Ergebnis/Status) ----
  var RULE_DEFS = [
    { key: "bbCover", name: "Bodenbedeckung deckt Grundstück", tip: "Σ klassifizierte Bodenbedeckung = Grundstücksfläche (Grundstücke mit AV-Daten)." },
    { key: "bzCover", name: "Bauzonen decken Grundstück", tip: "Σ Bauzonen inkl. „Ohne Bauzone“ = Grundstücksfläche." },
    { key: "hbCover", name: "Lebensräume decken Grundstück", tip: "Σ Lebensräume = Grundstücksfläche." },
    { key: "sealgreen", name: "Versiegelt + Grünfläche ≤ Bodenbedeckung", tip: "Versiegelte und Grünflächen sind disjunkte Teilmengen der klassifizierten Bodenbedeckung — ihre Summe darf sie nicht überschreiten (sonst Doppelzählung)." },
    { key: "bounds", name: "Keine Fläche grösser als das Grundstück", tip: "Keine einzelne Bodenbedeckungs-/Zonen-/Lebensraum-Komponente überschreitet die Grundstücksfläche." },
    { key: "egrid", name: "Alle E-GRID aufgelöst", tip: "Keine nicht gefundenen, ungültigen oder fehlerhaften E-GRID." },
    { key: "bzOk", name: "Bauzonen vollständig", tip: "Kein Grundstück mit gekappten/unsicheren Bauzonen-Daten (truncated/partial)." },
    { key: "hbOk", name: "Lebensräume vollständig", tip: "Kein Grundstück mit gekappten/unsicheren Lebensraum-Daten; geschätzte (gap-gefüllte) werden separat ausgewiesen." }
  ];
  // Per-parcel derived scalars for the quality rules and prioritisation. Parcels are
  // immutable, so the wide-column scan runs once per parcel and is cached in a WeakMap
  // (not on the object — keeps it out of exports/the embedded deliverable). This turns
  // the repeated per-render O(columns) scans in computeRules/prioMetrics/prioGate into
  // O(1) lookups. Field semantics mirror the original inline loops exactly:
  //   bzSum    — Σ bauzonen_<slug> EXCLUDING ohne_bauzone (the actual building-zone share)
  //   bzSumAll — Σ bauzonen_<slug> INCLUDING ohne_bauzone (the full parcel partition)
  //   maxComp  — largest single av_/bauzonen_(incl. ohne)/habitat_ piece (NOT the SIA/DIN/
  //              VBS/sealed/green aggregates, which legitimately approach the parcel area)
  var _statsCache = new WeakMap();
  function parcelStats(p) {
    var s = _statsCache.get(p); if (s) return s;
    var bzSum = 0, bzSumAll = 0, hbSum = 0, hbNat = 0, maxComp = 0, nLc = 0, nHb = 0, bzDom = 0, bzDomSlug = "";
    for (var k in p) {
      if (!Object.prototype.hasOwnProperty.call(p, k) || k.slice(-3) !== "_m2") continue;
      var v = num(p[k]);
      var bm = BAUZONE_RE.exec(k);
      if (bm) { bzSumAll += v; if (v > maxComp) maxComp = v; if (bm[1] !== "ohne_bauzone") { bzSum += v; if (v > bzDom) { bzDom = v; bzDomSlug = bm[1]; } } continue; }
      var hm = HABITAT_RE.exec(k);
      if (hm) { hbSum += v; if (v > 0) nHb++; if (v > maxComp) maxComp = v; if (PRIO_NAT_HAB[hm[1]]) hbNat += v; continue; }
      if (k.indexOf("av_") === 0) { if (v > 0) nLc++; if (v > maxComp) maxComp = v; }
    }
    s = { bzSum: bzSum, bzSumAll: bzSumAll, hbSum: hbSum, hbNat: hbNat, maxComp: maxComp, nLc: nLc, nHb: nHb, bzDom: bzDom, bzDomSlug: bzDomSlug };
    _statsCache.set(p, s); return s;
  }
  function computeRules(rows) {
    var R = {}; RULE_DEFS.forEach(function (d) { R[d.key] = { name: d.name, pass: 0, fail: 0, est: 0, fails: [] }; });
    rows.forEach(function (p) {
      var area = num(p.parcel_area_m2), tol = Math.max(1, area * 0.01);
      var nearOK = function (a, b) { return Math.abs(a - b) <= tol; };
      // pass → count; fail → count + remember the parcel so a click can list them.
      var rec = function (key, ok) { if (ok) R[key].pass++; else { R[key].fail++; R[key].fails.push({ p: p, hint: R[key].name }); } };
      var classified = num(p.sia416_ggf_m2) + num(p.sia416_buf_m2) + num(p.sia416_uuf_m2);
      var st = parcelStats(p), sumBz = st.bzSumAll, sumHb = st.hbSum, maxComp = st.maxComp;
      var cov = isCovered(p);
      if (cov) rec("bbCover", nearOK(classified, area));
      if (sumBz > 0 || (!!p.check_bauzonen && p.check_bauzonen !== "error")) rec("bzCover", nearOK(sumBz, area));
      if (sumHb > 0 || (!!p.check_habitat && p.check_habitat !== "error")) rec("hbCover", nearOK(sumHb, area));
      // Versiegelt + Grünfläche are disjoint subsets of the classified cover (can over-count on a bug).
      if (cov) rec("sealgreen", num(p.sealed_m2) + num(p.greenspace_m2) <= classified + tol);
      if (area > 0) rec("bounds", maxComp <= area + tol);
      var sk = statusKey(p);
      rec("egrid", sk === "found" || sk === "merged");
      if (p.check_bauzonen) rec("bzOk", p.check_bauzonen === "ok");
      if (p.check_habitat) {
        if (p.check_habitat === "estimated") { R.hbOk.pass++; R.hbOk.est++; }
        else rec("hbOk", p.check_habitat === "ok");
      }
    });
    return R;
  }
  function renderRulesTable() {
    var el = document.getElementById("q-rules"); if (!el) return;
    var body = RULE_DEFS.map(function (d) {
      var r = qRules[d.key], checked = r.pass + r.fail, status, cls, result, aLabel;
      if (checked === 0) { status = "–"; cls = "rule-na"; result = "keine Daten"; aLabel = "keine Daten"; }
      else if (r.fail === 0) { status = "✓"; cls = "rule-ok"; result = fmt(r.pass) + " / " + fmt(checked) + (r.est ? " · " + fmt(r.est) + " geschätzt" : ""); aLabel = "bestanden"; }
      else { status = "⚠"; cls = "rule-warn"; result = fmt(r.fail) + " von " + fmt(checked) + " abweichend"; aLabel = "Abweichung"; }
      var attr = (r.fail > 0 ? ' class="clickable' + (d.key === qActiveRule ? ' selected' : '') + '" data-rk="' + d.key + '" tabindex="0" role="button"' : '') + ' data-tip="' + esc(d.tip) + '"';
      return '<tr' + attr + '><td>' + esc(d.name) + '</td><td class="num rule-res">' + esc(result) + '</td><td class="rule-status ' + cls + '" role="img" aria-label="' + aLabel + '">' + status + '</td></tr>';
    }).join("");
    el.innerHTML = '<table class="sumtbl rules-tbl"><thead><tr><th>Regel</th><th class="num">Ergebnis</th><th class="rule-status">Status</th></tr></thead><tbody>' + body + '</tbody></table>';
  }
  // Switch the Auffällige-Grundstücke table between all problems and one clicked rule's fails.
  function applyQView() {
    var active = (qActiveRule && qRules[qActiveRule] && qRules[qActiveRule].fails.length) ? qActiveRule : null;
    qActiveRule = active;
    qProblems = active ? qRules[active].fails : qAllProblems;
    var cnt = document.getElementById("q-count");
    if (cnt) {
      if (active) cnt.innerHTML = "Regel »" + esc(qRules[active].name) + "« · " + fmt(qProblems.length) + " · <span class='q-filter-x' id='q-filter-x' role='button' tabindex='0'>✕ Filter aufheben</span>";
      else cnt.textContent = fmt(qProblems.length) + " " + (qProblems.length === 1 ? "Grundstück" : "Grundstücke");
    }
    renderQBody();
  }

  // ---- Table ----
  var COLUMNS = [
    { key:"id", label:"ID", def:true, tip:"Objektschlüssel BuKr/WE/Grundstk aus SAP." },
    { key:"egrid", label:"E-GRID", def:true, tip:"Eidgenössischer Grundstücksidentifikator (14-stellig). Klick öffnet das Grundstück auf map.geo.admin.ch.",
      render: function (v) {
        if (!v) return '<span class="muted">–</span>';
        var u = "https://map.geo.admin.ch/#/map?lang=de&topic=ech&bgLayer=ch.swisstopo.pixelkarte-farbe" +
                "&layers=ch.swisstopo-vd.stand-oerebkataster&swisssearch=" + encodeURIComponent(v);
        return '<a class="egrid-link" href="' + u + '" target="_blank" rel="noopener" data-tip="Grundstück auf map.geo.admin.ch öffnen (ÖREB-Kataster, neuer Tab)">' + esc(v) + " ↗</a>";
      } },
    { key:"nummer", label:"Grundstück-Nr.", def:false, tip:"Offizielle Grundstücknummer aus der amtlichen Vermessung." },
    { key:"input_ort", label:"Ort", def:true, tip:"Standortgemeinde des Grundstücks." },
    { key:"input_plz", label:"PLZ", def:false, tip:"Postleitzahl." },
    { key:"input_rg", label:"Kanton", def:true, tip:"Kanton (Region)." },
    { key:"input_bez. grundstück", label:"Bezeichnung", def:true, tip:"Bezeichnung des Grundstücks aus SAP." },
    { key:"input_eigent.art", label:"Eigentumsart", def:false, tip:"Eigentumsart aus SAP (1 = Eigentum Bund, 3 = Anmiete, 5 = Spezialfall).", render: function (v) { return v ? esc(eigentumLabel(v)) : '<span class="muted">–</span>'; } },
    { key:"input_tpf", label:"Teilportfolio", def:false, tip:"Teilportfolio (GOM) aus SAP.", render: function (v) { return v ? esc(tpfLabel(v)) : '<span class="muted">–</span>'; } },
    { key:"check_egrid", label:"Status", def:false, tip:"E-GRID-Status (gefunden / zusammengeführt / nicht gefunden)." },
    { key:"parcel_area_m2", label:"Grundstücksfläche m²", num:true, def:true, tip:"Berechnete Grundstücksfläche (GSF) — 2D-Planfläche auf LV95." },
    { key:"sia416_ggf_m2", label:"GGF m²", num:true, def:true, tip:"Gebäudegrundfläche nach SIA 416." },
    { key:"sia416_buf_m2", label:"BUF m²", num:true, def:false, tip:"Bearbeitete Umgebungsfläche nach SIA 416 (befestigt + humusiert)." },
    { key:"sia416_uuf_m2", label:"UUF m²", num:true, def:false, tip:"Unbearbeitete Umgebungsfläche nach SIA 416 (Gewässer + bestockt + vegetationslos)." },
    { key:"greenspace_m2", label:"Grünfläche m²", num:true, def:true, tip:"Grünfläche (humusiert + bestockt)." },
    { key:"sealed_m2", label:"Versiegelt m²", num:true, def:true, tip:"Versiegelte Fläche (Gebäude + befestigt)." },
    { key:"vbs_produktiv_m2", label:"VBS produktiv m²", num:true, def:false, tip:"Biologisch produktive Fläche (VBS-Klassifizierung)." },
    { key:"vbs_unproduktiv_m2", label:"VBS unproduktiv m²", num:true, def:false, tip:"Biologisch unproduktive Fläche (VBS-Klassifizierung)." }
  ];
  var colByKey = {};
  COLUMNS.forEach(function (c) { colByKey[c.key] = c; c.visible = c.def; });

  var deCollator = new Intl.Collator("de"); // reused — constructing a collator per comparison is costly at 260k rows
  function sortRows() {
    var key = state.sort, dir = state.dir, isNum = colByKey[key] && colByKey[key].num;
    state.rows.sort(function (a, b) {
      var x = a[key], y = b[key];
      if (isNum) { return (num(x) - num(y)) * dir; }
      return deCollator.compare(String(x == null ? "" : x), String(y == null ? "" : y)) * dir;
    });
  }
  function renderHead() {
    var vis = COLUMNS.filter(function (c) { return c.visible; });
    document.getElementById("thead-row").innerHTML = vis.map(function (c) {
      var sorted = state.sort === c.key;
      var arrow = sorted ? ' <span class="arrow">' + (state.dir < 0 ? "▼" : "▲") + "</span>" : "";
      var tip = c.tip ? ' data-tip="' + esc(c.tip) + '"' : "";
      var cls = (c.num ? "num" : "") + (sorted ? " sorted" : "");
      var lbl = c.num ? stripM2(c.label) + " (" + unitLabel() + ")" : c.label;
      return '<th class="' + cls + '" scope="col" tabindex="0" aria-sort="' + (sorted ? (state.dir < 0 ? "descending" : "ascending") : "none") + '" data-key="' + esc(c.key) + '"' + tip + ">" + esc(lbl) + arrow + "</th>";
    }).join("");
  }
  function renderBody() {
    var vis = COLUMNS.filter(function (c) { return c.visible; });
    if (!state.rows.length) {
      document.getElementById("tbody").innerHTML = '<tr><td class="empty" colspan="' + vis.length + '">Keine Grundstücke entsprechen den Filtern.</td></tr>';
      return;
    }
    var start = (state.page - 1) * state.pageSize;
    var pageRows = printing ? state.rows : state.rows.slice(start, start + state.pageSize);
    document.getElementById("tbody").innerHTML = pageRows.map(function (p) {
      var pid = (p.id == null ? "" : String(p.id));
      var sel = (selectedParcelId && pid === selectedParcelId) ? ' class="row-selected"' : "";
      return '<tr data-id="' + esc(pid) + '" tabindex="0"' + sel + ">" + vis.map(function (c) {
        var v = p[c.key];
        if (c.num) return '<td class="num">' + (num(v) ? fmtArea(num(v)) : '<span class="muted">0</span>') + "</td>";
        if (c.render) return "<td>" + c.render(v == null ? "" : String(v), p) + "</td>";
        var s = (v == null || v === "") ? "" : String(v);
        return "<td" + (s ? "" : ' class="muted"') + ">" + (s ? esc(s) : "–") + "</td>";
      }).join("") + "</tr>";
    }).join("");
  }
  function renderPager() {
    var total = state.rows.length, pages = Math.max(1, Math.ceil(total / state.pageSize));
    if (state.page > pages) state.page = pages;
    document.getElementById("page-info").textContent = "Seite " + state.page + " von " + pages;
    document.getElementById("prev").disabled = state.page <= 1;
    document.getElementById("next").disabled = state.page >= pages;
    document.getElementById("row-count").textContent =
      fmt(total) + " von " + fmt(PARCELS.length) + " Grundstücken" + (total < PARCELS.length ? " (gefiltert)" : "");
  }
  function renderFoot() {
    var vis = COLUMNS.filter(function (c) { return c.visible; });
    var sums = {};
    vis.forEach(function (c) { if (c.num) sums[c.key] = 0; });
    state.rows.forEach(function (p) { vis.forEach(function (c) { if (c.num) sums[c.key] += num(p[c.key]); }); });
    var labelDone = false;
    document.getElementById("tfoot-row").innerHTML = vis.map(function (c) {
      if (c.num) return '<td class="num">' + fmtArea(sums[c.key]) + "</td>";
      if (!labelDone) { labelDone = true; return "<td>Total · " + fmt(state.rows.length) + " Grundstücke</td>"; }
      return "<td></td>";
    }).join("");
  }
  function renderTable() { renderHead(); renderBody(); renderFoot(); renderPager(); }

  // Select a parcel from the map: highlight its polygon, then page to / highlight its row in
  // whichever table owns the map (Übersicht or Priorisierung). No viewport scroll.
  function selectParcel(id) {
    selectedParcelId = (id == null || id === "") ? null : String(id);
    if (map && mapReady && map.getLayer("parcels-hl")) {
      var hlFilter = ["==", ["get", "id"], selectedParcelId || " "];
      map.setFilter("parcels-hl", hlFilter);
      if (map.getLayer("parcels-hl-casing")) map.setFilter("parcels-hl-casing", hlFilter);
    }
    if (mapMode === "priority") { selectPrioRow(); return; }
    if (!selectedParcelId) { renderBody(); return; }
    var idx = -1;
    for (var i = 0; i < state.rows.length; i++) {
      if (String(state.rows[i].id == null ? "" : state.rows[i].id) === selectedParcelId) { idx = i; break; }
    }
    if (idx < 0) { renderBody(); return; } // parcel is filtered out of the current table
    var page = Math.floor(idx / state.pageSize) + 1;
    if (page !== state.page) { state.page = page; renderPager(); }
    renderBody();
  }
  // Page the Priorisierung table to the selected parcel + re-render (highlights its row).
  function selectPrioRow() {
    if (!selectedParcelId) { renderPrioBody(); return; }
    var idx = -1;
    for (var i = 0; i < prio.selected.length; i++) {
      if (String(prio.selected[i].p.id == null ? "" : prio.selected[i].p.id) === selectedParcelId) { idx = i; break; }
    }
    if (idx < 0) { renderPrioBody(); return; } // parcel isn't in the current Top-N
    var page = Math.floor(idx / prio.pageSize) + 1;
    if (page !== prio.page) prio.page = page;
    renderPrioBody();
  }
  // Click a table row → select the parcel on the map + zoom/pan to frame it.
  function focusParcel(id) { selectParcel(id); zoomToParcel(id); }
  var _parcelById = null;
  function parcelById(id) {
    if (!_parcelById) { _parcelById = {}; PARCELS.forEach(function (p) { _parcelById[String(p.id == null ? "" : p.id)] = p; }); }
    return _parcelById[String(id)];
  }
  function zoomToParcel(id) {
    if (!map || !mapReady || id == null || id === "") return;
    var p = parcelById(id);
    if (p && p._geom) fitMap(rowsToFC([p]), true);
  }

  // ---- Central update: filter → recompute everything ----
  var currentTab = "overview"; // active tab — gates the costly Datenqualität render out of update()
  function update() {
    var rows = getFiltered();
    state.rows = rows;
    sortRows();
    state.page = 1;
    renderDashboard(rows);
    if (currentTab === "quality") renderQuality(rows); // skip the costly rule scan unless the Datenqualität tab is open
    renderTable();
    if (mapMode !== "priority") renderMap(rows); // the priority tab owns the map while active
    var n = activeGroups(), b = document.getElementById("filter-badge");
    if (b) { b.textContent = n; b.classList.toggle("show", n > 0); }
    var filtered = rows.length < PARCELS.length;
    var fk = document.getElementById("flag-kpi"); if (fk) fk.classList.toggle("show", filtered);
    var fq = document.getElementById("flag-q"); if (fq) fq.classList.toggle("show", filtered);
    var fc = document.getElementById("f-count"); if (fc) fc.textContent = fmt(rows.length) + " Grundstücke";
    renderPills();
  }
  function commit() { refitMap = true; writeURL(); update(); }

  // ---- Active-filter pills ----
  var _pillActions = [];
  function buildPills() {
    var pills = [];
    if (state.search.trim()) {
      pills.push({ label: 'Suche: "' + state.search.trim() + '"', remove: function () { state.search = ""; document.getElementById("search").value = ""; } });
    }
    EXCLUDE_RULES.forEach(function (r) {
      if (filters.exclude[r.key] && excludeCounts[r.key] > 0)
        pills.push({ label: "Ohne: " + r.label, remove: function () { delete filters.exclude[r.key]; } });
    });
    Object.keys(filters.cantons).forEach(function (c) {
      pills.push({ label: "Kanton: " + c, remove: function () { delete filters.cantons[c]; } });
    });
    if (filters.coverage === "with") pills.push({ label: "Nur mit Bodenbedeckung", remove: function () { filters.coverage = "all"; } });
    if (filters.coverage === "without") pills.push({ label: "Nur ohne Bodenbedeckung", remove: function () { filters.coverage = "all"; } });
    Object.keys(filters.arts).forEach(function (a) {
      pills.push({ label: "Enthält: " + (ART_LABELS[a] || a), remove: function () { delete filters.arts[a]; } });
    });
    Object.keys(filters.bauzonen).forEach(function (z) {
      pills.push({ label: "Bauzone: " + bzLabel(z), remove: function () { delete filters.bauzonen[z]; } });
    });
    Object.keys(filters.has).forEach(function (m) {
      pills.push({ label: "Enthält: " + HAS_METRICS[m].label, remove: function () { delete filters.has[m]; } });
    });
    Object.keys(filters.tpf).forEach(function (t) {
      pills.push({ label: "Teilportfolio: " + tpfLabel(t), remove: function () { delete filters.tpf[t]; } });
    });
    Object.keys(filters.eigentum).forEach(function (e) {
      pills.push({ label: "Eigentumsart: " + eigentumLabel(e), remove: function () { delete filters.eigentum[e]; } });
    });
    Object.keys(filters.status).forEach(function (s) {
      pills.push({ label: "Status: " + (STATUS_LABELS[s] || s), remove: function () { delete filters.status[s]; } });
    });
    return pills;
  }
  function renderPills() {
    _pillActions = buildPills();
    var row = document.getElementById("pill-row");
    if (!_pillActions.length) { row.innerHTML = ""; row.style.display = "none"; return; }
    row.style.display = "flex";
    row.innerHTML = _pillActions.map(function (p, i) {
      return '<span class="pill">' + esc(p.label) + '<button class="pill-x" data-i="' + i + '" aria-label="Filter entfernen">✕</button></span>';
    }).join("") + '<button class="pill-reset" id="pill-reset">Alle Filter zurücksetzen</button>';
  }

  // ---- Reset & drawer sync ----
  function resetAll() {
    filters = defaultFilters();
    state.search = ""; document.getElementById("search").value = "";
    syncDrawer(); commit();
  }
  function syncDrawer() {
    renderExclude(); renderStatus(); renderCantons(); renderArts(); renderBauzonen(); renderTpf(); renderEigentum();
    var cov = document.querySelector('#f-coverage input[value="' + filters.coverage + '"]');
    if (cov) cov.checked = true;
  }

  // ---- URL <-> filter state ----
  // Explicit model: every active filter is its own URL parameter; removing a
  // filter drops its parameter. A URL with no filter params means "no filters";
  // a completely empty URL (first visit) applies the defaults and stamps them in.
  var URL_KEYS = ["q", "excl", "status", "eig", "cov", "kanton", "art", "bauz", "has", "tpf"];
  function writeURL() {
    var pr = new URLSearchParams();
    if (state.search.trim()) pr.set("q", state.search.trim());
    var excl = EXCLUDE_RULES.filter(function (r) { return filters.exclude[r.key]; }).map(function (r) { return r.key; });
    if (excl.length) pr.set("excl", excl.join(","));
    var st = Object.keys(filters.status); if (st.length) pr.set("status", st.join(","));
    var eig = Object.keys(filters.eigentum); if (eig.length) pr.set("eig", eig.join(","));
    if (filters.coverage !== "all") pr.set("cov", filters.coverage);
    var cant = Object.keys(filters.cantons); if (cant.length) pr.set("kanton", cant.join(","));
    var art = Object.keys(filters.arts); if (art.length) pr.set("art", art.join(","));
    var bauz = Object.keys(filters.bauzonen); if (bauz.length) pr.set("bauz", bauz.join(","));
    var has = Object.keys(filters.has); if (has.length) pr.set("has", has.join(","));
    var tpf = Object.keys(filters.tpf); if (tpf.length) pr.set("tpf", tpf.join(","));
    var qs = pr.toString();
    try { history.replaceState(null, "", qs ? "?" + qs : location.pathname); } catch (e) { /* file:// may block */ }
  }
  // Returns true if defaults were applied (empty URL) and should be written back.
  function readURL() {
    var pr = new URLSearchParams(location.search);
    if (!URL_KEYS.some(function (k) { return pr.has(k); })) {
      filters = defaultFilters(); state.search = ""; document.getElementById("search").value = ""; return true;
    }
    var validExcl = defaultExclude();
    state.search = pr.get("q") || "";
    document.getElementById("search").value = state.search;
    filters.exclude = {}; (pr.get("excl") || "").split(",").forEach(function (k) { if (k && validExcl[k]) filters.exclude[k] = true; });
    filters.status = {}; (pr.get("status") || "").split(",").forEach(function (s) { if (s) filters.status[s] = true; });
    filters.eigentum = {}; (pr.get("eig") || "").split(",").forEach(function (e) { if (e) filters.eigentum[e] = true; });
    var cov = pr.get("cov"); filters.coverage = (cov === "with" || cov === "without") ? cov : "all";
    filters.cantons = {}; (pr.get("kanton") || "").split(",").forEach(function (c) { if (c) filters.cantons[c] = true; });
    filters.arts = {}; (pr.get("art") || "").split(",").forEach(function (a) { if (a) filters.arts[a] = true; });
    filters.bauzonen = {}; (pr.get("bauz") || "").split(",").forEach(function (z) { if (z) filters.bauzonen[z] = true; });
    filters.has = {}; (pr.get("has") || "").split(",").forEach(function (m) { if (m && HAS_METRICS[m]) filters.has[m] = true; });
    filters.tpf = {}; (pr.get("tpf") || "").split(",").forEach(function (t) { if (t) filters.tpf[t] = true; });
    return false;
  }

  // ---- Chart click → toggle the matching "Enthält" filter; pill click → remove/reset ----
  function chartToggle(elId, facet) {
    var el = document.getElementById(elId); if (!el) return;
    var act = function (e) {
      if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
      var row = e.target.closest && e.target.closest("[data-key]"); if (!row) return;
      if (e.type === "keydown") e.preventDefault(); // Space would scroll
      var k = row.getAttribute("data-key");
      if (filters[facet][k]) delete filters[facet][k]; else filters[facet][k] = true;
      syncDrawer(); commit();
    };
    el.addEventListener("click", act);
    el.addEventListener("keydown", act); // Enter/Space on a focused row
  }
  chartToggle("tbl-art", "arts");        // per-Art types (summary-table rows)
  chartToggle("tbl-sia", "has");         // GGF / BUF / UUF
  chartToggle("tbl-gsv", "has");         // Grünfläche / Versiegelt
  chartToggle("tbl-bauzonen", "bauzonen"); // ARE-Bauzonentypen
  chartToggle("tbl-tpf", "tpf");         // Portfolio (input_tpf)
  chartToggle("tbl-rg", "cantons");      // Region (input_rg → Kanton-Filter)
  // BAFU Lebensräume fallback: this note shows only when the export has no habitat
  // columns; when it does, renderDashboard's tbl-habitat render (guarded by
  // habitatListAll.length) overwrites it with the real per-TypoCH-L1 table.
  var habEl = document.getElementById("tbl-habitat");
  if (habEl) habEl.innerHTML = '<div class="empty-note">Keine BAFU-Lebensraum-Daten im Export. Mit aktivierter Lebensraum-Analyse exportieren.</div>';

  // In-card tabs (VBS Kategorien/Produktiv · Bauzonen/SIA 416/Versiegelung)
  Array.prototype.forEach.call(document.querySelectorAll(".card-tabs"), function (card) {
    var head = card.querySelector(".ctab-head"); if (!head) return;
    head.addEventListener("click", function (e) {
      var b = e.target.closest(".ctab"); if (!b) return;
      var key = b.getAttribute("data-ctab");
      Array.prototype.forEach.call(head.querySelectorAll(".ctab"), function (t) { var on = t === b; t.classList.toggle("is-active", on); t.setAttribute("aria-pressed", on ? "true" : "false"); });
      Array.prototype.forEach.call(card.querySelectorAll(".ctab-pane"), function (pane) { pane.hidden = pane.getAttribute("data-pane") !== key; });
    });
  });
  document.getElementById("pill-row").addEventListener("click", function (e) {
    if (e.target.id === "pill-reset") { resetAll(); return; }
    var x = e.target.closest(".pill-x"); if (!x) return;
    var i = parseInt(x.getAttribute("data-i"), 10);
    if (_pillActions[i]) { _pillActions[i].remove(); syncDrawer(); commit(); }
  });

  // ---- Column picker ----
  document.getElementById("cols-menu").innerHTML = COLUMNS.map(function (c) {
    return '<label><input type="checkbox" data-key="' + esc(c.key) + '"' + (c.visible ? " checked" : "") + "> " + esc(c.label) + "</label>";
  }).join("");
  document.getElementById("cols-menu").addEventListener("click", function (e) { e.stopPropagation(); });
  document.getElementById("cols-menu").addEventListener("change", function (e) {
    var key = e.target.getAttribute("data-key");
    if (key) { colByKey[key].visible = e.target.checked; renderTable(); }
  });
  document.getElementById("cols-btn").addEventListener("click", function (e) {
    e.stopPropagation(); document.getElementById("cols-menu").classList.toggle("open");
  });
  document.addEventListener("click", function () { document.getElementById("cols-menu").classList.remove("open"); });

  // ---- Sorting / search / pager ----
  (function () {
    function sortAct(e) {
      if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
      var th = e.target.closest("th[data-key]"); if (!th) return;
      if (e.type === "keydown") e.preventDefault();
      var key = th.getAttribute("data-key");
      if (state.sort === key) state.dir = -state.dir;
      else { state.sort = key; state.dir = colByKey[key] && colByKey[key].num ? -1 : 1; }
      sortRows(); state.page = 1; renderTable();
    }
    var th = document.getElementById("thead-row");
    th.addEventListener("click", sortAct); th.addEventListener("keydown", sortAct); // Enter/Space sorts a focused header
  })();
  var searchTimer;
  document.getElementById("search").addEventListener("input", function (e) {
    clearTimeout(searchTimer);
    var v = e.target.value;
    searchTimer = setTimeout(function () { state.search = v; commit(); }, 150);
  });
  // Click or Enter/Space on a row → select the parcel on the map + zoom to it (Übersicht).
  (function () {
    function rowAct(e) {
      if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
      var tr = e.target.closest && e.target.closest("tr[data-id]"); if (!tr) return;
      if (e.type === "keydown") e.preventDefault();
      focusParcel(tr.getAttribute("data-id"));
    }
    var tb = document.getElementById("tbody");
    tb.addEventListener("click", rowAct); tb.addEventListener("keydown", rowAct);
  })();
  document.getElementById("prev").addEventListener("click", function () { if (state.page > 1) { state.page--; renderBody(); renderPager(); } });
  document.getElementById("next").addEventListener("click", function () {
    var pages = Math.ceil(state.rows.length / state.pageSize);
    if (state.page < pages) { state.page++; renderBody(); renderPager(); }
  });
  document.getElementById("page-size").addEventListener("change", function (e) {
    state.pageSize = parseInt(e.target.value, 10); state.page = 1; renderBody(); renderPager();
  });
  // "Auffällige Grundstücke" pager (Datenqualität tab)
  document.getElementById("q-prev").addEventListener("click", function () { if (qState.page > 1) { qState.page--; renderQBody(); } });
  document.getElementById("q-next").addEventListener("click", function () {
    if (qState.page < Math.ceil(qProblems.length / qState.pageSize)) { qState.page++; renderQBody(); }
  });
  document.getElementById("q-page-size").addEventListener("change", function (e) {
    qState.pageSize = parseInt(e.target.value, 10); qState.page = 1; renderQBody();
  });
  // Click a failed Prüfregel → filter "Auffällige Grundstücke" to its parcels (toggle).
  var qRuleAct = function (e) {
    if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
    var tr = e.target.closest && e.target.closest("tr[data-rk]"); if (!tr) return;
    if (e.type === "keydown") e.preventDefault();
    var key = tr.getAttribute("data-rk");
    qActiveRule = (qActiveRule === key) ? null : key;
    qState.page = 1; renderRulesTable(); applyQView();
  };
  document.getElementById("q-rules").addEventListener("click", qRuleAct);
  document.getElementById("q-rules").addEventListener("keydown", qRuleAct);
  document.getElementById("q-count").addEventListener("click", function (e) {
    if (e.target && e.target.id === "q-filter-x") { qActiveRule = null; qState.page = 1; renderRulesTable(); applyQView(); }
  });

  // ---- Filter panel (single column, capped with a "Alle anzeigen" toggle) ----
  var MAX_FILTER = 8;
  var fExpanded = {};
  function chk(attr, key, label, count, checked) {
    return '<label><input type="checkbox" data-' + attr + '="' + esc(key) + '"' + (checked ? " checked" : "") + '>' +
           '<span class="nm">' + esc(label) + '</span><span class="cnt">' + (count || 0) + '</span></label>';
  }
  function capList(id, arr) {
    var el = document.getElementById(id); if (!el) return;
    var exp = fExpanded[id];
    var html = (exp || arr.length <= MAX_FILTER ? arr : arr.slice(0, MAX_FILTER)).join("");
    if (arr.length > MAX_FILTER)
      html += '<button type="button" class="flink show-all" data-fl="' + id + '">' + (exp ? "Weniger anzeigen" : "Alle anzeigen (" + arr.length + ")") + '</button>';
    el.innerHTML = html;
  }
  function renderExclude() { capList("f-exclude", EXCLUDE_RULES.map(function (r) { return chk("x", r.key, r.label, excludeCounts[r.key], filters.exclude[r.key]); })); }
  function renderCantons() { capList("f-cantons", cantonList.map(function (c) { return chk("c", c, c, cantonCounts[c], filters.cantons[c]); })); }
  function renderArts() { capList("f-arts", artListAll.map(function (a) { return chk("a", a, ART_LABELS[a] || a, artParcelCount[a], filters.arts[a]); })); }
  function renderBauzonen() { capList("f-bauzonen", bauzoneListAll.map(function (z) { return chk("z", z, bzLabel(z), bauzoneParcelCount[z], filters.bauzonen[z]); })); }
  function renderTpf() { capList("f-tpf", tpfList.map(function (t) { return chk("t", t, tpfLabel(t), tpfCounts[t], filters.tpf[t]); })); }
  function renderEigentum() { capList("f-eigentum", eigentumList.map(function (e) { return chk("e", e, eigentumLabel(e), eigentumCounts[e], filters.eigentum[e]); })); }
  function renderStatus() { capList("f-status", statusList.map(function (s) { return chk("s", s, STATUS_LABELS[s] || s, statusCounts[s], filters.status[s]); })); }
  document.getElementById("cov-with").textContent = fmt(covWith);
  document.getElementById("cov-without").textContent = fmt(covWithout);

  var _rerenderGroup = { "f-exclude": renderExclude, "f-cantons": renderCantons, "f-arts": renderArts, "f-bauzonen": renderBauzonen, "f-tpf": renderTpf, "f-eigentum": renderEigentum, "f-status": renderStatus };
  document.getElementById("filter-panel").addEventListener("click", function (e) {
    var b = e.target.closest(".show-all"); if (!b) return;
    var id = b.getAttribute("data-fl"); fExpanded[id] = !fExpanded[id];
    if (_rerenderGroup[id]) _rerenderGroup[id]();
  });
  function bindChecklist(id, attr, facet) {
    document.getElementById(id).addEventListener("change", function (e) {
      var k = e.target.getAttribute("data-" + attr); if (k == null) return;
      if (e.target.checked) filters[facet][k] = true; else delete filters[facet][k];
      commit();
    });
  }
  bindChecklist("f-exclude", "x", "exclude");
  bindChecklist("f-cantons", "c", "cantons");
  bindChecklist("f-arts", "a", "arts");
  bindChecklist("f-bauzonen", "z", "bauzonen");
  bindChecklist("f-tpf", "t", "tpf");
  bindChecklist("f-eigentum", "e", "eigentum");
  bindChecklist("f-status", "s", "status");
  document.getElementById("f-coverage").addEventListener("change", function (e) { filters.coverage = e.target.value; commit(); });
  document.getElementById("cant-toggle").addEventListener("click", function () {
    if (Object.keys(filters.cantons).length < cantonList.length) cantonList.forEach(function (c) { filters.cantons[c] = true; });
    else filters.cantons = {};
    renderCantons(); commit();
  });
  document.getElementById("art-clear").addEventListener("click", function () { filters.arts = {}; renderArts(); commit(); });
  document.getElementById("bauz-clear").addEventListener("click", function () { filters.bauzonen = {}; renderBauzonen(); commit(); });
  document.getElementById("tpf-clear").addEventListener("click", function () { filters.tpf = {}; renderTpf(); commit(); });
  var frBtn = document.getElementById("f-reset"); if (frBtn) frBtn.addEventListener("click", resetAll);

  // ---- Tabs ----
  var tabBtns = Array.prototype.slice.call(document.querySelectorAll(".tab"));
  var mapMode = "overview"; // which tab owns the single shared map widget
  function showTab(name) {
    currentTab = name;
    tabBtns.forEach(function (t) {
      var on = t.getAttribute("data-tab") === name;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1; // roving tabindex
    });
    ["overview", "quality", "about", "priority"].forEach(function (n) {
      var panel = document.getElementById("panel-" + n);
      if (panel) panel.hidden = (n !== name);
    });
    if (name === "quality") renderQuality(state.rows); // gated out of update(); render it on demand with the current filtered set
    var mapEl = document.getElementById("map"), resize = function () { if (map && mapReady) setTimeout(function () { map.resize(); }, 30); };
    if (name === "priority") {
      mapMode = "priority";
      var slot = document.getElementById("pr-map-panel"); if (slot && mapEl && mapEl.parentNode !== slot) slot.appendChild(mapEl);
      ensureMap(); refitMap = true; renderPriority(); resize(); // renderPriority renders the selection onto the moved map
    } else if (mapMode === "priority") {
      mapMode = "overview";
      var ov = document.getElementById("ov-map-panel"); if (ov && mapEl && mapEl.parentNode !== ov) ov.appendChild(mapEl);
      refitMap = true; renderMap(state.rows); resize(); // back to the filtered selection
    }
  }
  tabBtns.forEach(function (t) { t.addEventListener("click", function () { showTab(t.getAttribute("data-tab")); }); });
  var tablistEl = document.querySelector(".tabs[role=tablist]");
  if (tablistEl) tablistEl.addEventListener("keydown", function (e) {
    var idx = tabBtns.indexOf(document.activeElement); if (idx < 0) return;
    var n = tabBtns.length, j = idx;
    if (e.key === "ArrowRight") j = (idx + 1) % n; else if (e.key === "ArrowLeft") j = (idx - 1 + n) % n;
    else if (e.key === "Home") j = 0; else if (e.key === "End") j = n - 1; else return;
    e.preventDefault(); showTab(tabBtns[j].getAttribute("data-tab")); tabBtns[j].focus();
  });

  // ---- Priorisierung tab: gate → score (6 percentile signals) → top-N + Kanton cap ----
  var WEIGHT_DEFS = [
    { key: "green", name: "Grünumgebung", def: 25, tip: "Anteil und Menge Grünfläche an der Umgebungsfläche — bevorzugt grünreiche Grundstücke mit Aufwertungspotenzial." },
    { key: "scale", name: "Grösse / Skala", def: 15, tip: "Grösse der Umgebungsfläche (logarithmisch) — grössere Flächen haben tendenziell mehr Wirkung." },
    { key: "urban", name: "Urbane Relevanz", def: 15, tip: "Eignung des dominierenden Bauzonentyps — zentrale und urbane Zonen werden höher gewichtet." },
    { key: "habitat", name: "Lebensräume", def: 10, tip: "Anteil naturnaher Lebensräume an der kartierten BAFU-Lebensraumfläche." },
    { key: "diversity", name: "Strukturvielfalt", def: 5, tip: "Anzahl verschiedener Bodenbedeckungs- bzw. Lebensraumtypen — vielfältigere Grundstücke werden höher bewertet." },
    { key: "quality", name: "Datenqualität", def: 10, tip: "Verlässlichkeit der Daten: amtliche AV-Quelle, vollständige Abdeckung, bestandene Geometrie- und Datenabruf-Prüfung." }
  ];
  // Building-zone relevance for N&W (developed grounds): Arbeits/öffentlich highest.
  var PRIO_BZ_REL = { arbeitszonen: 1, zonen_fuer_oeffentliche_nutzungen: 1, zentrumszonen: 0.9, tourismus_und_freizeitzonen: 0.7, mischzonen: 0.75, wohnzonen: 0.6, eingeschraenkte_bauzonen: 0.5, weitere_bauzonen: 0.4, verkehrszonen_innerhalb_der_bauzonen: 0.3 };
  var PRIO_NAT_HAB = { gewaesser: 1, ufer_feuchtgebiete: 1, gletscher_fels_schutt_geroell: 1, gruenland: 1, krautsaeume_hochstauden_gebuesche: 1, waelder: 1, pionier_ruderalvegetation: 1 };
  var prio = { federal: true, sap: true, ufMin: 1000, bauzone: true, bzMin: 50, topN: 100, cap: true, capN: 20, tpfCap: true, tpfCapN: 30, page: 1, pageSize: 25, weights: {}, selected: [], poolCount: 0, sort: "score", dir: -1 };
  WEIGHT_DEFS.forEach(function (w) { prio.weights[w.key] = w.def; });
  function prioUF(p) { return num(p.sia416_buf_m2) + num(p.sia416_uuf_m2); }
  function prioMetrics(p) {
    var area = num(p.parcel_area_m2), uf = prioUF(p), green = num(p.greenspace_m2);
    var st = parcelStats(p), bzDomSlug = st.bzDomSlug, hbNat = st.hbNat, hbAll = st.hbSum, nLc = st.nLc, nHb = st.nHb;
    // Feasibility: authoritative AV cover is best; no land cover at all = little to survey.
    var q = (p.lc_source === "AV" ? 1 : 0.6);
    if (!isCovered(p)) q -= 0.3;
    if (p.check_geom && p.check_geom !== "ok") q -= 0.2;
    if (p.check_wfs && p.check_wfs !== "ok") q -= 0.2;
    return {
      area: area, uf: uf, green: green,
      greenShare: uf ? Math.min(1, green / uf) : 0,          // a share — clamp at 100 %
      urban: (PRIO_BZ_REL[bzDomSlug] || 0),                  // zone-type fit; Bauzone-share is the gate, not the score
      hbAll: hbAll,                                          // total mapped habitat area (0 = BAFU layer not queried for this parcel)
      natShare: hbAll ? hbNat / hbAll : 0,                   // natural share of MAPPED habitat (robust to partial coverage)
      diversity: Math.max(nLc, nHb),                         // max, not sum — don't double-weight parcels that have both layers
      quality: Math.max(0, q)
    };
  }
  function prioSeg(m) { return m.greenShare >= 0.30 ? "Grün-reich" : m.greenShare >= 0.15 ? "Gemischt" : "Versiegelt"; } // ≥30 % / 15–30 %, per SURVEY_PRIORITIZATION.md
  function prioGate(p) {
    if (prio.federal && String(p["input_eigent.art"]) !== "1") return false;
    if (prio.sap && EXCLUDE_RULES.some(function (r) { return nameMatches(p, r); })) return false;
    if (prioUF(p) < prio.ufMin) return false;
    if (prio.bauzone) {
      var area = num(p.parcel_area_m2), bz = parcelStats(p).bzSum;
      if (!area || bz / area < prio.bzMin / 100) return false;
    }
    return true;
  }
  // Percentile rank in [0,1] within the pool, using midrank for ties so identical
  // values always get the same score (no spurious gradient from array order).
  function pctRanks(vals) {
    var n = vals.length;
    if (n <= 1) return vals.map(function () { return 0.5; }); // a lone candidate has no percentile context
    var idx = vals.map(function (v, i) { return i; }).sort(function (a, b) { return vals[a] - vals[b]; });
    var r = new Array(n), i = 0;
    while (i < n) { var j = i; while (j + 1 < n && vals[idx[j + 1]] === vals[idx[i]]) j++; var mid = ((i + j) / 2) / (n - 1); for (var k = i; k <= j; k++) r[idx[k]] = mid; i = j + 1; }
    return r;
  }
  // Like pctRanks, but null/undefined/non-finite values (e.g. parcels with no habitat
  // data) are excluded from the ranking and scored neutrally (0.5), so missing data is
  // not mistaken for an ecologically poor parcel.
  function pctRanksDefined(vals) {
    var pos = [], defined = [];
    vals.forEach(function (v, i) { if (v != null && isFinite(v)) { pos.push(i); defined.push(v); } });
    var r = []; for (var i = 0; i < vals.length; i++) r[i] = 0.5;
    var dr = pctRanks(defined); pos.forEach(function (origI, k) { r[origI] = dr[k]; });
    return r;
  }
  function prioBlend(a, b, wa) { return a.map(function (v, i) { return wa * v + (1 - wa) * b[i]; }); }
  // The pool + per-parcel metrics + percentile arrays depend only on the selection-funnel
  // gate (federal/SAP/UF/Bauzone), NOT on the weights or Top-N/caps. Cache them on a gate
  // signature so dragging a weight/Top-N/cap slider only recombines + re-sorts (cheap),
  // instead of re-filtering the full dataset and re-ranking 6 signals every input event.
  var _prioBase = null, _prioSig = null;
  function prioBase() {
    var sig = [prio.federal, prio.sap, prio.ufMin, prio.bauzone, prio.bzMin].join("|");
    if (_prioBase && _prioSig === sig) return _prioBase;
    var pool = PARCELS.filter(prioGate);
    var M = pool.map(prioMetrics);
    var sc = {
      green: prioBlend(pctRanks(M.map(function (m) { return m.greenShare; })), pctRanks(M.map(function (m) { return m.green; })), 0.6),
      scale: pctRanks(M.map(function (m) { return Math.log(1 + m.uf); })),
      urban: pctRanks(M.map(function (m) { return m.urban; })),
      habitat: pctRanksDefined(M.map(function (m) { return m.hbAll > 0 ? m.natShare : null; })),
      diversity: pctRanks(M.map(function (m) { return m.diversity; })),
      quality: pctRanks(M.map(function (m) { return m.quality; }))
    };
    _prioSig = sig; _prioBase = { pool: pool, M: M, sc: sc };
    return _prioBase;
  }
  function computePrio() {
    var base = prioBase(), pool = base.pool, M = base.M, sc = base.sc;
    var W = prio.weights, Wsum = WEIGHT_DEFS.reduce(function (s, w) { return s + (W[w.key] || 0); }, 0) || 1;
    var scored = pool.map(function (p, i) {
      return { p: p, m: M[i], score: (W.green * sc.green[i] + W.scale * sc.scale[i] + W.urban * sc.urban[i] + W.habitat * sc.habitat[i] + W.diversity * sc.diversity[i] + W.quality * sc.quality[i]) / Wsum };
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    var out = [], kt = {}, tp = {}, capK = prio.cap ? prio.capN : 0, capT = prio.tpfCap ? prio.tpfCapN : 0;
    for (var i = 0; i < scored.length && out.length < prio.topN; i++) {
      var sp = scored[i].p, k = sp.input_rg || "?", t = (sp.input_tpf == null || sp.input_tpf === "") ? "?" : String(sp.input_tpf);
      if (capK && (kt[k] || 0) >= capK) continue;
      if (capT && (tp[t] || 0) >= capT) continue;
      kt[k] = (kt[k] || 0) + 1; tp[t] = (tp[t] || 0) + 1; out.push(scored[i]);
    }
    out.forEach(function (s, i) { s.rank = i + 1; }); // score-rank, stable across table sorts
    prio.poolCount = pool.length; prio.selected = out;
  }
  function renderPrioWeights() {
    var el = document.getElementById("pr-weights"); if (!el) return;
    el.innerHTML = WEIGHT_DEFS.map(function (w) {
      return '<div class="prio-w"><label for="prw-' + w.key + '"><span>' + esc(w.name) + (w.tip ? ' <span class="ftip" tabindex="0" role="img" aria-label="' + esc(w.tip) + '" data-tip="' + esc(w.tip) + '">ⓘ</span>' : '') + '</span><strong>' + prio.weights[w.key] + '</strong></label>' +
             '<input type="range" id="prw-' + w.key + '" data-wk="' + w.key + '" aria-label="Gewicht ' + esc(w.name) + '" min="0" max="40" step="1" value="' + prio.weights[w.key] + '"></div>';
    }).join("");
  }
  var PRIO_SEGS = ["Grün-reich", "Gemischt", "Versiegelt"], PRIO_SEG_COL = { "Grün-reich": "#7cb342", "Gemischt": "#e0a23c", "Versiegelt": "#8d99a6" };
  // Count of selected parcels grouped by a field (Kanton / Teilportfolio) → renderValTable items, top-N + Übrige.
  function prioCountItems(field, topN, labelFn) {
    var map = {};
    prio.selected.forEach(function (s) { var v = s.p[field], key = (v == null || v === "") ? "—" : String(v); map[key] = (map[key] || 0) + 1; });
    var keys = Object.keys(map).sort(function (a, b) { return map[b] - map[a]; });
    var items = keys.slice(0, topN).map(function (key) { return { name: labelFn ? labelFn(key) : key, value: map[key] }; });
    if (keys.length > topN) { var rest = keys.slice(topN).reduce(function (s, key) { return s + map[key]; }, 0); items.push({ name: "Übrige (" + (keys.length - topN) + ")", value: rest }); }
    return items;
  }
  function renderPriority() {
    if (!document.getElementById("pr-tbody")) return;
    computePrio();
    var n = prio.selected.length, total = n || 1;
    var segCnt = { "Grün-reich": 0, "Gemischt": 0, "Versiegelt": 0 }, sumArea = 0, sumGreen = 0;
    prio.selected.forEach(function (s) { segCnt[prioSeg(s.m)]++; sumArea += num(s.p.parcel_area_m2); sumGreen += num(s.p.greenspace_m2); });
    var card = function (label, value, sub) { return '<div class="card"><div class="label">' + esc(label) + '</div><div class="value">' + value + '</div><div class="sub">' + esc(sub) + '</div></div>'; };
    var segMix = '<div class="prio-stack">' + PRIO_SEGS.map(function (s) { return segCnt[s] ? '<span style="width:' + (100 * segCnt[s] / total).toFixed(1) + '%;background:' + PRIO_SEG_COL[s] + '"></span>' : ""; }).join("") + '</div>' +
      '<div class="prio-legend">' + PRIO_SEGS.map(function (s) { return '<span><i style="background:' + PRIO_SEG_COL[s] + '"></i>' + s + ' ' + fmt(segCnt[s]) + '</span>'; }).join("") + '</div>';
    document.getElementById("pr-kpis").innerHTML =
      card("Kandidaten", fmt(prio.poolCount), "nach Eingrenzung") +
      card("Auswahl", fmt(n), "Top-N " + prio.topN) +
      card("Grundstücksfläche", fmtAreaU(sumArea), fmt(n) + " Grundstücke") +
      card("Grünfläche", fmtAreaU(sumGreen), (sumArea ? pct(sumGreen, sumArea) : 0) + "% der Fläche") +
      '<div class="card prio-seg-card"><div class="label">Segment-Mix der Auswahl</div>' + segMix + '</div>';
    renderValTable("pr-rg", prioCountItems("input_rg", 12), n, fmt, true, "Anzahl", "Anteil an der Auswahl (Anzahl Grundstücke).");
    renderValTable("pr-tpf", prioCountItems("input_tpf", 12, tpfLabel), n, fmt, true, "Anzahl", "Anteil an der Auswahl (Anzahl Grundstücke).");
    document.getElementById("pr-count").textContent = fmt(n) + " von " + fmt(prio.poolCount) + " Kandidaten";
    prio.page = 1; renderPrioHead(); renderPrioBody();
    if (mapMode === "priority") renderMap(prio.selected.map(function (s) { return s.p; })); // selected parcels on the map
  }
  // Rangliste columns — each maps a {p, m, score} row to a sort value (mirrors the Übersicht COLUMNS).
  var PRIO_COLS = [
    { key: "rang",  label: "Rang",        num: true,  val: function (s) { return s.rank; } },
    { key: "id",    label: "ID",          num: false, val: function (s) { return s.p.id || ""; } },
    { key: "egrid", label: "E-GRID",      num: false, val: function (s) { return s.p.egrid || ""; } },
    { key: "ort",   label: "Ort",         num: false, val: function (s) { return s.p.input_ort || ""; } },
    { key: "kt",    label: "Kt",          num: false, val: function (s) { return s.p.input_rg || ""; } },
    { key: "seg",   label: "Segment",     num: true,  val: function (s) { return s.m.greenShare; } }, // by underlying Grün-Anteil
    { key: "uf",    label: "UF",          num: true,  val: function (s) { return s.m.uf; }, tip: "Umgebungsfläche = SIA 416 BUF + UUF (Grundstück ohne Gebäudegrundfläche)." },
    { key: "gruen", label: "Grün&nbsp;%", num: true,  val: function (s) { return s.m.greenShare; }, tip: "Grünanteil an der Umgebungsfläche UF (nicht an der Grundstücksfläche)." },
    { key: "score", label: "Score",       num: true,  val: function (s) { return s.score; }, tip: "Gewichteter Mittelwert von 6 Perzentil-Signalen (0–1); höher = höhere Begehungs-Priorität." }
  ];
  var prioColByKey = {}; PRIO_COLS.forEach(function (c) { prioColByKey[c.key] = c; });
  function renderPrioHead() {
    var tr = document.getElementById("pr-thead-row"); if (!tr) return;
    tr.innerHTML = PRIO_COLS.map(function (c) {
      var sorted = prio.sort === c.key, arrow = sorted ? ' <span class="arrow">' + (prio.dir < 0 ? "▼" : "▲") + "</span>" : "";
      var tip = c.tip ? ' data-tip="' + esc(c.tip) + '"' : "";
      return '<th class="' + (c.num ? "num" : "") + (sorted ? " sorted" : "") + '" scope="col" tabindex="0" aria-sort="' + (sorted ? (prio.dir < 0 ? "descending" : "ascending") : "none") + '" data-key="' + c.key + '"' + tip + ">" + c.label + arrow + "</th>";
    }).join("");
  }
  function renderPrioBody() {
    var tb = document.getElementById("pr-tbody"); if (!tb) return;
    var rows = prio.selected.slice(), col = prioColByKey[prio.sort]; // sort a copy — prio.selected stays score-ranked
    if (col) rows.sort(function (a, b) {
      var x = col.val(a), y = col.val(b);
      return col.num ? (num(x) - num(y)) * prio.dir : deCollator.compare(String(x == null ? "" : x), String(y == null ? "" : y)) * prio.dir;
    });
    var pages = Math.max(1, Math.ceil(rows.length / prio.pageSize));
    if (prio.page > pages) prio.page = pages; if (prio.page < 1) prio.page = 1;
    var start = (prio.page - 1) * prio.pageSize;
    tb.innerHTML = rows.length
      ? rows.slice(start, start + prio.pageSize).map(function (s) {
          var p = s.p, m = s.m, pid = (p.id == null ? "" : String(p.id));
          var rs = (selectedParcelId && pid === selectedParcelId) ? ' class="row-selected"' : "";
          return '<tr data-id="' + esc(pid) + '" tabindex="0"' + rs + "><td>" + s.rank + "</td><td>" + esc(p.id || "") + "</td><td>" + (p.egrid ? esc(p.egrid) : '<span class="muted">–</span>') +
                 "</td><td>" + esc(p.input_ort || "") + "</td><td>" + esc(p.input_rg || "") + "</td><td>" + esc(prioSeg(m)) +
                 "</td><td class='num'>" + fmtArea(m.uf) + "</td><td class='num'>" + Math.round(100 * m.greenShare) + "</td><td class='num'>" + s.score.toFixed(3) + "</td></tr>";
        }).join("")
      : '<tr><td colspan="9" class="empty">Keine Kandidaten — Eingrenzung lockern.</td></tr>';
    var info = document.getElementById("pr-page-info"), prev = document.getElementById("pr-prev"), next = document.getElementById("pr-next");
    if (info) info.textContent = "Seite " + prio.page + " von " + pages;
    if (prev) prev.disabled = prio.page <= 1;
    if (next) next.disabled = prio.page >= pages;
  }
  if (document.getElementById("pr-uf")) {
    renderPrioWeights();
    var prBind = function (id, ev, fn) { var el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
    var _prT; var renderPriorityD = function () { clearTimeout(_prT); _prT = setTimeout(renderPriority, 110); }; // coalesce continuous slider drags (the value label updates immediately)
    prBind("pr-federal", "change", function (e) { prio.federal = e.target.checked; renderPriority(); });
    prBind("pr-sap", "change", function (e) { prio.sap = e.target.checked; renderPriority(); });
    prBind("pr-uf", "input", function (e) { prio.ufMin = +e.target.value; document.getElementById("pr-uf-val").textContent = fmt(prio.ufMin); renderPriorityD(); });
    prBind("pr-bauzone", "change", function (e) { prio.bauzone = e.target.checked; renderPriority(); });
    prBind("pr-bz", "input", function (e) { prio.bzMin = +e.target.value; document.getElementById("pr-bz-val").textContent = prio.bzMin; renderPriorityD(); });
    prBind("pr-topn", "input", function (e) { prio.topN = +e.target.value; document.getElementById("pr-topn-val").textContent = prio.topN; renderPriorityD(); });
    prBind("pr-cap", "change", function (e) { prio.cap = e.target.checked; renderPriority(); });
    prBind("pr-cap-n", "input", function (e) { prio.capN = Math.max(1, +e.target.value || 1); renderPriorityD(); });
    prBind("pr-tcap", "change", function (e) { prio.tpfCap = e.target.checked; renderPriority(); });
    prBind("pr-tcap-n", "input", function (e) { prio.tpfCapN = Math.max(1, +e.target.value || 1); renderPriorityD(); });
    prBind("pr-reset-w", "click", function () { WEIGHT_DEFS.forEach(function (w) { prio.weights[w.key] = w.def; }); renderPrioWeights(); renderPriority(); });
    document.getElementById("pr-weights").addEventListener("input", function (e) {
      var wk = e.target.getAttribute && e.target.getAttribute("data-wk"); if (!wk) return;
      prio.weights[wk] = +e.target.value;
      var st = e.target.previousElementSibling && e.target.previousElementSibling.querySelector("strong"); if (st) st.textContent = prio.weights[wk];
      renderPriorityD();
    });
    var prRowAct = function (e) { // click or Enter/Space a row → select on map + zoom (Priorisierung)
      if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
      var tr = e.target.closest && e.target.closest("tr[data-id]"); if (!tr) return;
      if (e.type === "keydown") e.preventDefault();
      focusParcel(tr.getAttribute("data-id"));
    };
    prBind("pr-tbody", "click", prRowAct); prBind("pr-tbody", "keydown", prRowAct);
    prBind("pr-prev", "click", function () { if (prio.page > 1) { prio.page--; renderPrioBody(); } });
    prBind("pr-next", "click", function () { if (prio.page < Math.ceil(prio.selected.length / prio.pageSize)) { prio.page++; renderPrioBody(); } });
    prBind("pr-page-size", "change", function (e) { prio.pageSize = parseInt(e.target.value, 10); prio.page = 1; renderPrioBody(); });
    prBind("pr-export", "click", function () { var b = document.getElementById("dl-btn"); if (b) b.click(); }); // → öffnet das Download-Fenster (Priorisiert-Bereich)
    var prTh = document.getElementById("pr-thead-row"); // sortable Rangliste columns (mirrors the Übersicht thead)
    function prSortAct(e) {
      if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
      var th = e.target.closest && e.target.closest("th[data-key]"); if (!th) return;
      if (e.type === "keydown") e.preventDefault();
      var key = th.getAttribute("data-key");
      if (prio.sort === key) prio.dir = -prio.dir;
      else { prio.sort = key; prio.dir = prioColByKey[key] && prioColByKey[key].num ? -1 : 1; }
      prio.page = 1; renderPrioHead(); renderPrioBody();
    }
    if (prTh) { prTh.addEventListener("click", prSortAct); prTh.addEventListener("keydown", prSortAct); }
  }

  // ---- Filter panel collapse / expand ----
  var appEl = document.getElementById("app");
  // Mobile (≤900px): the filter panel is an off-canvas drawer toggled from the header (#fp-toggle) + scrim.
  var fpScrim = document.getElementById("fp-scrim"), fpToggle = document.getElementById("fp-toggle");
  function setFpOpen(open) {
    appEl.classList.toggle("fp-open", open);
    if (fpScrim) fpScrim.hidden = !open;
    if (fpToggle) fpToggle.setAttribute("aria-expanded", open ? "true" : "false");
  }
  if (fpToggle) fpToggle.addEventListener("click", function () { setFpOpen(!appEl.classList.contains("fp-open")); });
  if (fpScrim) fpScrim.addEventListener("click", function () { setFpOpen(false); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") setFpOpen(false); });
  document.getElementById("fp-collapse").addEventListener("click", function () {
    // Mobile: "‹" just closes the off-canvas drawer. Desktop: collapse to the vertical rail.
    if (window.matchMedia && window.matchMedia("(max-width: 900px)").matches) setFpOpen(false);
    else { appEl.classList.add("fp-collapsed"); setFpOpen(false); }
  });
  document.getElementById("fp-expand").addEventListener("click", function () { appEl.classList.remove("fp-collapsed"); });
  // Print: render the full filtered set, restore pagination afterwards
  // WebGL canvases don't appear in print output → snapshot the map to an <img> over it for print.
  var _mapPrintImg = null;
  function mapToPrintImage() {
    if (!map || !mapReady) return;
    try {
      var url = map.getCanvas().toDataURL("image/png");
      if (!_mapPrintImg) { _mapPrintImg = document.createElement("img"); _mapPrintImg.className = "map-print-img"; _mapPrintImg.alt = "Kartenausschnitt"; }
      _mapPrintImg.src = url; map.getContainer().appendChild(_mapPrintImg);
    } catch (e) { /* cross-origin tainted canvas — leave it (map prints blank) */ }
  }
  function removeMapPrintImage() { if (_mapPrintImg && _mapPrintImg.parentNode) _mapPrintImg.parentNode.removeChild(_mapPrintImg); }
  window.addEventListener("beforeprint", function () { printing = true; renderBody(); mapToPrintImage(); });
  window.addEventListener("afterprint", function () { printing = false; renderBody(); removeMapPrintImage(); });

  // ---- Hover info tooltips ----
  var tipEl = document.getElementById("tip");
  function showTip(t) {
    var txt = t.getAttribute("data-tip"); if (!txt) return;
    tipEl.textContent = txt;
    var r = t.getBoundingClientRect(), w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    var top = r.top - h - 8; if (top < 8) top = r.bottom + 8;
    var left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8));
    tipEl.style.top = top + "px"; tipEl.style.left = left + "px";
    tipEl.classList.add("show");
  }
  function hideTip() { tipEl.classList.remove("show"); }
  // Info icons (ⓘ) are hover-only — a click on one must not toggle the checkbox/label it sits inside.
  document.addEventListener("click", function (e) { if (e.target.closest && e.target.closest(".ftip")) e.preventDefault(); }, true);
  document.addEventListener("mouseover", function (e) { var t = e.target.closest("[data-tip]"); if (t) showTip(t); });
  document.addEventListener("mouseout", function (e) { if (e.target.closest("[data-tip]")) hideTip(); });
  document.addEventListener("focusin", function (e) { var t = e.target.closest("[data-tip]"); if (t) showTip(t); });
  document.addEventListener("focusout", hideTip);
  // Make the static ⓘ info bubbles keyboard-focusable so the focusin tooltip + SR aria-label reach them
  // (the JS-rendered ftips already carry tabindex/aria-label inline, so they are skipped here).
  Array.prototype.forEach.call(document.querySelectorAll(".ftip[data-tip]:not([aria-label])"), function (el) { el.tabIndex = 0; el.setAttribute("role", "img"); el.setAttribute("aria-label", el.getAttribute("data-tip")); });

  // ---- Export helpers (shared by the download modal + the Priorisierung tab) ----
  // Parcels → GeoJSON features: geometry + all non-internal props (PII stripped on import). WGS84.
  function parcelFeatures(parcels) {
    return parcels.map(function (p) {
      var props = {};
      for (var k in p) { if (Object.prototype.hasOwnProperty.call(p, k) && k.charAt(0) !== "_") props[k] = p[k]; }
      return { type: "Feature", geometry: p._geom || null, properties: props };
    });
  }
  function exportGeojsonRows(parcels, fname) {
    saveBlob(JSON.stringify({ type: "FeatureCollection", features: parcelFeatures(parcels) }), "application/geo+json", fname);
  }
  // Excel: the visible table columns, optionally prefixed with extra columns ({label, key, num}).
  function exportXlsxRows(parcels, fname, sheet, extraCols) {
    return loadXlsx().then(function (XLSX) {
      var cols = (extraCols || []).concat(COLUMNS.filter(function (c) { return c.visible; }));
      var aoa = [cols.map(function (c) { return c.label; })];
      parcels.forEach(function (p) { aoa.push(cols.map(function (c) { return c.num ? num(p[c.key]) : (p[c.key] == null ? "" : String(p[c.key])); })); });
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheet);
      XLSX.writeFile(wb, fname);
    });
  }
  var PRIO_XLSX_COLS = [{ label: "Rang", key: "survey_rank", num: true }, { label: "Score", key: "survey_score", num: true }, { label: "Segment", key: "survey_segment" }];
  // Top-N prioritised parcels as flat rows (incl. _geom) tagged with survey rank / score / segment.
  function prioRows() {
    computePrio();
    return prio.selected.map(function (s, i) {
      var r = {}; for (var k in s.p) { if (Object.prototype.hasOwnProperty.call(s.p, k)) r[k] = s.p[k]; }
      r.survey_rank = i + 1; r.survey_score = +s.score.toFixed(4); r.survey_segment = prioSeg(s.m);
      return r;
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Grundstücksbericht (PDF, A3 hoch) — eine Seite je priorisiertes Grundstück.
  // Vollständig clientseitig: swisstopo-WMS-Bilder (CORS-frei) → Canvas (+ rote
  // Parzellengrenze) → jsPDF. Benötigt Internet (WMS-Bilder + jsPDF vom CDN).
  // ──────────────────────────────────────────────────────────────────────────
  var _jspdfP = null;
  function loadJsPDF() {
    if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
    if (!_jspdfP) _jspdfP = new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js";
      s.onload = function () { res(window.jspdf.jsPDF); };
      s.onerror = function () { _jspdfP = null; rej(new Error("jsPDF konnte nicht geladen werden (Internetverbindung nötig).")); };
      document.head.appendChild(s);
    });
    return _jspdfP;
  }
  function _merc(lon, lat) { var R = 20037508.342789; return [lon * R / 180, Math.log(Math.tan((90 + lat) * Math.PI / 360)) * R / Math.PI]; }
  // WGS84 → LV95 (EPSG:2056) — swisstopo approximate formula (~1 m), for the geo.admin.ch deep-link.
  function wgs84ToLv95(lon, lat) {
    var p = (lat * 3600 - 169028.66) / 10000, l = (lon * 3600 - 26782.5) / 10000;
    var E = 2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l * l * l;
    var N = 1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p * p * p;
    return [E, N];
  }
  function _hexRgb(h) { h = String(h).replace("#", ""); if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2); return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0]; }
  function _eachRing(geom, fn) { if (!geom) return; var ps = geom.type === "MultiPolygon" ? geom.coordinates : geom.type === "Polygon" ? [geom.coordinates] : []; ps.forEach(function (poly) { poly.forEach(fn); }); }
  // swisstopo WMS image for the parcel bbox + a red boundary overlay → JPEG data URL (CORS-clean).
  function reportSectionImage(geom, layers, wPx, hPx, fillsFor, label, pid, checkAbort) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    _eachRing(geom, function (ring) { ring.forEach(function (pt) { var m = _merc(pt[0], pt[1]); if (m[0] < minX) minX = m[0]; if (m[0] > maxX) maxX = m[0]; if (m[1] < minY) minY = m[1]; if (m[1] > maxY) maxY = m[1]; }); });
    if (!isFinite(minX)) return Promise.resolve(null);
    var padX = (maxX - minX) * 0.18 || 40, padY = (maxY - minY) * 0.18 || 40;
    minX -= padX; maxX += padX; minY -= padY; maxY += padY;
    var bw = maxX - minX, bh = maxY - minY, want = wPx / hPx, cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    if (bw / bh < want) { bw = bh * want; minX = cx - bw / 2; maxX = cx + bw / 2; } else { bh = bw / want; minY = cy - bh / 2; maxY = cy + bh / 2; }
    function project(pt) { var m = _merc(pt[0], pt[1]); return [(m[0] - minX) / (maxX - minX) * wPx, (1 - (m[1] - minY) / (maxY - minY)) * hPx]; }
    function fillGeom(ctx, g) { var ps = g.type === "MultiPolygon" ? g.coordinates : g.type === "Polygon" ? [g.coordinates] : []; ps.forEach(function (poly) { ctx.beginPath(); poly.forEach(function (ring) { ring.forEach(function (pt, i) { var q = project(pt); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }); ctx.closePath(); }); ctx.fill("evenodd"); }); }
    var url = "https://wms.geo.admin.ch/?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&FORMAT=image/png&CRS=EPSG:3857&STYLES=&WIDTH=" + wPx + "&HEIGHT=" + hPx + "&LAYERS=" + encodeURIComponent(layers) + "&BBOX=" + [minX, minY, maxX, maxY].join(",");
    return new Promise(function (resolve) {
      var settled = false, to, iv;
      function finish(v) { if (settled) return; settled = true; clearTimeout(to); clearInterval(iv); resolve(v); }
      to = setTimeout(function () { finish(null); }, 20000); // a stalled WMS tile must not hang the whole report
      iv = setInterval(function () { try { if (checkAbort) checkAbort(); } catch (e) { finish(null); } }, 250); // let Abbrechen interrupt an in-flight load
      var img = new Image(); img.crossOrigin = "anonymous";
      img.onload = function () {
        try {
          var cv = document.createElement("canvas"); cv.width = wPx; cv.height = hPx;
          var ctx = cv.getContext("2d"); ctx.drawImage(img, 0, 0, wPx, hPx); ctx.lineJoin = "round";
          if (fillsFor) { ctx.globalAlpha = 0.72; fillsFor([minX, minY, maxX, maxY], pid).forEach(function (fl) { ctx.fillStyle = fl.color; fillGeom(ctx, fl.geometry); }); ctx.globalAlpha = 1; }
          function trace() { _eachRing(geom, function (ring) { ctx.beginPath(); ring.forEach(function (pt, i) { var q = project(pt); if (i) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); }); ctx.closePath(); ctx.stroke(); }); }
          ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = 8.5; trace();
          ctx.strokeStyle = "#d8232a"; ctx.lineWidth = 4.5; trace();
          // centre marker + E-GRID label at the pole of inaccessibility (the parcel's visual centre)
          var pole = poleOfGeom(geom);
          if (pole) {
            var pp = project(pole);
            ctx.beginPath(); ctx.arc(pp[0], pp[1], 12, 0, 2 * Math.PI); ctx.fillStyle = "#d8232a"; ctx.fill(); ctx.lineWidth = 4; ctx.strokeStyle = "#fff"; ctx.stroke();
            ctx.beginPath(); ctx.arc(pp[0], pp[1], 4, 0, 2 * Math.PI); ctx.fillStyle = "#fff"; ctx.fill();
            if (label) {
              ctx.font = "bold 26px Arial, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "top";
              var tw = ctx.measureText(label).width, lx = pp[0], ly = pp[1] + 18, lpad = 9, half = tw / 2 + lpad;
              if (lx - half < 4) lx = half + 4; if (lx + half > wPx - 4) lx = wPx - half - 4;
              ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.fillRect(lx - tw / 2 - lpad, ly, tw + 2 * lpad, 36);
              ctx.fillStyle = "#1f2937"; ctx.fillText(label, lx, ly + 5);
            }
          }
          // scale bar (bottom-left), corrected for Web-Mercator latitude distortion
          var cosLat = Math.cos((pole ? pole[1] : 47) * Math.PI / 180), mPerPx = (maxX - minX) * cosLat / wPx, raw = wPx * 0.22 * mPerPx;
          var p10 = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), nf = raw / p10, D = (nf >= 5 ? 5 : nf >= 2 ? 2 : 1) * p10, barPx = D / mPerPx;
          var bx = 24, by = hPx - 28, dLabel = D >= 1000 ? (D / 1000) + " km" : D + " m";
          ctx.font = "bold 22px Arial, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
          ctx.fillStyle = "rgba(255,255,255,0.82)"; ctx.fillRect(bx - 8, by - 16, barPx + 20 + ctx.measureText(dLabel).width, 32);
          ctx.strokeStyle = "#1f2937"; ctx.fillStyle = "#1f2937"; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + barPx, by); ctx.moveTo(bx, by - 6); ctx.lineTo(bx, by + 6); ctx.moveTo(bx + barPx, by - 6); ctx.lineTo(bx + barPx, by + 6); ctx.stroke();
          ctx.fillText(dLabel, bx + barPx + 8, by + 1);
          finish(cv.toDataURL("image/jpeg", 0.88));
        } catch (e) { finish(null); }
      };
      img.onerror = function () { finish(null); };
      img.src = url;
    });
  }
  function reportSia(p) { return [
    { label: "Gebäudegrundfläche (GGF)", area: num(p.sia416_ggf_m2) },
    { label: "Bearbeitete Umgebung (BUF)", area: num(p.sia416_buf_m2) },
    { label: "Unbearbeitete Umgebung (UUF)", area: num(p.sia416_uuf_m2) }
  ]; }
  function reportLandcover(p) {
    // Full BBArt detail (not collapsed to the 6 Hauptgruppen): "Hauptgruppe · BBArt", coloured by main category.
    return ART_KEYS.map(function (a) {
      return { label: (ART_MAIN[a] && ART_MAIN[a] !== ART_LABELS[a] ? ART_MAIN[a] + " · " : "") + (ART_LABELS[a] || a), area: num(p[artCol(a)]), color: mainColor(a) };
    }).filter(function (r) { return r.area > 0; }).sort(function (x, y) { return y.area - x.area; });
  }
  function reportHabitat(p) {
    var out = []; for (var k in p) { if (Object.prototype.hasOwnProperty.call(p, k)) { var hm = HABITAT_RE.exec(k); if (hm) { var v = num(p[k]); if (v > 0) out.push({ label: hbLabel(hm[1]), area: v, color: habColor(hm[1]) }); } } }
    return out.sort(function (a, b) { return b.area - a.area; });
  }
  // Bauzonen overview (ARE-harmonised Hauptnutzung) for one parcel, mirroring the
  // on-screen Bauzonen table: zones by area; "Ohne Bauzone" is added by reportTable
  // as the remainder (remainderLabel) so the Total reads 100 % of the GSF.
  function reportBauzonen(p) {
    var rows = [];
    for (var k in p) {
      if (!Object.prototype.hasOwnProperty.call(p, k)) continue;
      var bm = BAUZONE_RE.exec(k); if (!bm || bm[1] === "ohne_bauzone") continue;
      var v = num(p[k]); if (v > 0) rows.push({ label: bzLabel(bm[1]), area: v, color: bzColor(bm[1]) });
    }
    rows.sort(function (a, b) { return b.area - a.area; });
    if (rows.length > 4) { var rest = rows.slice(4).reduce(function (s, r) { return s + r.area; }, 0); rows = rows.slice(0, 4); rows.push({ label: "Übrige Bauzonen", area: rest, color: "#cbd5e1" }); }
    return rows;
  }
  var ROWS_PER_TOC = 40;
  // Embedded overlay polygons bucketed by SAP-id → { id: [{geometry, color, bb}] }.
  // Built once (cached); the per-id bucket makes fills lookup O(features-on-parcel),
  // not a full scan of all ~16k–20k overlay features per report section.
  function _overlayIndex(fc, colorFn) {
    var byId = {};
    ((fc && fc.features) || []).forEach(function (f) {
      if (!f || !f.geometry || !f.properties) return; // tolerate a malformed feature instead of crashing the whole PDF
      var mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
      _eachRing(f.geometry, function (ring) { ring.forEach(function (pt) { var m = _merc(pt[0], pt[1]); if (m[0] < mnX) mnX = m[0]; if (m[0] > mxX) mxX = m[0]; if (m[1] < mnY) mnY = m[1]; if (m[1] > mxY) mxY = m[1]; }); });
      var id = String(f.properties.id == null ? "" : f.properties.id);
      (byId[id] || (byId[id] = [])).push({ geometry: f.geometry, color: colorFn(f.properties.art), bb: [mnX, mnY, mxX, mxY] });
    });
    return byId;
  }
  // Overlay polygons for one parcel (by SAP-id, string-normalised) that also fall in the section bbox.
  function _forParcel(idx, b, pid) {
    var list = idx[String(pid == null ? "" : pid)] || [];
    return list.filter(function (it) { return it.bb[0] <= b[2] && it.bb[2] >= b[0] && it.bb[1] <= b[3] && it.bb[3] >= b[1]; });
  }
  function habColorArt(a) { var m = String(a).match(/(\d)/); return (m && HABITAT_L1_COLORS[m[1]]) || "#8e7cc3"; } // TypoCH code → L1 colour
  var _lcIdx = null, _hbIdx = null;
  function landcoverFills(b, pid) { if (_lcIdx === null) _lcIdx = _overlayIndex(OVERLAYS && OVERLAYS.landcover, mainColor); return _forParcel(_lcIdx, b, pid); }
  function habitatFills(b, pid) { if (_hbIdx === null) _hbIdx = _overlayIndex(OVERLAYS && OVERLAYS.habitat, habColorArt); return _forParcel(_hbIdx, b, pid); }
  var REPORT_SECTIONS = [
    { n: "1", title: "Lage & SIA 416", layers: "ch.swisstopo.swissimage", tbl: "SIA 416 (Umgebung)", rows: reportSia },
    { n: "2", title: "Bodenbedeckung (AV)", layers: "ch.swisstopo.pixelkarte-grau", tbl: "Bodenbedeckung", rows: reportLandcover, fills: landcoverFills },
    { n: "3", title: "BAFU Lebensräume", layers: "ch.swisstopo.pixelkarte-grau", tbl: "Lebensräume (TypoCH)", rows: reportHabitat, fills: habitatFills }
  ];
  function reportTable(pdf, x, y, w, title, rows, totalArea, opts) {
    var remLabel = (opts && opts.remainderLabel) || "Ohne Bodenbedeckung";
    var pctX = x + w - 26; // % column right edge; area at x+w
    pdf.setTextColor(31, 41, 55); pdf.setFont("helvetica", "bold"); pdf.setFontSize(11); pdf.text(title, x, y);
    var hy = y + 6.5; // column header row
    pdf.setFont("helvetica", "bold"); pdf.setFontSize(8); pdf.setTextColor(120);
    pdf.text("Kategorie", x, hy); pdf.text("Anteil GSF", pctX, hy, { align: "right" }); pdf.text("Fläche", x + w, hy, { align: "right" });
    pdf.setDrawColor(205); pdf.line(x, hy + 1.6, x + w, hy + 1.6);
    var ry = hy + 6, sum = 0; pdf.setFontSize(9.5);
    function pct(a) { return totalArea ? Math.round(a / totalArea * 100) + "%" : "–"; }
    var rowsSum = rows.reduce(function (s, r) { return s + num(r.area); }, 0), draw = rows.slice();
    if (totalArea > 0 && totalArea - rowsSum > totalArea * 0.005) draw.push({ label: remLabel, area: totalArea - rowsSum, muted: true }); // mirror the on-screen remainder → Total reads 100 %
    draw.forEach(function (r) {
      pdf.setFont("helvetica", "normal");
      if (r.color) { var c = _hexRgb(r.color); pdf.setFillColor(c[0], c[1], c[2]); pdf.setDrawColor(140); pdf.rect(x, ry - 2.9, 3.2, 3.2, "FD"); }
      pdf.setTextColor(r.muted ? 150 : 40); pdf.text(String(r.label), x + (r.color ? 5.5 : 0), ry, { maxWidth: w - 46 });
      pdf.setTextColor(130); pdf.text(pct(num(r.area)), pctX, ry, { align: "right" });
      pdf.setTextColor(r.muted ? 150 : 40); pdf.text(fmtArea(r.area) + " " + unitLabel(), x + w, ry, { align: "right" });
      sum += num(r.area); ry += 5.7;
    });
    pdf.setDrawColor(170); pdf.line(x, ry - 2.6, x + w, ry - 2.6);
    pdf.setFont("helvetica", "bold"); pdf.setTextColor(31, 41, 55);
    pdf.text("Total", x, ry + 1.5); pdf.text(pct(sum), pctX, ry + 1.5, { align: "right" }); pdf.text(fmtArea(sum) + " " + unitLabel(), x + w, ry + 1.5, { align: "right" });
    return ry + 1.5; // bottom baseline — lets a caller stack another table beneath
  }
  function reportDateStr() { var d = new Date(); return ("0" + d.getDate()).slice(-2) + "." + ("0" + (d.getMonth() + 1)).slice(-2) + "." + d.getFullYear(); }
  function reportFooter(pdf, pageNum, totalPages) {
    var M = 12, PW = 297;
    pdf.setDrawColor(225); pdf.line(M, 408, PW - M, 408);
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(8); pdf.setTextColor(120);
    pdf.text("Quellen: Amtliche Vermessung · geodienste.ch · swisstopo · BAFU      Stand " + reportDateStr(), M, 413);
    pdf.text("Seite " + pageNum + " / " + totalPages, PW - M, 413, { align: "right" });
  }
  // Inhaltsverzeichnis / Übersicht as the first page(s).
  function renderTocPages(pdf, rows, tocPages, totalPages) {
    var M = 12, PW = 297, w = PW - 2 * M;
    var cols = [{ t: "Rang", x: M, a: "left" }, { t: "System ID", x: M + 16, a: "left" }, { t: "Ort", x: M + 58, a: "left" }, { t: "Kt", x: M + 120, a: "left" }, { t: "Fläche", x: M + 158, a: "right" }, { t: "Grün %", x: M + 192, a: "right" }, { t: "Score", x: M + 224, a: "right" }, { t: "Seite", x: M + w, a: "right" }];
    for (var pg = 0; pg < tocPages; pg++) {
      if (pg > 0) pdf.addPage();
      pdf.setTextColor(31, 41, 55); pdf.setFont("helvetica", "bold"); pdf.setFontSize(17); pdf.text("Grundstücksbericht", M, 16);
      pdf.setFont("helvetica", "normal"); pdf.setFontSize(9); pdf.setTextColor(120); pdf.text("Bundesamt für Bauten und Logistik BBL", PW - M, 16, { align: "right" });
      pdf.setFontSize(11); pdf.setTextColor(70); pdf.text("Übersicht — " + rows.length + " priorisierte Grundstücke · Stand " + reportDateStr(), M, 24);
      var hy = 34;
      pdf.setFont("helvetica", "bold"); pdf.setFontSize(8.5); pdf.setTextColor(110);
      cols.forEach(function (c) { pdf.text(c.t, c.x, hy, { align: c.a }); });
      pdf.setDrawColor(180); pdf.line(M, hy + 2, PW - M, hy + 2);
      var start = pg * ROWS_PER_TOC, ry = hy + 8;
      rows.slice(start, start + ROWS_PER_TOC).forEach(function (p, j) {
        var gi = start + j, area = num(p.parcel_area_m2), green = num(p.greenspace_m2), gp = area ? Math.round(green / area * 100) : 0;
        pdf.setFont("helvetica", "normal"); pdf.setFontSize(9); pdf.setTextColor(40);
        pdf.text(String(p.survey_rank || (gi + 1)), cols[0].x, ry);
        pdf.text(String(p.id || "-"), cols[1].x, ry, { maxWidth: 40 });
        pdf.text(((p.input_plz ? p.input_plz + " " : "") + (p.input_ort || "-")), cols[2].x, ry, { maxWidth: 58 });
        pdf.text(String(p.input_rg || "-"), cols[3].x, ry);
        pdf.text(fmtArea(area) + " " + unitLabel(), cols[4].x, ry, { align: "right" });
        pdf.text(gp + "%", cols[5].x, ry, { align: "right" });
        pdf.text(p.survey_score != null ? String(p.survey_score) : "-", cols[6].x, ry, { align: "right" });
        pdf.text(String(tocPages + gi + 1), cols[7].x, ry, { align: "right" });
        pdf.setDrawColor(236); pdf.line(M, ry + 2.6, PW - M, ry + 2.6); ry += 7;
      });
      reportFooter(pdf, pg + 1, totalPages);
    }
  }
  // Mini-map: Swiss canton outlines + a red dot at (lon,lat) — drawn top-right of each report page.
  function drawLocatorMap(pdf, x, y, w, h, lon, lat) {
    var CM = window.CH_MAP; if (!CM) return;
    var b = CM.bb, bw = b[2] - b[0], bh = b[3] - b[1], sc = Math.min(w / bw, h / bh);
    var ox = x + (w - bw * sc) / 2, oy = y + (h - bh * sc) / 2;
    function sx(X) { return ox + (X - b[0]) * sc; }
    function sy(Y) { return oy + (Y - b[1]) * sc; }
    pdf.setFillColor(232, 236, 239); pdf.setDrawColor(150); pdf.setLineWidth(0.12);
    CM.polys.forEach(function (poly) {
      if (poly.length < 6) return;
      var x0 = sx(poly[0]), y0 = sy(poly[1]), cxp = x0, cyp = y0, deltas = [];
      for (var i = 2; i < poly.length; i += 2) { var nx = sx(poly[i]), ny = sy(poly[i + 1]); deltas.push([nx - cxp, ny - cyp]); cxp = nx; cyp = ny; }
      pdf.lines(deltas, x0, y0, [1, 1], "FD", true);
    });
    if (lon != null && lat != null) {
      var dx = sx(CM.px[0] * lon + CM.px[1] * lat + CM.px[2]), dy = sy(CM.py[0] * lon + CM.py[1] * lat + CM.py[2]);
      pdf.setFillColor(216, 35, 42); pdf.setDrawColor(255); pdf.setLineWidth(0.4); pdf.circle(dx, dy, 1.7, "FD");
    }
    pdf.setLineWidth(0.2);
  }
  // Fetch the 3 section tiles for one page (the slow, network-bound part — kept separate
  // from drawing so pages can be prefetched with bounded concurrency, see generateParcelReport).
  function fetchPageImages(p, checkAbort) {
    return Promise.all(REPORT_SECTIONS.map(function (sec) {
      return reportSectionImage(p._geom, sec.layers, 1000, 667, sec.fills, p.egrid, p.id, checkAbort);
    }));
  }
  // Draw one already-fetched page (synchronous — jsPDF is single-document/stateful, so pages
  // must be drawn one at a time in order; only the image fetching above runs concurrently).
  function drawReportPage(pdf, p, urls, total, pageNum, totalPages) {
    var M = 12, PW = 297, w = PW - 2 * M;
    pdf.setTextColor(31, 41, 55); pdf.setFont("helvetica", "bold"); pdf.setFontSize(15); pdf.text("Grundstücksbericht", M, 13);
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(9); pdf.setTextColor(120); pdf.text("Bundesamt für Bauten und Logistik BBL", PW - M, 13, { align: "right" });
    pdf.setDrawColor(200); pdf.line(M, 16, PW - M, 16);
    pdf.setTextColor(31, 41, 55); pdf.setFont("helvetica", "bold"); pdf.setFontSize(13); pdf.text("System ID " + (p.id || "-"), M, 22);
    pdf.setFontSize(10.5); pdf.text(p.survey_rank ? ("Rang " + p.survey_rank + " / " + total) : "", PW - M, 22, { align: "right" });
    var bez = p["input_bez. grundstück"] || "";
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(9.5); pdf.setTextColor(90); if (bez) pdf.text(String(bez), M, 27, { maxWidth: w });
    var pole = poleOfGeom(p._geom);
    pdf.setDrawColor(225); pdf.line(M, 30, PW - M, 30);
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(7); pdf.setTextColor(135); pdf.text("Lage in der Schweiz", PW - M - 23.5, 33, { align: "center" });
    drawLocatorMap(pdf, PW - M - 47, 34.5, 47, 28, pole ? pole[0] : null, pole ? pole[1] : null); // locator beside the attribute table
    // clean 2-column key/value table (left block; locator map sits to its right)
    var area = num(p.parcel_area_m2), green = num(p.greenspace_m2), gp = area ? Math.round(green / area * 100) : 0;
    var L = [["Ort", (p.input_plz ? p.input_plz + " " : "") + (p.input_ort || "-")], ["Kanton", p.input_rg || "-"], ["E-GRID", p.egrid || "-"], ["Nummer", p.nummer || "-"], ["Segment", p.survey_segment || "-"]];
    var R = [["Teilportfolio", tpfLabel(p.input_tpf)], ["Eigentumsart", eigentumLabel(p["input_eigent.art"])], ["Grundstücksfläche", fmtArea(area) + " " + unitLabel()], ["Grünfläche", fmtArea(green) + " " + unitLabel() + " (" + gp + "%)"], ["Score", p.survey_score != null ? String(p.survey_score) : "-"]];
    var ty = 35, rowH = 4.8, colW = 108, labW = 30;
    for (var i = 0; i < 5; i++) {
      var yy = ty + i * rowH;
      pdf.setFont("helvetica", "normal"); pdf.setFontSize(8.5); pdf.setTextColor(120);
      pdf.text(L[i][0], M, yy); pdf.text(R[i][0], M + colW, yy);
      pdf.setFont("helvetica", "bold"); pdf.setFontSize(9); pdf.setTextColor(40);
      pdf.text(String(L[i][1]), M + labW, yy, { maxWidth: colW - labW - 4 }); pdf.text(String(R[i][1]), M + colW + labW, yy, { maxWidth: colW - labW - 4 });
    }
    var ly = ty + 5 * rowH + 0.5, lv = pole ? wgs84ToLv95(pole[0], pole[1]) : null;
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(8.5); pdf.setTextColor(120); pdf.text("Karte", M, ly);
    if (lv) { var en = lv[0].toFixed(1) + "," + lv[1].toFixed(1); pdf.setFont("helvetica", "bold"); pdf.setTextColor(191, 31, 37); pdf.textWithLink("Auf map.geo.admin.ch ansehen", M + labW, ly, { url: "https://map.geo.admin.ch/#/map?lang=de&center=" + en + "&z=10&crosshair=marker," + en + "&layers=ch.kantone.cadastralwebmap-farbe&bgLayer=ch.swisstopo.pixelkarte-grau" }); }
    pdf.setDrawColor(225); pdf.line(M, ty + 6 * rowH - 0.5, PW - M, ty + 6 * rowH - 0.5);
    var secY = [73, 184, 295], imgW = 144, imgH = 96, tblX = 163, tblW = 122; // gap before section 1; slightly shorter maps; wider table for detailed labels
    REPORT_SECTIONS.forEach(function (sec, i) {
      var yy = secY[i], dataUrl = urls[i];
      pdf.setFont("helvetica", "bold"); pdf.setFontSize(11.5); pdf.setTextColor(191, 31, 37); pdf.text(sec.n + "   " + sec.title, M, yy);
      pdf.setDrawColor(210);
      if (dataUrl) { pdf.addImage(dataUrl, "JPEG", M, yy + 4, imgW, imgH); pdf.rect(M, yy + 4, imgW, imgH, "S"); }
      else { pdf.setFillColor(245, 246, 247); pdf.rect(M, yy + 4, imgW, imgH, "FD"); pdf.setTextColor(140); pdf.setFontSize(9); pdf.setFont("helvetica", "normal"); pdf.text("Kartenbild nicht verfügbar (Internet?)", M + imgW / 2, yy + 4 + imgH / 2, { align: "center" }); }
      var tblEnd = reportTable(pdf, tblX, yy + 11, tblW, sec.tbl, sec.rows(p), num(p.parcel_area_m2));
      // Section 1: a Bauzonen overview fills the space under the SIA 416 table (no extra map).
      if (i === 0 && bauzoneListAll.length) reportTable(pdf, tblX, tblEnd + 11, tblW, "Bauzonen (ARE)", reportBauzonen(p), num(p.parcel_area_m2), { remainderLabel: "Ohne Bauzone" });
    });
    reportFooter(pdf, pageNum, totalPages);
  }
  // Build the PDF (one A3 page per prioritised parcel) and trigger the download.
  function generateParcelReport(filename, onProgress, token) {
    var rows = prioRows();
    if (!rows.length) return Promise.reject(new Error("Keine priorisierten Grundstücke vorhanden."));
    var tocPages = Math.max(1, Math.ceil(rows.length / ROWS_PER_TOC)), totalPages = tocPages + rows.length;
    var totalSteps = rows.length, done = 0; // one progress tick per parcel page (3 section tiles fetched in parallel)
    function tick(label) { done++; if (onProgress) onProgress(done / totalSteps, label); }
    function checkAbort() { if (token && token.aborted) throw new Error("__ABORT__"); } // thrown between steps → caught as cancellation
    return loadJsPDF().then(function (JsPDF) {
      checkAbort();
      var pdf = new JsPDF({ orientation: "portrait", unit: "mm", format: "a3", compress: true });
      renderTocPages(pdf, rows, tocPages, totalPages);
      // Prefetch section tiles with a sliding window of CONC pages in flight while drawing
      // strictly in order — turns N sequential page-fetches into ~N/CONC wall-clock.
      var CONC = 3, imgP = new Array(rows.length);
      function ensureFetched(i) { if (i < rows.length && !imgP[i]) imgP[i] = fetchPageImages(rows[i], checkAbort); }
      for (var w = 0; w < CONC; w++) ensureFetched(w); // prime the window
      return rows.reduce(function (seq, p, i) {
        return seq.then(function () {
          checkAbort();
          ensureFetched(i);
          return imgP[i].then(function (urls) {
            checkAbort(); // cancelled during fetch → stop before drawing this page
            pdf.addPage();
            drawReportPage(pdf, p, urls, rows.length, tocPages + i + 1, totalPages);
            imgP[i] = null;            // release this page's data URLs
            ensureFetched(i + CONC);   // start the next fetch as this slot frees
            tick("Grundstück " + (i + 1) + " / " + rows.length);
          });
        });
      }, Promise.resolve()).then(function () { checkAbort(); pdf.save(filename); return rows.length; });
    });
  }

  // ---- Download modal (header): offline HTML + GeoJSON/Excel per scope (Alle / Gefiltert / Priorisiert) ----
  (function () {
    var btn = document.getElementById("dl-btn"), modal = document.getElementById("dl-modal"), card = modal.querySelector(".modal-card");
    var titleInput = document.getElementById("dl-title"), hint = document.getElementById("dl-hint"), defHint = hint.textContent, lastFocus = null;
    if (window.DASHBOARD_TITLE) titleInput.value = window.DASHBOARD_TITLE;
    var titleVal = function () { return (titleInput.value || "Auswertung Bodenbedeckung").trim(); };
    var base = function () { return slug(titleVal()); };
    function refreshCounts() {
      computePrio();
      document.getElementById("dl-n-all").textContent = "(" + fmt(PARCELS.length) + ")";
      document.getElementById("dl-n-flt").textContent = "(" + fmt(state.rows.length) + ")";
      document.getElementById("dl-n-prio").textContent = "(" + fmt(prio.selected.length) + ")";
    }
    function bgInert(on) { [document.querySelector("header"), document.getElementById("app"), document.querySelector("footer")].forEach(function (el) { if (!el) return; el.inert = on; if (on) el.setAttribute("aria-hidden", "true"); else el.removeAttribute("aria-hidden"); }); } // hide background from AT/Tab while the dialog is open
    function openModal() { lastFocus = document.activeElement; refreshCounts(); hint.textContent = defHint; modal.hidden = false; bgInert(true); document.getElementById("dl-close").focus(); }
    function closeModal() { modal.hidden = true; bgInert(false); if (lastFocus && lastFocus.focus) lastFocus.focus(); }
    btn.addEventListener("click", openModal);
    document.getElementById("dl-close").addEventListener("click", closeModal);
    modal.addEventListener("click", function (e) { if (e.target === modal) closeModal(); }); // click on the backdrop
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !modal.hidden) closeModal(); });
    card.addEventListener("keydown", function (e) { // simple focus trap so Tab stays inside the dialog
      if (e.key !== "Tab") return;
      // Only truly focusable controls: skip hidden/disabled ones (e.g. the #dl-progress/#dl-abort
      // block is hidden until a download runs — including it would dead-end the trap).
      var f = Array.prototype.filter.call(card.querySelectorAll("button, input, [tabindex]"),
        function (el) { return !el.disabled && el.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    // Run an export, surfacing progress / errors in the hint line; the modal stays open for more downloads.
    function busy(msg, fn) {
      hint.textContent = msg;
      var done = function () { hint.textContent = defHint; }, fail = function (err) { hint.textContent = "Fehler: " + ((err && err.message) || err); };
      var r; try { r = fn(); } catch (err) { fail(err); return; }
      if (r && typeof r.then === "function") r.then(done, fail); else done();
    }
    document.getElementById("dl-html").addEventListener("click", function () {
      busy("HTML wird erstellt…", function () {
        return buildDeliverable(PARCELS, OVERLAYS, titleVal()).then(function (html) { saveBlob(html, "text/html;charset=utf-8", base() + ".html"); })
          .catch(function (err) { throw new Error("HTML-Download benötigt einen Webserver (fetch ist über file:// blockiert). " + err.message); });
      });
    });
    // Scopes — Alle = full dataset · Gefiltert = active side-panel filters · Priorisiert = Top-N (+ survey rank/score/segment).
    document.getElementById("dl-all-geo").addEventListener("click", function () { busy("GeoJSON wird erstellt…", function () { exportGeojsonRows(PARCELS, base() + "-alle.geojson"); }); });
    document.getElementById("dl-all-xlsx").addEventListener("click", function () { busy("Excel wird erstellt…", function () { return exportXlsxRows(PARCELS, base() + "-alle.xlsx", "Grundstücke"); }); });
    document.getElementById("dl-flt-geo").addEventListener("click", function () { busy("GeoJSON wird erstellt…", function () { exportGeojsonRows(state.rows, base() + "-gefiltert.geojson"); }); });
    document.getElementById("dl-flt-xlsx").addEventListener("click", function () { busy("Excel wird erstellt…", function () { return exportXlsxRows(state.rows, base() + "-gefiltert.xlsx", "Grundstücke"); }); });
    document.getElementById("dl-prio-geo").addEventListener("click", function () { busy("GeoJSON wird erstellt…", function () { exportGeojsonRows(prioRows(), base() + "-priorisierung-top" + prio.topN + ".geojson"); }); });
    document.getElementById("dl-prio-xlsx").addEventListener("click", function () { busy("Excel wird erstellt…", function () { return exportXlsxRows(prioRows(), base() + "-priorisierung-top" + prio.topN + ".xlsx", "Priorisierung", PRIO_XLSX_COLS); }); });
    // PDF-Bericht (A3, eine Seite je priorisiertes Grundstück) — Hintergrund-Verarbeitung mit Fortschrittsbalken.
    document.getElementById("dl-pdf").addEventListener("click", function () {
      var pbtn = this, prog = document.getElementById("dl-progress"), bar = document.getElementById("dl-progress-bar"), txt = document.getElementById("dl-progress-txt"), abortBtn = document.getElementById("dl-abort");
      var token = { aborted: false };
      pbtn.disabled = true; prog.hidden = false; bar.style.width = "0%"; txt.textContent = "Wird vorbereitet…"; hint.textContent = "PDF-Bericht wird erstellt — bitte warten.";
      abortBtn.disabled = false; abortBtn.onclick = function () { token.aborted = true; abortBtn.disabled = true; txt.textContent = "Wird abgebrochen…"; };
      generateParcelReport(base() + "-grundstuecksbericht.pdf", function (frac, label) {
        bar.style.width = Math.round(frac * 100) + "%"; txt.textContent = Math.round(frac * 100) + "% · " + (label || "");
      }, token).then(function (n) {
        bar.style.width = "100%"; txt.textContent = "Fertig — " + n + " Seite(n)."; hint.textContent = defHint;
        setTimeout(function () { prog.hidden = true; }, 2500); pbtn.disabled = false;
      }).catch(function (err) {
        var aborted = err && err.message === "__ABORT__";
        txt.textContent = aborted ? "Abgebrochen." : ("Fehler: " + ((err && err.message) || err));
        hint.textContent = aborted ? defHint : "PDF-Bericht fehlgeschlagen.";
        if (aborted) setTimeout(function () { prog.hidden = true; }, 1800);
        pbtn.disabled = false;
      });
    });
  })();

  // ---- "Neue Datei": reload to a clean URL → file picker (served builder) ----
  var bn0 = document.getElementById("btn-new");
  if (bn0) bn0.addEventListener("click", function () { location.href = location.pathname; });

  // ---- Area unit toggle (ha / m²) — display only; re-renders every area number ----
  var unitBtns = Array.prototype.slice.call(document.querySelectorAll("#unit-toggle .unit-btn"));
  function syncUnitUI() { unitBtns.forEach(function (b) { b.classList.toggle("is-active", b.getAttribute("data-unit") === areaUnit); }); }
  unitBtns.forEach(function (b) {
    b.addEventListener("click", function () {
      var u = b.getAttribute("data-unit"); if (u === areaUnit) return;
      areaUnit = u;
      try { localStorage.setItem("dashAreaUnit", u); } catch (e) { /* storage may be blocked */ }
      syncUnitUI(); update();
      if (!document.getElementById("panel-priority").hidden) renderPriority(); // reformat area KPIs + table on unit change
    });
  });
  syncUnitUI();

  // ---- Map: CARTO grey basemap + parcel polygons, poles & clustered ID points ----
  var map = null, mapReady = false, mapFitted = false, refitMap = false, lastRows = [];

  // Pole of inaccessibility (a polygon's "visual center") — ported from @mapbox/polylabel (ISC).
  function _segDistSq(px, py, a, b) {
    var x = a[0], y = a[1], dx = b[0] - x, dy = b[1] - y;
    if (dx !== 0 || dy !== 0) { var t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy); if (t > 1) { x = b[0]; y = b[1]; } else if (t > 0) { x += dx * t; y += dy * t; } }
    dx = px - x; dy = py - y; return dx * dx + dy * dy;
  }
  function _ptPolyDist(x, y, polygon) {
    var inside = false, minSq = Infinity, r, ring, i, len, j, a, b;
    for (r = 0; r < polygon.length; r++) { ring = polygon[r]; for (i = 0, len = ring.length, j = len - 1; i < len; j = i++) { a = ring[i]; b = ring[j];
      if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
      minSq = Math.min(minSq, _segDistSq(x, y, a, b)); } }
    return (inside ? 1 : -1) * Math.sqrt(minSq);
  }
  function _mkCell(x, y, h, polygon) { var d = _ptPolyDist(x, y, polygon); return { x: x, y: y, h: h, d: d, max: d + h * Math.SQRT2 }; }
  function _centroidCell(polygon) {
    var area = 0, x = 0, y = 0, ring = polygon[0], i, len, j, a, b, f;
    for (i = 0, len = ring.length, j = len - 1; i < len; j = i++) { a = ring[i]; b = ring[j]; f = a[0] * b[1] - b[0] * a[1]; x += (a[0] + b[0]) * f; y += (a[1] + b[1]) * f; area += f * 3; }
    return area === 0 ? _mkCell(ring[0][0], ring[0][1], 0, polygon) : _mkCell(x / area, y / area, 0, polygon);
  }
  function poleOf(polygon) {
    var ring = polygon && polygon[0]; if (!ring || !ring.length) return null;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, i, x, y;
    for (i = 0; i < ring.length; i++) { x = ring[i][0]; y = ring[i][1]; if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
    var width = maxX - minX, height = maxY - minY, cellSize = Math.min(width, height);
    if (cellSize === 0) return [minX, minY];
    var prec = Math.max(width, height) / 1000, h = cellSize / 2, heap = [];
    function hpush(c) { heap.push(c); var pos = heap.length - 1; while (pos > 0) { var par = (pos - 1) >> 1; if (heap[par].max >= heap[pos].max) break; var t = heap[par]; heap[par] = heap[pos]; heap[pos] = t; pos = par; } }
    function hpop() { var top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; var pos = 0, n = heap.length; for (;;) { var lg = pos, l = 2 * pos + 1, rr = 2 * pos + 2; if (l < n && heap[l].max > heap[lg].max) lg = l; if (rr < n && heap[rr].max > heap[lg].max) lg = rr; if (lg === pos) break; var t = heap[lg]; heap[lg] = heap[pos]; heap[pos] = t; pos = lg; } } return top; }
    for (x = minX; x < maxX; x += cellSize) for (y = minY; y < maxY; y += cellSize) hpush(_mkCell(x + h, y + h, h, polygon));
    var best = _centroidCell(polygon), bbox = _mkCell(minX + width / 2, minY + height / 2, 0, polygon);
    if (bbox.d > best.d) best = bbox;
    while (heap.length) { var cell = hpop(); if (cell.d > best.d) best = cell; if (cell.max - best.d <= prec) continue; h = cell.h / 2;
      hpush(_mkCell(cell.x - h, cell.y - h, h, polygon)); hpush(_mkCell(cell.x + h, cell.y - h, h, polygon)); hpush(_mkCell(cell.x - h, cell.y + h, h, polygon)); hpush(_mkCell(cell.x + h, cell.y + h, h, polygon)); }
    return [best.x, best.y];
  }
  function poleOfGeom(g) {
    if (!g) return null;
    if (g.type === "Polygon") return poleOf(g.coordinates);
    if (g.type === "MultiPolygon") {
      var best = null, bestA = -1;
      g.coordinates.forEach(function (poly) { var ring = poly[0]; if (!ring) return; var a = 0; for (var i = 0, n = ring.length, j = n - 1; i < n; j = i++) { a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]); } a = Math.abs(a); if (a > bestA) { bestA = a; best = poly; } }); // largest part by true (shoelace) area, not bbox
      return best ? poleOf(best) : null;
    }
    return null;
  }

  function rowsToFC(rows) {
    return { type: "FeatureCollection", features: rows.filter(function (p) { return p && p._geom; }).map(function (p) {
      return { type: "Feature", geometry: p._geom, properties: { id: p.id || "", ort: p.input_ort || "", egrid: p.egrid || "", area: num(p.parcel_area_m2) } };
    }) };
  }
  function rowsToPointsFC(rows) {
    var out = [];
    rows.forEach(function (p) {
      if (!p || !p._geom) return;
      if (p._pole === undefined) p._pole = poleOfGeom(p._geom); // computed once per parcel, then cached
      if (p._pole) out.push({ type: "Feature", geometry: { type: "Point", coordinates: p._pole }, properties: { id: String(p.id || "") } });
    });
    return { type: "FeatureCollection", features: out };
  }
  function fitMap(fc, animate) {
    var minX = 180, minY = 90, maxX = -180, maxY = -90, any = false;
    function walk(c) { if (typeof c[0] === "number") { if (c[0] < minX) minX = c[0]; if (c[0] > maxX) maxX = c[0]; if (c[1] < minY) minY = c[1]; if (c[1] > maxY) maxY = c[1]; any = true; } else for (var i = 0; i < c.length; i++) walk(c[i]); }
    fc.features.forEach(function (f) { if (f.geometry && f.geometry.coordinates) walk(f.geometry.coordinates); });
    if (any && map) map.fitBounds([[minX, minY], [maxX, maxY]], { padding: 30, animate: !!animate, duration: 600, maxZoom: 16 });
  }
  // Overlay features (Bodenbedeckung / Bauzonen / Lebensräume) bucketed by the SAP
  // parcel id they belong to. Built once per overlay key so clipping the overlays to
  // the filtered parcels on each render is a cheap per-parcel lookup, not a full
  // rescan of all ~16k–20k overlay features on every filter change / slider drag.
  var _ovById = {};
  function overlayById(key) {
    if (_ovById[key]) return _ovById[key];
    var byId = {}, fc = OVERLAYS[key];
    ((fc && fc.features) || []).forEach(function (f) {
      var id = String((f.properties && f.properties.id) == null ? "" : f.properties.id);
      (byId[id] || (byId[id] = [])).push(f);
    });
    return (_ovById[key] = byId);
  }
  function renderMap(rows) {
    lastRows = rows;
    if (!mapReady || !map) return;
    var polyFC = rowsToFC(rows);
    var ps = map.getSource("parcels"); if (ps) ps.setData(polyFC);
    var pts = map.getSource("points"); if (pts) pts.setData(rowsToPointsFC(rows));
    // Clip the data overlays to the visible parcels (join on SAP id) so filtering hides
    // the land cover / Bauzonen / Lebensräume of filtered-out parcels too — not just the
    // parcel polygons. Covers both the Übersicht (filtered set) and Priorisierung (Top-N).
    OVERLAY_DEFS.forEach(function (d) {
      var src = map.getSource("ov-" + d.key); if (!src) return;
      var byId = overlayById(d.key), feats = [];
      rows.forEach(function (p) {
        var bucket = byId[String(p.id == null ? "" : p.id)];
        if (bucket) feats.push.apply(feats, bucket);
      });
      src.setData({ type: "FeatureCollection", features: feats });
    });
    // A selected overlay feature may have just been clipped away (and setData regenerates
    // ids anyway), so drop the stale highlight bookkeeping.
    if (_selOv && map.getSource(_selOv.source)) map.setFeatureState(_selOv, { selected: false });
    _selOv = null;
    // Zoom to the (filtered) results: instant on first load, animated on later filter changes.
    if (polyFC.features.length && (refitMap || !mapFitted)) { fitMap(polyFC, mapFitted); mapFitted = true; }
    refitMap = false;
  }
  // Custom "home" control — zoom to the current (filtered) selection.
  function HomeControl() {}
  HomeControl.prototype.onAdd = function (m) {
    this._map = m;
    var div = document.createElement("div");
    div.className = "maplibregl-ctrl maplibregl-ctrl-group";
    var btn = document.createElement("button");
    btn.type = "button"; btn.className = "map-home"; btn.title = "Auf Auswahl zoomen"; btn.setAttribute("aria-label", "Auf Auswahl zoomen");
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v9h5v-6h4v6h5v-9"/></svg>';
    btn.addEventListener("click", function () { if (lastRows && lastRows.length) fitMap(rowsToFC(lastRows), true); });
    div.appendChild(btn); this._container = div; return div;
  };
  HomeControl.prototype.onRemove = function () { if (this._container && this._container.parentNode) this._container.parentNode.removeChild(this._container); this._map = undefined; };

  // ---- Overlay data layers (Bodenbedeckung / Bauzonen / Lebensräume) ----
  // Colours come from the shared maps above: land cover by AV main category,
  // habitat by TypoCH level-1 (the leading code digit), bauzonen one hue.
  var PARCEL_MINZOOM = 11, OVERLAY_MINZOOM = 12; // hide polygons when zoomed out (lighter on small laptops)
  var _landcoverColor = ["match", ["get", "art"]];
  ART_KEYS.forEach(function (a) { _landcoverColor.push(a, mainColor(a)); });
  _landcoverColor.push("#94a3b8");
  var _habitatColor = ["match", ["slice", ["get", "art"], 0, 1]]; // first char of "8.2.3 …" = TypoCH L1
  ["1","2","3","4","5","6","7","8","9"].forEach(function (d) { _habitatColor.push(d, HABITAT_L1_COLORS[d]); });
  _habitatColor.push("#8e7cc3");
  var _bauzonenColor = ["match", ["get", "art"]]; // overlay `art` = harmonised zone name
  Object.keys(BAUZONE_LABELS).forEach(function (z) { _bauzonenColor.push(BAUZONE_LABELS[z], bzColor(z)); });
  _bauzonenColor.push("#9e9e9e");
  var OVERLAY_DEFS = [
    { key: "landcover", label: "Bodenbedeckung", fill: _landcoverColor, line: "#6b7280", opacity: 0.62 },
    { key: "bauzonen", label: "Bauzonen", fill: _bauzonenColor, line: "#888", opacity: 0.5 },
    { key: "habitat", label: "Lebensräume", fill: _habitatColor, line: "#674ea7", opacity: 0.55 }
  ];
  function addOverlayLayers() {
    OVERLAY_DEFS.forEach(function (d) {
      var fc = OVERLAYS[d.key];
      if (!fc || !fc.features || !fc.features.length || map.getSource("ov-" + d.key)) return;
      map.addSource("ov-" + d.key, { type: "geojson", data: fc, generateId: true }); // generateId → feature-state highlight
      map.addLayer({ id: d.key + "-fill", type: "fill", source: "ov-" + d.key, minzoom: OVERLAY_MINZOOM, layout: { visibility: "none" }, paint: { "fill-color": d.fill, "fill-opacity": d.opacity } });
      map.addLayer({ id: d.key + "-line", type: "line", source: "ov-" + d.key, minzoom: OVERLAY_MINZOOM, layout: { visibility: "none" }, paint: {
        "line-color": ["case", ["boolean", ["feature-state", "selected"], false], "#d8232a", d.line],
        "line-width": ["case", ["boolean", ["feature-state", "selected"], false], 2.6, 0.4]
      } });
    });
  }
  // One reusable popup + single-feature highlight, shared by parcels and overlays.
  var _mapPopup = null, _selOv = null;
  function showPopup(lngLat, html) {
    if (!_mapPopup) _mapPopup = new maplibregl.Popup({ closeButton: false });
    _mapPopup.setLngLat(lngLat).setHTML(html).addTo(map);
  }
  function highlightOverlay(source, id) {
    if (_selOv && map.getSource(_selOv.source)) map.setFeatureState(_selOv, { selected: false });
    _selOv = { source: source, id: id };
    map.setFeatureState(_selOv, { selected: true });
  }
  var OVERLAY_NAME = { landcover: "Bodenbedeckung", bauzonen: "Bauzone", habitat: "Lebensraum" };
  function overlayPopupHTML(key, art, area) {
    var label = key === "landcover" ? (ART_LABELS[art] || art) : art;
    return "<strong>" + esc(label || "—") + "</strong><br><span class='pop-sub'>" + esc(OVERLAY_NAME[key] || "") + "</span>" +
           (area ? "<br>" + fmtAreaU(num(area)) : "");
  }

  // ── Parcel detail page (opened in a new tab from the map popup) ────────────
  // Renders every available attribute of one parcel, grouped by topic, into a
  // self-contained HTML document opened via a blob URL — so it works offline from
  // the distributed single-file deliverable (no server, no data fetch). Empty
  // topic sections are omitted; a collapsible "Alle Felder" dumps the raw columns.
  var DETAIL_CSS =
    "*{box-sizing:border-box}" +
    "body{margin:0;font-family:'Noto Sans','Helvetica Neue',Arial,sans-serif;color:#1f2937;background:#eef0f2;font-size:14px;line-height:1.45}" +
    ".head{background:#fff;border-bottom:3px solid #d8232a;padding:16px 24px;overflow:hidden}" +
    ".head .brand{color:#46596b;font-size:12px;letter-spacing:.02em}" +
    ".head h1{margin:.25em 0 .1em;font-size:20px;color:#2f4356}" +
    ".head .sub{color:#5b6b7a;font-size:13px}" +
    ".head .actions{float:right}" +
    ".btn{border:1px solid #cbd5e1;background:#f8fafc;border-radius:4px;padding:6px 12px;cursor:pointer;font:inherit;color:#2f4356}" +
    ".wrap{max-width:980px;margin:20px auto;padding:0 16px;display:flex;flex-direction:column;gap:14px}" +
    ".grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}" +
    "@media(max-width:760px){.grid2{grid-template-columns:1fr}}" +
    ".card{background:#fff;border:1px solid #e3e7eb;border-radius:6px;padding:14px 16px}" +
    ".card h2{margin:0 0 10px;font-size:13px;color:#d8232a;text-transform:uppercase;letter-spacing:.03em;border-bottom:1px solid #eef0f2;padding-bottom:6px}" +
    "table{width:100%;border-collapse:collapse}" +
    ".kv th{text-align:left;font-weight:500;color:#64748b;padding:3px 8px 3px 0;vertical-align:top;width:44%}" +
    ".kv td{padding:3px 0;color:#1f2937;word-break:break-word}" +
    ".at th{font-size:12px;color:#64748b;text-align:left;border-bottom:1px solid #e3e7eb;padding:4px 6px}" +
    ".at td{padding:4px 6px;border-bottom:1px solid #f1f4f6}" +
    ".at .num{text-align:right;white-space:nowrap}" +
    ".at .tot td{font-weight:600;border-top:1px solid #cbd5e1;border-bottom:none}" +
    ".sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:7px;vertical-align:middle}" +
    ".raw summary{cursor:pointer;color:#2f4356;font-weight:600}" +
    ".raw table{margin-top:8px}" +
    ".foot{max-width:980px;margin:6px auto 28px;padding:0 16px;color:#8a97a3;font-size:12px}" +
    "a{color:#d8232a}" +
    "@media print{body{background:#fff}.actions{display:none}.card{break-inside:avoid;border-color:#ccc}}";

  function buildParcelDetailHTML(p) {
    function detailKV(rows) {
      var b = "";
      rows.forEach(function (r) { if (!r) return; b += '<tr><th>' + esc(r[0]) + '</th><td>' + (r[2] ? r[1] : esc(r[1])) + '</td></tr>'; });
      return '<table class="kv">' + b + '</table>';
    }
    function detailAreaTable(items, total) {
      var b = "", sum = 0;
      items.forEach(function (it) {
        sum += it.value;
        var sw = it.swatch ? '<span class="sw" style="background:' + it.swatch + '"></span>' : '';
        var an = total ? pct(it.value, total) + ' %' : '';
        b += '<tr><td>' + sw + esc(it.name) + '</td><td class="num">' + fmtAreaU(it.value) + '</td><td class="num">' + an + '</td></tr>';
      });
      b += '<tr class="tot"><td>Total</td><td class="num">' + fmtAreaU(sum) + '</td><td class="num">' + (total ? pct(sum, total) + ' %' : '') + '</td></tr>';
      return '<table class="at"><thead><tr><th>Kategorie</th><th class="num">Fläche</th><th class="num">Anteil GSF</th></tr></thead><tbody>' + b + '</tbody></table>';
    }
    function card(title, inner) { return inner ? '<div class="card"><h2>' + esc(title) + '</h2>' + inner + '</div>' : ''; }
    function grid2(a, b) { return (a && b) ? '<section class="grid2">' + a + b + '</section>' : ((a || '') + (b || '')); }

    var parcelArea = num(p.parcel_area_m2);
    var ggf = num(p.sia416_ggf_m2), buf = num(p.sia416_buf_m2), uuf = num(p.sia416_uuf_m2), classified = ggf + buf + uuf;
    var green = num(p.greenspace_m2), sealed = num(p.sealed_m2);
    var dbf = num(p.din277_bf_m2), duf = num(p.din277_uf_m2);
    var vbsP = num(p.vbs_produktiv_m2), vbsU = num(p.vbs_unproduktiv_m2);
    var va = num(p.vbs_kat_a_m2), vb = num(p.vbs_kat_b_m2), vc = num(p.vbs_kat_c_m2), vd = num(p.vbs_kat_d_m2);
    var vt1 = num(p.vbs_typ1_m2), vt2 = num(p.vbs_typ2_m2);

    var artItems = ART_KEYS.map(function (a) {
      var label = ART_LABELS[a] || a, main = ART_MAIN[a] || "";
      return { name: (main && main !== label ? main + " · " + label : label), value: num(p[artCol(a)]), swatch: mainColor(a) };
    }).filter(function (it) { return it.value > 0; }).sort(function (x, y) { return y.value - x.value; });
    var bzItems = [], hbItems = [];
    for (var k in p) {
      if (!Object.prototype.hasOwnProperty.call(p, k)) continue;
      var bm = BAUZONE_RE.exec(k); if (bm) { var bv = num(p[k]); if (bv > 0) bzItems.push({ name: bzLabel(bm[1]), value: bv, swatch: bzColor(bm[1]) }); continue; }
      var hm = HABITAT_RE.exec(k); if (hm) { var hv = num(p[k]); if (hv > 0) hbItems.push({ name: hbLabel(hm[1]), value: hv, swatch: habColor(hm[1]) }); }
    }
    bzItems.sort(function (x, y) { return y.value - x.value; });
    hbItems.sort(function (x, y) { return y.value - x.value; });
    var stKey = statusKey(p), stLabel = (STATUS_LABELS[stKey] || stKey);

    var idCard = card("Identifikation", detailKV([
      ["System-ID", p.id || "—"], ["E-GRID", p.egrid || "—"], ["Grundstück-Nr.", p.nummer || "—"],
      ["Bezeichnung", p["input_bez. grundstück"] || "—"], (p.bfsnr ? ["BFS-Nr.", p.bfsnr] : null)
    ]));
    var lageCard = card("Lage & Eigentum", detailKV([
      ["Ort", p.input_ort || "—"], ["PLZ", p.input_plz || "—"], ["Kanton", p.input_rg || "—"],
      ["Teilportfolio", p.input_tpf ? tpfLabel(p.input_tpf) : "—"],
      ["Eigentumsart", p["input_eigent.art"] ? eigentumLabel(p["input_eigent.art"]) : "—"]
    ]));
    var flaechen = card("Flächen (Übersicht)", detailKV([
      ["Grundstücksfläche (GSF)", fmtAreaU(parcelArea)],
      ["Klassifizierte Bodenbedeckung (AV)", fmtAreaU(classified) + " (" + pct(classified, parcelArea) + " % der GSF)"],
      ["Grünfläche", fmtAreaU(green) + " (" + pct(green, classified) + " % der Bodenbedeckung)"],
      ["Versiegelte Fläche", fmtAreaU(sealed) + " (" + pct(sealed, classified) + " % der Bodenbedeckung)"]
    ]));
    var siaCard = classified > 0 ? card("SIA 416", detailKV([
      ["GGF · Gebäudegrundfläche", fmtAreaU(ggf)], ["BUF · Bearbeitete Umgebung", fmtAreaU(buf)], ["UUF · Unbearbeitete Umgebung", fmtAreaU(uuf)]
    ])) : "";
    var dinCard = (dbf || duf) ? card("DIN 277", detailKV([
      ["BF · Bebaute Fläche", fmtAreaU(dbf)], ["UF · Unbebaute Fläche", fmtAreaU(duf)]
    ])) : "";
    var artCard = artItems.length ? card("Bodenbedeckung nach Art (AV)", detailAreaTable(artItems, parcelArea)) : "";
    var vbsCard = (vbsP || vbsU || va || vb || vc || vd) ? card("VBS-Klassierung", detailKV([
      ["Produktiv", fmtAreaU(vbsP)], ["Unproduktiv", fmtAreaU(vbsU)],
      ((vt1 || vt2) ? ["Typ 1 / Typ 2", fmtAreaU(vt1) + " / " + fmtAreaU(vt2)] : null),
      ["A · Siedlungsfläche", fmtAreaU(va)], ["B · Landwirtschaftsfläche", fmtAreaU(vb)],
      ["C · Bestockte Fläche", fmtAreaU(vc)], ["D · Unproduktive Fläche", fmtAreaU(vd)]
    ])) : "";
    var bzCard = bzItems.length ? card("Bauzonen (ARE)", detailAreaTable(bzItems, parcelArea)) : "";
    var hbCard = hbItems.length ? card("Lebensräume (BAFU · TypoCH L1)", detailAreaTable(hbItems, parcelArea)) : "";
    var qCard = card("Datenqualität", detailKV([
      ["E-GRID-Status", stLabel], ["Bodenbedeckung-WFS", p.check_wfs || "—"], ["Geometrie", p.check_geom || "—"],
      (("check_bauzonen" in p) && p.check_bauzonen ? ["Bauzonen", p.check_bauzonen] : null),
      (("check_habitat" in p) && p.check_habitat ? ["Lebensräume", p.check_habitat] : null),
      ["Datenquelle (LC)", p.lc_source || "—"],
      (p.lc_synthetic === "yes" ? ["Bodenbedeckung", "⚠ Synthetisch aus BAFU-Lebensräumen abgeleitet (keine AV-Daten)"] : null)
    ]));
    var linkCard = "";
    if (p.egrid) {
      var egridUrl = "https://map.geo.admin.ch/#/map?lang=de&topic=ech&bgLayer=ch.swisstopo.pixelkarte-farbe&layers=ch.swisstopo-vd.stand-oerebkataster&swisssearch=" + encodeURIComponent(p.egrid);
      linkCard = card("Verknüpfungen", '<a href="' + esc(egridUrl) + '" target="_blank" rel="noopener">↗ Auf map.geo.admin.ch öffnen (ÖREB-Kataster)</a>');
    }
    var rawKeys = Object.keys(p).filter(function (k) { return k.charAt(0) !== "_"; }).sort();
    var rawBody = "";
    rawKeys.forEach(function (k) { var v = p[k]; rawBody += '<tr><th>' + esc(k) + '</th><td>' + esc(v == null ? "" : String(v)) + '</td></tr>'; });
    var rawCard = '<div class="card"><details class="raw"><summary>Alle Felder (Rohdaten · ' + rawKeys.length + ')</summary><table class="kv">' + rawBody + '</table></details></div>';

    var ort = p.input_ort || "", plz = p.input_plz || "", subParts = [];
    if (p.egrid) subParts.push(esc(p.egrid));
    if (ort || plz) subParts.push(esc((plz ? plz + " " : "") + ort));
    if (p.input_rg) subParts.push("Kanton " + esc(p.input_rg));
    if (p.input_tpf) subParts.push("Teilportfolio " + esc(tpfLabel(p.input_tpf)));
    var dashTitle = window.DASHBOARD_TITLE || "Auswertung Bodenbedeckung";

    var body =
      '<div class="head">' +
        '<div class="actions"><button class="btn" onclick="window.print()">⎙ Drucken</button></div>' +
        '<div class="brand">Schweizerische Eidgenossenschaft · Grundstück-Details</div>' +
        '<h1>System-ID ' + esc(p.id || "—") + '</h1>' +
        '<div class="sub">' + subParts.join(" · ") + '</div>' +
      '</div>' +
      '<div class="wrap">' +
        grid2(idCard, lageCard) + flaechen + grid2(siaCard, dinCard) +
        artCard + vbsCard + bzCard + hbCard + qCard + linkCard + rawCard +
      '</div>' +
      '<div class="foot">Quelle: Amtliche Vermessung · geodienste.ch · swisstopo · BAFU · ARE · ' + esc(dashTitle) + '</div>';

    return '<!doctype html><html lang="de"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>Grundstück ' + esc(p.id || "") + ' — Details</title><style>' + DETAIL_CSS + '</style></head><body>' + body + '</body></html>';
  }

  function openParcelDetails(id) {
    var p = parcelById(id); if (!p) return;
    var url = URL.createObjectURL(new Blob([buildParcelDetailHTML(p)], { type: "text/html;charset=utf-8" }));
    window.open(url, "_blank");
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000); // keep alive long enough for the new tab to load
  }
  // Delegated: the popup's "Alle Details anzeigen" link (the popup DOM is recreated on each open).
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest(".popup-details-link"); if (!a) return;
    e.preventDefault(); openParcelDetails(a.getAttribute("data-id"));
  });
  // Layer control (top-left). Widget order mirrors the map z-order, top → bottom:
  // labels + markers/clusters first, then overlays (habitat on top … landcover
  // bottom), then the parcel polygons. "Beschriftung" owns the point/cluster layers
  // so clustering still works when the parcel polygons ("Grundstücke") are hidden.
  function LayerControl() {}
  LayerControl.prototype.onAdd = function (m) {
    this._map = m;
    var div = document.createElement("div");
    div.className = "maplibregl-ctrl maplibregl-ctrl-group layer-ctrl";
    var groups = [
      { label: "Beschriftung", layers: ["clusters", "cluster-count", "point", "point-label"], on: true }
    ];
    OVERLAY_DEFS.slice().reverse().forEach(function (d) {
      if (m.getLayer(d.key + "-fill")) groups.push({ label: d.label, layers: [d.key + "-fill", d.key + "-line"], on: false });
    });
    groups.push({ label: "Grundstücke", layers: ["parcels-fill", "parcels-line", "parcels-hl"], on: true });
    groups.forEach(function (g) {
      var lbl = document.createElement("label");
      var cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = g.on;
      cb.addEventListener("change", function () {
        g.layers.forEach(function (lid) { if (m.getLayer(lid)) m.setLayoutProperty(lid, "visibility", cb.checked ? "visible" : "none"); });
        renderLegend();
      });
      lbl.appendChild(cb); lbl.appendChild(document.createTextNode(" " + g.label));
      div.appendChild(lbl);
    });
    this._container = div; return div;
  };
  LayerControl.prototype.onRemove = function () { if (this._container && this._container.parentNode) this._container.parentNode.removeChild(this._container); this._map = undefined; };
  // Legend (bottom-right): swatches for the currently-visible layers only.
  var legendEl = null;
  function legendGroups() {
    var g = [{ layer: "parcels-fill", title: null, items: [{ color: PARCEL_COLOR, label: "Grundstücke" }, { color: "#d8232a", label: "Ausgewählt", outline: true }] }];
    if (map.getLayer("landcover-fill")) g.push({ layer: "landcover-fill", title: "Bodenbedeckung", items: MAIN_ORDER.map(function (mc) { return { color: MAIN_COLORS[mc], label: mc }; }) });
    if (map.getLayer("bauzonen-fill")) g.push({ layer: "bauzonen-fill", title: "Bauzonen", items: Object.keys(BAUZONE_LABELS).map(function (z) { return { color: bzColor(z), label: BAUZONE_LABELS[z] }; }) });
    if (map.getLayer("habitat-fill")) g.push({ layer: "habitat-fill", title: "Lebensräume", items: Object.keys(HABITAT_LABELS).map(function (s) { return { color: habColor(s), label: HABITAT_LABELS[s] }; }) });
    return g;
  }
  function renderLegend() {
    if (!legendEl || !map) return;
    var html = "";
    legendGroups().forEach(function (g) {
      if (!map.getLayer(g.layer) || map.getLayoutProperty(g.layer, "visibility") === "none") return;
      if (g.title) html += '<div class="lg-title">' + esc(g.title) + '</div>';
      g.items.forEach(function (it) { var sw = it.outline ? "background:#fff;border:2px solid " + it.color : "background:" + it.color; html += '<div class="lg-row"><span class="lg-sw" style="' + sw + '"></span>' + esc(it.label) + '</div>'; });
    });
    legendEl.innerHTML = html;
    legendEl.style.display = html ? "" : "none";
  }
  function Legend() {}
  Legend.prototype.onAdd = function (m) {
    this._map = m;
    legendEl = document.createElement("div");
    legendEl.className = "maplibregl-ctrl map-legend";
    renderLegend();
    return legendEl;
  };
  Legend.prototype.onRemove = function () { if (legendEl && legendEl.parentNode) legendEl.parentNode.removeChild(legendEl); legendEl = null; this._map = undefined; };

  // ---- Right-click context menu (mirrors the web app) ----
  var CTX_ICON = {
    copy: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V7a2 2 0 0 1 2-2h8"/></svg>',
    share: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/></svg>',
    report: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 4 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>'
  };
  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t);
    var ta = document.createElement("textarea"); ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch (e) {} document.body.removeChild(ta);
    return Promise.resolve();
  }
  // WGS84 → LV95 (swisstopo approximate formulas, ~1 m) so the share link centres
  // map.geo.admin.ch on the clicked point via swisssearch (same viewer the E-GRID links use).
  function geoAdminUrl(lat, lon) {
    var phi = (lat * 3600 - 169028.66) / 10000, lam = (lon * 3600 - 26782.5) / 10000;
    var E = Math.round(2600072.37 + 211455.93 * lam - 10938.51 * lam * phi - 0.36 * lam * phi * phi - 44.54 * lam * lam * lam);
    var N = Math.round(1200147.07 + 308807.95 * phi + 3745.25 * lam * lam + 76.63 * phi * phi - 194.56 * lam * lam * phi + 119.79 * phi * phi * phi);
    return "https://map.geo.admin.ch/#/map?lang=de&topic=ech&bgLayer=ch.swisstopo.pixelkarte-farbe&swisssearch=" + encodeURIComponent(E + " " + N);
  }
  function initContextMenu() {
    var menu = document.createElement("div");
    menu.className = "map-ctxmenu";
    menu.innerHTML =
      '<div class="ctxitem ctx-coords" data-act="copy" title="Klicken zum Kopieren">' + CTX_ICON.copy + '<span class="ctx-coords-text"></span></div>' +
      '<div class="ctxitem" data-act="share">' + CTX_ICON.share + '<span>Teilen</span></div>' +
      '<div class="ctxitem" data-act="report">' + CTX_ICON.report + '<span>Problem melden</span></div>';
    map.getContainer().appendChild(menu);
    var coordsText = menu.querySelector(".ctx-coords-text"), ctxLL = null;
    var hide = function () { menu.classList.remove("show"); };
    var flash = function (el) { el.classList.add("copied"); setTimeout(function () { el.classList.remove("copied"); }, 900); };

    map.on("contextmenu", function (e) {
      if (e.preventDefault) e.preventDefault();
      ctxLL = e.lngLat;
      coordsText.textContent = e.lngLat.lat.toFixed(5) + ", " + e.lngLat.lng.toFixed(5);
      var copied = menu.querySelector(".copied"); if (copied) copied.classList.remove("copied");
      var c = map.getContainer().getBoundingClientRect();
      menu.style.left = e.point.x + "px"; menu.style.top = e.point.y + "px";
      menu.classList.toggle("flip-h", (e.point.x + 200) > c.width);
      menu.classList.toggle("flip-v", (e.point.y + 140) > c.height);
      menu.classList.add("show");
    });
    map.on("click", hide);
    map.on("movestart", hide);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") hide(); });

    menu.addEventListener("click", function (e) {
      var item = e.target.closest && e.target.closest(".ctxitem"); if (!item || !ctxLL) return;
      var act = item.getAttribute("data-act");
      var lat = ctxLL.lat.toFixed(5), lon = ctxLL.lng.toFixed(5);
      if (act === "copy") {
        copyText(lat + ", " + lon); flash(menu.querySelector(".ctx-coords")); setTimeout(hide, 400);
      } else if (act === "share") {
        var url = geoAdminUrl(ctxLL.lat, ctxLL.lng);
        if (navigator.share) { navigator.share({ title: "Standort", url: url }).catch(function () {}); hide(); }
        else { copyText(url); flash(item); setTimeout(hide, 700); }
      } else if (act === "report") {
        hide();
        var subject = encodeURIComponent("Problem melden – Auswertung Bodenbedeckung");
        var body = encodeURIComponent("Koordinaten: " + lat + ", " + lon + "\n\nBeschreibung:\n");
        window.location.href = "mailto:david.rasner@bbl.admin.ch?subject=" + subject + "&body=" + body;
      }
    });
  }

  function initMap(el) {
    map = new maplibregl.Map({ container: el, style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json", center: [8.23, 46.82], zoom: 6.4, preserveDrawingBuffer: true, cooperativeGestures: true });
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right"); // compass = north icon; click resets bearing to 0
    map.addControl(new HomeControl(), "top-right");
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }), "bottom-left");
    map.on("load", function () {
      map.addSource("parcels", { type: "geojson", data: rowsToFC(lastRows) });
      map.addLayer({ id: "parcels-fill", type: "fill", source: "parcels", minzoom: PARCEL_MINZOOM, paint: { "fill-color": PARCEL_COLOR, "fill-opacity": 0.4 } });
      map.addLayer({ id: "parcels-line", type: "line", source: "parcels", minzoom: PARCEL_MINZOOM, paint: { "line-color": "#3b5a7a", "line-width": 0.7 } });
      map.addLayer({ id: "parcels-hl-casing", type: "line", source: "parcels", minzoom: PARCEL_MINZOOM, filter: ["==", ["get", "id"], selectedParcelId || " "], paint: { "line-color": "#fff", "line-width": 5, "line-opacity": 0.9 } });
      map.addLayer({ id: "parcels-hl", type: "line", source: "parcels", minzoom: PARCEL_MINZOOM, filter: ["==", ["get", "id"], selectedParcelId || " "], paint: { "line-color": "#d8232a", "line-width": 2.6 } });
      addOverlayLayers(); // Bodenbedeckung / Bauzonen / Lebensräume — under the markers, hidden by default
      map.addSource("points", { type: "geojson", data: rowsToPointsFC(lastRows), cluster: true, clusterRadius: 48, clusterMaxZoom: 13 });
      map.addLayer({ id: "clusters", type: "circle", source: "points", filter: ["has", "point_count"],
        paint: { "circle-color": ["step", ["get", "point_count"], "#4f6f93", 25, "#3b5a7a", 100, "#2e4a68"], "circle-radius": ["step", ["get", "point_count"], 14, 25, 18, 100, 24], "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } });
      map.addLayer({ id: "cluster-count", type: "symbol", source: "points", filter: ["has", "point_count"],
        layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": ["Open Sans Regular"], "text-size": 12 }, paint: { "text-color": "#fff" } });
      map.addLayer({ id: "point", type: "circle", source: "points", filter: ["!", ["has", "point_count"]],
        paint: { "circle-color": "#3b5a7a", "circle-radius": 4, "circle-stroke-color": "#fff", "circle-stroke-width": 1.2 } });
      map.addLayer({ id: "point-label", type: "symbol", source: "points", filter: ["!", ["has", "point_count"]],
        layout: { "text-field": ["get", "id"], "text-font": ["Open Sans Regular"], "text-size": 11, "text-anchor": "bottom", "text-offset": [0, -0.5], "text-optional": true },
        paint: { "text-color": "#1f2937", "text-halo-color": "#fff", "text-halo-width": 1.4 } });
      map.addControl(new LayerControl(), "top-left");
      map.addControl(new Legend(), "bottom-right");
      initContextMenu();
      mapReady = true; mapFitted = false; renderMap(lastRows);
      // One click handler, priority top→bottom: cluster → overlay → parcel.
      map.on("click", function (e) {
        if (map.getLayer("clusters")) {
          var cl = map.queryRenderedFeatures(e.point, { layers: ["clusters"] });
          if (cl.length) {
            map.getSource("points").getClusterExpansionZoom(cl[0].properties.cluster_id, function (err, zoom) { if (err) return; map.easeTo({ center: cl[0].geometry.coordinates, zoom: zoom }); });
            return;
          }
        }
        var order = [["habitat-fill", "habitat"], ["bauzonen-fill", "bauzonen"], ["landcover-fill", "landcover"], ["parcels-fill", "parcel"]];
        for (var i = 0; i < order.length; i++) {
          if (!map.getLayer(order[i][0])) continue;
          var fs = map.queryRenderedFeatures(e.point, { layers: [order[i][0]] });
          if (!fs.length) continue;
          var f = fs[0];
          if (order[i][1] === "parcel") {
            var pr = f.properties;
            selectParcel(pr.id); // highlight polygon + select the table row (no scroll)
            var pInfo = "<strong>" + esc(pr.ort || "—") + "</strong><br>" + esc(pr.id || "") + (pr.egrid ? "<br>" + esc(pr.egrid) : "") + "<br>" + fmtAreaU(pr.area);
            if (pr.id) pInfo += '<a href="#" class="popup-details-link" data-id="' + esc(pr.id) + '" style="display:inline-block;margin-top:7px;color:#d8232a;font-weight:600;text-decoration:none">Alle Details anzeigen ↗</a>';
            showPopup(e.lngLat, pInfo);
          } else {
            highlightOverlay("ov-" + order[i][1], f.id);
            showPopup(e.lngLat, overlayPopupHTML(order[i][1], f.properties.art, f.properties.area_m2));
          }
          return;
        }
      });
      ["parcels-fill", "clusters", "point", "landcover-fill", "bauzonen-fill", "habitat-fill"].forEach(function (lid) {
        if (!map.getLayer(lid)) return;
        map.on("mouseenter", lid, function () { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", lid, function () { map.getCanvas().style.cursor = ""; });
      });
    });
  }
  var _mapTried = false;
  function ensureMap() {
    var el = document.getElementById("map"); if (!el || _mapTried) return; _mapTried = true;
    if (window.maplibregl) { initMap(el); return; }
    el.innerHTML = '<div class="map-msg">Karte wird geladen…</div>';
    var css = document.createElement("link"); css.rel = "stylesheet"; css.href = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css"; document.head.appendChild(css);
    var s = document.createElement("script"); s.src = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js";
    s.onload = function () { el.innerHTML = ""; initMap(el); };
    s.onerror = function () { el.innerHTML = '<div class="map-msg">Karte benötigt eine Internetverbindung (MapLibre + swisstopo).</div>'; };
    document.head.appendChild(s);
  }

  // ---- Init ----
  var dt0 = document.getElementById("dash-title"); if (dt0 && window.DASHBOARD_TITLE) dt0.textContent = window.DASHBOARD_TITLE;
  var appliedDefaults = readURL();
  syncDrawer();
  if (appliedDefaults) writeURL();   // first (empty) visit → stamp the active defaults into the URL
  update();
  ensureMap();
  } // ── end boot() ──

  // ── Dispatch: embedded data → dashboard; no data → file picker ──
  var __embedded = window.PARCELS || [];
  if (!__embedded.length) {
    initPicker();
  } else {
    if (window.DASHBOARD_TITLE) { try { document.title = window.DASHBOARD_TITLE; } catch (e) {} }
    boot(__embedded, window.OVERLAYS || {});
    var bnE = document.getElementById("btn-new"); if (bnE) bnE.style.display = "none";
  }
})();
