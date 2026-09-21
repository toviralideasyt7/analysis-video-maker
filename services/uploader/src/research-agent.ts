/**
 * AI research agent: topic (or a user-supplied data URL) -> video-input JSON.
 *
 * Runs inside GitHub Actions (research.yml). Pipeline per topic:
 *   1. PLAN      - the model turns the topic into a measurable definition and
 *                  proposes the entity list, time span and data sources to try;
 *   2. GATHER    - a user data URL is fetched directly if given; otherwise
 *                  Monid search + fetch collect candidate pages and the model
 *                  picks the best machine-readable source;
 *   3. EXTRACT   - the model pulls (entity, date, value) rows out of the page
 *                  text; every row must quote the source verbatim or it is
 *                  dropped - a model cannot smuggle in a number;
 *   4. COMPOSE   - facts (the side-panel narrative) are written from the same
 *                  source text, entities get colors/groups, world totals are
 *                  summed, and the video-input file is assembled and validated.
 *
 * The agent stops after one pass per stage; nothing loops unbounded.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createAIClient, type AIClient } from './ai';
import { createSearchProvider, type SearchProvider } from './search';
import { validateVideoInput } from '@avm/shared';
import type { VideoInput, VideoInputFact } from '@avm/shared';

export interface ResearchRequest {
  topic: string;
  dataUrl?: string;
  minYear?: number;
  maxYear?: number;
  topN?: number;
}

export interface ResearchOutput {
  ok: boolean;
  input?: VideoInput;
  outputPath?: string;
  warnings: string[];
  errors: string[];
}

function client(): AIClient {
  return createAIClient();
}

const SYSTEM = [
  'You are a research agent for a data-race video platform.',
  '1. Never invent data.',
  '2. Never hide missing data.',
  '3. Every extracted number needs a verbatim quote from the fetched text.',
  '4. Prefer official statistics and machine-readable data.',
  '5. Reply with a single JSON document only.',
].join('\n');

interface Plan {
  measurableDefinition: string;
  unit: string;
  entityType: string;
  entities: Array<{ id: string; name: string; group: string; domain?: string }>;
  startYear: number;
  endYear: number;
  searchQueries: string[];
}

async function planResearch(req: ResearchRequest, ai: AIClient): Promise<Plan> {
  const prompt = `Topic: "${req.topic}"
Year range: ${req.minYear ?? 'earliest available'} to ${req.maxYear ?? 'latest available'}.

Design the research for a bar-chart-race video. Identify the 10-30 entities that
belong in the race, what group/segment each belongs to, the measurable definition
and unit, and 3-6 search queries that would find historical numeric data for it.

Reply with JSON only:
{
  "measurableDefinition": "...",
  "unit": "...",
  "entityType": "country|website|company|...",
  "entities": [ { "id": "kebab-id", "name": "Display Name", "group": "Segment", "domain": "example.com" } ],
  "startYear": 1995,
  "endYear": 2026,
  "searchQueries": ["..."]
}`;
  return ai.completeJsonRole<Plan>('planner', { prompt, system: SYSTEM, maxTokens: 2500 });
}

async function gather(req: ResearchRequest, plan: Plan, ai: AIClient, search: SearchProvider, warnings: string[]): Promise<{ text: string; url: string } | null> {
  if (req.dataUrl) {
    const fetched = await search.fetch(req.dataUrl);
    let text = fetched.text ?? "";
    if (text.length > 100) {
      // A raw CSV dump is data, not prose: keep the rows whole and cap the size
      // so the extractor sees real rows without blowing the context window.
      if (/\.(csv|tsv)(\?|$)/i.test(req.dataUrl)) {
        const lines = text.split("\n").filter((l) => l.trim() !== "");
        text = lines.slice(0, 4000).join("\n");
        warnings.push(`data URL is a raw table: ${lines.length} rows (capped at 4000)`);
      }
      return { text, url: req.dataUrl };
    }
    warnings.push(`data URL provided but unusable: ${req.dataUrl}`);
  }
  for (const query of plan.searchQueries.slice(0, 4)) {
    const results = await search.search(query, { limit: 5 });
    for (const result of results.slice(0, 3)) {
      try {
        const fetched = await search.fetch(result.url);
        const text = fetched.text ?? '';
        if (text.length > 500 && /\d{3,}/.test(text)) return { text, url: result.url };
      } catch {
        /* try the next candidate */
      }
    }
  }
  return null;
}

