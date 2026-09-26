/**
 * Deterministic pipeline stages.
 *
 * Everything here is reproducible and testable without an AI call: source
 * scoring, observation construction, cross-source verification, data-quality
 * gating and the VideoSpec/ThumbnailSpec builders.
 *
 * The heavy math is delegated to the Rust core when the `datarace` binary is
 * available, with an explicit TypeScript fallback otherwise.
 */

import type {
  Conflict,
  DataQualityReport,
  Dataset,
  Observation,
  SourceCandidate,
  SourceRef,
  Story,
  ThumbnailSpec,
  VideoSpec,
  DataStatus,
  Frequency,
} from '@avm/shared';
import { runRustJson, rustAvailable, logger } from './runtime';

// ---------------------------------------------------------------------------
// Source scoring
// ---------------------------------------------------------------------------

export interface SourceScoreWeights {
  authority: number;
  directness: number;
  coverage: number;
  machineReadable: number;
  methodology: number;
  recency: number;
  consistency: number;
}

export const DEFAULT_WEIGHTS: SourceScoreWeights = {
  authority: 0.25,
  directness: 0.2,
  coverage: 0.15,
  machineReadable: 0.1,
  methodology: 0.15,
  recency: 0.05,
  consistency: 0.1,
};

/**
 * Technical source-quality score (0..1). Weights are configurable.
 * This is a data-quality metric only - it is not a ranking of anything else.
 */
export function sourceQualityScore(
  source: Pick<
    SourceCandidate,
    'authority' | 'directness' | 'coverage' | 'machineReadable' | 'methodologyTransparency' | 'recency' | 'consistency'
  >,
  weights: SourceScoreWeights = DEFAULT_WEIGHTS,
): number {
  const machine = source.machineReadable ? 1 : 0.35;
  const raw =
    source.authority * weights.authority +
    source.directness * weights.directness +
    source.coverage * weights.coverage +
    machine * weights.machineReadable +
    source.methodologyTransparency * weights.methodology +
    source.recency * weights.recency +
    source.consistency * weights.consistency;
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  return Math.max(0, Math.min(1, raw / total));
}

/** Score every candidate in place (returns a new array, does not mutate). */
export function scoreCandidates(
  candidates: SourceCandidate[],
  weights: SourceScoreWeights = DEFAULT_WEIGHTS,
): SourceCandidate[] {
  return candidates
    .map((c) => ({ ...c, qualityScore: sourceQualityScore(c, weights) }))
    .sort((a, b) => b.qualityScore - a.qualityScore);
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

export interface ObservationDraft {
  entity: string;
  entityId?: string;
  iso2?: string | null;
  flagCode?: string | null;
  date: string;
  frequency?: Frequency;
  value: number | null;
  unit: string;
  geography?: string;
  source: SourceRef;
  evidence?: Observation['evidence'];
  method?: 'direct' | 'calculated' | 'estimated';
  status?: DataStatus;
  confidence?: number;
}

let observationCounter = 0;

export function resetObservationCounter(): void {
  observationCounter = 0;
}

/**
 * Build an observation. A missing value is *always* serialised as `null` with
 * status UNKNOWN - there is no code path that substitutes a number.
 */
export function buildObservation(draft: ObservationDraft): Observation {
  observationCounter += 1;
  const value = draft.value === null || Number.isNaN(draft.value) ? null : draft.value;
  const status: DataStatus = value === null ? 'UNKNOWN' : (draft.status ?? 'SUPPORTED');
  const entityId = draft.entityId ?? draft.entity.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return {
    observationId: `obs_${String(observationCounter).padStart(5, '0')}`,
    entity: {
      id: entityId,
      name: draft.entity,
      iso2: draft.iso2 ?? null,
      flagCode: draft.flagCode ?? null,
      group: null,
    },
    date: draft.date,
    frequency: draft.frequency ?? inferFrequency(draft.date),
    value,
    unit: draft.unit,
    geography: draft.geography,
    source: draft.source,
    evidence: draft.evidence,
    method: draft.method ?? 'direct',
    status,
    confidence: draft.confidence,
  };
}

export function inferFrequency(date: string): Frequency {
  if (/^-?\d{1,5}-\d{2}-\d{2}/.test(date)) return 'daily';
  if (/^-?\d{1,5}-\d{2}$/.test(date)) return 'monthly';
  if (/^-?\d{1,5}-Q[1-4]$/i.test(date)) return 'quarterly';
  if (/^-?\d{1,5}$/.test(date)) return 'annual';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Extraction + verification hardening
// ---------------------------------------------------------------------------

/**
 * Common name variants that must resolve to one canonical entity, so that two
 * sources spelling a country differently still land in the same verification
 * cell (and the same bar) even when the Rust resolver is unavailable.
 */
const ENTITY_ALIASES: Record<string, string> = {
  'usa': 'United States',
  'u.s.a.': 'United States',
  'u.s.': 'United States',
  'united states of america': 'United States',
  'uk': 'United Kingdom',
  'u.k.': 'United Kingdom',
  'great britain': 'United Kingdom',
  'uae': 'United Arab Emirates',
  'south korea': 'Korea, Rep.',
  'republic of korea': 'Korea, Rep.',
  'korea, south': 'Korea, Rep.',
  'north korea': "Korea, Dem. People's Rep.",
  'russia': 'Russian Federation',
  'vietnam': 'Viet Nam',
  'iran': 'Iran, Islamic Rep.',
  'syria': 'Syrian Arab Republic',
  'laos': "Lao PDR",
  'moldova': 'Moldova, Rep.',
  'macedonia': 'North Macedonia',
  'ivory coast': "Cote d'Ivoire",
  "côte d'ivoire": "Cote d'Ivoire",
  'tanzania': 'Tanzania, United Rep.',
  'bolivia': 'Bolivia, Plurinational State of',
  'venezuela': 'Venezuela, RB',
  'egypt': 'Egypt, Arab Rep.',
  'yemen': 'Yemen, Rep.',
  'kyrgyzstan': 'Kyrgyz Republic',
  'slovakia': 'Slovak Republic',
  'czechia': 'Czech Republic',
  'czech republic': 'Czech Republic',
  'eswatini': 'Eswatini',
  'swaziland': 'Eswatini',
  'turkey': 'Turkiye',
  'türkiye': 'Turkiye',
  'cape verde': 'Cabo Verde',
  'east timor': 'Timor-Leste',
  'brunei': 'Brunei Darussalam',
  'gambia': 'Gambia, The',
  'bahamas': 'Bahamas, The',
  'congo': 'Congo, Rep.',
  'democratic republic of the congo': 'Congo, Dem. Rep.',
  'drc': 'Congo, Dem. Rep.',
  'hong kong': 'Hong Kong SAR, China',
  'macao': 'Macao SAR, China',
  'palestine': 'West Bank and Gaza',
  'republic of congo': 'Congo, Rep.',
  'ivory coast republic': "Cote d'Ivoire",
  'united arab emirates': 'United Arab Emirates',
  'saudi': 'Saudi Arabia',
  'south africa': 'South Africa',
  'new zealand': 'New Zealand',
  'sri lanka': 'Sri Lanka',
  'costa rica': 'Costa Rica',
  'dominican republic': 'Dominican Republic',
  'el salvador': 'El Salvador',
  'puerto rico': 'Puerto Rico',
  'trinidad and tobago': 'Trinidad and Tobago',
  'bosnia': 'Bosnia and Herzegovina',
  'bosnia and herzegovina': 'Bosnia and Herzegovina',
  'north macedonia': 'North Macedonia',
  'timor-leste': 'Timor-Leste',
  'eswatini (swaziland)': 'Eswatini',
};

/** Canonical display name for an entity (alias map first, then the raw name). */
export function aliasEntityName(name: string): string {
  const key = name.trim().toLowerCase().replace(/\s+/g, ' ');
  return ENTITY_ALIASES[key] ?? name.trim().replace(/\s+/g, ' ');
}

/** Suffixes that never change an entity's identity ("Apple Inc." is still Apple). */
const CORPORATE_SUFFIXES = /\s*\b(inc|ltd|llc|corp|corporation|co|company|gmbh|s\.?a\.?|s\.?r\.?l\.?|pty|plc|bv|nv|ab|asa|oyj|k\.?k\.?)\.?$/i;

/**
 * Strip trailing corporate suffixes so "Apple", "Apple Inc." and
 * "APPLE CORP" all resolve to the same entity. Never returns an empty
 * string: if stripping would erase the whole name, the name is kept.
 */
export function stripCorporateSuffix(name: string): string {
  let out = name.trim().replace(/\s+/g, ' ');
  let prev = '';
  while (prev !== out) {
    prev = out;
    out = out.replace(CORPORATE_SUFFIXES, '').trim();
  }
  return out === '' ? name.trim().replace(/\s+/g, ' ') : out;
}

/**
 * Stable grouping key for an entity across sources: suffix-stripped, aliased,
 * lower-cased, punctuation-collapsed. "USA", "United States" and
 * "United States of America" all become the same cell, as do
 * "Apple" and "Apple Inc.".
 */
export function canonicalEntityKey(name: string): string {
  return aliasEntityName(stripCorporateSuffix(name))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Parse a raw value cell that may carry scale words, currency symbols or a
 * percent sign. "1.2M" -> 1_200_000, "$45.2bn" -> 45_200_000_000,
 * "12.5k" -> 12_500, "37%" -> { value: 37, unitHint: 'percent' }.
 * Returns value null when the cell holds no parseable number.
 */
export function parseScaledNumber(raw: string): { value: number | null; unitHint?: 'percent' } {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '-' || /^n\/?a$/i.test(trimmed)) return { value: null };
  const isPercent = /%$/.test(trimmed);
  // Collapse all whitespace first ("1 234" -> "1234", "1.2 million" -> "1.2million").
  let cleaned = trimmed
    .replace(/\s+/g, '')
    .replace(/[$€£¥₹]/g, '')
    .replace(/,/g, '')
    .replace(/%$/, '');
  // Trailing or leading scale words: 1.2M, 3.4 billion, $45.2bn, 12.5k
  const multipliers: Array<[RegExp, number]> = [
    [/(trillion|tn|t)$/i, 1e12],
    [/(billion|bn|bln|b)$/i, 1e9],
    [/(million|mn|mln|m)$/i, 1e6],
    [/(thousand|k)$/i, 1e3],
  ];
  let multiplier = 1;
  for (const [pattern, factor] of multipliers) {
    if (pattern.test(cleaned)) {
      cleaned = cleaned.replace(pattern, '').trim();
      multiplier = factor;
      break;
    }
  }
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value)) return { value: null };
  return { value: value * multiplier, ...(isPercent ? { unitHint: 'percent' as const } : {}) };
}

