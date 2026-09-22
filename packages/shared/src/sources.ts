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
export async function resolveOwidTable(topic: string, options: { maxEntities?: number } = {}): Promise<
  | { slug: string; title: string; rows: OwidRow[]; countries: OwidRow[] }
  | null
> {
  const charts = await searchOwidCharts(topic);

  // OWID search is relevance-ordered but loose: "renewable energy capacity"
  // returns a per-capita-vs-electricity scatter before the capacity series. Rank
  // the candidates by how many of the topic's own words appear in the title, so
  // the closest chart is tried first.
  const stop = new Set(['the', 'and', 'per', 'for', 'with', 'from', 'by', 'of', 'in', 'to', 'a', 'total']);
  const tokens = topic
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !stop.has(token));
  const score = (title: string): number => {
    const lower = title.toLowerCase();
    return tokens.reduce((sum, token) => sum + (lower.includes(token) ? 1 : 0), 0);
  };
  const ranked = [...charts].sort((a, b) => score(b.title) - score(a.title));

  for (const chart of ranked.slice(0, 6)) {
    try {
      const csv = await fetchOwidCsv(chart.slug);
      const rows = parseOwidCsv(csv);
      if (rows.length < 20) continue;
      const countries = rows.filter((row) => row.code !== '' && !isOwidAggregate(row.code));
      const usable = countries.length >= 10 ? countries : rows;
      if (options.maxEntities) {
        const seen = new Set<string>();
        const trimmed: OwidRow[] = [];
        for (const row of usable) {
          if (!seen.has(row.code || row.entity)) {
            if (seen.size >= options.maxEntities) continue;
            seen.add(row.code || row.entity);
          }
          trimmed.push(row);
        }
        return { slug: chart.slug, title: chart.title, rows: trimmed, countries: trimmed };
      }
      return { slug: chart.slug, title: chart.title, rows: usable, countries: usable };
    } catch {
      /* try the next chart */
    }
  }
  return null;
}
