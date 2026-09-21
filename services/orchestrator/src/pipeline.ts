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
  if (/^\d{4}-\d{2}-\d{2}/.test(date)) return 'daily';
  if (/^\d{4}-\d{2}$/.test(date)) return 'monthly';
  if (/^\d{4}-Q[1-4]$/i.test(date)) return 'quarterly';
  if (/^\d{4}$/.test(date)) return 'annual';
  return 'unknown';
}

export function sourceRef(input: {
  url: string;
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
}

/**
 * Compare independent sources for the same entity/metric/date.
 *
 * Rules (from the specification):
 *   - same metric / same date / same unit must hold, otherwise no comparison;
 *   - a material disagreement becomes CONFLICTING, never a silent average;
 *   - agreement between two independent sources raises the status to VERIFIED.
 */
export function verifyAcrossSources(
  observations: Observation[],
  options: { tolerance?: number; metric?: string } = {},
): VerificationResult {
  const tolerance = options.tolerance ?? 0.05;
  const metric = options.metric ?? 'value';
  const groups = new Map<string, Observation[]>();
  for (const o of observations) {
    if (o.value === null) continue;
    const key = `${o.entity.id}|${o.date}|${o.unit}`;
    const list = groups.get(key) ?? [];
    list.push(o);
    groups.set(key, list);
  }

  const conflicts: Conflict[] = [];
  const decided: Observation[] = [];

  for (const [key, group] of groups) {
    if (group.length === 1) {
      decided.push(group[0]);
      continue;
    }
    const values = group.map((o) => o.value as number);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const spread = max === 0 ? 0 : (max - min) / Math.abs(max);
    const distinctSources = new Set(group.map((o) => o.source.url));

    if (spread <= tolerance && distinctSources.size >= 2) {
      // Independent agreement -> verified. The first observation is kept.
      const [primary, ...rest] = group;
      decided.push({
        ...primary,
        status: 'VERIFIED',
        confidence: Math.min(0.98, 0.75 + 0.05 * distinctSources.size),
        evidence: {
          ...(primary.evidence ?? {}),
          datasetUrl: primary.source.url,
          datasetVersion: `agree:${rest.length + 1}`,
        },
      });
      continue;
    }

    if (spread > tolerance) {
      conflicts.push({
        conflictId: `conflict_${conflicts.length + 1}`,
        entityId: group[0].entity.id,
        date: group[0].date,
        metric,
        unit: group[0].unit,
        candidates: group.map((o) => ({
          observationId: o.observationId,
          value: o.value as number,
          sourceUrl: o.source.url,
          status: o.status,
        })),
        reason: `credible sources disagree by ${(spread * 100).toFixed(1)}% (min ${min}, max ${max})`,
        resolved: false,
      });
      for (const o of group) decided.push({ ...o, status: 'CONFLICTING' });
      continue;
    }

    // Same publisher repeated inside one cell: keep the first, do not duplicate.
    decided.push(group[0]);
    void key;
  }

  // Observations with no value still belong in the dataset, marked UNKNOWN.
  for (const o of observations) {
    if (o.value === null) decided.push(o);
  }
  return { observations: decided, conflicts };
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
    obs.filter((o) => !/^\d{4}(-\d{2}(-\d{2})?|(-Q[1-4]))?$/.test(o.date)).map((o) => `${o.observationId} date ${o.date} is not normalised`),
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

  const cells = new Map<string, number>();
  for (const o of obs) {
    const key = `${o.entity.id}|${o.date}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
  }
  push(
    'duplicate',
    Array.from(cells.entries())
      .filter(([, n]) => n > 1)
      .map(([key]) => `duplicate entity/date cell ${key}`),
  );

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
}

export const DEFAULT_FRAME_OPTIONS: FrameOptions = {
  topN: 10,
  framesPerTransition: 30,
  fps: 30,
  width: 1280,
  height: 720,
  moverThreshold: 2,
  policy: 'carryForward',
};

export async function buildFrameTape(dataset: Dataset, options: Partial<FrameOptions> = {}): Promise<FrameTape> {
  const opts: FrameOptions = { ...DEFAULT_FRAME_OPTIONS, ...options };
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
  const titleSeconds = options.titleSeconds ?? 6;
  const introSeconds = options.introSeconds ?? 8;
  const endingSeconds = options.endingSeconds ?? 6;
  const sourceCardSeconds = options.sourceCardSeconds ?? 8;
  const raceSeconds = tape.frames.length > 0 ? tape.durationInFrames / tape.fps : 1;
  const total = titleSeconds + introSeconds + raceSeconds + endingSeconds + sourceCardSeconds;

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

  return {
    version: '1.0',
    metadata: {
      title: prettyLabel(story.title || dataset.name),
      subtitle: prettyLabel(story.subtitle || `${dataset.timeRange.start} - ${dataset.timeRange.end}`),
      language: options.language ?? 'en',
      durationSeconds: Number(total.toFixed(2)),
    },
    canvas: { width: tape.width, height: tape.height, fps: tape.fps },
    theme: theme as unknown as VideoSpec['theme'],
    datasetRef: dataset.datasetId,
    scenes: [
      { id: 'scene_title', type: 'title', duration: titleSeconds, title: story.title, subtitle: story.subtitle },
      { id: 'scene_intro', type: 'intro', duration: introSeconds, title: story.hook, subtitle: story.setup },
      {
        id: 'scene_race',
        type: 'bar_race',
        duration: Number(raceSeconds.toFixed(2)),
        datasetRef: dataset.datasetId,
        props: {
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
        },
      },
      { id: 'scene_ending', type: 'ending', duration: endingSeconds, title: story.ending },
      { id: 'scene_sources', type: 'source_card', duration: sourceCardSeconds, title: 'Sources', props: { sourcesLine: story.sourcesLine } },
    ],
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
    setup: `${dataset.stats.entities} entities, ${dataset.stats.observations} observations, ${dataset.stats.verified} verified by independent agreement.`,
    sequence: labels.map((l) => ({ atLabel: l, text: `${l}: ${leaderAt(tape.frames.find((f) => f.isPeriodBoundary && f.label === l))} leads.` })),
    highlights,
    ending: `${leaderAt(first)} starts first; ${leaderAt(last)} ends first.`,
    sourcesLine: `Data: ${Array.from(new Set(dataset.observations.map((o) => o.source.publisher))).join(', ')}`,
    generatedBy: { agent: 'deterministic-story', at: new Date().toISOString() },
  };
}