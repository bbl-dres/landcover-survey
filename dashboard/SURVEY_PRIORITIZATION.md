# Field-Survey Prioritisation — Top 100 Parcels for naturundwirtschaft.ch

**Goal.** Triage the federal parcel portfolio down to the **top 100 candidates to
send a [Natur & Wirtschaft](https://www.naturundwirtschaft.ch/de/zertifizieren/)
expert for an on-site inspection/survey.** This is a *where-do-we-send-the-expert*
ranking — **not** a prediction of certification.

> Status: **strategy / analysis** for the sustainability department. Internal
> (the `dashboard/` folder is git-ignored). No scoring code is built yet.

---

## 1. What we have vs. what the expert determines

| We **have** (objective, measured) | We **don't** have (the expert's on-site job) |
|---|---|
| Land cover per parcel — building, sealed, green, water, wooded… (m²) | Whether the green areas are **naturnah** (native species, extensive management, structures) |
| SIA 416 Umgebungsfläche `UF = BUF + UUF` (= parcel − building footprint) | Whether the site meets N&W's **≥ 30 % naturnah** threshold |
| Size, ownership (`input_eigent.art`), location, geometry | Habitat condition, neophytes, biodiversity quality on the ground |
| (via spatial joins) building zone, protected-area proximity, BAFU habitat | |

**Consequence for the method:** we **do not compute or report a "naturnah" figure**.
N&W's ≥30 %-of-Umgebungsfläche criterion is decided at the audit — that's *why* we
send an expert. We rank by **where a survey is most worthwhile**, using observable
land cover + ownership + location only.

---

## 2. What the data shows (current export, federal subset)

From the latest export (1544 found parcels), ownership code **`1` = federal → 1127
parcels**. The triage funnel:

| Stage | Count |
|---|---|
| Federal parcels (`input_eigent.art = 1`) | 1127 |
| …with Umgebungsfläche (UF > 0) | 926 |
| …with UF ≥ 1000 m² | 593 |
| …green land cover ≥ 30 % of UF *(observed, not "naturnah")* | 740 |
| …green 15–30 % of UF | 41 |
| …green < 15 % of UF | 145 |

> The "green ≥ 30 %" line is large (~80 %) because raw green land cover (mown lawn,
> arable, …) is **not** the same as *naturnah* — which is the whole point of the
> reframe. So green share is just **one observable signal**, never a pass/fail. The
> ranking and the portfolio mix do the real selection.
>
> ⚠ The current export was produced **without** `--bauzonen` / `--habitat` and before
> `lc_source` — so the spatial signals below need a re-run (see §5).

---

## 3. Method — gates → segment → score → select

```
1127 federal ──▶ 1. GATES ──▶ 2. SEGMENT ──▶ 3. SCORE ──▶ 4. SELECT top 100
                 (eligibility)  (archetypes)   (weighted)   (+ portfolio caps)
```

### Step 1 — Eligibility gates (hard filters)

| Gate | Rule |
|------|------|
| **Federal ownership** | `input_eigent.art = 1` (confirm) |
| **Real parcel** | exclude SAP pseudo-parcels (`ABGA*` / `LÖVM*` / `PP`) |
| **Has surroundings to survey** | `UF = BUF+UUF ≥` threshold (proposal **1000 m²**) — no Umgebung, nothing for the expert to assess |
| **In / near Siedlungsraum** | parcel intersects a **building zone** (`ch.are.bauzonen`), or ≥ X % inside one — N&W is about *developed* grounds, not remote forest/farmland |

### Step 2 — Segmentation (observable, for a balanced portfolio)

Bucket by **green-surroundings share** (raw land cover, *not* naturnah) and built
character, so the 100 is a deliberate mix, not 100 look-alikes:

| Segment | Definition | Survey rationale |
|---------|------------|------------------|
| **Green-rich grounds** | high green share of UF, has buildings | substantial existing green to assess — likely strong candidates |
| **Mixed grounds** | moderate green share | typical company/institutional Areal; clear upside |
| **Sealed but sizeable** | low green share, large UF, dense zone | de-sealing / greening flagships (biodiversity + heat + water) |
| *(excluded)* **rural / open land** | mostly outside Bauzone, ~no buildings | not an N&W "Areal" — drops out at the Siedlungsraum gate |

Cross-cut with **building-zone type** (Arbeits- / öffentliche / Wohn-/Zentrumszone →
N&W track) and **canton/region** for geographic spread.

