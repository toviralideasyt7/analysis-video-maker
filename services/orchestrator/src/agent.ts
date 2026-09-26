/**
 * Agent mode: a natural-language video request becomes a research decision.
 *
 *   prompt -> AgentDecision { topic, entityKind, metric, unit, topN,
 *                              years, worldBankIndicator | owidSlug | table }
 *
 * The decision, not a form, drives research:
 *  - direct data URLs in the prompt are downloaded and normalized first;
 *  - otherwise the agent classifies the topic against the tiered source
 *    registry, proposes World Bank / OWID candidates, probes each for its
 *    real year coverage, and picks the WIDEST range;
 *  - requested years are always clamped to what the data actually covers
 *    (2026 -> 2025 when 2026 has no data yet);
 *  - any race kind works: countries, platforms, browsers, companies,
 *    historical empires - entityKind 'custom' skips country-only handling.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getText, parseCsv } from './connectors';
import { createAIClient } from './providers/ai';
import { tableFromJsonArray } from './research';
import { logger } from './runtime';

/**
 * Parse HTML tables into a unified {columns, rows}. Handles Wikipedia-style
 * pages with multiple tables covering different year ranges: tables with
 * compatible headers (entity + year columns) are merged.
 */
function parseHtmlTables(html: string): { columns: string[]; rows: string[][] } | null {
  // Simple regex-based table parser (no external deps). Extracts text content
  // from <table> -> <tr> -> <td>/<th>, stripping inner tags and citations.
  const tables: string[][][] = [];
  const tableRe = /<table[\s>][\s\S]*?<\/table\s*>/gi;
  let tableMatch: RegExpExecArray | null;
  while ((tableMatch = tableRe.exec(html)) !== null) {
    const tableHtml = tableMatch[0];
    const rows: string[][] = [];
    const rowRe = /<tr[\s>][\s\S]*?<\/tr\s*>/gi;
    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = rowRe.exec(tableHtml)) !== null) {
      const rowHtml = rowMatch[0];
      const cells: string[] = [];
      const cellRe = /<(td|th)[\s>][\s\S]*?<\/\1\s*>/gi;
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
        let text = cellMatch[0]
          .replace(/<[^>]+>/g, ' ')           // strip tags
          .replace(/\[\s*\d+\s*\]/g, '')       // strip citations [1], [2]
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/\s+/g, ' ')
          .trim();
        cells.push(text);
      }
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length >= 2) tables.push(rows); // need header + at least 1 data row
  }
  if (tables.length === 0) return null;

  // Find tables that look like data tables: first cell of header is an entity
  // label, remaining headers contain 4-digit years.
  const yearRe = /\b(19|20)\d{2}\b/;
  const dataTables = tables.filter((t) => {
    const header = t[0];
    return header.length >= 2 && header.slice(1).some((h) => yearRe.test(h));
  });
  if (dataTables.length === 0) return null;

  // Merge tables with compatible structure. Use the first table's entity
  // column header; collect all year columns across tables.
  const entityHeader = dataTables[0][0][0];
  const yearCols = new Map<string, number>(); // year -> column index in merged
  const mergedRows = new Map<string, Map<string, string>>(); // entity -> year -> value

  for (const table of dataTables) {
    const header = table[0];
    // Map this table's column indices to years
    const colToYear = new Map<number, string>();
    for (let c = 1; c < header.length; c++) {
      const m = header[c].match(yearRe);
      if (m) colToYear.set(c, m[0]);
    }
    if (colToYear.size === 0) continue;
    for (let r = 1; r < table.length; r++) {
      const row = table[r];
      const entity = (row[0] ?? '').trim();
      if (!entity) continue;
      if (!mergedRows.has(entity)) mergedRows.set(entity, new Map());
      const entityYears = mergedRows.get(entity)!;
      for (const [colIdx, year] of colToYear) {
        const val = (row[colIdx] ?? '').trim();
        if (val && !entityYears.has(year)) entityYears.set(year, val);
      }
    }
  }

  const allYears = [...new Set([...mergedRows.values()].flatMap((m) => [...m.keys()]))].sort();
  if (allYears.length === 0 || mergedRows.size === 0) return null;

  const columns = [entityHeader, ...allYears];
  const rows: string[][] = [];
  for (const [entity, yearMap] of mergedRows) {
    rows.push([entity, ...allYears.map((y) => yearMap.get(y) ?? '')]);
  }
  return { columns, rows };
}

export interface PreloadedTable {
  columns: string[];
  rows: string[][];
  unit: string;
  sourceName: string;
  sourceUrl: string;
  yearMin?: number;
  yearMax?: number;
}