/**
 * Reduce a unit word to its canonical base for comparison: "million",
 * "millions", "M" -> { unit: 'count', multiplier: 1e6 }; "percent"/"%" stay
 * percent; anything unrecognised passes through unchanged.
 */
export function normalizeUnitWord(unit: string): { unit: string; multiplier: number } {
  const u = unit.trim().toLowerCase();
  if (/^(million|millions|mn|mln|m)$/.test(u)) return { unit: 'count', multiplier: 1e6 };
  if (/^(billion|billions|bn|bln|b)$/.test(u)) return { unit: 'count', multiplier: 1e9 };
  if (/^(trillion|trillions|tn|t)$/.test(u)) return { unit: 'count', multiplier: 1e12 };
  if (/^(thousand|thousands|k)$/.test(u)) return { unit: 'count', multiplier: 1e3 };
  if (/^(percent|percentage|pct|%)$/.test(u)) return { unit: 'percent', multiplier: 1 };
  if (/^(count|number|people|persons|total|index|usd|dollars?)$/.test(u)) return { unit: u === 'dollars' || u === 'dollar' ? 'USD' : u, multiplier: 1 };
  return { unit: unit.trim() === '' ? 'count' : unit.trim(), multiplier: 1 };
}

/**
 * Identity of a source for *independence* purposes: normalised publisher name
 * plus the URL host. Two pages on the same domain, or two rows from the same
 * API URL, are the same source - not independent corroboration.
 */
export function publisherKey(o: Observation): string {
  const publisher = (o.source.publisher ?? '').trim().toLowerCase();
  let host = '';
  try {
    host = new URL(o.source.url ?? '').hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    host = '';
  }
  return `${publisher}||${host}`;
}

export interface PrimarySourcePick {
  /** publisherKey of the source */
  key: string;
  publisher: string;
  url: string;
  /** distinct entity|date cells this source covers */
  cells: number;
  observations: number;
  meanConfidence: number;
}

export interface SourceRanking {
  primary: PrimarySourcePick;
  ranked: PrimarySourcePick[];
}

/**
 * Single-source rule (standing user rule, 2026-09-23): a dataset's time
 * series must come from ONE source - one consistent snapshot/methodology.
 * Merging values collected from different sources (or the same topic
 * re-pulled on different days) into a single series is what corrupted the
 * empires dataset: mixed methodologies produced phantom values such as a
 * French empire in 2016. Other sources are still used to *verify* the
 * primary source's values, but their values never enter the dataset.
 *
 * The primary source is the one covering the most distinct entity|date
 * cells; ties break on mean confidence, then first-seen order.
 */
export function selectPrimarySource(observations: Observation[]): SourceRanking {
  const byKey = new Map<
    string,
    { publisher: string; url: string; cells: Set<string>; observations: number; confidenceSum: number; firstSeen: number }
  >();
  observations.forEach((o, idx) => {
    const key = publisherKey(o);
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        publisher: o.source.publisher ?? '',
        url: o.source.url ?? '',
        cells: new Set(),
        observations: 0,
        confidenceSum: 0,
        firstSeen: idx,
      };
      byKey.set(key, entry);
    }
    entry.cells.add(`${canonicalEntityKey(o.entity.name)}|${o.date}`);
    entry.observations += 1;
    entry.confidenceSum += typeof o.confidence === 'number' ? o.confidence : 0;
  });
  const withOrder = [...byKey.entries()].map(([key, e]) => ({ key, ...e }));
  withOrder.sort((a, b) => {
    if (b.cells.size !== a.cells.size) return b.cells.size - a.cells.size;
    const meanA = a.observations > 0 ? a.confidenceSum / a.observations : 0;
    const meanB = b.observations > 0 ? b.confidenceSum / b.observations : 0;
    if (meanB !== meanA) return meanB - meanA;
    return a.firstSeen - b.firstSeen;
  });
  const ranked: PrimarySourcePick[] = withOrder.map((e) => ({
    key: e.key,
    publisher: e.publisher,
    url: e.url,
    cells: e.cells.size,
    observations: e.observations,
    meanConfidence: e.observations > 0 ? e.confidenceSum / e.observations : 0,
  }));
  return { primary: ranked[0], ranked };
}

export function sourceRef(input: {  url: string;
  publisher: string;
  title?: string;
  publishedAt?: string | null;
  identifier?: string;
}): SourceRef {
  return {
    url: input.url,
    publisher: input.publisher,
    title: input.title,
    publishedAt: input.publishedAt ?? null,
    retrievedAt: new Date().toISOString(),
    identifier: input.identifier,
  };
}

// ---------------------------------------------------------------------------
// Dataset assembly + stats
// ---------------------------------------------------------------------------

/**
 * The range the data actually covers.
 *
 * The requested range and the observed range are different things: asking the
 * World Bank for 1990-2026 returns nothing for 2026, and a spec that keeps
 * claiming 2026 is stating something the dataset does not support. The QA agent
 * caught exactly this, so the dataset now reports what it observed.
 */
export function observedTimeRange(observations: Observation[], fallback: { start: string; end: string }): { start: string; end: string } {
  const yearOf = (d: string): number | null => {
    const m = /^(-?\d{1,5})/.exec(d.trim());
    return m ? Number(m[1]) : null;
  };
  const years = observations
    .map((o) => yearOf(o.date))
    .filter((y): y is number => y !== null)
    .sort((a, b) => a - b);
  if (years.length === 0) return fallback;
  const label = (y: number): string => (y > 0 ? String(y) : y === 0 ? '0' : `${-y} BC`);
  return { start: label(years[0]), end: label(years[years.length - 1]) };
}

/**
 * Trim a sparse head off the observations before the dataset is built.
 *
 * A bar race that opens with 1-3 bars (e.g. poverty data 1963-1980, where
 * only a handful of countries reported per year) looks broken on video.
 * Returns the observations starting at the first period with enough distinct
 * reporting entities to fill the chart (`topN`, capped by the entity count),
 * plus trim metadata. When no period reaches the bar the observations are
 * returned untouched — a thin dataset is better than an empty one.
 */
