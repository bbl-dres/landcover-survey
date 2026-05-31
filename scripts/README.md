# Scripts

Standalone utility scripts (not part of the web app or the main Python CLI).
Standard library only — no dependencies.

## join_sap_measurements.py

Left-joins a SAP parcel export with a SAP measurement export into one CSV of
parcels (sites) and their plot area (GSF Grundstückfläche) in m².

Both inputs are SAP "Dynamische Listenausgabe" text reports: UTF-8 (with BOM),
pipe-delimited tables (`|col|col|`) whose column header is on row 11 and repeats
on every page break, interleaved with `---` separators and page-header noise.

- **Parcels** — columns `BuKr | WE | Grundstk | Bez. Grundstück | … | Ort | PLZ | E-GRID | …`
- **Measurements** — columns `Ident. AO | BezAOTyp | Nummer AO | … | Bem.Art Mitt | Größe | Einh | …`

**Filter (measurements):** `BezAOTyp = Grundstück` (the parcel total — *not* the
`Grundstücksfläche` sub-areas such as parking) **and** `Bem.Art Mitt = GSF
Grundstückfläche`; the area is the `Größe` column. Numbers are US-formatted
(`1,300.7060` = comma thousands, dot decimal) and parsed to a plain number.

**Join:** the measurement `Ident. AO` is `WE.Grundstk` (e.g. `1502.3`). It has no
BuKr, so the canonical key `BuKr/WE/Grundstk` (e.g. `1086/1502/3`) is built from
the parcel file (BuKr is present there, always `1086` in this export). Parcels
join to measurements on `WE.Grundstk`.

It is a **left join**: every parcel is kept; parcels without a parcel-level GSF
measurement get an empty `GSF_m2`. The run logs coverage (with/without area) and
warns about any measurement whose parcel is missing from the parcel export.

**Output:** every column from the parcel export, carried through unchanged, with
`ObjektKey` (`BuKr/WE/Grundstk`) prepended and `GSF_m2` appended. CSV, UTF-8 with
BOM, `;` delimiter (opens cleanly in German/Swiss Excel on double-click). Use
`--delimiter ,` to change the separator, or `--sep-line` to prepend an Excel
`sep=;` hint line if your Excel locale uses a different separator.

### Usage

```bash
# Uses the default file paths baked into the script
python join_sap_measurements.py

# Explicit paths; only output parcels that have a measurement; comma delimiter
python join_sap_measurements.py --parcels P.txt --measurements B.txt \
    --output out.csv --only-matched --delimiter ,
```

Run `python join_sap_measurements.py --help` for all options.
