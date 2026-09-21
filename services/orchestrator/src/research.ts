/**
 * End-to-end research driver: topic -> DataPlan -> sources -> observations ->
 * verification -> dataset -> frame tape -> story -> VideoSpec.
 *
 * Every stage writes a checkpoint, so a run that dies at any point can resume
 * instead of starting over. Nothing here fabricates a value: when a source
 * cannot be found or parsed, the observation is absent (or null + UNKNOWN) and
 * the failure is reported.
 */

import type {
  DataPlan,
  Dataset,
  SourceCandidate,
  Story,
  VideoSpec,
  ThumbnailSpec,
  Observation,
  DataQualityReport,
} from '@avm/shared';
import type { FrameTape } from './pipeline';
import {
  buildDataset,
  buildFrameTape,
  dataQualityReport,
  datasetToCoreInput,
  deterministicStory,
  inferFrequency,
  resolveEntities,
  scoreCandidates,
  sourceQualityScore,
  typescriptQualityReport,
  verifyAcrossSources,
  type FrameOptions,
} from './pipeline';
import {
  SOURCE_REGISTRY,
  ckanCandidates,
  ckanSearch,
  kaggleCandidates,
  kaggleSearch,
  owidFetch,
  uploadedCandidate,
  worldBankFetch,
  type UploadedFile,
} from './connectors';
import { Budget, createSearchProvider, hostOf } from './providers/search';
import { createAIClient, type AIClient } from './providers/ai';
import { JsonlLog, limits as loadLimits, logger, runRustJson } from './runtime';
import { ProjectStore, type ProjectState } from './project';
import {
  extractRowsFromText,
  huntSources,
  judgeSources,
  planTopic,
  selectBestSources,
  type AgentContext,
  type SourceSelection,
} from './agents';

export interface ResearchOptions {
  topic: string;
  projectId?: string;
  timeRange?: { start: string; end: string };
  entityCount?: number;
  topN?: number;
  framesPerTransition?: number;
  owidSlug?: string;
  worldBankIndicator?: string;
  entityFilter?: string[];
  uploads?: UploadedFile[];
  skipAi?: boolean;
  maxSearches?: number;
}

/** Plan used when no model is reachable: still declares the metric ambiguity. */
export function deterministicPlan(topic: string, options: ResearchOptions = { topic }): DataPlan {
  const range = options.timeRange ?? { start: '1990', end: String(new Date().getFullYear()) };
  const ambiguous = /\b(most popular|best selling|best-selling|most used|biggest|richest|most powerful|largest|most followed|top|greatest)\b/i.test(topic);
  return {
    version: '1.0',
    topic,
    metric: topic,
    metricAmbiguous: ambiguous,
    interpretations: ambiguous
      ? [
          { id: 'a', label: 'Measured quantity', description: 'the primary measurable quantity for this topic', measurableDefinition: 'a numeric value with an explicit unit per entity per period', recommended: true },
          { id: 'b', label: 'Alternative proxy', description: 'a different but defensible proxy for the same claim', measurableDefinition: 'a different numeric proxy, stated explicitly' },
        ]
      : [],
    metricAmbiguousOrUndefined: undefined,
    entityType: 'country',
    timeRange: range,
    frequency: 'annual',
    requiredFields: ['entity', 'date', 'value', 'unit', 'source'],
    candidateEntities: [],
    preferredSources: ['World Bank Open Data', 'Our World in Data', 'UNdata', 'OECD'],
    knownRisks: ambiguous
      ? ['the topic uses an ambiguous superlative; the metric definition must be confirmed before publishing']
      : [],
    missingDataPolicy: 'STRICT',
    targetEntityCount: options.entityCount ?? 10,
    generatedBy: { agent: 'deterministic-planner', at: new Date().toISOString() },
  } as DataPlan;
}

function buildAgentContext(options: ResearchOptions): AgentContext {
  const lim = loadLimits();
  const budget = new Budget(options.maxSearches ?? lim.maxSearches, lim.maxSearches * 4, lim.maxAgentRounds * 8);
  const search = createSearchProvider(budget);
  const ai: AIClient = createAIClient();
  return {
    ai,
    search,
    budget,
    limits: lim,
    runLog: new JsonlLog('agent-runs.jsonl'),
  };
}

