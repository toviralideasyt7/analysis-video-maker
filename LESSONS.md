# LESSONS.md - every mistake that cost a render

Each entry here produced a wrong video, a failed run, or a silent regression. The rule in the
last column is now in the code; the guards are listed in `README.md` section 6 and implemented
in `packages/shared/src/sources.ts`, `renderer/src/tape.ts`, `renderer/src/ReferenceRace.tsx`
and `services/uploader/src/research-agent.ts`.

---

## A. Wrong data

### 1. Raced a comparison chart
Topic "richest countries of the world". Owid answered with `share-richest-1-wid-vs-pip`, whose
CSV is Entity,Code,Year **plus four data columns** (two income-share series, a Population series,
a World region series). The ingestion picked one column arbitrarily and the video labelled it
with another column's unit.

Rule: a chart with more than one value column is rejected outright
(`countValueColumns()` in `packages/shared/src/sources.ts`). A comparison chart cannot be raced.

### 2. Summed a non-additive metric into a "world total"
The same video printed **19** as the world total of an income-share metric. Shares, rates,
per-capita values and indices are properties of an entity, not quantities that add up.

Rule: `isAdditiveUnit()` gates the world total. Non-additive metrics show the leader's value
labelled `Top:` instead. Also: never write a unit without `safeUnit()` - Owid ships charts whose
metadata unit is the empty string, which fails schema validation.

### 3. Trusted Owid search with a wordy query
"world population by country" returned health-access charts, and the real `population` chart was
**not in the response at all**. "richest countries" returned an income-share chart. Ranking
cannot fix a result set that does not contain the answer.

Rule: walk a ladder of progressively simpler queries (full phrase -> filler words removed ->
first two words) and prefer an exact title match. Plus an intent table for phrasings search
cannot bridge (richest/wealthiest -> GDP per capita; most populous -> population; a request for
depth -> the long-run series).

### 4. Applied a recency window to a topic that asked for depth
"richest countries of the world from ancient old to 2022" was windowed to 150 years, so a
request for ancient history got 1990+.

Rule: a depth request (`ancient`, `history`, `long run`, `centuries`) overrides the recency
window.

### 5. Sampled the review summary from the wrong rows
The two-model review was shown "Afghanistan 2000=..." while the entity list said Macao, Qatar,
Singapore. The models objected to the mismatch, and they were right - the observations are in
file order, not ranked order.

Rule: sample the leading entities (the first six of the ranked entity list), and describe the
dataset's shape (entity count, leading twelve, unit, year span) instead of a truncated view.

### 6. Aggregates raced as countries
`OWID_*` codes, blank codes and "(UN)" suffixed names are regions, not countries.

Rule: exclude them whenever the table carries a country-code column, and filter `isAggregateName`
when it does not.

---

## B. Wrong rendering

### 7. The anti-overlap guard was fed back as easing memory
Each frame eased a row toward its rank, then pushed rows apart to guarantee separation, and
stored the **pushed** value as the next frame's starting point. Every frame the whole chart
ratcheted downward a little, so it drifted out of order and rows slid out of the visible band.
Invisible in stills; obvious in a slot dump.

Rule: the separation pass is **display-only**. Store the unseparated position
(`tools/debug-tape.mts` exists to catch exactly this).

### 8. The rank badge came from the pre-easing order
Mid-swap, a badge disagreed with the visible order (a smaller value sitting above a larger one).

Rule: the badge is taken from the final vertical order.

### 9. The info panel rendered blank for the intro and outro
A fact was only shown while `factIndex` was non-null, and no fact was active outside the race,
so the panel was empty whenever it appeared - which the user described as the extra info
"sometimes" showing.

Rule: fall back to the most recent fact reached, then the first one. Never render an empty
panel.

### 10. The frame accessor was off by the intro length
`tape.frames` is indexed by absolute frame, but the composition read
`frames[frame - introFrames]`, so everything rendered 300 frames behind.

Rule: check the index contract against the array, not the intention.

### 11. The last fact's window ended before the final hold
The narrative panel was blank for the whole final hold, because the last fact's `toFrame` was
`introFrames + raceFrames`.

Rule: the last fact must extend through the hold.

