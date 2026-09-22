# MEMORY.md - analysis-video-maker

Durable facts about this repository: what everything is, where it runs, which credentials
unlock it, and how to verify a change. Read this before touching anything.

If you are new, read `README.md` first (architecture + every backend file), then `LESSONS.md`
(every mistake that produced a wrong video, and the rule each one left behind).

---

## 1. What this repository is

A pipeline that turns a **topic** into a **bar-chart-race MP4**:

    topic -> official data -> video-input JSON -> Remotion render -> MP4 on gofile.io

Two entry points:

- **The studio** (Cloudflare Pages, password-gated): type a topic, everything else is automatic.
- **A workflow dispatch**: `research.yml` (topic -> input file) then `make-video.yml` (input -> MP4).

The user's quality bar: the look should match `look-i-want.png` / the data-races.com reference;
wrong data is unacceptable; the system must run unattended.

## 2. Live deployment

| Thing | Value |
| --- | --- |
| Studio (Pages) | https://race-video-studio.pages.dev |
| API (Worker) | https://avm-control.avm-studio-video.workers.dev |
| Cloudflare account | 8aee88d9ea2ea8e660a82a12ce8fd47f (video@seocooking7.33mail.com) |
| workers.dev subdomain | avm-studio-video |
| D1 database | avm, id 0371647f-942c-403d-9ac2-0d82498fd97b |
| KV namespace | SESSIONS, id 6abbd87e08f34791acbbdf8ae6542d27 |
| Pages project | race-video-studio |
| Studio password | BloggingJi@7 (also a Worker secret) |
| Videos | published to gofile.io - **R2 is not used** (no payment on the account) |
| Repo | github.com/toviralideasyt7/analysis-video-maker, branch main |

The GitHub token that can push lives in the local `.env` as `GITHUB_TOKEN`; plain `git push`
authenticates as a different account. The working push pattern:

    $kt  = gh auth token
    $b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$kt"))
    git -c http.extraheader="Authorization: Basic $b64" push origin main

Pushes are frequently rejected with "fetch first" because the workflows commit
`inputs/<slug>.json`. Rebase on origin/main, then push.

## 3. Credentials and where each one is read

Everything is in the gitignored `.env` (47 keys, each annotated with a `# used:` note) and
mirrored as GitHub repo secrets / Cloudflare Worker secrets.

| Key | Read by |
| --- | --- |
| GITHUB_TOKEN | local push + the uploader's commit/dispatch |
| NARA_API_KEY, NARA_BASE_URL, NARA_MODELS | `services/uploader/src/ai.ts` (planner / extractor / story) |
| GEMINI_WORKER_1/2, GEMINI_MODELS | keyless Gemini proxies (fallback reviewer) |
| MONID_API_KEY, MONID_BASE_URL, MONID_*_ENDPOINT | `services/uploader/src/search.ts`, `tools/resolve-assets.ts` (flagViaMonid) |
| KAGGLE_USERNAME, KAGGLE_KEY | `tools/sources/kaggle.ts` |
| CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID | wrangler (deploy Worker/Pages, create D1/KV) |
| HOOK_SECRET | `make-video.yml` + `research.yml` -> Worker `/api/hooks/render-complete` |
| APP_PASSWORD | the studio login |
| DATARACE_FFPROBE | ffprobe/ffmpeg paths for probing and frame extraction |

`gh secret list` needs admin:repo and returns HTTP 404 with the keyring token. Secrets were set
by value; the names are documented in the workflows.

## 4. The data rules (why the videos are correct)

These are the guards that make specific wrong outputs impossible. See `LESSONS.md` for the
failures that created them.

1. A chart with **more than one value column is rejected**. Comparison charts (income share:
   WID vs World Bank - which also ships Population and World region columns) cannot be raced.
2. **Non-additive metrics get no world total.** A share, a rate or a per-capita value does not
   sum into a meaningful total; the summary shows the leader labelled `Top:`.
3. Every unit passes `safeUnit()`: Owid ships charts whose metadata unit is the empty string.
4. Region aggregates (`OWID_*`, blank codes, "(UN)" names) are excluded.
5. Entities are ranked by peak value, and each carries its flag code from the source's own
   country column (ISO3 -> ISO2, 217 countries).
6. A 150-year recency window is the default; a topic asking for depth overrides it.
7. Facts carry the unit; leader-change facts are capped at four.

## 5. Data sources that are known to work

| Source | Discovery | Download |
| --- | --- | --- |
| Our World in Data | `/api/search?q=` -> `results[].slug` | `/grapher/<slug>.csv` + `.metadata.json` |
| data-races.com | `sitemap-0.xml` -> `/en/datasets/<slug>/` | `/data/<category>/<slug>.json` (a ready-made race tape) |
| World Bank DDH | `/search?qname=dataset&param=` | `/datasets/<id>` -> `resources[].url` |
| Kaggle | `/api/v1/datasets/list?search=` | `/api/v1/datasets/download/<ref>/<file>` |
| circle-flags | - | `hatscripts.github.io/circle-flags/flags/<iso2>.svg` |
| flagcdn | - | `flagcdn.com/w80/<iso2>.png` (rectangular, used for the flag cards) |
| gofile.io | `/servers` + `POST /accounts` | `POST /<server>.gofile.io/contents/uploadfile` |

Google Dataset Search has **no public API** - it is a human discovery layer only.

Probe everything at once: `npx tsx tools/sources/cli.ts probe`.

## 6. Verification commands

    npm run typecheck        # 4 workspaces; must be clean
    npm test                 # 22 tests (9 shared + 6 uploader + 7 renderer)
    cargo +stable-x86_64-pc-windows-gnu test --workspace
    cargo +stable-x86_64-pc-windows-gnu clippy --workspace --all-targets -- -D warnings

    npx tsx tools/sources/cli.ts probe                       # every data source, live
    npx tsx tools/check-input.ts input/generated/x.json       # schema validation
    npx tsx tools/probe-control.mts <base> <password>         # the deployed control plane
    npx tsx tools/debug-tape.mts input/generated/x.json       # tape state per frame
    npx tsx tools/debug-resolve.mts "topic" "topic 2"          # which chart a topic resolves to

Renders:

    npm run render -w @avm/renderer -- --input <in.json> --out out.mp4
    npm run render -w @avm/renderer -- --input <in.json> --still 9000 --out still.mp4

`--still` renders one frame. **Use it before a full render** - it is how almost every layout
fault was caught without paying for a render.

Independent visual review: extract a frame with ffmpeg, upload it with
`~/.openclaw-autoclaw/skills/autoglm-image-recognition/upload-mix.py`, then run
`image-recognition.py <url> "<specific questions>"`. Ask about overlaps, clipping, panels and
scores; it has caught every defect that a self-report missed.

## 7. Known limits

- A 2-core GitHub runner renders about 15 frames/second, so a 10-minute video at 30 fps
  (17 851 frames) takes roughly 20 minutes. The job cap is 120 minutes.
- The review gate is best-effort: with no model reachable it is skipped, and two agreeing
  models can still be wrong. The deterministic guards are what make the wrong-column and
  wrong-total faults impossible.
- gofile.io links are temporary. The input file is committed, so a re-render needs no research.
- Wordy topics can still resolve to a loosely-related chart when no intent rule matches.
- The studio password has a default in `cloudflare/worker/src/index.ts`; set `APP_PASSWORD` as a
  Worker secret to move it out of the repository.