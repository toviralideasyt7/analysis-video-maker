# analysis-video-maker

Turn a **topic** (or a data link) into a polished **bar-chart-race MP4**, rendered on GitHub
Actions, driven by a password-protected studio on Cloudflare's free tier.

Type `world population by country` into the studio. An agent finds the official data, keeps a
sensible time window, writes the video input, renders it, publishes the MP4 to gofile.io, and
reports the link back to the studio. No human touches a spreadsheet.

**Studio:** https://race-video-studio.pages.dev
**API:** https://avm-control.avm-studio-video.workers.dev

---

## 1. Top-level architecture

```
                         +------------------------------+
   Browser -- topic -->  | Cloudflare Pages  (the UI)   |
                         |  + Pages Function /api/*     |  same-origin proxy, keeps the
                         +---------------+--------------+  session cookie first-party
                                         |
                                         v
                         +------------------------------+
                         | Cloudflare Worker (API)      |
                         |  login / jobs / callback     |
                         +-------+--------------+-------+
                                 |              |
                  writes job     |              |  dispatches
                  + events       v              v  research.yml
                         +--------------+   +------------------------------+
                         | D1 database  |   | GitHub Actions: research.yml |
                         |  jobs,events |   |  1. resolve the official data|
                         +--------------+   |  2. build the video input    |
                                            |  3. commit inputs/<slug>.json|
                                            |  4. dispatch make-video.yml  |
                                            +---------------+--------------+
                                                            |
                                                            v
                                            +------------------------------+
                                            | GitHub Actions: make-video   |
                                            |  validate -> resolve assets  |
                                            |  -> render (Remotion) -> probe|
                                            +---------------+--------------+
                                                            | publishes the MP4
                                                            v
                                            +------------------------------+
                                            | gofile.io  (no account)      |
                                            +---------------+--------------+
                                                            |  POST /api/hooks/
                                                            v  render-complete
                                            Worker updates D1: status=done + link
```

**No R2 anywhere.** There is no paid storage on the Cloudflare account, so finished MP4s are
published to gofile.io and only the link is stored.

---

## 2. The four moving parts

| Part | Directory | What it is |
| --- | --- | --- |
| Studio UI | `cloudflare/pages` | One static page + a Pages Function that proxies `/api/*` to the Worker |
| Control plane | `cloudflare/worker` | Worker API, D1 schema, wrangler config |
| Renderer | `renderer` | Remotion composition + the tape that turns data into frames |
| Research agent | `services/uploader` | Topic -> official data -> validated video input |
| Rust core | `crates` | Validate / probe / ingest / rank (speed-critical, tested) |
| Tools | `tools` | Data-source adapters, generators, probes and diagnostics |
| Legacy | `legacy/research-stack` | The parked first-generation agent. Kept for reference; `tools/csv-to-input.ts` still imports its CSV parser |

---

## 3. Backend files, and what each one does

### packages/shared - the contract everything shares

| File | Role |
| --- | --- |
| `src/videoInput.ts` | `VideoInput`: the one user-supplied file that drives a video (entities, observations, facts, groups, settings) |
| `src/validate.ts` | Schema-registered validation used by the uploader, the renderer and CI |
| `src/sources.ts` | Every direct-download data source. Owid search/CSV/metadata, the query ladder, ISO3->ISO2 flags, `countValueColumns` (rejects comparison charts), `safeUnit` (no empty units), `isAdditiveUnit` (no meaningless totals), `intentSlugs` (phrasings search cannot bridge) |

### renderer - the animation

| File | Role |
| --- | --- |
| `src/ReferenceRace.tsx` | The composition: near-black canvas with a teal vignette, title + subtitle, flag card and rank badge in a left gutter, chunky gradient bars with rounded ends, a gold ring on the leader, name inside the bar, value after the bar end, a right-hand info panel (narrative + summary + key moments), a giant translucent year, and a bottom axis |
| `src/tape.ts` | Data -> frames. Per-frame interpolation with smoothstep easing, collision-free row slots (two bars can never share a line), fact scheduling, group sums, world total |
| `src/polish.ts` | Palette and easing helpers (`isDarkColor`, `lighten`) |
| `src/fonts.ts` | Lazy Inter loading (weights 400-900), non-fatal |
| `src/render.ts` | The render CLI. `--still <frame>` renders one frame for fast layout review |

### services/uploader - the research agent

| File | Role |
| --- | --- |
| `src/research-agent.ts` | The agent. Resolves official data, windows it, ranks entities, derives facts, validates, and reviews itself |
| `src/ai.ts` | The AI client (Nara + keyless Gemini workers), JSON extraction with retries |
| `src/search.ts` | Monid search/fetch |
| `src/github.ts` | Commit the input, dispatch workflows |
| `src/server.ts` | The local uploader API (`/api/upload`, `/api/research`) |
| `src/csv.ts`, `src/validate.ts`, `src/dates.ts` | CSV -> video input, validation, date handling |
| `src/scripts/research.ts` | The CLI the workflow runs (TOPIC, DATA_URL, TOP_N, LAYOUT, TARGET_MINUTES, START_YEAR) |

