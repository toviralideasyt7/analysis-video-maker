/**
 * World Bank Data Catalog (DDH) OpenAPI - direct access, no key.
 *
 * Docs UI:  https://ddh-openapi.worldbank.org/docs/index.html
 * Spec:     https://ddh-openapi.worldbank.org/docs/2.0/document.json
 *
 * Endpoints used (all GET, JSON):
 *   /search?qname=dataset|resource&param=<query>&top=&skip=
 *   /datasets?top=&skip=                       - list the whole catalog
 *   /datasets/<dataset_unique_id>              - metadata + resources[] with direct urls
 *   /resources/<resource_unique_id>/data?top=&skip=&select=&filter=
 *   /resources/<resource_unique_id>/download
 *
 * The dataset metadata already exposes direct file downloads on
 * datacatalogfiles.worldbank.org, so a resource file can be fetched with no
 * extra hop. The /resources/<id>/data endpoint returns rows inline for
 * DATABANK-format resources that carry a version.
 *
 * Verified live 2026-09-21: /search, /datasets/<id>, resource url HEAD all 200.
 */

import { fetchJson } from './http';

export const DDH_BASE = 'https://ddh-openapi.worldbank.org';
export const DDH_SPEC_URL = `${DDH_BASE}/docs/2.0/document.json`;

export interface DdhSearchHit {
  dataset_id: string;
  dataset_unique_id: string;   // the id used by /datasets/<id>
  name: string;
  modified_on?: string;
}

export interface DdhSearchResponse {
  count: number;
  data: DdhSearchHit[];
}

export interface DdhResource {
  resource_unique_id: string;
  resource_id?: string;
  name: string;
  resource_type?: string;
  format?: string;             // DATABANK | EXCEL | ZIP | CSV | ...
  description?: string;
  url?: string;                // direct download when present
}

export interface DdhDataset {
  dataset_id?: string;
  dataset_unique_id: string;
  name: string;
  identification?: { title?: string; description?: string; subtitle?: string };
  resources?: DdhResource[];
  indicators?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/** Catalog search. qname is 'dataset' or 'resource'; the query goes in `param`. */
export async function ddhSearch(query: string, options: { qname?: 'dataset' | 'resource'; top?: number; skip?: number } = {}): Promise<DdhSearchResponse> {
  const qname = options.qname ?? 'dataset';
  const top = options.top ?? 10;
  const skip = options.skip ?? 0;
  const url = `${DDH_BASE}/search?qname=${qname}&param=${encodeURIComponent(query)}&top=${top}&skip=${skip}`;
  return fetchJson<DdhSearchResponse>(url);
}

/** List catalog datasets without a query. */
export async function ddhListDatasets(options: { top?: number; skip?: number } = {}): Promise<DdhSearchResponse> {
  const top = options.top ?? 10;
  const skip = options.skip ?? 0;
  return fetchJson<DdhSearchResponse>(`${DDH_BASE}/datasets?top=${top}&skip=${skip}`);
}

/** Dataset metadata, including the resource list with direct download urls. */
export async function ddhDataset(datasetUniqueId: string): Promise<DdhDataset> {
  return fetchJson<DdhDataset>(`${DDH_BASE}/datasets/${encodeURIComponent(datasetUniqueId)}`);
}

/** Resources for a dataset id (alias for ddhDataset().resources). */
export async function ddhResources(datasetUniqueId: string): Promise<DdhResource[]> {
  const dataset = await ddhDataset(datasetUniqueId);
  return dataset.resources ?? [];
}

/** Resources that can be downloaded directly (url present). */
export async function ddhDownloadableResources(datasetUniqueId: string): Promise<Array<DdhResource & { url: string }>> {
  const resources = await ddhResources(datasetUniqueId);
  return resources.filter((resource): resource is DdhResource & { url: string } => Boolean(resource.url));
}

/** Inline rows for a resource (works for DATABANK resources carrying a version). */
export async function ddhResourceData(
  resourceUniqueId: string,
  options: { top?: number; skip?: number; select?: string[]; filter?: string; version?: string } = {},
): Promise<{ count: number; value?: unknown[]; [key: string]: unknown }> {
  const params = new URLSearchParams();
  params.set('top', String(options.top ?? 100));
  params.set('skip', String(options.skip ?? 0));
  if (options.select?.length) params.set('select', options.select.join(','));
  if (options.filter) params.set('filter', options.filter);
  if (options.version) params.set('version', options.version);
  return fetchJson(`${DDH_BASE}/resources/${encodeURIComponent(resourceUniqueId)}/data?${params.toString()}`);
}