export interface AgentDecision {
  topic: string;
  entityKind: 'country' | 'custom';
  metric: string;
  unit: string;
  topN: number;
  yearFrom?: number;
  yearTo?: number;
  worldBankIndicator?: string;
  owidSlug?: string;
  directUrls: string[];
  table?: PreloadedTable;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Tiered source registry (condensed from the user's source list).
// Tier 1 = official/authoritative, checked first. Tier 2 = high-quality
// curated. Tier 3 = discovery. Tier 4 = other/public.
// `api` carries a URL template the agent can call directly; without it the
// agent uses web search + page fetch for that source.
// ---------------------------------------------------------------------------

export interface TierSource {
  name: string;
  url: string;
  tier: 1 | 2 | 3 | 4;
  topics: string[];
  api?: string;
  note?: string;
}

export const TIER_SOURCES: TierSource[] = [
  // Tier 1 — official / highly authoritative
  { name: 'World Bank Open Data', url: 'https://data.worldbank.org/', tier: 1, topics: ['economy', 'population', 'health', 'education', 'energy', 'environment', 'labour', 'agriculture', 'trade'], api: 'https://api.worldbank.org/v2/country/all/indicator/{indicator}?format=json&date={from}:{to}&per_page=20000' },
  { name: 'UNdata', url: 'https://data.un.org/', tier: 1, topics: ['population', 'health', 'education', 'agriculture', 'energy', 'trade', 'environment'] },
  { name: 'UN SDG Database', url: 'https://unstats.un.org/sdgs/dataportal/', tier: 1, topics: ['economy', 'health', 'education', 'environment', 'energy', 'population'] },
  { name: 'OECD Data Explorer', url: 'https://data-explorer.oecd.org/', tier: 1, topics: ['economy', 'labour', 'education', 'energy', 'industry'] },
  { name: 'IMF Data', url: 'https://data.imf.org/', tier: 1, topics: ['economy', 'finance'], api: 'https://www.imf.org/external/datamapper/api/v1/{indicator}', note: 'DataMapper API: /api/v1/{indicator} e.g. NGDP_RPCH' },
  { name: 'WHO Global Health Observatory', url: 'https://www.who.int/data/gho', tier: 1, topics: ['health'], api: 'https://ghoapi.azureedge.net/api/{code}' },
  { name: 'FAOSTAT', url: 'https://www.fao.org/faostat/', tier: 1, topics: ['agriculture'] },
  { name: 'ILOSTAT', url: 'https://ilostat.ilo.org/data/', tier: 1, topics: ['labour'], api: 'https://ilostat.ilo.org/data/bulk/', note: 'bulk CSV downloads' },
  { name: 'UNESCO Institute for Statistics', url: 'https://uis.unesco.org/', tier: 1, topics: ['education'], api: 'https://api.uis.unesco.org/sdmx/data/{flow}' },
  { name: 'ITU DataHub', url: 'https://datahub.itu.int/', tier: 1, topics: ['technology'] },
  { name: 'UN Comtrade', url: 'https://comtradeplus.un.org/', tier: 1, topics: ['trade'], api: 'https://comtradeapi.un.org/public/v1/preview/C/A/HS' },
  { name: 'WTO Stats', url: 'https://stats.wto.org/', tier: 1, topics: ['trade'] },
  { name: 'IEA Data', url: 'https://www.iea.org/data-and-statistics', tier: 1, topics: ['energy'] },
  { name: 'FRED', url: 'https://fred.stlouisfed.org/', tier: 1, topics: ['economy', 'finance', 'labour'], api: 'https://api.stlouisfed.org/fred/series/observations?series_id={id}&file_type=json', note: 'needs free API key' },
  { name: 'Eurostat', url: 'https://ec.europa.eu/eurostat/', tier: 1, topics: ['economy', 'population', 'energy', 'labour', 'transport'] },
  { name: 'UN Population Division (WPP)', url: 'https://population.un.org/wpp/', tier: 1, topics: ['population'] },
  { name: 'U.S. EIA Open Data', url: 'https://www.eia.gov/opendata/', tier: 1, topics: ['energy'], api: 'https://api.eia.gov/v2/{route}?api_key={key}', note: 'needs free API key' },
  { name: 'Data.gov.in', url: 'https://www.data.gov.in/', tier: 1, topics: ['india'] },
  { name: 'RBI DBIE', url: 'https://data.rbi.org.in/', tier: 1, topics: ['india', 'economy', 'finance'] },
  { name: 'Census of India', url: 'https://censusindia.gov.in/', tier: 1, topics: ['india', 'population'] },
  // Tier 2 — high-quality curated
  { name: 'Our World in Data', url: 'https://ourworldindata.org/', tier: 2, topics: ['population', 'health', 'economy', 'energy', 'environment', 'education', 'technology', 'agriculture'], api: 'https://ourworldindata.org/grapher/{slug}.csv', note: 'any grapher chart slug + .csv downloads the data' },
  { name: 'Data Commons', url: 'https://datacommons.org/', tier: 2, topics: ['population', 'economy', 'health', 'energy', 'environment'] },
  { name: 'Ember Energy Data', url: 'https://ember-energy.org/data/', tier: 2, topics: ['energy', 'environment'] },
  { name: 'Climate Watch', url: 'https://www.climatewatchdata.org/', tier: 2, topics: ['environment', 'energy'] },
  { name: 'Global Carbon Atlas', url: 'https://globalcarbonatlas.org/', tier: 2, topics: ['environment'] },
  { name: 'Energy Institute Statistical Review', url: 'https://www.energyinst.org/statistical-review', tier: 2, topics: ['energy'] },
  { name: 'IHME GHDx', url: 'https://ghdx.healthdata.org/', tier: 2, topics: ['health'] },
  { name: 'UNICEF Data', url: 'https://data.unicef.org/', tier: 2, topics: ['health', 'population', 'education'] },
  { name: 'StatCounter GlobalStats', url: 'https://gs.statcounter.com/', tier: 2, topics: ['technology'], note: 'browser/OS/social-media market share time series' },
  { name: 'DataReportal', url: 'https://datareportal.com/', tier: 2, topics: ['technology'] },
  { name: 'CompaniesMarketCap', url: 'https://companiesmarketcap.com/', tier: 2, topics: ['finance', 'economy'] },
  { name: 'Macrotrends', url: 'https://www.macrotrends.net/', tier: 2, topics: ['finance', 'economy'] },
  { name: 'OEC', url: 'https://oec.world/', tier: 2, topics: ['trade', 'economy'] },
  { name: 'UNIDO Statistics', url: 'https://stat.unido.org/', tier: 2, topics: ['industry'] },
  { name: 'World Resources Institute', url: 'https://www.wri.org/data', tier: 2, topics: ['environment', 'energy'] },
  { name: 'Global Forest Watch', url: 'https://www.globalforestwatch.org/', tier: 2, topics: ['environment'] },
  { name: 'Penn World Table', url: 'https://www.rug.nl/ggdc/productivity/pwt/', tier: 2, topics: ['economy'] },
  // Tier 3 — discovery
  { name: 'Google Dataset Search', url: 'https://datasetsearch.research.google.com/', tier: 3, topics: [] },
  { name: 'Kaggle Datasets', url: 'https://www.kaggle.com/datasets', tier: 3, topics: [] },
  { name: 'Hugging Face Datasets', url: 'https://huggingface.co/datasets', tier: 3, topics: [] },
  { name: 'AWS Open Data Registry', url: 'https://registry.opendata.aws/', tier: 3, topics: [] },
  { name: 'Data.gov', url: 'https://data.gov/', tier: 3, topics: [] },
  { name: 'Data.europa.eu', url: 'https://data.europa.eu/', tier: 3, topics: [] },
  // Tier 4 — other/public
  { name: 'Zenodo', url: 'https://zenodo.org/', tier: 4, topics: [] },
  { name: 'Figshare', url: 'https://figshare.com/', tier: 4, topics: [] },
  { name: 'Internet Archive', url: 'https://archive.org/', tier: 4, topics: [] },
  { name: 'Common Crawl', url: 'https://commoncrawl.org/', tier: 4, topics: [] },
  { name: 'Natural Earth', url: 'https://www.naturalearthdata.com/', tier: 4, topics: [] },
];

/** Sources for a topic class, tier 1 first. */
export function sourcesForTopics(topics: string[]): TierSource[] {
  const scored = TIER_SOURCES.map((s) => ({
    s,
    hits: s.topics.filter((t) => topics.includes(t)).length,
  })).filter((x) => x.hits > 0 || x.s.tier <= 2);
  scored.sort((a, b) => a.s.tier - b.s.tier || b.hits - a.hits);
  return scored.map((x) => x.s);
}

// ---------------------------------------------------------------------------
// Prompt parsing
// ---------------------------------------------------------------------------

const URL_RE = /https?:\/\/[^\s)"']+/g;

export function extractUrls(prompt: string): string[] {
  const found = prompt.match(URL_RE) ?? [];
  return [...new Set(found.map((u) => u.replace(/[.,;]+$/, '')))];
}

const TOPIC_KEYWORDS: Array<{ re: RegExp; topics: string[] }> = [
  { re: /\b(poverty|poor|inequality|gini)\b/i, topics: ['economy'] },
  { re: /\b(gdp|economy|economic|income|debt|inflation|trade|export|import)\b/i, topics: ['economy'] },
  { re: /\b(population|demograph|birth|death|migration|urban)\b/i, topics: ['population'] },
  { re: /\b(health|disease|mortality|life expectancy|hospital|vaccine)\b/i, topics: ['health'] },
  { re: /\b(energy|electricity|oil|gas|coal|solar|wind|nuclear|renewable)\b/i, topics: ['energy'] },
  { re: /\b(climate|carbon|co2|emission|temperature|forest|pollution)\b/i, topics: ['environment'] },
  { re: /\b(school|education|literacy|university|student)\b/i, topics: ['education'] },
  { re: /\b(job|employment|unemployment|labour|labor|wage)\b/i, topics: ['labour'] },
  { re: /\b(farm|crop|agriculture|food|wheat|rice)\b/i, topics: ['agriculture'] },
  { re: /\b(browser|social media|internet|smartphone|app |apps|platform|website)\b/i, topics: ['technology'] },
  { re: /\b(stock|market cap|company|companies|bank|finance)\b/i, topics: ['finance'] },
  { re: /\b(india|indian)\b/i, topics: ['india'] },
  { re: /\b(sport|football|cricket|olympic|fifa)\b/i, topics: ['sports'] },
  { re: /\b(industry|manufacturing|steel|cement)\b/i, topics: ['industry'] },
];

export function classifyTopics(prompt: string): string[] {
  const topics = new Set<string>();
  for (const { re, topics: ts } of TOPIC_KEYWORDS) {
    if (re.test(prompt)) for (const t of ts) topics.add(t);
  }
  return [...topics];
}

const YEAR_RANGE_RE = /(?:from\s+)?(\d{1,5})\s*(bc|bce|ad|ce)?\s*(?:to|-|–|until)\s*(\d{1,5})\s*(bc|bce|ad|ce)?/i;

export function parseYearPreference(prompt: string): { from?: number; to?: number } {
  const m = YEAR_RANGE_RE.exec(prompt);
  if (!m) return {};
  const num = (v: string, era?: string): number => {
    const n = Number(v);
    return /^(bc|bce)$/i.test(era ?? '') ? -n : n;
  };
  let from = num(m[1], m[2]);
  let to = num(m[3], m[4]);
  if (from > to) [from, to] = [to, from];
  if (from < -20000 || to > 2100) return {};
  return { from, to };
}

export function parseTopN(prompt: string): number {
  const m = /top\s*(\d{1,3})/i.exec(prompt);
  if (m) return Math.min(30, Math.max(3, Number(m[1])));
  return 10;
}

// ---------------------------------------------------------------------------
// Direct URL ingestion: CSV / JSON / ZIP -> normalized table
// ---------------------------------------------------------------------------

async function unzipToCsvAsync(zipBytes: Buffer): Promise<{ name: string; text: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'avm-zip-'));
  const zipPath = join(dir, 'data.zip');
  writeFileSync(zipPath, zipBytes);
  try {
    const names: string = await new Promise((resolve, reject) => {
      execFile('unzip', ['-Z1', zipPath], { timeout: 30000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    const pick = names.split('\n').map((s) => s.trim()).find((s) => /\.(csv|tsv|txt)$/i.test(s));
    if (!pick) throw new Error('zip contains no CSV/TSV');
    const text: string = await new Promise((resolve, reject) => {
      execFile('unzip', ['-p', zipPath, pick], { timeout: 60000, maxBuffer: 300 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    return { name: pick, text };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function hostOf(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    // Local/test URLs have no meaningful publisher: fall back to the file
    // name ("browsers.csv" -> "browsers") instead of "localhost".
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(host)) {
      const stem = u.pathname.split('/').filter(Boolean).pop()?.replace(/\.[a-z0-9]+$/i, '');
      if (stem) return stem;
    }
    return host;
  } catch {
    return 'source';
  }
}

function sniffUnit(columns: string[], prompt: string): string {
  const cols = columns.join(' ').toLowerCase();
  if (/%|percent|share|rate|ratio/.test(cols) || /percent|share|rate/.test(prompt.toLowerCase())) return 'percent';
  if (/\b(usd|dollar|gdp|income|price|cost|revenue)\b/.test(cols)) return 'USD';
  if (/\b(km2|km²|sq\s?km|area)\b/.test(cols) || /\b(area|land area)\b/.test(prompt.toLowerCase())) return 'km²';
  if (/\bpopulation\b/.test(cols) || /\bpopulation\b/.test(prompt.toLowerCase())) return 'people';
  return 'count';
}

/** Download one URL and normalize it to a table. Returns null when unusable. */
export async function ingestUrl(url: string, prompt: string): Promise<PreloadedTable | null> {
  const notes: string[] = [];
  try {
    const looksZip = /\.zip(\?|$)/i.test(url);
    let columns: string[] = [];
    let rows: string[][] = [];
    if (looksZip) {
      const res = await fetch(url, { headers: { 'User-Agent': 'analysis-video-maker/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const { name, text } = await unzipToCsvAsync(buf);
      const parsed = parseCsv(text, name.toLowerCase().endsWith('.tsv') ? '\t' : ',');
      columns = parsed.columns;
      rows = parsed.rows;
      notes.push(`unzipped ${name}: ${rows.length} rows`);
    } else {
      const { text, status, contentType } = await getText(url, { timeoutMs: 90000 });
      if (status !== 200) throw new Error(`HTTP ${status}`);
      const trimmed = text.trimStart();
      const looksJson = /json/i.test(contentType ?? '') || trimmed.startsWith('[') || trimmed.startsWith('{');
      const looksHtml = /html/i.test(contentType ?? '') || /^<!DOCTYPE html/i.test(trimmed) || /^<html/i.test(trimmed);
      if (looksJson) {
        let parsed: unknown = JSON.parse(text);
        if (!Array.isArray(parsed)) {
          // common wrappers: { data: [...] }, { results: [...] }
          const obj = parsed as Record<string, unknown>;
          const inner = ['data', 'results', 'rows', 'observations'].map((k) => obj[k]).find(Array.isArray);
          if (!inner) throw new Error('JSON is not a row array');
          parsed = inner;
        }
        const table = tableFromJsonArray(parsed as unknown[]);
        columns = table.columns;
        rows = table.rows;
      } else if (looksHtml) {
        const htmlTable = parseHtmlTables(text);
        if (!htmlTable) throw new Error('no data tables found in HTML');
        columns = htmlTable.columns;
        rows = htmlTable.rows;
        notes.push(`parsed ${columns.length - 1} year columns, ${rows.length} entities from HTML tables`);
      } else {
        const parsed = parseCsv(text, /\.tsv(\?|$)/i.test(url) ? '\t' : ',');
        columns = parsed.columns;
        rows = parsed.rows;
      }
    }
    if (rows.length === 0) throw new Error('no rows parsed');
    // Year span of the table: find the year column by header, scan every row.
    // For wide-format tables (years as column headers, e.g. from HTML),
    // derive the range directly from the headers.
    let yearMin: number | undefined;
    let yearMax: number | undefined;
    const headerYears = columns
      .map((c) => {
        const m = /^(\d{4})$/.exec(c.trim());
        return m ? Number(m[1]) : null;
      })
      .filter((y): y is number => y !== null && y >= 1000 && y <= 2100);
    if (headerYears.length >= 2) {
      yearMin = Math.min(...headerYears);
      yearMax = Math.max(...headerYears);
    } else {
      const yearIdx = columns.findIndex((c) => /^(year|date)$/i.test(c.trim()));
      const scanIdx = yearIdx >= 0 ? yearIdx : -1;
      const scanCell = (cell: string | undefined): void => {
        const m = /^(-?\d{1,5})$/.exec((cell ?? '').trim());
        if (!m) return;
        const y = Number(m[1]);
        if (y < -20000 || y > 2100) return;
        yearMin = yearMin === undefined ? y : Math.min(yearMin, y);
        yearMax = yearMax === undefined ? y : Math.max(yearMax, y);
      };
      if (scanIdx >= 0) {
        for (const row of rows) scanCell(row[scanIdx]);
      } else {
        for (const row of rows.slice(0, 20000)) for (const cell of row) scanCell(cell);
      }
    }
    return {
      columns,
      rows,
      unit: sniffUnit(columns, prompt),
      sourceName: hostOf(url),
      sourceUrl: url,
      yearMin,
      yearMax,
      // @ts-expect-error debug aid, stripped by callers that don't need it
      _notes: notes,
    };
  } catch (error) {
    logger.warn('agent: direct URL ingest failed', { url, error: String(error) });
    return null;
  }
}

export async function ingestDirectUrls(urls: string[], prompt: string): Promise<{ table?: PreloadedTable; notes: string[] }> {
  const notes: string[] = [];
  for (const url of urls.slice(0, 3)) {
    const table = await ingestUrl(url, prompt);
    if (table && table.rows.length >= 10) {
      notes.push(`using direct data URL ${url} (${table.rows.length} rows${table.yearMin !== undefined ? `, ${table.yearMin}-${table.yearMax}` : ''})`);
      return { table, notes };
    }
    notes.push(`direct URL ${url} unusable, trying next`);
  }
  return { notes };
}

// ---------------------------------------------------------------------------
// Range probing: pick the WIDEST real coverage among candidates
// ---------------------------------------------------------------------------

export async function probeWorldBankRange(indicator: string): Promise<{ from: number; to: number } | null> {
  try {
    // Sample large countries; the union of their covered years approximates
    // the indicator's real span without paging the whole world.
    const url = `https://api.worldbank.org/v2/country/USA;CHN;IND/indicator/${encodeURIComponent(indicator)}?format=json&date=1800:2100&per_page=20000`;
    const { text } = await getText(url, { timeoutMs: 60000 });
    const parsed = JSON.parse(text) as Array<{ date?: string; value?: number | null } | { message?: unknown }>;
    const rows = Array.isArray(parsed) ? parsed[1] : null;
    if (!Array.isArray(rows)) return null;
    let from = Infinity;
    let to = -Infinity;
    for (const r of rows as Array<{ date?: string; value?: number | null }>) {
      if (r.value === null || r.value === undefined) continue;
      const y = Number(r.date);
      if (!Number.isFinite(y)) continue;
      from = Math.min(from, y);
      to = Math.max(to, y);
    }
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    return { from, to };
  } catch {
    return null;
  }
}

export async function probeOwidRange(slug: string): Promise<{ from: number; to: number } | null> {
  try {
    const { text, status } = await getText(`https://ourworldindata.org/grapher/${slug}.csv`, { timeoutMs: 90000 });
    if (status !== 200) return null;
    const { rows } = parseCsv(text);
    let from = Infinity;
    let to = -Infinity;
    for (const row of rows) {
      for (const cell of row) {
        const m = /^(-?\d{1,4})$/.exec((cell ?? '').trim());
        if (!m) continue;
        const y = Number(m[1]);
        if (y < 1700 || y > 2100) continue;
        from = Math.min(from, y);
        to = Math.max(to, y);
        break;
      }
    }
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    return { from, to };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

const KNOWN_TOPICS: Array<{ re: RegExp; make: (prompt: string) => Partial<AgentDecision> }> = [
  {
    re: /\bpoverty\b/i,
    make: () => ({ topic: 'Countries by poverty rate', entityKind: 'country', metric: 'poverty headcount ratio', unit: 'percent', worldBankIndicator: 'SI.POV.DDAY' }),
  },
  {
    re: /\bpopulation\b/i,
    make: () => ({ topic: 'World population by country', entityKind: 'country', metric: 'total population', unit: 'count', worldBankIndicator: 'SP.POP.TOTL' }),
  },
  {
    re: /\bgdp\b/i,
    make: () => ({ topic: 'Largest economies by GDP', entityKind: 'country', metric: 'GDP (current US$)', unit: 'USD', worldBankIndicator: 'NY.GDP.MKTP.CD' }),
  },
  {
    re: /\blife expectancy\b/i,
    make: () => ({ topic: 'Life expectancy by country', entityKind: 'country', metric: 'life expectancy at birth', unit: 'years', owidSlug: 'life-expectancy' }),
  },
  {
    re: /\bbrowsers?\b/i,
    make: () => ({ topic: 'Most popular web browsers', entityKind: 'custom', metric: 'browser market share', unit: 'percent' }),
  },
  {
    re: /\bsocial media\b/i,
    make: () => ({ topic: 'Most popular social media platforms', entityKind: 'custom', metric: 'monthly active users', unit: 'count' }),
  },
  {
    re: /\bco2\b|\bcarbon\b|\bemission\b/i,
    // World Bank's EN.ATM.CO2E.KT is retired (archived, probe returns
    // nothing). OWID's annual-co2-emissions grapher CSV (Global Carbon
    // Project, 1750-2024, tonnes) is the working direct source. Verified 2026-09-26.
    make: () => ({ topic: 'CO2 emissions by country', entityKind: 'country', metric: 'CO2 emissions', unit: 't', owidSlug: 'annual-co2-emissions' }),
  },
];

function deterministicDecide(prompt: string, directUrls: string[]): AgentDecision {
  const years = parseYearPreference(prompt);
  const topN = parseTopN(prompt);
  const base: AgentDecision = {
    // Strip the URL plus any dangling "Data:"/"Source:" label the user put
    // before it, so the video title never ends with a stray "Data:".
    topic: prompt
      .replace(URL_RE, '')
      .replace(/\s*\b(data|source|link|url)\s*:\s*$/i, '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 120) || 'Data race',
    entityKind: /\b(countr|nation|state)s?\b/i.test(prompt) ? 'country' : 'custom',
    metric: 'value',
    unit: 'count',
    topN,
    yearFrom: years.from,
    yearTo: years.to,
    directUrls,
    notes: [],
  };
  for (const { re, make } of KNOWN_TOPICS) {
    if (re.test(prompt)) return { ...base, ...make(prompt) };
  }
  base.notes.push('no known-topic match; researcher will web-search for sources');
  return base;
}

/** Drop undefined values so a merge keeps the base's field. Nulls are kept (explicit "none"). */
function defined<T extends object>(partial: T | null | undefined): Partial<T> {
  if (!partial) return {};
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(partial)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function tierContext(topics: string[]): string {
  return sourcesForTopics(topics)
    .slice(0, 18)
    .map((s) => `- [T${s.tier}] ${s.name} (${s.url})${s.api ? ` API: ${s.api}` : ''}`)
    .join('\n');
}

async function decideWithAi(prompt: string, directUrls: string[]): Promise<Partial<AgentDecision> | null> {
  const topics = classifyTopics(prompt);
  const ai = createAIClient();
  const system = [
    'You plan data-race videos. Output JSON ONLY, no markdown, no commentary.',
    'Schema: {"topic": string, "entityKind": "country"|"custom", "metric": string, "unit": string,',
    ' "topN": number, "yearFrom": number|null, "yearTo": number|null,',
    ' "worldBankIndicator": string|null, "owidSlug": string|null, "reasoning": string}',
    'Rules:',
    '- entityKind is "country" only for country races; platforms, browsers, companies, empires -> "custom".',
    '- Prefer a World Bank indicator id (e.g. SP.POP.TOTL) or an OWID grapher slug when the topic fits; else null and the researcher will web-search.',
    '- For CO2 / carbon emissions topics use owidSlug "annual-co2-emissions" (unit "t"); do not invent other CO2 slugs. World Bank indicator EN.ATM.CO2E.KT is retired - never use it.',
    '- yearFrom/yearTo: the years the user asked for, or null when not stated.',
    '- topN defaults to 10.',
    '- unit: count | percent | USD | years | kt — pick what the metric really is.',
    'Authoritative sources to prefer (tier 1 first):',
    tierContext(topics),
  ].join('\n');
  try {
    const res = await ai.complete({ system, prompt: `Video request: ${prompt}`, maxTokens: 800, temperature: 0.2 });
    const text = res.text ?? '';
    const jsonText = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const years = parseYearPreference(prompt);
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    // Sanity: a planner that returns none of topic/metric/indicator/slug
    // (e.g. a mock or a refusal) is not a plan — signal fallback.
    if (!str(parsed.topic) && !str(parsed.metric) && !str(parsed.worldBankIndicator) && !str(parsed.owidSlug)) {
      logger.warn('agent: AI planner returned an empty plan, using deterministic fallback');
      return null;
    }
    return {
      topic: str(parsed.topic),
      entityKind: parsed.entityKind === 'country' || parsed.entityKind === 'custom' ? parsed.entityKind : undefined,
      metric: str(parsed.metric),
      unit: str(parsed.unit),
      yearFrom: years.from ?? num(parsed.yearFrom),
      yearTo: years.to ?? num(parsed.yearTo),
      worldBankIndicator: str(parsed.worldBankIndicator),
      owidSlug: str(parsed.owidSlug),
      notes: [`AI planner: ${str(parsed.reasoning)?.slice(0, 200) ?? 'n/a'}`],
    };
  } catch (error) {
    logger.warn('agent: AI planner failed, using deterministic fallback', { error: String(error) });
    return null;
  }
}

/**
 * Full decision: parse prompt -> maybe ingest direct URLs -> plan ->
 * probe candidate ranges and keep the widest real coverage.
 */
export async function decideAgentPlan(prompt: string): Promise<AgentDecision> {
  const directUrls = extractUrls(prompt);
  const notes: string[] = [];

  // Direct data links win outright: download and normalize now.
  if (directUrls.length > 0) {
    const { table, notes: ingestNotes } = await ingestDirectUrls(directUrls, prompt);
    notes.push(...ingestNotes);
    if (table) {
      const years = parseYearPreference(prompt);
      const decision: AgentDecision = {
        ...deterministicDecide(prompt, directUrls),
        table,
        // The table's own span is the truth; user years only narrow it.
        yearFrom: years.from ?? table.yearMin,
        yearTo: years.to ?? table.yearMax,
        notes: [...notes, 'direct-URL mode: dataset comes from the provided link'],
      };
      // Guess country vs custom from the table's entity column. A single
      // country-named row (e.g. "United States" listed as an empire) must not
      // flip the kind: require several distinct country hits, and never count
      // names that are clearly historical polities (empires, dynasties...).
      const polityRe = /empire|dynasty|kingdom|caliphate|khanate|sultanate|confederacy|republic/i;
      const countryRe =
        /\b(afghanistan|albania|algeria|argentina|armenia|australia|austria|azerbaijan|bangladesh|belgium|benin|bolivia|brazil|bulgaria|cameroon|canada|chad|chile|china|colombia|cuba|czechia|denmark|ecuador|egypt|ethiopia|finland|france|georgia|germany|ghana|greece|guatemala|guinea|haiti|honduras|hungary|india|indonesia|iran|iraq|ireland|israel|italy|japan|jordan|kazakhstan|kenya|kuwait|lebanon|libya|malaysia|mali|mexico|mongolia|morocco|mozambique|myanmar|nepal|netherlands|nicaragua|niger|nigeria|norway|oman|pakistan|paraguay|peru|philippines|poland|portugal|qatar|romania|russia|rwanda|saudi arabia|senegal|serbia|somalia|south africa|south korea|spain|sudan|sweden|switzerland|syria|taiwan|tanzania|thailand|togo|tunisia|turkey|uganda|ukraine|united arab emirates|united kingdom|united states|uruguay|uzbekistan|venezuela|vietnam|yemen|zambia|zimbabwe)\b/;
      const distinctNames = [...new Set(table.rows.slice(0, 60).map((r) => String(r[0] ?? '')))].filter(
        (n) => n && !polityRe.test(n),
      );
      const countryHits = distinctNames.filter((n) => countryRe.test(n.toLowerCase()));
      if (countryHits.length >= 3) decision.entityKind = 'country';
      return decision;
    }
    notes.push('no direct URL yielded a table; falling back to source search');
  }

  const base = deterministicDecide(prompt, directUrls);
  const aiPartial = await decideWithAi(prompt, directUrls);
  // The deterministic baseline always applies; the AI only refines fields it
  // actually returned. A mock/empty AI plan can never wipe the baseline.
  const decision: AgentDecision = { ...base, ...defined(aiPartial) };
  decision.notes = [
    ...(aiPartial?.notes ?? ['deterministic planner (AI planner unreachable or empty)']),
    ...base.notes,
    ...notes,
  ];

  // Widest-range-wins: probe the proposed candidates and keep the one with
  // the broadest real coverage. Requested years are a preference; the probe
  // result is the truth we clamp to.
  const candidates: Array<{ kind: 'wb' | 'owid'; id: string; range: { from: number; to: number } }> = [];
  if (decision.worldBankIndicator) {
    const r = await probeWorldBankRange(decision.worldBankIndicator);
    if (r) candidates.push({ kind: 'wb', id: decision.worldBankIndicator, range: r });
    else decision.notes.push(`World Bank ${decision.worldBankIndicator}: no data found via probe`);
  }
  if (decision.owidSlug) {
    const r = await probeOwidRange(decision.owidSlug);
    if (r) candidates.push({ kind: 'owid', id: decision.owidSlug, range: r });
    else decision.notes.push(`OWID ${decision.owidSlug}: probe failed`);
  }
  if (candidates.length > 1) {
    candidates.sort((a, b) => b.range.to - b.range.from - (a.range.to - a.range.from));
    const winner = candidates[0];
    decision.notes.push(
      `widest range wins: ${winner.kind === 'wb' ? 'World Bank ' + winner.id : 'OWID ' + winner.id} ` +
        `(${winner.range.from}-${winner.range.to}) beats ` +
        candidates.slice(1).map((c) => `${c.kind === 'wb' ? c.id : c.id} (${c.range.from}-${c.range.to})`).join(', '),
    );
    if (winner.kind === 'wb') decision.owidSlug = undefined;
    else decision.worldBankIndicator = undefined;
  }
  const winnerRange = candidates[0]?.range;
  if (winnerRange) {
    // Clamp the user's wish to reality (2026 -> 2025 when 2026 has no data).
    if (decision.yearFrom !== undefined) {
      const clamped = Math.max(decision.yearFrom, winnerRange.from);
      if (clamped !== decision.yearFrom) decision.notes.push(`from-year clamped ${decision.yearFrom} -> ${clamped} (data starts ${winnerRange.from})`);
      decision.yearFrom = clamped;
    } else {
      decision.yearFrom = winnerRange.from;
    }
    if (decision.yearTo !== undefined) {
      const clamped = Math.min(decision.yearTo, winnerRange.to);
      if (clamped !== decision.yearTo) decision.notes.push(`to-year clamped ${decision.yearTo} -> ${clamped} (data ends ${winnerRange.to})`);
      decision.yearTo = clamped;
    } else {
      decision.yearTo = winnerRange.to;
    }
  }
  // Drop candidates whose probe found nothing so the pipeline doesn't chase ghosts.
  if (decision.worldBankIndicator && !candidates.some((c) => c.kind === 'wb')) decision.worldBankIndicator = undefined;
  if (decision.owidSlug && !candidates.some((c) => c.kind === 'owid')) decision.owidSlug = undefined;

  return decision;
}
