# Video style

Derived from the supplied reference frames. The goal is to match the *format*
(the data-race grammar audiences already understand) with an **original**
look: our own layout proportions, typography scale, palette and motion.

## Reference layout (observed)

From two reference frames of the target format:

**Frame A — brand ranking, snapshot moment**

- 16:9, white background with a subtle light-grey edge vignette.
- Top-left: a small circular red mark containing a white bar-chart glyph.
- Top-centre: large bold black sans-serif title, e.g. `Most Popular Cell Phone
  Brands in the World`.
- Left ~60%: horizontal ranking bars, one row per entity. Each row is
  `colored bar → flag chip → brand wordmark/logo → entity name → value`. Bars
  are coloured per brand; the leader's bar runs nearly the full width.
- Right ~40%: a **fact panel** — bold heading (`Nokia Peak`), a one-sentence grey
  explanation, a very large light-grey date (`09/2008`), and a large entity
  wordmark. Below it, one or two product photos.
- The numbers are percentages with two decimals (`38.05%`, `16.2%`).

**Frame B — country ranking, historical moment**

- Same chrome: circular red mark, bold black title (`World Population by
  Country | 10000 bC - 2026`).
- Left: country rows with `colored bar → country name → national flag →
  9-digit population`.
- Bottom-middle: a second, smaller **vertical** bar chart (population by
  continent) with a coloured map icon capping each column and a value label.
- Bottom-right: a pale pie chart plus the stacked text `World Population` /
  `1,205 M` / and a huge light-grey `1841` for the current year.
- Large light-grey numerals are used for time; black is reserved for entities
  and titles.

## Our system (implemented)

| Element | Implementation | File |
|---|---|---|
| Canvas | 1280×720 @ 30fps, radial white→`#eef0f3` vignette | `renderer/src/components.tsx` (`Canvas`) |
| Accent mark | red circle + 3 white bars, top-left | `BrandMark` |
| Title | 40–66px, weight 800, tight tracking, top-left | `TitleBlock` |
| Ranking rows | 50px rows, bar + flag + monogram badge + name + value | `RankingRow` |
| Flags | optional `flagcdn` asset by ISO alpha-2, text fallback | `FlagChip` |
| Entity identity | **monogram badge** in the entity colour (no copyrighted logos shipped) | `LogoBadge` |
| Fact panel | accent rule, bold heading, grey body, huge light-grey date, wordmark | `FactBox` |
| Secondary chart | vertical bars grouped by region, value labels | `GroupBarChart` |
| Summary | metric heading, large value, pale ring, leader name | `PieSummary` + summary block |
| Time | large light-grey date stamp, always visible | `BigDate` |
| Movers | red ▲ with `+N entity` label | `HighlightArrow` |
| Honesty strip | notes about held/carried values and dropped rows | `NoteStrip` |
| Sources | closing card listing every publisher + URL | `SourceCard` |

## Motion rules

- Rows re-sort smoothly: animated ranks are pre-computed with a 12-frame
  cubic blend, so a rank change reads as a slide, not a jump.
- Bars interpolate value continuously between periods (the Rust core emits a
  per-frame tape; the renderer never does data maths).
- Values count up with the bar; they never snap.
- Scene durations are content-derived: title 6s, intro 8s, race
  `frames/fps`, ending 6s, sources 8s.

## Honesty in the picture

- A bar whose value is *carried forward* (no observation that period) is drawn
  at 55% opacity, and the reason is printed in the notes strip.
- Observations with no value are never drawn — they are counted in the intro
  statistics instead.
- Conflicting values are surfaced in the intro counts and in the sources card.

## Copyright position

Entity names and colours are used as nominative references. We do **not** ship
another channel's artwork, typography, thumbnails, scripts or narration, and we
do not embed third-party logo files in the repository. If a project wants real
logo files, they must be recorded in the asset table with a licence before
publishing (`asset-plan.json` is where that stage starts).