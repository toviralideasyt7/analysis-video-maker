/**
 * Our World in Data - direct download, no browser and no API key.
 *
 *   1. DISCOVER  GET https://ourworldindata.org/api/search?q=<query>
 *                -> { results: [ { title, slug, type, availableEntities } ] }
 *   2. DOWNLOAD  GET https://ourworldindata.org/grapher/<slug>.csv
 *                GET https://ourworldindata.org/grapher/<slug>.metadata.json
 *
 * The grapher CSV header is always `Entity,Code,Year,<value column>`; the
 * metadata document describes the value column (unit, timespan, source) and
 * links the full indicator metadata via api.ourworldindata.org.
 *
 * Verified live 2026-09-21: search + csv + metadata all return HTTP 200.
 */

import { fetchJson, fetchText, parseDelimited, numeric, findColumn, type Table } from './http';

export const OWID_BASE = 'https://ourworldindata.org';

export interface OwidSearchHit {
  title: string;
  slug: string;
  type: string;            // "chart" | "explorerView" | "dataset" | "article"
  variantName?: string;
  availableEntities?: string[];
}

export interface OwidSearchResponse {
  query: string;
  results: OwidSearchHit[];
  nbHits: number;
  page: number;
  nbPages: number;
  hitsPerPage: number;
}

export interface OwidColumnMeta {
  titleShort?: string;
  titleLong?: string;
  descriptionShort?: string;
  shortUnit?: string;
  unit?: string;
  timespan?: string;
  owidVariableId?: number;
  shortName?: string;
  lastUpdated?: string;
  citationShort?: string;
  citationLong?: string;
  fullMetadata?: string;   // https://api.ourworldindata.org/v1/indicators/<id>.metadata.json
}

export interface OwidMetadata {
  chart?: {
    title?: string;
    subtitle?: string;
    note?: string;
    citation?: string;
    originalChartUrl?: string;
    selection?: string[];
  };
  columns?: Record<string, OwidColumnMeta>;
  dateDownloaded?: string;
}

/** Step 1 - discovery. Returns chart/dataset hits that all carry a slug. */
export async function searchOwid(query: string): Promise<OwidSearchHit[]> {
  const url = `${OWID_BASE}/api/search?q=${encodeURIComponent(query)}`;
  const json = await fetchJson<OwidSearchResponse>(url);
  return (json.results ?? []).filter((hit) => Boolean(hit.slug));
}

/** Restrict search results to the ones usable as a grapher CSV. */
export async function searchOwidCharts(query: string): Promise<OwidSearchHit[]> {
  const hits = await searchOwid(query);
  return hits.filter((hit) => hit.type === 'chart' || hit.type === 'explorerView');
}

export const owidCsvUrl = (slug: string): string => `${OWID_BASE}/grapher/${slug}.csv`;
export const owidMetadataUrl = (slug: string): string => `${OWID_BASE}/grapher/${slug}.metadata.json`;

export const fetchOwidCsv = (slug: string): Promise<string> => fetchText(owidCsvUrl(slug));
export const fetchOwidMetadata = (slug: string): Promise<OwidMetadata> => fetchJson<OwidMetadata>(owidMetadataUrl(slug));

export interface OwidObservation {
  entity: string;
  code: string;
  year: number;
  value: number;
}

export interface OwidSeries {
  slug: string;
  unit?: string;
  valueColumn: string;
  title?: string;
  citation?: string;
  timespan?: string;
  observations: OwidObservation[];
  entities: string[];
  skipped: number;
}

/** Parse a grapher CSV body into typed observations. Values are taken verbatim. */
export function parseOwidCsv(text: string, slug = ''): OwidSeries {
  const table: Table = parseDelimited(text);
  const entityIndex = findColumn(table.columns, ['entity', 'country', 'name']);
  const codeIndex = findColumn(table.columns, ['code', 'iso']);
  const yearIndex = findColumn(table.columns, ['year', 'date']);
  const valueIndex = table.columns.findIndex((_, index) => index !== entityIndex && index !== codeIndex && index !== yearIndex);
  const observations: OwidObservation[] = [];
  let skipped = 0;
  if (entityIndex >= 0 && yearIndex >= 0 && valueIndex >= 0) {
    for (const row of table.rows) {
      const entity = (row[entityIndex] ?? '').trim();
      const year = Number.parseInt((row[yearIndex] ?? '').trim(), 10);
      const value = numeric(row[valueIndex]);
      if (!entity || !Number.isFinite(year) || !Number.isFinite(value)) { skipped += 1; continue; }
      observations.push({ entity, code: codeIndex >= 0 ? (row[codeIndex] ?? '').trim() : '', year, value });
    }
  }
  const entities = Array.from(new Set(observations.map((o) => o.entity)));
  return { slug, valueColumn: table.columns[valueIndex] ?? '', observations, entities, skipped };
}

/**
 * Owid aggregates are coded OWID_<something> (OWID_WRL = World, OWID_EU27,
 * OWID_AFR ...). They are regions, not countries, and are usually excluded
 * from a country race.
 */
export const isOwidAggregate = (code: string): boolean => code.startsWith('OWID_');

/** World entity code in the grapher CSVs. */
export const OWID_WORLD_CODE = 'OWID_WRL';

/** Convenience: discover by topic and return the first chart CSV as a series. */
export async function resolveOwidSeries(query: string, options: { slug?: string } = {}): Promise<OwidSeries | null> {
  let slug = options.slug;
  if (!slug) {
    const charts = await searchOwidCharts(query);
    slug = charts[0]?.slug;
  }
  if (!slug) return null;
  const [csv, metadata] = await Promise.all([
    fetchOwidCsv(slug),
    fetchOwidMetadata(slug).catch(() => ({}) as OwidMetadata),
  ]);
  const series = parseOwidCsv(csv, slug);
  const column = Object.values(metadata.columns ?? {})[0];
  series.unit = column?.unit ?? column?.shortUnit;
  series.title = metadata.chart?.title;
  series.citation = metadata.chart?.citation;
  series.timespan = column?.timespan;
  return series;
}