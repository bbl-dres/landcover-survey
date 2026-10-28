# Dashboard design & UX review — `dashboard/`

**Date:** 2026-10-28
**Scope:** the offline dashboard (`dashboard/index.html`, `css/tokens.css`, `css/styles.css`,
`js/dashboard.js`) as a product: interactions, design consistency, hard-coded styles that
belong in tokens, and responsive behaviour. No feature was added or removed.
**Role:** senior product designer / UX expert, with the owner's reported flaws as the starting
point: clicking the empty map should clear the marked parcel; clicking a parcel's ID label (or
its point marker) should select it; the download dialog greyed out «Ausgewählt» and the
PDF report although a parcel had been clicked.
**Method:** full read of the markup, tokens, stylesheet and app script; live measurement in
headless Chromium with Playwright at 1440 × 960, 1280 × 720, 1024 × 768, 390 × 844 and
844 × 390 (computed styles, bounding boxes, WCAG contrast ratios, keyboard focus, scroll
behaviour, text overflow), 64 screenshots; a usage audit of every token against the
stylesheet; then a verification harness that re-measures the same things after the changes
(`ux_verify.js`) plus the three existing end-to-end suites.

## Verdict

At desktop width the dashboard is a coherent federal-CD product: lockup header, one
slate/red palette, a strong global search, careful dialogs, keyboard support for tabs, table
rows and summary rows, German MapLibre controls with the Lucide set, sensible empty states
and print rules. The weaknesses sat in three places and all three are fixed in this change
set: **(1)** the viewport layout was built on magic numbers (`calc(100vh − 174px)` and
friends) that broke as soon as the header wrapped — at 1280 px already — and on phones the
filter drawer's lower groups were unreachable; **(2)** the map's selection model had two
overlapping concepts (red "highlight" from a click, slate "checkbox selection" for the
report) under one word, which is where the three owner-reported gaps came from; **(3)** the
stylesheet carried a token file it did not use (spacing, icon, z-index tokens defined but
unused, nine literal font sizes, six literal z-indexes, some twenty map and legend colours
outside the palette).

---

## Findings and what changed

Severity: **High** = a task fails or content is unreachable; **Medium** = a real usability or
consistency defect; **Low** = polish. Every row marked *Fixed* is in this change set.

