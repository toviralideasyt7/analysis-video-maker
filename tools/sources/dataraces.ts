/**
 * data-races.com - pre-built race tapes, plain JSON, no key and no browser.
 *
 *   1. CATALOG   GET https://data-races.com/sitemap-0.xml
 *                -> every /<locale>/datasets/<slug>/ page (375 datasets, x11 locales)
 *   2. RESOLVE   GET the dataset page and read its /data/<category>/<slug>.json link
 *   3. DOWNLOAD  GET https://data-races.com/data/<category>/<slug>.json
 *
 * The JSON payload is already a race tape:
 *   { version, schema: [entity_id, group_id, value, rank, group_rank, ...],
 *     periodUnit: "year" | "month", data: { "1990": [ [entityId, groupId, value, rank, ...] ] } }
 *
 * Asset note: country flags on the site are served from the public
 * hatscripts/circle-flags set, so high-quality circular flag SVGs come from
 * https://hatscripts.github.io/circle-flags/flags/<cc>.svg (see flags.ts).
 *
 * Verified live 2026-09-21: sitemap, dataset page scrape and JSON download all 200.
 */

import { fetchText, fetchJson, extractImageUrls } from './http';

export const DATARACES_BASE = 'https://data-races.com';

export interface DataRaceDatasetRef {
  slug: string;
  url: string;         // https://data-races.com/en/datasets/<slug>/
}

export interface DataRacePayload {
  version: number;
  schema: string[];
  periodUnit: 'year' | 'month' | string;
  data: Record<string, Array<Array<string | number>>>;
}

/** Step 1 - the sitemap lists every dataset page. Defaults to the English locale. */
export async function listDataRaceDatasets(locale = 'en'): Promise<DataRaceDatasetRef[]> {
  const xml = await fetchText(`${DATARACES_BASE}/sitemap-0.xml`);
  const seen = new Set<string>();
  const out: DataRaceDatasetRef[] = [];
  for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const value = match[1];
    const path = new RegExp(`/${locale}/datasets/([a-z0-9-]+)/$`).exec(value);
    if (!path) continue;
    if (seen.has(path[1])) continue;
    seen.add(path[1]);
    out.push({ slug: path[1], url: `${DATARACES_BASE}/${locale}/datasets/${path[1]}/` });
  }
  return out;
}

/** Step 2 - the dataset page embeds the JSON path for its own race tape. */
export async function resolveDataRaceJsonUrl(pageUrl: string): Promise<string | null> {
  const html = await fetchText(pageUrl);
  const match = /\/data\/[a-z0-9\-/]+\.json/.exec(html);
  return match ? `${DATARACES_BASE}${match[0]}` : null;
}

/** Step 2b - images and social cards linked from a dataset or race page. */
export async function scrapeDataRaceImages(pageUrl: string): Promise<string[]> {
  const html = await fetchText(pageUrl);
  return extractImageUrls(html).map((url) => (url.startsWith('//') ? `https:${url}` : url.startsWith('/') ? `${DATARACES_BASE}${url}` : url));
}

/** Step 3 - download the tape. */
export const fetchDataRacePayload = (jsonUrl: string): Promise<DataRacePayload> => fetchJson<DataRacePayload>(jsonUrl);

export interface DataRaceRow {
  entityId: string;
  groupId: string;
  value: number;
  rank: number;
  period: string;
}

/** Flatten the tape into one row per (period, entity). */
export function flattenDataRace(payload: DataRacePayload): DataRaceRow[] {
  const column = new Map(payload.schema.map((name, index) => [name, index]));
  const at = (row: Array<string | number>, name: string, fallback: number): string | number => {
    const index = column.get(name) ?? fallback;
    return row[index];
  };
  const rows: DataRaceRow[] = [];
  for (const [period, entries] of Object.entries(payload.data ?? {})) {
    for (const entry of entries) {
      rows.push({
        entityId: String(at(entry, 'entity_id', 0)),
        groupId: String(at(entry, 'group_id', 1)),
        value: Number(at(entry, 'value', 2)),
        rank: Number(at(entry, 'rank', 3)),
        period,
      });
    }
  }
  return rows;
}

/** Resolve a dataset slug end to end: page -> json url -> payload. */
export async function fetchDataRaceBySlug(slug: string, locale = 'en'): Promise<{ jsonUrl: string; payload: DataRacePayload } | null> {
  const jsonUrl = await resolveDataRaceJsonUrl(`${DATARACES_BASE}/${locale}/datasets/${slug}/`);
  if (!jsonUrl) return null;
  return { jsonUrl, payload: await fetchDataRacePayload(jsonUrl) };
}