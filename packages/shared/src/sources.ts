/**
 * Direct-download data sources, shared by the research agent and the tools.
 *
 * Our World in Data needs no key and no browser:
 *   discover  GET https://ourworldindata.org/api/search?q=<query>
 *   download  GET https://ourworldindata.org/grapher/<slug>.csv
 *
 * This is the canonical implementation; tools/sources/owid.ts re-exports it so
 * the two never drift.
 */

export const OWID_BASE = 'https://ourworldindata.org';

export interface OwidSearchHit {
  title: string;
  slug: string;
  type: string;
  availableEntities?: string[];
}

export interface OwidRow {
  entity: string;
  code: string;
  year: number;
  value: number;
}

const USER_AGENT = 'analysis-video-maker/0.2 (+https://github.com/toviralideasyt8/analysis-video-maker)';

async function getText(url: string, timeoutMs = 30_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'user-agent': USER_AGENT } });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Discovery. Returns hits that all carry a grapher slug. */
export async function searchOwid(query: string): Promise<OwidSearchHit[]> {
  const body = JSON.parse(await getText(`${OWID_BASE}/api/search?q=${encodeURIComponent(query)}`)) as {
    results?: OwidSearchHit[];
  };
  return (body.results ?? []).filter((hit) => Boolean(hit.slug));
}

/** Only the hits that have a downloadable grapher CSV. */
export async function searchOwidCharts(query: string): Promise<OwidSearchHit[]> {
  const hits = await searchOwid(query);
  return hits.filter((hit) => hit.type === 'chart' || hit.type === 'explorerView');
}

/**
 * Pull the grapher slug out of any Our World in Data link. The site hands out
 * several download shapes for the same chart - with query strings, and as .csv,
 * .zip or .metadata.json - so the slug is the only stable part:
 *
 *   /grapher/population-growth-rates
 *   /grapher/population-growth-rates.zip?v=1&csvType=full
 *   /grapher/population-growth-rates.csv?v=1&useColumnShortNames=false
 */
export function owidSlugFromUrl(url: string): string | null {
  const match = /ourworldindata\.org\/grapher\/([A-Za-z0-9_-]+)/i.exec(url);
  return match ? match[1] : null;
}

/** Rewrite any Owid grapher link to the plain CSV endpoint. */
export function normaliseOwidUrl(url: string): string {
  const slug = owidSlugFromUrl(url);
  return slug ? owidCsvUrl(slug) : url;
}

export const owidCsvUrl = (slug: string): string => `${OWID_BASE}/grapher/${slug}.csv`;
export const fetchOwidCsv = (slug: string): Promise<string> => getText(owidCsvUrl(slug));
export interface OwidColumnMeta {
  titleShort?: string;
  unit?: string;
  shortUnit?: string;
  timespan?: string;
  shortName?: string;
}

export interface OwidMetadata {
  chart?: { title?: string; subtitle?: string; citation?: string };
  columns?: Record<string, OwidColumnMeta>;
}

export const owidMetadataUrl = (slug: string): string => `${OWID_BASE}/grapher/${slug}.metadata.json`;

/** Chart metadata: the unit, title and citation that describe the series. */
export async function fetchOwidMetadata(slug: string): Promise<OwidMetadata> {
  return JSON.parse(await getText(owidMetadataUrl(slug))) as OwidMetadata;
}


/**
 * Parse a grapher CSV. The header is always Entity,Code,Year,<value column>; the
 * value column is whatever is left once entity/code/year are accounted for.
 */
