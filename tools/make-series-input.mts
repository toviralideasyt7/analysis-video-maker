#!/usr/bin/env tsx
/**
 * Build a race-video input from one Our World in Data grapher series.
 *
 *   npx tsx tools/make-series-input.mts ^
 *     --slug annual-co2-emissions-per-country ^
 *     --title "CO2 Emissions by Country | 1900 - 2024" ^
 *     --metric "Annual CO2 emissions" --unit "tonnes" ^
 *     --start 1900 --target-minutes 10 --out input/examples/co2.json
 *
 * Everything here is deterministic: the numbers come straight out of the OWID
 * CSV, flags and groups come from the offline country table, and the side-panel
 * facts are derived from the data (who led, when the lead changed hands). No AI
 * writes a number.
 *
 * Pacing is driven by a target duration: sampling step and seconds-per-frame are
 * computed from the target minutes, so long histories stay watchable.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  searchOwidCharts,
  fetchOwidCsv,
  fetchOwidMetadata,
  parseOwidCsv,
  isOwidAggregate,
  owidCsvUrl,
} from './sources/owid';
import { countryInfo } from './sources/regions';
import { validateVideoInput } from '@avm/shared';
import type { VideoInput, VideoInputEntity, VideoInputFact, VideoInputSeriesPoint } from '@avm/shared';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
const numArg = (name: string, fallback: number): number => {
  const raw = arg(name);
  const value = raw === undefined ? Number.NaN : Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
};

/** Colour per World Bank region so groups read as coherent blocks. */
const REGION_COLORS: Record<string, string> = {
  'East Asia & Pacific': '#E1251B',
  'Europe & Central Asia': '#2563EB',
  'Latin America & Caribbean': '#F59E0B',
  'Middle East, North Africa, Afghanistan & Pakistan': '#16A34A',
  'North America': '#7C3AED',
  'South Asia': '#DB2777',
  'Sub-Saharan Africa': '#0891B2',
};
const FALLBACK_COLORS = ['#DC2626', '#0EA5E9', '#EAB308', '#22C55E', '#A855F7', '#F97316', '#14B8A6', '#EC4899'];
const colorFor = (region: string | undefined, index: number): string =>
  (region && REGION_COLORS[region]) || FALLBACK_COLORS[index % FALLBACK_COLORS.length];

const slugify = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return (value / 1e12).toFixed(2) + ' trillion';
  if (abs >= 1e9) return (value / 1e9).toFixed(2) + ' billion';
  if (abs >= 1e6) return (value / 1e6).toFixed(1) + ' million';
  if (abs >= 1e3) return Math.round(value).toLocaleString('en-US');
  return value.toFixed(2);
}

