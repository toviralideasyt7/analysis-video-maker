# Direct-download data sources

Goal: turn a topic into a data table with **no browser, no scraping-by-eye and no
AI in the loop**. Discovery is a search endpoint; the data is a plain CSV/JSON
download. The AI is reserved for narration and for pages that genuinely need
reading.

Probe all sources at once:

```bash
npx tsx tools/sources/cli.ts probe
```

Code lives in `tools/sources/`. Every module is dependency-free (`fetch` only).

---

## 1. Our World in Data - discovery + direct CSV

| Step | Endpoint | Verified |
| --- | --- | --- |
| Discover | `GET https://ourworldindata.org/api/search?q=<query>` | 200, JSON, 20 hits |
| Download | `GET https://ourworldindata.org/grapher/<slug>.csv` | 200, `Entity,Code,Year,<value>` |
| Metadata | `GET https://ourworldindata.org/grapher/<slug>.metadata.json` | 200, unit/timespan/citation |
| Deep metadata | `GET https://api.ourworldindata.org/v1/indicators/<id>.metadata.json` | link inside the metadata file |

Notes:

- Search returns `results[].slug` plus `availableEntities`, so a topic maps to a
  download URL without guessing slugs.
- `type` is `chart`, `explorerView`, `dataset` or `article`; only `chart` has a
  grapher CSV.
- Slugs are sometimes redirected (`co2-emissions-per-capita` ->
  `co-emissions-per-capita`), so always use the slug returned by search.
- Country codes in the `Code` column are ISO3 (`IND`, `USA`); aggregates are
  coded `OWID_*` (`OWID_WRL` = World) and must be excluded from a country race.
- The table-URL form the site shows
  (`/grapher/<slug>?tab=table&country=...&source=...`) is a *view* of the same
  data; the `.csv` path is the machine-readable equivalent and needs no query
  string.

```bash
npx tsx tools/sources/cli.ts owid "co2 emissions"
npx tsx tools/sources/cli.ts owid-slug annual-co2-emissions-per-country
```

## 2. data-races.com - prebuilt race tapes + image scraping

| Step | Endpoint | Verified |
| --- | --- | --- |
| Catalog | `GET https://data-races.com/sitemap-0.xml` | 200, 9,632 URLs, 375 `/en/datasets/<slug>/` |
| Resolve | `GET https://data-races.com/en/datasets/<slug>/` then read the `/data/**/*.json` link | 200 |
| Download | `GET https://data-races.com/data/<category>/<slug>.json` | 200, 1.9 MB tape |
| Images | scrape `<img src>`, `srcset`, `og:image` from any page | works via `extractImageUrls()` |

The JSON is already a race tape:

```json
{"version":1,
 "schema":["entity_id","group_id","value","rank","group_rank","pop_change","rank_change","group_rank_change"],
 "periodUnit":"year",
 "data":{"1990":[["CHN","EAST_ASIA",...,1,1], ...]}}
```

Country flags on that site come from the public **circle-flags** set, which is a
direct, high-quality asset source for our own videos:

```
https://hatscripts.github.io/circle-flags/flags/<iso2>.svg
```

```bash
npx tsx tools/sources/cli.ts dataraces
npx tsx tools/sources/cli.ts dataraces-slug global-co2
npx tsx tools/sources/cli.ts dataraces-images https://data-races.com/en/datasets/global-co2/
```

`global-co2` covers 1990-2022 in 33 yearly periods (World Bank source).

## 3. Kaggle - search + file download

| Step | Endpoint | Verified |
| --- | --- | --- |
| Search | `GET https://www.kaggle.com/api/v1/datasets/list?search=<q>&pageSize=<n>` | 200, JSON |
| Metadata | `GET https://www.kaggle.com/api/v1/datasets/view/<owner>/<slug>` | 200 |
| File list | `GET https://www.kaggle.com/api/v1/datasets/list/<owner>/<slug>` | 200, `{datasetFiles:[...]}` |
| File download | `GET https://www.kaggle.com/api/v1/datasets/download/<owner>/<slug>/<fileName>` | 200 CSV (302 first, follow redirects) |

Two traps, both handled in `kaggle.ts`:

1. **A browser User-Agent gets an HTML reCAPTCHA page with HTTP 200.** Send a
   tool UA (`curl/8.9.1`, `TOOL_UA`).
2. Dataset metadata is at `/datasets/view/<ref>` but the *file list* is at
   `/datasets/list/<ref>`. Mixing them up returns an empty file array.

```bash
npx tsx tools/sources/cli.ts kaggle "co2 emissions"
```

Credentials: `KAGGLE_USERNAME` / `KAGGLE_KEY`. A masked value (`...`, `***`) is
detected and skipped rather than sent.

## 4. World Bank Data Catalog (DDH) OpenAPI - reverse-engineered

Docs UI `https://ddh-openapi.worldbank.org/docs/index.html` loads a Swagger UI
whose spec URL is embedded in the page:

```
https://ddh-openapi.worldbank.org/docs/2.0/document.json
```

Endpoints (all GET, no auth):

| Purpose | Endpoint |
| --- | --- |
| Search catalog | `/search?qname=dataset|resource&param=<query>&top=&skip=` |
| List catalog | `/datasets?top=&skip=` |
| Dataset metadata | `/datasets/<dataset_unique_id>` |
| Resource rows | `/resources/<resource_unique_id>/data?top=&skip=&select=&filter=` |
| Resource download | `/resources/<resource_unique_id>/download` (404 for most; use `url`) |

The practical win: `/datasets/<id>` returns `resources[]` where each EXCEL/ZIP/CSV
entry carries a **direct download url** on `datacatalogfiles.worldbank.org`. No
extra hop, no auth.

```bash
npx tsx tools/sources/cli.ts wb "CO2 emissions"
npx tsx tools/sources/cli.ts wb-dataset 0037712
```

Example: World Development Indicators (`0037712`) exposes
`WDI_CSV_2026_07_15.zip` and `WDI_excel_2026_07_15.zip` as direct urls.

## 5. Google Dataset Search - discovery only, no API

`https://datasetsearch.research.google.com/?q=<query>` is a JavaScript
application with no public JSON API; a plain fetch returns the app shell, not
results. Treat it as a **human** discovery layer. For automated discovery use
the OWID search API, the data-races catalog and the World Bank `/search`
endpoint above, which all return JSON.

## 6. Country codes, flags and groups

`tools/sources/regions.ts` holds an ISO3 -> ISO2 + World Bank region table for
217 countries, generated from `https://api.worldbank.org/v2/country?format=json&per_page=400`
with aggregates removed. It gives every entity a flag and a group with no AI
call.

```bash
npx tsx tools/sources/cli.ts flag IND
```

## Probe results (2026-09-21)

```
SOURCE            STATUS
owid search       OK  hits=20 first=co-emissions-per-capita
owid metadata     OK  title=Annual CO2 emissions
data-races        OK  datasets=375 first=australia-state-gdp
data-races json   OK  periods=33 unit=year
kaggle            OK  hits=20 first=ulrikthygepedersen/co2-emissions-by-country
worldbank search  OK  count=41 first=0064545
circle-flags      OK  bytes=475 url=https://hatscripts.github.io/circle-flags/flags/in.svg
```