export function trimSparseHead(
  observations: Observation[],
  topN: number,
): { observations: Observation[]; trimmedFrom: string | null; droppedPeriods: number } {
  // Leading year of an ISO-ish date, BCE-aware ("-10000" -> -10000).
  const yearOf = (date: string): number | null => {
    const m = /^(-?\d{1,5})/.exec(date.trim());
    return m ? Number(m[1]) : null;
  };
  const fmtYear = (y: number): string => (y > 0 ? String(y) : y === 0 ? '0' : `${-y} BC`);
  const usable = observations.filter(
    (o) =>
      o.status !== 'CONFLICTING' &&
      o.status !== 'REJECTED' &&
      Number.isFinite(o.value) &&
      yearOf(o.date) !== null,
  );
  const entityCount = new Set(usable.map((o) => o.entity.id)).size;
  const needed = Math.max(2, Math.min(topN, entityCount));
  const perPeriod = new Map<number, Set<string>>();
  for (const o of usable) {
    const year = yearOf(o.date);
    if (year === null) continue;
    let set = perPeriod.get(year);
    if (!set) {
      set = new Set<string>();
      perPeriod.set(year, set);
    }
    set.add(o.entity.id);
  }
  const years = [...perPeriod.keys()].sort((a, b) => a - b);
  const firstFull = years.find((y) => (perPeriod.get(y)?.size ?? 0) >= needed);
  if (firstFull === undefined || firstFull === years[0]) {
    return { observations, trimmedFrom: null, droppedPeriods: 0 };
  }
  const droppedPeriods = years.filter((y) => y < firstFull).length;
  return {
    observations: observations.filter((o) => {
      const y = yearOf(o.date);
      return y !== null && y >= firstFull;
    }),
    trimmedFrom: fmtYear(firstFull),
    droppedPeriods,
  };
}
export function datasetStats(observations: Observation[]): Dataset['stats'] {
  const stats: Dataset['stats'] = {
    observations: observations.length,
    entities: new Set(observations.map((o) => o.entity.id)).size,
    verified: 0,
    supported: 0,
    estimated: 0,
    unknown: 0,
    conflicting: 0,
    rejected: 0,
  };
  for (const o of observations) {
    switch (o.status) {
      case 'VERIFIED':
        stats.verified += 1;
        break;
      case 'SUPPORTED':
        stats.supported += 1;
        break;
      case 'ESTIMATED':
        stats.estimated += 1;
        break;
      case 'UNKNOWN':
        stats.unknown += 1;
        break;
      case 'CONFLICTING':
        stats.conflicting += 1;
        break;
      case 'REJECTED':
        stats.rejected += 1;
        break;
    }
  }
  return stats;
}

export function buildDataset(input: {
  projectId: string;
  datasetId: string;
  name: string;
  metric: string;
  unit: string;
  timeRange: { start: string; end: string };
  frequency: Frequency;
  missingDataPolicy: Dataset['missingDataPolicy'];
  observations: Observation[];
  conflicts: Conflict[];
  version?: number;
  frozen?: boolean;
}): Dataset {
  return {
    datasetId: input.datasetId,
    projectId: input.projectId,
    name: input.name,
    metric: input.metric,
    unit: input.unit,
    timeRange: input.timeRange,
    frequency: input.frequency,
    missingDataPolicy: input.missingDataPolicy,
    version: input.version ?? 1,
    frozen: input.frozen ?? false,
    observations: input.observations,
    conflicts: input.conflicts,
    stats: datasetStats(input.observations),
    createdAt: new Date().toISOString(),
  };
}

export function datasetToCoreInput(dataset: Dataset): unknown {
  return {
    name: dataset.name,
    metric: dataset.metric,
    unit: dataset.unit,
    entities: Array.from(new Set(dataset.observations.map((o) => o.entity.name))).map((name) => ({ name })),
    observations: dataset.observations
      .map((o) => ({
        entity: o.entity.name,
        date: o.date,
        value: o.value,
        unit: o.unit,
        frequency: o.frequency,
        geography: o.geography,
        status: o.status,
        source: o.source.publisher,
        sourceUrl: o.source.url,
        confidence: o.confidence,
      })),
  };
}
// ---------------------------------------------------------------------------
// Cross-source verification
// ---------------------------------------------------------------------------

export interface VerificationResult {
  observations: Observation[];
  conflicts: Conflict[];
  /** Human-readable notes for the run log: unit mismatches, outliers, what was checked. */
  notes: string[];
  /** Set when singleSource mode picked one source for the dataset. */
  primarySource?: PrimarySourcePick;
  /** Cell count dropped in singleSource mode for having no primary-source value. */
  droppedCells?: number;
}

/**
 * Compare independent sources for the same entity/metric/date.
 *
 * Rules (from the specification, tightened):
 *   - same entity (canonicalised across name variants), same date, same base
 *     unit must hold, otherwise no comparison;
 *   - scale words are normalised for comparison only ("1.2 million" vs
 *     1_200_000 compare as the same cell); stored units are untouched;
 *   - a material disagreement becomes CONFLICTING, never a silent average;
 *   - agreement between 2+ INDEPENDENT sources raises the status to VERIFIED.
 *     Independent means different publishers on different hosts: two pages on
 *     the same domain, or two rows from the same API endpoint, are one source.
 *   - a value that jumps 100x+ between consecutive periods is flagged in the
 *     notes (it stays in the dataset, it just never auto-verifies on a jump).
 *   - singleSource: true collapses the dataset to ONE source (selectPrimarySource);
 *     other sources only verify, their values never merge into the series.
 */
export interface SanitizeResult {
  observations: Observation[];
  problems: string[];
}

/**
 * Pre-verification cleaning pass: drop observations that can never be trusted
 * (missing entity/date, non-finite values, negative counts) and say exactly
 * what was dropped. Runs before verifyAcrossSources so junk never reaches the
 * comparison cells.
 */
export function sanitizeObservations(observations: Observation[]): SanitizeResult {
  const kept: Observation[] = [];
  const problems: string[] = [];
  for (const o of observations) {
    const id = o.observationId || 'unknown';
    if (!o.entity?.name?.trim() || !o.date?.trim()) {
      problems.push(`dropped ${id}: missing entity or date`);
      continue;
    }
    if (o.value !== null && !Number.isFinite(o.value)) {
      problems.push(`dropped ${id} (${o.entity.name} ${o.date}): non-finite value`);
      continue;
    }
    if (o.value !== null && o.value < 0 && /count/i.test(o.unit ?? '')) {
      problems.push(`dropped ${id} (${o.entity.name} ${o.date}): negative count ${o.value}`);
      continue;
    }
    kept.push(o);
  }
  return { observations: kept, problems };
}

