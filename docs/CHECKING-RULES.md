# Data-Quality Checks (Datenqualität)

The dashboard's **Datenqualität** tab runs per-parcel checks over the **current filtered
selection**. The **Prüfregeln** table reports each rule as **`<did not pass> von <filtered
total> abweichend`** — the count that failed, out of every parcel in the selection.
A rule that only applies to a subset (e.g. land-cover balance needs land cover) simply
can't fail on the parcels it doesn't apply to; those count as neither pass nor deviation.
**Auffällige Grundstücke** lists every parcel that failed **at least one** rule, with the
check name(s) it did not pass.

- **Source:** [`dashboard/js/dashboard.js`](../dashboard/js/dashboard.js) → `RULE_DEFS` + `computeRules()`.
- **Area tolerance** (all balance checks): **±1 % of the parcel area, minimum ±1 m²**
  (`tol = max(1, area × 0.01)`).
- **Scope:** the filtered selection (same set as the Übersicht). Underlying-area
  classification is in [CLASSIFICATION.md](CLASSIFICATION.md); columns in
  [DATAMODEL.md](DATAMODEL.md).

## Rules

| Rule (UI) | Category | Checks | Evaluated on | Passes when |
|-----------|----------|--------|--------------|-------------|
| **Grundstück im Kataster gefunden** | Completeness | E-GRID resolved to a geometry during processing | **all** parcels | `check_egrid` ∈ {`found`, `merged`} |
| **Geometrie vorhanden** | Completeness | The entry carries a non-null polygon geometry | **all** parcels | `geometry` ≠ null |
| **Fläche vorhanden** | Completeness | `parcel_area_m2` is a real positive number | **all** parcels | area is finite and > 0 |
| **E-GRID eindeutig** *(Hinweis)* | Integrity | No E-GRID appears on more than one entry | parcels with a non-empty E-GRID | E-GRID occurs once **in the selection** |
| **Bodenbedeckung vollständig (Fläche)** | Area balance | Σ classified land cover (GGF + BUF + UUF) equals the parcel area | parcels **with** land cover | \|Σ − area\| ≤ tol |
| **Bauzonen vollständig (Fläche)** | Area balance | Σ Bauzonen incl. „Ohne Bauzone" equals the parcel area | parcels with Bauzonen data | \|Σ − area\| ≤ tol |
| **Lebensräume vollständig (Fläche)** | Area balance | Σ BAFU-Lebensräume equals the parcel area | parcels with Lebensraum data | \|Σ − area\| ≤ tol |
| **Bauzonen-Abruf vollständig** | Fetch | Bauzonen fetch returned complete data (not truncated/partial) | parcels with a Bauzonen check | `check_bauzonen` = `ok` |
| **Lebensraum-Abruf vollständig** | Fetch | Lebensraum fetch returned complete data; estimated (gap-filled) reported separately | parcels with a Lebensraum check | `check_habitat` = `ok` (`estimated` → pass, counted apart) |

> The three **Area-balance** rules are the "land cover / BAFU polygons sum to the parcel
> area" check — they validate the export's per-parcel area sums (`sia416_*`, `bauzonen_*`,
> `habitat_*`) against `parcel_area_m2`, not the raw overlay geometries.

## Notes

- **Geometrie / Fläche vorhanden** make the "every entry has a geometry and an area"
  guarantee explicit. They catch a *found* parcel that still lacks a polygon or area
  (e.g. an SDR entry with an E-GRID but no geometry) — which "im Kataster gefunden" passes
  but shouldn't be treated as complete.
- **E-GRID eindeutig** is judged **over the filtered selection** (consistent with every
  other rule): an E-GRID that appears twice in the current selection fails both entries.
  Empty E-GRIDs (not-found / invalid) are excluded from the check.
- `check_egrid = merged` means duplicate **source geometries** were dissolved into one
  output row — expected, stays a pass. It is *not* the same as two output rows sharing an
  E-GRID, which is what **E-GRID eindeutig** catches.

## Reading the numbers

`⚠ 1 von 1102 abweichend` on **Bodenbedeckung vollständig (Fläche)** with 1102 filtered
parcels means: **1** parcel has land cover that doesn't balance to its area. The parcels
with *no* land cover (not-found, cantons without WFS coverage, high-alpine "übriges
Gebiet") aren't deviations — they simply don't apply to this rule — and the top KPI
**Ohne Bodenbedeckung** counts them separately.

**KPIs** (top of the tab): *Grundstücke* (Auswahl / Alle), *E-GRID nicht gefunden*,
*Ohne Bodenbedeckung*, *Ohne Lebensräume* — all over the current filtered selection.
