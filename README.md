# analysis-video-maker

Turns a topic into a **source-backed data-race video**:

```
topic → DataPlan → source discovery → extraction → verification → normalized
dataset → story → VideoSpec → human approval → GitHub Actions → MP4
```

It is deliberately *not* "LLM → video". An LLM only ever produces structured
artifacts (`DataPlan`, `Story`, `VideoSpec`); a deterministic renderer turns a
verified dataset into frames. Missing data stays missing.

## Repository layout

| Path | What it is |
|---|---|
| `crates/datarace-core` | Rust library: ingest, date/unit/entity normalization, ranking, frame tape, validation, hashing, MP4 probe |
| `crates/datarace-cli` | the `datarace` binary used by everything else |
| `packages/shared` | TypeScript types + JSON Schemas + runtime validators (the contract) |
| `services/orchestrator` | Node backend: AI providers, search, connectors, agents, pipeline, project store, HTTP API, GitHub dispatch |
| `renderer` | Remotion (React) renderer + thumbnail + render CLI |
| `apps/web` | Vite/React/Tailwind research dashboard with a browser preview |
| `tools` | CI gates: spec validation, frame-tape reproducibility |
| `.github/workflows` | `ci.yml` (tests) and `render-video.yml` (the render layer) |
| `docs` | architecture, data sources, video style |

## Prerequisites

- Node.js ≥ 20 (the project is developed on 22)
- Rust (stable) — the deterministic core
- ffmpeg on the machine doing the final encode (GitHub Actions has it; Remotion
  also ships its own encoder for local renders)

## Quick start

```bash
npm install                 # install all workspaces
cargo build --release -p datarace-cli   # build the Rust core (needed for frames)

cp .env.example .env        # then fill in what you have (see below)
npm run demo:connectors     # live smoke test of every dataset connector
npm run demo:plan           # ask the planner for a DataPlan
npm run demo:research -- "World Population by Country" --indicator SP.POP.TOTL
npm run render -- --project <projectDir>
```

Dashboard:

```bash
npm run serve -w @avm/orchestrator   # http://localhost:8787
npm run dev:web                      # http://localhost:5173
```

## Configuration

Everything secret is an environment variable (see `.env.example`). The minimum
useful set:

| Variable | Purpose |
|---|---|
| `GEMINI_WORKER_1`, `GEMINI_WORKER_2` | keyless Gemini web-proxy workers (AI planning/story) |
| `MONID_API_KEY` | Monid proxy → TinyFish search + fetch |
| `KAGGLE_USERNAME`, `KAGGLE_KEY` | Kaggle dataset search/download |
| `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_TOKEN` | dispatching the render workflow |
| `R2_*` | optional Cloudflare R2 upload of finished renders |
| `DATARACE_BIN` | explicit path to the Rust binary (otherwise auto-discovered) |
| `MAX_SEARCHES`, `MAX_SOURCES`, `MAX_AGENT_ROUNDS`, `MAX_TOKENS`, `MAX_RENDER_ATTEMPTS` | per-project cost limits |

Nothing in this repository contains a key. Never commit `.env`; for CI put the
values in repository secrets.

## The Rust core

```bash
cargo test --workspace                 # unit + integration tests
./target/release/datarace --help
./target/release/datarace frames --in dataset.json --out frames.json --top 10
./target/release/datarace validate --in dataset.json --strict
```

`datarace frames` is the hot path: it converts a full dataset into the exact
per-frame bar state the renderer draws, so the render never does data maths.

## Verification

```bash
cargo test --workspace      # Rust
npm run typecheck           # all TypeScript workspaces
npm test                    # vitest (shared schemas + pipeline behaviour)
```

CI runs all three. The render workflow additionally:

1. validates `video-spec.json` against the shared schema,
2. runs `datarace validate --strict` on the dataset,
3. recomputes the frame tape and fails if it does not match the shipped one,
4. renders, post-processes with ffmpeg, and probes the MP4.

## Status and honest limitations

Working end to end: planning, source discovery with scoring, extraction from
Our World in Data and the World Bank, verification, the quality gate, the frame
tape, story generation, VideoSpec/thumbnail generation, the dashboard with a
browser preview, GitHub dispatch, and the render pipeline.

Not finished (tracked, not hidden):

- **PDF and image uploads.** CSV/XLSX/JSON uploads work; PDF/image extraction is
  a documented TODO behind the same `connectors` interface.
- **Logo/photographic assets.** Entity identity renders as a colour monogram.
  The asset stage exists as `asset-plan.json` (what to fetch, which licence to
  check) but does not download logos yet.
- **UNdata/OECD/Eurostat/Hugging Face/AWS/Directory connectors** are implemented
  but only the OWID and World Bank paths are wired into automatic extraction;
  the others produce scored candidates.
- **Cost accounting** records tokens and durations per call; the monetary
  estimate is not implemented because provider pricing changes.
- The pure-TypeScript quality fallback is intentionally narrower than the Rust
  validator.

## Licence

MIT for the code (`LICENSE`). Data pulled through the connectors keeps its own
licence — every observation records the publisher and URL it came from.