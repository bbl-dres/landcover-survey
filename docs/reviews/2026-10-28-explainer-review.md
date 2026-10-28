# Explainer review — «Kurz erklärt: Was macht diese Anwendung?»

**Date:** 2026-10-28
**Subject:** the explainer animation below the upload card of the processing web app
(`processing-web/js/explainer.js`, its `.ex-*` styles in `processing-web/css/styles.css`,
the `explainer.*` strings in `processing-web/js/i18n.js`).
**Reviewers:** two independent review passes, each in a professional role —
a video / motion-design producer (timing, legibility, choreography, controls) and a
communication / plain-language editor (copy, jargon, narrative, FR / IT / EN fidelity).
**Persona:** someone who opens the page and has no idea what the application does,
what a Grundstück, an EGRID or «Bodenbedeckung» is, and who watches **without sound**.
**Method:** the first version (six scenes, 31.5 s, title «In 30 Sekunden») was
reviewed from eight screenshots plus 19 additional frames captured with a read-only
Playwright harness at 1440 px and at 390 / 360 px phone widths; reading time was
budgeted at 2.5 words per second (silent reading of German UI copy); font sizes were
measured at the phone render scale (stage 332 px wide → SVG scale 0.52); path lengths
and animation timings were measured in the DOM. Facts in the copy were checked against
`docs/MANUAL.md`, `docs/CLASSIFICATION.md`, `processing-web/README.md`,
`data/landcover.json` and the app's own UI strings (`upload.*`, `agg.*`, `summary.*`).

Both reviews reached the same verdict: the arc (what → why → source → how → result →
next) is right and the visuals are good, but the piece was **written for people who
already know the domain** and **built for a desktop screen**. A novice could say "it is
about Grundstücke and Bodenbedeckung" after 30 s, but not what comes out or why anyone
cares; on a phone almost every word inside the picture was 4–8 px. Everything below was
implemented in a rebuild of the module unless the status column says otherwise.

---

## Findings

Severity: **High** = a first-time viewer misunderstands or gives up; **Medium** = clearly
worse than it should be; **Low** = polish. Source: **P** = production review, **C** = copy
review (a finding both raised is listed once).