| # | Sev. | Finding (evidence) | Fix |
|---|------|--------------------|-----|
| H1 | High | **Map-tab layout relied on fixed chrome heights.** `#map { height: calc(100vh − 174px) }` and `#filter-panel { height: calc(100vh − 121px) }` assumed a 78 px header; the header wraps to two rows at 1280 px (132 px), so the "Karte never scrolls" promise held only above 1289 px (1280 × 720: page 774 px in a 720 px viewport; 1024 × 768: 822/768; 390 × 844: 1096/844; 844 × 390: 650/390). | Fixed — `body` is a flex column (header · `#app` · footer), `#app.tab-map` lets the map panel fill what is left (`flex: 1 1 auto; min-height: min(320px, 60vh)`), the filter panel stretches with it, a `ResizeObserver` resizes the canvas. The three `calc()`s and the `min-height: calc(100vh − 100px)` rule are gone. The search field shrinks (`flex: 1 1 220px; max-width: 380px`) so the header stays one row down to 1280 px; `Liegenschaftsinventar` hides below 1280 px. Measured after: no page scroll on Karte at 1440, 1280, 1024 and 390 px. |
| H2 | High | **Phone drawer unreachable below ~800 px.** The fixed drawer kept the base rule `align-self: flex-start`, so with `top: 0; bottom: 0; height: auto` it was sized to its content (2 671 px); `.fp-body` never scrolled and wheel/touch scrolled the page behind it. | Fixed — in the drawer media query `align-self: auto; height: 100dvh`, `.fp-body { min-height: 0 }`; the page is locked (`body.no-scroll`) while the drawer or a dialog is open. Measured after: drawer 844 px, body scrolls 3 566 px inside it. |
| H3 | High | **Owner flaw 1 — clicking the empty map did not clear the marked parcel.** The click handler returned only when a feature was hit; no "miss" branch; overlay highlight and popup stayed too. | Fixed — `clearMapSelection()` on a miss (active parcel, overlay highlight, popup); **Escape** clears as well when no dialog, menu, dropdown or drawer is open. The shared popup no longer uses MapLibre's own close-on-click, which had removed a popup the same click had just opened. |
| H4 | High | **Owner flaw 2 — ID labels and point markers were not targets.** The handler queried clusters → overlays → parcel fills; the `point-label` symbol layer and the `point` circles (the only thing visible below zoom 11) were never hit-tested, and the cursor did not change over labels. | Fixed — labels and markers are tested right after clusters (they are drawn on top): the parcel is marked and, above the polygon zoom, its popup opens; below it the map zooms to the parcel. `point-label` joined the hover layers. Verified by clicking a rendered label (the right parcel is marked, popup open). |
| H5 | High | **Owner flaw 3 — the download dialog ignored the marked parcel.** `counts()` only read the checkbox selection, so «Ausgewählt (0)» was disabled and the PDF row said «Maximal 50 Grundstücke …» while the popup's own «PDF-Bericht erstellen» printed exactly that parcel. | Fixed — the marked parcel is the implicit selection while no checkbox selection exists: the dialog opens on «Ausgewählt (1)», the PDF row reads «A3, eine Seite: Grundstück ‹id› (auf der Karte markiert)», Excel / GeoJSON / Datenqualität follow the same scope. The >50 message now says what to do («Ausgewählt» wählen oder die Filter einschränken). The table bar and the map selection bar stay checkbox-only (they *are* the explicit selection). |
| H6 | High | **Two selection states, one vocabulary, look-alike class names.** Red outline + `.row-selected` (map click) and dashed slate outline + `.row-sel` (report checkboxes) were both «Ausgewählt» in the legend, the layer info and the bars. | Fixed — one name per concept: **«Markiert»** (map legend, layer info «Markiert (angeklickt)») vs **«Für den Bericht ausgewählt»** (table bar, map selection bar, layer info); classes `.row-active` / `.row-checked`. Colours unchanged (red = marked, slate = report set). |
| M1 | Medium | **Layer accordion collided with the bottom-left stack** (`max-height: calc(100vh − 240px)` ignored the selection bar + scale; at 1280 × 720 «Menü schliessen» and «Karte hinzufügen» sat under the selection bar; at 390 the toggle was covered). | Fixed — the top-left control container is bounded (`bottom: 110px`, 150 px on phones) and the panel flexes inside it; both `calc()`s removed. Measured: accordion bottom 783 px, bottom-left stack top 885 px at 1440 × 960. |
| M2 | Medium | **Popups rendered under the map controls and over the parcel they describe** (no z-index; anchored at the pole of inaccessibility). | Fixed — `.maplibregl-popup { z-index: 3 }`; a popup opened from the table or search anchors at the parcel's right edge, mid-height, and the zoom-to-parcel fit leaves room beside it (padding right up to 340 px, 45 % of the map on narrow screens). Verified: the card no longer covers the map centre. |
| M3 | Medium | **Focus rings clipped** on segmented controls (`.seg { overflow: hidden }`), table headers / rows (scroll box, sticky header). | Fixed — inner rings (`outline-offset: −3px`) where clipping is structural. |
| M4 | Medium | **MapLibre buttons showed MapLibre's blue focus ring**, not the CD ring. | Fixed — `box-shadow: none` on focus, the 3 px purple ring on `:focus-visible` (inner offset); also the attribution button. |
| M5 | Medium | **Info dialog had no focus trap / inert background; dialogs and the drawer left the page scrollable; the columns menu ignored Escape.** | Fixed — `trapTab()`, `bgInert()` and `lockScroll()` are shared helpers used by both dialogs; the drawer locks the page; Escape closes the columns menu and returns focus to its button. Verified: six Tabs stay inside the info dialog, `#app.inert` is true. |
| M6 | Medium | **Table: sticky header/footer never stuck; the horizontal scrollbar sat 1 000 px below the header** (`.table-scroll` only scrolled horizontally). | Fixed — `.table-scroll { overflow: auto; max-height: calc(100vh − 160px) }`: head and foot stick, the horizontal bar is always within reach; print keeps `max-height: none`. |
| M7 | Medium | **WCAG AA contrast failures**: section titles, chart notes, counts and the About muted text at 4.37:1 on the tinted panel, checklist counts 3.78:1, switched-off layer rows 2.3–2.6:1. | Fixed — gray-600 for the first group (6.8:1), gray-500 for off layers (4.6:1). |
| M8 | Medium | **Click / touch targets below 24 px**: collapse button 26 px, pill × 18, layer × 20, layer info 24, info glyph 14, text links 17 px tall, checklist rows 27 px with 13 px boxes, popup close 21 × 22. | Fixed — `--control-icon: 32px` for icon buttons (collapse, layer info), layer × 24 px, pill × 24 px, text links 24 px hit area, checklist rows 32 px (44 px on phones) with 16 px boxes, popup close 28 px (36 px on coarse pointers), map buttons 36 px on coarse pointers, info glyph 20 px hit area. |
| M9 | Medium | **Horizontal overflow at tablet and phone widths**: the two-column grids collapsed on *viewport* width although the main column is 662 px at 1024 with the panel open; summary tables inherited `white-space: nowrap`; the logo lockup could not shrink; checklist names never truncated (no `min-width: 0`). | Fixed — container queries on `#main` (grids at ≤ 760 px, narrower bar column and tighter cells at ≤ 420 px; viewport fallback kept), summary cells wrap (numbers never), cards shrink and scroll a wide table inside themselves, shrinkable lockup, checklist names truncate with a title. Measured after: `#app` 1024 / 1024 and 390 / 390 px wide. |
| M10 | Medium | **Phone collisions**: selection bar over the basemap button and the accordion toggle, three header rows before the map, 312 px search dropdown under a 362 px input, landscape map taller than the viewport. | Fixed — selection bar wraps within `calc(100vw − 120px)`, icon-only basemap button, the filter toggle shares the tabs row (scrollable), «Neue Datei» moves into the gear menu on phones (the header keeps gear + Herunterladen), the search dropdown spans the width, the flex layout caps the map at `60vh` in landscape. |
| L1 | Low | Table hover (secondary-100) was stronger than the checked state (secondary-50); the summary tables used the same colour for hover and selected. | Fixed — hover `gray-50`, selected keeps secondary-50 + inset bar, same pair in the summary tables. |
| L2 | Low | Icon stragglers: «+/−» text glyphs in the tree tables, MapLibre's «×» popup close and «i» attribution glyph, `.tip-term:hover` turning KPI labels link-red. | Fixed — Lucide chevron (rotates when open), masked × and i, dotted underline on hover; the picker's native file input gets a `.btn`-styled file button. |
| L3 | Low | Zero results left the last map view without a word. | Fixed — «Keine Grundstücke entsprechen den Filtern.» floats over the map while the filtered set is empty. |
| L4 | Low | Search combobox without `aria-activedescendant`; tab panels without `role="tabpanel"`; no visible `h1`. | Fixed — option ids + `aria-activedescendant` / `aria-selected`, tabpanel roles, the dashboard title is the page's `h1` (visually unchanged). |
| L5 | Low | Inverted key/value hierarchy in the info dialogs (values lighter than keys). | Fixed — keys gray-500, values gray-800. |
| L6 | Low | Picker: error text in the neutral status box, 34 px primary button; dialog titles truncated to one line; a `modal-sm` class without a rule; dead `.badge` CSS + `#filter-badge` code. | Fixed — `.b-status.is-error`, 40 px primary, two-line titles, dead rules and code removed. |
| L7 | Low | Map labels used Open Sans while the UI is Noto Sans. | Fixed — `["Noto Sans Regular", "Open Sans Regular"]`. |

