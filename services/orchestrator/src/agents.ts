/**
 * Specialised agents.
 *
 * Each agent is a narrow, testable function with a strict output contract. The
 * shared system prompt below is the specification's "agent prompt rules" and is
 * attached to every research call, because the failure mode we care about most
 * is a model inventing data.
 */

import type { DataPlan, Dataset, SourceCandidate, Story } from '@avm/shared';
import { JsonlLog, logger, type Limits } from './runtime';
import type { AIClient } from './providers/ai';
import { extractJson, type AgentRole } from './providers/ai';
import type { Budget, SearchProvider } from './providers/search';
import { hostOf } from './providers/search';
import {
  buildThumbnailSpec,
  buildVideoSpec,
  deterministicStory,
  sourceRef,
  verifyAcrossSources,
  type FrameTape,
  type FrameOptions,
} from './pipeline';
import { buildDataset, buildObservation, type ObservationDraft } from './pipeline';
import type { Observation, ThumbnailSpec, VideoSpec } from '@avm/shared';

export interface AgentContext {
  ai: AIClient;
  search: SearchProvider;
  budget: Budget;
  limits: Limits;
  runLog: JsonlLog;
  cacheRoot?: string;
}

export const RESEARCH_RULES = [
  '1. Never invent data.',
  '2. Never hide missing data.',
  '3. Never silently interpolate.',
  '4. Always preserve source provenance.',
  '5. Distinguish primary and secondary sources.',
  '6. Verify units.',
  '7. Verify dates.',
  '8. Verify metric definitions.',
  '9. Surface conflicts.',
  '10. Prefer machine-readable authoritative data.',
  '11. Use uploaded user data exactly as instructed.',
  '12. Keep raw evidence.',
  '13. Produce structured JSON.',
  '14. Follow the project DataPlan.',
  '15. Do not modify source code.',
].join('\n');

function logRun(ctx: AgentContext, agent: string, input: unknown, output: unknown, model?: string): void {
  ctx.runLog.append({
    at: new Date().toISOString(),
    agent,
    model,
    inputHash: JSON.stringify(input).length,
    outputHash: JSON.stringify(output).length,
    ok: true,
  });
}

// ---------------------------------------------------------------------------
// 1. Planner - topic -> DataPlan
// ---------------------------------------------------------------------------

export async function planTopic(
  topic: string,
  ctx: AgentContext,
  options: { timeRange?: { start: string; end: string }; entityCount?: number; missingDataPolicy?: DataPlan['missingDataPolicy'] } = {},
): Promise<DataPlan> {
  const range = options.timeRange ?? { start: '1990', end: String(new Date().getFullYear()) };
  const prompt = `You are the Planner for a data-video platform.

TOPIC: ${topic}
REQUESTED RANGE: ${range.start} to ${range.end}
TARGET ENTITY COUNT: ${options.entityCount ?? 10}

Task: turn this topic into a DataPlan that a research team can execute.

Critical requirement: words like "most popular", "best selling", "most used",
"biggest", "richest", "most powerful" are ambiguous. You MUST detect that and
list measurable interpretations, with the measurable unit for each. Never pick
one silently on the user's behalf - mark one recommended in the UI instead.

Reply with JSON only, shaped exactly like:
{
  "version": "1.0",
  "topic": "...",
  "metric": "...",
  "metricAmbiguous": true,
  "interpretations": [
    { "id": "a", "label": "short label", "description": "what it means", "measurableDefinition": "exact measurable definition + unit", "caveats": ["..."] }
  ],
  "entityType": "country | brand | company | product | person | other",
  "timeRange": { "start": "${range.start}", "end": "${range.end}" },
  "frequency": "annual | quarterly | monthly",
  "geography": "global or a region",
  "requiredFields": ["entity","date","value","unit","source"],
  "candidateEntities": ["..."],
  "preferredSources": ["authoritative source classes for this topic"],
  "knownRisks": ["..."],
  "missingDataPolicy": "${options.missingDataPolicy ?? 'STRICT'}",
  "targetEntityCount": ${options.entityCount ?? 10}
}`;

  const plan = await ctx.ai.completeJsonRole<DataPlan>('planner', { prompt, system: RESEARCH_RULES, maxTokens: 2048 }, 'dataPlan');
  logRun(ctx, 'planner', topic, plan, 'role:planner');
  return plan;
}

