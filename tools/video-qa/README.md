---
name: "video-qa"
description: "Visual QA gate for data-race videos: checks a rendered MP4 against its frames.json/video-spec.json bundle for proportional bars, stable layout, smooth tweens, and correct labels/rank order. Run after every render, before shipping."
metadata: { "includeInPrompt": true }
---

# video-qa

Post-render visual gate for data-race videos. It watches the actual MP4
(pixel measurements with OpenCV) and compares what it sees against the
bundle's `frames.json` / `video-spec.json`, catching the visual bug classes
that unit tests on the data pipeline miss.

## When to use

Run `bin/check-video.py` after **every** render (local or CI), before the
video ships to the user. It is the last gate in the render pipeline.

## How to run

```bash
# deps (once): pip install opencv-python-headless numpy pillow  (plus ffmpeg on PATH)
~/workspace/skills/video-qa/bin/check-video.py <video.mp4> \
  --frames bundles/<bundle-id>/ \
  --out /tmp/videoqa/report.json
```

`--frames` takes the bundle directory (must contain `frames.json` and
`video-spec.json`) or a direct path to `frames.json`.
`--samples N` controls how many settled year-frames are checked (default 8).

Exit codes: **0** = clean, **1** = violations found, **2** = usage/environment
error (missing deps, ffmpeg failure, bad bundle). Warnings (prefixed `!`)
never fail the gate.

## What it checks

Sampling is scene-aware: `video-spec.json` maps each `bar_race` scene's
`tapeRange` to screen frames. Checks run on **settled mid-year frames**
(year boundaries are transition zones where rows overlap — sampling there
produces false failures), plus dense probes across each race scene's
opening seconds.

| Check | What it measures | Bug it catches |
|---|---|---|
| `C1-non-proportional-bars` | Bar-width ratios vs value ratios for every pair of bars > 40px; must match within 12% | The `Math.max(110, …)` min-width clamp: 7% and 1% rendering at the same 110px width |
| `C1-identical-widths` | Bars > 20px rendering at the same width (±3%) with ≥ 1.5× value ratio | Same clamp, stated bluntly |
| `C2-layout-unstable` | Leader-bar width (value fraction = 1.0) across scene openings + all year-frames, grouped by spotlight-card visibility; spread must be ≤ 12px | The `740 - 150*panelAppear` bug: every bar visibly shrinking/growing back each time the spotlight card fades ("refreshing" bars) |
| `C2-bar-shifted` | Leader's left edge must stay pinned at x=96 (±6px) | Bars sliding horizontally on refresh |
| `C3a-tween-overshoot` | Top-3 bars probed at 0.2s steps: width must stay within the 0.6s endpoint range (±4%, min 15px) | Jerky / resetting tweens |
| `C3b-label-*` | Name text present in/after each bar; value text after bar end | Missing or clipped labels |
| `C3c-rank-order` | Dominant brand color per row band must match frames.json rank order | Bars in the wrong order |
| `C3c-bar-missing` / `C3c-rank-label-missing` | Every expected bar and rank number is actually drawn | Dropped rows / missing rank numerals |

Measurement notes (why it doesn't cry wolf):

- Bar width uses a **full-height column profile** through the bar's vertical
  span, not a center-line scan: the white name painted *inside* wide bars
  breaks single-line scans (they stop at the first long word), and the
  rounded pill ends break near-edge scans.
- Brand colors are matched in HSV with a BGR fallback for near-gray colors;
  the gloss gradient is accounted for in the saturation floor.
- The 4px visibility stub for near-zero values is exempt from the
  identical-widths check; pairs under 40px are exempt from proportionality.
- `C2-inconclusive` is a warning, not a failure: if the card never changes
  state across samples, the layout-vs-card comparison is skipped.

## Interpreting failures

- **C1 fires**: the renderer's bar-width formula has a clamp/floor. Fix:
  `barW = Math.max(4, widthFrac * maxBarWidth)` — strictly proportional,
  4px stub only.
- **C2 fires**: something per-frame (spotlight card fade, panel animation)
  is feeding into the race width. Fix: `maxBarWidth` must be a constant;
  the card may fade freely without moving any bar.
- **C3a fires**: the year-to-year interpolation overshoots — check the
  easing/spring parameters.
- **C3c fires**: the row order in the video disagrees with frames.json —
  usually a stale bundle or a rank-swap transition bug.

Each violation carries `frame` (video frame), `tape_index`, and `scene` so
you can extract the exact frame with ffmpeg and look at it.

## Suggested CI gate (document only — wire it up in the workflow file)

```yaml
# .github/workflows/render-video.yml — after the MP4 is produced
- name: Video QA gate
  run: |
    pip install opencv-python-headless numpy pillow
    ~/workspace/skills/video-qa/bin/check-video.py \
      out/final.mp4 --frames bundles/${{ inputs.bundle }} \
      --out /tmp/videoqa/report.json
```

Validated 2026-09-23 against two pre-fix renders (both 1280×720):

- **browsers** (`old-browsers.mp4`, 14280 frames): 66 violations, 0 warnings,
  0 false positives — C1 (110px clamp, e.g. netscape 4.81% vs opera 0.78%
  both at 110px) and C2 (leader 585px card-shown vs 739px card-hidden,
  154px spread matching the old `740 - 150*panelAppear` formula).
- **population** (`old-population.mp4`, ~38000 frames, 10 rows): 85
  violations, 0 warnings, 0 false positives — C1, C2 (151px spread). The
  sibling checks also caught a real label-overlap between two rows'
  outside labels on one sampled frame. (Settled checks skip each race
  scene's first year-block: the entrance transition there briefly
  overlaps rows.)
