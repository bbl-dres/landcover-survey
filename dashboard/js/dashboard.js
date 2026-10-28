"use strict";
(function () {
  // ── Shared helpers (used by the picker and the Download menu) ──────────────
  // Snapshot the pristine template BEFORE any DOM mutation, so the HTML download
  // carries a clean shell with data swapped into the PARCEL-DATA markers.
  var TEMPLATE_HTML = "<!doctype html>\n" + document.documentElement.outerHTML;
  // PII allowlist (mirrors the old build_dashboard.py): keep every non-input_
  // column; of input_ keep only these six. The rest never reach a saved file.
  var KEEP_INPUT = { "input_ort":1, "input_plz":1, "input_rg":1, "input_bez. grundstück":1, "input_eigent.art":1, "input_tpf":1, "input_l/r":1 };
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
    // Local images (the basemap thumbnails) → data URIs, so the saved file needs no assets/ folder.
    var ire = /<img\b[^>]*src=["'](?!https?:|data:)([^"']+)["'][^>]*>/g;
    while ((m = ire.exec(html))) (function (tag, url) {
      jobs.push(fetch(url).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status + " für " + url); return r.blob(); }).then(function (b) {
        return new Promise(function (res, rej) { var fr = new FileReader(); fr.onload = function () { res([tag, tag.replace(url, fr.result)]); }; fr.onerror = function () { rej(new Error("Bild konnte nicht gelesen werden: " + url)); }; fr.readAsDataURL(b); });
      }));
    })(m[0], m[1]);
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
  // Values mirror data/landcover.json `maingroups[].color` (aligned to the official
  // BAFU habitat colour families) — keep in sync with it.
  var MAIN_COLORS = {
    "Gebäude": "#333333", "Befestigt": "#808080", "Humusiert": "#FC8C1D",
    "Bestockt": "#62AF39", "Gewässer": "#0D74FC", "Vegetationslos": "#9AAAB3"
  };
  var MAIN_ORDER = ["Gebäude", "Befestigt", "Humusiert", "Bestockt", "Gewässer", "Vegetationslos"];
  function mainColor(a) { return MAIN_COLORS[ART_MAIN[a]] || "#94a3b8"; }
  // Habitat by TypoCH level-1 (digit → colour). Official BAFU Lebensraumkarte mid-tone
  // family reps; mirrors data/typoch.json `l1_colors` and web/js/config.js BAFU_TYPOCH_L1.
  var HABITAT_L1_COLORS = { "1":"#0D74FC", "2":"#12DEFF", "3":"#9AAAB3", "4":"#FC8C1D", "5":"#F0F000", "6":"#62AF39", "7":"#C89646", "8":"#E673E4", "9":"#505050" };
  // TypoCH level-1 classes 1–7 are naturnah; 8 (Kulturen) & 9 (Bauten/Anlagen) are not.
  var HABITAT_NAT_DIGIT = { "1":1, "2":1, "3":1, "4":1, "5":1, "6":1, "7":1 };
  // Legacy level-1 name-slugs (older exports collapsed habitat to level-1).
  var HABITAT_SLUG_DIGIT = {
    gewaesser:"1", ufer_feuchtgebiete:"2", gletscher_fels_schutt_geroell:"3", gruenland:"4",
    krautsaeume_hochstauden_gebuesche:"5", waelder:"6", pionier_ruderalvegetation:"7",
    pflanzungen_aecker_kulturen:"8", gebaeude_anlagen:"9"
  };
  // TypoCH level-1 digit of a habitat column slug — robust to export granularity:
  // level-2/3 code-slugs ("6_3_andere_laubwaelder") take their leading digit; legacy
  // level-1 name-slugs ("waelder") map via HABITAT_SLUG_DIGIT.
  function habDigit(slug) { return /^[1-9]/.test(slug) ? String(slug).charAt(0) : (HABITAT_SLUG_DIGIT[slug] || ""); }
  function habColor(slug) { return HABITAT_L1_COLORS[habDigit(slug)] || "#8e7cc3"; }
  // (TypoCH class/group names come from the embedded TYPOCH_NAMES via typochLabel — see above.)
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
  // ISO 3166-1 alpha-2 → German country name (input_l/r). Derived from data/countries.json;
  // inlined so the self-contained offline file needs no fetch. Unknown codes fall back to the code.
  var COUNTRY_LABELS = {
    "AD":"Andorra", "AE":"Vereinigte Arabische Emirate", "AF":"Afghanistan", "AG":"Antigua und Barbuda", "AI":"Anguilla", "AL":"Albanien",
    "AM":"Armenien", "AO":"Angola", "AQ":"Antarktis", "AR":"Argentinien", "AS":"Amerikanisch-Samoa", "AT":"Österreich",
    "AU":"Australien", "AW":"Aruba", "AX":"Åland", "AZ":"Aserbaidschan", "BA":"Bosnien und Herzegowina", "BB":"Barbados",
    "BD":"Bangladesch", "BE":"Belgien", "BF":"Burkina Faso", "BG":"Bulgarien", "BH":"Bahrain", "BI":"Burundi",
    "BJ":"Benin", "BL":"Saint-Barthélemy", "BM":"Bermuda", "BN":"Brunei", "BO":"Bolivien", "BQ":"Bonaire",
    "BR":"Brasilien", "BS":"Bahamas", "BT":"Bhutan", "BV":"Bouvetinsel", "BW":"Botswana", "BY":"Belarus",
    "BZ":"Belize", "CA":"Kanada", "CC":"Kokosinseln", "CD":"Kongo (Dem. Rep.)", "CF":"Zentralafrikanische Republik", "CG":"Kongo (Rep.)",
    "CH":"Schweiz", "CI":"Côte d’Ivoire", "CK":"Cookinseln", "CL":"Chile", "CM":"Kamerun", "CN":"China",
    "CO":"Kolumbien", "CR":"Costa Rica", "CU":"Kuba", "CV":"Cabo Verde", "CW":"Curaçao", "CX":"Weihnachtsinsel",
    "CY":"Zypern", "CZ":"Tschechien", "DE":"Deutschland", "DJ":"Dschibuti", "DK":"Dänemark", "DM":"Dominica",
    "DO":"Dominikanische Republik", "DZ":"Algerien", "EC":"Ecuador", "EE":"Estland", "EG":"Ägypten", "EH":"Westsahara",
    "ER":"Eritrea", "ES":"Spanien", "ET":"Äthiopien", "FI":"Finnland", "FJ":"Fidschi", "FK":"Falklandinseln",
    "FM":"Mikronesien", "FO":"Färöer", "FR":"Frankreich", "GA":"Gabun", "GB":"Vereinigtes Königreich", "GD":"Grenada",
    "GE":"Georgien", "GF":"Französisch-Guayana", "GG":"Guernsey", "GH":"Ghana", "GI":"Gibraltar", "GL":"Grönland",
    "GM":"Gambia", "GN":"Guinea", "GP":"Guadeloupe", "GQ":"Äquatorialguinea", "GR":"Griechenland", "GS":"Südgeorgien und die Südlichen Sandwichinseln",
    "GT":"Guatemala", "GU":"Guam", "GW":"Guinea-Bissau", "GY":"Guyana", "HK":"Hongkong", "HM":"Heard und McDonaldinseln",
    "HN":"Honduras", "HR":"Kroatien", "HT":"Haiti", "HU":"Ungarn", "ID":"Indonesien", "IE":"Irland",
    "IL":"Israel", "IM":"Insel Man", "IN":"Indien", "IO":"Britisches Territorium im Indischen Ozean", "IQ":"Irak", "IR":"Iran",
    "IS":"Island", "IT":"Italien", "JE":"Jersey", "JM":"Jamaika", "JO":"Jordanien", "JP":"Japan",
    "KE":"Kenia", "KG":"Kirgisistan", "KH":"Kambodscha", "KI":"Kiribati", "KM":"Komoren", "KN":"St. Kitts und Nevis",
    "KP":"Nordkorea", "KR":"Südkorea", "KW":"Kuwait", "KY":"Kaimaninseln", "KZ":"Kasachstan", "LA":"Laos",
    "LB":"Libanon", "LC":"St. Lucia", "LI":"Liechtenstein", "LK":"Sri Lanka", "LR":"Liberia", "LS":"Lesotho",
    "LT":"Litauen", "LU":"Luxemburg", "LV":"Lettland", "LY":"Libyen", "MA":"Marokko", "MC":"Monaco",
    "MD":"Moldau", "ME":"Montenegro", "MF":"Saint-Martin (frz.)", "MG":"Madagaskar", "MH":"Marshallinseln", "MK":"Nordmazedonien",
    "ML":"Mali", "MM":"Myanmar", "MN":"Mongolei", "MO":"Macau", "MP":"Nördliche Marianen", "MQ":"Martinique",
    "MR":"Mauretanien", "MS":"Montserrat", "MT":"Malta", "MU":"Mauritius", "MV":"Malediven", "MW":"Malawi",
    "MX":"Mexiko", "MY":"Malaysia", "MZ":"Mosambik", "NA":"Namibia", "NC":"Neukaledonien", "NE":"Niger",
    "NF":"Norfolkinsel", "NG":"Nigeria", "NI":"Nicaragua", "NL":"Niederlande", "NO":"Norwegen", "NP":"Nepal",
    "NR":"Nauru", "NU":"Niue", "NZ":"Neuseeland", "OM":"Oman", "PA":"Panama", "PE":"Peru",
    "PF":"Französisch-Polynesien", "PG":"Papua-Neuguinea", "PH":"Philippinen", "PK":"Pakistan", "PL":"Polen", "PM":"Saint-Pierre und Miquelon",
    "PN":"Pitcairninseln", "PR":"Puerto Rico", "PS":"Palästina", "PT":"Portugal", "PW":"Palau", "PY":"Paraguay",
    "QA":"Katar", "RE":"Réunion", "RO":"Rumänien", "RS":"Serbien", "RU":"Russland", "RW":"Ruanda",
    "SA":"Saudi-Arabien", "SB":"Salomonen", "SC":"Seychellen", "SD":"Sudan", "SE":"Schweden", "SG":"Singapur",
    "SH":"St. Helena", "SI":"Slowenien", "SJ":"Svalbard und Jan Mayen", "SK":"Slowakei", "SL":"Sierra Leone", "SM":"San Marino",
    "SN":"Senegal", "SO":"Somalia", "SR":"Suriname", "SS":"Südsudan", "ST":"São Tomé und Príncipe", "SV":"El Salvador",
    "SX":"Sint Maarten", "SY":"Syrien", "SZ":"Eswatini", "TC":"Turks- und Caicosinseln", "TD":"Tschad", "TF":"Französische Süd- und Antarktisgebiete",
    "TG":"Togo", "TH":"Thailand", "TJ":"Tadschikistan", "TK":"Tokelau", "TL":"Timor-Leste", "TM":"Turkmenistan",
    "TN":"Tunesien", "TO":"Tonga", "TR":"Türkei", "TT":"Trinidad und Tobago", "TV":"Tuvalu", "TW":"Taiwan",
    "TZ":"Tansania", "UA":"Ukraine", "UG":"Uganda", "UM":"Kleinere Amerikanische Überseeinseln", "US":"Vereinigte Staaten", "UY":"Uruguay",
    "UZ":"Usbekistan", "VA":"Vatikanstadt", "VC":"St. Vincent und die Grenadinen", "VE":"Venezuela", "VG":"Britische Jungferninseln", "VI":"Amerikanische Jungferninseln",
    "VN":"Vietnam", "VU":"Vanuatu", "WF":"Wallis und Futuna", "WS":"Samoa", "XK":"Kosovo", "YE":"Jemen",
    "YT":"Mayotte", "ZA":"Südafrika", "ZM":"Sambia", "ZW":"Simbabwe"
  };
  function countryLabel(c) { if (c == null || c === "") return "—"; var k = String(c).toUpperCase(); return COUNTRY_LABELS[k] || String(c); }
  // TypoCH code -> German name (levels 1-4), embedded from data/typoch.json so the
  // self-contained dashboard needs no fetch. Consistent habitat labels for the pivot.
  var TYPOCH_NAMES = {
    "1":"Gewässer", "1.1":"Stehende Gewässer", "1.1.0":"Stehendes Gewässer ohne Vegetation", "1.1.0.1":"Tiefgründiges Gewässer (Freiwasserzone)", "1.1.0.2":"Seichtes Gewässer (Litoral, inkl. Tümpel)", "1.1.1":"Armleuchteralgengesellschaft",
    "1.1.2":"Laichkrautgesellschaften", "1.1.3":"Wasserlinsengesellschaften", "1.1.3.1":"Froschbissgesellschaften", "1.1.3.2":"Wasserschlauchgesellschaften", "1.1.4":"Schwimmblattgesellschaft", "1.1.4.1":"Wasserhahnenfussgesellschaft",
    "1.1.4.2":"Wasserfedergesellschaft", "1.2":"Fliessgewässer", "1.2.1":"Brachsmen- und Barbenregion (Epipotamon)", "1.2.1.1":"Breites Fliessgewässer des Flachlands", "1.2.1.2":"Langsam fliessender Bach im Flachland", "1.2.2":"Äschenregion (Hyporhithron)",
    "1.2.2.0":"Äschenregion ohne Vegetation", "1.2.2.1":"Äschenregion mit Vegetation", "1.2.3":"Untere Forellenregion (Metarhithron)", "1.2.4":"Obere Forellenregion (Epirhithron)", "1.2.5":"Temporärer Wasserlauf", "1.2.6":"Zone der Gletscherbäche (Kryal)",
    "1.3":"Quellen und Quellfluren", "1.3.0":"Überrieselte Fläche, Quelle ohne Vegetation", "1.3.0.1":"Auenquelle, Giesse", "1.3.1":"Wärmeliebende Quellflur", "1.3.2":"Kalkreiche Quellflur", "1.3.3":"Kalkarme Quellflur",
    "1.4":"Unterirdische Gewässer", "1.4.1":"Porengrundwasser", "1.4.2":"Kluftgrundwasser", "1.4.3":"Höhlenbach", "1.4.4":"Höhlensee", "2":"Ufer und Feuchtgebiete",
    "2.0":"Künstliche Ufer", "2.0.0":"Künstliche Ufer ohne Vegetation", "2.0.1":"Künstliche Ufer mit Vegetation", "2.1":"Ufer mit Vegetation", "2.1.1":"Moortümpelgesellschaft", "2.1.2":"Röhricht",
    "2.1.2.1":"Stillwasser-Röhricht", "2.1.2.2":"Flussufer- und Landröhricht", "2.1.3":"Strandlingsgesellschaften", "2.1.4":"Bachröhricht", "2.2":"Flachmoore", "2.2.1":"Grossseggenried",
    "2.2.1.1":"Grossseggenried", "2.2.1.2":"Schneidbinsenried", "2.2.2":"Kalkarmes Kleinseggenried (Braunseggenried)", "2.2.3":"Kalkreiches Kleinseggenried (Davallseggenried)", "2.2.4":"Übergangsmoor", "2.2.5":"Schwemmufervegetation alpiner Wildbäche",
    "2.3":"Feuchtwiesen", "2.3.1":"Pfeifengraswiese", "2.3.2":"Nährstoffreiche Feuchtwiesen (Sumpfdotterblumenwiese)", "2.3.3":"Feuchte Hochstaudenflur (Spierstaudenflur)", "2.4":"Hochmoore", "2.4.1":"Offene Hochmoore",
    "2.5":"Wechselfeuchte Pionierfluren", "2.5.0":"Wechselfeuchte Pionierfluren ohne Vegetation", "2.5.1":"Einjährige Schlammflur (Zwergbinsenflur)", "2.5.1.1":"Zwergbinsen-Annuellenflur mit Sumpfbinsen", "2.5.1.2":"Zwergbinsen-Annuellenflur mit Zypergräsern", "2.5.1.3":"Annuellenflur feuchter Böden mit Zwergkräutern",
    "2.5.2":"Mehrjährige Schlammflur (Zweizahnflur)", "3":"Gletscher, Fels, Schutt und Geröll", "3.1":"Gletscher, Firn- und Schneefleder", "3.1.1":"Gletscher", "3.1.2":"Blockgletscher", "3.1.3":"Firnfeld (Sommer)",
    "3.1.4":"Schneefeld (Frühling)", "3.2":"Alluvionen und Moränen", "3.2.1":"Alluvionen (Schwemmland)", "3.2.1.0":"Alluvionen ohne Vegetation", "3.2.1.1":"Alluvionen mit krautiger Pioniervegetation", "3.2.2":"Moräne",
    "3.2.2.0":"Moräne ohne Vegetation", "3.2.2.1":"Moräne mit Pioniervegetation", "3.3":"Steinschutt- und Geröllfluren", "3.3.1":"Kalkschutt", "3.3.1.1":"Kalkschutthalde ohne Gefässpflanzen", "3.3.1.2":"Alpine Kalkblockflur",
    "3.3.1.3":"Alpine Kalkschieferflur", "3.3.1.4":"Feinerdereiche Kalkschuttflur", "3.3.1.5":"Trockenwarme Kalkschuttflur", "3.3.2":"Silikatschutt", "3.3.2.1":"Silikatschutthalde ohne Gefässpflanzen", "3.3.2.2":"Alpine Silikatschuttflur",
    "3.3.2.3":"Trockenwarme Silikatschuttflur", "3.4":"Felsen", "3.4.1":"Kalkfelsen", "3.4.1.1":"Kalkfels ohne Gefässpflanzen", "3.4.1.2":"Trockene Kalkfelsflur", "3.4.1.3":"Schattige Kalkfelsflur",
    "3.4.2":"Silikat- oder Serpentinfelsen", "3.4.2.1":"Silikatfels ohne Gefässpflanzen", "3.4.2.2":"Silikatfelsflur", "3.4.2.3":"Serpentingesteinsflur", "3.5":"Höhlen", "3.5.1":"Kleine Felsspalten, Halbhöhlen: endogäische Fauna (\"Fauna der Steinunterseite\")",
    "3.5.2":"Bau von Tieren", "3.5.3":"Höhleneingang", "3.5.4":"Guanohaufen", "3.5.5":"Künstliche Höhlung (Minen, Tunnel, etc.)", "3.5.6":"Unterirdische Lehmablagerung", "3.5.7":"Unterirdische Felswand",
    "4":"Grünland (Naturrasen, Wiesen und Weiden)", "4.0":"Kunstrasen", "4.0.1":"Kunstwiese auf Fruchtfolgefläche", "4.0.2":"Kunstrasen auf Sportplätzen, im Siedlungsraum, etc.", "4.0.3":"Begrünung in Tieflagen (Strassenböchungen, etc.)", "4.0.4":"Begrünung in Hochlagen (Skipisten, etc.)",
    "4.1":"Pionierfluren auf Felsböden (Felsgrusfluren)", "4.1.1":"Wärmeliebende Kalkfels-Pionierflur", "4.1.2":"Kalkfels-Pionierflur des Gebirges (Karstfluren)", "4.1.3":"Wärmeliebende Silikatfels-Pionierflur", "4.1.4":"Silikatfelsgrusflur des Gebirges", "4.2":"Wärmeliebende Trockenrasen",
    "4.2.1":"Wärmeliebende Trockenrasen (Kontinentaler Trockenrasen; Innerwallis, Graubünden)", "4.2.1.1":"Inneralpine Felsensteppe", "4.2.1.1":"Inneralpine Felsensteppe der Westalpen", "4.2.1.1":"Inneralpine Felsensteppe der Ostalpen", "4.2.1.2":"Kontinentaler Halbtrockenrasen", "4.2.2":"Mitteleuropäischer Trockenrasen",
    "4.2.3":"Insubrischer Trockenrasen", "4.2.4":"Mitteleuropäischer Halbtrockenrasen", "4.3":"Gebirgs-Magerrasen", "4.3.1":"Blaugrashalde", "4.3.1.1":"Blaugrashalde s.str.", "4.3.1.2":"Blaugrashalde der südlichen Kalkalpen",
    "4.3.2":"Polsterseggenrasen", "4.3.3":"Rostseggenhalde", "4.3.4":"Windkantenrasen (Nacktriedrasen)", "4.3.5":"Borstgrasrasen", "4.3.6":"Buntschwingelhalde", "4.3.6.1":"Buntschwingelhalde s.str.",
    "4.3.6.2":"Violettschwingelrasen", "4.3.6.3":"Goldschwingelrasen", "4.3.7":"Krummseggenrasen", "4.4":"Schneetälchen", "4.4.1":"Kalkreiches Schneetälchen", "4.4.2":"Kalkarmes Schneetälchen",
    "4.5":"Fettwiesen und -weiden", "4.5.1":"Talfettwiesen (Fromentalwiese)", "4.5.1.1":"Knaulgraswiesen", "4.5.1.2":"Typische Fromentalwiese", "4.5.1.3":"Trockene Fromentalwiese", "4.5.1.4":"Feuchte Fuchschwanzwiese",
    "4.5.2":"Bergfettwiese (Goldhaferwiese)", "4.5.3":"Talfettweide (Kammgrasweide)", "4.5.4":"Bergfettweide (Milchkrautweide)", "4.6":"Grasbrachen", "4.6.1":"Queckenbrache", "4.6.2":"Fiederzwenckenbrache",
    "4.6.3":"Fromentalbrache", "4.6.4":"Pfeifengrasbrache", "4.6.5":"Reitgrasbrache", "5":"Krautsäume, Hochstaudenfluren und Gebüsche", "5.1":"Krautsäume", "5.1.0":"Atypische Saumgesellschaft",
    "5.1.1":"Trockenwarmer Krautsaum", "5.1.2":"Mesophiler Krautsaum", "5.1.3":"Feuchter Krautsaum (Tieflagen)", "5.1.4":"Feuchter Krautsaum (höheren Lagen)", "5.1.5":"Nährstoffreicher Krautsaum", "5.2":"Hochstauden- und Schlagfluren",
    "5.2.1":"Kalkreiche Schlagflur", "5.2.2":"Kalkarme Schlagflur", "5.2.3":"Hochgrasflur des Gebirges", "5.2.4":"Hochstaudenflur des Gebirges", "5.2.5":"Adlerfarnflur", "5.3":"Gebüsche",
    "5.3.0":"Naturferne Pflanzung", "5.3.0.1":"Naturferne Pflanzung mit sommergrünen Arten", "5.3.0.2":"Naturferne Pflanzung mit immergrünen Arten", "5.3.1":"Besenginster-Gebüsche", "5.3.2":"Trockenwarmes Gebüsch", "5.3.3":"Mesophiles Gebüsch",
    "5.3.4":"Brombeergestrüpp", "5.3.5":"Gebüschreiche Vorwaldgesellschaften", "5.3.6":"Auen-Weidengebüsch", "5.3.7":"Moor-Weidengebüsch", "5.3.8":"Gebirgs-Weidengebüsch", "5.3.9":"Grünerlengebüsche",
    "5.4":"Zwergstrauchheiden", "5.4.1":"Subatlantische Zwergstrauchheide (Ginsterheide)", "5.4.1.1":"Subatlantische Heide auf Torf", "5.4.1.2":"Subatlantsiche Heide, nicht auf Torf", "5.4.2":"Kontinentale Zwergstrauchheide (Sefistrauchheide)", "5.4.3":"Subalpine Kalkheide (Erikaheide)",
    "5.4.4":"Trockene subalpine Zwergstrauchheide (Zwergwacholderheide)", "5.4.5":"Mesophile subalpine Zwergstrauchheide (Alpenrosenheide)", "5.4.6":"Alpine Windheide", "6":"Wälder", "6.0":"Forstpflanzungen", "6.0.1":"Aufforstung mit Laubgehölzen",
    "6.0.2":"Aufforstung mit Nadelgehölzen", "6.0.3":"Einzelbaum", "6.1":"Bruch- und Auenwälder", "6.1.1":"Erlen-Bruchwald", "6.1.2":"Weichholz-Auenwald", "6.1.3":"Grauerlen-Auenwald",
    "6.1.3.1":"Alpen-Weidenauenwald", "6.1.4":"Hartholz-Auenwald", "6.2":"Buchenwälder", "6.2.1":"Orchideen-Buchenwald", "6.2.2":"Hainsimsen-Buchenwald", "6.2.3":"Waldmeister-Buchenwald",
    "6.2.3.1":"Atlantischer Buchenwald", "6.2.4":"Zahnwurz-Buchenwald", "6.2.5":"Tannen-Buchenwald", "6.3":"Andere Laubwälder", "6.3.1":"Ahorn-Schluchtwald", "6.3.2":"Linden-Mischwald",
    "6.3.3":"Eichen- Hainbuchenwald", "6.3.4":"Flaumeichenwald", "6.3.5":"Hopfenbuchenwald", "6.3.6":"Saurer Eichenmischwald", "6.3.7":"Kastanienwald", "6.3.8":"Laubwald mit immergrünen Sträuchern",
    "6.3.9":"Robinienwald", "6.4":"Wärmeliebende Föhrenwälder", "6.4.1":"Pfeifengras-Föhrenwald", "6.4.2":"Subkontinentaler kalkreicher Föhrenwald", "6.4.2.1":"Mitteleuropäischer subkontinentaler kalkreicher Föhrenwald (Geissklee-Föhrenwald)", "6.4.3":"Kontinentaler Steppen-Föhrenwald",
    "6.4.3.1":"Kalkreicher Steppen-Föhrenwald", "6.4.3.2":"Kalkarmer Steppen-Föhrenwald", "6.4.4":"Kalkarmer Föhrenwald", "6.5":"Hochmoorwälder", "6.5.1":"Hochmoor-Birkenwald", "6.5.2":"Hochmoor-Bergföhrenwald",
    "6.5.3":"Hochmoor-Fichtenwald", "6.6":"Gebirgsnadelwälder", "6.6.1":"Tannen-Fichtenwald", "6.6.2":"Heidelbeer-Fichtenwald", "6.6.3":"Lärchen-Arvenwald", "6.6.4":"Lärchenwald",
    "6.6.5":"Bergföhrenwald", "6.6.5.1":"Kalkarmer Bergföhrenwald", "6.6.5.2":"Kalkreicher Bergföhrenwald", "7":"Pioniervegetation gestörter Plätze (Ruderalstandorte)", "7.1":"Trittrasen und Ruderalfluren", "7.1.0":"Tritt- und Trümmerflächen ohne Vegetation",
    "7.1.1":"Feuchte Trittflur", "7.1.2":"Trockene Trittflur", "7.1.3":"Subalpin-alpine Trittflur", "7.1.4":"Einjährige Ruderalflur", "7.1.5":"Trockenwarme Ruderalflur", "7.1.6":"Mesophile Ruderalflur (Steinkleeflur)",
    "7.1.7":"Alpine Lägerflur (Alpenblackenflur)", "7.1.8":"Lägerflur der Tieflagen", "7.2":"Anthropogene Steinfluren", "7.2.0":"Mauer oder Steinpflästerung ohne Vegetation", "7.2.1":"Trockenwarme Mauerflur", "7.2.2":"Steinpflaster-Trittflur",
    "8":"Pflanzungen, Äcker und Kulturen", "8.1":"Baumschulen, Obstgärten, Rebberge", "8.1.1":"Baumschule aus Laubgehölzen", "8.1.2":"Baumschule aus Nadelgehölzen", "8.1.3":"Kastanienhain (ohne Unterholz)", "8.1.4":"Hochstammobstgarten",
    "8.1.5":"Niederstammobstgarten", "8.1.6":"Rebberg", "8.1.7":"Beerenkultur", "8.2":"Feldkulturen (Äcker)", "8.2.0":"Feldkulturen (Äcker) ohne Vegetation", "8.2.1":"Getreidefeld (vorwiegend Winterkultur)",
    "8.2.1.0":"Getreide ohne Begleitvegetation", "8.2.1.1":"Kalkarme Getreideäcker", "8.2.1.2":"Kalkreiche Getreideäcker", "8.2.2":"Mais-, Tabak- und andere Ackerkulturen (vorwiegend Sommerkultur)", "8.2.3":"Hackfruchtacker (Sommerkultur), Garten", "8.2.3.0":"Hackfrucht ohne Begleitflora",
    "8.2.3.1":"Kalkarmer, lehmiger Hackfruchtacker", "8.2.3.2":"Kalkreicher, lehmiger Hackfruchtacker", "8.2.3.3":"Kalkarmer, trockener Hackfruchtacker", "8.2.3.4":"Kalkreicher, trockener Hackfruchtacker", "9":"Bauten, Anlagen", "9.1":"Lagerplätze, Deponien",
    "9.1.1":"Deponie (Sperrgut)", "9.1.2":"Deponie (organische Abfälle)", "9.2":"Bauten", "9.2.1":"Bewohntes Gebäude", "9.2.1.1":"Bauernhaus", "9.2.1.2":"Sennhütte, Chalet",
    "9.2.1.3":"Einfamilienhaus", "9.2.1.4":"Mietgebäude, Gewerbegebäude", "9.2.2":"Tierstallungen, Gewächshäuser", "9.2.2.1":"Kuh- und Pferdestall", "9.2.2.2":"Schweinestall", "9.2.2.3":"Hühnerstall",
    "9.2.2.4":"Treibhaus", "9.2.3":"Nebengebäude, Halle, Garage", "9.2.3.1":"Scheune, Schopf", "9.2.3.2":"Garage", "9.2.3.3":"Bootshaus", "9.2.3.4":"Bunker",
    "9.2.3.5":"Berghütte, Forsthaus", "9.2.4":"Fabrik, Halle, Lagerhaus", "9.2.4.1":"Fabrik", "9.2.4.2":"Lagerhaus", "9.2.4.3":"Elektrisches Kraftwerk", "9.2.4.4":"Atomkraftwerk",
    "9.2.4.5":"Raffinerie", "9.2.4.6":"Sägerei, Schreinerei", "9.2.5":"Öffentliches Gebäude, Denkmal", "9.2.5.1":"Schloss", "9.2.5.2":"Kriche", "9.2.5.3":"Bahnhof",
    "9.2.5.4":"Spital", "9.3":"Verkehrswege", "9.3.2":"Asphalt- und Betonstrasse", "9.3.2.1":"Strasse", "9.3.2.2":"Autobahn", "9.3.2.3":"Weg ohne Vegetation (Beton, Kies)",
    "9.3.3":"Naturstrasse, Weg", "9.3.3.1":"Naturweg (Dreckweg)", "9.3.3.2":"Holzerweg", "9.3.3.3":"Pfad", "9.3.4":"Bahngleis", "9.4":"Versiegeleter Sportplatz, Parkplatz etc."
  };
  function typochName(code) { return TYPOCH_NAMES[code] || ""; }
  function typochLabel(code) { var n = typochName(code); return n ? code + " " + n : String(code); }
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
  // Share label for a table row: a positive share that would round to 0 % reads as
  // "< 1 %" so tiny-but-present slivers aren't shown as absent. Caller guards whole > 0.
  function pctLabel(part, whole) { if (!(part > 0)) return "0 %"; var r = part / whole * 100; return r < 0.5 ? "< 1 %" : Math.round(r) + " %"; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]; }); }
  function isCovered(p) { return num(p.sia416_ggf_m2) + num(p.sia416_buf_m2) + num(p.sia416_uuf_m2) > 0; }

  // ---- Icons: Lucide (ISC), 24 grid, stroke 2, round caps — inlined so the offline file needs no font/CDN ----
  var ICON = (function () {
    var P = {
      search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
      x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
      chevRight: '<path d="m9 18 6-6-6-6"/>', chevLeft: '<path d="m15 18-6-6 6-6"/>', chevDown: '<path d="m6 9 6 6 6-6"/>', chevUp: '<path d="m18 15-6-6-6 6"/>',
      info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
      plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
      extlink: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
      house: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
      zoomIn: '<circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="11" x2="11" y1="8" y2="14"/><line x1="8" x2="14" y1="11" y2="11"/>',
      funnel: '<path d="M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z"/>',
      fileText: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
      check: '<path d="M20 6 9 17l-5-5"/>',
      alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'
    };
    var o = {}, k;
    function svg(name, size) { return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + P[name] + "</svg>"; }
    for (k in P) o[k] = svg(k, 16);
    o.sz = svg; // ICON.sz("info", 18) for other sizes
    return o;
  })();
  // ---- Counting rule: a parcel counts in a VBS category when it covers ≥ 10 % of the parcel area ----
  var VBS_THRESHOLD = 0.10;
  function vbsShare(p, field) { var a = num(p.parcel_area_m2); return a > 0 ? num(p[field]) / a : 0; }
  function vbsHas(p, field) { var s = vbsShare(p, field); return s > 0 && s >= VBS_THRESHOLD; }
  var SEL_MAX = 50; // parcels per PDF report (selection cap)
  // ---- Green inventory (Grünflächeninventar der Bundesgärtnerei): optional join column `greeninv`
  // (yes / no, written by the web app or the CLI), shown as filter, table column and links into
  // the inventory app, which reads center + zoom from its URL. ----
  var GREEN_INVENTORY_APP = "https://bbl-dres.github.io/green-inventory/prototype-main/";
  var GREENINV_KEYS = ["yes", "no"], GREENINV_LABELS = { yes: "Erfasst", no: "Nicht erfasst" };
  function greeninvLabel(v) { return GREENINV_LABELS[v] || "—"; }


  function boot(PARCELS, OVERLAYS) {
    OVERLAYS = OVERLAYS || {};
  // ---- Precompute filter option counts (over the full dataset) ----
  var cantonCounts = {}, countryCounts = {}, eigentumCounts = {}, artTotal = {}, artParcelCount = {}, covWith = 0, covWithout = 0;
  var excludeCounts = {}, statusCounts = {}, tpfCounts = {}, bauzoneTotal = {}, bauzoneParcelCount = {}, habitatTotal = {}, habitatParcelCount = {};
  var greeninvCounts = { yes: 0, no: 0 }, hasGreeninv = false; // the export carries the opt-in join column
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
  // Habitat columns come in two export shapes: the current pipeline emits code columns
  // habitat_l1_<code>_m2 + habitat_l2_<code>_m2; older exports a single slug family
  // habitat_<slug>_m2. Use the LEVEL-2 leaves only — the l1_ columns are redundant and
  // would double-count. Detect the shape once, then match leaves (the habitat_m2 total
  // never matches). The captured group is the slug/code; habDigit/habCode/hbLabel handle it.
  var _habCodeCols = PARCELS.some(function (p) { for (var k in p) if (k.indexOf("habitat_l2_") === 0) return true; return false; });
  var HABITAT_RE = _habCodeCols ? /^habitat_l2_(.+)_m2$/ : /^habitat_(.+)_m2$/;
  var _habKeyBySlug = {}; // captured slug/code → the actual column key (differs for code columns)
  // Display label per habitat slug (TypoCH level-1) — mirrors web/js/config.js.
  var HABITAT_LABELS = {
    gewaesser: "Gewässer", ufer_feuchtgebiete: "Ufer & Feuchtgebiete",
    gletscher_fels_schutt_geroell: "Gletscher, Fels, Schutt, Geröll", gruenland: "Grünland",
    krautsaeume_hochstauden_gebuesche: "Krautsäume, Hochstauden, Gebüsche", waelder: "Wälder",
    pionier_ruderalvegetation: "Pionier-/Ruderalvegetation", pflanzungen_aecker_kulturen: "Pflanzungen, Äcker, Kulturen",
    gebaeude_anlagen: "Gebäude / Anlagen"
  };
  // Habitat column slug → TypoCH code ("6_3_andere_laubwaelder" → "6.3"; the level-1
  // catch-all "2_ufer_und_feuchtgebiete" → "2"). "" when the slug carries no leading code.
  function habCode(h) {
    var parts = String(h).split("_"), code = [], i = 0;
    while (i < parts.length && /^[0-9]+$/.test(parts[i])) { code.push(parts[i]); i++; }
    return code.join(".");
  }
  // Habitat column slug → "<code> <name>" from the embedded TypoCH reference (consistent
  // with the level-1 group labels). Legacy name-slugs use HABITAT_LABELS; unknown → prettified.
  function hbLabel(h) {
    if (HABITAT_LABELS[h]) return HABITAT_LABELS[h];
    var code = habCode(h);
    return code ? typochLabel(code) : String(h).replace(/_/g, " ");
  }
  // A habitat column is the level-1 "catch-all" when BAFU only classified it to level 1,
  // so its code is a single part (e.g. "6"). The pipeline emits it as habitat_l2_<digit>_m2
  // (level-2 code falls back to the level-1 code), so it sits under its own L1 group as a
  // child that would otherwise read identically to the group total — flag it distinctly.
  function hbIsL1Only(h) { var c = habCode(h); return c !== "" && c.indexOf(".") < 0; }
  function hbLabelFull(h) { return hbIsL1Only(h) ? hbLabel(h) + " (nur Stufe 1)" : hbLabel(h); }
  EXCLUDE_RULES.forEach(function (r) { excludeCounts[r.key] = 0; });
  PARCELS.forEach(function (p) {
    var c = p.input_rg || ""; if (c) cantonCounts[c] = (cantonCounts[c] || 0) + 1;
    var lc = p["input_l/r"] || ""; if (lc) countryCounts[lc] = (countryCounts[lc] || 0) + 1;
    var e = p["input_eigent.art"] || ""; if (e) eigentumCounts[e] = (eigentumCounts[e] || 0) + 1;
    var tp = (p.input_tpf == null || p.input_tpf === "") ? "—" : String(p.input_tpf); tpfCounts[tp] = (tpfCounts[tp] || 0) + 1;
    var st = statusKey(p); statusCounts[st] = (statusCounts[st] || 0) + 1;
    if (isCovered(p)) covWith++; else covWithout++;
    if (p.greeninv === "yes" || p.greeninv === "no") { greeninvCounts[p.greeninv]++; hasGreeninv = true; }
    EXCLUDE_RULES.forEach(function (r) { if (nameMatches(p, r)) excludeCounts[r.key]++; });
    ART_KEYS.forEach(function (a) {
      var v = num(p[artCol(a)]);
      if (v > 0) { artTotal[a] = (artTotal[a] || 0) + v; artParcelCount[a] = (artParcelCount[a] || 0) + 1; }
    });
    for (var bk in p) {
      var bm = BAUZONE_RE.exec(bk);
      if (bm) { var bv = num(p[bk]); if (bv > 0) { var bz = bm[1]; bauzoneTotal[bz] = (bauzoneTotal[bz] || 0) + bv; bauzoneParcelCount[bz] = (bauzoneParcelCount[bz] || 0) + 1; } }
      var hm = HABITAT_RE.exec(bk);
      if (hm) { var hv = num(p[bk]); if (hv > 0) { var hz = hm[1]; _habKeyBySlug[hz] = bk; habitatTotal[hz] = (habitatTotal[hz] || 0) + hv; habitatParcelCount[hz] = (habitatParcelCount[hz] || 0) + 1; } }
    }
  });
  var cantonList = Object.keys(cantonCounts).sort(function (a, b) { return cantonCounts[b] - cantonCounts[a]; });
  // Country list sorted by frequency (CH dominant); the raw ISO code stays the filter key.
  var countryList = Object.keys(countryCounts).sort(function (a, b) { return countryCounts[b] - countryCounts[a]; });
  var artListAll = Object.keys(artTotal).sort(function (a, b) { return artTotal[b] - artTotal[a]; });
  var bauzoneListAll = Object.keys(bauzoneTotal).sort(function (a, b) { return bauzoneTotal[b] - bauzoneTotal[a]; });
  var habitatListAll = Object.keys(habitatTotal).sort(function (a, b) { return habitatTotal[b] - habitatTotal[a]; });
  // Precomputed column-name arrays — built once so the per-parcel aggregate loop
  // doesn't rebuild "av_<a>_m2" / "bauzonen_<z>_m2" / "habitat_<h>_m2" strings every render.
  var artCols = ART_KEYS.map(artCol);
  var bzCols = bauzoneListAll.map(function (z) { return "bauzonen_" + z + "_m2"; });
  var hbCols = habitatListAll.map(function (h) { return _habKeyBySlug[h]; }); // real column key (code cols ≠ "habitat_"+slug)
  var tpfList = Object.keys(tpfCounts).sort(function (a, b) { return tpfCounts[b] - tpfCounts[a]; });
  var eigentumList = Object.keys(eigentumCounts).sort();
  var statusList = STATUS_ORDER.filter(function (s) { return statusCounts[s]; })
    .concat(Object.keys(statusCounts).filter(function (s) { return STATUS_ORDER.indexOf(s) === -1; }));

  // ---- Filter state ----
  // Defaults active on load: ABGA*/LÖVM*/PP* excluded, Eigentumsart 1, Land = CH
  // (E-GRID-Status defaults to "Alle", so the Datenqualität completeness checks can
  // see not-found parcels; Bodenbedeckung defaults to "Alle"). The empty URL
  // represents exactly this default state; query params encode deviations from it.
  // Aggregate "Enthält" categories (clickable on the SIA 416 / Grün·Versiegelung·VBS
  // charts). Like the per-Art filter, each selects Grundstücke that *contain* the
  // category (value > 0) — it does not hide the other land cover of those parcels.
  var HAS_METRICS = {
    GGF:    { label:"Gebäudegrundfläche (GGF)", field:"sia416_ggf_m2" },
    BUF:    { label:"Bearbeitete Umgebung (BUF)", field:"sia416_buf_m2" },
    UUF:    { label:"Unbearbeitete Umgebung (UUF)", field:"sia416_uuf_m2" },
    Green:  { label:"Grünfläche", field:"greenspace_m2" },
    Sealed: { label:"Versiegelte Fläche", field:"sealed_m2" }
  };
  var HAS_KEYS = Object.keys(HAS_METRICS);
  var hasCounts = {};
  HAS_KEYS.forEach(function (m) { hasCounts[m] = 0; });

  // VBS (arImmo) as two independent filter groups — Produktivität (layer 2) and, within
  // the productive share, Typ (layer 3; typ1 + typ2 == produktiv). They get their own
  // facets rather than joining `has`, because that facet ORs across all of its keys:
  // "produktiv or Typ 1" is never a useful question, while two facets AND like every
  // other group ("produktiv" AND "Typ 1") and still OR inside a group.
  var VBS_GROUPS = {
    vbsprod: {
      keys: ["produktiv", "unproduktiv"], pill: "VBS", attr: "vp",
      fields: { produktiv:"vbs_produktiv_m2", unproduktiv:"vbs_unproduktiv_m2" },
      labels: { produktiv:"Biologisch produktiv", unproduktiv:"Biologisch unproduktiv" },
      short:  { produktiv:"Biologisch produktiv", unproduktiv:"Biologisch unproduktiv" }
    },
    vbstyp: {
      keys: ["typ1", "typ2"], pill: "VBS Typ", attr: "vt",
      fields: { typ1:"vbs_typ1_m2", typ2:"vbs_typ2_m2" },
      labels: { typ1:"Typ 1 · Grünflächen in Gebäudeumgebung", typ2:"Typ 2 · Übrige Grünflächen" },
      short:  { typ1:"Typ 1", typ2:"Typ 2" }
    }
  };
  var VBS_FACETS = Object.keys(VBS_GROUPS);
  var vbsCounts = {}; // facet → key → number of parcels carrying that area
  VBS_FACETS.forEach(function (f) { vbsCounts[f] = {}; VBS_GROUPS[f].keys.forEach(function (k) { vbsCounts[f][k] = 0; }); });
  PARCELS.forEach(function (p) {
    HAS_KEYS.forEach(function (m) { if (num(p[HAS_METRICS[m].field]) > 0) hasCounts[m]++; });
    VBS_FACETS.forEach(function (f) {
      VBS_GROUPS[f].keys.forEach(function (k) { if (vbsHas(p, VBS_GROUPS[f].fields[k])) vbsCounts[f][k]++; });
    });
  });
  // A legacy export without any vbs_* column would leave a dead filter behind — hide
  // the whole group in that case (the current pipeline always writes these columns).
  function vbsHasData(f) { return VBS_GROUPS[f].keys.some(function (k) { return vbsCounts[f][k] > 0; }); }

  function defaultEigentum() { return eigentumCounts["1"] ? { "1": true } : {}; }
  // Country defaults to Switzerland — hides the foreign representation parcels (Ausland).
  function defaultCountries() { return countryCounts["CH"] ? { CH: true } : {}; }
  // Bodenbedeckung is a two-option checklist like every other group (so its head
  // carries the same "alle / keine" toggle): an empty selection — or both boxes,
  // since every parcel is either covered or not — means "alle".
  var COVERAGE_KEYS = ["with", "without"];
  var COVERAGE_LABELS = { with: "Mit Bodenbedeckung", without: "Ohne Bodenbedeckung" };
  function coverageCount(k) { return k === "with" ? covWith : covWithout; }
  function defaultFilters() {
    // status defaults to {} (all) — not-found/invalid parcels stay visible so the
    // Datenqualität "gefunden / Geometrie / Fläche" rules actually surface them.
    return { countries:defaultCountries(), cantons:{}, coverage:{}, arts:{}, has:{}, bauzonen:{}, vbsprod:{}, vbstyp:{}, tpf:{}, eigentum:defaultEigentum(), status:{}, exclude:defaultExclude(), greeninv:{} };
  }
  var filters = defaultFilters();

  function passesFilters(p) {
    for (var i = 0; i < EXCLUDE_RULES.length; i++) {
      var r = EXCLUDE_RULES[i];
      if (filters.exclude[r.key] && nameMatches(p, r)) return false;
    }
    var st = Object.keys(filters.status);
    if (st.length && !filters.status[statusKey(p)]) return false;
    var co = Object.keys(filters.countries);
    if (co.length && !filters.countries[p["input_l/r"] || ""]) return false;
    var cs = Object.keys(filters.cantons);
    if (cs.length && !filters.cantons[p.input_rg || ""]) return false;
    var cv = Object.keys(filters.coverage);
    if (cv.length && !cv.some(function (k) { return k === "with" ? isCovered(p) : !isCovered(p); })) return false;
    var as = Object.keys(filters.arts);
    if (as.length && !as.some(function (a) { return num(p[artCol(a)]) > 0; })) return false;
    var bz = Object.keys(filters.bauzonen);
    if (bz.length && !bz.some(function (z) { return num(p["bauzonen_" + z + "_m2"]) > 0; })) return false;
    var hs = Object.keys(filters.has);
    if (hs.length && !hs.some(function (m) { return num(p[HAS_METRICS[m].field]) > 0; })) return false;
    for (var vi = 0; vi < VBS_FACETS.length; vi++) {
      var vf = VBS_FACETS[vi], vg = VBS_GROUPS[vf], vs = Object.keys(filters[vf]);
      if (vs.length && !vs.some(function (k) { return vbsHas(p, vg.fields[k]); })) return false;
    }
    var gi = Object.keys(filters.greeninv);
    if (gi.length && !filters.greeninv[p.greeninv || ""]) return false;
    var es = Object.keys(filters.eigentum);
    if (es.length && !filters.eigentum[p["input_eigent.art"] || ""]) return false;
    var tp = Object.keys(filters.tpf);
    if (tp.length && !filters.tpf[(p.input_tpf == null || p.input_tpf === "") ? "—" : String(p.input_tpf)]) return false;
    return true;
  }
  function activeGroups() {
    var n = 0;
    if (EXCLUDE_RULES.some(function (r) { return filters.exclude[r.key] && excludeCounts[r.key] > 0; })) n++;
    if (Object.keys(filters.countries).length) n++;
    if (Object.keys(filters.cantons).length) n++;
    if (Object.keys(filters.coverage).length === 1) n++; // both boxes = alle = no constraint
    if (Object.keys(filters.arts).length) n++;
    if (Object.keys(filters.bauzonen).length) n++;
    if (Object.keys(filters.has).length) n++;
    VBS_FACETS.forEach(function (f) { if (Object.keys(filters[f]).length) n++; });
    if (Object.keys(filters.tpf).length) n++;
    if (Object.keys(filters.eigentum).length) n++;
    if (Object.keys(filters.status).length) n++;
    if (Object.keys(filters.greeninv).length) n++;
    return n;
  }

  // ---- Table state & search ----
  var SEARCH_KEYS = ["id", "egrid", "nummer", "input_ort", "input_rg", "input_bez. grundstück"];
  var state = { sort:"parcel_area_m2", dir:-1, search:"", page:1, pageSize:25, rows:PARCELS.slice() };
  var selectedParcelId = null; // parcel highlighted on the map / focused in the table
  var printing = false;
  // PDF-report selection: session state (not in the URL), at most SEL_MAX parcels.
  var sel = {};
  function selIds() { return Object.keys(sel); }
  function selCount() { return selIds().length; }
  function selRows() { return selIds().map(parcelById).filter(function (p) { return !!p; }); }

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
    var t = { parcelArea:0, GGF:0, BUF:0, UUF:0, Sealed:0, Green:0, VBSp:0, VBSu:0, VBSa:0, VBSb:0, VBSc:0, VBSd:0, VBSt1:0, VBSt2:0 }, byArt = {}, byBauzone = {}, byHabitat = {}, withData = 0;
    var wfsIssues = 0, geomIssues = 0, nT1 = 0, nT2 = 0, nU = 0, nP = 0; // parcel counts by the 10 % rule
    rows.forEach(function (p) {
      t.parcelArea += num(p.parcel_area_m2);
      t.GGF += num(p.sia416_ggf_m2); t.BUF += num(p.sia416_buf_m2); t.UUF += num(p.sia416_uuf_m2);
      t.Sealed += num(p.sealed_m2); t.Green += num(p.greenspace_m2);
      t.VBSp += num(p.vbs_produktiv_m2); t.VBSu += num(p.vbs_unproduktiv_m2);
      t.VBSt1 += num(p.vbs_typ1_m2); t.VBSt2 += num(p.vbs_typ2_m2); // VBS Typ (within produktiv): typ1+typ2 == produktiv
      t.VBSa += num(p.vbs_kat_a_m2); t.VBSb += num(p.vbs_kat_b_m2); t.VBSc += num(p.vbs_kat_c_m2); t.VBSd += num(p.vbs_kat_d_m2);
      if (isCovered(p)) withData++;
      var h1 = vbsHas(p, "vbs_typ1_m2"), h2 = vbsHas(p, "vbs_typ2_m2");
      if (h1) nT1++; if (h2) nT2++; if (h1 || h2) nP++; if (vbsHas(p, "vbs_unproduktiv_m2")) nU++;
      if (p.check_wfs && p.check_wfs !== "ok") wfsIssues++;
      if (p.check_geom && p.check_geom !== "ok") geomIssues++;
      for (var ai = 0; ai < ART_KEYS.length; ai++) { var av = num(p[artCols[ai]]); if (av) byArt[ART_KEYS[ai]] = (byArt[ART_KEYS[ai]] || 0) + av; }
      for (var zi = 0; zi < bauzoneListAll.length; zi++) { var zv = num(p[bzCols[zi]]); if (zv) byBauzone[bauzoneListAll[zi]] = (byBauzone[bauzoneListAll[zi]] || 0) + zv; }
      for (var hi = 0; hi < habitatListAll.length; hi++) { var hv2 = num(p[hbCols[hi]]); if (hv2) byHabitat[habitatListAll[hi]] = (byHabitat[habitatListAll[hi]] || 0) + hv2; }
    });
    return { len:rows.length, withData:withData, totals:t, byArt:byArt, byBauzone:byBauzone, byHabitat:byHabitat, classified:t.GGF + t.BUF + t.UUF,
             wfsIssues:wfsIssues, geomIssues:geomIssues, nT1:nT1, nT2:nT2, nU:nU, nP:nP };
  }

  // ---- Summary-table renderer (sortable; inline proportion bar per row) ----
  // Default order = the caller's (preserves fixed orders like SIA GGF/BUF/UUF and VBS A–D);
  // clicking the "Kategorie" or value header sets a per-table sort. The user's choice
  // survives filter re-renders; the muted "remainder" row always stays pinned last.
  var _valCtx = {}, _valSort = {}, _treeOpen = {}; // per-table render context / sort / expand-state
  // Habitat mixes TypoCH levels, so default it to category order — clusters each class (1,2,…9).
  _valSort["tbl-habitat"] = { by: "name", dir: 1 };
  // The VBS Produktiv & Typ pivot starts expanded so Typ 1 / Typ 2 are visible without a click.
  _treeOpen["tbl-vbsprod"] = { produktiv: true };
  // opts.showN adds a "Grundstücke" count column (items carry `n`; the Total row shows opts.nTotal).
  function renderValTable(elId, items, total, fmtVal, showTotal, valHeader, anteilHint, opts) {
    _valCtx[elId] = { items: items, total: total, fmtVal: fmtVal, showTotal: showTotal, valHeader: valHeader, anteilHint: anteilHint, showN: !!(opts && opts.showN), nTotal: opts ? opts.nTotal : null };
    _paintValTable(elId);
  }
  // Renders a flat summary table, or — when any item carries `children` — a two-level pivot
  // (parent groups expand/collapse via a chevron). The muted remainder stays pinned last;
  // bars scale to the largest top-level value; sort is hierarchy-aware (groups + their kids).
  function _paintValTable(elId) {
    var el = document.getElementById(elId), ctx = _valCtx[elId]; if (!el || !ctx) return;
    var items = ctx.items, total = ctx.total, fmtVal = ctx.fmtVal, s = _valSort[elId];
    if (!items.length) { el.innerHTML = '<div class="empty-note">Keine Daten</div>'; return; }
    var isTree = false; for (var ii = 0; ii < items.length; ii++) { if (items[ii].children) { isTree = true; break; } }
    var main = [], tail = [];
    items.forEach(function (it) { (it.muted ? tail : main).push(it); });
    var cmp = s ? function (a, b) {
      var r = s.by === "name" ? deCollator.compare(String(a.name), String(b.name)) : (a.value - b.value);
      return r * s.dir;
    } : null;
    if (cmp) main = main.slice().sort(cmp);
    var maxVal = main.reduce(function (m, it) { return Math.max(m, it.value); }, 0) || 1;
    var sum = 0; items.forEach(function (it) { sum += it.value; });
    var open = _treeOpen[elId] || {};
    function row(it, kind, groupKey) { // kind: flat | open | closed | child | muted
      var chev = kind === "open" ? '<span class="tree-icon">−</span>'
               : kind === "closed" ? '<span class="tree-icon">+</span>'
               : kind === "child" ? '<span class="tree-icon tree-spacer"></span>' : "";
      var sw = it.swatch ? '<span class="cat-sw" style="background:' + it.swatch + '"></span>' : "";
      var bar = it.muted ? "" : '<span class="sumbar"><i style="width:' + (it.value / maxVal * 100).toFixed(1) + '%"></i></span>';
      var anteil = total ? pctLabel(it.value, total) : "";
      var cls = ((it.muted ? "muted-row " : "") + (it.key ? "clickable " : "") + (it.selected ? "selected " : "")
               + (kind === "child" ? "tree-child " : "") + (kind === "open" || kind === "closed" ? "tree-parent " : "")).trim();
      var attr = it.key ? ' data-key="' + esc(it.key) + '" tabindex="0" role="button" data-tip="' + esc(it.name + ": anklicken zum Filtern") + '"'
               : (groupKey != null ? ' data-tree-group="' + esc(groupKey) + '" tabindex="0" role="button"' : "");
      var nCell = ctx.showN ? '<td class="num cnt">' + (it.n != null ? fmt(it.n) : "") + '</td>' : "";
      return '<tr class="' + cls + '"' + attr + '><td><span class="cat-cell">' + chev + sw + esc(it.name) + '</span></td>' +
             '<td class="bar-col">' + bar + '</td>' +
             '<td class="num">' + fmtVal(it.value) + '</td><td class="num">' + anteil + '</td>' + nCell + '</tr>';
    }
    var body = "";
    main.forEach(function (g) {
      if (isTree && g.children && g.children.length) {
        var isOpen = !!open[g.group];
        body += row(g, isOpen ? "open" : "closed", g.group);
        if (isOpen) (cmp ? g.children.slice().sort(cmp) : g.children).forEach(function (ch) { body += row(ch, "child"); });
      } else {
        body += row(g, "flat");
      }
    });
    tail.forEach(function (it) { body += row(it, "muted"); });
    var totalRow = ctx.showTotal ? '<tr class="total"><td>Total</td><td class="bar-col"></td><td class="num">' + fmtVal(sum) + '</td><td class="num">' + (total ? pct(sum, total) + " %" : "") + '</td>' +
      (ctx.showN ? '<td class="num cnt">' + (ctx.nTotal != null ? fmt(ctx.nTotal) : "") + '</td>' : "") + '</tr>' : "";
    var hint = ctx.anteilHint ? ' <span class="ftip" tabindex="0" role="img" aria-label="' + esc(ctx.anteilHint) + '" data-tip="' + esc(ctx.anteilHint) + '"></span>' : "";
    function th(by, numCls, label) {
      var on = s && s.by === by, arr = on ? ' <span class="arrow">' + (s.dir < 0 ? ICON.sz("chevDown", 12) : ICON.sz("chevUp", 12)) + "</span>" : "";
      return '<th class="' + (numCls ? numCls + " " : "") + "sortable" + (on ? " sorted" : "") + '" data-vs="' + by +
             '" tabindex="0" role="button" aria-sort="' + (on ? (s.dir < 0 ? "descending" : "ascending") : "none") + '">' + label + arr + '</th>';
    }
    el.innerHTML = '<table class="sumtbl' + (isTree ? " tree-tbl" : "") + '"><thead><tr>' + th("name", "", "Kategorie") + '<th class="bar-col"></th>' +
      th("value", "num", (ctx.valHeader || "")) + '<th class="num">Anteil' + hint + '</th>' + (ctx.showN ? '<th class="num">Grundstücke</th>' : "") + '</tr></thead><tbody>' + body + totalRow + '</tbody></table>';
  }
  // Header click → sort that table (toggle direction), hierarchy-aware.
  function _valSortAct(e) {
    if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
    var th = e.target.closest && e.target.closest(".sumtbl th.sortable[data-vs]"); if (!th) return;
    if (e.type === "keydown") e.preventDefault();
    var tbl = th.closest("table"), host = tbl && tbl.parentNode, elId = host && host.id;
    if (!elId || !_valCtx[elId]) return;
    var by = th.getAttribute("data-vs"), cur = _valSort[elId];
    _valSort[elId] = (cur && cur.by === by) ? { by: by, dir: -cur.dir } : { by: by, dir: by === "name" ? 1 : -1 };
    _paintValTable(elId);
  }
  document.addEventListener("click", _valSortAct);
  document.addEventListener("keydown", _valSortAct);
  // Pivot group row → expand/collapse; header buttons ([data-tree-all]) → expand/collapse all.
  function _treeToggleAct(e) {
    if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
    var tr = e.target.closest && e.target.closest("tr[data-tree-group]"); if (!tr) return;
    if (e.type === "keydown") e.preventDefault();
    var tbl = tr.closest("table"), host = tbl && tbl.parentNode, elId = host && host.id;
    if (!elId || !_valCtx[elId]) return;
    var g = tr.getAttribute("data-tree-group"), o = _treeOpen[elId] || (_treeOpen[elId] = {});
    if (o[g]) delete o[g]; else o[g] = true;
    _paintValTable(elId);
  }
  document.addEventListener("click", _treeToggleAct);
  document.addEventListener("keydown", _treeToggleAct);
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-tree-all]"); if (!b) return;
    var elId = b.getAttribute("data-tree-all"), ctx = _valCtx[elId]; if (!ctx) return;
    var o = _treeOpen[elId] = {};
    if (b.getAttribute("data-open") === "1") ctx.items.forEach(function (it) { if (it.children && it.children.length) o[it.group] = true; });
    _paintValTable(elId);
  });

  // ---- Parcel area + parcel count grouped by a field (Teilportfolio, Region) → table items ----
  // Exclusive counts (each parcel in exactly one group), so the count column sums to the Total row.
  function groupBarItems(rows, field, selMap, topN, labelFn) {
    var map = {}, cnt = {};
    rows.forEach(function (p) {
      var v = p[field]; var k = (v == null || v === "") ? "—" : String(v);
      map[k] = (map[k] || 0) + num(p.parcel_area_m2); cnt[k] = (cnt[k] || 0) + 1;
    });
    var keys = Object.keys(map).sort(function (a, b) { return map[b] - map[a] || cnt[b] - cnt[a]; });
    var items = keys.slice(0, topN).map(function (k) {
      return { name: labelFn ? labelFn(k) : k, value: map[k], n: cnt[k], key: (k === "—" ? null : k), selected: !!(selMap && selMap[k]) };
    });
    if (keys.length > topN) {
      var rest = 0, restN = 0; keys.slice(topN).forEach(function (k) { rest += map[k]; restN += cnt[k]; });
      items.push({ name: "Übrige (" + (keys.length - topN) + ")", value: rest, n: restN, swatch: "#cbd5e1" });
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
        tip:"Summe der berechneten Grundstücksflächen (GSF), 2D-Planfläche auf LV95 (EPSG:2056). " +
            "Klassifizierte Bodenbedeckung: " + fmtAreaU(a.classified) + " (" + ofArea(a.classified) + ")." },
      { label:"Grünfläche", value:fmtAreaU(a.totals.Green), sub:ofCover(a.totals.Green),
        tip:"Humusierte und bestockte Flächen gemäss Grünflächen-Klassifizierung. Aktuell " + ofCover(a.totals.Green) + " bzw. " + ofArea(a.totals.Green) + "." },
      { label:"Versiegelte Fläche", value:fmtAreaU(a.totals.Sealed), sub:ofCover(a.totals.Sealed),
        tip:"Gebäude und befestigte Flächen (versiegelt). Aktuell " + ofCover(a.totals.Sealed) + " bzw. " + ofArea(a.totals.Sealed) + "." },
      { label:"Gebäudegrundfläche (GGF)", value:fmtAreaU(a.totals.GGF), sub:ofCover(a.totals.GGF),
        tip:"Gebäudegrundfläche nach SIA 416 (GGF). Aktuell " + ofCover(a.totals.GGF) + " bzw. " + ofArea(a.totals.GGF) + "." },
      { label:"Grundstücke mit Typ 1", value:fmt(a.nT1), sub:"Typ 2: " + fmt(a.nT2) + " · ab 10 % Fläche",
        tip:"Grundstücke, deren VBS-Typ-Fläche mindestens 10 % der Grundstücksfläche ausmacht. Ein Grundstück kann beide Typen haben." }
    ];
    document.getElementById("kpis").innerHTML = kpis.map(function (k) {
      return '<div class="card"><div class="label tip-term" data-tip="' + esc(k.tip) + '">' + k.label + '</div>' +
             '<div class="value">' + k.value + '</div><div class="sub">' + k.sub + '</div></div>';
    }).join("");

    // Bodenbedeckung nach Art — pivot: Hauptgruppe (L1) → BBArt (L2). L2 keeps `key` so a
    // BBArt row still toggles the Art filter; the L1 group row expands/collapses.
    var artByMain = {};
    Object.keys(a.byArt).forEach(function (k) {
      if (!(a.byArt[k] > 0)) return;
      var main = ART_MAIN[k] || "—";
      var g = artByMain[main] || (artByMain[main] = { name: main, value: 0, swatch: MAIN_COLORS[main] || "#94a3b8", group: main, children: [] });
      g.value += a.byArt[k];
      g.children.push({ name: ART_LABELS[k] || k, value: a.byArt[k], swatch: mainColor(k), key: k, selected: !!filters.arts[k] });
    });
    var artGroups = Object.keys(artByMain).map(function (m) { return artByMain[m]; }).sort(function (x, y) { return y.value - x.value; });
    artGroups.forEach(function (g) { g.children.sort(function (x, y) { return y.value - x.value; }); });
    var gsfHint = "Anteil an der gesamten Grundstücksfläche (GSF) der Auswahl.";
    var pa = a.totals.parcelArea;
    // Append a muted "remainder" row so each table sums to 100 % of the Grundstücksfläche;
    // the gap = parcel area the categories don't cover (z. B. ohne Bodenbedeckungsdaten).
    function withMiss(items, label, n) {
      var s = 0; items.forEach(function (it) { s += it.value; });
      var m = pa - s;
      return m > 0 ? items.concat([{ name: label || "Ohne Bodenbedeckung", value: m, muted: true, n: n }]) : items;
    }
    renderValTable("tbl-art", withMiss(artGroups), pa, fmtArea, true, unitLabel(), gsfHint);
    // Provenance note: parcels whose land cover was synthesized from BAFU (real AV < 5 %) are
    // blended into the BBArt totals above, but those areas are modelled estimates, not surveyed.
    var artNote = document.getElementById("note-art");
    if (artNote) {
      // lc_synthetic === "yes" is the precise flag (a real synthetic-cover parcel); lc_source
      // === "BAFU" also tags zero-area degenerate rows, so it would over-count. This matches
      // the per-parcel ⚠ warning in the detail view (buildParcelDetailHTML).
      var synthN = 0; for (var si = 0; si < rows.length; si++) { if (rows[si].lc_synthetic === "yes") synthN++; }
      if (synthN > 0) {
        artNote.innerHTML = "Enthält " + fmt(synthN) + " von " + fmt(rows.length) + " Grundstücken mit <strong>synthetischer</strong> Bodenbedeckung (aus BAFU-Lebensräumen modelliert, da amtliche AV-Daten fehlen). Diese Flächen sind Schätzwerte.";
        artNote.hidden = false;
      } else { artNote.hidden = true; }
    }
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
    // VBS Produktivität (Layer 2) → Typ (Layer 3) as a pivot: "Biologisch produktiv" expands
    // to Typ 1 / Typ 2 (which sum to it exactly — VBSt1+VBSt2==VBSp); "Biologisch unproduktiv"
    // is a sibling. The muted "Ohne Bodenbedeckung" remainder (via withMiss) keeps the Total at
    // 100 % of GSF. Collapsed, this reads exactly like the former flat "VBS Produktiv" tab.
    renderValTable("tbl-vbsprod", withMiss([
      { name:"Biologisch produktiv", value:a.totals.VBSp, n:a.nP, group:"produktiv", children:[
        { name:"Typ 1 · Grünflächen in Gebäudeumgebung", value:a.totals.VBSt1, n:a.nT1 },
        { name:"Typ 2 · Übrige Grünflächen", value:a.totals.VBSt2, n:a.nT2 }
      ] },
      { name:"Biologisch unproduktiv", value:a.totals.VBSu, n:a.nU }
    ], null, a.len - a.withData), pa, fmtArea, true, unitLabel(), gsfHint, { showN: true, nTotal: a.len });
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
      // BAFU Lebensräume — pivot: TypoCH class (L1, by leading digit) → group (L2). Both
      // levels get consistent "<code> <name>" labels from the embedded TypoCH reference.
      var hbByDigit = {};
      habitatListAll.forEach(function (h) {
        var v = a.byHabitat[h] || 0; if (!(v > 0)) return;
        var d = habDigit(h) || "?";
        var g = hbByDigit[d] || (hbByDigit[d] = { name: typochLabel(d), value: 0, swatch: HABITAT_L1_COLORS[d] || "#8e7cc3", group: d, children: [] });
        g.value += v;
        g.children.push({ name: hbLabelFull(h), value: v, swatch: habColor(h) });
      });
      var hbGroups = Object.keys(hbByDigit).map(function (d) { return hbByDigit[d]; });
      renderValTable("tbl-habitat", withMiss(hbGroups, "Ohne Lebensraum-Daten"), pa, fmtArea, true, unitLabel(), gsfHint);
    }
    renderValTable("tbl-tpf", groupBarItems(rows, "input_tpf", filters.tpf, 12, tpfLabel), a.totals.parcelArea, fmtArea, true, unitLabel(), gsfHint, { showN: true, nTotal: a.len });
    renderValTable("tbl-rg", groupBarItems(rows, "input_rg", filters.cantons, 12), a.totals.parcelArea, fmtArea, true, unitLabel(), gsfHint, { showN: true, nTotal: a.len });

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
  var qAllProblems = [], qRules = {}, qActiveRule = null, qTotal = 0; // qActiveRule = a clicked Prüfregel → table shows its fails; qTotal = filtered total (Prüfregeln denominator)
  function renderQuality(rows) {
    if (!document.getElementById("q-kpis")) return;
    qTotal = rows.length;
    qRules = computeRules(rows);
    // Auffällige Grundstücke = every parcel that failed ≥1 Prüfregel (deduped, in row
    // order); the hint lists the check name(s) it did not pass.
    var failNames = new Map(); // parcel → [failed rule names]
    RULE_DEFS.forEach(function (d) {
      qRules[d.key].fails.forEach(function (f) {
        var e = failNames.get(f.p); if (e) e.push(d.name); else failNames.set(f.p, [d.name]);
      });
    });
    qAllProblems = [];
    var c = { found:0, merged:0, not_found:0, invalid:0, error:0 }, cOther = 0;
    rows.forEach(function (p) {
      var names = failNames.get(p); if (names) qAllProblems.push({ p: p, hint: names.join(", ") });
      var sk = statusKey(p); if (c[sk] != null) c[sk]++; else cOther++;
    });
    var denom = rows.length || 1;
    // KPIs = headline of the most important Prüfregeln; each count equals its rule's
    // "abweichend" count in the Prüfregeln table below.
    var kpiFail = function (label, key) {
      return { label: label, value: fmt(qRules[key].fail), sub: pct(qRules[key].fail, denom) + "% der Auswahl" };
    };
    var qk = [
      { label:"Grundstücke", value:fmt(rows.length) + " / " + fmt(PARCELS.length), sub:"Auswahl / Alle" },
      kpiFail("E-GRID nicht gefunden", "egrid"),
      kpiFail("Bodenbedeckung unvollständig", "bbCover"),
      kpiFail("Lebensräume unvollständig", "hbCover")
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
  // Names + descriptions kept deliberately plain. Each rule is only evaluated on the
  // subset it applies to (e.g. Bodenbedeckungs-Regeln nur auf Grundstücke mit Bodenbedeckung),
  // so the tips state the scope — the table shows how many wurden übersprungen.
  var RULE_DEFS = [
    { key: "egrid", name: "Grundstück E-GRID im Kataster gefunden", tip: "Die E-GRID wurde in der amtlichen Vermessung gefunden und die Geometrie geladen. Geprüft: alle Grundstücke der Auswahl." },
    { key: "geom", name: "Geometrie vorhanden", tip: "Der Grundstück-Eintrag enthält eine Polygon-Geometrie (nicht NULL). Geprüft: alle Grundstücke der Auswahl." },
    { key: "area", name: "Fläche vorhanden", tip: "Die Grundstücksfläche ist eine gültige, positive Zahl (nicht NULL, grösser 0). Geprüft: alle Grundstücke der Auswahl." },
    { key: "egridUnique", name: "E-GRID eindeutig", tip: "Jede E-GRID kommt in der aktuellen Auswahl nur einmal vor (keine doppelten Einträge). Geprüft: Grundstücke mit E-GRID." },
    { key: "bbCover", name: "Summe Bodenbedeckung = Grundstücksfläche", tip: "Die Summe der einzelnen Bodenbedeckungsflächen (Gebäude + Umgebung) entspricht der Grundstücksfläche (±1 %). Nur Grundstücke mit Bodenbedeckungsdaten." },
    { key: "bzCover", name: "Summe Bauzonen = Grundstücksfläche", tip: "Die Summe der einzelnen Bauzonenflächen inkl. „Ohne Bauzone“ entspricht der Grundstücksfläche (±1 %). Nur Grundstücke mit Bauzonen-Daten." },
    { key: "hbCover", name: "Summe Lebensräume = Grundstücksfläche", tip: "Die Summe der einzelnen BAFU-Lebensraumflächen entspricht der Grundstücksfläche (±1 %). Nur Grundstücke mit Lebensraum-Daten." }
  ];
  // Per-parcel derived scalars for the quality rules. Parcels are
  // immutable, so the wide-column scan runs once per parcel and is cached in a WeakMap
  // (not on the object — keeps it out of exports/the embedded deliverable). This turns
  // the repeated per-render O(columns) scans in computeRules into
  // O(1) lookups. Field semantics mirror the original inline loops exactly:
  //   bzSum    — Σ bauzonen_<slug> EXCLUDING ohne_bauzone (the actual building-zone share)
  //   bzSumAll — Σ bauzonen_<slug> INCLUDING ohne_bauzone (the full parcel partition)
  var _statsCache = new WeakMap();
  function parcelStats(p) {
    var s = _statsCache.get(p); if (s) return s;
    var bzSum = 0, bzSumAll = 0, hbSum = 0, hbNat = 0, nLc = 0, nHb = 0, bzDom = 0, bzDomSlug = "";
    for (var k in p) {
      if (!Object.prototype.hasOwnProperty.call(p, k) || k.slice(-3) !== "_m2") continue;
      var v = num(p[k]);
      var bm = BAUZONE_RE.exec(k);
      if (bm) { bzSumAll += v; if (bm[1] !== "ohne_bauzone") { bzSum += v; if (v > bzDom) { bzDom = v; bzDomSlug = bm[1]; } } continue; }
      var hm = HABITAT_RE.exec(k);
      if (hm) { hbSum += v; if (v > 0) nHb++; if (HABITAT_NAT_DIGIT[habDigit(hm[1])]) hbNat += v; continue; }
      if (k.indexOf("av_") === 0) { if (v > 0) nLc++; }
    }
    s = { bzSum: bzSum, bzSumAll: bzSumAll, hbSum: hbSum, hbNat: hbNat, nLc: nLc, nHb: nHb, bzDom: bzDom, bzDomSlug: bzDomSlug };
    _statsCache.set(p, s); return s;
  }
  function computeRules(rows) {
    var R = {}; RULE_DEFS.forEach(function (d) { R[d.key] = { name: d.name, pass: 0, fail: 0, est: 0, fails: [] }; });
    // E-GRID uniqueness is judged over the current (filtered) selection — count first.
    var egCounts = {};
    rows.forEach(function (p) { var eg = String(p.egrid == null ? "" : p.egrid).trim(); if (eg) egCounts[eg] = (egCounts[eg] || 0) + 1; });
    rows.forEach(function (p) {
      var area = num(p.parcel_area_m2), tol = Math.max(1, area * 0.01);
      var nearOK = function (a, b) { return Math.abs(a - b) <= tol; };
      // pass → count; fail → count + remember the parcel so a click can list them.
      var rec = function (key, ok) { if (ok) R[key].pass++; else { R[key].fail++; R[key].fails.push({ p: p, hint: R[key].name }); } };
      var classified = num(p.sia416_ggf_m2) + num(p.sia416_buf_m2) + num(p.sia416_uuf_m2);
      var st = parcelStats(p), sumBz = st.bzSumAll, sumHb = st.hbSum;
      var cov = isCovered(p);
      // Completeness — every entry must resolve, carry a geometry + a real area, and be unique.
      var sk = statusKey(p);
      rec("egrid", sk === "found" || sk === "merged");
      rec("geom", !!p._geom);
      rec("area", area > 0);
      var eg = String(p.egrid == null ? "" : p.egrid).trim();
      if (eg) rec("egridUnique", egCounts[eg] === 1);
      // Flächenbilanz — classified cover / Bauzonen / Lebensräume tile the parcel.
      if (cov) rec("bbCover", nearOK(classified, area));
      if (sumBz > 0 || (!!p.check_bauzonen && p.check_bauzonen !== "error")) rec("bzCover", nearOK(sumBz, area));
      if (sumHb > 0 || (!!p.check_habitat && p.check_habitat !== "error")) rec("hbCover", nearOK(sumHb, area));
    });
    return R;
  }
  function renderRulesTable() {
    var el = document.getElementById("q-rules"); if (!el) return;
    var body = RULE_DEFS.map(function (d) {
      var r = qRules[d.key], ok = r.fail === 0;
      var status = ok ? ICON.check : ICON.alert, cls = ok ? "rule-ok" : "rule-warn", aLabel = ok ? "bestanden" : "Abweichung";
      var result = fmt(r.fail) + " von " + fmt(qTotal) + " abweichend"; // always: fails out of the filtered total
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
      if (active) cnt.innerHTML = "Regel »" + esc(qRules[active].name) + "« · " + fmt(qProblems.length) + " · <span class='q-filter-x' id='q-filter-x' role='button' tabindex='0'>" + ICON.sz("x", 13) + "Filter aufheben</span>";
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
        return '<a class="egrid-link" href="' + u + '" target="_blank" rel="noopener" data-tip="Grundstück auf map.geo.admin.ch öffnen (ÖREB-Kataster, neuer Tab)">' + esc(v) + ICON.sz("extlink", 12) + "</a>";
      } },
    { key:"nummer", label:"Grundstück-Nr.", def:false, tip:"Offizielle Grundstücknummer aus der amtlichen Vermessung." },
    { key:"input_ort", label:"Ort", def:true, tip:"Standortgemeinde des Grundstücks." },
    { key:"input_plz", label:"PLZ", def:false, tip:"Postleitzahl." },
    { key:"input_rg", label:"Kanton", def:true, tip:"Kanton (Region)." },
    { key:"input_bez. grundstück", label:"Bezeichnung", def:true, tip:"Bezeichnung des Grundstücks aus SAP." },
    { key:"input_eigent.art", label:"Eigentumsart", def:false, tip:"Eigentumsart aus SAP (1 = Eigentum Bund, 3 = Anmiete, 5 = Spezialfall).", render: function (v) { return v ? esc(eigentumLabel(v)) : '<span class="muted">–</span>'; } },
    { key:"input_tpf", label:"Teilportfolio", def:false, tip:"Teilportfolio (GOM) aus SAP.", render: function (v) { return v ? esc(tpfLabel(v)) : '<span class="muted">–</span>'; } },
    { key:"check_egrid", label:"Status", def:false, tip:"E-GRID-Status (gefunden / zusammengeführt / nicht gefunden)." },
    { key:"greeninv", label:"Grüninventar", def:true, tip:"Im Grüninventar der Bundesgärtnerei erfasst (Abgleich über E-GRID und SAP-Schlüssel). Der Link öffnet das Grüninventar an der Lage des Grundstücks.",
      render: function (v, p) {
        if (v !== "yes" && v !== "no") return '<span class="muted">–</span>';
        var u = v === "yes" ? greenInventoryUrl(p) : "";
        return u ? '<a class="egrid-link" href="' + esc(u) + '" target="_blank" rel="noopener" data-tip="Im Grüninventar öffnen (neuer Tab)">' + esc(greeninvLabel(v)) + ICON.sz("extlink", 12) + '</a>' : esc(greeninvLabel(v));
      } },
    { key:"parcel_area_m2", label:"Grundstücksfläche m²", num:true, def:true, tip:"Berechnete Grundstücksfläche (GSF), 2D-Planfläche auf LV95." },
    { key:"sia416_ggf_m2", label:"GGF m²", num:true, def:true, tip:"Gebäudegrundfläche nach SIA 416." },
    { key:"sia416_buf_m2", label:"BUF m²", num:true, def:false, tip:"Bearbeitete Umgebungsfläche nach SIA 416 (befestigt + humusiert)." },
    { key:"sia416_uuf_m2", label:"UUF m²", num:true, def:false, tip:"Unbearbeitete Umgebungsfläche nach SIA 416 (Gewässer + bestockt + vegetationslos)." },
    { key:"greenspace_m2", label:"Grünfläche m²", num:true, def:true, tip:"Grünfläche (humusiert + bestockt)." },
    { key:"sealed_m2", label:"Versiegelt m²", num:true, def:true, tip:"Versiegelte Fläche (Gebäude + befestigt)." },
    { key:"vbs_produktiv_m2", label:"VBS produktiv m²", num:true, def:false, tip:"Biologisch produktive Fläche (VBS-Klassifizierung)." },
    { key:"vbs_unproduktiv_m2", label:"VBS unproduktiv m²", num:true, def:false, tip:"Biologisch unproduktive Fläche (VBS-Klassifizierung)." },
    // Typ 1 + Typ 2 partition the productive share — selectable so the VBS-Typ filter's
    // dimension can also be read off the table (both default-hidden, like the two above).
    { key:"vbs_typ1_m2", label:"VBS Typ 1 m²", num:true, def:false, tip:"Typ 1 · Grünflächen in Gebäudeumgebung (Teil der biologisch produktiven Fläche)." },
    { key:"vbs_typ2_m2", label:"VBS Typ 2 m²", num:true, def:false, tip:"Typ 2 · Übrige Grünflächen (Teil der biologisch produktiven Fläche)." }
  ];
  if (!hasGreeninv) COLUMNS = COLUMNS.filter(function (c) { return c.key !== "greeninv"; }); // column only when the export carries the join
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
  // Rows of the current page (what the header checkbox selects).
  function pageRows() { var start = (state.page - 1) * state.pageSize; return printing ? state.rows : state.rows.slice(start, start + state.pageSize); }
  function renderHead() {
    var vis = COLUMNS.filter(function (c) { return c.visible; });
    var pr = pageRows(), allSel = pr.length > 0 && pr.every(function (p) { return !!sel[String(p.id == null ? "" : p.id)]; });
    document.getElementById("thead-row").innerHTML =
      '<th class="sel-col" scope="col"><input type="checkbox" id="sel-all" aria-label="Alle Grundstücke dieser Seite für den PDF-Bericht auswählen" title="Alle dieser Seite auswählen"' + (allSel ? " checked" : "") + '></th>' +
      vis.map(function (c) {
      var sorted = state.sort === c.key;
      var arrow = sorted ? ' <span class="arrow">' + (state.dir < 0 ? ICON.sz("chevDown", 12) : ICON.sz("chevUp", 12)) + "</span>" : "";
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
    var full = selCount() >= SEL_MAX;
    document.getElementById("tbody").innerHTML = pageRows().map(function (p) {
      var pid = (p.id == null ? "" : String(p.id)), isSel = !!sel[pid];
      var cls = ((selectedParcelId && pid === selectedParcelId) ? "row-selected " : "") + (isSel ? "row-sel" : "");
      var rs = cls.trim() ? ' class="' + cls.trim() + '"' : "";
      var cb = '<td class="sel-col"><input type="checkbox" data-sel="' + esc(pid) + '" aria-label="Für PDF-Bericht auswählen"' + (isSel ? " checked" : "") + (!isSel && full ? ' disabled title="Maximal ' + SEL_MAX + ' Grundstücke"' : "") + '></td>';
      return '<tr data-id="' + esc(pid) + '" tabindex="0"' + rs + ">" + cb + vis.map(function (c) {
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
    document.getElementById("tfoot-row").innerHTML = '<td class="sel-col"></td>' + vis.map(function (c) {
      if (c.num) return '<td class="num">' + fmtArea(sums[c.key]) + "</td>";
      if (!labelDone) { labelDone = true; return "<td>Total · " + fmt(state.rows.length) + " Grundstücke</td>"; }
      return "<td></td>";
    }).join("");
  }
  function renderTable() { renderHead(); renderBody(); renderFoot(); renderPager(); }

  // Select (focus) a parcel from the map: highlight its polygon, then page to / highlight its row
  // in the table. No viewport scroll.
  function selectParcel(id) {
    selectedParcelId = (id == null || id === "") ? null : String(id);
    if (map && mapReady && map.getLayer("parcels-hl")) {
      var hlFilter = ["==", ["get", "id"], selectedParcelId || " "];
      map.setFilter("parcels-hl", hlFilter);
      if (map.getLayer("parcels-hl-casing")) map.setFilter("parcels-hl-casing", hlFilter);
    }
    if (!selectedParcelId) { renderBody(); return; }
    var idx = -1;
    for (var i = 0; i < state.rows.length; i++) {
      if (String(state.rows[i].id == null ? "" : state.rows[i].id) === selectedParcelId) { idx = i; break; }
    }
    if (idx < 0) { renderBody(); return; } // parcel is filtered out of the current table
    var page = Math.floor(idx / state.pageSize) + 1;
    if (page !== state.page) { state.page = page; renderPager(); }
    renderHead(); renderBody();
  }
  // Table row click, search hit, popup action → switch to the map tab, select + fly to the parcel.
  function focusParcel(id, opts) {
    selectParcel(id);
    if (currentTab !== "map") { showTab("map"); setTimeout(function () { zoomToParcel(id, opts); }, 80); } // let the map resize first
    else zoomToParcel(id, opts);
  }
  // Deep link into the green inventory app at the parcel's visual centre (the app reads center + zoom from its URL).
  function greenInventoryUrl(p) {
    if (!p || !p._geom) return "";
    if (p._pole === undefined) p._pole = poleOfGeom(p._geom);
    if (!p._pole) return "";
    return GREEN_INVENTORY_APP + "?center=" + p._pole[0].toFixed(5) + "," + p._pole[1].toFixed(5) + "&zoom=17.5";
  }
  var _parcelById = null;
  function parcelById(id) {
    if (!_parcelById) { _parcelById = {}; PARCELS.forEach(function (p) { _parcelById[String(p.id == null ? "" : p.id)] = p; }); }
    return _parcelById[String(id)];
  }
  function zoomToParcel(id, opts) {
    if (id == null || id === "") return;
    var p = parcelById(id); if (!p || !p._geom) return;
    if (!map || !mapReady) { _pendingZoom = { id: id, opts: opts }; return; } // the map is still loading: fly once it is ready
    if (opts && opts.zoom) { var pole = poleOfGeom(p._geom); if (pole) map.flyTo({ center: pole, zoom: opts.zoom, duration: 800 }); }
    else fitMap(rowsToFC([p]), true);
    if (!(opts && opts.noPopup)) openParcelPopup(p); // anchored at the parcel's visual centre, so it rides along with the camera
  }
  var _pendingZoom = null;

  // ---- PDF-report selection (table checkboxes, map popup) ----
  function setSelected(id, on) {
    var k = String(id == null ? "" : id); if (!k) return;
    if (on) { if (!sel[k] && selCount() >= SEL_MAX) return; sel[k] = 1; } else delete sel[k];
    renderSelUI();
  }
  function clearSelection() { sel = {}; renderSelUI(); }
  // Re-render everything that shows the selection: table rows, table bar, map outline + bar, download counts.
  function renderSelUI() {
    renderHead(); renderBody();
    var n = selCount(), info = document.getElementById("sel-info"), lbl = document.getElementById("sel-label"), sf = document.getElementById("sel-filtered"), pb = document.getElementById("pdf-sel-btn");
    if (info) info.hidden = n === 0;
    if (lbl) lbl.textContent = n + " von max. " + SEL_MAX + " ausgewählt";
    if (sf) { var canAll = n === 0 && state.rows.length > 0 && state.rows.length <= SEL_MAX; sf.hidden = !canAll; sf.textContent = "Alle " + state.rows.length + " gefilterten auswählen"; }
    if (pb) { pb.disabled = n === 0; pb.textContent = n ? "PDF-Bericht (" + n + ")" : "PDF-Bericht"; pb.title = n ? "A3-Bericht, eine Seite pro ausgewähltem Grundstück" : "Zuerst Grundstücke über die Checkboxen auswählen (max. " + SEL_MAX + ")"; }
    if (map && mapReady && map.getLayer("parcels-sel")) map.setFilter("parcels-sel", ["in", ["get", "id"], ["literal", selIds()]]);
    renderSelBar();
  }

  // ---- Central update: filter → recompute everything ----
  var currentTab = "map"; // active tab; gates the costly Datenqualität render out of update()
  function update() {
    var rows = getFiltered();
    state.rows = rows;
    sortRows();
    state.page = 1;
    renderDashboard(rows);
    if (currentTab === "quality") renderQuality(rows); // skip the costly rule scan unless the Datenqualität tab is open
    renderTable();
    renderMap(rows);
    var n = activeGroups(), b = document.getElementById("filter-badge");
    if (b) { b.textContent = n; b.classList.toggle("show", n > 0); }
    var filtered = rows.length < PARCELS.length;
    var fk = document.getElementById("flag-kpi"); if (fk) fk.classList.toggle("show", filtered);
    var fq = document.getElementById("flag-q"); if (fq) fq.classList.toggle("show", filtered);
    var fc = document.getElementById("f-count"); if (fc) fc.textContent = fmt(rows.length) + " Grundstücke";
    renderPills();
    renderSelUI();
  }
  function commit() { refitMap = true; writeURL(); update(); }

  // ---- Active-filter pills ----
  var _pillActions = [];
  function buildPills() {
    var pills = [];
    if (state.search.trim()) {
      pills.push({ label: "Tabelle: «" + state.search.trim() + "»", remove: function () { state.search = ""; document.getElementById("tsearch").value = ""; } });
    }
    EXCLUDE_RULES.forEach(function (r) {
      if (filters.exclude[r.key] && excludeCounts[r.key] > 0)
        pills.push({ label: "Ohne: " + r.label, remove: function () { delete filters.exclude[r.key]; } });
    });
    Object.keys(filters.countries).forEach(function (c) {
      pills.push({ label: "Land: " + countryLabel(c), remove: function () { delete filters.countries[c]; } });
    });
    Object.keys(filters.cantons).forEach(function (c) {
      pills.push({ label: "Kanton: " + c, remove: function () { delete filters.cantons[c]; } });
    });
    // Only a single-sided selection narrows anything — both boxes means "alle".
    if (Object.keys(filters.coverage).length === 1) {
      var covKey = Object.keys(filters.coverage)[0];
      pills.push({ label: covKey === "with" ? "Nur mit Bodenbedeckung" : "Nur ohne Bodenbedeckung", remove: function () { filters.coverage = {}; } });
    }
    Object.keys(filters.arts).forEach(function (a) {
      pills.push({ label: "Enthält: " + (ART_LABELS[a] || a), remove: function () { delete filters.arts[a]; } });
    });
    Object.keys(filters.bauzonen).forEach(function (z) {
      pills.push({ label: "Bauzone: " + bzLabel(z), remove: function () { delete filters.bauzonen[z]; } });
    });
    Object.keys(filters.has).forEach(function (m) {
      pills.push({ label: "Enthält: " + HAS_METRICS[m].label, remove: function () { delete filters.has[m]; } });
    });
    VBS_FACETS.forEach(function (f) {
      Object.keys(filters[f]).forEach(function (k) {
        pills.push({ label: VBS_GROUPS[f].pill + ": " + VBS_GROUPS[f].short[k], remove: function () { delete filters[f][k]; } });
      });
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
    Object.keys(filters.greeninv).forEach(function (g) {
      pills.push({ label: "Grüninventar: " + greeninvLabel(g), remove: function () { delete filters.greeninv[g]; } });
    });
    return pills;
  }
  function renderPills() {
    _pillActions = buildPills();
    var row = document.getElementById("pill-row");
    if (!_pillActions.length) { row.innerHTML = ""; row.style.display = "none"; return; }
    row.style.display = "flex";
    row.innerHTML = _pillActions.map(function (p, i) {
      return '<span class="pill">' + esc(p.label) + '<button class="pill-x" data-i="' + i + '" aria-label="Filter entfernen">' + ICON.sz("x", 12) + '</button></span>';
    }).join("") + '<button class="pill-reset" id="pill-reset">Alle Filter zurücksetzen</button>';
  }

  // ---- Reset & drawer sync ----
  function resetAll() {
    filters = defaultFilters();
    state.search = ""; document.getElementById("tsearch").value = "";
    syncDrawer(); commit();
  }
  function syncDrawer() {
    renderExclude(); renderStatus(); renderCoverage(); renderCountries(); renderCantons(); renderArts(); renderBauzonen(); renderVbsProd(); renderVbsTyp(); renderTpf(); renderEigentum(); renderGreeninv();
  }

  // ---- URL <-> state ----
  // Explicit model: every active filter is its own URL parameter; removing a
  // filter drops its parameter. A URL with no filter params means "no filters";
  // a completely empty URL (first visit) applies the defaults and stamps them in.
  // Navigation state travels alongside, never counting as a filter: tab=map|overview|quality|about,
  // basemap=light|standard|aerial|aerial-labels|dark, ext=<external map ids, "-" prefix = hidden>.
  var URL_KEYS = ["q", "excl", "status", "eig", "cov", "land", "kanton", "art", "bauz", "has", "vbsp", "vbst", "tpf", "gi"];
  var NAV_KEYS = ["tab", "basemap", "ext"];
  var VBS_URL_KEY = { vbsprod: "vbsp", vbstyp: "vbst" };
  var urlMigrated = false; // a legacy parameter was rewritten to its current spelling
  var nav = { tab: "map", basemap: null, ext: null }; // parsed navigation params (consumed by showTab / the map)
  function writeURL() {
    var pr = new URLSearchParams();
    if (currentTab && currentTab !== "map") pr.set("tab", currentTab);
    if (typeof basemapUrlValue === "function" && basemapUrlValue() !== "light") pr.set("basemap", basemapUrlValue());
    if (typeof extUrlValue === "function" && extUrlValue()) pr.set("ext", extUrlValue());
    if (state.search.trim()) pr.set("q", state.search.trim());
    var excl = EXCLUDE_RULES.filter(function (r) { return filters.exclude[r.key]; }).map(function (r) { return r.key; });
    if (excl.length) pr.set("excl", excl.join(","));
    var st = Object.keys(filters.status); if (st.length) pr.set("status", st.join(","));
    var eig = Object.keys(filters.eigentum); if (eig.length) pr.set("eig", eig.join(","));
    // `cov` stays single-valued (with|without): a complete or empty selection is
    // "alle" and drops the parameter, so a shared URL never carries a no-op filter.
    var cov = Object.keys(filters.coverage); if (cov.length === 1) pr.set("cov", cov[0]);
    var land = Object.keys(filters.countries); if (land.length) pr.set("land", land.join(","));
    var cant = Object.keys(filters.cantons); if (cant.length) pr.set("kanton", cant.join(","));
    var art = Object.keys(filters.arts); if (art.length) pr.set("art", art.join(","));
    var bauz = Object.keys(filters.bauzonen); if (bauz.length) pr.set("bauz", bauz.join(","));
    var has = Object.keys(filters.has); if (has.length) pr.set("has", has.join(","));
    VBS_FACETS.forEach(function (f) { var v = Object.keys(filters[f]); if (v.length) pr.set(VBS_URL_KEY[f], v.join(",")); });
    var tpf = Object.keys(filters.tpf); if (tpf.length) pr.set("tpf", tpf.join(","));
    var gi = Object.keys(filters.greeninv); if (gi.length) pr.set("gi", gi.join(","));
    var qs = pr.toString();
    try { history.replaceState(null, "", qs ? "?" + qs : location.pathname); } catch (e) { /* file:// may block */ }
  }
  // Returns true if defaults were applied (no filter params) and should be written back.
  function readURL() {
    var pr = new URLSearchParams(location.search);
    var tab = pr.get("tab"); nav.tab = (tab === "overview" || tab === "quality" || tab === "about" || tab === "map") ? tab : "map";
    nav.basemap = pr.get("basemap"); nav.ext = pr.get("ext");
    if (!URL_KEYS.some(function (k) { return pr.has(k); })) {
      filters = defaultFilters(); state.search = ""; document.getElementById("tsearch").value = ""; return true;
    }
    var validExcl = defaultExclude();
    state.search = pr.get("q") || "";
    document.getElementById("tsearch").value = state.search;
    filters.exclude = {}; (pr.get("excl") || "").split(",").forEach(function (k) { if (k && validExcl[k]) filters.exclude[k] = true; });
    filters.status = {}; (pr.get("status") || "").split(",").forEach(function (s) { if (s) filters.status[s] = true; });
    filters.eigentum = {}; (pr.get("eig") || "").split(",").forEach(function (e) { if (e) filters.eigentum[e] = true; });
    filters.coverage = {}; var cov = pr.get("cov"); if (cov === "with" || cov === "without") filters.coverage[cov] = true;
    filters.countries = {}; (pr.get("land") || "").split(",").forEach(function (c) { if (c) filters.countries[c] = true; });
    filters.cantons = {}; (pr.get("kanton") || "").split(",").forEach(function (c) { if (c) filters.cantons[c] = true; });
    filters.arts = {}; (pr.get("art") || "").split(",").forEach(function (a) { if (a) filters.arts[a] = true; });
    filters.bauzonen = {}; (pr.get("bauz") || "").split(",").forEach(function (z) { if (z) filters.bauzonen[z] = true; });
    filters.has = {}; (pr.get("has") || "").split(",").forEach(function (m) { if (m && HAS_METRICS[m]) filters.has[m] = true; });
    VBS_FACETS.forEach(function (f) {
      filters[f] = {};
      (pr.get(VBS_URL_KEY[f]) || "").split(",").forEach(function (k) { if (k && VBS_GROUPS[f].fields[k]) filters[f][k] = true; });
    });
    // Back-compat: VBS productivity used to be two keys of the `has` facet, reachable
    // only by hand-writing the URL. Keep such links working by folding them in here,
    // and flag it so boot stamps the current spelling back into the address bar.
    (pr.get("has") || "").split(",").forEach(function (m) {
      if (m === "VBSp") { filters.vbsprod.produktiv = true; urlMigrated = true; }
      if (m === "VBSu") { filters.vbsprod.unproduktiv = true; urlMigrated = true; }
    });
    filters.tpf = {}; (pr.get("tpf") || "").split(",").forEach(function (t) { if (t) filters.tpf[t] = true; });
    filters.greeninv = {}; (pr.get("gi") || "").split(",").forEach(function (g) { if (GREENINV_LABELS[g]) filters.greeninv[g] = true; });
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
  document.getElementById("tsearch").addEventListener("input", function (e) {
    clearTimeout(searchTimer);
    var v = e.target.value;
    searchTimer = setTimeout(function () { state.search = v; commit(); }, 150);
  });
  // Click or Enter/Space on a row → select the parcel on the map + zoom to it (Übersicht).
  (function () {
    function rowAct(e) {
      if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
      if (e.target.closest && e.target.closest(".sel-col")) return; // the checkbox cell selects, it does not navigate
      var tr = e.target.closest && e.target.closest("tr[data-id]"); if (!tr) return;
      if (e.type === "keydown") e.preventDefault();
      focusParcel(tr.getAttribute("data-id"));
    }
    var tb = document.getElementById("tbody");
    tb.addEventListener("click", rowAct); tb.addEventListener("keydown", rowAct);
    // Selection: row checkboxes, the header checkbox (this page), the bar links + the PDF button.
    tb.addEventListener("change", function (e) {
      var k = e.target.getAttribute && e.target.getAttribute("data-sel"); if (k == null) return;
      setSelected(k, e.target.checked);
    });
    document.getElementById("thead-row").addEventListener("change", function (e) {
      if (e.target.id !== "sel-all") return;
      var pr = pageRows(), on = e.target.checked;
      pr.forEach(function (p) { var k = String(p.id == null ? "" : p.id); if (on) { if (!sel[k] && selCount() < SEL_MAX) sel[k] = 1; } else delete sel[k]; });
      renderSelUI();
    });
    document.getElementById("sel-clear").addEventListener("click", clearSelection);
    document.getElementById("sel-filtered").addEventListener("click", function () {
      if (state.rows.length > SEL_MAX) return;
      sel = {}; state.rows.forEach(function (p) { var k = String(p.id == null ? "" : p.id); if (k) sel[k] = 1; });
      renderSelUI();
    });
    document.getElementById("pdf-sel-btn").addEventListener("click", function () { if (selCount()) openDownload("sel", selRows()); });
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
    if (e.target.closest && e.target.closest("#q-filter-x")) { qActiveRule = null; qState.page = 1; renderRulesTable(); applyQView(); }
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
  function renderCoverage() { capList("f-coverage", COVERAGE_KEYS.map(function (k) { return chk("v", k, COVERAGE_LABELS[k], coverageCount(k), filters.coverage[k]); })); }
  function renderVbs(f) {
    var g = VBS_GROUPS[f], grp = document.getElementById("fg-" + f);
    if (grp) grp.hidden = !vbsHasData(f);
    capList("f-" + f, g.keys.map(function (k) { return chk(g.attr, k, g.labels[k], vbsCounts[f][k], filters[f][k]); }));
  }
  function renderVbsProd() { renderVbs("vbsprod"); }
  function renderVbsTyp() { renderVbs("vbstyp"); }
  function renderCountries() { capList("f-countries", countryList.map(function (c) { return chk("l", c, countryLabel(c), countryCounts[c], filters.countries[c]); })); }
  function renderCantons() { capList("f-cantons", cantonList.map(function (c) { return chk("c", c, c, cantonCounts[c], filters.cantons[c]); })); }
  function renderArts() { capList("f-arts", artListAll.map(function (a) { return chk("a", a, ART_LABELS[a] || a, artParcelCount[a], filters.arts[a]); })); }
  function renderBauzonen() { capList("f-bauzonen", bauzoneListAll.map(function (z) { return chk("z", z, bzLabel(z), bauzoneParcelCount[z], filters.bauzonen[z]); })); }
  function renderTpf() { capList("f-tpf", tpfList.map(function (t) { return chk("t", t, tpfLabel(t), tpfCounts[t], filters.tpf[t]); })); }
  function renderEigentum() { capList("f-eigentum", eigentumList.map(function (e) { return chk("e", e, eigentumLabel(e), eigentumCounts[e], filters.eigentum[e]); })); }
  function renderStatus() { capList("f-status", statusList.map(function (s) { return chk("s", s, STATUS_LABELS[s] || s, statusCounts[s], filters.status[s]); })); }
  // Grüninventar: only exports that carry the opt-in join column show the group.
  function renderGreeninv() {
    var grp = document.getElementById("fg-greeninv"); if (grp) grp.hidden = !hasGreeninv;
    capList("f-greeninv", GREENINV_KEYS.map(function (k) { return chk("g", k, GREENINV_LABELS[k], greeninvCounts[k], filters.greeninv[k]); }));
  }
  var _rerenderGroup = { "f-exclude": renderExclude, "f-coverage": renderCoverage, "f-countries": renderCountries, "f-cantons": renderCantons, "f-arts": renderArts, "f-bauzonen": renderBauzonen, "f-vbsprod": renderVbsProd, "f-vbstyp": renderVbsTyp, "f-tpf": renderTpf, "f-eigentum": renderEigentum, "f-status": renderStatus, "f-greeninv": renderGreeninv };
  // Every fgroup-head carries the same "alle / keine" toggle (data-toggle="<facet>"):
  // one click fills the facet with all of its options, the next clears it. Note that
  // for value-based groups (Kanton, Land, Eigentumsart, Status) "alle" is not quite
  // "no filter" — it hides parcels whose value is empty, since "" is never an option.
  var GROUP_TOGGLES = {
    exclude:   { opts: EXCLUDE_RULES.map(function (r) { return r.key; }), render: renderExclude },
    status:    { opts: statusList,      render: renderStatus },
    coverage:  { opts: COVERAGE_KEYS,   render: renderCoverage },
    eigentum:  { opts: eigentumList,    render: renderEigentum },
    tpf:       { opts: tpfList,         render: renderTpf },
    countries: { opts: countryList,     render: renderCountries },
    cantons:   { opts: cantonList,      render: renderCantons },
    arts:      { opts: artListAll,      render: renderArts },
    bauzonen:  { opts: bauzoneListAll,  render: renderBauzonen },
    vbsprod:   { opts: VBS_GROUPS.vbsprod.keys, render: renderVbsProd },
    vbstyp:    { opts: VBS_GROUPS.vbstyp.keys,  render: renderVbsTyp },
    greeninv:  { opts: GREENINV_KEYS,          render: renderGreeninv }
  };
  document.getElementById("filter-panel").addEventListener("click", function (e) {
    var t = e.target.closest("[data-toggle]");
    if (t) {
      var facet = t.getAttribute("data-toggle"), g = GROUP_TOGGLES[facet];
      if (!g) return;
      // Toggle within the group's own options only, and read "alle" off them too —
      // a stale key from a hand-edited URL then neither counts as selected nor survives.
      var all = g.opts.every(function (k) { return filters[facet][k]; });
      filters[facet] = {};
      if (!all) g.opts.forEach(function (k) { filters[facet][k] = true; });
      g.render(); commit();
      return;
    }
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
  bindChecklist("f-countries", "l", "countries");
  bindChecklist("f-cantons", "c", "cantons");
  bindChecklist("f-arts", "a", "arts");
  bindChecklist("f-vbsprod", "vp", "vbsprod");
  bindChecklist("f-vbstyp", "vt", "vbstyp");
  bindChecklist("f-bauzonen", "z", "bauzonen");
  bindChecklist("f-tpf", "t", "tpf");
  bindChecklist("f-eigentum", "e", "eigentum");
  bindChecklist("f-status", "s", "status");
  bindChecklist("f-coverage", "v", "coverage");
  bindChecklist("f-greeninv", "g", "greeninv");
  var frBtn = document.getElementById("f-reset"); if (frBtn) frBtn.addEventListener("click", resetAll);

  // ---- Tabs (Karte is the start view; the tab is kept in the URL) ----
  var tabBtns = Array.prototype.slice.call(document.querySelectorAll(".tab"));
  function showTab(name) {
    if (["map", "overview", "quality", "about"].indexOf(name) < 0) name = "map";
    currentTab = name;
    tabBtns.forEach(function (t) {
      var on = t.getAttribute("data-tab") === name;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1; // roving tabindex
    });
    ["map", "overview", "quality", "about"].forEach(function (n) {
      var panel = document.getElementById("panel-" + n);
      if (panel) panel.hidden = (n !== name);
    });
    if (name === "quality") renderQuality(state.rows); // gated out of update(); render it on demand with the current filtered set
    document.getElementById("app").classList.toggle("tab-map", name === "map"); // map tab: page fits the viewport, no scrolling
    if (name === "map") { ensureMap(); if (map && mapReady) setTimeout(function () { map.resize(); }, 30); } // hidden tabs report 0×0
    writeURL();
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

  // ---- Export helpers (download dialog) ----
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
  // ---- Datenqualität export: Prüfregeln (Referenz) + Abweichungen (Langformat) ----
  // Reuses computeRules' authoritative per-rule `fails` lists (the SAME pass/fail
  // decisions the Datenqualität tab makes, no re-derivation) and only adds the display
  // values (Ist / Soll / Abweichung) per deviation. Recomputed fresh from a row set
  // so the export is correct even if the Datenqualität tab was never opened.
  // E-GRID uniqueness (and every count) is judged within `rows`, so Alle/Gefiltert differ.
  function _devDelta(diff, base) { // "+50 (+5 %)" / "-32 (-3.8 %)" — Ist minus Soll, signed
    var d = Math.round(diff), p = base > 0 ? Math.round(diff / base * 1000) / 10 : null;
    return (d > 0 ? "+" : "") + d + (p == null ? "" : " (" + (p > 0 ? "+" : "") + p + " %)");
  }
  // Ist / Soll / Abweichung / Einheit for one FAILED check (the parcel already failed `key`,
  // so e.g. the geom Ist is always "nein" and the coverage Ist ≠ Soll). Mirrors the checks
  // in computeRules exactly; only the *values*, not the pass/fail decision, live here.
  function _devValues(key, p, egCounts) {
    var area = num(p.parcel_area_m2), st = parcelStats(p);
    var classified = num(p.sia416_ggf_m2) + num(p.sia416_buf_m2) + num(p.sia416_uuf_m2);
    var eg = String(p.egrid == null ? "" : p.egrid).trim(), sk = statusKey(p);
    switch (key) {
      case "egrid":       return { ist: STATUS_LABELS[sk] || sk || "—", soll: "gefunden", abw: "", unit: "" };
      case "geom":        return { ist: "nein", soll: "ja", abw: "", unit: "" };
      case "area":        return { ist: Math.round(area), soll: "> 0", abw: "", unit: "m²" };
      case "egridUnique": return { ist: (eg ? (egCounts[eg] || 0) : 0), soll: 1, abw: "", unit: "Vorkommen" };
      case "bbCover":     return { ist: Math.round(classified), soll: Math.round(area), abw: _devDelta(classified - area, area), unit: "m²" };
      case "bzCover":     return { ist: Math.round(st.bzSumAll), soll: Math.round(area), abw: _devDelta(st.bzSumAll - area, area), unit: "m²" };
      case "hbCover":     return { ist: Math.round(st.hbSum), soll: Math.round(area), abw: _devDelta(st.hbSum - area, area), unit: "m²" };
      default:            return { ist: "", soll: "", abw: "", unit: "" };
    }
  }
  function qualityDeviationRows(rows) {
    var R = computeRules(rows), egCounts = {};
    rows.forEach(function (p) { var eg = String(p.egrid == null ? "" : p.egrid).trim(); if (eg) egCounts[eg] = (egCounts[eg] || 0) + 1; });
    var out = [];
    RULE_DEFS.forEach(function (d) {
      R[d.key].fails.forEach(function (f) { out.push({ key: d.key, name: d.name, p: f.p, v: _devValues(d.key, f.p, egCounts) }); });
    });
    return { rules: R, deviations: out };
  }
  // Two-sheet workbook: "Prüfregeln" (rule reference keyed by Prüf-ID + pass/fail summary)
  // and "Abweichungen" (one row per failed check × Grundstück, long/tidy format).
  function exportQualityXlsx(rows, fname) {
    return loadXlsx().then(function (XLSX) {
      var q = qualityDeviationRows(rows);
      var rulesAoa = [["Prüf-ID", "Prüfung", "Beschreibung", "Geprüft", "Bestanden", "Abweichend"]];
      RULE_DEFS.forEach(function (d) { var r = q.rules[d.key]; rulesAoa.push([d.key, d.name, d.tip, r.pass + r.fail, r.pass, r.fail]); });
      var devAoa = [["Prüf-ID", "Prüfung", "Grundstück-ID", "E-GRID", "Ort", "PLZ", "Kanton", "Bezeichnung", "Ist-Wert", "Soll-Wert", "Abweichung", "Einheit"]];
      q.deviations.forEach(function (x) {
        var p = x.p, v = x.v;
        devAoa.push([x.key, x.name, p.id == null ? "" : String(p.id), p.egrid == null ? "" : String(p.egrid),
          p.input_ort || "", p.input_plz || "", p.input_rg || "", p[NAME_COL] || "", v.ist, v.soll, v.abw, v.unit]);
      });
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rulesAoa), "Prüfregeln");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(devAoa), "Abweichungen");
      XLSX.writeFile(wb, fname);
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Grundstücksbericht (PDF, A3 hoch), eine Seite je ausgewähltes Grundstück (max. SEL_MAX).
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
  // VBS "naturnahe Flächen" for the report — the productive green split (Typ 1 / Typ 2)
  // plus biologically unproductive. Typ1+Typ2+Unproduktiv == classified cover, so
  // reportTable's "Ohne Bodenbedeckung" remainder makes the Total read 100 % of the GSF
  // (same reconciliation as the on-screen VBS Produktiv & Typ pivot). Replaces the former
  // SIA 416 table: for a naturnahe-VBS survey report the VBS split is the on-topic breakdown.
  function reportVbs(p) { return [
    { label: "Typ 1 · Grünflächen in Gebäudeumgebung", area: num(p.vbs_typ1_m2), color: "#8ED554" },
    { label: "Typ 2 · Übrige Grünflächen", area: num(p.vbs_typ2_m2), color: "#62AF39" },
    { label: "Biologisch unproduktiv", area: num(p.vbs_unproduktiv_m2), color: "#9AAAB3" }
  ]; }
  function reportLandcover(p) {
    // Full BBArt detail (not collapsed to the 6 Hauptgruppen): "Hauptgruppe · BBArt", coloured by main category.
    return ART_KEYS.map(function (a) {
      return { label: (ART_MAIN[a] && ART_MAIN[a] !== ART_LABELS[a] ? ART_MAIN[a] + " · " : "") + (ART_LABELS[a] || a), area: num(p[artCol(a)]), color: mainColor(a) };
    }).filter(function (r) { return r.area > 0; }).sort(function (x, y) { return y.area - x.area; });
  }
  function reportHabitat(p) {
    var out = []; for (var k in p) { if (Object.prototype.hasOwnProperty.call(p, k)) { var hm = HABITAT_RE.exec(k); if (hm) { var v = num(p[k]); if (v > 0) out.push({ label: hbLabelFull(hm[1]), area: v, color: habColor(hm[1]) }); } } }
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
    { n: "1", title: "Lage & VBS", layers: "ch.swisstopo.swissimage", tbl: "VBS - Naturnahe Flächen", rows: reportVbs },
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
    var cols = [{ t: "Nr.", x: M, a: "left" }, { t: "System ID", x: M + 16, a: "left" }, { t: "Ort", x: M + 58, a: "left" }, { t: "Kt", x: M + 120, a: "left" }, { t: "Fläche", x: M + 158, a: "right" }, { t: "Grün %", x: M + 192, a: "right" }, { t: "E-GRID", x: M + 204, a: "left" }, { t: "Seite", x: M + w, a: "right" }];
    for (var pg = 0; pg < tocPages; pg++) {
      if (pg > 0) pdf.addPage();
      pdf.setTextColor(31, 41, 55); pdf.setFont("helvetica", "bold"); pdf.setFontSize(17); pdf.text("Grundstücksbericht", M, 16);
      pdf.setFont("helvetica", "normal"); pdf.setFontSize(9); pdf.setTextColor(120); pdf.text("Bundesamt für Bauten und Logistik BBL", PW - M, 16, { align: "right" });
      pdf.setFontSize(11); pdf.setTextColor(70); pdf.text("Übersicht: " + rows.length + " Grundstücke · Stand " + reportDateStr(), M, 24);
      var hy = 34;
      pdf.setFont("helvetica", "bold"); pdf.setFontSize(8.5); pdf.setTextColor(110);
      cols.forEach(function (c) { pdf.text(c.t, c.x, hy, { align: c.a }); });
      pdf.setDrawColor(180); pdf.line(M, hy + 2, PW - M, hy + 2);
      var start = pg * ROWS_PER_TOC, ry = hy + 8;
      rows.slice(start, start + ROWS_PER_TOC).forEach(function (p, j) {
        var gi = start + j, area = num(p.parcel_area_m2), green = num(p.greenspace_m2), gp = area ? Math.round(green / area * 100) : 0;
        pdf.setFont("helvetica", "normal"); pdf.setFontSize(9); pdf.setTextColor(40);
        pdf.text(String(gi + 1), cols[0].x, ry);
        pdf.text(String(p.id || "-"), cols[1].x, ry, { maxWidth: 40 });
        pdf.text(((p.input_plz ? p.input_plz + " " : "") + (p.input_ort || "-")), cols[2].x, ry, { maxWidth: 58 });
        pdf.text(String(p.input_rg || "-"), cols[3].x, ry);
        pdf.text(fmtArea(area) + " " + unitLabel(), cols[4].x, ry, { align: "right" });
        pdf.text(gp + "%", cols[5].x, ry, { align: "right" });
        pdf.text(String(p.egrid || "-"), cols[6].x, ry);
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
  function drawReportPage(pdf, p, urls, total, pageNum, totalPages, nr) {
    var M = 12, PW = 297, w = PW - 2 * M;
    pdf.setTextColor(31, 41, 55); pdf.setFont("helvetica", "bold"); pdf.setFontSize(15); pdf.text("Grundstücksbericht", M, 13);
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(9); pdf.setTextColor(120); pdf.text("Bundesamt für Bauten und Logistik BBL", PW - M, 13, { align: "right" });
    pdf.setDrawColor(200); pdf.line(M, 16, PW - M, 16);
    pdf.setTextColor(31, 41, 55); pdf.setFont("helvetica", "bold"); pdf.setFontSize(13); pdf.text("System ID " + (p.id || "-"), M, 22);
    pdf.setFontSize(10.5); pdf.text("Nr. " + nr + " / " + total, PW - M, 22, { align: "right" });
    var bez = p["input_bez. grundstück"] || "";
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(9.5); pdf.setTextColor(90); if (bez) pdf.text(String(bez), M, 27, { maxWidth: w });
    var pole = poleOfGeom(p._geom);
    pdf.setDrawColor(225); pdf.line(M, 30, PW - M, 30);
    pdf.setFont("helvetica", "normal"); pdf.setFontSize(7); pdf.setTextColor(135); pdf.text("Lage in der Schweiz", PW - M - 23.5, 33, { align: "center" });
    drawLocatorMap(pdf, PW - M - 47, 34.5, 47, 28, pole ? pole[0] : null, pole ? pole[1] : null); // locator beside the attribute table
    // clean 2-column key/value table (left block; locator map sits to its right)
    var area = num(p.parcel_area_m2), green = num(p.greenspace_m2), gp = area ? Math.round(green / area * 100) : 0;
    var L = [["Ort", (p.input_plz ? p.input_plz + " " : "") + (p.input_ort || "-")], ["Kanton", p.input_rg || "-"], ["E-GRID", p.egrid || "-"], ["Nummer", p.nummer || "-"], ["E-GRID-Status", STATUS_LABELS[statusKey(p)] || statusKey(p) || "-"]];
    var R = [["Teilportfolio", tpfLabel(p.input_tpf)], ["Eigentumsart", eigentumLabel(p["input_eigent.art"])], ["Grundstücksfläche", fmtArea(area) + " " + unitLabel()], ["Grünfläche", fmtArea(green) + " " + unitLabel() + " (" + gp + "%)"], ["Datenquelle", p.lc_source === "AV" ? "Amtliche Vermessung (AV)" : p.lc_source === "BAFU" ? "BAFU (modelliert)" : (p.lc_source || "-")]];
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
  // Build the PDF (one A3 page per parcel in `rows`) and trigger the download.
  function generateParcelReport(rows, filename, onProgress, token) {
    if (!rows || !rows.length) return Promise.reject(new Error("Keine Grundstücke ausgewählt."));
    if (rows.length > SEL_MAX) return Promise.reject(new Error("Maximal " + SEL_MAX + " Grundstücke pro Bericht."));
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
            drawReportPage(pdf, p, urls, rows.length, tocPages + i + 1, totalPages, i + 1);
            imgP[i] = null;            // release this page's data URLs
            ensureFetched(i + CONC);   // start the next fetch as this slot frees
            tick("Grundstück " + (i + 1) + " / " + rows.length);
          });
        });
      }, Promise.resolve()).then(function () { checkAbort(); pdf.save(filename); return rows.length; });
    });
  }

  // ---- Download dialog: one scope switch (Alle / Aktive Filter / Ausgewählt), one list of formats ----
  // openDownload(scope, pdfRows): opens the dialog on `scope`; with `pdfRows` it starts the PDF
  // report for exactly those parcels right away (table bar button, map popup action).
  var openDownload;
  (function () {
    var btn = document.getElementById("dl-btn"), modal = document.getElementById("dl-modal"), card = modal.querySelector(".modal-card");
    var titleInput = document.getElementById("dl-title"), hint = document.getElementById("dl-hint"), defHint = hint.textContent, lastFocus = null;
    var scopeEl = document.getElementById("dl-scope"), scope = "flt";
    var prog = document.getElementById("dl-progress"), bar = document.getElementById("dl-progress-bar"), txt = document.getElementById("dl-progress-txt"), abortBtn = document.getElementById("dl-abort");
    var pdfBtn = document.getElementById("dl-pdf"), pdfSub = document.getElementById("dl-pdf-sub"), running = false;
    if (window.DASHBOARD_TITLE) titleInput.value = window.DASHBOARD_TITLE;
    var titleVal = function () { return (titleInput.value || "Auswertung Bodenbedeckung").trim(); };
    var base = function () { return slug(titleVal()); };
    var SCOPE_FILE = { all: "alle", flt: "gefiltert", sel: "auswahl" };
    function counts() { return { all: PARCELS.length, flt: state.rows.length, sel: selCount() }; }
    function scopeRows() { return scope === "sel" ? selRows() : scope === "flt" ? state.rows : PARCELS; }
    function setRow(id, ok) { var b = document.getElementById(id); b.disabled = !ok; b.closest(".dl-row").classList.toggle("is-off", !ok); }
    function refresh() {
      var c = counts(), n = c[scope];
      document.getElementById("dl-n-all").textContent = "(" + fmt(c.all) + ")";
      document.getElementById("dl-n-flt").textContent = "(" + fmt(c.flt) + ")";
      document.getElementById("dl-n-sel").textContent = "(" + fmt(c.sel) + ")";
      Array.prototype.forEach.call(scopeEl.querySelectorAll(".seg-btn"), function (b) {
        var k = b.getAttribute("data-scope");
        b.setAttribute("aria-checked", k === scope ? "true" : "false"); b.disabled = c[k] === 0;
      });
      var pdfOk = n > 0 && n <= SEL_MAX && !running;
      setRow("dl-pdf", pdfOk);
      pdfSub.textContent = running ? "Bericht wird erstellt." : n === 0 ? "Keine Grundstücke im gewählten Umfang." : n > SEL_MAX ? "Maximal " + SEL_MAX + " Grundstücke. Grundstücke in der Tabelle auswählen." : "A3, eine Seite pro Grundstück (" + fmt(n) + ").";
      pdfBtn.textContent = running ? "Läuft…" : "PDF erstellen";
      setRow("dl-xlsx", n > 0); setRow("dl-geo", n > 0); setRow("dl-q", n > 0); setRow("dl-html", true);
    }
    function bgInert(on) { [document.querySelector("header"), document.getElementById("app"), document.querySelector("footer")].forEach(function (el) { if (!el) return; el.inert = on; if (on) el.setAttribute("aria-hidden", "true"); else el.removeAttribute("aria-hidden"); }); } // hide background from AT/Tab while the dialog is open
    openDownload = function (sc, pdfRows) {
      lastFocus = document.activeElement;
      var c = counts();
      scope = (sc && c[sc]) ? sc : (c.sel ? "sel" : (c.flt ? "flt" : "all"));
      refresh(); hint.textContent = defHint; modal.hidden = false; bgInert(true);
      document.getElementById("dl-close").focus();
      if (pdfRows) runPdf(pdfRows);
    };
    function closeModal() { modal.hidden = true; bgInert(false); if (lastFocus && lastFocus.focus) lastFocus.focus(); }
    btn.addEventListener("click", function () { openDownload(null); });
    scopeEl.addEventListener("click", function (e) { var b = e.target.closest(".seg-btn"); if (!b || b.disabled) return; scope = b.getAttribute("data-scope"); refresh(); });
    document.getElementById("dl-close").addEventListener("click", closeModal);
    modal.addEventListener("click", function (e) { if (e.target === modal) closeModal(); }); // click on the backdrop
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !modal.hidden) closeModal(); });
    card.addEventListener("keydown", function (e) { // simple focus trap so Tab stays inside the dialog
      if (e.key !== "Tab") return;
      var f = Array.prototype.filter.call(card.querySelectorAll("button, input, [tabindex]"),
        function (el) { return !el.disabled && el.offsetParent !== null; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    // Run an export, surfacing progress / errors in the hint line; the dialog stays open for more downloads.
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
    document.getElementById("dl-xlsx").addEventListener("click", function () { busy("Excel wird erstellt…", function () { return exportXlsxRows(scopeRows(), base() + "-" + SCOPE_FILE[scope] + ".xlsx", "Grundstücke"); }); });
    document.getElementById("dl-geo").addEventListener("click", function () { busy("GeoJSON wird erstellt…", function () { exportGeojsonRows(scopeRows(), base() + "-" + SCOPE_FILE[scope] + ".geojson"); }); });
    document.getElementById("dl-q").addEventListener("click", function () { busy("Datenqualität-Excel wird erstellt…", function () { return exportQualityXlsx(scopeRows(), base() + "-datenqualitaet-" + SCOPE_FILE[scope] + ".xlsx"); }); });
    // PDF-Bericht (A3, eine Seite je Grundstück): Hintergrund-Verarbeitung mit Fortschrittsbalken + Abbrechen.
    function runPdf(rowsIn) {
      if (running) return;
      var rows = rowsIn || scopeRows();
      if (!rows.length || rows.length > SEL_MAX) { refresh(); return; }
      var token = { aborted: false };
      running = true; refresh();
      prog.hidden = false; bar.style.width = "0%"; txt.textContent = "Wird vorbereitet…"; hint.textContent = "PDF-Bericht wird erstellt, bitte warten.";
      abortBtn.disabled = false; abortBtn.onclick = function () { token.aborted = true; abortBtn.disabled = true; txt.textContent = "Wird abgebrochen…"; };
      var fname = base() + "-grundstuecksbericht" + (rows.length === 1 && rows[0].id ? "-" + slug(String(rows[0].id)) : "") + ".pdf";
      generateParcelReport(rows, fname, function (frac, label) {
        bar.style.width = Math.round(frac * 100) + "%"; txt.textContent = Math.round(frac * 100) + "% · " + (label || "");
      }, token).then(function (n) {
        bar.style.width = "100%"; txt.textContent = "Fertig: " + fname + " (" + n + (n === 1 ? " Seite" : " Seiten") + ")."; hint.textContent = defHint;
        setTimeout(function () { prog.hidden = true; }, 2500);
      }).catch(function (err) {
        var aborted = err && err.message === "__ABORT__";
        txt.textContent = aborted ? "Abgebrochen." : ("Fehler: " + ((err && err.message) || err));
        hint.textContent = aborted ? defHint : "PDF-Bericht fehlgeschlagen.";
        if (aborted) setTimeout(function () { prog.hidden = true; }, 1800);
      }).then(function () { running = false; abortBtn.disabled = true; refresh(); });
    }
    pdfBtn.addEventListener("click", function () { runPdf(null); });
  })();

  // ---- "Neue Datei": reload to a clean URL → file picker (served builder) ----
  var bn0 = document.getElementById("btn-new");
  if (bn0) bn0.addEventListener("click", function () { location.href = location.pathname; });

  // ---- Settings (gear menu): area unit ha / m², display only; re-renders every area number ----
  (function () {
    var btn = document.getElementById("gear-btn"), menu = document.getElementById("gear-menu");
    function syncUnitUI() { var r = document.getElementById(areaUnit === "m2" ? "unit-m2" : "unit-ha"); if (r) r.checked = true; }
    function setOpen(open) { menu.hidden = !open; btn.setAttribute("aria-expanded", open ? "true" : "false"); }
    btn.addEventListener("click", function (e) { e.stopPropagation(); setOpen(menu.hidden); });
    menu.addEventListener("click", function (e) { e.stopPropagation(); });
    document.addEventListener("click", function () { if (!menu.hidden) setOpen(false); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !menu.hidden) { setOpen(false); btn.focus(); } });
    menu.addEventListener("change", function (e) {
      var u = e.target.value; if (!u || u === areaUnit) return;
      areaUnit = u;
      try { localStorage.setItem("dashAreaUnit", u); } catch (err) { /* storage may be blocked */ }
      update();
    });
    syncUnitUI();
  })();

  // ---- Map: switchable basemaps + parcel polygons, poles & clustered ID points + external swisstopo maps ----
  var map = null, mapReady = false, mapFitted = false, refitMap = false, lastRows = [];
  // Visibility of the app's own layers; survives basemap switches, which rebuild every layer.
  var layerVis = { parcels: true, labels: true, landcover: false, bauzonen: false, habitat: false };
  // Basemaps: CARTO vector styles (OpenMapTiles schema) and aerial imagery (Esri World Imagery worldwide,
  // the higher-resolution swisstopo SWISSIMAGE on top within Switzerland). "Hybrid" adds Esri's Hybrid
  // Reference labels via transformStyle. `url` is a style URL or an inline style object; the thumbnails are
  // the <img> elements in #basemap-thumbs (index.html), which the offline deliverable inlines as data URIs.
  var SWISSIMAGE_TILES = "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg";
  var AERIAL_STYLE = { version: 8, glyphs: "https://tiles.basemaps.cartocdn.com/fonts/{fontstack}/{range}.pbf", sources: {
      "world-imagery": { type: "raster", tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"], tileSize: 256, maxzoom: 19, attribution: "Esri, Maxar, Earthstar Geographics, and the GIS User Community" },
      "swissimage": { type: "raster", tiles: [SWISSIMAGE_TILES], tileSize: 256, minzoom: 8, maxzoom: 20, bounds: [5.95, 45.81, 10.49, 47.81], attribution: '&copy; <a href="https://www.swisstopo.admin.ch">swisstopo</a>' }
    }, layers: [{ id: "world-imagery", type: "raster", source: "world-imagery" }, { id: "swissimage", type: "raster", source: "swissimage" }] };
  var BASEMAPS = [
    { id: "positron", urlValue: "light", name: "Light", url: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json" },
    { id: "voyager", urlValue: "standard", name: "Standard", url: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json" },
    { id: "swissimage", urlValue: "aerial", name: "Luftbild", url: AERIAL_STYLE },
    { id: "swissimage-labels", urlValue: "aerial-labels", name: "Hybrid", url: "https://www.arcgis.com/sharing/rest/content/items/30d6b8271e1849cd9c3042060001f425/resources/styles/root.json", hybrid: true },
    { id: "dark-matter", urlValue: "dark", name: "Dark", url: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json" }
  ];
  var basemapId = "positron";
  function basemapById(id) { for (var i = 0; i < BASEMAPS.length; i++) if (BASEMAPS[i].id === id) return BASEMAPS[i]; return BASEMAPS[0]; }
  function basemapUrlValue() { return basemapById(basemapId).urlValue; }
  function basemapThumb(id) { var img = document.querySelector('#basemap-thumbs img[data-bm="' + id + '"]'); return img ? img.getAttribute("src") : ""; }
  // MapLibre calls this after downloading the Esri reference style: put the imagery underneath and map
  // its Arial labels onto the CARTO glyph service (Open Sans / Noto Sans) the other basemaps use.
  function composeHybrid(prev, ref) {
    var k, sources = {}; for (k in AERIAL_STYLE.sources) sources[k] = AERIAL_STYLE.sources[k];
    sources.esri = { type: "vector", tiles: ["https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/{z}/{y}/{x}.pbf"], maxzoom: 16, attribution: "Esri, TomTom, Garmin, FAO, NOAA, USGS, &copy; OpenStreetMap contributors, and the GIS User Community" };
    var out = {}; for (k in ref) out[k] = ref[k];
    out.glyphs = AERIAL_STYLE.glyphs; out.sources = sources;
    out.layers = AERIAL_STYLE.layers.concat((ref.layers || []).map(function (l) {
      var f = l.layout && l.layout["text-font"]; if (!f) return l;
      var w = f.some(function (x) { return x.indexOf("Bold") >= 0; }) ? "Bold" : f.some(function (x) { return x.indexOf("Italic") >= 0; }) ? "Italic" : "Regular";
      var layout = {}, q; for (q in l.layout) layout[q] = l.layout[q]; layout["text-font"] = ["Open Sans " + w, "Noto Sans " + w];
      var c = {}, r; for (r in l) c[r] = l[r]; c.layout = layout; return c;
    }));
    return out;
  }

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
    // parcel polygons.
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
      map.addLayer({ id: d.key + "-fill", type: "fill", source: "ov-" + d.key, minzoom: OVERLAY_MINZOOM, layout: { visibility: layerVis[d.key] ? "visible" : "none" }, paint: { "fill-color": d.fill, "fill-opacity": d.opacity } });
      map.addLayer({ id: d.key + "-line", type: "line", source: "ov-" + d.key, minzoom: OVERLAY_MINZOOM, layout: { visibility: layerVis[d.key] ? "visible" : "none" }, paint: {
        "line-color": ["case", ["boolean", ["feature-state", "selected"], false], "#d8232a", d.line],
        "line-width": ["case", ["boolean", ["feature-state", "selected"], false], 2.6, 0.4]
      } });
    });
  }
  // One reusable popup + single-feature highlight, shared by parcels and overlays.
  var _mapPopup = null, _selOv = null;
  function showPopup(lngLat, html) {
    if (!_mapPopup) _mapPopup = new maplibregl.Popup({ closeButton: true, maxWidth: "300px" });
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
        var an = total ? pctLabel(it.value, total) : '';
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
      var hm = HABITAT_RE.exec(k); if (hm) { var hv = num(p[k]); if (hv > 0) hbItems.push({ name: hbLabelFull(hm[1]), value: hv, swatch: habColor(hm[1]) }); }
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
      ["Eigentumsart", p["input_eigent.art"] ? eigentumLabel(p["input_eigent.art"]) : "—"],
      (hasGreeninv ? ["Grüninventar", greeninvLabel(p.greeninv)] : null)
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
    var hbCard = hbItems.length ? card("Lebensräume (BAFU · TypoCH)", detailAreaTable(hbItems, parcelArea)) : "";
    var qCard = card("Datenqualität", detailKV([
      ["E-GRID-Status", stLabel], ["Bodenbedeckung-WFS", p.check_wfs || "—"], ["Geometrie", p.check_geom || "—"],
      (("check_bauzonen" in p) && p.check_bauzonen ? ["Bauzonen", p.check_bauzonen] : null),
      (("check_habitat" in p) && p.check_habitat ? ["Lebensräume", p.check_habitat] : null),
      ["Datenquelle (LC)", p.lc_source || "—"],
      (p.lc_synthetic === "yes" ? ["Bodenbedeckung", "Hinweis: synthetisch aus BAFU-Lebensräumen abgeleitet (keine AV-Daten)"] : null)
    ]));
    var links = [];
    if (p.egrid) {
      var egridUrl = "https://map.geo.admin.ch/#/map?lang=de&topic=ech&bgLayer=ch.swisstopo.pixelkarte-farbe&layers=ch.swisstopo-vd.stand-oerebkataster&swisssearch=" + encodeURIComponent(p.egrid);
      links.push('<a href="' + esc(egridUrl) + '" target="_blank" rel="noopener">Auf map.geo.admin.ch öffnen (ÖREB-Kataster) ' + ICON.sz("extlink", 12) + '</a>');
    }
    var giUrl = p.greeninv === "yes" ? greenInventoryUrl(p) : "";
    if (giUrl) links.push('<a href="' + esc(giUrl) + '" target="_blank" rel="noopener">Im Grüninventar öffnen ' + ICON.sz("extlink", 12) + '</a>');
    var linkCard = links.length ? card("Verknüpfungen", links.join("<br>")) : "";
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
        '<div class="actions"><button class="btn" onclick="window.print()">Drucken</button></div>' +
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
      '<title>Grundstück ' + esc(p.id || "") + ': Details</title><style>' + DETAIL_CSS + '</style></head><body>' + body + '</body></html>';
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

  // ---- External swisstopo maps (WMS from the Geokatalog), listed under "Dargestellte Karten" ----
  // Entry: { id, title, visible, opacity 10–100, rec }. `rec` marks the two recommended maps that start
  // hidden. The URL carries the list as ext=id1,-id2 ("-" = hidden); recommended hidden maps are implicit.
  var EXT_RECOMMENDED = [
    { id: "ch.bafu.lebensraumkarte-schweiz", title: "Lebensraumkarte der Schweiz (BAFU)" },
    { id: "ch.swisstopo-vd.amtliche-vermessung", title: "Amtliche Vermessung (OpenData)" }
  ];
  var EXT_SUGGEST = [ // "Häufig verwendete Karten" while the search field is still empty
    ["ch.swisstopo.pixelkarte-farbe", "Landeskarten (farbig)"], ["ch.swisstopo.swissimage", "SWISSIMAGE Luftbild"],
    ["ch.kantone.cadastralwebmap-farbe", "Amtliche Vermessung (farbig)"], ["ch.are.bauzonen", "Bauzonen Schweiz (harmonisiert)"],
    ["ch.bafu.lebensraumkarte-schweiz", "Lebensraumkarte der Schweiz"], ["ch.bafu.waldreservate", "Waldreservate"]
  ];
  var EXT_ID_RE = /^[a-zA-Z0-9._-]+$/;
  var extLayers = [];
  function extDefaults() { return EXT_RECOMMENDED.map(function (r) { return { id: r.id, title: r.title, visible: false, opacity: 70, rec: true }; }); }
  function extById(id) { for (var i = 0; i < extLayers.length; i++) if (extLayers[i].id === id) return extLayers[i]; return null; }
  function extUrlValue() {
    return extLayers.filter(function (l) { return !(l.rec && !l.visible); }).map(function (l) { return (l.visible ? "" : "-") + l.id; }).join(",");
  }
  // Apply the navigation params read from the URL (basemap=…, ext=…); defaults otherwise.
  function applyNavState() {
    basemapId = "positron"; BASEMAPS.forEach(function (b) { if (b.urlValue === nav.basemap) basemapId = b.id; });
    extLayers = extDefaults();
    (nav.ext || "").split(",").forEach(function (tok) {
      tok = tok.trim(); if (!tok) return;
      var hidden = tok.charAt(0) === "-", id = hidden ? tok.slice(1) : tok;
      if (!EXT_ID_RE.test(id)) return;
      var l = extById(id);
      if (l) { l.visible = !hidden; return; }
      if (extLayers.length >= 20) return; // at most 20 maps from a link
      extLayers.push({ id: id, title: id, visible: !hidden, opacity: 70, rec: false, resolve: true });
    });
    extLayers.forEach(function (l) { if (l.resolve) resolveExtTitle(l); }); // best effort; offline the id stays
  }
  function extMapId(l) { return "ext-" + l.id; }
  function extTileUrl(id) { return "https://wms.geo.admin.ch/?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=" + encodeURIComponent(id) + "&STYLES=&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true"; }
  // External maps sit below the app's data layers (inserted before parcels-fill); first in the list = on top.
  function addExtToMap(l) {
    var lid = extMapId(l); if (!map || map.getSource(lid)) return;
    map.addSource(lid, { type: "raster", tiles: [extTileUrl(l.id)], tileSize: 256, maxzoom: 19, attribution: '&copy; <a href="https://www.swisstopo.admin.ch">swisstopo</a>' });
    map.addLayer({ id: lid, type: "raster", source: lid, layout: { visibility: l.visible ? "visible" : "none" }, paint: { "raster-opacity": l.opacity / 100 } }, map.getLayer("parcels-fill") ? "parcels-fill" : undefined);
  }
  function syncExtOrder() {
    if (!map || !map.getLayer("parcels-fill")) return;
    extLayers.slice().reverse().forEach(function (l) { if (map.getLayer(extMapId(l))) map.moveLayer(extMapId(l), "parcels-fill"); });
  }
  function extCommit() { syncExtOrder(); renderAccordion(); writeURL(); }
  function addExtLayer(id, title) {
    if (!EXT_ID_RE.test(id || "")) return;
    var l = extById(id);
    if (l) { l.visible = true; if (title && l.title === l.id) l.title = title; }
    else { l = { id: id, title: title || id, visible: true, opacity: 70, rec: false, resolve: !title }; extLayers.unshift(l); }
    if (map && mapReady) { addExtToMap(l); map.setLayoutProperty(extMapId(l), "visibility", "visible"); }
    if (l.resolve) resolveExtTitle(l);
    accOpen = true; menuOpen = true;
    extCommit();
    if (currentTab !== "map") showTab("map");
  }
  function removeExtLayer(id) {
    var l = extById(id); if (!l) return;
    if (map && map.getLayer(extMapId(l))) { map.removeLayer(extMapId(l)); map.removeSource(extMapId(l)); }
    extLayers = extLayers.filter(function (x) { return x !== l; });
    extCommit();
  }
  function setExtVisible(id, on) { var l = extById(id); if (!l) return; l.visible = !!on; if (map && map.getLayer(extMapId(l))) map.setLayoutProperty(extMapId(l), "visibility", on ? "visible" : "none"); extCommit(); }
  function setExtOpacity(id, v) { var l = extById(id); if (!l) return; l.opacity = Math.max(10, Math.min(100, +v || 70)); if (map && map.getLayer(extMapId(l))) map.setPaintProperty(extMapId(l), "raster-opacity", l.opacity / 100); }
  // Title of a map restored from a link: taken from the geo.admin legend heading; offline the id stays.
  function resolveExtTitle(l) {
    l.resolve = false;
    fetchLegendDoc(l.id).then(function (doc) {
      var h = doc && doc.querySelector(".bod-title, h1, h2, h3"), t = h && h.textContent.trim();
      if (t && l.title === l.id) { l.title = t; renderAccordion(); }
    }).catch(function () {});
  }
  var _legendCache = {};
  // geo.admin legend HTML → sanitized Document (scripts, frames, objects, forms, styles, event handlers and
  // javascript: URLs removed; links open in a new tab). Cached per layer id.
  function fetchLegendDoc(id) {
    if (_legendCache[id]) return _legendCache[id];
    return (_legendCache[id] = fetch("https://api3.geo.admin.ch/rest/services/api/MapServer/" + encodeURIComponent(id) + "/legend?lang=de")
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, "text/html");
        Array.prototype.forEach.call(doc.querySelectorAll("script, iframe, object, embed, form, link, meta, base, style"), function (el) { el.parentNode.removeChild(el); });
        Array.prototype.forEach.call(doc.querySelectorAll("*"), function (el) {
          Array.prototype.slice.call(el.attributes).forEach(function (a) { if (/^on/i.test(a.name) || /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name); });
        });
        Array.prototype.forEach.call(doc.querySelectorAll("a[href]"), function (a) { a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener"); });
        return doc;
      }).catch(function (e) { delete _legendCache[id]; throw e; }));
  }

  // ---- Internal maps (checkbox + info): parcels, labels/clusters, and the data overlays the export carries ----
  function internalLayerDefs() {
    var defs = [
      { key: "parcels", label: "Grundstücke", layers: ["parcels-fill", "parcels-line", "parcels-hl-casing", "parcels-hl", "parcels-sel"] },
      { key: "labels", label: "Beschriftung & Cluster", layers: ["clusters", "cluster-count", "point", "point-label"] }
    ];
    OVERLAY_DEFS.forEach(function (d) { var fc = OVERLAYS[d.key]; if (fc && fc.features && fc.features.length) defs.push({ key: d.key, label: d.label, layers: [d.key + "-fill", d.key + "-line"] }); });
    return defs;
  }
  function setLayerVis(key, on) {
    layerVis[key] = !!on;
    if (map && mapReady) applyLayerVis();
    renderLegend(); renderAccordion();
  }
  function applyLayerVis() { internalLayerDefs().forEach(function (d) { d.layers.forEach(function (lid) { if (map.getLayer(lid)) map.setLayoutProperty(lid, "visibility", layerVis[d.key] ? "visible" : "none"); }); }); }

  // ---- Tools accordion (top-left): "Dargestellte Karten" + "Menü schliessen" toggle ----
  var accEl = null, accOpen = true, menuOpen = !(window.matchMedia && window.matchMedia("(max-width: 900px)").matches); // phones start with the menu closed
  function AccordionControl() {}
  AccordionControl.prototype.onAdd = function (m) {
    this._map = m;
    accEl = document.createElement("div"); accEl.className = "maplibregl-ctrl acc-wrap";
    accEl.addEventListener("click", accClick);
    accEl.addEventListener("change", accChange);
    renderAccordion();
    return accEl;
  };
  AccordionControl.prototype.onRemove = function () { if (accEl && accEl.parentNode) accEl.parentNode.removeChild(accEl); accEl = null; this._map = undefined; };
  function lyrRow(o) { // { kind: "int"|"ext", id, label, on, tip }
    var cid = "lyr-" + o.kind + "-" + String(o.id).replace(/[^a-zA-Z0-9_-]/g, "_");
    var info = '<button type="button" class="icon-btn lyr-info" data-info="' + o.kind + '" data-id="' + esc(o.id) + '" title="Legende und Informationen" aria-label="Legende und Informationen">' + ICON.sz("info", 18) + '</button>';
    var x = o.kind === "ext" ? '<button type="button" class="lyr-x" data-ext-x="' + esc(o.id) + '" title="Karte entfernen" aria-label="Karte entfernen">' + ICON.sz("x", 12) + '</button>' : "";
    return '<div class="lyr-row' + (o.on ? "" : " is-off") + '">' + x +
      '<input type="checkbox" id="' + cid + '" data-' + o.kind + '="' + esc(o.id) + '"' + (o.on ? " checked" : "") + '>' +
      '<label class="lyr-t" for="' + cid + '" title="' + esc(o.tip || o.label) + '">' + esc(o.label) + '</label>' + info + '</div>';
  }
  function renderAccordion() {
    if (!accEl) return;
    accEl.classList.toggle("is-closed", !menuOpen);
    var nVis = extLayers.filter(function (l) { return l.visible; }).length;
    accEl.innerHTML = '<aside class="acc-panel" aria-label="Werkzeuge">' +
      '<button type="button" class="acc-head" data-acc-toggle aria-expanded="' + (accOpen ? "true" : "false") + '"><span class="acc-arrow">' + ICON.sz("chevRight", 18) + '</span><span>Dargestellte Karten</span><span class="acc-meta">' + (nVis ? nVis + " extern" : "") + '</span></button>' +
      '<div class="acc-body"' + (accOpen ? "" : " hidden") + '>' +
        '<div class="acc-group">Interne Karten</div>' +
        internalLayerDefs().map(function (d) { return lyrRow({ kind: "int", id: d.key, label: d.label, on: !!layerVis[d.key] }); }).join("") +
        '<div class="acc-group sep">Externe Karten</div>' +
        (extLayers.some(function (l) { return l.rec && !l.visible; }) ? '<div class="acc-hint">Empfohlene Karten sind ausgeblendet. Häkchen setzen zum Einblenden.</div>' : "") +
        (extLayers.length ? extLayers.map(function (l) { return lyrRow({ kind: "ext", id: l.id, label: l.title, on: l.visible, tip: l.title + " · " + l.id }); }).join("")
                          : '<div class="acc-empty">Keine externen Karten aktiv.</div>') +
        '<div class="acc-add"><button type="button" class="btn" data-acc-add>' + ICON.plus + 'Karte hinzufügen</button><div class="acc-hint">Sucht Karten im Geokatalog von swisstopo.</div></div>' +
      '</div></aside>' +
      '<button type="button" class="acc-toggle" data-menu-toggle aria-expanded="' + (menuOpen ? "true" : "false") + '"><span class="acc-chev">' + ICON.sz("chevRight", 18) + '</span><span>' + (menuOpen ? "Menü schliessen" : "Menü öffnen") + '</span></button>';
  }
  function accClick(e) {
    var t = e.target;
    if (t.closest("[data-menu-toggle]")) { menuOpen = !menuOpen; renderAccordion(); return; }
    if (t.closest("[data-acc-toggle]")) { accOpen = !accOpen; renderAccordion(); return; }
    if (t.closest("[data-acc-add]")) { openLayerSearch(); return; }
    var x = t.closest("[data-ext-x]"); if (x) { removeExtLayer(x.getAttribute("data-ext-x")); return; }
    var i = t.closest("[data-info]"); if (i) { openInfo(i.getAttribute("data-info"), i.getAttribute("data-id")); }
  }
  function accChange(e) {
    var t = e.target; if (!t || t.type !== "checkbox") return;
    if (t.hasAttribute("data-int")) setLayerVis(t.getAttribute("data-int"), t.checked);
    else if (t.hasAttribute("data-ext")) setExtVisible(t.getAttribute("data-ext"), t.checked);
  }

  // ---- Basemap switcher (bottom-right) ----
  var bmEl = null, bmOpen = false;
  function BasemapControl() {}
  BasemapControl.prototype.onAdd = function (m) {
    this._map = m;
    bmEl = document.createElement("div"); bmEl.className = "maplibregl-ctrl bm-wrap";
    bmEl.addEventListener("click", function (e) {
      var o = e.target.closest("[data-bm]"); if (o) { bmOpen = false; setBasemap(o.getAttribute("data-bm")); return; }
      if (e.target.closest("[data-bm-toggle]")) { bmOpen = !bmOpen; renderBasemapUI(); }
    });
    // composedPath: the panel re-renders on its own click, so e.target may already be detached from the DOM.
    document.addEventListener("click", function (e) { if (bmOpen && !(e.composedPath && e.composedPath().indexOf(bmEl) >= 0)) { bmOpen = false; renderBasemapUI(); } });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && bmOpen) { bmOpen = false; renderBasemapUI(); } });
    renderBasemapUI();
    return bmEl;
  };
  BasemapControl.prototype.onRemove = function () { if (bmEl && bmEl.parentNode) bmEl.parentNode.removeChild(bmEl); bmEl = null; this._map = undefined; };
  function renderBasemapUI() {
    if (!bmEl) return;
    var cur = basemapById(basemapId);
    bmEl.innerHTML = '<div class="popover bm-panel"' + (bmOpen ? "" : " hidden") + ' role="group" aria-label="Hintergrundkarte">' +
      BASEMAPS.map(function (b) { return '<button type="button" class="bm-opt' + (b.id === basemapId ? " is-active" : "") + '" data-bm="' + b.id + '" title="' + esc(b.name) + '"><img class="bm-thumb" src="' + esc(basemapThumb(b.id)) + '" alt=""><span>' + esc(b.name) + '</span></button>'; }).join("") + '</div>' +
      '<button type="button" class="bm-btn" data-bm-toggle title="Hintergrund wechseln" aria-haspopup="true" aria-expanded="' + (bmOpen ? "true" : "false") + '"><img class="bm-thumb" src="' + esc(basemapThumb(cur.id)) + '" alt="Aktueller Hintergrund: ' + esc(cur.name) + '"><span class="bm-l">Hintergrund</span></button>';
  }
  function styleOptions(b) { return b.hybrid ? { diff: false, transformStyle: composeHybrid } : { diff: false }; }
  function setBasemap(id) {
    var b = basemapById(id);
    if (b.id === basemapId || !map) { basemapId = b.id; renderBasemapUI(); return; }
    basemapId = b.id; renderBasemapUI(); writeURL();
    mapReady = false;
    map.off("style.load", addAppLayers); map.once("style.load", addAppLayers); // rebuild every source + layer on the new style
    map.setStyle(b.url, styleOptions(b));
  }

  // ---- Selection bar on the map (bottom-left) ----
  var selBarEl = null;
  function SelBarControl() {}
  SelBarControl.prototype.onAdd = function (m) {
    this._map = m;
    selBarEl = document.createElement("div"); selBarEl.className = "maplibregl-ctrl map-selbar"; selBarEl.hidden = true;
    selBarEl.addEventListener("click", function (e) {
      if (e.target.closest("[data-sel-clear]")) clearSelection();
      else if (e.target.closest("[data-sel-pdf]")) openDownload("sel", selRows());
    });
    renderSelBar(); return selBarEl;
  };
  SelBarControl.prototype.onRemove = function () { if (selBarEl && selBarEl.parentNode) selBarEl.parentNode.removeChild(selBarEl); selBarEl = null; this._map = undefined; };
  function renderSelBar() {
    if (!selBarEl) return;
    var n = selCount(); selBarEl.hidden = n === 0;
    if (n) selBarEl.innerHTML = '<strong>' + n + ' von max. ' + SEL_MAX + ' ausgewählt</strong><button type="button" class="flink" data-sel-clear>Auswahl aufheben</button><button type="button" class="btn btn-sm btn-primary" data-sel-pdf>PDF-Bericht (' + n + ')</button>';
  }

  // ---- Layer info dialog (C1): static description + legend for internal maps, geo.admin legend for external ----
  var INT_INFO = {
    parcels: { title: "Grundstücke", desc: "Liegenschaften und SDR der aktuellen Auswahl. Folgt den Filtern im Seitenpanel.",
      legend: [["Grundstück", "rgba(111,138,172,.4)", "1px solid #3b5a7a"], ["Ausgewählt", "#fff", "2px solid #d8232a"], ["Für PDF-Bericht ausgewählt", "#fff", "2px dashed #2f4356"]],
      rows: function () { return [["Quelle", "Amtliche Vermessung (AV), Liegenschaften (E-GRID) · SAP-Export"], ["Format", "GeoJSON (Polygon, WGS84)"], ["Grundstücke", fmt(lastRows.length) + " von " + fmt(PARCELS.length)], ["Sichtbar ab", "Zoomstufe " + PARCEL_MINZOOM]]; } },
    labels: { title: "Beschriftung & Cluster", desc: "Grundstücks-ID als Beschriftung. Beim Herauszoomen zu Clustern mit Anzahl gruppiert.",
      legend: [["Einzelnes Grundstück", "#3b5a7a", "1.5px solid #fff", true], ["Cluster (bis 25)", "#4f6f93", "1.5px solid #fff", true], ["Cluster (25 bis 100)", "#3b5a7a", "1.5px solid #fff", true], ["Cluster (über 100)", "#2e4a68", "1.5px solid #fff", true]],
      rows: function () { return [["Quelle", "Abgeleitet aus den Grundstücken (visueller Mittelpunkt)"], ["Cluster bis", "Zoomstufe 13"]]; } },
    landcover: { title: "Bodenbedeckung", desc: "Bodenbedeckungsflächen der Amtlichen Vermessung (AV) je Grundstück, eingefärbt nach Hauptgruppe.",
      legend: function () { return MAIN_ORDER.map(function (mc) { return [mc, MAIN_COLORS[mc], "none"]; }); },
      rows: function () { return [["Quelle", "Amtliche Vermessung, DM.01-AV-CH (geodienste.ch)"], ["Sichtbar ab", "Zoomstufe " + OVERLAY_MINZOOM]]; } },
    bauzonen: { title: "Bauzonen", desc: "Harmonisierte Bauzonen (ARE) je Grundstück.",
      legend: function () { return Object.keys(BAUZONE_LABELS).map(function (z) { return [BAUZONE_LABELS[z], bzColor(z), "none"]; }); },
      rows: function () { return [["Quelle", "ARE, ch.are.bauzonen"], ["Sichtbar ab", "Zoomstufe " + OVERLAY_MINZOOM]]; } },
    habitat: { title: "Lebensräume", desc: "BAFU-Lebensraumkarte (modelliert) je Grundstück, eingefärbt nach TypoCH-Klasse.",
      legend: function () { return ["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(function (d) { return [typochLabel(d), HABITAT_L1_COLORS[d], "none"]; }); },
      rows: function () { return [["Quelle", "BAFU, ch.bafu.lebensraumkarte-schweiz"], ["Sichtbar ab", "Zoomstufe " + OVERLAY_MINZOOM]]; } }
  };
  var infoReq = 0, openInfoModal;
  function infoFoot(l) {
    return '<div class="info-foot"><span>Deckkraft</span><input type="range" min="10" max="100" step="5" value="' + l.opacity + '" data-ext-op="' + esc(l.id) + '" aria-label="Deckkraft"><span class="info-op">' + l.opacity + ' %</span>' +
      '<a href="https://map.geo.admin.ch/#/map?lang=de&layers=' + encodeURIComponent(l.id) + '" target="_blank" rel="noopener">map.geo.admin.ch' + ICON.sz("extlink", 12) + '</a></div>';
  }
  function openInfo(kind, id) {
    var body = document.getElementById("info-body"), title = document.getElementById("info-title"), req = ++infoReq;
    if (kind === "int") {
      var d = INT_INFO[id]; if (!d) return;
      var lg = typeof d.legend === "function" ? d.legend() : d.legend;
      title.textContent = d.title;
      body.innerHTML = '<div class="info-desc">' + esc(d.desc) + '</div><div class="info-legend">' +
        lg.map(function (r) { return '<div class="info-legend-row"><span class="info-sw' + (r[3] ? " round" : "") + '" style="background:' + r[1] + ';border:' + r[2] + '"></span>' + esc(r[0]) + '</div>'; }).join("") + '</div>' +
        '<div class="info-h">Informationen</div><table class="info-kv">' + d.rows().map(function (r) { return '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>'; }).join("") + '</table>';
    } else {
      var l = extById(id); if (!l) return;
      title.textContent = l.title;
      body.innerHTML = '<div class="info-status">Lade Informationen…</div>';
      fetchLegendDoc(l.id).then(function (doc) {
        if (req !== infoReq) return;
        var h = doc.querySelector(".bod-title"); if (h && l.title === l.id && h.textContent.trim()) { l.title = h.textContent.trim(); title.textContent = l.title; renderAccordion(); }
        body.innerHTML = '<div class="lyr-api">' + (doc.body ? doc.body.innerHTML : "") + '</div>' + infoFoot(l);
      }).catch(function () {
        if (req !== infoReq) return;
        body.innerHTML = '<div class="info-status">Informationen konnten nicht geladen werden (Internetverbindung nötig).</div><table class="info-kv"><tr><td>Layer-ID</td><td>' + esc(l.id) + '</td></tr></table>' + infoFoot(l);
      });
    }
    openInfoModal();
  }
  (function () {
    var modal = document.getElementById("info-modal"), body = document.getElementById("info-body"), lastFocus = null;
    openInfoModal = function () { lastFocus = document.activeElement; modal.hidden = false; document.getElementById("info-close").focus(); };
    function close() { infoReq++; modal.hidden = true; if (lastFocus && lastFocus.focus) lastFocus.focus(); }
    document.getElementById("info-close").addEventListener("click", close);
    modal.addEventListener("click", function (e) { if (e.target === modal) close(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !modal.hidden) close(); });
    body.addEventListener("input", function (e) {
      var id = e.target.getAttribute && e.target.getAttribute("data-ext-op"); if (!id) return;
      setExtOpacity(id, e.target.value);
      var o = e.target.parentNode.querySelector(".info-op"), l = extById(id); if (o && l) o.textContent = l.opacity + " %";
    });
  })();

  // ---- Parcel popup (map click, table row, search hit) ----
  function parcelPopupHTML(p) {
    var pid = String(p.id == null ? "" : p.id), bez = p[NAME_COL] || "";
    var act = function (a, label, icon) { return '<button type="button" class="mp-act" data-pop="' + a + '" data-id="' + esc(pid) + '">' + ICON.sz(icon, 15) + '<span>' + label + '</span></button>'; };
    var full = !sel[pid] && selCount() >= SEL_MAX;
    return '<div class="map-pop"><div class="mp-t">' + esc(p.input_ort || "—") + '</div>' + (bez ? '<div class="mp-s">' + esc(bez) + '</div>' : "") +
      '<div class="mp-kv"><span>ID</span><span>' + esc(pid || "—") + '</span><span>E-GRID</span><span>' + esc(p.egrid || "—") + '</span><span>Region</span><span>' + esc((p.input_rg || "—") + " · " + (p.input_plz ? p.input_plz + " " : "") + (p.input_ort || "")) + '</span><span>Grundstücksfläche</span><span>' + fmtAreaU(num(p.parcel_area_m2)) + '</span>' +
      (hasGreeninv ? '<span>Grüninventar</span><span>' + esc(greeninvLabel(p.greeninv)) + '</span>' : "") + '</div>' +
      '<div class="mp-acts">' + act("zoom", "Hinzoomen", "zoomIn") + act("table", "In Tabelle anzeigen", "funnel") + act("pdf", "PDF-Bericht erstellen", "fileText") +
      (p.greeninv === "yes" && greenInventoryUrl(p) ? '<a class="mp-act" href="' + esc(greenInventoryUrl(p)) + '" target="_blank" rel="noopener">' + ICON.sz("extlink", 15) + '<span>Im Grüninventar öffnen</span></a>' : "") +
      '<label class="mp-sel"><input type="checkbox" data-pop-sel="' + esc(pid) + '"' + (sel[pid] ? " checked" : "") + (full ? " disabled" : "") + '> Für PDF-Bericht auswählen' + (full ? " (max. " + SEL_MAX + ")" : "") + '</label></div>' +
      (pid ? '<a href="#" class="mp-more popup-details-link" data-id="' + esc(pid) + '"><span>Alle Details anzeigen' + ICON.sz("extlink", 12) + '</span></a>' : "") + '</div>';
  }
  function openParcelPopup(p, lngLat) {
    if (!map || !p) return;
    if (p._pole === undefined) p._pole = poleOfGeom(p._geom);
    var at = lngLat || p._pole; if (!at) return;
    showPopup(at, parcelPopupHTML(p));
  }
  // Delegated popup actions (the popup DOM is recreated on each open).
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-pop]"); if (!b) return;
    var id = b.getAttribute("data-id"), p = parcelById(id), act = b.getAttribute("data-pop"); if (!p) return;
    if (act === "zoom") zoomToParcel(id, { zoom: 17.5, noPopup: true });
    else if (act === "table") {
      if (_mapPopup) _mapPopup.remove();
      state.search = id; document.getElementById("tsearch").value = id;
      showTab("overview"); writeURL(); update();
      setTimeout(function () { var t = document.getElementById("tsearch"); if (t) t.scrollIntoView({ block: "center", behavior: "smooth" }); }, 50);
    } else if (act === "pdf") { if (_mapPopup) _mapPopup.remove(); openDownload(null, [p]); }
  });
  document.addEventListener("change", function (e) {
    var k = e.target.getAttribute && e.target.getAttribute("data-pop-sel"); if (k == null) return;
    setSelected(k, e.target.checked);
  });

  // ---- Global search (header): Grundstücke (local), Orte and Karten (swisstopo SearchServer) ----
  var openLayerSearch = function () {}, searchMarker = null, _pendingMapAction = null;
  function initGlobalSearch() {
    var input = document.getElementById("gsearch"), dd = document.getElementById("gsearch-dd");
    var scope = "all", open = false, q = "", loc = [], lay = [], loading = false, err = "", timer = null, ac = null, online = true, active = -1, actions = [];
    var ORIGIN_LABEL = { kantone: "Kanton", gg25: "Gemeinde", district: "Bezirk", address: "Adresse", parcel: "Grundstück", gazetteer: "Ortsname", zipcode: "PLZ" };
    var ZOOM = { kantone: 10, gg25: 13, district: 12, address: 17, parcel: 17, gazetteer: 14, zipcode: 13 };
    function strip(s) { return String(s || "").replace(/<[^>]*>/g, ""); }
    function place() {
      var r = input.getBoundingClientRect();
      dd.style.top = (r.bottom + 4) + "px"; dd.style.right = Math.max(8, window.innerWidth - r.right) + "px"; dd.style.left = "auto"; dd.style.width = Math.max(460, Math.round(r.width)) + "px";
    }
    function setOpen(o) { open = o; dd.hidden = !o; input.setAttribute("aria-expanded", o ? "true" : "false"); if (o) { place(); render(); } }
    function inScope(k) { return scope === "all" || scope === k; }
    function localHits() {
      var ql = q.toLowerCase(); if (!ql) return [];
      return PARCELS.filter(function (p) { return SEARCH_KEYS.some(function (k) { return String(p[k] == null ? "" : p[k]).toLowerCase().indexOf(ql) >= 0; }); });
    }
    function runRemote() {
      clearTimeout(timer); if (ac) ac.abort();
      if (q.length < 2 || (!inScope("places") && !inScope("maps"))) { loc = []; lay = []; loading = false; err = ""; render(); return; }
      loading = true; render();
      timer = setTimeout(function () {
        ac = new AbortController();
        var url = function (t) { return "https://api3.geo.admin.ch/rest/services/ech/SearchServer?type=" + t + "&limit=5&sr=4326&lang=de&searchText=" + encodeURIComponent(q); };
        var get = function (t) { return fetch(url(t), { signal: ac.signal }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }).then(function (d) { return d.results || []; }); };
        Promise.all([inScope("places") ? get("locations") : [], inScope("maps") ? get("layers") : []]).then(function (res) {
          online = true; loading = false; err = "";
          loc = res[0].map(function (r) { var a = r.attrs || {}; return { label: strip(a.label), origin: a.origin, lat: +a.lat, lon: +a.lon, box: a.geom_st_box2d }; }).filter(function (x) { return isFinite(x.lat) && isFinite(x.lon); });
          lay = res[1].map(function (r) { var a = r.attrs || {}; return { id: a.layer, title: strip(a.label) }; }).filter(function (x) { return EXT_ID_RE.test(x.id || ""); });
          render();
        }).catch(function (e) { if (e && e.name === "AbortError") return; online = false; loading = false; err = "swisstopo ist nicht erreichbar. Orte und Karten stehen offline nicht zur Verfügung."; loc = []; lay = []; render(); });
      }, 250);
    }
    function row(o) {
      return '<div class="sd-row" role="option" data-i="' + o.i + '"><span class="sd-mark ' + o.mark + '"></span><span class="sd-txt"><span class="sd-t">' + esc(o.t) + '</span>' + (o.s ? '<span class="sd-s' + (o.mono ? " mono" : "") + '">' + esc(o.s) + '</span>' : "") + '</span>' + (o.meta ? '<span class="sd-meta ' + (o.metaCls || "") + '">' + esc(o.meta) + '</span>' : "") + '</div>';
    }
    function render() {
      if (!open) return;
      actions = []; var h = "", i = 0;
      var SC = [["all", "Alle"], ["parcels", "Grundstücke"], ["places", "Orte"], ["maps", "Karten"]];
      h += '<div class="sd-scopes"><span>Suchen in</span><div class="seg seg-sm" role="group" aria-label="Suchbereich">' + SC.map(function (s) { return '<button type="button" class="seg-btn' + (scope === s[0] ? " is-active" : "") + '" data-scope="' + s[0] + '">' + s[1] + '</button>'; }).join("") + '</div></div>';
      var mapRow = function (id, title) {
        var l = extById(id), on = !!(l && l.visible);
        actions.push(function () { setOpen(false); if (!on) addExtLayer(id, title); });
        return row({ i: i++, mark: "mark-layer", t: title, s: id, mono: true, meta: on ? "Auf Karte" : "Hinzufügen", metaCls: on ? "on" : "" });
      };
      if (q.length >= 1 && inScope("parcels")) {
        var hits = localHits();
        if (hits.length) {
          h += '<div class="sd-sect"><div class="sd-head"><span>Grundstücke</span><span class="sd-src">Datensatz · ' + fmt(hits.length) + ' Treffer</span></div>';
          hits.slice(0, 5).forEach(function (p) {
            var pid = String(p.id == null ? "" : p.id);
            actions.push(function () { setOpen(false); focusParcel(pid); });
            h += row({ i: i++, mark: "mark-parcel", t: p[NAME_COL] || p.input_ort || pid, s: pid + " · " + (p.input_plz ? p.input_plz + " " : "") + (p.input_ort || "") + (p.input_rg ? " (" + p.input_rg + ")" : ""), meta: fmtAreaU(num(p.parcel_area_m2)), metaCls: "muted" });
          });
          actions.push(function () { setOpen(false); state.search = q; document.getElementById("tsearch").value = q; showTab("overview"); writeURL(); update(); });
          h += '<button type="button" class="flink sd-more" data-i="' + (i++) + '">Alle ' + fmt(hits.length) + ' Treffer in Tabelle filtern</button></div>';
        }
      }
      if (q.length >= 2 && inScope("places") && loc.length) {
        h += '<div class="sd-sect"><div class="sd-head"><span>Orte</span><span class="sd-src">swisstopo</span></div>';
        loc.forEach(function (r) { actions.push(function () { setOpen(false); goLocation(r); }); h += row({ i: i++, mark: "mark-place", t: r.label, s: ORIGIN_LABEL[r.origin] || r.origin || "" }); });
        h += '</div>';
      }
      if (q.length >= 2 && inScope("maps") && lay.length) {
        h += '<div class="sd-sect"><div class="sd-head"><span>Karten</span><span class="sd-src">swisstopo Geokatalog</span></div>';
        lay.forEach(function (r) { h += mapRow(r.id, r.title); });
        h += '</div>';
      }
      if (q.length < 2 && (scope === "all" || scope === "maps")) {
        h += '<div class="sd-sect"><div class="sd-head"><span>Häufig verwendete Karten</span><span class="sd-src">swisstopo Geokatalog</span></div>';
        EXT_SUGGEST.forEach(function (s) { h += mapRow(s[0], s[1]); });
        h += '</div>';
      }
      var status = "";
      if (q.length >= 2) {
        if (loading) status = "Suche bei swisstopo…";
        else if (err) status = err;
        else if (!actions.length) status = "Keine Treffer für «" + q + "».";
      } else if (q.length === 1 && !actions.length) status = "Keine Treffer.";
      if (status) h += '<div class="sd-status">' + esc(status) + '</div>';
      dd.innerHTML = h; active = -1;
    }
    function goLocation(r) {
      var switched = currentTab !== "map"; if (switched) showTab("map");
      var go = function () {
        if (!map) return;
        if (searchMarker) searchMarker.remove();
        var m = /BOX\(([-\d.]+) ([-\d.]+),([-\d.]+) ([-\d.]+)\)/.exec(r.box || "");
        if (m && r.origin !== "address" && r.origin !== "parcel") map.fitBounds([[+m[1], +m[2]], [+m[3], +m[4]]], { padding: 40, maxZoom: 17, duration: 900 });
        else map.flyTo({ center: [r.lon, r.lat], zoom: ZOOM[r.origin] || 14, duration: 900 });
        searchMarker = new maplibregl.Marker({ color: "#d8232a" }).setLngLat([r.lon, r.lat]).addTo(map);
      };
      if (map && mapReady) { if (switched) setTimeout(go, 80); else go(); } else _pendingMapAction = go;
    }
    dd.addEventListener("mousedown", function (e) { e.preventDefault(); }); // keep the focus in the input
    dd.addEventListener("click", function (e) {
      var s = e.target.closest("[data-scope]"); if (s) { scope = s.getAttribute("data-scope"); runRemote(); render(); input.focus(); return; }
      var r = e.target.closest("[data-i]"); if (r) { var a = actions[+r.getAttribute("data-i")]; if (a) a(); }
    });
    input.addEventListener("input", function () { q = input.value.trim(); if (!open) setOpen(true); runRemote(); render(); });
    input.addEventListener("focus", function () { q = input.value.trim(); setOpen(true); runRemote(); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { setOpen(false); input.blur(); return; }
      if (!open) { if (e.key === "ArrowDown") setOpen(true); return; }
      var rows = dd.querySelectorAll("[data-i]");
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault(); if (!rows.length) return;
        active = e.key === "ArrowDown" ? (active + 1) % rows.length : (active - 1 + rows.length) % rows.length;
        Array.prototype.forEach.call(rows, function (x, j) { x.classList.toggle("is-active", j === active); });
        return;
      }
      if (e.key === "Enter") { e.preventDefault(); var r = rows[active >= 0 ? active : 0]; if (r) { var a = actions[+r.getAttribute("data-i")]; if (a) a(); } }
    });
    document.addEventListener("click", function (e) { var path = e.composedPath ? e.composedPath() : []; if (open && e.target !== input && path.indexOf(dd) < 0) setOpen(false); });
    window.addEventListener("resize", function () { if (open) place(); });
    window.addEventListener("scroll", function () { if (open) place(); }, { passive: true });
    openLayerSearch = function () { scope = "maps"; input.focus(); input.select(); q = input.value.trim(); setOpen(true); runRemote(); render(); };
  }

  // ---- Map init: controls once, app layers on every (re)load of a style ----
  var HOVER_LAYERS = ["parcels-fill", "clusters", "point", "landcover-fill", "bauzonen-fill", "habitat-fill"];
  function initMap(el) {
    var b = basemapById(basemapId);
    var opts = { container: el, style: b.url, center: [8.23, 46.82], zoom: 6.4, preserveDrawingBuffer: true, cooperativeGestures: true, attributionControl: { compact: true } };
    if (b.hybrid) opts.transformStyle = composeHybrid;
    map = new maplibregl.Map(opts);
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right"); // compass = north icon; click resets bearing to 0
    map.addControl(new HomeControl(), "top-right");
    // Fullscreen over the map element itself, so every control, the popup and the dialogs' anchor come along.
    map.addControl(new maplibregl.FullscreenControl(), "top-right");
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }), "bottom-left");
    map.addControl(new SelBarControl(), "bottom-left");
    map.addControl(new AccordionControl(), "top-left");
    map.addControl(new BasemapControl(), "bottom-right");
    map.addControl(new Legend(), "bottom-right"); // print only (css); the info dialogs carry the legends on screen
    initContextMenu();
    map.on("load", addAppLayers);
    // One click handler, priority top→bottom: cluster → overlay → parcel.
    map.on("click", function (e) {
      if (!mapReady) return;
      if (map.getLayer("clusters")) {
        var cl = map.queryRenderedFeatures(e.point, { layers: ["clusters"] });
        if (cl.length) {
          var zp = map.getSource("points").getClusterExpansionZoom(cl[0].properties.cluster_id);
          var go = function (zoom) { map.easeTo({ center: cl[0].geometry.coordinates, zoom: zoom }); };
          if (zp && typeof zp.then === "function") zp.then(go).catch(function () {}); else map.getSource("points").getClusterExpansionZoom(cl[0].properties.cluster_id, function (err, zoom) { if (!err) go(zoom); });
          return;
        }
      }
      var order = [["habitat-fill", "habitat"], ["bauzonen-fill", "bauzonen"], ["landcover-fill", "landcover"], ["parcels-fill", "parcel"]];
      for (var i = 0; i < order.length; i++) {
        if (!map.getLayer(order[i][0]) || map.getLayoutProperty(order[i][0], "visibility") === "none") continue;
        var fs = map.queryRenderedFeatures(e.point, { layers: [order[i][0]] });
        if (!fs.length) continue;
        var f = fs[0];
        if (order[i][1] === "parcel") {
          var p = parcelById(f.properties.id);
          selectParcel(f.properties.id); // highlight polygon + focus the table row (no scroll)
          if (p) openParcelPopup(p, e.lngLat);
        } else {
          highlightOverlay("ov-" + order[i][1], f.id);
          showPopup(e.lngLat, overlayPopupHTML(order[i][1], f.properties.art, f.properties.area_m2));
        }
        return;
      }
    });
    map.on("mousemove", function (e) {
      if (!mapReady) return;
      var ls = HOVER_LAYERS.filter(function (l) { return map.getLayer(l) && map.getLayoutProperty(l, "visibility") !== "none"; });
      var f = ls.length ? map.queryRenderedFeatures(e.point, { layers: ls }) : [];
      map.getCanvas().style.cursor = f.length ? "pointer" : "";
    });
  }
  // Everything the app draws: runs on the first load and again after every basemap switch (setStyle drops it all).
  function addAppLayers() {
    if (map.getSource("parcels")) return; // already built for this style
    map.addSource("parcels", { type: "geojson", data: rowsToFC(lastRows) });
    map.addLayer({ id: "parcels-fill", type: "fill", source: "parcels", minzoom: PARCEL_MINZOOM, paint: { "fill-color": PARCEL_COLOR, "fill-opacity": 0.4 } });
    map.addLayer({ id: "parcels-line", type: "line", source: "parcels", minzoom: PARCEL_MINZOOM, paint: { "line-color": "#3b5a7a", "line-width": 0.7 } });
    map.addLayer({ id: "parcels-sel", type: "line", source: "parcels", minzoom: PARCEL_MINZOOM, filter: ["in", ["get", "id"], ["literal", selIds()]], paint: { "line-color": "#2f4356", "line-width": 2.2, "line-dasharray": [2, 1.2] } });
    map.addLayer({ id: "parcels-hl-casing", type: "line", source: "parcels", minzoom: PARCEL_MINZOOM, filter: ["==", ["get", "id"], selectedParcelId || " "], paint: { "line-color": "#fff", "line-width": 5, "line-opacity": 0.9 } });
    map.addLayer({ id: "parcels-hl", type: "line", source: "parcels", minzoom: PARCEL_MINZOOM, filter: ["==", ["get", "id"], selectedParcelId || " "], paint: { "line-color": "#d8232a", "line-width": 2.6 } });
    addOverlayLayers(); // Bodenbedeckung / Bauzonen / Lebensräume, under the markers
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
    extLayers.forEach(addExtToMap); syncExtOrder();
    applyLayerVis();
    _selOv = null;
    mapReady = true; renderMap(lastRows); renderLegend(); renderAccordion();
    if (_pendingZoom) { var z = _pendingZoom; _pendingZoom = null; zoomToParcel(z.id, z.opts); }
    if (_pendingMapAction) { var a = _pendingMapAction; _pendingMapAction = null; a(); }
  }
  var _mapTried = false;
  function ensureMap() {
    var el = document.getElementById("map"); if (!el || _mapTried) return; _mapTried = true;
    if (window.maplibregl) { initMap(el); return; }
    el.innerHTML = '<div class="map-msg">Karte wird geladen…</div>';
    var css = document.createElement("link"); css.rel = "stylesheet"; css.href = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css"; document.head.appendChild(css);
    var s = document.createElement("script"); s.src = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js";
    s.onload = function () { el.innerHTML = ""; initMap(el); };
    s.onerror = function () { el.innerHTML = '<div class="map-msg">Karte konnte nicht geladen werden (Internetverbindung nötig).</div>'; };
    document.head.appendChild(s);
  }

  // ---- Init ----
  var dt0 = document.getElementById("dash-title"); if (dt0 && window.DASHBOARD_TITLE) dt0.textContent = window.DASHBOARD_TITLE;
  readURL();            // filters (defaults on a first visit) + navigation params
  applyNavState();      // basemap + external maps from the URL
  syncDrawer();
  initGlobalSearch();
  update();
  showTab(nav.tab);     // Karte is the start view; showTab stamps tab, basemap, ext and the active defaults into the URL
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
