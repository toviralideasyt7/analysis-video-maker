# analysis-video-maker

**One data file in, one data-race MP4 out.**

```
upload a file  ->  GitHub Actions renders it  ->  download the MP4
     (CSV / JSON)        (Rust core + Remotion + ffmpeg)
```

The file contains everything the video shows: the numbers, the colors, the
flags, the fact texts, the group (continent) chart. There is no research step,
no source discovery, no AI in the critical path - the only network call in the
pipeline fills in a missing flag image.

## Quick start

```bash
npm install
cargo build --release --workspace        # Rust core (probe + validate)

# make a video from the example
npx tsx tools/csv-to-input.ts --in mydata.csv --out input.json \
  --title "My Video" --metric "World Population" --unit "people"
npm run render -w @avm/renderer -- --input input.json --out my-video.mp4
```

Or just start the uploader and the web page:

```bash
npm run dev:api     # http://localhost:8790  (commits + dispatches to GitHub)
npm run dev:web     # http://localhost:5173  (drag & drop upload)
```

## The input file

Schema: `packages/shared/schemas/video-input.schema.json` (validated before
anything renders). Required fields: `version`, `title`, `metric`, `unit`,
`observations`. Optional: `entities` (colors, flag codes, groups), `facts`
(the side-panel texts), `groups` (the mini chart), `worldTotal`, `settings`
(topN, secondsPerYear, scalePower, intro/outro seconds).

A CSV is accepted too - columns `entity,date,value`, plus optional
`color,flagCode,group`, and an optional second facts CSV
(`atDate,heading,body,tiles`). See `tools/csv-to-input.ts`.

## Animation (matches the reference format)

Measured from the reference video, reproduced frame-for-frame by
`renderer/src/tape.ts` + `renderer/src/ReferenceRace.tsx`:

- one continuous timeline; values interpolate between years, ranks slide;
- 15 rows, 42px pitch, bars flush from x=0, no track, square ends;
- entity name in white inside the bar before the flag at the bar end;
- value after the bar end, full numbers with commas;
- compressed bar scale (power 0.8) so the tail stays legible;
- side panel: current fact, flag tiles, pale pie, world total, huge grey year;
- small vertical chart of the groups with a glyph per column;
- 60 fps, year label ticks in whole years.

## Repository layout

| Path | What it is |
|---|---|
| `renderer/` | Remotion composition matching the reference + tape builder + render CLI |
| `services/uploader/` | upload API: validate -> commit to GitHub -> dispatch the render |
| `apps/web/` | Cloudflare Pages upload page (drag & drop) |
| `packages/shared/` | TypeScript types + JSON Schemas (the contract) |
| `crates/datarace-core` | Rust core: ingestion, validation, MP4 probing |
| `tools/` | CSV converter, input checker, flag/logo resolver |
| `input/examples/` | a full example: world population 1960-2024 |
| `legacy/research-stack/` | the earlier research/agent system, parked for later |

## GitHub Actions

`make-video.yml` (manual or API dispatch, `inputPath` = the committed file):

1. validates the input against the schema;
2. resolves missing flags/logos (country table -> Monid fetch -> AI, verified);
3. renders with Remotion at 60fps;
4. post-processes with ffmpeg and probes the MP4 with the Rust core;
5. uploads the MP4 + thumbnail as artifacts (optionally pushes to R2).

Trigger it from the web page, the uploader API, or `gh workflow run`.

## Configuration

Secrets/variables for the uploader service and Actions: `GITHUB_TOKEN`,
`GITHUB_OWNER`, `GITHUB_REPO`, `NARA_API_KEY`, `MONID_API_KEY`,
`GEMINI_WORKER_1/2`, and optionally the `R2_*` set. See
`docs/DEPLOYMENT.md` for the full list and what each one does.

## The parked research stack

`legacy/research-stack/` contains the earlier system: AI planning, source
discovery across 12 dataset providers, multi-model routing, cross-source
verification. It is complete and tested but was retired from the critical path
until the research automation is wanted again. Its README explains how to revive
it.

## Licence

MIT for the code. Flag images come from flagcdn.com at render time; datasets
keep their own licences.