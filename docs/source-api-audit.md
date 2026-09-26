# Data Source API Audit

Audit of 17 approved research sources for the automated research pipeline.
Probed 2026-09-26 via curl (no live-browser inspection available to the auditor).
Precision on URL patterns is the priority; all patterns below were HTTP-tested
unless marked "not verified".

Legend — Verdict: **yes** = fully usable unauthenticated in an automated
pipeline · **partial** = usable with caveats · **no** = not usable.

---

### 1. data-races.com — https://data-races.com/en/
- Search API: none (client-side only) | tested: `https://data-races.com/en/datasets/` → HTTP 200, page embeds ~375 dataset cards (`data-id` attributes) filtered by in-page JS; no `<form>`, no XHR endpoint in HTML
- Download: `https://data-races.com/data/{category}/{slug}.json` | tested: `https://data-races.com/data/economy/global-gdp.json` → HTTP 200, 669KB, `{"version":1,"schema":["entity_id","group_id","value","rank",...],"periodUnit":"year","data":{"1960":[...]}}`; dataset page URL pattern `/en/datasets/{slug}/`; discovery = scrape `/en/datasets/` for `data-id` slugs; category segment discoverable from the dataset page's JSON-LD `contentUrl`
- Auth: no
- Quirks: JSON only (no CSV/ZIP links found)
- Verdict: **partial** (downloads usable unauthenticated; no server-side search — scrape the list page)

### 2. Google Dataset Search — https://datasetsearch.research.google.com/
- Search API: none public | tested: `https://datasetsearch.research.google.com/search?query=test` → HTTP 200, 417KB JS app shell with zero embedded result JSON — results load via internal JS RPC only; `/robots.txt` → 404 (no file, not a block)
- Download: n/a
- Auth: n/a
- Quirks: JS-heavy, no documented or discoverable public search API
- Verdict: **no** (not usable unauthenticated in an automated pipeline)

### 3. Kaggle — https://www.kaggle.com/datasets
- Search API: `https://www.kaggle.com/api/v1/datasets/list?search={q}&page={n}` | tested: `...?search=car-production&page=1&pageSize=3` → HTTP 200, JSON array of dataset objects (`ref`, `title`, `totalBytesNullable`, `urlNullable`); 20 results returned, `pageSize` appeared ignored
- Download: `https://www.kaggle.com/api/v1/datasets/download/{owner}/{dataset}` | tested: `.../download/zynicide/wine-reviews` → HTTP 200, 53MB zip (PK header, contains `winemag-data-130k-v2.csv`) — downloaded WITHOUT auth
- Auth: no — contrary to expectation, both list and download worked unauthenticated in this probe (official docs still state a Kaggle API token username+key is required; unauthenticated access may be rate-limited or IP-dependent)
- Quirks: public API historically 401/403 without token; observed open access today — treat as fragile, keep token-based auth as the planned path
- Verdict: **partial** (works unauthenticated in this test, but not contractually guaranteed; have token auth ready)

### 4. Our World in Data — https://ourworldindata.org/
- Search API: none public/unauthenticated | tested: `https://ourworldindata.org/search?q=test` → HTTP 200 HTML search page, zero server-rendered results (JS-driven, no Algolia keys in page); `https://ourworldindata.org/grapher/search.json?q=life` → HTTP 404; `https://catalog.ourworldindata.org/` and `/garden` → HTTP 404
- Download: `https://ourworldindata.org/grapher/{slug}.csv` | tested: slug=`life-expectancy` → HTTP 200, 605KB CSV, header `Entity,Code,Year,Life expectancy`
- Auth: no
- Quirks: no slug-discovery API found; slugs must be discovered elsewhere (site links, OWID GitHub baker repo, or search-page scraping)
- Verdict: **partial** (CSV downloads fully usable; no usable search/discovery API)

