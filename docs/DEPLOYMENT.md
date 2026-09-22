# Deployment

Four moving parts. Each one is replaceable without touching the others.

| Layer | Runs on | Responsibility |
|---|---|---|
| Dashboard | Cloudflare Pages | static React app, browser preview |
| Research + orchestration | Render.com (free) | planning, source discovery, verification, VideoSpec |
| Rendering | GitHub Actions | Remotion + ffmpeg -> MP4 |
| Artifacts | Cloudflare R2 (optional) | finished renders and large files |

**Render never renders video.** It has no durable disk and it sleeps; long jobs
belong on a runner. This split is the whole point of the architecture.

## 1. GitHub repository and Actions

```bash
gh repo create <owner>/analysis-video-maker --private --source . --push
```

Then set the values the workflows read:

```bash
# Secrets (never printed, never committed)
gh secret set NARA_API_KEY        --body '<nara key>'
gh secret set MONID_API_KEY       --body '<monid key>'
gh secret set KAGGLE_USERNAME     --body '<kaggle user>'
gh secret set KAGGLE_KEY          --body '<kaggle key>'
gh secret set CLOUDFLARE_API_TOKEN --body '<cloudflare token>'   # Pages + R2
gh secret set CLOUDFLARE_ACCOUNT_ID --body '<account id>'
gh secret set R2_ACCESS_KEY_ID     --body '<r2 key id>'
gh secret set R2_SECRET_ACCESS_KEY --body '<r2 secret>'
gh secret set R2_BUCKET            --body '<bucket name>'
gh secret set R2_ACCOUNT_ID        --body '<account id>'

# Variables (non-secret)
gh variable set GEMINI_WORKER_1 --body 'https://gemini-web-proxy.shonratt.workers.dev'
gh variable set GEMINI_WORKER_2 --body 'https://gemini-web-proxy.dipteshray7.workers.dev'
gh variable set GEMINI_MODELS   --body 'gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash'
gh variable set NARA_BASE_URL   --body 'https://router.bynara.id/v1'
gh variable set VITE_API_BASE   --body 'https://<your-orchestrator>.onrender.com'
```

Workflows:

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | push / PR | Rust tests + clippy, TypeScript typecheck, unit tests |
| `research.yml` | manual | runs the full research pipeline with the AI providers, validates every bundle, runs the AI QA agent, uploads the bundle as an artifact |
| `render-video.yml` | manual / API dispatch | validates the VideoSpec and dataset, re-derives the frame tape, runs the AI QA agent, renders with Remotion, post-processes with ffmpeg, probes the MP4, uploads the artifacts, optionally publishes to R2 |
| `deploy-web.yml` | push to `apps/web` | builds the dashboard and publishes it to Cloudflare Pages |

Actions minutes are not unlimited: GitHub Free gives 2,000 minutes/month for
private repositories. Check the current numbers at
<https://docs.github.com/en/billing/concepts/product-billing/github-actions>
before scheduling frequent renders.

## 2. Cloudflare Pages (dashboard)

```bash
npm run build -w @avm/web
npx wrangler pages deploy apps/web/dist --project-name analysis-video-maker
```

`apps/web/wrangler.toml` holds the project settings. Set `VITE_API_BASE` at
build time to the deployed orchestrator URL — the dashboard is a static SPA and
needs no server of its own.

Pages free-tier limits (verify before relying on them):
<https://developers.cloudflare.com/pages/platform/limits/>

## 3. Render.com (research service)

`render.yaml` is a blueprint for the orchestrator as a free web service.
Point Render at this repository and it will build and start:

```
npm ci && npm run serve -w @avm/orchestrator
```

Health check: `GET /api/health` (it also reports whether the Rust core binary is
present). Secrets marked `sync: false` are entered in the Render dashboard.

Caveats, honestly: a free service sleeps after inactivity and has no durable
disk, so project state is written under `/tmp` and is lost on restart. The
resumable checkpoint design means a run picks up where it left off, but a
long-lived deployment wants a real database or object storage.

## 4. Cloudflare R2 (artifacts)

`render-video.yml` publishes the finished MP4 to R2 when the `R2_*` secrets are
present; otherwise it stops after uploading the workflow artifacts. R2 is
S3-compatible, so the job uses the AWS CLI with
`--endpoint-url https://<account>.r2.cloudflarestorage.com`.

Never store rendered video in git. `renders/` and `*.mp4` are gitignored.

## Cost control

`MAX_SEARCHES`, `MAX_SOURCES`, `MAX_AGENT_ROUNDS`, `MAX_TOKENS` and
`MAX_RENDER_ATTEMPTS` bound a run from the environment. Every AI and search call
is appended to `usage.jsonl` / `search-usage.jsonl` with tokens and duration, so
a run can be audited after the fact. The monetary estimate is deliberately not
implemented — provider pricing changes and a stale constant is worse than none.