interface RawRow {
  entity: string;
  date: string;
  value: number;
  quote: string;
}

/**
 * Deterministic CSV ingestion: when the data URL is a table, parse it directly
 * instead of asking a model to read it. AI plans and narrates; the numbers come
 * from the file. This is the honest and scalable path for any tabular source.
 */
function ingestCsvTable(text: string): Array<{ entity: string; date: string; value: number; code: string }> {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length < 2) return [];
  // A proxied CSV often arrives as a markdown table (| a | b |). Support both
  // shapes so the deterministic ingestion path works either way.
  const markdown = lines[0].trim().startsWith('|') && lines[0].includes('|');
  const delimiter = markdown ? '|' : lines[0].includes('\t') ? '\t' : ',';
  const clean = (value: string): string => value.replace(/\|/g, '').trim();
  const split = (line: string): string[] => {
    const out: string[] = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"') {
          if (line[i + 1] === '"') { field += '"'; i += 1; } else { quoted = false; }
        } else field += ch;
        continue;
      }
      if (ch === '"') quoted = true;
      else if (ch === delimiter) { out.push(field); field = ''; }
      else if (ch !== '\r') field += ch;
    }
    out.push(field);
    return out;
  };
  const header = split(lines[0]).map((h) => clean(h).toLowerCase());
  // Header hints are matched as substrings so real-world names work:
  // "Country Name", "Annual CO2 emissions", "Entity", "Code", "Year", "Value".
  const hint = (names: string[]): number =>
    header.findIndex((h) => names.some((n) => h.includes(n)));
  const entityIndex = hint(['entity', 'country', 'name', 'brand']);
  const dateIndex = hint(['date', 'year', 'time', 'period']);
  // Some sources (OWID) carry an ISO3 country code in a sibling column; when it
  // exists it lets us drop region aggregates instead of racing them.
  const codeIndex = hint(['code', 'iso']);
  let valueIndex = hint(['value', 'population', 'amount', 'count', 'total', 'sales', 'emissions', 'gdp']);
  // Fallback for a value column with an unpredictable title (OWID's "Annual CO2
  // emissions"): pick the column that actually parses as numbers.
  if (valueIndex < 0) {
    let best = { index: -1, hits: 0 };
    for (let c = 0; c < header.length; c += 1) {
      if (c === entityIndex || c === dateIndex || c === codeIndex) continue;
      let hits = 0;
      for (const line of lines.slice(1, 25)) {
        const raw = clean(split(line)[c] ?? '').replace(/[\s,]/g, '');
        if (raw !== '' && Number.isFinite(Number.parseFloat(raw))) hits += 1;
      }
      if (hits > best.hits) best = { index: c, hits };
    }
    if (best.hits >= 3) valueIndex = best.index;
  }
  if (entityIndex < 0 || dateIndex < 0 || valueIndex < 0) return [];
  const rows: Array<{ entity: string; date: string; value: number; code: string }> = [];
  for (const line of lines.slice(1)) {
    if (/^\|?[\s|:-]+\|?$/.test(line)) continue;   // markdown separator row
    const parts = split(line);
    const entity = clean(parts[entityIndex] ?? '');
    const date = clean(parts[dateIndex] ?? '');
    const raw = clean(parts[valueIndex] ?? '').replace(/["',\s]/g, '');
    if (!entity || !date || raw === '') continue;
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value)) continue;
    rows.push({ entity, date, value, code: codeIndex >= 0 ? clean(parts[codeIndex] ?? '') : '' });
  }
  return rows;
}
async function extractRows(source: { text: string; url: string }, plan: Plan, ai: AIClient): Promise<{ rows: RawRow[]; dropped: number }> {
  const prompt = `SOURCE: ${source.url}

Measurable definition: ${plan.measurableDefinition} (${plan.unit})
Entities in the race: ${plan.entities.map((e) => e.name).join(', ')}

PAGE TEXT (truncated):
"""
${source.text.slice(0, 45000)}
"""

Extract every (entity, date, value) row that appears in the text for these entities.
Each row MUST include "quote": the exact substring of the page containing the number.
If the page has no usable series, return an empty rows array.

Reply with JSON only:
{ "rows": [ { "entity": "...", "date": "1995", "value": 123, "quote": "..." } ] }`;
  const parsed = await ai.completeJsonRole<{ rows?: RawRow[] }>(
    'extractor',
    { prompt, system: SYSTEM, maxTokens: 8000 },
  );
  const haystack = source.text.replace(/\s+/g, ' ').toLowerCase();
  const rows: RawRow[] = [];
  let dropped = 0;
  for (const row of parsed.rows ?? []) {
    const quote = (row.quote ?? '').replace(/\s+/g, ' ').toLowerCase();
    const digits = String(row.value).replace(/[^0-9.]/g, '');
    if (!row.entity || !row.date || !Number.isFinite(row.value) || quote.length < 8 || !haystack.includes(quote) || !quote.includes(digits)) {
      dropped += 1;
      continue;
    }
    rows.push(row);
  }
  return { rows, dropped };
}