### 5. World Bank Data Catalog — https://datacatalog.worldbank.org/
- Search API: `https://datacatalogapi.worldbank.org/ddhxext/v3/search` (base found in frontend `_app` chunk; spec at `https://ddh-openapi.worldbank.org/docs/2.0/document.json` lists `/search` with `qname`/`param`/`filter`/`top`/`skip`) | tested: `/ddhxext/v3/search?search=gdp` → HTTP 200, `{"count":7968,"data":[{"dataset_id":...,"dataset_unique_id":"0037715","name":"IBRD Statement Of Loans and Guarantees..."}]}` — BUT query params are ignored (`search=test`, `search=gdp`, `q=`, `keyword=` all return count=7968): it returns the unfiltered full catalog
- Download: dataset detail + file endpoints per OpenAPI spec (`/datasets/{dataset_unique_id}`, `/resources/{resource_unique_id}/download`) — not verified (untested)
- Auth: no for the above; the site's true keyword search goes through Azure Cognitive Search (`https://itsdt-ddhext-search-prd.search.windows.net/indexes/ddh-dataset-v2/docs?api-version=2020-06-30`) which → HTTP 403 without the runtime-fetched `AzureSearchApiKey`
- Quirks: `/search` is effectively a full-catalog dump (paginate client-side; ~1MB response); real filtered search requires the Azure key the frontend fetches at runtime
- Verdict: **partial** (unauthenticated full-catalog listing works; keyword search not usable without the Azure key)
- Note: the World Bank *indicator* API (`https://api.worldbank.org/v2/indicator?format=json&per_page=20000`) is separate and fully open, but has no motor-vehicle-PRODUCTION indicator (only `IS.VEH.NVEH.P3` = vehicles per 1,000 people, i.e. ownership, not production)

### 6. Feed Me Data — https://feedmedata.ai/datasets
- Search API: none | tested: page fetch → HTTP 200, title "Dataset Guide — Where to Find Public Data, Portals & APIs"; it is a SvelteKit content/guide site (chapters like `/datasets/nyc` = "The NYC Chapter"), not a data catalog — no list/search JSON endpoint, no embedded dataset data
- Download: n/a (links point to third-party portals/APIs, not hosted data)
- Auth: no
- Quirks: useful as a human-readable directory of data sources, not a machine source
- Verdict: **no** (not a data source; no API, no downloads)

### 7. visdatasets — https://visdatasets.github.io/
- Search API: none (static site, no index API) | tested: `https://visdatasets.github.io/datasets.json` → HTTP 404
- Download: `https://visdatasets.github.io/datasets/<name>.csv` (in-repo) or raw `https://raw.githubusercontent.com/visdatasets/visdatasets.github.io/master/datasets/<name>.csv` | tested: `https://visdatasets.github.io/datasets/mobile_os_market_share.csv` → HTTP 200, CSV header `Year,OperatingSystem,Share` + rows; raw.githubusercontent.com pattern also verified HTTP 200
- Auth: no — GitHub repo `visdatasets/visdatasets.github.io` (public, default branch `master`, confirmed via GitHub API)
- Quirks: no central JSON index (no JSON URLs on the site — only CSVs, one per dataset, 26 datasets); filenames must be scraped from the HTML
- Verdict: **yes** — static CSV downloads, no auth; only limitation is no machine-readable dataset catalog