### Step 3 — Survey-priority score (observable signals only)

Each parcel gets 0–1 sub-scores, combined as `Score = Σ wᵢ · subscoreᵢ`. Default
weights tunable:

| # | Signal (all observable) | Source | Weight |
|---|--------------------------|--------|:------:|
| 1 | **Green surroundings** — green land cover in UF (share + absolute m²) | `GreenSpace_m2`, `BUF/UUF` | **0.25** |
| 2 | **Ecological context** — proximity/adjacency to protected areas & networks (Auen, TWW, Amphibien, Moore, wildlife corridors, ÖREB) | spatial join (Bundesinventare) | **0.20** |
| 3 | **Scale** — UF / parcel size (log-scaled) | `parcel_area_m2`, UF | **0.15** |
| 4 | **Urban relevance** — building-zone type + centrality (N&W fit + visibility) | `ch.are.bauzonen` | **0.15** |
| 5 | **Habitat quality** — habitats on/around the parcel | BAFU Lebensraumkarte | **0.10** |
| 6 | **Structural diversity** — number of distinct land-cover / habitat types | per-`Art` columns | **0.05** |
| 7 | **Feasibility / data confidence** — authoritative AV cover, accessibility | `lc_source`, QA cols | **0.10** |

> No "readiness vs 30 %" term — that would be claiming naturnah. Green surroundings
> (#1) only says *there is vegetation worth an expert's time*, not that it qualifies.

### Step 4 — Selection with portfolio guardrails

Rank by composite, take top 100, then enforce a **balanced portfolio**: segment
quotas (e.g. green-rich / mixed / a few de-sealing flagships), max-per-canton/city
caps, and zone-type spread — so expert visits cover the range of situations and the
country, not one agglomeration. Output: ranked top-100 with EGRID, Ort/Kanton,
segment, the observable metrics, each sub-score, and the composite.

---

## 4. The Bauzonen intersection (the department's suggestion) — its concrete role

Intersecting parcels with `ch.are.bauzonen` (we already have `bauzonen.py`, exposing
zone category `ch_code_hn` + name) gives three usable things:

1. **Share of the parcel inside a building zone** → the clean **Siedlungsraum gate**
   (Step 1) — more precise than a distance buffer.
2. **Zone type** (Wohn- / Arbeits- / öffentliche / Zentrumszone) → **N&W category
   routing** (Unternehmen / Wohnen / Schule / öffentlich) and the urban-relevance
   score (#4).
3. **The remainder outside any Bauzone** = **Nichtbauzone** (agriculture/forest) →
   identifies rural parcels that should drop out.

> `ch.are.bauzonen` covers *building zones* only; "outside any Bauzone" is inferred
> Nichtbauzone. For explicit use types we can also lean on `input_nuart1/nuart2`
> (Nutzungsart) already in the export — a cheaper route to N&W category.

---

## 5. Data prerequisite (you chose "spatial signals first")

The current export lacks the spatial columns, so before ranking:
- **Re-export with `--bauzonen`** (zone membership + type) and **`--habitat`** (BAFU).
- **Add protected-area / inventory layers** as `LayerConfig`s (Bundesinventare, ÖREB,
  wildlife corridors) for the ecological-context score (#2).
- Geometry is already in the source geojson, so distance/adjacency joins are feasible.

---

## 6. Open decisions remaining

1. **Federal-ownership code** — confirm `input_eigent.art = 1` is federal (and what 3 / 5 are).
2. **Min UF threshold** (proposal 1000 m²) and **Siedlungsraum rule** (intersects vs ≥X% inside a Bauzone).
3. **Portfolio quotas** — segment mix and per-canton/city caps for the top 100.
4. **Datasets** — which protected-area / inventory layers to include in #2.
5. **Unit** — rank per parcel now, group contiguous federal parcels into *Areale* as a fast-follow? (N&W certifies the *site*, which may span several parcels.)

---

## 7. Next step (when you're ready — not yet)

A read-only Python scorer over the parcels **geojson**: gates → spatial joins →
observable sub-scores → composite → segment → top-100 with portfolio caps → ranked
CSV/geojson (+ `survey_priority` rank, `survey_segment`). Weights/thresholds in a
small config block so the department can re-rank without code changes; results can
also feed a "Survey priority" view in this dashboard.