// ---------------------------------------------------------------------------
// 2. Source Hunter - DataPlan -> SourceCandidate[]
// ---------------------------------------------------------------------------

export async function huntSources(plan: DataPlan, ctx: AgentContext): Promise<SourceCandidate[]> {
  const scouted = await scoutQueries(plan, ctx);
  const found: SourceCandidate[] = candidatesFromScout(scouted);

  for (const query of scouted.queries) {
    if (ctx.budget.exhausted()) {
      logger.warn('research budget exhausted during source hunting');
      break;
    }
    const results = await ctx.search.search(query, { limit: 8 });
    for (const r of results) {
      found.push({
        candidateId: `web_${hostOf(r.url)}_${found.length}`,
        sourceName: hostOf(r.url) || 'web',
        publisher: hostOf(r.url) || 'web',
        url: r.url,
        kind: 'web',
        accessMethod: 'web',
        title: r.title,
        description: r.snippet,
        retrievedAt: new Date().toISOString(),
        license: 'UNKNOWN',
        machineReadable: /\.(csv|json|xlsx?|tsv)(\?|$)/i.test(r.url) || /\/api\//i.test(r.url),
        authority: 0.3,
        directness: 0.25,
        coverage: 0.3,
        methodologyTransparency: 0.2,
        recency: 0.4,
        consistency: 0.3,
        qualityScore: 0,
        accepts: null,
        primary: false,
        discoveredBy: 'source-hunter',
        notes: [`query: ${query}`, 'web hit: must be followed through to actual data before use'],
      });
    }
  }
  logRun(ctx, 'source-hunter', plan.topic, { count: found.length, queries: scouted.queries.length });
  return found;
}
// ---------------------------------------------------------------------------
// 3. Judge - accept/reject candidates
// ---------------------------------------------------------------------------

export interface JudgeDecision {
  candidateId: string;
  accept: boolean;
  reason: string;
}

export async function judgeSources(candidates: SourceCandidate[], ctx: AgentContext): Promise<JudgeDecision[]> {
  const shortlist = candidates.slice(0, 40);
  if (shortlist.length === 0) return [];
  const listing = shortlist.map((c) => ({ candidateId: c.candidateId, source: c.sourceName, url: c.url, title: c.title, machineReadable: c.machineReadable, license: c.license }));
  const prompt = `You are the Source Judge.

Decide which of these candidates can actually supply machine-readable data for the
stated metric. Reject pages that merely mention numbers, are paywalled, are
secondary reporting without data, or have an unknown licence for redistribution.

CANDIDATES:
${JSON.stringify(listing, null, 2)}

Reply with JSON only:
{ "decisions": [ { "candidateId": "...", "accept": true, "reason": "short reason" } ] }`;

  const response = await ctx.ai.completeRole('factCheck', { prompt, system: RESEARCH_RULES, maxTokens: 4096 });
  let decisions: JudgeDecision[] = [];
  try {
    const parsed = extractJson(response.text) as { decisions?: JudgeDecision[] };
    decisions = parsed.decisions ?? [];
  } catch (error) {
    logger.warn('judge returned unparsable JSON; keeping every candidate marked undecided', { error: String(error) });
  }
  const byId = new Map(decisions.map((d) => [d.candidateId, d]));
  for (const c of candidates) {
    const decision = byId.get(c.candidateId);
    if (decision) {
      c.accepts = decision.accept;
      c.notes = [...(c.notes ?? []), `judge: ${decision.reason}`];
    }
  }
  logRun(ctx, 'data-judge', listing.length, decisions);
  return decisions;
}

// ---------------------------------------------------------------------------
// 4. Story Director
// ---------------------------------------------------------------------------