### crates/datarace-core (Rust)

`validate.rs`, `ingest.rs`, `rank.rs`, `probe.rs`, `units.rs`, `dates.rs` - the fast, tested core.
`datarace validate --in file.json` must print zero problems; `datarace probe` verifies the MP4.

### tools - data sources and diagnostics

| File | Role |
| --- | --- |
| `sources/owid.ts` | Owid search + grapher CSV + metadata |
| `sources/dataraces.ts` | data-races.com sitemap -> dataset page -> race tape, plus image scraping |
| `sources/kaggle.ts` | Kaggle dataset search/view/download (must send a tool User-Agent) |
| `sources/worldbank.ts` | World Bank DDH catalog (reverse-engineered spec) |
| `sources/flags.ts` | Circular flag assets |
| `sources/regions.ts` | ISO3 -> ISO2 + World Bank region for 217 countries |
| `sources/http.ts` | Shared fetch, CSV/TSV parsing, image extraction |
| `make-series-input.mts` | Owid series -> video input (windowing, pacing, facts) |
| `resolve-assets.ts` | Flags/logos: country table -> AI -> Monid -> monogram |
| `upload-gofile.mts` | Publish the finished MP4 to gofile.io |
| `notify-control.mts` | Report a milestone back to the control plane |
| `check-input.ts` | Validate an input file |
| `debug-*.mts` | Diagnostics: tape state, Owid ranking, resolution, logo probes |

### cloudflare

| File | Role |
| --- | --- |
| `worker/src/index.ts` | Login/logout/me, jobs create/list/get, the render-complete callback |
| `worker/schema.sql` | D1: jobs, events, sessions |
| `worker/wrangler.toml` | D1 + KV bindings, vars, workers.dev |
| `pages/index.html` | The studio page (password gate, topic form, live job list) |
| `pages/functions/api/[[path]].ts` | Same-origin proxy so the session cookie stays first-party |

### .github/workflows

| Workflow | Does |
| --- | --- |
| `ci.yml` | Rust test/clippy/build + Node typecheck/test + input validation |
| `research.yml` | The agent: resolve data -> input file -> commit -> chain the render -> report back |
| `make-video.yml` | Validate -> resolve assets -> render -> probe -> publish to gofile -> report back |
| `deploy-web.yml` | Deploy the studio to Pages (runs from inside `cloudflare/pages`) |

---

## 4. How the agent decides things

Deterministic rules come first. The AI is a second line, never the source of a number.

1. Resolve the data. An Owid link of any shape (.csv, .zip, explorer, query strings) is reduced to
   a chart slug and fetched as the plain CSV. Otherwise a ladder of progressively simpler queries
   is tried, and an exact title match wins - because Owid's search returns the wrong chart for
   wordy queries. An intent table maps phrasings search cannot bridge (richest -> GDP per capita,
   most populous -> population).
2. Reject unusable charts. A chart with more than one value column is a comparison and cannot be
   raced: picking a column and labelling it from another column is how a video once showed the
   wrong number under the wrong name. So it is skipped, and the next candidate is tried.
3. Window it. A 150-year default window (population 1873-2023, not 10 000 BC), unless the topic
   asks for depth, in which case the full range is kept.
4. Filter and rank. Region aggregates are dropped, entities are ranked by peak value, and every
   entity carries the flag code from the source's own country column.
5. Derive the narrative. Facts come from the data: where it began, who took the lead (capped at
   four), the fastest riser, the biggest jump, where it stands. Each one carries the unit.
6. Pace it. About 3.5 seconds per period, clamped to one minute at the short end and ten at the
   long end. A long history is sampled rather than flashed past. 30 fps halves the render time.
7. Validate. The input must pass the shared schema.
8. Review. Two models are asked separately whether the dataset answers the topic. Both must object
   before the job is refused (best-effort; skipped with no model reachable).

---

## 5. Deployment

### GitHub secrets

| Secret | Used by |
| --- | --- |
| NARA_API_KEY, MONID_API_KEY | research.yml, make-video.yml |
| GEMINI_WORKER_1/2 (variables) | both |
| KAGGLE_USERNAME, KAGGLE_KEY | research.yml |
| HOOK_SECRET | both - must match the Worker secret |
| CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID | deploy-web.yml |
| PAGES_PROJECT (variable) | deploy-web.yml |

### Cloudflare

    cd cloudflare/worker
    npm install
    npx wrangler d1 create avm                       # paste database_id into wrangler.toml
    npx wrangler kv namespace create SESSIONS        # paste id into wrangler.toml
    npx wrangler d1 execute avm --file=./schema.sql --remote
    npx wrangler secret put GH_TOKEN
    npx wrangler secret put HOOK_SECRET
    npx wrangler secret put APP_PASSWORD
    npx wrangler deploy

    cd ../pages
    npx wrangler pages project create race-video-studio --production-branch main
    npx wrangler pages deploy . --project-name race-video-studio --branch main

