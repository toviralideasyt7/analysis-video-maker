# Research stack (parked)

The research/agent half of the project: topic -> DataPlan -> source discovery
across 12 dataset providers -> extraction -> cross-source verification ->
quality gate -> story -> VideoSpec, with role-routed AI models (Gemini proxy
workers + Nara) and Monid search/fetch.

**Why it was parked:** the product needs a simple path first - the user supplies
the data file, GitHub Actions renders it. The research stack is the automation
of that data-gathering step, to be switched back on later.

**State when parked:** working end to end. World Bank and OWID extraction were
wired into the automatic path; the AI source-picker read real pages through
Monid fetch and chose between candidates; the text extractor had a verbatim-quote
guard against hallucinated numbers; the quality gate ran from Rust. CI was green
on the render path (research.yml ran the pipeline on a runner).

**Contents**

| Path | What it is |
|---|---|
| `orchestrator/` | the full Node service: agents, providers, connectors, pipeline, project store, HTTP API |
| `research.yml.old` | the workflow that ran research on Actions |
| `render-video.yml.old` | the previous render workflow (bundle-based) |

**Reviving it**

1. Move `orchestrator/` back to `services/orchestrator` and re-add it to the
   root `package.json` workspaces.
2. Restore `research.yml.old` to `.github/workflows/research.yml`.
3. `npm install` (its deps: hono, @hono/node-server, tsx, vitest).
4. Its tests live in `orchestrator/test/` and run with `npm test`.
5. The renderer it fed was replaced; point its VideoSpec output at
   `renderer/src/ReferenceRace.tsx` by regenerating a VideoInput JSON instead
   (the current input schema) - that is the only real integration work.

Secrets it needs: `NARA_API_KEY` (verify the account still serves the models in
`ROLE_MODELS` - availability changed during development), `MONID_API_KEY`,
`KAGGLE_USERNAME/KEY`, `GEMINI_WORKER_1/2`.