# Data sources

Priority order implemented by the source registry and the scorer
(`services/orchestrator/src/connectors.ts`, `sourceQualityScore` in
`pipeline.ts`):

```
user-provided authoritative dataset
  > official APIs            (World Bank, Eurostat, data.gov CKAN)
  > official datasets        (Our World in Data, Data Commons, UNdata)
  > international bodies     (UN, OECD, Eurostat)
  > company filings / reports
  > industry organisations
  > reputable public datasets
  > community datasets       (Kaggle, Hugging Face)
  > general web pages
```

A discovery index (Google Dataset Search, Data Races, visdatasets, Feed Me Data)
is **never** treated as the data provider — the pipeline follows the result to
the owner.

## Implemented connectors

| Connector | Endpoint | Auth | Notes |
|---|---|---|---|
| Our World in Data | `ourworldindata.org/grapher/<slug>.csv` + `.metadata.json` | none | metadata carries units, timespan and citation |
| World Bank | `api.worldbank.org/v2/country/{codes}/indicator/{id}?format=json` | none | indicator discovery by name matching (`findWorldBankIndicator`) |
| Data Commons | `api.datacommons.org/v2/observation` | optional key | aggregates upstream sources; provenance recorded |
| UNdata | `data.un.org/ws/rest/data` | none | UN statistical system |
| OECD | `sdmx.oecd.org/public/rest/v1/data/...` | none | SDMX JSON |
| Eurostat | `ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/{ds}` | none | JSON-stat |
| Data.gov (+ any CKAN) | `catalog.data.gov/api/3/action/package_search` | none | discover then follow resources |
| Kaggle | `www.kaggle.com/api/v1/datasets/...` | `KAGGLE_USERNAME` + `KAGGLE_KEY` | licence/date/columns must be inspected before use |
| Hugging Face | `datasets-server.huggingface.co/rows` | optional token | not an authority for world statistics |
| AWS Open Data | `registry.opendata.aws/index.json` | none | licensing is per dataset |
| Discovery directories | page HTML → outbound links | none | discovery only |

## Search + fetch

`providers/search.ts` fronts the Monid proxy, which in turn exposes the free
TinyFish `search` and `fetch` endpoints:

```
POST https://api.monid.ai/v1/inspect  { "provider": "tinyfish", "endpoint": "/search" }
POST https://api.monid.ai/v1/run      { "provider": "tinyfish", "endpoint": "/search", "input": { ... } }
```

`inspect` is called once per endpoint and cached, then the runner tries the
documented input shapes in order, so a provider-side schema change degrades
instead of breaking the pipeline. A direct browser-user-agent fetch is the
fallback for anything the proxy cannot reach.

## AI providers

`providers/ai.ts`. Primary is the keyless Gemini web-proxy worker pair, used
strictly as documented:

- one worker per batch; the second is a 429/502/503 backup only;
- 1 request / 2s (thinking models 1 request / 4s), one in-flight request per class;
- a worker that answers 429/5xx is parked for 2.5 minutes;
- every answer is cached on disk by request hash and never re-asked.

A Nara-router (OpenAI-compatible) provider is available as a secondary, and a
`MockProvider` keeps tests and offline runs working.

## Free-tier caveats (verify before relying on them)

- Cloudflare Pages/Workers limits — <https://developers.cloudflare.com/pages/platform/limits/>
- GitHub Actions minutes — <https://docs.github.com/en/billing/concepts/product-billing/github-actions>
- Dataset licences — each connector records a `license` field; `UNKNOWN` means
  "do not redistribute until checked".

Nothing above is hard-coded as a business rule; quotas are read from the
environment (`MAX_SEARCHES`, `MAX_SOURCES`, `MAX_AGENT_ROUNDS`, `MAX_TOKENS`,
`MAX_RENDER_ATTEMPTS`) and can be changed without touching code.