/** Registry entries become candidates so the UI always shows the full catalogue. */
export function registryCandidates(): SourceCandidate[] {
  return SOURCE_REGISTRY.map((definition) => ({
    candidateId: `registry_${definition.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    sourceName: definition.name,
    publisher: definition.name,
    url: definition.url,
    kind: definition.type === 'directory' ? 'web' : definition.type === 'search' ? 'web' : 'dataset',
    accessMethod: definition.accessMethod,
    title: definition.name,
    description: definition.notes,
    retrievedAt: new Date().toISOString(),
    license: definition.license,
    machineReadable: definition.accessMethod === 'api' || definition.accessMethod === 'download',
    authority: Math.max(0.1, 1 - definition.priority / 12),
    directness: definition.accessMethod === 'api' ? 0.9 : definition.accessMethod === 'download' ? 0.75 : 0.3,
    coverage: definition.categories.includes('global') ? 0.9 : 0.6,
    methodologyTransparency: 0.7,
    recency: 0.7,
    consistency: 0.7,
    qualityScore: 0,
    accepts: null,
    primary: false,
    discoveredBy: 'source-registry',
    notes: [definition.notes ?? ''],
  }));
}

export interface SourceHarvest {
  candidates: SourceCandidate[];
  errors: string[];
}

/** Ask every connector that can answer without credentials. */
export async function harvestSources(plan: DataPlan, options: ResearchOptions, ctx: AgentContext): Promise<SourceHarvest> {
  const candidates: SourceCandidate[] = registryCandidates();
  const errors: string[] = [];

  if (options.owidSlug) {
    try {
      const result = await owidFetch(options.owidSlug);
      candidates.push(result.candidate);
    } catch (error) {
      errors.push(`OWID ${options.owidSlug}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (options.worldBankIndicator) {
    try {
      const result = await worldBankFetch(options.worldBankIndicator, 'all', {
        start: Number(plan.timeRange.start.slice(0, 4)),
        end: Number(plan.timeRange.end.slice(0, 4)),
      });
      candidates.push(result.candidate);
    } catch (error) {
      errors.push(`World Bank ${options.worldBankIndicator}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (process.env.KAGGLE_USERNAME && process.env.KAGGLE_KEY) {
    try {
      const datasets = await kaggleSearch(`${plan.metric} ${plan.entityType}`, { limit: 6 });
      candidates.push(...kaggleCandidates(datasets));
    } catch (error) {
      errors.push(`Kaggle: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    errors.push('Kaggle: KAGGLE_USERNAME / KAGGLE_KEY not configured, connector skipped');
  }

  try {
    const resources = await ckanSearch(plan.metric, { rows: 5 });
    candidates.push(...ckanCandidates(resources));
  } catch (error) {
    errors.push(`Data.gov CKAN: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const upload of options.uploads ?? []) {
    candidates.push(uploadedCandidate(upload));
  }

  try {
    const web = await huntSources(plan, ctx);
    candidates.push(...web);
  } catch (error) {
    errors.push(`web search: ${error instanceof Error ? error.message : String(error)}`);
  }

  const scored = scoreCandidates(candidates);
  return { candidates: scored, errors };
}
// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export interface ExtractionResult {
  observations: Observation[];
  source: SourceCandidate;
  errors: string[];
}

/** Pick entity/date/value columns from an arbitrary table, refusing to guess. */
export function detectColumns(columns: string[]): { entity?: string; date?: string; value?: string } {
  const lower = columns.map((c) => c.toLowerCase());
  const entityIndex = lower.findIndex((c) => ['entity', 'country', 'name', 'region', 'brand', 'company', 'item'].includes(c));
  const dateIndex = lower.findIndex((c) => ['year', 'date', 'time', 'period'].includes(c));
  const entity = entityIndex >= 0 ? columns[entityIndex] : undefined;
  const date = dateIndex >= 0 ? columns[dateIndex] : undefined;
  const reserved = new Set([entity, date, 'code', 'iso', 'iso3', 'continent', 'flag']);
  const numericCandidates: Array<{ name: string; hits: number }> = [];
  for (const column of columns) {
    if (!column || reserved.has(column)) continue;
    lower.includes(column.toLowerCase());
    numericCandidates.push({ name: column, hits: 0 });
  }
  // Prefer a column whose name looks like a measurement.
  const value = numericCandidates.map((c) => c.name).find((c) => /(value|population|total|amount|count|number|sales|users|spend|gdp|production|share|percent|rate|emission)/i.test(c))
    ?? numericCandidates[0]?.name;
  return { entity, date, value };
}

export interface ExtractedDraft {
  entity: string;
  date: string;
  value: number | null;
  unit: string;
}

/**
 * Normalize drafts through the Rust core (dates, units, entity resolution).
 * Falls back to a local implementation when the binary is missing.
 */
export async function normalizeDrafts(drafts: ExtractedDraft[], defaultUnit: string): Promise<ExtractedDraft[]> {
  if (drafts.length === 0) return [];
  if (drafts.length > 0) {
    try {
      const coreInput = {
        unit: defaultUnit,
        observations: drafts.map((d) => ({ entity: d.entity, date: d.date, value: d.value, unit: d.unit || defaultUnit })),
      };
      const { mkdtempSync, writeFileSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join: joinPath } = await import('node:path');
      const tmp = joinPath(mkdtempSync(joinPath(tmpdir(), 'datarace-norm-')), 'in.json');
      writeFileSync(tmp, JSON.stringify(coreInput), 'utf8');
      const normalized = await runRustJson<{
        observations: Array<{ entity: { id: string; name: string }; date: string; value: number | null; unit?: string | null; status?: string }>;
      }>(['normalize', '--in', tmp], { timeoutMs: 180_000 }).catch(() => null);
      if (normalized) {
        // The core returns ISO dates; a source that said "1960" comes back as
        // "1960-01-01", which would make the renderer print a full date for
        // annual data. Keep the source's own spelling when the two line up
        // one-to-one, and fall back to the normalised date otherwise.
        const aligned = normalized.observations.length === drafts.length;
        return normalized.observations.map((o, index) => ({
          entity: o.entity.name,
          date: aligned && drafts[index]?.date ? drafts[index].date : o.date,
          value: o.value,
          unit: o.unit ?? defaultUnit,
        }));
      }
    } catch (error) {
      logger.debug('rust normalize unavailable', { error: String(error) });
    }
  }
  return drafts.map((d) => ({ ...d, unit: d.unit || defaultUnit }));
}

/** Extract observations from a connector payload. */
export function draftsFromTable(columns: string[], rows: string[][], defaultUnit: string): { drafts: ExtractedDraft[]; problems: string[] } {
  const problems: string[] = [];
  const detected = detectColumns(columns);
  if (!detected.entity || !detected.date || !detected.value) {
    problems.push(`could not identify entity/date/value columns in [${columns.join(', ')}]`);
    return { drafts: [], problems };
  }
  const ci = {
    entity: columns.indexOf(detected.entity),
    date: columns.indexOf(detected.date),
    value: columns.indexOf(detected.value),
  };
  const drafts: ExtractedDraft[] = [];
  for (const row of rows) {
    const entity = (row[ci.entity] ?? '').trim();
    const date = (row[ci.date] ?? '').trim();
    const rawValue = (row[ci.value] ?? '').trim().replace(/[",%\s]/g, '');
    if (!entity || !date) continue;
    const value = rawValue === '' ? null : Number.parseFloat(rawValue);
    drafts.push({ entity, date, value: value !== null && Number.isFinite(value) ? value : null, unit: defaultUnit });
  }
  return { drafts, problems };
}

/** Deterministic World Bank indicator discovery by name matching. */
export async function findWorldBankIndicator(metric: string): Promise<{ id: string; name: string } | null> {
  const { getJson } = await import('./connectors');
  const page = await getJson<unknown[]>('https://api.worldbank.org/v2/indicator?format=json&per_page=25000', { timeoutMs: 90_000 });
  if (!Array.isArray(page) || page.length < 2) return null;
  const indicators = (page[1] as Array<{ id?: string; name?: string }>) ?? [];
  const stop = new Set(['the', 'of', 'by', 'in', 'and', 'most', 'popular', 'best', 'selling', 'top', 'largest', 'world', 'global']);
  const tokens = metric
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !stop.has(t));
  let best: { id: string; name: string; score: number } | null = null;
  for (const indicator of indicators) {
    if (!indicator.id || !indicator.name) continue;
    const name = indicator.name.toLowerCase();
    let score = 0;
    for (const token of tokens) if (name.includes(token)) score += 1;
    if (tokens.length > 0) score = score / tokens.length;
    if (score > 0.5 && (!best || score > best.score)) best = { id: indicator.id, name: indicator.name, score };
  }
  return best ? { id: best.id, name: best.name } : null;
}
/**
 * Canonicalise entity names through the Rust core and, when the plan is about
 * countries, drop anything that is not a real country.
 *
 * This is what keeps World Bank aggregates ("Arab World", "Euro area", "World")
 * out of a country race - without it the ranking would be dominated by rows that
 * are not countries at all.
 */
export async function canonicalizeDrafts(drafts: ExtractedDraft[], options: { countryOnly: boolean }): Promise<ExtractedDraft[]> {
  if (drafts.length === 0) return [];
  const names = Array.from(new Set(drafts.map((d) => d.entity)));
  const resolution = await resolveEntities(names);
  if (resolution.size === 0) return drafts;
  const out: ExtractedDraft[] = [];
  let dropped = 0;
  for (const draft of drafts) {
    const resolved = resolution.get(draft.entity);
    if (!resolved) {
      out.push(draft);
      continue;
    }
    // A real country resolves AND has a fetchable flag code. That is exactly
    // what excludes World Bank aggregates ("World", "North America",
    // "Euro area"), whose flag code is null.
    if (options.countryOnly && (resolved.status !== 'resolved' || !resolved.flagCode)) {
      dropped += 1;
      continue;
    }
    out.push({ ...draft, entity: resolved.name });
  }
  if (dropped > 0) logger.info('dropped non-country rows', { dropped });
  return out;
}
/** Flatten an array of JSON objects into a column/row table. */
export function tableFromJsonArray(items: unknown[]): { columns: string[]; rows: string[][] } {
  const columns: string[] = [];
  for (const item of items.slice(0, 500)) {
    if (item && typeof item === 'object') {
      for (const key of Object.keys(item as Record<string, unknown>)) {
        if (!columns.includes(key)) columns.push(key);
      }
    }
  }
  const rows: string[][] = [];
  for (const item of items.slice(0, 200_000)) {
    if (!item || typeof item !== 'object') continue;
    const node = item as Record<string, unknown>;
    rows.push(
      columns.map((c) => {
        const v = node[c];
        if (v === null || v === undefined) return '';
        return typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v);
      }),
    );
  }
  return { columns, rows };
}

function candidateIdFor(url: string): string {
  const slug = url.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return `picked_${slug}`;
}
// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export interface ResearchResult {
  state: ProjectState;
  store: ProjectStore;
  errors: string[];
  summary: {
    sources: number;
    acceptedSources: number;
    observations: number;
    verified: number;
    unknown: number;
    conflicting: number;
    periods: number;
    entities: number;
    durationSeconds: number;
    qualityViolations: number;
    extraction: string;
  };
}

function toObservation(
  draft: ExtractedDraft,
  source: SourceCandidate,
  timeRange: { start: string; end: string },
): Observation {
  // Keep the source's own spelling: turning "1994" into "1994-01-01" would make
  // the Rust core treat annual data as daily and print "1994-01-01" on screen.
  const date = draft.date;
  return {
    observationId: `obs_${source.candidateId}_${draft.entity}_${draft.date}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 80),
    entity: { id: draft.entity.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), name: draft.entity },
    date,
    frequency: inferFrequency(draft.date),
    value: draft.value,
    unit: draft.unit,
    geography: 'global',
    source: {
      url: source.url,
      publisher: source.publisher,
      title: source.title,
      publishedAt: source.publishedAt ?? null,
      retrievedAt: source.retrievedAt,
      identifier: source.candidateId,
    },
    evidence: {
      datasetUrl: source.url,
      datasetVersion: source.candidateId,
      fileName: source.title,
      columns: [],
    },
    method: 'direct',
    status: draft.value === null ? 'UNKNOWN' : 'SUPPORTED',
    confidence: sourceQualityScore(source),
  };
}

export async function researchTopic(options: ResearchOptions): Promise<ResearchResult> {
  const store = new ProjectStore();
  const state = options.projectId ? store.load(options.projectId) : store.create(options.topic, loadLimits());
  const ctx = buildAgentContext(options);
  const errors: string[] = [];

  // --- 1. Plan ------------------------------------------------------------
  store.setStatus(state, 'PLANNING');
  let plan: DataPlan;
  if (state.dataPlan && store.reached(state, 'PLAN_COMPLETE')) {
    plan = state.dataPlan;
    logger.info('resuming from PLAN_COMPLETE');
  } else if (options.skipAi) {
    plan = deterministicPlan(options.topic, options);
  } else {
    try {
      plan = await planTopic(options.topic, ctx, { timeRange: options.timeRange, entityCount: options.entityCount });
    } catch (error) {
      errors.push(`planner: ${error instanceof Error ? error.message : String(error)}`);
      plan = deterministicPlan(options.topic, options);
    }
  }
  state.dataPlan = plan;
  store.checkpoint(state, 'PLAN_COMPLETE');

  // --- 2. Sources ---------------------------------------------------------
  store.setStatus(state, 'RESEARCHING');
  const harvest = store.reached(state, 'SOURCES_COMPLETE')
    ? { candidates: state.sources, errors: [] as string[] }
    : await harvestSources(plan, options, ctx);
  errors.push(...harvest.errors);
  state.sources = harvest.candidates;

  // The AI agent reads the leading candidate pages (through Monid fetch) and
  // decides which source is actually best, instead of trusting titles.
  let selection: SourceSelection = { picked: [], rejected: [], dataUrls: [], inspected: [], problems: [] };
  if (!options.skipAi && !store.reached(state, 'SOURCES_COMPLETE')) {
    try {
      selection = await selectBestSources(state.sources, plan, ctx, { inspectLimit: 6 });
      state.notes.push(`source picker inspected ${selection.inspected.filter((i) => i.ok).length}/${selection.inspected.length} pages and verified ${selection.dataUrls.length} data URLs`);
      for (const problem of selection.problems.slice(0, 5)) state.notes.push(`picker: ${problem}`);
    } catch (error) {
      errors.push(`source picker: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await judgeSources(state.sources, ctx);
    } catch (error) {
      errors.push(`source judge: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  store.checkpoint(state, 'SOURCES_COMPLETE');

  // --- 3. Extraction ------------------------------------------------------
  store.setStatus(state, 'EXTRACTING');
  const timeRange = options.timeRange ?? plan.timeRange;
  const collected: Observation[] = [];
  const extractionNotes: string[] = [];

  const wantedIndicator =
    options.worldBankIndicator ?? (await findWorldBankIndicator(plan.metric).catch(() => null))?.id;

  if (options.owidSlug) {
    try {
      const owid = await owidFetch(options.owidSlug);
      const { drafts: owidDrafts, problems } = draftsFromTable(owid.columns, owid.rows, 'count');
      extractionNotes.push(...problems);
      const drafts = await canonicalizeDrafts(owidDrafts, { countryOnly: plan.entityType === 'country' });
      const normalized = await normalizeDrafts(drafts, 'count');
      const candidate = state.sources.find((s) => s.candidateId === owid.candidate.candidateId) ?? owid.candidate;
      collected.push(...normalized.map((d) => toObservation(d, candidate, timeRange)));
      extractionNotes.push(`OWID ${options.owidSlug}: ${normalized.length} observations`);
    } catch (error) {
      errors.push(`OWID extraction: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (wantedIndicator) {
    try {
      const wb = await worldBankFetch(wantedIndicator, 'all', {
        start: Number(String(timeRange.start).slice(0, 4)) || 1960,
        end: Number(String(timeRange.end).slice(0, 4)) || new Date().getFullYear(),
      });
      const rawDrafts: ExtractedDraft[] = wb.rows
        .filter((r) => r.value !== null && r.countryIso3 && r.countryIso3 !== 'WLD')
        .map((r) => ({ entity: r.countryName, date: r.date, value: r.value, unit: 'count' }));
      const drafts = await canonicalizeDrafts(rawDrafts, { countryOnly: true });
      const normalized = await normalizeDrafts(drafts, 'count');
      const candidate = state.sources.find((s) => s.candidateId === wb.candidate.candidateId) ?? wb.candidate;
      collected.push(...normalized.map((d) => toObservation(d, candidate, timeRange)));
      extractionNotes.push(`World Bank ${wantedIndicator}: ${normalized.length} observations`);
    } catch (error) {
      errors.push(`World Bank extraction: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // URLs the picker verified in the pages it actually read.
  for (const dataUrl of selection.dataUrls.slice(0, 5)) {
    if (ctx.budget.exhausted()) break;
    try {
      const fetched = await ctx.search.fetch(dataUrl);
      const text = fetched.text ?? '';
      if (text.length === 0) continue;
      const looksJson = /json/i.test(fetched.contentType ?? '') || text.trimStart().startsWith('[');
      let table = { columns: [] as string[], rows: [] as string[][] };
      if (looksJson && fetched.json !== undefined) {
        const parsed = fetched.json as unknown;
        if (Array.isArray(parsed)) table = tableFromJsonArray(parsed);
      } else {
        const { parseCsv } = await import('./connectors');
        table = parseCsv(text, dataUrl.endsWith('.tsv') ? '\t' : ',');
      }
      if (table.rows.length === 0) continue;
      const { drafts: urlDrafts, problems } = draftsFromTable(table.columns, table.rows, 'count');
      extractionNotes.push(...problems);
      if (urlDrafts.length === 0) continue;
      const drafts = await canonicalizeDrafts(urlDrafts.slice(0, 200_000), { countryOnly: plan.entityType === 'country' && /country|nation|population/i.test(plan.topic) });
      const normalized = await normalizeDrafts(drafts, 'count');
      const candidate =
        state.sources.find((s) => s.url === dataUrl) ??
        ({
          candidateId: candidateIdFor(dataUrl),
          sourceName: hostOf(dataUrl) || 'source',
          publisher: hostOf(dataUrl) || 'source',
          url: dataUrl,
          kind: 'dataset',
          accessMethod: 'download',
          retrievedAt: new Date().toISOString(),
          license: 'UNKNOWN',
          machineReadable: true,
          authority: 0.7,
          directness: 0.8,
          coverage: 0.6,
          methodologyTransparency: 0.5,
          recency: 0.6,
          consistency: 0.6,
          qualityScore: 0.7,
          accepts: true,
          primary: false,
          discoveredBy: 'source-picker',
        } as SourceCandidate);
      collected.push(...normalized.map((d) => toObservation(d, candidate, timeRange)));
      extractionNotes.push(`picker data URL ${dataUrl}: ${normalized.length} observations`);
    } catch (error) {
      extractionNotes.push(`${dataUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const csvCandidates = state.sources.filter((s) => s.machineReadable && /\.(csv|tsv)(\?|$)/i.test(s.url) && s.accepts !== false);
  for (const candidate of csvCandidates.slice(0, 3)) {
    try {
      const { getText } = await import('./connectors');
      const { text, status } = await getText(candidate.url, { timeoutMs: 60_000 });
      if (status !== 200) {
        extractionNotes.push(`${candidate.url}: HTTP ${status}`);
        continue;
      }
      const { parseCsv } = await import('./connectors');
      const table = parseCsv(text);
      const { drafts: csvDrafts, problems } = draftsFromTable(table.columns, table.rows, 'count');
      extractionNotes.push(...problems);
      if (csvDrafts.length === 0) continue;
      const drafts = await canonicalizeDrafts(csvDrafts.slice(0, 200_000), { countryOnly: plan.entityType === 'country' && /country|nation|population/i.test(plan.topic) });
      const normalized = await normalizeDrafts(drafts, 'count');
      collected.push(...normalized.map((d) => toObservation(d, candidate, timeRange)));
      extractionNotes.push(`${candidate.url}: ${normalized.length} observations`);
    } catch (error) {
      extractionNotes.push(`${candidate.url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Last resort: if nothing structured worked, let the extractor read the best
  // page and pull rows out of it - every row must quote the page verbatim.
  if (collected.length === 0 && !options.skipAi && ctx.budget.remaining()) {
    const best =
      state.sources.find((s) => selection.picked.some((p) => p.candidateId === s.candidateId)) ??
      [...state.sources].sort((a, b) => b.qualityScore - a.qualityScore)[0];
    if (best) {
      try {
        const fetched = await ctx.search.fetch(best.url);
        const text = fetched.text ?? '';
        if (text.length > 200) {
          const extraction = await extractRowsFromText(text, { url: best.url, publisher: best.publisher, title: best.title }, plan, ctx);
          extractionNotes.push(`AI text extraction from ${best.url}: kept ${extraction.rows.length}, dropped ${extraction.dropped}`);
          for (const note of extraction.notes) extractionNotes.push(`extractor: ${note}`);
          if (extraction.rows.length > 0) {
            const drafts: ExtractedDraft[] = extraction.rows.map((r) => ({ entity: r.entity, date: r.date, value: r.value, unit: r.unit ?? 'count' }));
            const normalized = await normalizeDrafts(drafts, 'count');
            collected.push(...normalized.map((d) => toObservation(d, best, timeRange)));
          }
        }
      } catch (error) {
        extractionNotes.push(`AI text extraction failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  let observations = collected;
  if (options.entityFilter && options.entityFilter.length > 0) {
    const keep = new Set(options.entityFilter.map((e) => e.toLowerCase()));
    observations = observations.filter((o) => keep.has(o.entity.name.toLowerCase()) || keep.has(o.entity.id));
  }

  state.notes.push(...extractionNotes.slice(0, 40));
  store.checkpoint(state, 'EXTRACTION_COMPLETE');
  store.checkpoint(state, 'NORMALIZATION_COMPLETE');

  // --- 4. Verification ----------------------------------------------------
  store.setStatus(state, 'VERIFYING');
  const verified = verifyAcrossSources(observations, { metric: plan.metric });
  const dataset = buildDataset({
    projectId: state.projectId,
    datasetId: `dataset_${state.projectId}`,
    name: plan.topic,
    metric: plan.metric,
    unit: 'count',
    timeRange,
    frequency: plan.frequency,
    missingDataPolicy: plan.missingDataPolicy,
    observations: verified.observations,
    conflicts: verified.conflicts,
  });
  store.checkpoint(state, 'VERIFICATION_COMPLETE');

  // --- 5. Quality ---------------------------------------------------------
  const quality: DataQualityReport = await dataQualityReport(dataset);
  state.quality = quality;
  state.dataset = dataset;
  store.checkpoint(state, 'DATASET_COMPLETE');

  // --- 6. Frame tape ------------------------------------------------------
  let tape: FrameTape = {
    fps: 30,
    width: 1280,
    height: 720,
    topN: 0,
    framesPerTransition: 0,
    durationInFrames: 0,
    periodLabels: [],
    entities: [],
    frames: [],
    notes: ['frame tape not generated'],
  };
  try {
    tape = await buildFrameTape(dataset, {
      topN: options.topN ?? Math.min(10, Math.max(3, plan.targetEntityCount)),
      framesPerTransition: options.framesPerTransition ?? 30,
    });
  } catch (error) {
    errors.push(`frame tape: ${error instanceof Error ? error.message : String(error)}`);
  }
  state.frameTape = tape;

  // --- 7. Story -----------------------------------------------------------
  const story: Story = options.skipAi ? deterministicStory(dataset, tape) : await safeStory(dataset, tape, ctx);
  state.story = story;
  store.checkpoint(state, 'STORY_COMPLETE');

  // --- 8. Video spec ------------------------------------------------------
  const { buildVideoSpec, buildThumbnailSpec } = await import('./pipeline');
  const videoSpec: VideoSpec = buildVideoSpec({ dataset, story, tape });
  const thumbnail: ThumbnailSpec = buildThumbnailSpec({ dataset, story, tape });
  state.videoSpec = videoSpec;
  state.thumbnail = thumbnail;
  store.checkpoint(state, 'VIDEOSPEC_COMPLETE');
  store.setStatus(state, 'READY_FOR_REVIEW');
  store.save(state);

  store.writeArtifact(state.projectId, 'frames.json', tape);
  store.writeArtifact(state.projectId, 'asset-plan.json', {
    flags: tape.entities.filter((e) => e.flagCode).map((e) => ({ entityId: e.id, type: 'flag', code: e.flagCode })),
    logos: tape.entities.map((e) => ({ entityId: e.id, type: 'logo', query: `${e.name} logo png transparent`, license: 'verify before publishing' })),
    note: 'asset acquisition runs in the asset stage; licences must be recorded before publishing',
  });

  return {
    state,
    store,
    errors,
    summary: {
      sources: state.sources.length,
      acceptedSources: state.sources.filter((s) => s.accepts !== false).length,
      observations: dataset.stats.observations,
      verified: dataset.stats.verified,
      unknown: dataset.stats.unknown,
      conflicting: dataset.stats.conflicting,
      periods: tape.periodLabels.length,
      entities: tape.entities.length,
      durationSeconds: videoSpec.metadata.durationSeconds,
      qualityViolations: quality.violations,
      extraction: extractionNotes.join(' | ').slice(0, 600),
    },
  };
}


async function safeStory(dataset: Dataset, tape: FrameTape, ctx: AgentContext): Promise<Story> {
  try {
    const { draftStory } = await import('./agents');
    return await draftStory(dataset, tape, ctx);
  } catch (error) {
    logger.warn('story generation failed; using the deterministic story', { error: String(error) });
    return deterministicStory(dataset, tape);
  }
}

export { datasetToCoreInput, dataQualityReport };