| # | Sev. | Finding | Source | Status |
|---|------|---------|--------|--------|
| 1 | High | **Captions overran the no-audio reading budget in every scene** (19–23 words where the scene allows 14–16; 105 caption words plus ~80 in-scene words in 31.5 s, i.e. 42 s of reading in a 32 s film). Each caption also competed with sentences inside the picture. | P1, C1 | Fixed — every caption ≤ 14 words, no sentence inside the SVG, each scene carries one idea. |
| 2 | High | **Phone legibility**: 11.5 px / 11 px / 9 px SVG text rendered at 5.4–6.0 px / 4.2–4.7 px on 360–390 px phones; legend, KPI labels, box subtitles and notes were grey smudges. | P2 | Fixed — nothing in the viewBox below 13 px (14 px for labels), no explanatory text in the SVG, sentences only in the 14 px HTML caption. |
| 3 | High | **The «Klassieren» beat was factually wrong and showed no classification**: the orange meadow swatch was labelled «UUF – Wald, Wasser, unbearbeitet» (a meadow is BUF per `CLASSIFICATION.md`), the garden colour had no legend entry, «humusiert» is survey jargon, and the parcel itself never changed — only a legend faded in. Clip and classify shared one 6.5 s scene. | P3, C4, C7 | Fixed — split into «Zuschneiden» (4.5 s) and «Klassieren» (5.0 s). Classify recolours and merges the five patches into the three classes the film is about (bebaut · versiegelt · grün), inner boundaries disappear in the same fade; the norms appear as a three-line gloss («Normen: SIA 416 · DIN 277 / Grünfläche · Versiegelung / naturnah (VBS)»). No GGF / BUF / UUF acronyms on screen. |
| 4 | High | **The poster was an empty grey box**: `showScene(0, {silent:true})` paused every animation at t = 0, where all children are at opacity 0. A novice saw a blank video with a play button. | P4 | Fixed — the poster shows the end frame of scene 1 (negative `animation-delay` on every animated node, paused) under the veil; play restarts from zero. |
| 5 | High | **The hook used an insider frame and over-promised**: «Grundstück des Bundes» presumes the reader knows the Confederation owns a portfolio; «jedes» is wrong (six cantons return no land cover); «befestigt» reads as "fastened" and two scenes later the same idea is called «versiegelt». | C2 | Fixed — «Wie viel eines Grundstücks ist bebaut, versiegelt oder grün? Diese Anwendung rechnet es aus.»; the question is in the picture («Was bedeckt den Boden – und wie viel davon?»); the paved patch is now the noun «Vorplatz»; «Bund» moved to the Wozu scene, where it is the reason. |
| 6 | High | **Wozu was stated in facility-management vocabulary and showed nothing to compare**: «Portfolio», «Kennzahlen», «Zielwerte», «SIA 416 und DIN 277» in the caption; one single bar for one parcel while the note promised comparability; tiles said 55 % green while the bar drew 62 %. | C3, P5 | Fixed — «Gleich gerechnet für alle Grundstücke des Bundes – so werden Standorte vergleichbar und Ziele messbar.»; three stacked bars A / B / C with visibly different splits; tiles and bar agree (38 / 62); norms removed from this scene. |
| 7 | Medium | **The clip was too subtle and vanished under reduced motion**: raw patches overhung the boundary by 20–40 px, the cut was a plain cross-fade with no cue, nothing showed what was removed; with `prefers-reduced-motion` the raw layer disappeared at once, so the scene showed only the result. | P6 | Fixed — ≥ 60 px overhang on every side, the outline pulses once at the cut, the outside remainder stays as a 12 % ghost (so the reduced-motion still is self-explanatory). |
| 8 | Medium | **The result scene crammed three ideas and had layout bugs**: result mock + export chips + privacy lines + a 23-word caption in 5.5 s; a 9 px «Karte» label was drawn across the parcel; the parcel had a different shape in scenes 3, 4 and 5. | P7, C5 | Fixed — the privacy line moved to the Woher scene, where the data flow is shown («Gesendet wird nur die Grundstücks-ID (EGRID).» — the upload card's own gloss); the result scene keeps mock → donut → table → export chips; the same `PARCEL` path is drawn, scaled, in every scene; the tiny labels are gone. |
| 9 | Medium | **Draw animations snapped on**: `stroke-dasharray: 1200` on 80–90 px arrows meant the whole arrow was visible after ~50 ms; the parcel outline (892 px) finished at 0.55 s instead of 1.2 s; arrows appeared before the boxes they point to. | P8 | Fixed — `pathLength="1"` on every drawn path with dasharray 1; scene 3 retimed (arrow → box → arrow → app window). |
| 10 | Medium | **Every scene change was a hard cut to a blank stage** (`innerHTML` swap, first element delayed 0.1–0.4 s). | P9 | Fixed — 250 ms cross-fade on the stage (Web Animations API, skipped under reduced motion), consistent first delay of 0.25 s; the parcel stays in place from scene 1 through clip and classify. |
| 11 | Medium | **Label contrast**: white 11 px bold on `#BFBFBF` (1.9:1) and on `#FCC690` (1.6:1); the road patch painted over the parcel outline. | P10 | Fixed — dark labels with a light halo on the two light patches, 14 px / 700; the outline is the last child of the scene group. |
| 12 | Medium | **Three different lengths were advertised**: title «In 30 Sekunden», badge «32 Sekunden», comment «≈ 31 s». | P11, C9 | Fixed — title «Kurz erklärt: Was macht diese Anwendung?» (FR «En bref : …», IT «In breve: …», EN «In short: …»); at the owner's request **no duration is shown anywhere** (badge and poster number removed). |
| 13 | Medium | **Controls and accessibility**: 16 px timeline segments with no hover state or title; all segments `flex: 1` although scenes last 2.5–6.5 s; `role="tablist"` without the keyboard behaviour that implies; the play button toggled both `aria-pressed` and its label; the poster's focus ring was clipped by `overflow: hidden`; `<svg role="img" aria-hidden="true">`; two dead lines (`data-reduced-motion`, `animationPlayState` on the stage). | P12 | Fixed — 24 px segments with hover and title, widths proportional to scene length (`flex: <ms>`), `role="group"` + `aria-current` + ←/→ keys, label-only toggle, inset focus ring on the poster, no `role="img"`, dead code removed. Click-to-play stays (autoplay would compete with the upload card above it). |
| 14 | Medium | **Woher: three unexplained names and an IT-jargon note**: «EGRID», «AV» and «amtliche Vermessung» without a gloss; «Öffentliche Dienste – keine lokale Datenhaltung nötig» reads as public utilities and IT-department German. | C6 | Fixed — chip caption «EGRID – öffentliche Grundstücks-ID»; boxes «swisstopo / Grundstücksgrenze» and «geodienste.ch / Bodenbedeckung»; caption «Aus der amtlichen Vermessung, den offiziellen Grundstücksdaten: swisstopo liefert die Grenze, geodienste.ch die Bodenbedeckung.»; the note is replaced by the privacy line. |
| 15 | Medium | **FR / IT diverged from the UI**: IT said «particella» while the IT UI says «parcella»; FR / IT legends used the German acronyms GGF / BUF / UUF although the FR / IT UI names the classes SB / SAA / SAN and SE / SLES / SLEN. | C8 | Fixed — IT uses «parcella» throughout; the legend uses plain words in every language (bâti · imperméabilisé · vert / edificato · impermeabilizzato · verde / built · sealed · green), so no acronym has to be translated. |
| 16 | Medium | **The call to action did not match the controls** («Liste hochladen» — a list of what? the tabs say «Stapel-Upload (CSV)»), and the viewer had to find «oben» alone. | C10, P13 | Fixed — «Grundstück anklicken oder CSV-Liste hochladen / oben auf dieser Seite»; a click on the last scene scrolls to the upload card and focuses the search field. |
| 17 | Low | Caption title ran into the text for the two non-question titles («Ergebnis Karte, Tabelle …»). | C11, P13 | Fixed — the title is a pill; the last title is the question «Und jetzt?». |
| 18 | Low | KPI tiles and the bar disagreed; label casing mixed («versiegelt» next to «Grünfläche»). | C12 | Fixed — «Versiegelt», 38 / 62 everywhere. |
| 19 | Low | The KPI counters ran on their own clock (kept counting while paused); bars animated the CSS `width` of SVG rects (flaky outside Chromium). | P14 | Fixed — counters follow the scene clock and freeze on pause; bars grow with `transform: scaleX()`. |
| 20 | Low | Sample EGRID with spaces («CH4277 6011 0057») unlike the manual and the inputs; the caption says «grün» while meadow and garden are orange (the real map's palette). | P15, C14 | Fixed — «CH955832730536» (the manual's example); the palette stays (users meet it on the map), and the classify scene names the orange class «grün», which resolves the mismatch where it matters. |
| 21 | Low | FR / IT / EN wording slips («Services publics», «chez swisstopo», «terre végétale», «unworked», «sealing» vs the UI's «imperviousness», «for every federal parcel»). | C13 | Fixed where the string survived the rewrite; the others were removed with the scene text they belonged to. |
| 22 | Low | On a phone a stale toast («1 Fehler – Protokoll öffnen») from an earlier run sits over the play / replay row. | C15 | **Open** — the toast is global to the app, not explainer copy; it is only visible after a run that ended with errors and before the user starts the next one. Left as is. |

---

## What was implemented

The module was rebuilt rather than patched; the rules that came out of the review are
now in the file header so the next edit keeps them:

- every caption ≤ 14 words, no sentence inside the SVG;
- nothing in the SVG below 13 px (the stage renders at about half size on phones);
- one idea per scene, the same parcel shape in every scene, the colours of the real
  result map.

**Scenes** (seven, about 34 s in total; the length is deliberately not advertised):

| # | Scene | Length | Caption (DE) |
|---|-------|--------|--------------|
| 1 | Was? | 6.0 s | Wie viel eines Grundstücks ist bebaut, versiegelt oder grün? Diese Anwendung rechnet es aus. |
| 2 | Wozu? | 5.5 s | Gleich gerechnet für alle Grundstücke des Bundes – so werden Standorte vergleichbar und Ziele messbar. |
| 3 | Woher? | 5.5 s | Aus der amtlichen Vermessung, den offiziellen Grundstücksdaten: swisstopo liefert die Grenze, geodienste.ch die Bodenbedeckung. |
| 4 | Zuschneiden | 4.5 s | Die Bodenbedeckung wird an der Grundstücksgrenze abgeschnitten. |
| 5 | Klassieren | 5.0 s | Jede Fläche wird einer Klasse zugeordnet – bebaut, versiegelt oder grün, nach Normen wie SIA 416. |
| 6 | Ergebnis | 5.0 s | Karte, Tabelle und Zusammenfassung – Export als Excel, CSV oder GeoJSON. Ihre Daten bleiben im Browser. |
| 7 | Und jetzt? | 2.5 s | Oben: Grundstück auf der Karte anklicken oder CSV-Liste hochladen. |

FR, IT and EN carry the same seven captions and labels (47 keys per language, all
`explainer.*`); a language switch re-captions a running scene.

**Poster**: the end frame of scene 1 (the labelled parcel) under a light veil with one
button, «Abspielen».

**Motion**: drawn paths use `pathLength="1"`; scene changes cross-fade in 250 ms; the
clip scene shows a wide overhang, a pulse at the cut and a ghost of the discarded
remainder; the classify scene recolours and merges the patches; counters and bars follow
the scene clock. Under `prefers-reduced-motion` every scene jumps to its end frame and
the user steps through the timeline.

**Controls**: play / pause, replay, a proportional timeline (24 px targets, hover,
titles, `aria-current`, ←/→), the caption title as a pill. The last scene is clickable
and leads to the upload card. The explainer lives inside the start state: `main.js`
pauses it when the state changes and resets it on «Neue Analyse».

---

## Decisions that differ from a recommendation

- **Plain classes instead of SIA acronyms on stage.** The copy review proposed a
  corrected SIA legend («Gebäude → GGF», «Wege, Wiesen, Gärten → BUF», «Wald, Wasser,
  Fels → UUF»); the production review proposed the three plain classes the whole film
  asks about. The plain classes were chosen: they close the loop with scene 1 and need
  no translation of acronyms; the norms are named once, as a gloss, in the same scene.
- **No duration anywhere.** Both reviews asked for a single source of truth for the
  advertised length; the owner decided to show none.
- **Seven scenes, ~34 s** instead of six at ~32 s: the extra scene costs two seconds and
  removes the one beat that carried two ideas.
- **Still no autoplay** — the explainer sits under the primary upload card, and autoplay
  would compete with it and with reduced-motion users.

## Open points

- The phone toast overlap (finding 22) is a toast-placement question for the app, not
  the explainer.
- The IT UI mixes *tu* and *voi* forms («Clicca» / «Selezionate»); the explainer uses
  *voi*. Aligning the UI register is a separate copy task.

---

## Verification

End-to-end run (`scratchpad/pw/run_explainer.js`, Playwright + Chromium, local
`http.server`): placement below the upload card, poster visible with 8 / 8 scene-1
elements drawn, title and poster text, every one of the seven captions after stepping
through the timeline, `aria-current` on the right segment, the last segment at 100 % with
`data-playing="false"` at the end, the CTA click scrolls up and focuses
`parcel-search-input`, replay → pause → play, the FR caption after a language switch,
the explainer hidden while a batch runs and the poster restored after «Neue Analyse», the
phone layout at 390 px (explainer 358 px wide, no horizontal overflow); no page or console
errors. Per-scene screenshots were inspected at desktop and phone width.

## Files

| File | Change |
|------|--------|
| `processing-web/js/explainer.js` | Rebuilt (seven scenes, poster frame, cross-fade, scene-clock counters, controls) |
| `processing-web/css/styles.css` | Explainer block replaced (`/* ── Explainer («Kurz erklärt») … */`) |
| `processing-web/js/i18n.js` | `explainer.*` strings replaced in DE / FR / IT / EN |
| `processing-web/js/main.js` | Unchanged API (`initExplainer`, `pauseExplainer`, `resetExplainer`) |
| `processing-web/README.md` | Feature bullet and file list updated |

---

## Second iteration — one real parcel, told as the workflow

**Request (owner, same day):** start from a real parcel (CH834682352690) and structure
the explainer like the real workflow — most users begin with an aerial view, search the
place on map.geo.admin.ch or in the app's own search field, see the parcel polygon over
the aerial image, then learn how land cover, processing, results and exports work.

### What the parcel is

CH834682352690 is **Zollikofen (BE), Parzelle 112**: 17'427 m² with a building complex,
a forecourt and parking, a garden, a meadow and a pond. Processed by the app's own
pipeline (CLI, `--source api`, identical to the web app) it yields 44 % sealed, 50 % green
space, 2'542 m² building footprint and 6 % water — a parcel with every class the film
talks about, which is why it works as the running example.

### Storyline (implemented)

Eight scenes, about 39 s, every one on the same parcel; scenes 2–5 share one aerial frame
so the parcel never moves:

| # | Scene | s | On stage | Caption (DE) |
|---|-------|---|----------|--------------|
| 1 | Wo? | 6.0 | Wide aerial of Zollikofen; «Zollikofen 112» typed into a search field, the hit «Zollikofen 112 (CH 8346 8235 2690)» as map.geo.admin.ch and the app's search show it; the map zooms onto the parcel, a pin marks it; «Adresse · Grundstücknummer · EGRID» | Ein Ort, gesucht mit Adresse, Grundstücknummer oder EGRID – auf map.geo.admin.ch oder hier im Suchfeld. |
| 2 | Grundstück | 5.5 | Tight aerial; the cadastral boundary draws itself and pulses; «Zollikofen · Parzelle 112», the EGRID chip, «Grenze: amtliche Vermessung · swisstopo», the privacy line | Die amtliche Vermessung kennt die genaue Grenze – swisstopo liefert sie zur EGRID. |
| 3 | Bodenbedeckung | 5.5 | The real AV land cover of the whole frame appears group by group (paved, buildings, humus, wood, water) in the result map's colours; the surfaces inside the parcel get their names (Gebäude, Vorplatz, Garten, Wiese, Teich, Strasse) | Was den Boden bedeckt – Gebäude, Strasse, Garten, Wiese, Teich – kommt von geodienste.ch. |
| 4 | Zuschneiden | 4.0 | The boundary pulses; everything outside fades to a ghost, the aerial shows through again; the inside stays | Die Bodenbedeckung wird an der Grundstücksgrenze abgeschnitten. |
| 5 | Klassieren | 5.0 | The clipped surfaces take the colour of their class; legend bebaut · versiegelt · grün · Gewässer; the norms as a gloss | Jede Fläche wird einer Klasse zugeordnet – bebaut, versiegelt, grün, Gewässer – nach Normen wie SIA 416. |
| 6 | Kennzahlen | 5.5 | The parcel's real figures count up (44 %, 50 %, 2'542 m²); three stacked bars — «112» with its real split and two other parcels — make «vergleichbar» visible | Für jedes Grundstück des Bundes gleich gerechnet – vergleichbar, für Berichte und Ziele. |
| 7 | Ergebnis | 5.0 | The app window: the aerial with the classified parcel, the summary donut with the real split, the table; export chips Excel · CSV · GeoJSON | Karte, Tabelle und Zusammenfassung – Export als Excel, CSV oder GeoJSON. Ihre Daten bleiben im Browser. |
| 8 | Und jetzt? | 2.5 | «Grundstück anklicken, Adresse oder EGRID eingeben / oder CSV-Liste hochladen – oben auf dieser Seite», arrow; the stage is a link to the upload card | Oben: Grundstück auf der Karte anklicken, Adresse oder EGRID eingeben – oder CSV-Liste hochladen. |

The poster is the end frame of scene 2 (the parcel on the aerial). The earlier «Wozu?» and
«Woher?» scenes are folded into scenes 2, 3 and 6, where the sources and the comparison
appear in context instead of as a diagram. Every rule from the first review still holds
(captions ≤ 14 words, no sentence in the SVG, nothing below 13 px, one idea per scene);
one rule was added: text over the aerial always carries a halo.

### How the material is produced

`scripts/build_explainer_sample.py` (network) fetches the parcel boundary and the raw land
cover around it through the CLI's `api` module, runs the CLI for the figures, requests two
SWISSIMAGE excerpts from the geo.admin WMS (1.5 km and 430 m frames, same centre, 80 m east
of the parcel so the parcel sits left and the right side stays free for labels), projects
every polygon into the stage's 640 × 300 viewBox and writes `processing-web/js/explainer-sample.js`
(45 KB: boundary path, 173 surfaces with their AV main group, label anchors, figures, zoom
factor) and `processing-web/assets/explainer/zollikofen-112.jpg` (172 KB) +
`zollikofen-112-wide.jpg` (110 KB). The wide frame zooms onto the tight one with a plain
CSS scale about the frame centre; the pin rides along. Aerial imagery is swisstopo
SWISSIMAGE (free geodata); «Luftbild © swisstopo» is written on every aerial frame.

### Verification

`run_explainer.js` (eight scenes): poster from scene 2 with all elements drawn, every
caption after stepping through the timeline, `aria-current`, end state, the CTA click
focusing the search field, replay / pause / play, FR captions, hidden while a batch runs,
poster restored after «Neue Analyse», phone width; no page or console errors. Frames of the
zoom at 1.5 / 2.5 / 3.8 / 5.6 s confirm the pin stays on the parcel and the zoomed wide frame
matches the tight frame of scene 2; the alignment of boundary and surfaces over the aerial
was checked with the generator's `--preview` overlay.

### Files (second iteration)

| File | Change |
|------|--------|
| `processing-web/js/explainer.js` | Eight scenes over the aerial excerpts; poster = parcel scene |
| `processing-web/js/explainer-sample.js` | **New, generated** — the parcel's geometry, surfaces, figures |
| `processing-web/assets/explainer/*.jpg` | **New** — two SWISSIMAGE excerpts (© swisstopo) |
| `scripts/build_explainer_sample.py` | **New** — generator (CLI api module + WMS) |
| `processing-web/js/i18n.js` | 50 `explainer.*` keys per language, rewritten for the new scenes |
| `processing-web/css/styles.css` | Halo text, surfaces over the aerial, zoom / pin / typing animations |
