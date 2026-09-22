# Architecture

```
                 browser (apps/web · Vite + React + Tailwind)
                                │  REST
                                ▼
                 orchestrator (services/orchestrator · Node 22)
   ┌───────────────────────────────────────────────────────────────┐
   │ providers/ai        Gemini web-proxy workers, Nara router      │
   │ providers/search    Monid proxy → TinyFish search + fetch      │
   │ connectors/*        OWID, World Bank, Data Commons, UNdata,    │
   │                     OECD, Eurostat, Data.gov, Kaggle, HF,      │
   │                     AWS Open Data, discovery directories       │
   │ agents/*            planner, source hunter, judge, story,      │
   │                     video director, QA, revision, idea finder  │
   │ pipeline.ts         scoring, observations, verification,       │
   │                     quality gate, VideoSpec builder            │
   └───────────────┬───────────────────────────────┬───────────────┘
                   │ deterministic CPU work        │ dispatch
                   ▼                               ▼
        crates/datarace-core + CLI          GitHub Actions
        (ingest · dates · units · entities   ┌──────────────────┐
         · rank · frames · validate ·        │ render-video.yml │
         hash · probe)                       │ Remotion+ffmpeg  │
                   ▲                          └────────┬─────────┘
                   │ dataset.json / frames.json       │ MP4
                   └──────────────────────────────────┘
```

## Separation of concerns

The platform is deliberately **not** `LLM → video`. It is:

```
LLM → structured research → verified dataset → structured story
    → structured VideoSpec → deterministic renderer
```

- The orchestrator never renders.
- The renderer never fetches data or decides anything about the data.
- The Rust core owns every piece of maths that must be fast, deterministic and
  reproducible (ranking, frame tape, validation).

## Why Rust, and where

| Stage | Why it is in Rust |
|---|---|
| `ingest` | CSV/TSV/JSON/JSONL/XLSX parsing of large files before anything else touches them |
| `dates`/`units`/`entities` | millions of normalizations per run; must be identical across runs |
| `rank` | O(n log n) per period over full history, repeated on every revision |
| `frames` | the hot path: turns 50k+ observations into a per-frame tape for the renderer |
| `validate` | the CI gate; runs on every push and every render |
| `hash` | stable cache keys for the research cache |
| `probe` | MP4 validation in CI |

The TypeScript layer calls the compiled binary (`datarace`, discovered via
`DATARACE_BIN`, `target/{release,debug}`, or `PATH`) and consumes JSON. A pure-TS
fallback exists only for the data-quality report, so the pipeline still gives
useful output while the Rust binary is building.

## Project state and resumability

```
projects/{projectId}/
  project.json      state machine, checkpoints, revisions, limits
  plan.json         DataPlan (metric interpretations, risks, policy)
  sources.json      SourceCandidate[] with the quality score
  dataset.json      verified observations + conflicts (versioned, freezable)
  frames.json       the Rust frame tape
  story.json        Story (title, hook, sequence, highlights, fact boxes)
  video-spec.json   VideoSpec (scenes, theme, assets, sources)
  thumbnail.json    ThumbnailSpec
  quality.json      DataQualityReport
  revisions.json    revision history (rollback source)
  render-job.json   RenderJob + GitHub run id
  asset-plan.json   what assets are still needed, and their licence status
  logs/
```

Checkpoints: `PLAN_COMPLETE → SOURCES_COMPLETE → EXTRACTION_COMPLETE →
NORMALIZATION_COMPLETE → VERIFICATION_COMPLETE → DATASET_COMPLETE →
STORY_COMPLETE → VIDEOSPEC_COMPLETE → APPROVED → RENDER_COMPLETE`.
A rerun skips stages whose checkpoint is already present.

## Guards

- **No invention.** A missing measurement serialises as `value: null` +
  `status: UNKNOWN`. There is no code path that substitutes a number.
- **No silent averaging.** Disagreeing sources produce `CONFLICTING` plus a
  `Conflict` record with both candidates.
- **Quality gate.** `datarace validate --strict` exits non-zero on violations;
  CI fails, the render workflow fails, and `/approve` refuses.
- **Approval gate.** Only `APPROVED` projects can be dispatched to render.
- **Budget.** Search/fetch/AI calls are counted against `MAX_*` limits from the
  environment; the loops stop on budget instead of running forever.
- **Secrets.** Everything secret comes from the environment. `redact()` scrubs
  credential-shaped strings out of logs and usage records.

## Limits that are verified facts, not assumptions

Free-tier quotas change. Nothing in the codebase hard-codes a quota: they are
read from the environment and the docs point at the provider pages to check.
See `docs/DATA_SOURCES.md`.