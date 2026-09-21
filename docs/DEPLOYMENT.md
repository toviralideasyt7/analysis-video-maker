# Deployment

Four pieces. The data file is the only input; nothing else is user-managed.

```
Cloudflare Pages (upload page)
        |  POST file
        v
Uploader service (Render.com, ~zero config)
        |  commit to inputs/ + workflow_dispatch
        v
GitHub Actions (make-video.yml)
        |  validate -> resolve flags -> Remotion 60fps -> ffmpeg -> probe
        v
MP4 artifact (+ optional Cloudflare R2)
```

## 1. GitHub

```bash
gh repo create <owner>/analysis-video-maker --private --source . --push
```

Secrets:

```bash
gh secret set GITHUB_TOKEN       --body '<token with repo + workflow scope>'  # only for the uploader
gh secret set NARA_API_KEY       --body '<nara key>'       # optional: fills missing flags
gh secret set MONID_API_KEY      --body '<monid key>'      # optional: page fetch for logos
gh secret set R2_ACCESS_KEY_ID      --body '<r2 key id>'   # optional
gh secret set R2_SECRET_ACCESS_KEY  --body '<r2 secret>'   # optional
gh secret set R2_ACCOUNT_ID         --body '<account id>'  # optional
gh variable set R2_BUCKET           --body '<bucket>'      # optional
```

## 2. Uploader service

Any Node host works. On Render.com, import the repo and use:

```
build:  npm ci
start:  npm run serve -w @avm/uploader
health: /api/health
```

Environment: `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`, `ALLOWED_ORIGINS`
(the Pages URL), optional `MAX_UPLOAD_BYTES`.

## 3. Cloudflare Pages

```bash
npm run build -w @avm/web
npx wrangler pages deploy apps/web/dist --project-name analysis-video-maker
```

Set `VITE_API_BASE` to the uploader URL at build time.

## 4. The render workflow

`make-video.yml` is dispatched automatically by the uploader, or manually:

```bash
gh workflow run make-video.yml -f inputPath=inputs/my-video-input.json
```

Steps: schema check -> flag/logo resolution (offline table first, then Monid
fetch, then AI with a verified-asset check) -> Remotion render at 60fps ->
ffmpeg -> MP4 probe -> artifacts (+ R2 when configured).

## Costs and limits

GitHub Free gives 2,000 Actions minutes/month for private repos; a typical
render takes 4-8 minutes. Verify current quotas at
<https://docs.github.com/en/billing/concepts/product-billing/github-actions>.
Cloudflare Pages limits: <https://developers.cloudflare.com/pages/platform/limits/>

The AI step is optional and small (one short call per unknown entity): a video
with normal countries renders fine with no AI keys at all.