export function verifyAcrossSources(
  observations: Observation[],
  options: { tolerance?: number; metric?: string; outlierRatio?: number; singleSource?: boolean } = {},
): VerificationResult {
  const tolerance = options.tolerance ?? 0.05;
  const outlierRatio = options.outlierRatio ?? 100;
  const metric = options.metric ?? 'value';
  const notes: string[] = [];
  // Single-source mode: the dataset is built from ONE source only (see
  // selectPrimarySource). Other sources are compared against the primary
  // source's values for VERIFIED status and conflict detection, but their
  // values never enter the dataset - no merged series, ever. Cells the
  // primary source does not cover are dropped, not backfilled. A disputed
  // primary value is kept (the single source stands) and the dispute is
  // recorded as a conflict + note for the reviewer.
  const singleSource = options.singleSource === true && observations.length > 0;
  const ranking = singleSource ? selectPrimarySource(observations) : null;
  const primary = ranking?.primary ?? null;
  let droppedCells = 0;
  if (primary && ranking) {
    notes.push(
      `single-source: dataset values come from ONE source - ${primary.publisher || 'unknown publisher'} (${primary.url || 'no url'}), ` +
        `covering ${primary.cells} cells; ${ranking.ranked.length - 1} other source(s) used for verification only, never merged`,
    );
  }

  // Unit-mismatch scan first: same entity/date reported in genuinely different
  // base units (count vs percent) cannot be compared - say so explicitly.
  const cellUnits = new Map<string, Set<string>>();
  for (const o of observations) {
    if (o.value === null) continue;
    const key = `${canonicalEntityKey(o.entity.name)}|${o.date}`;
    const base = normalizeUnitWord(o.unit ?? 'count').unit;
    if (!cellUnits.has(key)) cellUnits.set(key, new Set());
    cellUnits.get(key)!.add(base);
  }
  for (const [key, units] of cellUnits) {
    if (units.size > 1) {
      notes.push(`unit mismatch at ${key}: reported as ${Array.from(units).join(' vs ')} - not compared, kept as separate observations`);
    }
  }

  const groups = new Map<string, Observation[]>();
  for (const o of observations) {
    if (o.value === null) continue;
    const norm = normalizeUnitWord(o.unit ?? 'count');
    const key = `${canonicalEntityKey(o.entity.name)}|${o.date}|${norm.unit}`;
    const list = groups.get(key) ?? [];
    list.push(o);
    groups.set(key, list);
  }

  const conflicts: Conflict[] = [];
  const decided: Observation[] = [];
  let verifiedCells = 0;
  let comparedCells = 0;

  const canonicalize = (o: Observation): Observation => {
    const key = canonicalEntityKey(o.entity.name);
    if (key === o.entity.id) return o;
    return { ...o, entity: { ...o.entity, id: key } };
  };

  for (const [key, group] of groups) {
    // Single-source mode: the decided observation is always the primary
    // source's. A cell the primary source does not cover is dropped, never
    // backfilled from another source - the series stays one source.
    const primaryObs = primary ? group.find((o) => publisherKey(o) === primary.key) : undefined;
    if (primary && !primaryObs) {
      droppedCells += 1;
      continue;
    }
    const cell = primaryObs ?? group[0];
    if (group.length === 1) {
      decided.push(canonicalize(cell));
      continue;
    }
    comparedCells += 1;
    const norm = normalizeUnitWord(group[0].unit ?? 'count');
    const values = group.map((o) => (o.value as number) * normalizeUnitWord(o.unit ?? 'count').multiplier / norm.multiplier);
    const min = Math.min(...values);
    const max = Math.max(...values);
    // Symmetric denominator: (max-min)/|max| understates agreement for
    // all-negative series (e.g. growth rates), where |max| is the value
    // closest to zero. Using the largest magnitude treats both signs alike.
    const magnitude = Math.max(Math.abs(max), Math.abs(min), 1e-9);
    const spread = (max - min) / magnitude;
    const publishers = new Set(group.map((o) => publisherKey(o)));

    if (spread <= tolerance && publishers.size >= 2) {
      // Two INDEPENDENT publishers agree -> verified. The primary source's
      // observation is kept (in single-source mode); otherwise the first.
      verifiedCells += 1;
      const rest = group.filter((o) => o !== cell);
      decided.push({
        ...canonicalize(cell),
        status: 'VERIFIED',
        confidence: Math.min(0.98, 0.75 + 0.05 * publishers.size),
        evidence: {
          ...(cell.evidence ?? {}),
          datasetUrl: cell.source.url,
          datasetVersion: `agree:${rest.length + 1}`,
        },
      });
      continue;
    }

    if (publishers.size < 2) {
      // Same source repeated (e.g. two pages on one domain): keep the first,
      // do not pretend this is corroboration.
      decided.push(canonicalize(cell));
      continue;
    }

    // Independent publishers disagree materially -> CONFLICTING, never averaged.
    conflicts.push({
      conflictId: `conflict_${conflicts.length + 1}`,
      entityId: canonicalEntityKey(group[0].entity.name),
      date: group[0].date,
      metric,
      unit: norm.unit,
      candidates: group.map((o) => ({
        observationId: o.observationId,
        value: o.value as number,
        sourceUrl: o.source.url,
        status: o.status,
      })),
      reason: `${publishers.size} independent publishers disagree by ${(spread * 100).toFixed(1)}% (min ${min}, max ${max})`,
      resolved: false,
    });
    if (primary && primaryObs) {
      // Single-source rule: the primary source's value stands - the dispute is
      // recorded above, never merged in as a second observation.
      decided.push(canonicalize(primaryObs));
      notes.push(
        `disputed: ${primaryObs.entity.name} @ ${primaryObs.date} - primary ${primary.publisher || 'source'} reports ${primaryObs.value}, ` +
          `${publishers.size - 1} other publisher(s) disagree; primary value kept (see conflicts)`,
      );
    } else {
      for (const o of group) decided.push({ ...canonicalize(o), status: 'CONFLICTING' });
    }
    void key;
  }

  // Outlier pass: flag period-to-period jumps that smell like a unit or
  // extraction error. Flagged values stay in the dataset; they are recorded
  // here so reviewers and the QA agent see them.
  const byEntity = new Map<string, Observation[]>();
  for (const o of decided) {
    if (o.value === null || o.value === 0) continue;
    const list = byEntity.get(o.entity.id) ?? [];
    list.push(o);
    byEntity.set(o.entity.id, list);
  }
  for (const [entityId, list] of byEntity) {
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1].value as number;
      const cur = sorted[i].value as number;
      const ratio = Math.abs(cur) / Math.abs(prev);
      if (ratio >= outlierRatio || ratio <= 1 / outlierRatio) {
        notes.push(
          `outlier: ${entityId} jumps ${ratio >= outlierRatio ? 'up' : 'down'} ${ratio >= 1 ? ratio.toFixed(1) : (1 / ratio).toFixed(1)}x ` +
          `between ${sorted[i - 1].date} (${prev}) and ${sorted[i].date} (${cur}) - possible unit/extraction error`,
        );
      }
    }
  }

  // Observations with no value still belong in the dataset, marked UNKNOWN.
  // In single-source mode only the primary source's nulls are kept.
  for (const o of observations) {
    if (o.value === null && (!primary || publisherKey(o) === primary.key)) decided.push(canonicalize(o));
  }

  if (primary && droppedCells > 0) {
    notes.push(
      `single-source: dropped ${droppedCells} cell(s) with no value from the primary source (not backfilled from other sources)`,
    );
  }

  logger.info('verification complete', {
    cells: groups.size,
    comparedCells,
    verifiedCells,
    conflicts: conflicts.length,
    notes: notes.length,
  });
  return { observations: decided, conflicts, notes, primarySource: primary ?? undefined, droppedCells };
}

/**
 * One-paragraph-per-line summary of a verification pass, for run logs and
 * the dashboard. Callers should persist this so every run shows its work.
 */
export function verificationSummary(result: VerificationResult): string[] {
  const lines: string[] = [];
  const byStatus = new Map<string, number>();
  for (const o of result.observations) byStatus.set(o.status, (byStatus.get(o.status) ?? 0) + 1);
  if (result.primarySource) {
    const p = result.primarySource;
    lines.push(
      `primary source: ${p.publisher || 'unknown publisher'} (${p.url || 'no url'}) - all ${result.observations.length} dataset values come from this one source` +
        (result.droppedCells ? `; ${result.droppedCells} cell(s) dropped for having no primary-source value` : ''),
    );
  }
  lines.push(
    `verification: ${result.observations.length} observations ` +
    `(VERIFIED ${byStatus.get('VERIFIED') ?? 0}, SUPPORTED ${byStatus.get('SUPPORTED') ?? 0}, ` +
    `UNKNOWN ${byStatus.get('UNKNOWN') ?? 0}, CONFLICTING ${byStatus.get('CONFLICTING') ?? 0}, ` +
    `REJECTED ${byStatus.get('REJECTED') ?? 0}); ${result.conflicts.length} conflicts`,
  );
  // Corroboration at a glance: only VERIFIED cells were seen by 2+ independent
  // publishers. Everything merely SUPPORTED rests on one publisher and was
  // never independently checked - that is the honest state of the evidence.
  const valued = result.observations.filter((o) => o.value !== null);
  const verified = byStatus.get('VERIFIED') ?? 0;
  const singlePublisher = valued.filter((o) => o.status === 'SUPPORTED').length;
  lines.push(
    `corroboration: ${verified} of ${valued.length} valued cells confirmed by 2+ independent publishers; ` +
    `${singlePublisher} rest on a single publisher (SUPPORTED, not independently verified)`,
  );
  for (const c of result.conflicts.slice(0, 10)) {
    lines.push(`conflict: ${c.entityId} @ ${c.date} - ${c.reason}`);
  }
  for (const n of result.notes.slice(0, 15)) lines.push(n);
  return lines;
}