### 8. Data Commons — https://datacommons.org/
- Search API: `https://api.datacommons.org/v2/{observation,node,resolve}?key=...` per `https://docs.datacommons.org/api/rest/v2` (current v2 base confirmed in docs: `https://api.datacommons.org/v2/node`; old v0 `/stat/series` → HTTP 410 deprecated) | tested: `https://api.datacommons.org/v2/observation?entity=country/USA&select=date&select=value&variable=Count_Person` → HTTP 401, `UNAUTHENTICATED: Method doesn't allow unregistered callers... Visit apikeys.datacommons.org`
- Download: same v2 endpoints (JSON) | tested: same URL → HTTP 401
- Auth: **yes** — API key required on `api.datacommons.org` (`?key=` for GET, `X-API-Key` header for POST); custom instances use `<CUSTOM_URL>/core/api/v2/` and need NO key
- Quirks: docs ship a quota-limited public trial key (not used); v2 GET uses dotted params like `entity.dcids=[...]`, `select=[...]`, `variable.dcids=[...]`; responses paginated via `nextToken`. UNSD-hosted custom instance `https://unsd-datacommons.gcp.un-icc.cloud/core/api/v2/observation` → HTTP 200 unauthenticated (JSON `{"byVariable":...}`) — usable without key but carries UN/SDG stat-vars only (main-instance DCIDs don't all exist there)
- Verdict: **partial** — main instance needs an API key; UNSD custom instance works unauthenticated for SDG stat-vars

### 9. UNdata — https://data.un.org/
- Search API: none found — homepage is a React SPA shell (HTTP 200, JS bundles only); old `Handlers/DownloadHandler.ashx` pattern is dead (no params → returns SPA HTML; with old query params → 404) | tested: `https://data.un.org/Handlers/DownloadHandler.ashx` → HTTP 200, HTML + GTM script, no data
- Download: none on data.un.org itself; the SPA's data backend is the UNSD Data Commons instance (homepage HTML references `https://unsd-datacommons.gcp.un-icc.cloud/datacommons.js`; bundle confirms calls to `<origin>/core/api/v2/observation`)
- Auth: no (for the UNSD Data Commons backend, per custom-instance rule)
- Quirks: no SDMX/CSV download endpoint discoverable; all data flows through Data Commons v2 API on `unsd-datacommons.gcp.un-icc.cloud`; `/core/api/v2/node` timed out repeatedly (slow/flaky), `/core/api/v2/observation` was fast
- Verdict: **partial** — no direct UNdata download API; usable unauthenticated only via the UNSD Data Commons v2 instance with its SDG stat-var DCIDs

### 10. OECD Data Explorer — https://data.oecd.org/
- Search API: SDMX REST v1 dataflow list `https://sdmx.oecd.org/public/rest/v1/dataflow/{agency}/{resource}/{version}` with header `Accept: application/vnd.sdmx.structure+json;version=2.0.0` | tested: `https://sdmx.oecd.org/public/rest/v1/dataflow/all/all/all` → HTTP 200, SDMX-JSON 2.0.0 with 2685 dataflows
- Download: `https://sdmx.oecd.org/public/rest/v1/data/{agency},{dataflow},{version}/{key}?startPeriod=&endPeriod=&dimensionAtObservation=AllDimensions` with header `Accept: application/vnd.sdmx.data+json;version=2.0.0` | tested: `https://sdmx.oecd.org/public/rest/v1/data/OECD.SDD.NAD,DSD_NAMAIN1@DF_QNA,1.0/.............?startPeriod=2024&endPeriod=2024&firstNObservations=10` → HTTP 200, SDMX-JSON 2.0.0 data message
- Auth: no
- Quirks: the `/rest/v2/...` path does NOT exist (HTTP 400 `UnsupportedApiVersion`); v1 requires camelCase `dimensionAtObservation` (snake_case fails); dataflow list needs the SDMX Accept header or it 406s; key must have all dimension positions (13 dots for QNA); dataflow IDs look like `OECD.SDD.NAD,DSD_NAMAIN1@DF_QNA,1.0`
- Verdict: **yes** — fully usable unauthenticated; SDMX-JSON v1 API, camelCase params, correct Accept headers required

### 11. Eurostat — https://ec.europa.eu/eurostat/
- Search API: catalog/dataflow list `https://ec.europa.eu/eurostat/api/dissemination/sdmx/2.1/dataflow/ESTAT/all/all` | tested: same URL with `?detail=allstubs` → HTTP 200, SDMX-XML 2.1 structure message (~7 MB)
- Download: `https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/{dataset}?format=JSON&lang=en[&dim=value...]` | tested: `https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/nama_10_gdp?format=JSON&lang=en` → HTTP 200, JSON-stat 2.0 `{"version":"2.0","class":"dataset","label":"Gross domestic product (GDP)...","source":"ESTAT","updated":"2026-09-21T23:00:00+0200","value":{...}}`; filtered example (`geo=DE&geo=FR&na_item=B1GQ&unit=CLV15_MEUR&time=2024`) also → HTTP 200 with `"status":{"0":"p"}` flags
- Auth: no
- Quirks: JSON-stat format (values keyed by flat index, dimensions in `id`/`dimension` maps); per-dimension filters are plain query params; response includes `updated` timestamp — good for single-source snapshot discipline
- Verdict: **yes** — fully usable unauthenticated; JSON-stat v1 API is the simplest of the statistical APIs

### 12. Data.gov (catalog) — https://www.data.gov/
- Search API: `https://catalog.data.gov/search?q=<query>&per_page=<n>` (JSON; paginate with `after=<cursor>`) | tested: `https://catalog.data.gov/search?q=test&per_page=2` → HTTP 200, `{"after":"WzEyMC4z...","results":[{_score,_sort,dcat:{@type,title,distribution:[...]}}]}` — ~6KB JSON, DCAT schema
- Download: no stable download-URL pattern of its own — `results[].dcat.distribution[].downloadURL` holds the *publisher's* file URL (often external; some entries only have `accessURL`/HTML pages, not direct files) | tested: one result's distribution pointed to an HTML query page, not a file
- Auth: no
- Quirks: **the legacy CKAN path is dead** — `https://catalog.data.gov/api/3/action/package_search?q=test` → HTTP 404 `{"detail":{},"message":"Not Found"}`; data.gov rebuilt the catalog on a new (FastAPI-style) stack. Search supports `q`, `per_page`, `after` cursor, `sort=relevance`; no dataset-detail JSON endpoint seen (detail pages are HTML at `/dataset/<slug>`)
- Verdict: **partial** — unauthenticated JSON search works and yields per-dataset publisher download URLs, but no package_show-style metadata API and download URLs are heterogeneous/publisher-owned

### 13. Hugging Face Datasets — https://huggingface.co/datasets
- Search API: `https://huggingface.co/api/datasets?search=<q>&limit=<n>` | tested: `...?search=motor%20vehicle&limit=3` → HTTP 200, JSON array of dataset objects (`id`, `author`, `sha`, `tags`, `gated`, `private`…)
- Download: `https://huggingface.co/datasets/{namespace}/{name}/resolve/main/{path}` (302 → signed CDN URL, Xet bridge) | tested: `…/datasets/cornell-movie-review-data/rotten_tomatoes/resolve/main/test.parquet` → HTTP 302 → signed `https://us.aws.cdn.hf.co/xet-bridge-us/…` (expires). File paths from `/api/datasets/{id}` → `siblings[].rfilename`. Parquet auto-API: `https://huggingface.co/api/datasets/{id}/parquet` → HTTP 200 JSON `{"default":{"test":["https://huggingface.co/api/datasets/…/parquet/default/test/0.parquet"],…}}`; one chunk → HTTP 200, 92KB, starts with `PAR1` magic (valid parquet)
- Auth: no for public datasets; gated/private need a token (e.g. `GET /api/datasets/meta-llama/Llama-2-7b-hf` unauthenticated → HTTP 401)
- Quirks: no rate limit hit in probing; row-level querying via `/api/datasets/{id}/rows` and arrow format at `/api/datasets/{id}/arrow` (documented, not verified); large splits have `0.parquet`, `1.parquet`…
- Verdict: **yes** — fully usable unauthenticated for public datasets (search → info/siblings → resolve/parquet download)

### 14. Registry of Open Data on AWS — https://registry.opendata.aws/
- Search API: none as a REST endpoint. Machine-readable index embedded in site JS: `https://registry.opendata.aws/js/index.js` (HTTP 200, ~14.1MB) declares `var datasets = [{...}, …]` — 1202 dataset objects | tested: fetched and parsed the first object; keys: `Name, Description, Documentation, License, ManagedBy, Contact, Slug, Tags, Sources, Resources, DataAtWork, UpdateFrequency, RegistryEntryAdded, RegistryEntryLastModified`
- Download: per-dataset; each entry's `Resources`/`DataAtWork` lists S3/HTTPS file URLs (e.g. `s3://…` buckets, STAC `catalog.json` links) — no registry-wide file API | tested: index parse only; individual S3 URLs not fetched
- Auth: no (index and public S3 buckets are open)
- Quirks: `https://registry.opendata.aws/index.json` → HTTP 404 (no standalone JSON index); parsing requires stripping the JS wrapper (`var datasets = `); dataset pages at `/<slug>/` are HTML
- Verdict: **partial** — no search API, but the full catalog index is machine-readable via the embedded JS array (fetch once, parse, extract S3/HTTPS resource URLs)

### 15. OpenCity (India) — https://data.opencity.in/
- Search API: standard CKAN `https://data.opencity.in/api/3/action/package_search?q=<q>&rows=<n>` | tested: `…?q=test` → HTTP 200 CKAN JSON `{"success":true,"result":{"count":5,"results":[...]}}`; `…?q=population&rows=2` → HTTP 200, count 25. `package_show?id=<id>` → HTTP 200 with `result.resources[]` (name, format, url)
- Download: `https://data.opencity.in/dataset/<dataset-id>/resource/<resource-id>/download/<filename>` (CKAN download endpoint) | tested: HEAD on a KML resource → HTTP 200, `Content-Type: application/vnd.google-earth.kml+xml`, `Content-Length: 4077836`
- Auth: no (generator: `ckan 2.11.4`)
- Quirks: no rate limit observed; resources in CSV, ZIP, PDF, KML, PNG; some search results include extension-less resource URLs (full filename appears in package_show)
- Verdict: **yes** — vanilla public CKAN, fully usable unauthenticated

### 16. ICAO Data+ Tools — https://dataplus.icao.int/Tools
- Search API: none public. `/Tools` → HTTP 200 HTML ("Catalogue - ICAO Data+"); every tool (aciAptData, aptTraffic, carFinances, carTraffic, fleet, ofod, personnel, tfs) renders only a "Subscribe" button wired to a token store (`goToStore('…')` → `http://store1.icao.int/…`)
- Download: no public data download. Login (`/Windows/Login`) → HTTP 401 without credentials; "Demo" on the Pricing page is a sales "Request Demo" contact form, not free data
- Auth: **yes** — account + paid token subscription required for all tools/data
- Quirks: token-based commercial API portal (ICAO's official statistics store); no sample datasets exposed
- Verdict: **no** — auth-walled and paywalled; nothing usable in an unauthenticated automated pipeline

---

## Pipeline integration summary

| # | Source | Verdict | Search | Direct download |
|---|--------|---------|--------|-----------------|
| 1 | data-races.com | partial | scrape `/en/datasets/` list page | `data-races.com/data/{category}/{slug}.json` ✅ |
| 2 | Google Dataset Search | no | — | — |
| 3 | Kaggle | partial | `kaggle.com/api/v1/datasets/list?search=` ✅ (fragile, keep token ready) | `kaggle.com/api/v1/datasets/download/{owner}/{ds}` ✅ |
| 4 | OWID | partial | none (slug discovery via links/GitHub) | `ourworldindata.org/grapher/{slug}.csv` ✅ |
| 5 | WB Data Catalog | partial | `/ddhxext/v3/search` = full dump, paginate client-side | detail/download endpoints per OpenAPI (unverified) |
| 6 | feedmedata.ai | no | — | — |
| 7 | visdatasets | yes | scrape HTML for filenames | `visdatasets.github.io/datasets/<name>.csv` ✅ |
| 8 | Data Commons | partial | v2 API needs key; UNSD instance open for SDG vars | `api.datacommons.org/v2/observation` (key) / UNSD instance (open) |
| 9 | UNdata | partial | none — use UNSD Data Commons v2 instance | same as above |
| 10 | OECD | yes | `sdmx.oecd.org/public/rest/v1/dataflow/all/all/all` ✅ (2685 flows, SDMX-JSON, Accept header) | `.../rest/v1/data/{agency},{flow},{ver}/{key}?…&dimensionAtObservation=AllDimensions` ✅ |
| 11 | Eurostat | yes | `ec.europa.eu/eurostat/api/dissemination/sdmx/2.1/dataflow/ESTAT/all/all` ✅ | `.../statistics/1.0/data/{dataset}?format=JSON&lang=en` ✅ (JSON-stat) |
| 12 | data.gov | partial | `catalog.data.gov/search?q=&per_page=&after=` ✅ (legacy CKAN dead) | per-publisher `distribution[].downloadURL` |
| 13 | Hugging Face | yes | `huggingface.co/api/datasets?search=&limit=` ✅ | `/api/datasets/{id}/parquet` or `.../resolve/main/{path}` ✅ |
| 14 | AWS Open Data | partial | parse `registry.opendata.aws/js/index.js` (1202 entries) | per-dataset S3/HTTPS resource URLs |
| 15 | OpenCity | yes | CKAN `data.opencity.in/api/3/action/package_search?q=` ✅ | CKAN resource download ✅ |
| 16 | ICAO Data+ | no | — | — |

**Fully usable unauthenticated (5):** visdatasets (#7), OECD (#10), Eurostat (#11), Hugging Face (#13), OpenCity (#15).
**Partially usable (8):** data-races (#1), Kaggle (#3), OWID (#4), WB catalog (#5), Data Commons (#8), UNdata (#9), data.gov (#12), AWS Open Data (#14).
**Not usable (3):** Google Dataset Search (#2), feedmedata.ai (#6), ICAO Data+ (#16).

**Gotchas for the pipeline:**
- Eurostat responses carry an `updated` timestamp — good for the single-source snapshot rule.
- OECD v1 requires camelCase `dimensionAtObservation` and SDMX `Accept` headers; `/rest/v2` does not exist.
- Data.gov's old CKAN API is dead — do not use `/api/3/action/package_search` on catalog.data.gov.
- Kaggle worked without auth in this probe but is not contractually open — keep token auth as the planned path.
- Hugging Face `resolve` URLs 302-redirect to expiring signed CDN URLs — follow redirects at download time.
- AWS Open Data's index is a 14MB JS file — fetch once and cache, don't pull per query.