pages deploy must run from inside cloudflare/pages. Deploying a subdirectory from the
repository root silently drops the Functions bundle, which breaks /api/*.

### Local

    npm install
    npm run typecheck          # 4 workspaces
    npm test                   # 22 tests
    cargo +stable-x86_64-pc-windows-gnu test --workspace
    npx tsx tools/sources/cli.ts probe        # every data source, live
    npx tsx tools/make-series-input.mts --slug population --out input/generated/population.json
    npx tsx tools/resolve-assets.ts input/generated/population.json
    npm run render -w @avm/renderer -- --input input/generated/population.json --out out.mp4
    npm run render -w @avm/renderer -- --input ... --still 9000 --out still.mp4   # one frame

---

## 6. Every mistake that cost a render, and the rule it left behind

Each of these produced a wrong video, a failed run, or a silent regression. They are the reason
the guards exist.

| # | Mistake | What it produced | The rule now in the code |
| --- | --- | --- | --- |
| 1 | Racing a comparison chart (income share: WID vs World Bank - 4 data columns) | One arbitrary column raced while labelled with another column's unit | Charts with more than one value column are rejected |
| 2 | Summing a share into a world total | 19 displayed as the world total of an income-share metric | Non-additive units get no total; the summary shows the leader, labelled Top |
| 3 | A data URL that was not .csv fell through every branch | no plan could be built for this topic, for any .zip or explorer link | A fallback chain: Owid link -> table -> direct sources -> model-planned page |
| 4 | An Owid explorer link was ignored | The user's link replaced by whatever the topic resolved to | The Indicator parameter of an explorer link is used as the search phrase |
| 5 | Empty unit from chart metadata | /unit must NOT have fewer than 1 characters | safeUnit() never returns an empty string |
| 6 | Owid search used verbatim for wordy queries | "world population by country" returned health-access charts; the real chart was not in the response | A query ladder; an exact title match wins; an intent table for phrasings search cannot bridge |
| 7 | The anti-overlap guard was fed back as easing memory | Rows ratcheted downward each frame; the chart drifted out of order and rows slid out of the band | The separation pass is display-only |
| 8 | The rank badge came from the pre-easing order | A badge disagreed with the visible order mid-swap | The badge is taken from the final vertical order |
| 9 | The info panel rendered blank during intro and outro | The panel only "sometimes" showed | It falls back to the most recent fact, then the first |
| 10 | Frame accessor used frame - introFrames on an absolute-frame array | Every frame rendered 300 frames behind | tape.frames is indexed by absolute frame |
| 11 | Wordy data URLs were ignored, then the unit was empty | The poverty-explorer link failed validation | Explorer Indicator -> search phrase; safeUnit() |
| 12 | A 150-year window applied to a topic asking for ancient history | The review rejected it: the window answered a different question | A depth request overrides the window |
| 13 | The review summary showed six entity names | The models concluded the race covered six countries | The summary reports the count, the leading twelve, the unit and the span |
| 14 | Owid search returned the wrong chart for "richest countries" | An income-share chart raced as if it were income | The intent table, tried before search |
| 15 | PowerShell here-strings flattening onto one line, and Math.Max instead of Math.max | Broken TS committed; a runtime crash | Select-String verification after every generated file |

Two rules that have saved more time than any of the above:

- --still <frame> renders one frame. A full render used to be the only way to see a layout
  change. Rendering a still and reading it independently catches almost everything first.
- Debug dumps beat reasoning. tools/debug-tape.mts printed the slot values that made fault 7
  obvious in seconds, after an hour of it being invisible in stills.

---

## 7. Facts a new contributor needs

- .env is gitignored and holds every key. .env.example documents the names.
- The same values are also GitHub repo secrets (Actions read them there) and Cloudflare Worker
  secrets (the deployed API reads them there).
- The Rust toolchain is GNU on Windows: cargo +stable-x86_64-pc-windows-gnu ...
- gofile.io needs no account: servers -> guest token -> upload.
- Kaggle answers a browser User-Agent with an HTML reCAPTCHA page and HTTP 200. Send a tool UA.
- Monid's fetch strips image tags, so it cannot be used for image scraping; plain HTTP works on
  data-races.com.
- Cloudflare Pages Functions are resolved relative to the working directory - deploy from inside
  the studio folder or /api/* silently serves the static page.

---

## 8. parked

legacy/research-stack/ holds the first-generation agent (orchestrator, providers, QA scripts) and
the old render workflow. It is kept for reference; see legacy/research-stack/README.md. The only
live dependency on it is the CSV parser in tools/csv-to-input.ts.

## 8. Where the durable knowledge lives

| File | Contents |
| --- | --- |
| `MEMORY.md` | Live deployment, credentials and where each is read, the data rules, known-working sources, verification commands, current limits |
| `LESSONS.md` | Every mistake that produced a wrong video or a failed run, and the rule each one left behind (26 entries) |
| `docs/DATA-SOURCES.md` | The verified endpoints, their traps, and the probe results |
| `docs/VIDEO_STYLE.md` | The design rationale behind the look |

A new contributor should read `README.md`, then `MEMORY.md`, then `LESSONS.md`, in that order.

---
## 9. License

See LICENSE.