// ---------------------------------------------------------------------------
// Data quality (Rust first, TypeScript fallback)
// ---------------------------------------------------------------------------

export async function dataQualityReport(dataset: Dataset): Promise<DataQualityReport> {
  const maxDate = new Date().toISOString().slice(0, 10);
  if (rustAvailable()) {
    try {
      // Same stdin caveat as the frame tape: write the payload to a temp file.
      const { mkdtempSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const work = mkdtempSync(join(tmpdir(), 'datarace-validate-'));
      const inFile = join(work, 'dataset.json');
      const outFile = join(work, 'quality.json');
      writeFileSync(inFile, JSON.stringify(datasetToCoreInput(dataset)), 'utf8');
      await runRustJson<DataQualityReport>(['validate', '--in', inFile, '--out', outFile, '--max-date', maxDate], {
        timeoutMs: 180_000,
      });
      const { readFileSync } = await import('node:fs');
      const report = JSON.parse(readFileSync(outFile, 'utf8')) as DataQualityReport;
      return { ...report, engine: 'rust' };
    } catch (error) {
      logger.warn('rust validate failed; using the TypeScript fallback', { error: String(error) });
    }
  }
  return typescriptQualityReport(dataset, maxDate);
}

/**
 * The dataset-level unit label: the unit most valued observations actually
 * carry. The old code hardcoded 'count', so a GDP dataset (units of USD) or a
 * share dataset (percent) was labelled "count" all the way to the video.
 * Ties prefer anything concrete over the 'count' fallback.
 */
export function majorityUnit(observations: Observation[]): string {
  const counts = new Map<string, number>();
  for (const o of observations) {
    if (o.value === null) continue;
    const unit = (o.unit ?? '').trim() || 'count';
    counts.set(unit, (counts.get(unit) ?? 0) + 1);
  }
  let best = 'count';
  let bestCount = 0;
  for (const [unit, n] of counts) {
    if (n > bestCount || (n === bestCount && best === 'count' && unit !== 'count')) {
      best = unit;
      bestCount = n;
    }
  }
  return best;
}

/** Pure-TS mirror of the Rust checks (kept deliberately simple and explicit). */
export function typescriptQualityReport(dataset: Dataset, maxDate: string): DataQualityReport {
  const checks: DataQualityReport['checks'] = [];
  const push = (name: string, details: string[]) =>
    checks.push({ name, passed: details.length === 0, violations: details.length, details });

  const obs = dataset.observations;
  push('schema', obs.length === 0 ? ['no observations present'] : []);
  push(
    'type',
    obs.filter((o) => o.value !== null && !Number.isFinite(o.value)).map((o) => `${o.observationId} has a non-finite value`),
  );
  push(
    'date',
    obs.filter((o) => !/^-?\d{1,5}(-\d{2}(-\d{2})?|(-Q[1-4]))?$/.test(o.date)).map((o) => `${o.observationId} date ${o.date} is not normalised`),
  );
  push(
    'unit',
    obs.filter((o) => !o.unit || o.unit.trim() === '').map((o) => `${o.observationId} has no unit`),
  );
  push(
    'range',
    obs.filter((o) => (o.value ?? 0) < 0 && o.unit === 'count').map((o) => `${o.observationId} is a negative count`),
  );
  push(
    'source',
    obs.filter((o) => !o.source?.url).map((o) => `${o.observationId} has no provenance url`),
  );
  const future = obs.filter((o) => o.date.slice(0, 10) > maxDate);
  push('temporal', future.map((o) => `${o.observationId} is dated ${o.date}, later than ${maxDate}`));
  push(
    'citation',
    obs.filter((o) => o.value !== null && !o.source?.publisher).map((o) => `${o.observationId} has a value without a publisher`),
  );

  const cells = new Map<string, Observation[]>();
  for (const o of obs) {
    // Unit-aware: the same entity/date in two different base units is a
    // unit mismatch, not a duplicate - it gets its own check below.
    const baseUnit = normalizeUnitWord(o.unit ?? 'count').unit;
    const key = `${canonicalEntityKey(o.entity.name)}|${o.date}|${baseUnit}`;
    const list = cells.get(key) ?? [];
    list.push(o);
    cells.set(key, list);
  }
  push(
    'duplicate',
    Array.from(cells.entries())
      // A cell holding two CONFLICTING observations is the designed outcome of
      // a genuine disagreement (see verifyAcrossSources), not a data defect.
      .filter(([, list]) => list.length > 1 && !list.every((o) => o.status === 'CONFLICTING'))
      .map(([key]) => `duplicate entity/date/unit cell ${key}`),
  );

  // Same entity/date reported in different base units (count vs percent).
  const unitCells = new Map<string, Set<string>>();
  for (const o of obs) {
    if (o.value === null) continue;
    const key = `${canonicalEntityKey(o.entity.name)}|${o.date}`;
    const baseUnit = normalizeUnitWord(o.unit ?? 'count').unit;
    if (!unitCells.has(key)) unitCells.set(key, new Set());
    unitCells.get(key)!.add(baseUnit);
  }
  push(
    'unit-mismatch',
    Array.from(unitCells.entries())
      .filter(([, units]) => units.size > 1)
      .map(([key, units]) => `unit mismatch at ${key}: ${Array.from(units).join(' vs ')}`),
  );

  // Outliers: period-to-period jumps of 100x+ smell like a unit or
  // extraction error. Reported, not auto-rejected.
  const outlierDetails: string[] = [];
  const series = new Map<string, Observation[]>();
  for (const o of obs) {
    if (o.value === null || o.value === 0) continue;
    const key = `${canonicalEntityKey(o.entity.name)}|${normalizeUnitWord(o.unit ?? 'count').unit}`;
    const list = series.get(key) ?? [];
    list.push(o);
    series.set(key, list);
  }
  for (const [, list] of series) {
    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1].value as number;
      const cur = sorted[i].value as number;
      const ratio = Math.abs(cur) / Math.abs(prev);
      if (ratio >= 100 || ratio <= 0.01) {
        outlierDetails.push(
          `${sorted[i].entity.name} jumps ${(ratio >= 1 ? ratio : 1 / ratio).toFixed(1)}x between ${sorted[i - 1].date} and ${sorted[i].date}`,
        );
      }
    }
  }
  push('outlier', outlierDetails);

  const sorted = [...obs].sort((a, b) => a.date.localeCompare(b.date));
  let rankingOk = true;
  for (const o of sorted) {
    if (o.value === null) continue;
    if (o.status === 'REJECTED') rankingOk = false;
  }
  push('ranking', rankingOk ? [] : ['rejected values are present in the dataset']);

  const violations = checks.reduce((sum, c) => sum + c.violations, 0);
  return {
    observations: obs.length,
    entities: new Set(obs.map((o) => o.entity.id)).size,
    checks,
    violations,
    passed: violations === 0,
    generatedAt: new Date().toISOString(),
    engine: 'typescript',
  };
}

// ---------------------------------------------------------------------------
// Rust frame tape
// ---------------------------------------------------------------------------

export interface FrameTapeEntity {
  id: string;
  name: string;
  flag?: string;
  flagCode?: string;
  color: string;
  logo?: string;
  image?: string;
  group?: string;
}

export interface FrameTapeBar {
  entityId: string;
  value: number;
  rank: number;
  previousRank?: number;
  width: number;
  held: boolean;
  rankDelta?: number;
  isMover: boolean;
}

export interface FrameTapeFrame {
  index: number;
  label: string;
  fromLabel: string;
  toLabel: string;
  t: number;
  isPeriodBoundary: boolean;
  maxValue: number;
  bars: FrameTapeBar[];
}

export interface FrameTape {
  fps: number;
  width: number;
  height: number;
  topN: number;
  framesPerTransition: number;
  durationInFrames: number;
  periodLabels: string[];
  entities: FrameTapeEntity[];
  frames: FrameTapeFrame[];
  notes: string[];
}

export interface FrameOptions {
  topN: number;
  framesPerTransition: number;
  fps: number;
  width: number;
  height: number;
  moverThreshold: number;
  policy: 'strict' | 'carryForward';
  /** Max trailing periods past an entity's last observation its value is carried. Undefined = unlimited. */
  maxCarryPeriods?: number;
}