async function main(): Promise<void> {
  const requestedSlug = arg('slug');
  const topic = arg('topic');
  let slug = requestedSlug;
  if (!slug && topic) {
    const charts = await searchOwidCharts(topic);
    slug = charts[0]?.slug;
    process.stdout.write('resolved topic "' + topic + '" -> ' + (slug ?? '(none)') + '\n');
  }
  if (!slug) {
    process.stderr.write('usage: --slug <owid-slug> (or --topic <query>) [--out file.json]\n');
    process.exit(2);
  }

  const metadata = await fetchOwidMetadata(slug).catch(() => undefined);
  const csv = await fetchOwidCsv(slug);
  const series = parseOwidCsv(csv, slug);
  const column = metadata ? Object.values(metadata.columns ?? {})[0] : undefined;

  const unit = arg('unit') ?? column?.unit ?? column?.shortUnit ?? 'units';
  const metric = arg('metric') ?? metadata?.chart?.title ?? slug;
  const title = arg('title') ?? metadata?.chart?.title ?? slug;

  // ---- filter years -------------------------------------------------------
  const allYears = series.observations.map((o) => o.year).filter((y) => Number.isFinite(y));
  const minYear = arg('start') ? Number.parseInt(String(arg('start')), 10) : Math.min(...allYears);
  const maxYear = arg('end') ? Number.parseInt(String(arg('end')), 10) : Math.max(...allYears);

  const inRange = series.observations.filter((o) => o.year >= minYear && o.year <= maxYear);

  // ---- country-only rows --------------------------------------------------
  // OWID aggregates are OWID_* codes. Anything without a real ISO3 country row
  // (aggregates, regions, "World") is excluded from the race itself.
  const countryRows = inRange.filter((o) => Boolean(countryInfo(o.code)) && !isOwidAggregate(o.code));
  const dropped = inRange.length - countryRows.length;

  if (countryRows.length === 0) {
    process.stderr.write('no country rows for ' + slug + ' between ' + minYear + ' and ' + maxYear + '\n');
    process.exit(1);
  }

  // ---- entity pool: anything that reaches the top slice in any year -------
  const byYear = new Map<number, Array<{ name: string; code: string; value: number }>>();
  for (const row of countryRows) {
    const bucket = byYear.get(row.year) ?? [];
    bucket.push({ name: row.entity, code: row.code, value: row.value });
    byYear.set(row.year, bucket);
  }
  const poolDepth = Math.max(numArg('topn', 12) * 2, 24);
  const pool = new Map<string, { name: string; code: string; best: number }>();
  for (const bucket of byYear.values()) {
    for (const item of bucket.sort((a, b) => b.value - a.value).slice(0, poolDepth)) {
      const current = pool.get(item.code);
      const best = Math.max(current?.best ?? 0, item.value);
      pool.set(item.code, { name: item.name, code: item.code, best });
    }
  }
  const poolSize = numArg('entities', 90);
  const selected = Array.from(pool.values()).sort((a, b) => b.best - a.best).slice(0, poolSize);

  const entities: VideoInputEntity[] = selected.map((item, index) => {
    const info = countryInfo(item.code);
    return {
      id: slugify(item.name),
      name: item.name,
      color: colorFor(info?.region, index),
      flagCode: info?.iso2 ?? null,
      group: info?.region ?? null,
    } as VideoInputEntity;
  });
  const selectedNames = new Set(entities.map((e) => e.name));
  const selectedCodes = new Set(selected.map((s) => s.code));

  // ---- sampling step from the frame budget -------------------------------
  const yearSpan = maxYear - minYear + 1;
  const maxFrames = numArg('max-frames', 150);
  const step = numArg('step', Math.max(1, Math.ceil(yearSpan / maxFrames)));
  const frames: number[] = [];
  for (let year = minYear; year <= maxYear; year += step) frames.push(year);
  if (frames[frames.length - 1] !== maxYear) frames.push(maxYear);

  const observations = countryRows
    .filter((row) => selectedCodes.has(row.code) && frames.includes(row.year))
    .map((row) => ({ entity: row.entity, date: String(row.year), value: row.value }));

  // ---- world total: every country in the series, summed per sample year ---
  const totalByYear = new Map<number, number>();
  for (const row of countryRows) {
    if (!frames.includes(row.year)) continue;
    totalByYear.set(row.year, (totalByYear.get(row.year) ?? 0) + row.value);
  }
  const worldTotal: VideoInputSeriesPoint[] = frames
    .filter((year) => totalByYear.has(year))
    .map((year) => ({ date: String(year), value: totalByYear.get(year)! }));

  // ---- facts derived from the data ----------------------------------------
  const leaders = frames.map((year) => {
    const bucket = (byYear.get(year) ?? []).sort((a, b) => b.value - a.value)[0];
    return bucket ? { year, ...bucket } : undefined;
  }).filter((row): row is { year: number; name: string; code: string; value: number } => Boolean(row));

  const maxFacts = numArg('facts', 8);
  const totalAt = (year: number): number => totalByYear.get(year) ?? 0;
  const first = leaders[0];
  const last = leaders[leaders.length - 1];

  // per-entity first/last sample for growth facts
  const span = new Map<string, { first: number; last: number; name: string }>();
  for (const year of frames) {
    for (const row of byYear.get(year) ?? []) {
      if (!selectedCodes.has(row.code)) continue;
      const current = span.get(row.code);
      if (!current) span.set(row.code, { first: row.value, last: row.value, name: row.name });
      else current.last = row.value;
    }
  }

  const draft: VideoInputFact[] = [];

  if (first) {
    draft.push({
      atDate: String(first.year),
      heading: 'WHERE IT BEGAN',
      body: first.name + ' led in ' + first.year + ' with ' + compact(first.value) + ' ' + unit +
        ' of ' + metric.toLowerCase() + ' - ' + (first.value / (totalAt(first.year) || 1) * 100).toFixed(1) +
        '% of everything recorded that year.',
      tiles: [first.name],
    });
  }

  // every hand-over of the number-one spot
  for (let i = 1; i < leaders.length; i += 1) {
    const previous = leaders[i - 1];
    const current = leaders[i];
    if (previous.name === current.name) continue;
    draft.push({
      atDate: String(current.year),
      heading: current.name.toUpperCase() + ' TAKES THE LEAD',
      body: current.name + ' overtook ' + previous.name + ' in ' + current.year +
        ' at ' + compact(current.value) + ' ' + unit + '.',
      tiles: [current.name, previous.name],
    });
  }

  // fastest overall riser between the first and last sample
  const risers = Array.from(span.values())
    .filter((item) => item.first > 0 && item.last / item.first > 1.2)
    .sort((a, b) => b.last / b.first - a.last / a.first);
  if (risers[0]) {
    const ratio = risers[0].last / risers[0].first;
    draft.push({
      atDate: String(maxYear),
      heading: 'FASTEST RISER',
      body: risers[0].name + ' multiplied its ' + metric.toLowerCase() + ' by ' +
        (ratio >= 10 ? Math.round(ratio).toLocaleString('en-US') : ratio.toFixed(1)) +
        'x over the period, reaching ' + compact(risers[0].last) + ' ' + unit + '.',
      tiles: [risers[0].name],
    });
  }

  // single largest year-on-year jump recorded in the pool
  let jump: { name: string; year: number; delta: number } | undefined;
  for (const item of selected) {
    let previous: number | undefined;
    for (const year of frames) {
      const row = (byYear.get(year) ?? []).find((candidate) => candidate.code === item.code);
      if (!row) { previous = undefined; continue; }
      if (previous !== undefined) {
        const delta = row.value - previous;
        if (!jump || delta > jump.delta) jump = { name: item.name, year, delta };
      }
      previous = row.value;
    }
  }
  if (jump && jump.delta > 0) {
    draft.push({
      atDate: String(jump.year),
      heading: 'BIGGEST SINGLE-YEAR JUMP',
      body: 'The largest one-year rise in the pool is ' + jump.name + ' in ' + jump.year +
        ', up ' + compact(jump.delta) + ' ' + unit + '.',
      tiles: [jump.name],
    });
  }

  // how much the recorded total grew across the whole span
  const firstTotal = totalAt(frames[0]);
  const lastTotal = totalAt(frames[frames.length - 1]);
  if (firstTotal > 0 && lastTotal > firstTotal) {
    const multiple = lastTotal / firstTotal;
    draft.push({
      atDate: String(frames[Math.floor(frames.length / 2)]),
      heading: 'THE RECORDED TOTAL',
      body: 'Across the period the combined total went from ' + compact(firstTotal) + ' to ' +
        compact(lastTotal) + ' ' + unit + ' - about ' +
        (multiple >= 10 ? Math.round(multiple).toLocaleString('en-US') : multiple.toFixed(1)) + 'x.',
      tiles: [],
    });
  }

  if (last) {
    draft.push({
      atDate: String(last.year),
      heading: 'WHERE IT STANDS',
      body: last.name + ' tops the ' + last.year + ' table at ' + compact(last.value) + ' ' + unit + ', ' +
        (last.value / (totalAt(last.year) || 1) * 100).toFixed(1) + '% of the recorded total.',
      tiles: [last.name],
    });
  }

  // Facts play in date order; the panel is capped so it never overflows.
  const facts = draft
    .sort((a, b) => Number(a.atDate) - Number(b.atDate))
    .slice(0, maxFacts)
    .map((fact) => ({ ...fact, tiles: fact.tiles ?? [] }));

  // ---- pacing -------------------------------------------------------------
  const introSeconds = numArg('intro', 5);
  const outroSeconds = numArg('outro', 8);
  const finalHoldSeconds = numArg('final-hold', 12);
  const targetMinutes = numArg('target-minutes', 10);
  const raceSeconds = Math.max(30, targetMinutes * 60 - introSeconds - outroSeconds - finalHoldSeconds);
  const secondsPerYear = arg('seconds-per-year')
    ? numArg('seconds-per-year', 5)
    : Number((raceSeconds / frames.length).toFixed(3));

  const input: VideoInput = {
    version: '1.0',
    title,
    metric,
    unit,
    valueFormat: (arg('format') as 'comma' | 'compact') ?? 'comma',
    canvas: { width: 1280, height: 720, fps: 60 },
    settings: {
      topN: numArg('topn', 12),
      secondsPerYear,
      scalePower: numArg('scale-power', 0.72),
      introSeconds,
      outroSeconds,
      finalHoldSeconds,
    },
    entities,
    observations,
    facts: facts.slice(0, maxFacts),
    groups: Object.entries(REGION_COLORS)
      .filter(([label]) => entities.some((e) => e.group === label))
      .map(([label, color]) => ({ id: slugify(label), label, color })),
    worldTotal,
    sources: metadata?.chart?.citation ?? ('Our World in Data - ' + owidCsvUrl(slug)),
    endingTitle: title,
  };

  const validation = validateVideoInput(input);
  if (!validation.valid) {
    process.stderr.write('video input failed validation:\n - ' + validation.errors.join('\n - ') + '\n');
    process.exit(1);
  }

  const outPath = resolve(arg('out') ?? ('input/generated/' + slug + '.json'));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(input, null, 2), 'utf8');

  process.stdout.write('slug=' + slug + ' unit=' + unit + '\n');
  process.stdout.write('years=' + minYear + '..' + maxYear + ' step=' + step + ' frames=' + frames.length + '\n');
  process.stdout.write('entities=' + entities.length + ' observations=' + observations.length + ' facts=' + input.facts!.length + ' dropped=' + dropped + '\n');
  process.stdout.write('secondsPerYear=' + secondsPerYear + ' totalSeconds=' + Math.round(introSeconds + frames.length * secondsPerYear + finalHoldSeconds + outroSeconds) + '\n');
  process.stdout.write('wrote ' + outPath + '\n');
}

main().catch((error) => {
  process.stderr.write(String(error?.stack ?? error) + '\n');
  process.exit(1);
});