async function composeFacts(rows: RawRow[], req: ResearchRequest, plan: Plan, ai: AIClient): Promise<VideoInputFact[]> {
  const byDate = new Map<string, number>();
  for (const row of rows) byDate.set(row.date, (byDate.get(row.date) ?? 0) + 1);
  const leaders = new Map<string, string>();
  for (const row of rows) {
    const current = leaders.get(row.date);
    if (!current) leaders.set(row.date, row.entity);
  }
  const prompt = `Topic: "${req.topic}"
Series: ${plan.measurableDefinition} (${plan.unit}), ${plan.startYear}-${plan.endYear}
Entities: ${plan.entities.map((e) => e.name).join(', ')}

Write 6-9 short narrative facts for the side panel of the video, each anchored to a
year where something notable happened (a lead change, a milestone, an event). Use
ONLY the entities and general history of this topic; do not state numbers you have
not been given.

Reply with JSON only:
{ "facts": [ { "atDate": "2004", "heading": "3-6 words", "body": "one sentence", "tiles": ["entity-id", "entity-id"] } ] }`;
  const parsed = await ai.completeJsonRole<{ facts?: VideoInputFact[] }>('story', { prompt, system: SYSTEM, maxTokens: 2500 });
  return parsed.facts ?? [];
}

/**
 * Data-derived fallback narrative, used when the model is unavailable. Every
 * sentence is built from the ingested rows, so it cannot invent a number.
 */