export const DEFAULT_FRAME_OPTIONS: FrameOptions = {
  topN: 10,
  framesPerTransition: 30,
  fps: 30,
  width: 1280,
  height: 720,
  moverThreshold: 2,
  policy: 'carryForward',
  // A long-dead entity should not haunt the chart: the trailing carry past
  // the final observation is capped at ~10 years (buildFrameTape sizes it
  // from the dataset's years/period). Gaps within the observed lifespan are
  // always carried so sparse historical data doesn't flicker.
  maxCarryPeriods: 10,
};

export async function buildFrameTape(dataset: Dataset, options: Partial<FrameOptions> = {}): Promise<FrameTape> {
  const opts: FrameOptions = { ...DEFAULT_FRAME_OPTIONS, ...options };
  // The carry cap is in YEARS, not periods: with multi-year periods, "10
  // periods" carried a long-dead empire half a century into the future (the
  // Second French colonial empire was still #1 in 2021 on a value from 1976).
  // Tape periods are the distinct observation dates, so derive years/period
  // from the dataset and cap the carry at ~10 years of screen time.
  if (options.maxCarryPeriods === undefined) {
    const years = new Set<number>();
    for (const o of dataset.observations) {
      const m = /^(\d{1,4})/.exec(String(o.date ?? ''));
      if (m) years.add(parseInt(m[1], 10));
    }
    const sorted = [...years].sort((a, b) => a - b);
    const span = sorted.length > 1 ? sorted[sorted.length - 1] - sorted[0] : 1;
    const yearsPerPeriod = Math.max(1, span / Math.max(1, sorted.length - 1));
    opts.maxCarryPeriods = Math.max(1, Math.round(10 / yearsPerPeriod));
  }
  if (!rustAvailable()) {
    throw new Error('the datarace binary is required for frame-tape generation; build it with `cargo build --release`');
  }
  // The payload goes through a temp file rather than stdin: spawning the CLI
  // with a piped, never-closed stdin would block it forever waiting for EOF.
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const work = mkdtempSync(join(tmpdir(), 'datarace-frames-'));
  const inFile = join(work, 'dataset.json');
  const outFile = join(work, 'frames.json');
  writeFileSync(inFile, JSON.stringify(datasetToCoreInput(dataset)), 'utf8');
  return runRustJson<FrameTape>(
    [
      'frames',
      '--in',
      inFile,
      '--out',
      outFile,
      '--top',
      String(opts.topN),
      '--frames-per-transition',
      String(opts.framesPerTransition),
      '--fps',
      String(opts.fps),
      '--width',
      String(opts.width),
      '--height',
      String(opts.height),
      '--mover',
      String(opts.moverThreshold),
      '--policy',
      opts.policy,
      ...(opts.maxCarryPeriods !== undefined ? ['--max-carry', String(opts.maxCarryPeriods)] : []),
    ],
    { timeoutMs: 300_000 },
  ).then(async () => {
    const { readFileSync } = await import('node:fs');
    return JSON.parse(readFileSync(outFile, 'utf8')) as FrameTape;
  });
}

/** Resolve entity names to canonical ones through the Rust core. */
export async function resolveEntities(names: string[]): Promise<Map<string, { name: string; status: string; flagCode?: string | null; group?: string | null }>> {
  const out = new Map<string, { name: string; status: string; flagCode?: string | null; group?: string | null }>();
  if (names.length === 0) return out;
  try {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const work = mkdtempSync(join(tmpdir(), 'datarace-entities-'));
    const inFile = join(work, 'names.json');
    writeFileSync(inFile, JSON.stringify(names), 'utf8');
    const resolved = await runRustJson<Array<{ status: string; entity: { name: string; flagCode?: string | null; group?: string | null }; candidates?: string[] }>>(
      ['entities', '--in', inFile],
      { timeoutMs: 60_000 },
    );
    resolved.forEach((entry, index) => {
      const raw = names[index];
      if (raw === undefined) return;
      out.set(raw, { name: entry.entity.name, status: entry.status, flagCode: entry.entity.flagCode ?? null, group: entry.entity.group ?? null });
    });
  } catch (error) {
    logger.warn('entity resolution unavailable; keeping raw names', { error: String(error) });
  }
  return out;
}
// ---------------------------------------------------------------------------
// VideoSpec + ThumbnailSpec builders
// ---------------------------------------------------------------------------

export interface VideoSpecOptions {
  language?: string;
  theme?: Partial<Record<string, string | number>>;
  titleSeconds?: number;
  introSeconds?: number;
  endingSeconds?: number;
  sourceCardSeconds?: number;
  /** Target total runtime; the race is slowed and decade spotlights inserted to fill it. Default 480 (8 min). */
  targetDurationSeconds?: number;
  /** Seconds per decade-spotlight card. Default 14. */
  spotlightSeconds?: number;
}

/** Format a race value the same way the renderer does (duplicated to avoid a renderer import). */
function formatSpecValue(value: number, unit: string): string {
  if (!Number.isFinite(value)) return '-';
  if (unit === 'percent') return `${value.toFixed(2)}%`;
  const abs = Math.abs(value);
  const scaled =
    abs >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M`
    : abs >= 1_000 ? `${(value / 1_000).toFixed(1)}K`
    : `${Math.round(value)}`;
  return unit ? `${scaled} ${unit}` : scaled;
}

interface DecadeSpot {
  atLabel: string;
  kicker: string;
  headline: string;
  body: string;
  entityIds: string[];
}

/**
 * Deterministic decade-spotlight beats computed from the tape: for each
 * decade boundary, who led as the decade began and who climbed most in the
 * previous ten periods. No LLM needed, always consistent with the data.
 */
function buildDecadeSpotlights(tape: FrameTape, dataset: Dataset): DecadeSpot[] {
  const out: DecadeSpot[] = [];
  const fpt = Math.max(1, tape.framesPerTransition);
  const decades = ['1970', '1980', '1990', '2000', '2010', '2020'];
  const lastLabel = tape.periodLabels[tape.periodLabels.length - 1] ?? '';
  for (const decade of decades) {
    const pi = tape.periodLabels.indexOf(decade);
    if (pi < 0) continue;
    // The final decade card must agree with the video's ending: the leader is
    // whoever tops the last period (e.g. India in 2023, not China in 2020).
    const isFinal = decade === decades[decades.length - 1];
    const fi = isFinal
      ? tape.frames.length - 1
      : Math.min(pi * fpt, tape.frames.length - 1);
    const frame = tape.frames[fi];
    if (!frame) continue;
    const top = [...frame.bars].sort((a, b) => a.rank - b.rank).slice(0, 3);
    const ent = (id: string) => tape.entities.find((e) => e.id === id);
    const leader = top[0] ? ent(top[0].entityId) : undefined;
    const prevPi = Math.max(0, pi - 10);
    const prevFi = Math.min(prevPi * fpt, tape.frames.length - 1);
    const prevRank = new Map((tape.frames[prevFi]?.bars ?? []).map((b) => [b.entityId, b.rank]));
    let climber: { id: string; gain: number } | undefined;
    for (const b of frame.bars) {
      const pr = prevRank.get(b.entityId) ?? tape.topN + 5;
      const gain = pr - b.rank;
      if (gain > 0 && (!climber || gain > climber.gain)) climber = { id: b.entityId, gain };
    }
    const leaderName = leader?.name ?? '—';
    const leaderVal = top[0] ? formatSpecValue(top[0].value, dataset.unit) : '';
    const climberEnt = climber ? ent(climber.id) : undefined;
    const climberGain = climber?.gain ?? 0;
    const decadeName = `${decade.slice(0, 3)}0s`;
    const leadIn = isFinal
      ? `As of ${lastLabel}, ${leaderName} leads the world with ${leaderVal}.`
      : `As the ${decadeName} began, ${leaderName} led the world with ${leaderVal}.`;
    out.push({
      atLabel: decade,
      kicker: `THE ${decadeName.toUpperCase()}`,
      headline: `${leaderName} rules the ${decadeName}`,
      body: climberEnt && !isFinal
        ? `${leadIn} ${climberEnt.name} was the previous decade's biggest climber, rising ${climberGain} place${climberGain === 1 ? '' : 's'} into the top ${tape.topN}.`
        : leadIn,
      entityIds: top.map((b) => b.entityId),
    });
  }
  return out;
}