export function parseOwidCsv(text: string): OwidRow[] {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((cell) => cell.trim().toLowerCase());
  const entityIndex = header.findIndex((cell) => cell.includes('entity') || cell.includes('country') || cell === 'name');
  const codeIndex = header.findIndex((cell) => cell === 'code' || cell.includes('iso'));
  const yearIndex = header.findIndex((cell) => cell.includes('year') || cell === 'date');
  const valueIndex = header.findIndex((_, index) => index !== entityIndex && index !== codeIndex && index !== yearIndex);
  if (entityIndex < 0 || yearIndex < 0 || valueIndex < 0) return [];

  const rows: OwidRow[] = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(',');
    const entity = (parts[entityIndex] ?? '').trim();
    const year = Number.parseInt((parts[yearIndex] ?? '').trim(), 10);
    const value = Number.parseFloat((parts[valueIndex] ?? '').trim().replace(/[",\s]/g, ''));
    if (!entity || !Number.isFinite(year) || !Number.isFinite(value)) continue;
    rows.push({ entity, code: codeIndex >= 0 ? (parts[codeIndex] ?? '').trim() : '', year, value });
  }
  return rows;
}

/** OWID aggregates are coded OWID_* (OWID_WRL is World) and are not countries. */
export const isOwidAggregate = (code: string): boolean => code.startsWith('OWID_');

/**
 * Resolve a topic straight to a table: search, take the best chart, download and
 * parse. Returns null when nothing usable is found, so the caller can fall back.
 */
/**
 * Resolve a topic to a grapher table.
 *
 * Owid's search only behaves on short queries: "population" finds the Population
 * chart, while "world population by country" returns health-access charts and the
 * wordier the request the worse it gets. So walk a ladder of progressively
 * simpler queries and prefer a chart whose title is exactly what was asked for.
 */
export async function resolveOwidTable(
  topic: string,
  options: { maxEntities?: number } = {},
): Promise<{ slug: string; title: string; rows: OwidRow[]; countries: OwidRow[] } | null> {
  const DROP = new Set([
    'world', 'global', 'countries', 'country', 'by', 'all', 'top', 'over', 'across',
    'since', 'total', 'list', 'ranking', 'rank', 'chart', 'video', 'data', 'the', 'of', 'in', 'a',
  ]);
  const split = (value: string): string[] => value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const words = (value: string): string[] => split(value).filter((word) => word.length > 2);
  const simplify = (value: string): string => split(value).filter((word) => !DROP.has(word)).join(' ');
  const stop = new Set(['the', 'and', 'per', 'for', 'with', 'from', 'by', 'of', 'in', 'to', 'a', 'total']);

  const core = simplify(topic);
  const ladder = Array.from(new Set([
    topic.trim(),
    core,
    core.split(' ').slice(0, 2).join(' '),
  ].filter((query) => query.length > 2)));

  const topicPhrase = words(topic).join(' ');
  const tokens = words(topic).filter((token) => !stop.has(token));
  const score = (title: string): [number, number, number] => {
    const titleWords = words(title);
    const titlePhrase = titleWords.join(' ');
    const exact = topicPhrase.includes(titlePhrase) || titlePhrase.includes(topicPhrase) ? 1 : 0;
    const overlap = tokens.reduce((sum, token) => sum + (titleWords.includes(token) ? 1 : 0), 0);
    return [exact, overlap, -titleWords.length];
  };

  const exactHits: OwidSearchHit[] = [];
  const otherHits: OwidSearchHit[] = [];
  const seen = new Set<string>();
  for (const query of ladder) {
    let hits: OwidSearchHit[] = [];
    try {
      hits = await searchOwidCharts(query);
    } catch {
      continue;
    }
    const queryPhrase = words(query).join(' ');
    for (const hit of hits) {
      if (seen.has(hit.slug)) continue;
      seen.add(hit.slug);
      const titleWords = words(hit.title);
      const isExact = hit.type === 'chart'
        && (titleWords.join(' ') === queryPhrase || titleWords.join(' ') === topicPhrase);
      if (isExact) exactHits.push(hit);
      else otherHits.push(hit);
    }
  }
  otherHits.sort((a, b) => {
    const left = score(a.title);
    const right = score(b.title);
    return right[0] - left[0] || right[1] - left[1] || right[2] - left[2];
  });

  const tryChart = async (chart: OwidSearchHit): Promise<{ slug: string; title: string; rows: OwidRow[]; countries: OwidRow[] } | null> => {
    try {
      const rows = parseOwidCsv(await fetchOwidCsv(chart.slug));
      if (rows.length < 20) return null;
      const countries = rows.filter((row) => row.code !== '' && !isOwidAggregate(row.code));
      let usable = countries.length >= 10 ? countries : rows;
      if (options.maxEntities) {
        const kept = new Set<string>();
        const trimmed: OwidRow[] = [];
        for (const row of usable) {
          const key = row.code || row.entity;
          if (!kept.has(key)) {
            if (kept.size >= options.maxEntities) continue;
            kept.add(key);
          }
          trimmed.push(row);
        }
        usable = trimmed;
      }
      return { slug: chart.slug, title: chart.title, rows: usable, countries: usable };
    } catch {
      return null;
    }
  };

  for (const chart of [...exactHits, ...otherHits.slice(0, 8)]) {
    const resolved = await tryChart(chart);
    if (resolved) return resolved;
  }
  return null;
}