### Tokens

`css/tokens.css` gained the missing families and the stylesheet now uses them:

- **Surfaces / text on dark**: `--surface`, `--on-dark`, `--surface-translucent`, `--hover-on-dark` (36 `#fff` literals replaced).
- **Type scale**: `--text-2xs … --text-kpi` (nine literal sizes, 11–25 px, replaced; the role of each step is documented in the file); `--leading-tight / normal / relaxed` for eight literal line-heights.
- **Controls / icons**: `--control-icon` (32), `--control-xs` (28); `--icon-xs … --icon-lg`.
- **Layers**: `--z-scrim`, `--z-drawer`, `--z-skip`, `--z-loading` (six literal z-indexes replaced; the context menu uses `--z-map`).
- **Map colours**: `--parcel`, `--parcel-line`, `--map-active`, `--map-checked`, `--map-label`, `--cluster-1/2/3`, `--swatch-rest`. `dashboard.js` reads them once at boot (`MAP_COLORS`, via `getComputedStyle`; the deliverable inlines the token file, so it works offline) for the parcel, highlight, cluster and label paints, the legends and the detail page's stylesheet — no colour literal is left in the map code.
- **Borders**: `--border-control`, `--border-input` (the header search had a darker border than every other input).
- Removed: `--primary-100`, `--primary-500` (unused); fixed: `var(--federal-blue)` (undefined in the dashboard) and a wrong `--gray-400` fallback.
- Breakpoints stay literal (CSS cannot tokenise media queries); they are named once in the token file (1280 / 900 / 600) and `dashboard.js` mirrors 900 and 600.

### Responsive summary (measured before → after)