export const DEFAULT_THEME = {
  background: '#ffffff',
  surface: '#f4f5f7',
  primaryText: '#111827',
  secondaryText: '#6b7280',
  mutedText: '#c8ccd4',
  accent: '#e11d2e',
  barTrack: '#eef0f3',
  fontFamily: 'Inter',
} as const;

/**
 * Estimate the final video duration in seconds from content, using the same
 * math as buildVideoSpec. Used to size the story: the side facts card shows
 * roughly one fact per minute of video (a 4-minute video gets 4 facts).
 */
export function estimateDurationSeconds(
  tape: FrameTape,
  dataset: Dataset,
  options: VideoSpecOptions = {},
): number {
  const titleSeconds = options.titleSeconds ?? 8;
  const introSeconds = options.introSeconds ?? 25;
  const endingSeconds = options.endingSeconds ?? 15;
  const spotlightSeconds = options.spotlightSeconds ?? 14;
  const targetDuration = options.targetDurationSeconds ?? 480;
  const periods = tape.periodLabels.length;
  const spotlightTotal = buildDecadeSpotlights(tape, dataset).length * spotlightSeconds;
  const fixedSeconds = titleSeconds + introSeconds + endingSeconds;
  let raceSeconds = targetDuration - fixedSeconds - spotlightTotal;
  // Documentary pace: never faster than 3s/period. For big datasets (50+
  // periods), allow up to 10s/period so the race doesn't feel rushed — the
  // user explicitly wants slower pacing when there's lots of data.
  const maxPerPeriod = periods >= 50 ? 10 : 6;
  raceSeconds = Math.min(Math.max(raceSeconds, periods * 3), periods * maxPerPeriod);
  return fixedSeconds + spotlightTotal + raceSeconds;
}

/**
 * How many side-card facts the story should contain: roughly one per minute
 * of video, clamped to a sane range.
 */
export function factCountForTape(tape: FrameTape, dataset: Dataset): number {
  return Math.min(8, Math.max(2, Math.round(estimateDurationSeconds(tape, dataset) / 60)));
}

/**
 * Compose a VideoSpec from a verified dataset, the story and the frame tape.
 * Scene durations are content-derived; nothing is hard-coded to a fixed runtime.
 */
/** "1960-01-01" -> "1960"; leaves anything else alone. */
export function prettyLabel(raw: string): string {
  return raw.replace(/(\d{4})-01-01/g, '$1');
}

export function buildVideoSpec(input: { dataset: Dataset; story: Story; tape: FrameTape; options?: VideoSpecOptions }): VideoSpec {
  const { dataset, story, tape } = input;
  const options = input.options ?? {};
  const titleSeconds = options.titleSeconds ?? 8;
  const introSeconds = options.introSeconds ?? 25;
  const endingSeconds = options.endingSeconds ?? 15;
  const sourceCardSeconds = options.sourceCardSeconds ?? 12;
  const spotlightSeconds = options.spotlightSeconds ?? 14;
  const targetDuration = options.targetDurationSeconds ?? 480;

  const periods = tape.periodLabels.length;
  const fpt = Math.max(1, tape.framesPerTransition);
  const tapeFrames = tape.frames.length;

  // Split the race at decade boundaries so spotlight cards can pause the race
  // between chapters: [startPeriod, endPeriod) segments with tape ranges.
  const decadeStarts = [0];
  for (const d of ['1970', '1980', '1990', '2000', '2010', '2020']) {
    const pi = tape.periodLabels.indexOf(d);
    if (pi > 0) decadeStarts.push(pi);
  }
  decadeStarts.sort((a, b) => a - b);
  const segments: Array<{ startPeriod: number; endPeriod: number; startFrame: number; endFrame: number }> = [];
  for (let i = 0; i < decadeStarts.length; i++) {
    const sp = decadeStarts[i];
    const ep = i + 1 < decadeStarts.length ? decadeStarts[i + 1] : periods;
    if (ep > sp) {
      segments.push({
        startPeriod: sp,
        endPeriod: ep,
        startFrame: Math.min(sp * fpt, Math.max(0, tapeFrames - 1)),
        endFrame: Math.min(ep * fpt - 1, Math.max(0, tapeFrames - 1)),
      });
    }
  }
  if (segments.length === 0 && tapeFrames > 0) {
    segments.push({ startPeriod: 0, endPeriod: periods, startFrame: 0, endFrame: tapeFrames - 1 });
  }

  const spotlights = buildDecadeSpotlights(tape, dataset);
  // One spotlight after each segment except the last, keyed to the decade the
  // next segment opens on.
  const segSpotlights = segments.slice(0, -1).map((_, i) => {
    const nextDecade = tape.periodLabels[segments[i + 1].startPeriod];
    return spotlights.find((s) => s.atLabel === nextDecade);
  });

  const fixedSeconds = titleSeconds + introSeconds + endingSeconds;
  const spotlightTotal = segSpotlights.filter(Boolean).length * spotlightSeconds;
  let raceSeconds = targetDuration - fixedSeconds - spotlightTotal;
  // Documentary pace: never faster than 2s/period, never slower than 6s/period.
  raceSeconds = Math.min(Math.max(raceSeconds, periods * 2), periods * 6);
  const total = fixedSeconds + spotlightTotal + raceSeconds;

  const highlightFrames = (story.highlights ?? []).map((h) => {
    const periodIndex = Math.max(0, tape.periodLabels.indexOf(h.atLabel) + 1);
    const frame = Math.min(Math.max(0, periodIndex * tape.framesPerTransition - 8), Math.max(0, tape.durationInFrames - 1));
    return { atFrame: frame, ...h };
  });

  const finalFrame = tape.frames[tape.frames.length - 1];
  const topBar = finalFrame?.bars[0];
  const topEntity = topBar ? tape.entities.find((e) => e.id === topBar.entityId) : undefined;
  const summaryEntities = (finalFrame?.bars ?? []).slice(0, 3).map((b) => {
    const entity = tape.entities.find((e) => e.id === b.entityId);
    return entity
      ? { id: entity.id, name: entity.name, color: entity.color, flagCode: entity.flagCode }
      : { id: b.entityId, name: b.entityId, color: DEFAULT_THEME.primaryText };
  });

  const theme = { ...DEFAULT_THEME, ...(options.theme ?? {}) };

  const racePropsBase = {
    tapeRef: 'frames.json',
    topN: tape.topN,
    periodLabels: tape.periodLabels,
    highlights: highlightFrames,
    notes: tape.notes,
    summary: {
      heading: dataset.metric,
      value: topBar?.value ?? null,
      entityName: topEntity?.name ?? '',
      entityId: topEntity?.id ?? '',
      year: tape.periodLabels[tape.periodLabels.length - 1] ?? '',
      unit: dataset.unit,
      entities: summaryEntities,
    },
  };

  const datasetRange = `${dataset.timeRange.start} - ${dataset.timeRange.end}`;
  const scenes: VideoSpec['scenes'] = [
    { id: 'scene_title', type: 'title', duration: titleSeconds, title: story.title, subtitle: datasetRange },
    {
      id: 'scene_intro',
      type: 'intro',
      duration: introSeconds,
      // Never leave the intro blank: fall back to the video title when the
      // story hook/setup are missing (e.g. story step skipped).
      title: story.hook || story.title || dataset.name,
      subtitle: story.setup || datasetRange,
    },
  ];
  segments.forEach((seg, i) => {
    const segFrames = Math.max(1, seg.endFrame - seg.startFrame + 1);
    const segSeconds = Number((raceSeconds * (segFrames / Math.max(1, tapeFrames))).toFixed(2));
    scenes.push({
      id: `scene_race_${i + 1}`,
      type: 'bar_race',
      duration: segSeconds,
      datasetRef: dataset.datasetId,
      props: { ...racePropsBase, tapeRange: [seg.startFrame, seg.endFrame] },
    });
    const spot = segSpotlights[i];
    if (spot) {
      scenes.push({
        id: `scene_spotlight_${spot.atLabel}`,
        type: 'fact_box',
        duration: spotlightSeconds,
        title: spot.headline,
        props: {
          kicker: spot.kicker,
          atLabel: spot.atLabel,
          body: spot.body,
          entityIds: spot.entityIds,
        },
      });
    }
  });
  scenes.push(
    { id: 'scene_ending', type: 'ending', duration: endingSeconds, title: story.ending },
  );

  return {
    version: '1.0',
    metadata: {
      title: prettyLabel(story.title || dataset.name),
      // Subtitle MUST match dataset.timeRange exactly — AI-generated story.subtitle
      // often has off-by-one year errors that cause QA false rejections.
      subtitle: `${dataset.timeRange.start} - ${dataset.timeRange.end}`,
      language: options.language ?? 'en',
      durationSeconds: Number(total.toFixed(2)),
    },
    canvas: { width: tape.width, height: tape.height, fps: tape.fps },
    theme: theme as unknown as VideoSpec['theme'],
    datasetRef: dataset.datasetId,
    scenes,
    assets: [],
    sources: Array.from(new Map(dataset.observations.map((o) => [o.source.url, o.source])).values()),
  };
}