### 12. Values lost their decimals / gained noise
Per-capita metrics printed as whole numbers, and compact values mixed 2-decimal and 1-decimal.

Rule: one decimal for compact values; `formatValue` keeps decimals for small magnitudes.

---

## C. Broken links and sources

### 13. A data URL that was not `.csv` fell through every branch
An earlier edit deleted the final `else` branch, so any `.zip` or other link left `plan`
undefined and the job died with "no plan could be built for this topic".

Rule: the fallback chain is explicit and ordered - Owid link -> plain table -> key-free direct
sources -> model-planned page read.

### 14. An Owid explorer link was ignored entirely
`/explorers/<name>.zip?...&Indicator=...` never matches a grapher slug, so it was dropped and the
topic was used instead.

Rule: the `Indicator` parameter of an explorer link is the search phrase.

### 15. Kaggle answered a browser User-Agent with an HTML reCAPTCHA page and HTTP 200
It looks like success and then fails to parse.

Rule: send a tool UA (`curl/8.9.1`). Also: dataset metadata is `/datasets/view/<ref>` but the
file list is `/datasets/list/<ref>`.

### 16. Monid's fetch strips image tags
It normalises a page to text, so it cannot be used for image scraping.

Rule: use plain HTTP when the site allows it (data-races.com does), and keep Monid for search and
as the last automated flag attempt.

### 17. Google Dataset Search has no public API
It is a JavaScript application; a plain fetch returns the app shell.

Rule: treat it as a human discovery layer. Use the Owid search API, the data-races catalog and
the World Bank `/search` endpoint for automated discovery.

---

## D. Broken deployments

### 18. Cloudflare Pages silently dropped its Functions bundle
Deploying `cloudflare/pages` from the repository root made `/api/login` return the static HTML
instead of the Worker's JSON, because wrangler resolves `functions/` relative to the **working
directory**, not the deploy target.

Rule: run from inside the studio folder and deploy `.`. Pin the wrangler CLI version in
`wrangler-action@v3`.

### 19. The Worker uploaded but refused to serve
The account had never registered a workers.dev subdomain, so the deploy ended with "register a
workers.dev subdomain".

Rule: `PUT /accounts/<id>/workers/subdomain` once, then `workers_dev = true`. Also note that a
new subdomain's TLS certificate takes a couple of minutes; the handshake fails until then.

### 20. `gh secret list` returns HTTP 404
The keyring token lacks admin:repo.

Rule: set secrets by value and keep the names documented in the workflows.

### 21. The wrong workflow trigger can clobber the live site
A push that touched the studio folder redeploys Pages.

Rule: verify the proxy (`/api/health` must return JSON) after any Pages deploy.

---

## E. Process mistakes

### 22. A full render was the only way to see a change
A 10-minute video is 17 851 frames, so every layout iteration cost 20 minutes.

Rule: `--still <frame>` renders one frame. Check the layout with stills and an independent image
read before rendering.

### 23. Self-reports were trusted once
"Tests passed" and "input ok" were accepted without looking at the data, and a video shipped with
the wrong metric.

Rule: verify the data, not the log line. Dump the tape, print the observations, read a frame.

### 24. PowerShell string generation corrupted TypeScript twice
Here-strings flattened onto a single line, and `Math.Max` (PowerShell's casing) replaced
`Math.max`.

Rule: after any generated file, run the typecheck **and** grep for the intended content. Never
trust a write that reported success.

### 25. A failure was described as success
An earlier report said the chain was verified when only `rendering` had been observed; the final
`done` transition and the gofile link were still unproven.

Rule: name the exact stage that was observed. `rendering` is not `done`.

### 26. A gate blocked a good job
The two-model review refused a correct dataset because the summary shown to it was lossy (six
entity names, unranked sample rows, a windowed span).

Rule: a gate needs a faithful summary. When a gate objects, assume the inputs to the gate are
wrong until proven otherwise.

---

## F. Repetition

The user has said "so many issues are coming again and again". The pattern behind every repeat:
a guard was added for the case that failed, and the next case failed one step earlier in the same
pipeline. The durable response is the fallback chain plus the reject-unusable-inputs rule, not
another special case.