| Viewport | Before | After |
|----------|--------|-------|
| 1440 × 960 | fits | fits; accordion ends 100 px above the bottom-left stack |
| 1280 × 720 | header 132 px, Karte scrolls 54 px, accordion under the selection bar | header 71 px, no scroll, map 553 px |
| 1024 × 768 | Karte scrolls 54 px; overview 150 px wider than the viewport | header wraps (125 px) but no scroll, map 547 px; overview 1024 / 1024 px |
| 390 × 844 | drawer 2 671 px tall and unreachable, header 443 px wide, overview 452 px wide, dropdown 312 px | drawer 844 px with an inner scroll, no horizontal overflow, dropdown 362 px, selection bar wraps |
| 844 × 390 | map 420 px in a 203 px slot | map capped at 60 vh |

## Not changed (deliberately)

- The red/slate colour pair for the two selection states stays — it was already distinct; only the words changed.
- `--space-*` tokens are now used where a value matched exactly; the off-grid paddings (7, 9, 11, 14, 18 px) were left rather than snapped, to keep the rendered layout identical.
- The header still wraps to two rows at 1024 px (its content is 1 128 px wide); with the flex layout that no longer costs a page scroll.

## Verification

- `ux_verify.js` (Playwright, 1440 / 1280 / 1024 / 390): page never scrolls on Karte; the drawer is 844 px tall and scrolls inside; a row click marks the parcel with the popup beside it; an empty-map click clears mark, popup and table row; a label click marks the right parcel and opens its popup; Escape clears; the download dialog opens on «Ausgewählt (1)» with the PDF row enabled and the marked parcel named; Escape closes the dialog without clearing the mark; the info dialog traps Tab and makes `#app` inert; the columns menu closes on Escape; the legend reads «Markiert»; tree icons are SVGs; the title is the `h1`; four tab panels carry the role; the phone search dropdown is 362 px wide; no console or page errors.
- Regression: `run.js` (full walkthrough incl. downloads and the offline deliverable), `ovmap_check.js`, `run_gi.js` — all green, zero errors; `npm test` 22 pass.

## Files

| File | Change |
|------|--------|
| `dashboard/css/tokens.css` | New token families (surfaces, type scale, leading, controls, icons, z-index, map colours, borders); two unused tokens removed |
| `dashboard/css/styles.css` | Flex viewport layout, drawer, accordion container, focus rings, targets, contrast, container queries, phone rules, hover states, dialog/picker polish, literals → tokens |
| `dashboard/js/dashboard.js` | Click handler (labels, markers, miss), Escape, `effectiveSel()` in the download dialog, vocabulary, shared dialog helpers, scroll lock, popup anchor and `closeOnClick: false`, `MAP_COLORS` from tokens, detail-page CSS from tokens, empty-state note, combobox ARIA, tabpanel roles, `hidden` instead of inline styles |
| `dashboard/index.html` | `h1` title, «Neue Datei» entry in the gear menu (phones), dead class removed |
| `dashboard/README.md` | Selection vocabulary, phone notes, tokens |

## Addendum (same day, owner follow-ups)

After the review the owner asked for four more changes, implemented on top of the fixes above:

- **M2 superseded**: instead of a popup anchored beside the parcel, the details now live in a fixed **info card** at the top right of the map (left of the control column, on both maps), so it never covers the geometry; the zoom-to-parcel fit keeps the parcel clear of the card (room beside it, below it on narrow maps). The MapLibre popup and its CSS are gone; the card's × closes the card only, an empty-map click or Escape still clears everything.
- The Auswertung map got back its **compact layer widget** (top left): the app's own layers, same state as the Karte accordion, next to the legend.
- The Auswertung sections were **reordered** (Kennzahlen der Auswahl, Flächenverteilung, Karte der Auswahl, Grundstücksliste, Teilportfolio und Region) with compact titles and a one-line note each, and a **table row click** now marks and zooms on that tab's map (scrolled into view below the sticky tabs bar) instead of switching to Karte.
- **Grüninventar** is exported everywhere: always in the Excel table export (as Erfasst / Nicht erfasst, hidden column or not), on every PDF parcel page and in the Datenqualität Abweichungen sheet; GeoJSON already carried the raw property.

Verified with `followup_verify.js` (Playwright, 1440 and 390 px): card at 10 px from the top and 50 px from the right edge of the map on both maps, the marked parcel's screen box outside the card; empty click, × and Escape behave as described; the widget toggles the parcel layer and the accordion checkbox follows; a row click on Auswertung keeps the tab, scrolls the map into view and opens the card there; with the Grüninventar column hidden, the Excel header still carries it and the Datenqualität Abweichungen sheet lists it; no console or page errors.