function deriveFacts(rows: RawRow[], plan: Plan): VideoInputFact[] {
  const byDate = new Map<string, RawRow[]>();
  for (const row of rows) {
    const list = byDate.get(row.date) ?? [];
    list.push(row);
    byDate.set(row.date, list);
  }
  const dates = Array.from(byDate.keys()).sort((a, b) => Number(a) - Number(b));
  const facts: VideoInputFact[] = [];
  const compact = (value: number): string => {
    const abs = Math.abs(value);
    if (abs >= 1e12) return (value / 1e12).toFixed(2) + ' trillion';
    if (abs >= 1e9) return (value / 1e9).toFixed(2) + ' billion';
    if (abs >= 1e6) return (value / 1e6).toFixed(1) + ' million';
    return Math.round(value).toLocaleString('en-US');
  };
  let previousLeader = '';
  for (const date of dates) {
    const leader = [...(byDate.get(date) ?? [])].sort((a, b) => b.value - a.value)[0];
    if (!leader) continue;
    if (!previousLeader) {
      facts.push({
        atDate: date,
        heading: 'WHERE IT BEGAN',
        body: leader.entity + ' led in ' + date + ' with ' + compact(leader.value) + '.',
        tiles: [leader.entity],
      });
    } else if (leader.entity !== previousLeader) {
      facts.push({
        atDate: date,
        heading: leader.entity.toUpperCase() + ' TAKES THE LEAD',
        body: leader.entity + ' overtook ' + previousLeader + ' in ' + date + ' at ' + compact(leader.value) + '.',
        tiles: [leader.entity, previousLeader],
      });
    }
    previousLeader = leader.entity;
  }
  const last = dates[dates.length - 1];
  const lastLeader = last ? [...(byDate.get(last) ?? [])].sort((a, b) => b.value - a.value)[0] : undefined;
  if (lastLeader) {
    facts.push({
      atDate: last,
      heading: 'WHERE IT STANDS',
      body: lastLeader.entity + ' tops the ' + last + ' table at ' + compact(lastLeader.value) + '.',
      tiles: [lastLeader.entity],
    });
  }
  return facts.slice(0, 9);
}

/** Region/world aggregates that must never race against real countries. */
const AGGREGATE_NAMES = new Set([
  'world', 'asia', 'africa', 'europe', 'north america', 'south america', 'americas',
  'oceania', 'european union', 'oecd', 'high income', 'low income', 'middle income',
  'upper middle income', 'lower middle income', 'east asia and pacific',
  'latin america and caribbean', 'middle east and north africa', 'sub-saharan africa',
  'south asia', 'europe and central asia', 'least developed countries',
]);

function isAggregateName(name: string): boolean {
  const key = name.trim().toLowerCase();
  // OWID/UN region entities are suffixed "(UN)"; some are bare region names.
  return key.endsWith('(un)') || AGGREGATE_NAMES.has(key);
}

