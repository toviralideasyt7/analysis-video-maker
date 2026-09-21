# Control plane (Cloudflare free tier only)

A password-gated studio that turns a typed topic into a finished video. No R2,
no paid storage: finished MP4s are published to **gofile.io** and only the link
is stored.

| Piece | Cloudflare product | Used for |
| --- | --- | --- |
| API | **Worker** | login, create job, list jobs, receive the workflow callback |
| Records | **D1** | `jobs` (durable state) + `events` (append-only trail) |
| Sessions | **KV** | session tokens, so a refresh keeps you signed in |
| UI | **Pages** | the studio page |

Everything the browser shows is rebuilt from D1 on load, so closing the tab or
refreshing mid-render loses nothing.

## Flow

```
Pages (topic)  ->  Worker  ->  D1 job row (status=queued)
                     |
                     +-> GitHub research.yml  (AI agent -> data -> input file)
                              |
                              +-> GitHub make-video.yml (render -> probe)
                                       |
                                       +-> gofile.io  (MP4 published)
                                       |
                                       +-> POST /api/hooks/render-complete
                                                   -> D1 status=done + video_url
```

## Deploy

```bash
cd cloudflare/worker
npm install

npx wrangler login
npx wrangler d1 create avm                     # paste database_id into wrangler.toml
npx wrangler kv namespace create SESSIONS      # paste id into wrangler.toml
npx wrangler d1 execute avm --file=./schema.sql --remote

npx wrangler secret put GH_TOKEN               # GitHub PAT: actions:write + contents:write
npx wrangler secret put HOOK_SECRET            # any long random string
npx wrangler secret put APP_PASSWORD           # optional; a default is coded in

npx wrangler deploy
```

Then publish the UI and point `/api/*` at the Worker:

```bash
cd ../pages
npx wrangler pages deploy . --project-name race-video-studio
```

Add a route for the Pages project (or a Worker route) so that
`https://<your-domain>/api/*` reaches this Worker. Same-origin is what the page
expects by default; if you host the API on a different hostname, set
`ALLOWED_ORIGIN` in `wrangler.toml` to the Pages origin and add
`<script>window.__API_BASE__ = "https://avm-control.<you>.workers.dev"</script>`
to `pages/index.html`.

## GitHub side

Add the repository secret used by both workflows:

| Name | Used by | Purpose |
| --- | --- | --- |
| `HOOK_SECRET` | research.yml, make-video.yml | must match the Worker secret |
| `KAGGLE_USERNAME`, `KAGGLE_KEY` | research.yml | Kaggle dataset search |
| `NARA_API_KEY`, `MONID_API_KEY` | both | AI + fetch proxy |

The workflows only call back when `JOB_ID`, `CALLBACK_URL` and `HOOK_SECRET` are
all present, so running them by hand still works with no control plane.

## Notes and limits

- **The password is currently a default in `src/index.ts`.** Set `APP_PASSWORD`
  as a Worker secret to move it out of the repository.
- **`GH_TOKEN` lives only as a Worker secret**, never in the repository.
- Free-tier ceilings: Workers 100k requests/day, D1 5 GB, KV 1 GB, Pages
  unlimited requests. A video is 100-200 MB and lives on gofile.io, not here.
- gofile.io links are temporary by nature. If a link expires, re-run the job:
  the input file is committed, so a re-render needs no new research.