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
import { MODEL_ROLES, extractJson } from './providers/ai';
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

  const plan = await ctx.ai.completeJson<DataPlan>({ prompt, system: RESEARCH_RULES, maxTokens: 2048 }, 'dataPlan', MODEL_ROLES.planner);
  logRun(ctx, 'planner', topic, plan, MODEL_ROLES.planner);
  return plan;
}

// ---------------------------------------------------------------------------
// 2. Source Hunter - DataPlan -> SourceCandidate[]
// ---------------------------------------------------------------------------

export async function huntSources(plan: DataPlan, ctx: AgentContext): Promise<SourceCandidate[]> {
  const queries = [
    `${plan.metric} ${plan.entityType} historical dataset csv`,
    `${plan.topic} ${plan.timeRange.start} ${plan.timeRange.end} data`,
    `${plan.metric} official statistics download`,
  ];
  const found: SourceCandidate[] = [];
  for (const query of queries) {
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
        machineReadable: /\.(csv|json|xlsx?|tsv)(\?|$)/i.test(r.url),
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
        notes: ['web hit: must be followed through to actual data before use'],
      });
    }
  }
  logRun(ctx, 'source-hunter', plan.topic, { count: found.length });
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

  const response = await ctx.ai.complete({ prompt, system: RESEARCH_RULES, maxTokens: 4096 }, MODEL_ROLES.factCheck);
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
    const story = await ctx.ai.completeJson<Story>({ prompt, system: RESEARCH_RULES, maxTokens: 3000 }, 'story', MODEL_ROLES.story);
    logRun(ctx, 'story-director', facts, story, MODEL_ROLES.story);
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
    const plan = await ctx.ai.completeJson<RevisionPlan>({ prompt, system: RESEARCH_RULES, maxTokens: 1200 }, 'dataPlan', MODEL_ROLES.qa);
    logRun(ctx, 'revision', instruction, plan, MODEL_ROLES.qa);
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