export async function runResearch(req: ResearchRequest, outDir: string): Promise<ResearchOutput> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const ai = client();
  const search = createSearchProvider();

  // With a tabular data URL the file itself is the plan: entities, dates and
  // values come from the columns deterministically. AI is used only to
  // narrate. This keeps a 12k-row CSV out of a prompt window entirely.
  const isTable = Boolean(req.dataUrl && /\.(csv|tsv)(\?|$)/i.test(req.dataUrl));
  let plan: Plan;
  let source: { text: string; url: string } | null = null;
  let rows: RawRow[] = [];
  if (isTable && req.dataUrl) {
    const fetched = await search.fetch(req.dataUrl);
    const text = fetched.text ?? "";
    const parsedTable = ingestCsvTable(text);
    if (parsedTable.length === 0) {
      errors.push("the CSV at dataUrl could not be parsed (need entity/date/value columns)");
      return { ok: false, warnings, errors };
    }
    // When the table carries a country-code column, region aggregates (OWID_* and
    // blank codes) are not countries: exclude them instead of racing them.
    const hasCodes = parsedTable.some((row) => row.code !== '');
    const parsed = hasCodes
      ? parsedTable.filter((row) => row.code !== '' && !row.code.startsWith('OWID_') && !isAggregateName(row.entity))
      : parsedTable.filter((row) => !isAggregateName(row.entity));
    // Rank by each entity's peak value so the race holds the biggest players
    // rather than the alphabetically first ones.
    const peak = new Map<string, number>();
    for (const row of parsed) peak.set(row.entity, Math.max(peak.get(row.entity) ?? 0, row.value));
    warnings.push(`${parsedTable.length} rows ingested directly from the CSV table`
      + (hasCodes ? `, ${parsedTable.length - parsed.length} aggregate rows excluded` : ''));
    if (parsed.length === 0) {
      errors.push("every row in the CSV was filtered out as an aggregate");
      return { ok: false, warnings, errors };
    }
    const names = Array.from(peak.keys())
      .sort((a, b) => (peak.get(b) ?? 0) - (peak.get(a) ?? 0))
      .slice(0, 40);
    const years = parsed.map((r) => Number(r.date)).filter((y) => Number.isFinite(y));
    plan = {
      measurableDefinition: req.topic,
      unit: "count",
      entityType: "entity",
      entities: names.map((name) => ({
        id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        name,
        group: "All",
      })),
      startYear: Math.min(...years),
      endYear: Math.max(...years),
      searchQueries: [],
    };
    source = { text, url: req.dataUrl };
    rows = parsed.map((r) => ({ ...r, quote: "deterministic CSV ingestion" }));
  } else {
    plan = await planResearch(req, ai);
    source = await gather(req, plan, ai, search, warnings);
  }
  if (rows.length === 0 && source) {
    const extracted = await extractRows(source, plan, ai);
    rows = extracted.rows;
    if (extracted.dropped > 0) warnings.push(`${extracted.dropped} extracted rows dropped (quote guard)`);
  }
  if (!source) {
    warnings.push("no usable source page found; cannot extract a series");
  }

  if (rows.length === 0) {
    errors.push('research produced no observations; the video cannot be built honestly');
    return { ok: false, warnings, errors };
  }

  let facts: VideoInputFact[] = [];
  try {
    const narrated = await composeFacts(rows, req, plan, ai);
    // A fact that names no number is not worth a panel slot ("hit a major
    // milestone"): keep only concrete ones and top up from the data below.
    facts = narrated.filter((fact) => /\d/.test(fact.body ?? ''));
    if (facts.length < narrated.length) {
      warnings.push(`${narrated.length - facts.length} narrated facts dropped (no number in the body)`);
    }
  } catch (error) {
    warnings.push('fact narration unavailable: ' + (error instanceof Error ? error.message : String(error)));
  }
  // Never ship a video with an empty panel: fall back to facts derived from the
  // rows themselves, which cannot invent a number.
  if (facts.length < 3) facts = deriveFacts(rows, plan);
  const byEntity = new Map<string, Array<{ date: string; value: number }>>();
  for (const row of rows) {
    const list = byEntity.get(row.entity) ?? [];
    list.push({ date: row.date, value: row.value });
    byEntity.set(row.entity, list);
  }
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.date, (totals.get(row.date) ?? 0) + row.value);

  const knownIds = new Set(plan.entities.map((e) => e.id));
  const input: VideoInput = {
    version: '1.0',
    title: req.topic,
    metric: plan.measurableDefinition.slice(0, 40),
    unit: plan.unit,
    valueFormat: 'comma',
    canvas: { width: 1280, height: 720, fps: 60 },
    settings: { topN: req.topN ?? 12, secondsPerYear: 17, introSeconds: 5, outroSeconds: 8, finalHoldSeconds: 12 },
    entities: plan.entities
      .filter((e: { name: string; id: string }) => byEntity.has(e.name) || byEntity.has(e.id) || knownIds.has(e.id))
      .map((e: { id: string; name: string; group: string; domain?: string }) => ({ id: e.id, name: e.name, group: e.group, logoUrl: e.domain ? `logos/${e.id}.png` : undefined })),
    observations: rows.map((r) => ({ entity: r.entity, date: r.date, value: r.value })),
    facts,
    groups: Array.from(new Set(plan.entities.map((e: { group: string }) => e.group))).map((g) => ({ id: g, label: g })),
    worldTotal: [...totals.entries()].map(([date, value]) => ({ date, value })).sort((a, b) => Number(a.date) - Number(b.date)),
    sources: source ? `Source: ${source.url}` : undefined,
  };

  const check = validateVideoInput(input);
  if (!check.valid) {
    errors.push(`generated input failed validation: ${check.errors.join('; ')}`);
    return { ok: false, warnings, errors };
  }

  mkdirSync(outDir, { recursive: true });
  const outputPath = join(outDir, `${req.topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}.json`);
  writeFileSync(outputPath, JSON.stringify(input, null, 1), 'utf8');
  return { ok: true, input, outputPath, warnings, errors };
}
