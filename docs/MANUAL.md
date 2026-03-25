# Benutzeranleitung / Guide de l'utilisateur / Guida per l'utente / User Guide

## DE — Deutsch

### Was macht diese Anwendung?

Die Anwendung berechnet, wie viel Fläche (m²) jeder **Bodenbedeckungsart** innerhalb einer Schweizer Katasterparzelle liegt. Sie nutzt offizielle Daten der amtlichen Vermessung (geodienste.ch) und swisstopo.

### Kurzanleitung

1. **CSV- oder Excel-Datei hochladen** mit mindestens zwei Spalten: `ID` und `EGRID`.
   Weitere Spalten werden beibehalten und im Export mit dem Präfix `input_` ausgegeben.
2. **Ergebnisse prüfen** — Karte, Tabelle und Zusammenfassung zeigen die Bodenbedeckung pro Parzelle.
3. **Exportieren** — CSV, Excel oder GeoJSON herunterladen.

### Was ist EGRID?

Der **Eidgenössische Grundstücksidentifikator** (z.B. `CH955832730536`) ist die schweizweit eindeutige Parzellen-ID. Sie finden den EGRID im Grundbuch, auf [geo.admin.ch](https://map.geo.admin.ch) oder bei Ihrem Grundbuchamt.

### Klassifikationen

| Kürzel | Bedeutung | Beschreibung |
|--------|-----------|--------------|
| **GGF** | Gebäudegrundfläche | Fläche unter Gebäuden (SIA 416) |
| **BUF** | Umgebungsfläche | Bearbeitete Flächen: Strassen, Wege, Gärten, Landwirtschaft (SIA 416) |
| **UUF** | Naturbelassene Fläche | Wald, Gewässer, Fels, unbearbeitete Flächen (SIA 416) |
| **BF** | Bebaute Fläche | Grundfläche der Gebäude (DIN 277) |
| **UF** | Unbebaute Fläche | Alles ausser Gebäude (DIN 277) |

### Häufige Fragen

**Wohin werden meine Daten gesendet?**
Ihre Datei wird nur lokal im Browser verarbeitet. Einzig der EGRID wird an die swisstopo-API und geodienste.ch gesendet, um Parzellen- und Bodenbedeckungsdaten abzurufen.

**Warum zeigt eine Parzelle 0 m² Bodenbedeckung?**
Mögliche Ursachen: (1) Die Parzelle liegt in einem Kanton, der noch keine Bodenbedeckungsdaten auf geodienste.ch publiziert. (2) Die WFS-Abfrage war vorübergehend nicht verfügbar — prüfen Sie die Spalte `check_wfs` im Export.

**Was bedeutet der Status „Nicht gefunden"?**
Der EGRID konnte in der swisstopo-Datenbank nicht zugeordnet werden. Prüfen Sie, ob der EGRID korrekt und aktuell ist.

**Kann ich mehrere Parzellen gleichzeitig analysieren?**
Ja. Die CSV-Datei kann beliebig viele Zeilen enthalten. Die Verarbeitung erfolgt parallel (max. 5 gleichzeitig).

**Welches Koordinatensystem wird verwendet?**
Die Anzeige erfolgt in WGS 84 (EPSG:4326). Flächenberechnungen basieren auf geodätischen Methoden.

---

## FR — Français

### Que fait cette application ?

L'application calcule la surface (m²) de chaque **type de couverture du sol** à l'intérieur de chaque parcelle cadastrale suisse, à partir des données officielles de la mensuration (geodienste.ch) et de swisstopo.

### Guide rapide

1. **Charger un fichier CSV ou Excel** contenant au minimum deux colonnes : `ID` et `EGRID`.
   Les colonnes supplémentaires sont conservées et exportées avec le préfixe `input_`.
2. **Consulter les résultats** — carte, tableau et résumé affichent la couverture du sol par parcelle.
3. **Exporter** — télécharger en CSV, Excel ou GeoJSON.

### Qu'est-ce que l'EGRID ?

L'**identifiant fédéral de bien-fonds** (p. ex. `CH955832730536`) est l'identifiant unique de chaque parcelle en Suisse. Vous le trouverez au registre foncier, sur [geo.admin.ch](https://map.geo.admin.ch) ou auprès de votre office du registre foncier.

### Classifications

| Abrév. | Signification | Description |
|--------|---------------|-------------|
| **GGF** | Surface de bâtiment | Emprise au sol des bâtiments (SIA 416) |
| **BUF** | Surface aménagée | Routes, chemins, jardins, agriculture (SIA 416) |
| **UUF** | Surface naturelle | Forêt, cours d'eau, rochers (SIA 416) |
| **BF** | Surface bâtie | Emprise des bâtiments (DIN 277) |
| **UF** | Surface non bâtie | Tout sauf les bâtiments (DIN 277) |

### Questions fréquentes

**Où vont mes données ?**
Votre fichier est traité uniquement dans le navigateur. Seul l'EGRID est transmis à l'API swisstopo et à geodienste.ch pour récupérer les données de parcelle et de couverture du sol.

**Pourquoi une parcelle affiche-t-elle 0 m² ?**
Causes possibles : (1) Le canton n'a pas encore publié les données de couverture du sol sur geodienste.ch. (2) Le service WFS était temporairement indisponible — vérifiez la colonne `check_wfs` dans l'export.

**Que signifie le statut « Non trouvé » ?**
L'EGRID n'a pas pu être trouvé dans la base swisstopo. Vérifiez qu'il est correct et à jour.

**Puis-je analyser plusieurs parcelles en même temps ?**
Oui. Le fichier CSV peut contenir autant de lignes que nécessaire. Le traitement s'effectue en parallèle (max. 5 simultanément).

---

## IT — Italiano

### Cosa fa questa applicazione?

L'applicazione calcola la superficie (m²) di ciascun **tipo di copertura del suolo** all'interno di ogni particella catastale svizzera, utilizzando i dati ufficiali della misurazione (geodienste.ch) e di swisstopo.

### Guida rapida

1. **Caricare un file CSV o Excel** con almeno due colonne: `ID` ed `EGRID`.
   Le colonne aggiuntive vengono conservate ed esportate con il prefisso `input_`.
2. **Consultare i risultati** — carta, tabella e riepilogo mostrano la copertura del suolo per particella.
3. **Esportare** — scaricare in CSV, Excel o GeoJSON.

### Cos'è l'EGRID?

L'**identificatore federale dei fondi** (ad es. `CH955832730536`) è l'identificativo unico di ogni particella in Svizzera. Si trova nel registro fondiario, su [geo.admin.ch](https://map.geo.admin.ch) o presso l'ufficio del registro fondiario.

### Classificazioni

| Sigla | Significato | Descrizione |
|-------|-------------|-------------|
| **GGF** | Superficie edificata | Superficie coperta dagli edifici (SIA 416) |
| **BUF** | Superficie sistemata | Strade, sentieri, giardini, agricoltura (SIA 416) |
| **UUF** | Superficie naturale | Bosco, corsi d'acqua, roccia (SIA 416) |
| **BF** | Superficie costruita | Impronta degli edifici (DIN 277) |
| **UF** | Superficie non costruita | Tutto tranne gli edifici (DIN 277) |

### Domande frequenti

**Dove finiscono i miei dati?**
Il file viene elaborato unicamente nel browser. Solo l'EGRID viene trasmesso all'API swisstopo e a geodienste.ch per ottenere i dati della particella e della copertura del suolo.

**Perché una particella mostra 0 m²?**
Possibili cause: (1) Il cantone non ha ancora pubblicato i dati di copertura del suolo su geodienste.ch. (2) Il servizio WFS era temporaneamente non disponibile — verificare la colonna `check_wfs` nell'export.

**Cosa significa lo stato «Non trovato»?**
L'EGRID non è stato trovato nella banca dati swisstopo. Verificare che sia corretto e aggiornato.

---

## EN — English

### What does this application do?

The application calculates the area (m²) of each **land cover type** within each Swiss cadastral parcel, using official surveying data from geodienste.ch and swisstopo.

### Quick start

1. **Upload a CSV or Excel file** with at least two columns: `ID` and `EGRID`.
   Additional columns are preserved and exported with the prefix `input_`.
2. **Review results** — map, table, and summary show land cover per parcel.
3. **Export** — download as CSV, Excel, or GeoJSON.

### What is EGRID?

The **Federal Property Identifier** (e.g. `CH955832730536`) is the unique ID for every parcel in Switzerland. You can find it in the land register, on [geo.admin.ch](https://map.geo.admin.ch), or from your local land registry office.

### Classifications

| Code | Meaning | Description |
|------|---------|-------------|
| **GGF** | Building footprint | Area covered by buildings (SIA 416) |
| **BUF** | Surroundings | Roads, paths, gardens, agriculture (SIA 416) |
| **UUF** | Natural areas | Forest, water bodies, rock (SIA 416) |
| **BF** | Built-up area | Building footprint (DIN 277) |
| **UF** | Unbuilt area | Everything except buildings (DIN 277) |

### FAQ

**Where does my data go?**
Your file is processed entirely in the browser. Only the EGRID is sent to the swisstopo API and geodienste.ch to retrieve parcel and land cover data.

**Why does a parcel show 0 m² land cover?**
Possible causes: (1) The canton has not yet published land cover data on geodienste.ch. (2) The WFS service was temporarily unavailable — check the `check_wfs` column in the export.

**What does the status "Not found" mean?**
The EGRID could not be matched in the swisstopo database. Verify that it is correct and up to date.

**Can I analyze multiple parcels at once?**
Yes. The CSV file can contain any number of rows. Processing runs in parallel (max. 5 at a time).

**What coordinate system is used?**
Display uses WGS 84 (EPSG:4326). Area calculations use geodesic methods.

---

## Datenquellen / Sources de données / Fonti dati / Data sources

| Daten | Quelle | URL |
|-------|--------|-----|
| Parzellen | swisstopo Cadastralwebmap | api3.geo.admin.ch |
| Bodenbedeckung | Amtliche Vermessung (WFS) | geodienste.ch |