export async function draftStory(dataset: Dataset, tape: FrameTape, ctx: AgentContext): Promise<Story> {
  const fallback = deterministicStory(dataset, tape);
  try {
    const facts = {
      topic: dataset.name,
      metric: dataset.metric,
      unit: dataset.unit,
      periodLabels: tape.periodLabels,
      entities: tape.entities.slice(0, 12).map((e) => e.name),
      leaders: tape.frames
        .filter((f) => f.isPeriodBoundary)
        .map((f) => ({ label: f.label, leader: tape.entities.find((e) => e.id === f.bars[0]?.entityId)?.name ?? null, value: f.bars[0]?.value ?? null })),
      movers: tape.frames[tape.frames.length - 1]?.bars.filter((b) => b.isMover).map((b) => b.entityId) ?? [],
      verified: dataset.stats.verified,
      unknown: dataset.stats.unknown,
      conflicting: dataset.stats.conflicting,
    };
    const prompt = `You are the Story Director for a data-race video.

You may ONLY use facts present in the JSON below. Do not add outside knowledge
and do not invent numbers. If a period has no leader, say nothing about it.
The topic field is the subject of the video: the title and subtitle must name
that subject, never a generic phrase like "data race", and never a raw
ISO timestamp.

FACTS:
${JSON.stringify(facts, null, 2)}

Reply with JSON only:
{
  "version": "1.0",
  "title": "sentence-case title that names the actual subject of the data (use the topic field), no clickbait, no placeholders",
  "subtitle": "range or one-line qualifier",
  "hook": "one sentence",
  "setup": "one or two sentences",
  "sequence": [ { "atLabel": "period label", "text": "one sentence grounded in the facts" } ],
  "highlights": [ { "atLabel": "period label", "entityId": "id from entities", "headline": "3-6 words", "detail": "one grounded sentence", "factBox": { "heading": "2-3 words", "body": "one grounded sentence", "dateLabel": "MM/YYYY or label", "wordmark": "entity name" } } ],
  "ending": "one recap sentence",
  "sourcesLine": "Data: publisher names"
}`;
    const story = await ctx.ai.completeJsonRole<Story>('story', { prompt, system: RESEARCH_RULES, maxTokens: 3000 }, 'story');
    logRun(ctx, 'story-director', facts, story, 'role:story');
    return story;
  } catch (error) {
    logger.warn('story model unavailable; using the deterministic story', { error: String(error) });
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// 5. Video Director + QA
// ---------------------------------------------------------------------------

export function directVideo(dataset: Dataset, story: Story, tape: FrameTape): VideoSpec {
  return buildVideoSpec({ dataset, story, tape });
}

export function directThumbnail(dataset: Dataset, story: Story, tape: FrameTape): ThumbnailSpec {
  return buildThumbnailSpec({ dataset, story, tape });
}

export interface QaResult {
  problems: string[];
  passed: boolean;
}

export function qaCheck(dataset: Dataset, spec: VideoSpec, tape: FrameTape): QaResult {
  const problems: string[] = [];
  const summed = spec.scenes.reduce((sum, s) => sum + s.duration, 0);
  if (Math.abs(summed - spec.metadata.durationSeconds) > 1) {
    problems.push(`scene durations sum to ${summed.toFixed(2)}s but metadata says ${spec.metadata.durationSeconds}s`);
  }
  if (tape.durationInFrames === 0) problems.push('frame tape is empty');
  if (dataset.observations.length === 0) problems.push('dataset has no observations');
  const seenEntities = new Set<string>();
  for (const scene of spec.scenes) {
    for (const id of scene.entities ?? []) {
      if (seenEntities.has(id)) problems.push(`entity ${id} appears in more than one scene list`);
      seenEntities.add(id);
    }
  }
  const assetRefs = spec.assets.map((a) => a.url);
  for (const scene of spec.scenes) {
    const refs = (scene.props?.assets as string[] | undefined) ?? [];
    for (const ref of refs) {
      if (!assetRefs.includes(ref)) problems.push(`scene ${scene.id} references a missing asset ${ref}`);
    }
  }
  for (const entity of tape.entities) {
    if (!entity.name || entity.name.trim() === '') problems.push(`entity ${entity.id} has an empty name`);
  }
  return { problems, passed: problems.length === 0 };
}
// ---------------------------------------------------------------------------
// 6. Revision Agent - natural language -> structured change
// ---------------------------------------------------------------------------

export interface RevisionPlan {
  instruction: string;
  datasetFilters: {
    allowStatuses?: string[];
    topN?: number;
    removeEntityIds?: string[];
    annualOnly?: boolean;
  };
  storyOverrides: { title?: string; subtitle?: string };
  videoOverrides: { framesPerTransition?: number; topN?: number };
  notes: string[];
}

export async function planRevision(instruction: string, context: { entities: string[]; statuses: string[]; topN: number }, ctx: AgentContext): Promise<RevisionPlan> {
  const prompt = `You translate a user's natural-language revision request into a structured change.

CONTEXT:
${JSON.stringify(context, null, 2)}

USER REQUEST: "${instruction}"

Translate ONLY what the user asked for. Allowed operational fields are fixed; if the
request cannot be expressed with them, explain that in "notes" and leave the rest empty.
Valid statuses: VERIFIED, SUPPORTED, ESTIMATED, UNKNOWN, CONFLICTING, REJECTED.

Reply with JSON only:
{
  "instruction": "the original request",
  "datasetFilters": { "allowStatuses": ["..."], "topN": 10, "removeEntityIds": ["..."], "annualOnly": false },
  "storyOverrides": { "title": "", "subtitle": "" },
  "videoOverrides": { "framesPerTransition": 30, "topN": 10 },
  "notes": ["..."]
}`;
  try {
    const plan = await ctx.ai.completeJsonRole<RevisionPlan>('qa', { prompt, system: RESEARCH_RULES, maxTokens: 1200 }, 'revisionPlan');
    logRun(ctx, 'revision', instruction, plan, 'role:qa');
    return plan;
  } catch (error) {
    logger.warn('revision model failed; applying a conservative interpretation', { error: String(error) });
    return {
      instruction,
      datasetFilters: {},
      storyOverrides: {},
      videoOverrides: {},
      notes: [`could not structure this request automatically: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

/** Apply a revision plan to a frozen dataset, producing a new version. */
export function applyRevision(dataset: Dataset, plan: RevisionPlan): Dataset {
  const filters = plan.datasetFilters ?? {};
  let observations = [...dataset.observations];
  if (filters.allowStatuses && filters.allowStatuses.length > 0) {
    const allowed = new Set(filters.allowStatuses);
    observations = observations.filter((o) => allowed.has(o.status));
  }
  if (filters.removeEntityIds && filters.removeEntityIds.length > 0) {
    const remove = new Set(filters.removeEntityIds);
    observations = observations.filter((o) => !remove.has(o.entity.id));
  }
  if (filters.annualOnly) {
    observations = observations.filter((o) => o.frequency === 'annual');
  }
  if (filters.topN && filters.topN > 0) {
    const perPeriod = new Map<string, Observation[]>();
    for (const o of observations) {
      const list = perPeriod.get(o.date) ?? [];
      list.push(o);
      perPeriod.set(o.date, list);
    }
    const keep = new Set<string>();
    for (const list of perPeriod.values()) {
      list
        .sort((a, b) => (b.value ?? Number.NEGATIVE_INFINITY) - (a.value ?? Number.NEGATIVE_INFINITY))
        .slice(0, filters.topN)
        .forEach((o) => keep.add(o.observationId));
    }
    observations = observations.filter((o) => keep.has(o.observationId));
  }
  return buildDataset({
    projectId: dataset.projectId,
    datasetId: dataset.datasetId,
    name: dataset.name,
    metric: dataset.metric,
    unit: dataset.unit,
    timeRange: dataset.timeRange,
    frequency: dataset.frequency,
    missingDataPolicy: dataset.missingDataPolicy,
    observations,
    conflicts: dataset.conflicts,
    version: dataset.version + 1,
  });
}

// ---------------------------------------------------------------------------
// 7. Idea Discovery Agent
// ---------------------------------------------------------------------------

export interface VideoIdea {
  title: string;
  topic: string;
  metric: string;
  datasetId: string;
  timeRange: string;
  visualType: 'bar_race' | 'timeline' | 'comparison';
  reason: string;
  scores: {
    dataCompleteness: number;
    historicalDepth: number;
    sourceQuality: number;
    entityCount: number;
    visualPotential: number;
    changeFrequency: number;
    audienceClarity: number;
    updatePotential: number;
  };
  status: 'DISCOVERED' | 'RESEARCHING' | 'READY' | 'USED' | 'REJECTED';
}

/**
 * Score a candidate idea from measurable dataset properties only. These are
 * internal content-production metrics, not claims about popularity.
 */
export function scoreIdea(input: {
  observations: number;
  distinctDates: number;
  entities: number;
  sourceQuality: number;
  distinctLeaders: number;
}): VideoIdea['scores'] {
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  return {
    dataCompleteness: clamp(input.observations / 400),
    historicalDepth: clamp(input.distinctDates / 40),
    sourceQuality: clamp(input.sourceQuality),
    entityCount: clamp(input.entities / 15),
    visualPotential: clamp(input.entities / 10),
    changeFrequency: clamp(input.distinctLeaders / 5),
    audienceClarity: clamp(input.entities / 8),
    updatePotential: clamp(input.distinctDates / 25),
  };
}

export function ideaFromDataset(dataset: Dataset, sourceQuality: number): VideoIdea {
  const dates = new Set(dataset.observations.map((o) => o.date));
  const entities = new Set(dataset.observations.map((o) => o.entity.id));
  const leaders = new Set<string>();
  const byDate = new Map<string, Observation[]>();
  for (const o of dataset.observations) {
    const list = byDate.get(o.date) ?? [];
    list.push(o);
    byDate.set(o.date, list);
  }
  for (const list of byDate.values()) {
    const leader = list.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity))[0];
    if (leader) leaders.add(leader.entity.id);
  }
  const scores = scoreIdea({
    observations: dataset.observations.length,
    distinctDates: dates.size,
    entities: entities.size,
    sourceQuality,
    distinctLeaders: leaders.size,
  });
  const average = Object.values(scores).reduce((a, b) => a + b, 0) / Object.values(scores).length;
  return {
    title: dataset.name,
    topic: dataset.name,
    metric: dataset.metric,
    datasetId: dataset.datasetId,
    timeRange: `${dataset.timeRange.start}-${dataset.timeRange.end}`,
    visualType: 'bar_race',
    reason: `${entities.size} entities over ${dates.size} periods; ${leaders.size} different leaders; mean idea score ${average.toFixed(2)}`,
    scores,
    status: 'DISCOVERED',
  };
}

// ---------------------------------------------------------------------------
// Helpers used by the pipeline driver
// ---------------------------------------------------------------------------

export function observationsFromRows(input: {
  rows: Array<{ entity: string; date: string; value: number | null; unit?: string; extra?: Partial<ObservationDraft> }>;
  publisher: string;
  url: string;
  title?: string;
  defaultUnit: string;
}): Observation[] {
  const ref = sourceRef({ url: input.url, publisher: input.publisher, title: input.title });
  return input.rows.map((row) =>
    buildObservation({
      entity: row.entity,
      date: row.date,
      value: row.value,
      unit: row.unit ?? input.defaultUnit,
      source: ref,
      method: 'direct',
      ...row.extra,
    }),
  );
}

export function mergeAndVerify(all: Observation[], metric: string): { observations: Observation[]; conflicts: ReturnType<typeof verifyAcrossSources>['conflicts'] } {
  const result = verifyAcrossSources(all, { metric });
  return { observations: result.observations, conflicts: result.conflicts };
}

export type { FrameOptions };
// ---------------------------------------------------------------------------
// 8. Query Scout - what should we even search for?
// ---------------------------------------------------------------------------

export interface ScoutingResult {
  queries: string[];
  knownSources: Array<{ name: string; url: string; why: string }>;
}

/**
 * Ask the model to design the search, instead of hard-coding a query template.
 * It is given the plan and must return concrete, targetable queries plus any
 * dataset or API it already knows about.
 */
export async function scoutQueries(plan: DataPlan, ctx: AgentContext): Promise<ScoutingResult> {
  const fallback: ScoutingResult = {
    queries: [
      `${plan.metric} ${plan.entityType} historical dataset csv`,
      `${plan.topic} ${plan.timeRange.start} ${plan.timeRange.end} data download`,
      `${plan.metric} official statistics api`,
    ],
    knownSources: [],
  };
  const prompt = `You are the Query Scout for a data-research agent.

PLAN:
${JSON.stringify({ topic: plan.topic, metric: plan.metric, entityType: plan.entityType, timeRange: plan.timeRange, frequency: plan.frequency, geography: plan.geography }, null, 2)}

Design the research. Prefer, in this order: official APIs, official datasets, government statistics,
then a reputable public dataset. Name the endpoints you actually expect to exist; do not invent URLs
you are unsure about.

Reply with JSON only:
{
  "queries": ["6 to 10 concrete search queries, each targeting machine-readable data"],
  "knownSources": [ { "name": "publisher", "url": "https://...", "why": "what it provides and in what format" } ]
}`;
  try {
    const result = await ctx.ai.completeJsonRole<ScoutingResult>('queryScout', { prompt, system: RESEARCH_RULES, maxTokens: 1400 }, 'scouting');
    const queries = (result.queries ?? []).filter((q) => typeof q === 'string' && q.trim().length > 4).slice(0, 10);
    // Models often omit the scheme; normalise rather than discard a good source.
    const knownSources = (result.knownSources ?? [])
      .filter((s) => typeof s?.url === 'string' && s.url.trim().length > 3)
      .slice(0, 8)
      .map((s) => ({ ...s, url: /^https?:\/\//i.test(s.url.trim()) ? s.url.trim() : `https://${s.url.trim()}` }));
    logRun(ctx, 'query-scout', plan.topic, { queries: queries.length, knownSources: knownSources.length }, 'role:queryScout');
    return queries.length > 0 ? { queries, knownSources } : fallback;
  } catch (error) {
    logger.warn('query scout failed; using template queries', { error: String(error) });
    return fallback;
  }
}

/** Turn the scout's known sources into candidates with a starting score. */
export function candidatesFromScout(scouted: ScoutingResult): SourceCandidate[] {
  return scouted.knownSources.map((source, index) => ({
    candidateId: `scout_${index}_${hostOf(source.url) || 'source'}`,
    sourceName: source.name || hostOf(source.url),
    publisher: source.name || hostOf(source.url),
    url: source.url,
    kind: 'dataset' as const,
    accessMethod: 'web' as const,
    title: source.name,
    description: source.why,
    retrievedAt: new Date().toISOString(),
    license: 'UNKNOWN',
    machineReadable: /\.(csv|json|tsv|xlsx?)(\?|$)/i.test(source.url) || /api/i.test(source.url),
    authority: 0.6,
    directness: 0.5,
    coverage: 0.5,
    methodologyTransparency: 0.4,
    recency: 0.5,
    consistency: 0.5,
    qualityScore: 0,
    accepts: null,
    primary: false,
    discoveredBy: 'query-scout',
    notes: [`scout rationale: ${source.why}`],
  }));
}

// ---------------------------------------------------------------------------
// 9. Source Picker - read the actual pages, then choose
// ---------------------------------------------------------------------------

export interface SourceSelection {
  picked: Array<{ candidateId: string; rank: number; why: string; directDataUrl?: string }>;
  rejected: Array<{ candidateId: string; why: string }>;
  dataUrls: string[];
  inspected: Array<{ candidateId: string; url: string; via: string; bytes: number; ok: boolean }>;
  problems: string[];
}

function normaliseForMatch(input: string): string {
  return input.replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Fetch the leading candidates, hand the real page content to the model, and
 * let it choose which source is actually best - rather than trusting a title.
 *
 * Anti-hallucination guard: any `directDataUrl` the model proposes is kept only
 * if it literally appears in the fetched page text (or is the candidate's own
 * URL). Invented links are dropped and counted.
 */
export async function selectBestSources(
  candidates: SourceCandidate[],
  plan: DataPlan,
  ctx: AgentContext,
  options: { inspectLimit?: number } = {},
): Promise<SourceSelection> {
  const selection: SourceSelection = { picked: [], rejected: [], dataUrls: [], inspected: [], problems: [] };
  const inspectLimit = options.inspectLimit ?? 6;
  const ordered = [...candidates].sort((a, b) => b.qualityScore - a.qualityScore).slice(0, inspectLimit);

  const briefs: Array<{ candidateId: string; source: string; url: string; title?: string; kind: string; machineReadable: boolean; excerpt?: string }> = [];
  for (const candidate of ordered) {
    const brief: (typeof briefs)[number] = {
      candidateId: candidate.candidateId,
      source: candidate.sourceName,
      url: candidate.url,
      title: candidate.title,
      kind: candidate.kind,
      machineReadable: candidate.machineReadable,
    };
    try {
      const fetched = await ctx.search.fetch(candidate.url);
      const text = fetched.text ?? '';
      brief.excerpt = text.slice(0, 4000);
      selection.inspected.push({ candidateId: candidate.candidateId, url: candidate.url, via: fetched.via, bytes: fetched.bytes ?? text.length, ok: fetched.status === 200 });
    } catch (error) {
      selection.inspected.push({ candidateId: candidate.candidateId, url: candidate.url, via: 'none', bytes: 0, ok: false });
      selection.problems.push(`${candidate.url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    briefs.push(brief);
  }

  const pageText = normaliseForMatch(briefs.map((b) => `${b.url} ${b.excerpt ?? ''}`).join(' '));

  const prompt = `You are the Source Picker for a data-video platform. Choose the sources that can actually supply
machine-readable numbers for the plan, after having read their pages.

PLAN:
${JSON.stringify({ topic: plan.topic, metric: plan.metric, entityType: plan.entityType, timeRange: plan.timeRange, frequency: plan.frequency }, null, 2)}

CANDIDATES (excerpts are real page content, truncated):
${JSON.stringify(briefs, null, 2)}

Rules:
- Prefer an official API or official dataset over an aggregator; prefer machine-readable over prose.
- Reject pages that only mention numbers, are paywalled, or have no licence we could check.
- If a candidate page links to a downloadable CSV/JSON/API endpoint, put that exact URL in "directDataUrl".
- Only propose URLs you can see in the excerpts. Do not invent links.

Reply with JSON only:
{
  "picks": [ { "candidateId": "...", "rank": 1, "why": "short reason", "directDataUrl": "https://... or omit" } ],
  "rejected": [ { "candidateId": "...", "why": "short reason" } ],
  "dataUrls": ["every genuinely downloadable data URL you can see, best first"]
}`;

  try {
    const response = await ctx.ai.completeRole('sourcePicker', { prompt, system: RESEARCH_RULES, maxTokens: 2500 });
    const parsed = extractJson(response.text) as {
      picks?: Array<{ candidateId: string; rank: number; why: string; directDataUrl?: string }>;
      rejected?: Array<{ candidateId: string; why: string }>;
      dataUrls?: string[];
    };
    selection.picked = (parsed.picks ?? []).filter((p) => typeof p?.candidateId === 'string');
    selection.rejected = (parsed.rejected ?? []).filter((r) => typeof r?.candidateId === 'string');

    const proposed = [
      ...(parsed.dataUrls ?? []),
      ...selection.picked.map((p) => p.directDataUrl).filter((u): u is string => typeof u === 'string'),
    ];
    const verified: string[] = [];
    for (const url of proposed) {
      if (typeof url !== 'string' || !/^https?:/.test(url)) continue;
      const known = pageText.includes(normaliseForMatch(url)) || briefs.some((b) => b.url === url);
      if (known && !verified.includes(url)) verified.push(url);
      else selection.problems.push(`dropped a data URL the model proposed but the pages do not contain: ${url}`);
    }
    selection.dataUrls = verified.slice(0, 10);
    logRun(ctx, 'source-picker', ordered.map((c) => c.candidateId), { picked: selection.picked.length, dataUrls: selection.dataUrls.length }, 'role:sourcePicker');
  } catch (error) {
    selection.problems.push(`source picker failed: ${error instanceof Error ? error.message : String(error)}`);
    logger.warn('source picker failed', { error: String(error) });
  }

  // Apply the decision to the candidates so the UI shows it.
  for (const candidate of candidates) {
    const pick = selection.picked.find((p) => p.candidateId === candidate.candidateId);
    const reject = selection.rejected.find((r) => r.candidateId === candidate.candidateId);
    if (pick) {
      candidate.accepts = true;
      candidate.primary = pick.rank === 1;
      candidate.notes = [...(candidate.notes ?? []), `picker: ${pick.why}`];
    } else if (reject) {
      candidate.accepts = false;
      candidate.notes = [...(candidate.notes ?? []), `picker: ${reject.why}`];
    }
  }
  return selection;
}

// ---------------------------------------------------------------------------
// 10. Text Extractor - last resort, with a substring guard
// ---------------------------------------------------------------------------

export interface ExtractedRow {
  entity: string;
  date: string;
  value: number | null;
  unit?: string;
  quote: string;
}

export interface TextExtraction {
  rows: ExtractedRow[];
  dropped: number;
  notes: string[];
}

/**
 * Pull rows out of a fetched page.
 *
 * Every row must come with a verbatim quote, and that quote must actually occur
 * in the page text and contain the reported number. Anything that fails the
 * guard is dropped and counted, so a model cannot smuggle in a value that is
 * not on the page.
 */
export async function extractRowsFromText(
  text: string,
  meta: { url: string; publisher: string; title?: string },
  plan: DataPlan,
  ctx: AgentContext,
): Promise<TextExtraction> {
  const haystack = normaliseForMatch(text);
  const prompt = `You are the Data Extractor for a data-video platform.

SOURCE: ${meta.publisher} - ${meta.url}
PLAN: ${JSON.stringify({ metric: plan.metric, entityType: plan.entityType, timeRange: plan.timeRange, frequency: plan.frequency }, null, 0)}

PAGE TEXT:
"""
${text.slice(0, 40000)}
"""

Extract only numbers that are literally written in the page text above.

Hard rules:
- Every row needs a "quote": an exact substring copied from the page text that contains the number.
- If the page does not contain the metric over time, return an empty rows array. That is a valid answer.
- Do not compute, convert, estimate or interpolate anything.
- Use the unit the page uses (e.g. "million", "percent", "count").

Reply with JSON only:
{
  "rows": [ { "entity": "...", "date": "1960 or 1960-05", "value": 123.4, "unit": "...", "quote": "exact text from the page" } ],
  "notes": ["anything the analyst should know about this page"]
}`;

  const extraction: TextExtraction = { rows: [], dropped: 0, notes: [] };
  try {
    const parsed = await ctx.ai.completeJsonRole<{ rows?: ExtractedRow[]; notes?: string[] }>(
      'extractor',
      { prompt, system: RESEARCH_RULES, maxTokens: 4000 },
      'extractedRows',
    );
    extraction.notes = (parsed.notes ?? []).filter((n) => typeof n === 'string').slice(0, 5);
    for (const row of parsed.rows ?? []) {
      if (!row || typeof row.entity !== 'string' || typeof row.date !== 'string') {
        extraction.dropped += 1;
        continue;
      }
      const quote = typeof row.quote === 'string' ? row.quote : '';
      const quoteNorm = normaliseForMatch(quote);
      const valueOk = row.value === null || typeof row.value === 'number';
      if (!valueOk || quoteNorm.length < 8 || !haystack.includes(quoteNorm)) {
        extraction.dropped += 1;
        continue;
      }
      if (typeof row.value === 'number' && !quoteNorm.includes(String(row.value))) {
        // accept a rounded form too, but never silently: count it and require the digits to appear
        const digits = String(row.value).replace(/[^0-9.]/g, '');
        if (!quoteNorm.includes(digits)) {
          extraction.dropped += 1;
          continue;
        }
      }
      extraction.rows.push({ entity: row.entity.trim(), date: row.date.trim(), value: row.value ?? null, unit: row.unit, quote });
    }
    logRun(ctx, 'text-extractor', meta.url, { kept: extraction.rows.length, dropped: extraction.dropped }, 'role:extractor');
  } catch (error) {
    extraction.notes.push(`extraction failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return extraction;
}

// ---------------------------------------------------------------------------
// 11. AI QA - used both interactively and inside CI
// ---------------------------------------------------------------------------

export interface AiQaVerdict {
  passed: boolean;
  /**
   * False when the review could not run at all (no provider reachable). Callers
   * must distinguish this from an actual rejection: an advisory AI check should
   * not block a pipeline just because a provider was briefly down.
   */
  available: boolean;
  problems: string[];
  notes: string[];
}

export async function aiQaReview(
  input: { datasetSummary: unknown; videoSpec: unknown; frameTapeSummary: unknown },
  ctx: AgentContext,
): Promise<AiQaVerdict> {
  const fallback: AiQaVerdict = { passed: false, available: false, problems: ['AI QA could not run: no model was reachable'], notes: [] };
  const prompt = `You are the QA Agent for a data-video platform. Audit this rendered-plan bundle for
unsupported claims, impossible timings, missing provenance, duplicate entities and ranking errors.

DATASET SUMMARY:
${JSON.stringify(input.datasetSummary, null, 2)}

VIDEO SPEC:
${JSON.stringify(input.videoSpec, null, 2)}

FRAME TAPE SUMMARY:
${JSON.stringify(input.frameTapeSummary, null, 2)}

Reply with JSON only:
{ "passed": true, "problems": ["only real, specific problems"], "notes": ["optional"] }`;
  try {
    const verdict = await ctx.ai.completeJsonRole<AiQaVerdict>('qa', { prompt, system: RESEARCH_RULES, maxTokens: 1500 }, 'aiQaVerdict');
    return { passed: Boolean(verdict.passed), available: true, problems: verdict.problems ?? [], notes: verdict.notes ?? [] };
  } catch (error) {
    logger.warn('AI QA failed', { error: String(error) });
    return fallback;
  }
}