export function buildThumbnailSpec(input: { dataset: Dataset; story: Story; tape: FrameTape }): ThumbnailSpec {
  const { dataset, story, tape } = input;
  const finalFrame = tape.frames[tape.frames.length - 1];
  const entities = (finalFrame?.bars ?? [])
    .slice(0, 3)
    .map((b) => tape.entities.find((e) => e.id === b.entityId)?.name ?? b.entityId);
  const words = (story.title || dataset.name).split(' ');
  const split = Math.max(1, Math.ceil(words.length / 2));
  return {
    version: '1.0',
    title: words.slice(0, split).join(' ').toUpperCase(),
    subtitle: words.slice(split).join(' ').toUpperCase() || `${dataset.timeRange.start}-${dataset.timeRange.end}`,
    entities,
    assets: [],
    layout: 'ranking',
    backgroundColor: DEFAULT_THEME.background,
    accentColor: DEFAULT_THEME.accent,
  };
}

/**
 * Deterministic fallback story. It only ever states facts that exist in the
 * dataset and the frame tape.
 */
export interface TapeEvent {
  label: string;
  kind: 'newcomer' | 'jump' | 'overtake';
  entityId: string;
  name: string;
  rank: number;
  value: number;
  fromRank?: number;
}

/**
 * Interesting, data-grounded events per period boundary: newcomers entering
 * the topN for the first time, big rank jumps (>=3 places), lead changes and
 * record values. The story (LLM or deterministic) turns these into the side
 * facts card — never "X leads" narration, which the bars already show.
 */
export function tapeEvents(tape: FrameTape): TapeEvent[] {
  const events: TapeEvent[] = [];
  const nameOf = (id: string) => tape.entities.find((e) => e.id === id)?.name ?? id;
  const valueOf = (label: string, id: string): number => {
    const f = tape.frames.find((fr) => fr.isPeriodBoundary && fr.label === label);
    return f?.bars.find((b) => b.entityId === id)?.value ?? 0;
  };
  const topAt = (label: string): Array<{ id: string; rank: number }> => {
    const f = tape.frames.find((fr) => fr.isPeriodBoundary && fr.label === label);
    return (f?.bars ?? [])
      .slice()
      .sort((a, b) => a.rank - b.rank)
      .slice(0, tape.topN)
      .map((b, i) => ({ id: b.entityId, rank: i + 1 }));
  };
  const seen = new Set<string>();
  let prevRanks = new Map<string, number>();
  let prevLeader: string | undefined;
  for (const label of tape.periodLabels) {
    const top = topAt(label);
    const rankNow = new Map(top.map((t) => [t.id, t.rank]));
    for (const { id, rank } of top) {
      if (!seen.has(id)) {
        seen.add(id);
        events.push({ label, kind: 'newcomer', entityId: id, name: nameOf(id), rank, value: valueOf(label, id) });
      }
      const pr = prevRanks.get(id);
      if (pr !== undefined && pr - rank >= 3) {
        events.push({ label, kind: 'jump', entityId: id, name: nameOf(id), rank, value: valueOf(label, id), fromRank: pr });
      }
    }
    const leader = top[0]?.id;
    if (leader && prevLeader && leader !== prevLeader) {
      events.push({ label, kind: 'overtake', entityId: leader, name: nameOf(leader), rank: 1, value: valueOf(label, leader) });
    }
    if (leader) prevLeader = leader;
    prevRanks = rankNow;
  }
  return events;
}

/**
 * Deterministic side-card facts: pick factCountForTape() events spread across
 * the timeline, preferring newcomers, then big jumps, then overtakes. Each
 * fact is one interesting sentence about what is happening — never
 * "X leads." narration, which the bars already show.
 */
function deterministicFacts(
  tape: FrameTape,
  dataset: Dataset,
): Array<{ atLabel: string; text: string }> {
  const count = factCountForTape(tape, dataset);
  const events = tapeEvents(tape);
  if (events.length === 0) return [];
  // How interesting is an event? A lead change beats any debut; a high-rank
  // debut beats a low-rank one; a big climb beats a small one.
  const interest = (e: TapeEvent): number =>
    e.kind === 'overtake' ? 100 + (10 - e.rank)
    : e.kind === 'newcomer' ? 50 + (10 - e.rank)
    : 30 + ((e.fromRank ?? e.rank) - e.rank);
  // Spread picks across the timeline: split the label range into `count`
  // buckets and take the most interesting event from each bucket.
  const labels = tape.periodLabels;
  const idxOf = (label: string) => Math.max(0, labels.indexOf(label));
  const out: Array<{ atLabel: string; text: string }> = [];
  for (let b = 0; b < count; b++) {
    const lo = Math.floor((b * labels.length) / count);
    const hi = Math.floor(((b + 1) * labels.length) / count);
    const inBucket = events.filter((e) => {
      const i = idxOf(e.label);
      return i >= lo && i < hi && !out.some((o) => o.atLabel === e.label);
    });
    inBucket.sort((a, b2) => interest(b2) - interest(a));
    const ev = inBucket[0];
    if (!ev) continue;
    const val = formatSpecValue(ev.value, dataset.unit);
    const text =
      ev.kind === 'newcomer'
        ? `${ev.label}: ${ev.name} bursts into the ranking at #${ev.rank} with ${val}.`
        : ev.kind === 'jump'
          ? `${ev.label}: ${ev.name} surges from #${ev.fromRank} to #${ev.rank}.`
          : `${ev.label}: ${ev.name} takes the lead with ${val}.`;
    out.push({ atLabel: ev.label, text });
  }
  return out;
}

export function deterministicStory(dataset: Dataset, tape: FrameTape): Story {
  const labels = tape.periodLabels;
  const first = tape.frames[0];
  const last = tape.frames[tape.frames.length - 1];
  const leaderAt = (frame: FrameTapeFrame | undefined): string => {
    const id = frame?.bars[0]?.entityId;
    if (!id) return 'no data';
    return tape.entities.find((e) => e.id === id)?.name ?? id;
  };
  const movers = (last?.bars ?? []).filter((b) => b.isMover);
  const highlights = movers.slice(0, 3).map((b) => {
    const entity = tape.entities.find((e) => e.id === b.entityId);
    return {
      atLabel: last?.label ?? labels[labels.length - 1] ?? '',
      entityId: b.entityId,
      headline: `${entity?.name ?? b.entityId} moves`,
      detail: `${entity?.name ?? b.entityId} moved ${Math.abs(b.rankDelta ?? 0)} place(s) by ${last?.label ?? ''}.`,
    };
  });
  return {
    version: '1.0',
    title: dataset.name,
    subtitle: `${dataset.timeRange.start} - ${dataset.timeRange.end}`,
    hook: `${dataset.metric}, ${dataset.timeRange.start} to ${dataset.timeRange.end}.`,
    // YouTube-facing copy: what the video shows, never pipeline internals
    // (no entity/observation/verification counts — those read as debug output).
    setup: `The full race, year by year — watch the rankings shift from ${dataset.timeRange.start} to ${dataset.timeRange.end}.`,
    sequence: deterministicFacts(tape, dataset),
    highlights,
    ending: `${leaderAt(first)} starts first; ${leaderAt(last)} ends first.`,
    sourcesLine: `Data: ${Array.from(new Set(dataset.observations.map((o) => o.source.publisher))).join(', ')}`,
    generatedBy: { agent: 'deterministic-story', at: new Date().toISOString() },
  };
}