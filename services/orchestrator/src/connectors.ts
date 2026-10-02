/**
 * Dataset connectors.
 *
 * Each connector is a thin, honest adapter over a public endpoint:
 *   - failures are surfaced, never swallowed;
 *   - provenance (endpoint, params, retrieval timestamp) is recorded;
 *   - a discovery index is never treated as the data provider.
 *
 * Connectors are functions rather than classes so new sources can be added
 * without touching the pipeline.
 */

import { createReadStream, createWriteStream, mkdirSync, rmSync, writeFileSync, mkdtempSync, openSync, closeSync, readSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { env, logger } from './runtime';
import { directFetch, hostOf, type SearchProvider } from './providers/search';
import type { SourceCandidate, SourceDefinition } from '@avm/shared';

function nowIso(): string {
  return new Date().toISOString();
}

function candidateId(prefix: string, key: string): string {
  const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return `${prefix}_${slug}`;
}

// ---------------------------------------------------------------------------
// HTTP helper with retry/backoff
// ---------------------------------------------------------------------------

export async function getText(
  url: string,
  options: { retries?: number; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ text: string; status: number; contentType?: string }> {
  const retries = options.retries ?? 2;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = options.timeoutMs ? setTimeout(() => controller.abort(), options.timeoutMs) : null;
      const result = await directFetch(url, { headers: options.headers, signal: controller.signal });
      if (timer) clearTimeout(timer);
      if (result.status === 429 || result.status >= 500) {
        lastError = new Error(`HTTP ${result.status} for ${url}`);
        await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
        continue;
      }
      return { text: result.text ?? '', status: result.status, contentType: result.contentType };
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 600 * 2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`request failed: ${url}`);
}

export async function getJson<T>(
  url: string,
  options: { retries?: number; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<T> {
  const { text, status } = await getText(url, {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers ?? {}) },
  });
  if (status >= 400) {
    throw new Error(`HTTP ${status} for ${url}: ${text.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`JSON parse failed for ${url} (HTTP ${status}): ${String(error)} — body: ${text.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// Source registry (specification priority order)
// ---------------------------------------------------------------------------

export const SOURCE_REGISTRY: SourceDefinition[] = [
  { name: 'Our World in Data', type: 'dataset', url: 'https://ourworldindata.org/', domains: ['demographics', 'health', 'energy', 'environment', 'economics', 'technology'], categories: ['global', 'long-timeseries'], accessMethod: 'download', priority: 1, requiresAuth: false, license: 'CC BY 4.0 (per chart; check metadata)', notes: 'Append .csv to a Grapher URL; .metadata.json returns units/timespan/citation.' },
  { name: 'World Bank Open Data', type: 'api', url: 'https://data.worldbank.org/', domains: ['economics', 'population', 'trade', 'energy', 'infrastructure'], categories: ['country', 'annual'], accessMethod: 'api', priority: 1, requiresAuth: false, license: 'CC BY 4.0', notes: 'api.worldbank.org/v2/country/{codes}/indicator/{indicator}?format=json' },
  { name: 'Data Commons', type: 'api', url: 'https://datacommons.org/', domains: ['statistics', 'demographics', 'economics'], categories: ['place', 'cross-source'], accessMethod: 'api', priority: 1, requiresAuth: false, license: 'Apache-2.0 (API); data per upstream source', notes: 'Records underlying provenance where available.' },
  { name: 'UNdata', type: 'api', url: 'https://data.un.org/', domains: ['population', 'migration', 'agriculture', 'education', 'health', 'trade', 'energy'], categories: ['country'], accessMethod: 'api', priority: 2, requiresAuth: false, license: 'UN terms of use', notes: 'Single entry point to the UN statistical system.' },
  { name: 'OECD', type: 'api', url: 'https://www.oecd.org/en/data.html', domains: ['economics', 'labour', 'education', 'productivity', 'industry'], categories: ['country'], accessMethod: 'api', priority: 2, requiresAuth: false, license: 'OECD terms', notes: 'SDMX-based REST API.' },
  { name: 'Eurostat', type: 'api', url: 'https://ec.europa.eu/eurostat/', domains: ['eu', 'population', 'economy', 'transport', 'energy', 'labour'], categories: ['country', 'region'], accessMethod: 'api', priority: 2, requiresAuth: false, license: 'Eurostat reuse policy', notes: 'statistics/1.0/data/{dataset}?format=JSON' },
  { name: 'Data.gov', type: 'api', url: 'https://data.gov/', domains: ['us-government', 'transport', 'aviation', 'environment', 'health'], categories: ['dataset-catalogue'], accessMethod: 'api', priority: 3, requiresAuth: false, license: 'US public domain (varies)', notes: 'CKAN package_search.' },
  { name: 'Kaggle Datasets', type: 'dataset', url: 'https://www.kaggle.com/datasets', domains: ['general', 'historical', 'community'], categories: ['dataset-catalogue'], accessMethod: 'api', priority: 6, requiresAuth: true, license: 'per dataset', notes: 'Requires KAGGLE_USERNAME + KAGGLE_KEY. Inspect licence/date/columns before use.' },
  { name: 'Hugging Face Datasets', type: 'dataset', url: 'https://huggingface.co/datasets', domains: ['ai', 'ml', 'text', 'vision', 'technical'], categories: ['dataset-catalogue'], accessMethod: 'api', priority: 7, requiresAuth: false, license: 'per dataset', notes: 'Not an authority for general-world statistics.' },
  { name: 'AWS Open Data Registry', type: 'dataset', url: 'https://registry.opendata.aws/', domains: ['climate', 'satellite', 'geospatial', 'scientific'], categories: ['dataset-catalogue'], accessMethod: 'web', priority: 7, requiresAuth: false, license: 'per dataset', notes: 'Inspect licensing and access instructions.' },
  { name: 'Google Dataset Search', type: 'search', url: 'https://datasetsearch.research.google.com/', domains: ['discovery'], categories: ['discovery'], accessMethod: 'web', priority: 0, requiresAuth: false, license: 'n/a (discovery only)', notes: 'Discovery only: always follow through to the real dataset owner.' },
  { name: 'Data Races', type: 'directory', url: 'https://data-races.com/en/', domains: ['inspiration', 'format'], categories: ['discovery'], accessMethod: 'web', priority: 9, requiresAuth: false, license: 'see site', notes: 'Inspiration and format reference only. Do not reproduce their content.' },
  { name: 'Visualization Datasets', type: 'directory', url: 'https://visdatasets.github.io/', domains: ['visualization'], categories: ['discovery'], accessMethod: 'web', priority: 9, requiresAuth: false, license: 'per dataset', notes: 'Discovery layer.' },
  { name: 'Feed Me Data', type: 'directory', url: 'https://feedmedata.ai/datasets', domains: ['discovery'], categories: ['discovery'], accessMethod: 'web', priority: 9, requiresAuth: false, license: 'n/a (directory)', notes: 'Discovery layer, follow through to the owner.' },
];

export function definitionFor(name: string): SourceDefinition | undefined {
  return SOURCE_REGISTRY.find((s) => s.name.toLowerCase() === name.toLowerCase());
}
// ---------------------------------------------------------------------------
// Our World in Data
// ---------------------------------------------------------------------------

export interface OwidResult {
  candidate: SourceCandidate;
  csv: string;
  metadata: unknown;
  columns: string[];
  rows: string[][];
}

/** Fetch a Grapher chart as CSV plus its metadata sidecar. */
export async function owidFetch(slug: string, options: { baseUrl?: string } = {}): Promise<OwidResult> {
  const base = (options.baseUrl ?? 'https://ourworldindata.org').replace(/\/$/, '');
  const csvUrl = `${base}/grapher/${slug}.csv`;
  const metaUrl = `${base}/grapher/${slug}.metadata.json`;
  const csvResponse = await getText(csvUrl, { timeoutMs: 60_000 });
  if (csvResponse.status !== 200) throw new Error(`OWID grapher ${slug} returned ${csvResponse.status}`);
  let metadata: unknown = null;
  try {
    metadata = JSON.parse((await getText(metaUrl, { timeoutMs: 30_000 })).text);
  } catch (error) {
    logger.warn('OWID metadata unavailable', { slug, error: String(error) });
  }
  const table = parseCsv(csvResponse.text);
  const definition = definitionFor('Our World in Data');
  return {
    candidate: {
      candidateId: candidateId('owid', slug),
      sourceName: 'Our World in Data',
      publisher: 'Our World in Data',
      url: csvUrl,
      kind: 'dataset',
      accessMethod: 'download',
      title: slug,
      description: 'Our World in Data grapher export (CSV) with metadata sidecar',
      retrievedAt: nowIso(),
      license: definition?.license ?? 'CC BY 4.0',
      machineReadable: true,
      authority: 0.85,
      directness: 0.8,
      coverage: 0.9,
      methodologyTransparency: 0.85,
      recency: 0.85,
      consistency: 0.85,
      qualityScore: 0,
      accepts: null,
      primary: false,
      discoveredBy: 'owid-connector',
      notes: metadata ? ['metadata sidecar retrieved'] : ['metadata sidecar unavailable'],
    },
    csv: csvResponse.text,
    metadata,
    columns: table.columns,
    rows: table.rows,
  };
}

// ---------------------------------------------------------------------------
// World Bank
// ---------------------------------------------------------------------------

export interface WorldBankRow {
  countryIso3: string;
  countryName: string;
  indicatorId: string;
  date: string;
  value: number | null;
}

export async function worldBankFetch(
  indicator: string,
  countries: string[] | 'all' = 'all',
  options: { start?: number; end?: number; baseUrl?: string } = {},
): Promise<{ candidate: SourceCandidate; rows: WorldBankRow[]; indicatorName: string }> {
  const base = (options.baseUrl ?? 'https://api.worldbank.org/v2').replace(/\/$/, '');
  const codes = countries === 'all' ? 'all' : countries.join(';');
  const start = options.start ?? 1960;
  const end = options.end ?? new Date().getFullYear();
  const url = `${base}/country/${codes}/indicator/${indicator}?format=json&per_page=20000&date=${start}:${end}`;
  // World Bank caps a page well below 20000 for wide queries, so every page
  // is followed. Reading only page 1 silently dropped most countries.
  // Wide year spans are also split into ~15-year chunks: a single page for
  // 60+ years x 200+ countries exceeds the HTTP client's response cap and
  // arrives as truncated JSON.
  const rows: WorldBankRow[] = [];
  const CHUNK_YEARS = 15;
  for (let chunkStart = start; chunkStart <= end; chunkStart += CHUNK_YEARS) {
    const chunkEnd = Math.min(end, chunkStart + CHUNK_YEARS - 1);
    const chunkUrl = `${base}/country/${codes}/indicator/${indicator}?format=json&per_page=20000&date=${chunkStart}:${chunkEnd}`;
    let page = 1;
    let pages = 1;
    do {
      const pageUrl = `${chunkUrl}&page=${page}`;
      const payload = await getJson<unknown[]>(pageUrl, { timeoutMs: 90_000 });
      if (!Array.isArray(payload) || payload.length < 2) {
        throw new Error(`World Bank returned an unexpected payload for ${indicator} (page ${page})`);
      }
      const meta = payload[0] as { total?: number; page?: number; pages?: number };
      pages = meta.pages ?? 1;
      for (const item of (payload[1] as Array<Record<string, unknown>>) ?? []) {
        const country = (item.country ?? {}) as { id?: string; value?: string };
        const indicatorNode = (item.indicator ?? {}) as { id?: string; value?: string };
        rows.push({
          countryIso3: String(country.id ?? ''),
          countryName: String(country.value ?? ''),
          indicatorId: String(indicatorNode.id ?? indicator),
          date: String(item.date ?? ''),
          value: typeof item.value === 'number' ? item.value : null,
        });
      }
      page += 1;
    } while (page <= pages);
  }
  if (rows.length > 20000) {
    logger.info('World Bank chunked fetch complete', { indicator, rows: rows.length });
  }
  const definition = definitionFor('World Bank Open Data');
  return {
    candidate: {
      candidateId: candidateId('wb', `${indicator}-${codes === 'all' ? 'all' : codes}`),
      sourceName: 'World Bank Open Data',
      publisher: 'World Bank',
      url,
      kind: 'api',
      accessMethod: 'api',
      title: indicator,
      description: 'World Bank indicator series',
      retrievedAt: nowIso(),
      license: definition?.license ?? 'CC BY 4.0',
      machineReadable: true,
      authority: 0.95,
      directness: 0.95,
      coverage: 0.85,
      methodologyTransparency: 0.8,
      recency: 0.9,
      consistency: 0.9,
      qualityScore: 0,
      accepts: null,
      primary: false,
      discoveredBy: 'worldbank-connector',
      notes: [`endpoint params: indicator=${indicator}, date=${start}:${end}`, `rows=${rows.length}`],
    },
    rows,
    indicatorName: indicator,
  };
}
// ---------------------------------------------------------------------------
// Data Commons
// ---------------------------------------------------------------------------

export async function dataCommonsObservation(
  entityDcids: string[],
  variableDcids: string[],
  options: { date?: string; baseUrl?: string; apiKey?: string } = {},
): Promise<{ candidate: SourceCandidate; byVariable: unknown }> {
  const base = (options.baseUrl ?? 'https://api.datacommons.org/v2').replace(/\/$/, '');
  const params = new URLSearchParams();
  for (const e of entityDcids) params.append('entity.dcids', e);
  for (const v of variableDcids) params.append('variable.dcids', v);
  if (options.date) params.set('date', options.date);
  const key = options.apiKey ?? env('DATA_COMMONS_API_KEY');
  if (key) params.set('key', key);
  const url = `${base}/observation?${params.toString()}`;
  const payload = await getJson<Record<string, unknown>>(url, { timeoutMs: 60_000 });
  const definition = definitionFor('Data Commons');
  return {
    candidate: {
      candidateId: candidateId('dc', `${entityDcids.join('-')}_${variableDcids.join('-')}`),
      sourceName: 'Data Commons',
      publisher: 'Google Data Commons',
      url,
      kind: 'api',
      accessMethod: 'api',
      title: variableDcids.join(', '),
      retrievedAt: nowIso(),
      license: definition?.license ?? 'Apache-2.0',
      machineReadable: true,
      authority: 0.8,
      directness: 0.75,
      coverage: 0.85,
      methodologyTransparency: 0.7,
      recency: 0.85,
      consistency: 0.75,
      qualityScore: 0,
      accepts: null,
      primary: false,
      discoveredBy: 'datacommons-connector',
      notes: ['aggregates upstream sources; underlying provenance is recorded when present'],
    },
    byVariable: payload.byVariable ?? payload,
  };
}

// ---------------------------------------------------------------------------
// Kaggle
// ---------------------------------------------------------------------------

/**
 * Kaggle credentials, sent with a non-browser user agent.
 *
 * Verified 2026-09-21: kaggle.com answers a browser User-Agent with an HTML
 * reCAPTCHA challenge page (HTTP 200, so it looks like success), while a plain
 * client UA returns the documented JSON. This is why the UA is pinned here
 * instead of inheriting the browser default.
 */
function kaggleAuthHeader(): Record<string, string> {
  const user = env('KAGGLE_USERNAME');
  const key = env('KAGGLE_KEY');
  if (!user || !key) throw new Error('KAGGLE_USERNAME / KAGGLE_KEY are not configured');
  return {
    Authorization: `Basic ${Buffer.from(`${user}:${key}`).toString('base64')}`,
    'User-Agent': 'analysis-video-maker/0.1 (kaggle-api client)',
    Accept: 'application/json',
  };
}

export interface KaggleDataset {
  ref: string;
  title: string;
  subtitle?: string;
  totalBytes?: number;
  lastUpdated?: string;
  downloadCount?: number;
  voteCount?: number;
  usabilityRating?: number;
  licenseName?: string;
  description?: string;
}

export async function kaggleSearch(
  query: string,
  options: { limit?: number; baseUrl?: string } = {},
): Promise<KaggleDataset[]> {
  const base = (options.baseUrl ?? 'https://www.kaggle.com/api/v1').replace(/\/$/, '');
  const url = `${base}/datasets/list?search=${encodeURIComponent(query)}&page=1`;
  const payload = await getJson<unknown[]>(url, { headers: kaggleAuthHeader(), timeoutMs: 60_000 });
  if (!Array.isArray(payload)) return [];
  return payload.slice(0, options.limit ?? 10).map((raw) => {
    const d = raw as Record<string, unknown>;
    const ref = String(d.ref ?? '');
    return {
      ref,
      title: String(d.title ?? ref),
      subtitle: typeof d.subtitle === 'string' ? d.subtitle : undefined,
      totalBytes: typeof d.totalBytes === 'number' ? d.totalBytes : undefined,
      lastUpdated: typeof d.lastUpdated === 'string' ? d.lastUpdated : undefined,
      downloadCount: typeof d.downloadCount === 'number' ? d.downloadCount : undefined,
      voteCount: typeof d.voteCount === 'number' ? d.voteCount : undefined,
      usabilityRating: typeof d.usabilityRating === 'number' ? d.usabilityRating : undefined,
      licenseName: typeof d.licenseName === 'string' ? d.licenseName : undefined,
      description: typeof d.description === 'string' ? d.description : undefined,
    };
  });
}

export function kaggleCandidates(datasets: KaggleDataset[]): SourceCandidate[] {
  return datasets.map((d) => ({
    candidateId: candidateId('kaggle', d.ref),
    sourceName: 'Kaggle Datasets',
    publisher: `Kaggle: ${d.ref.split('/')[0] ?? 'unknown'}`,
    url: `https://www.kaggle.com/datasets/${d.ref}`,
    kind: 'dataset',
    accessMethod: 'download',
    title: d.title,
    description: d.subtitle ?? d.description?.slice(0, 300),
    publishedAt: d.lastUpdated,
    retrievedAt: nowIso(),
    license: d.licenseName ?? 'UNKNOWN',
    machineReadable: true,
    authority: 0.55,
    directness: 0.5,
    coverage: 0.6,
    methodologyTransparency: 0.4,
    recency: d.lastUpdated && Date.parse(d.lastUpdated) > Date.now() - 3.15e10 ? 0.7 : 0.4,
    consistency: 0.4,
    qualityScore: 0,
    accepts: null,
    primary: false,
    discoveredBy: 'kaggle-connector',
    notes: ['community dataset: verify licence, update date, columns and provenance before use'],
  }));
}

export async function kaggleDownload(
  ref: string,
  outDir: string,
  options: { baseUrl?: string } = {},
): Promise<{ file: string; bytes: number }> {
  const base = (options.baseUrl ?? 'https://www.kaggle.com/api/v1').replace(/\/$/, '');
  const response = await fetch(`${base}/datasets/download/${ref}`, { headers: kaggleAuthHeader() });
  if (!response.ok) throw new Error(`Kaggle download failed for ${ref}: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${ref.replace(/[^a-z0-9]+/gi, '_')}.zip`);
  writeFileSync(file, buffer);
  return { file, bytes: buffer.byteLength };
}

/**
 * Extract a Kaggle dataset ref ("owner/slug") from a dataset page URL or an
 * API download URL. Returns null for anything that is not a specific dataset
 * — notably the bare https://www.kaggle.com/datasets catalog, which carries
 * no data and must never be treated as a dataset.
 */
export function kaggleRefFromUrl(url: string): string | null {
  const m = /kaggle\.com\/(?:api\/v1\/datasets\/download\/|datasets\/)([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

export interface KaggleFileEntry {
  name: string;
  totalBytes: number;
}

/** List the files inside a Kaggle dataset (authenticated). */
export async function kaggleListFiles(
  ref: string,
  options: { baseUrl?: string } = {},
): Promise<KaggleFileEntry[]> {
  const base = (options.baseUrl ?? 'https://www.kaggle.com/api/v1').replace(/\/$/, '');
  const [owner, slug] = ref.split('/');
  const payload = await getJson<unknown>(`${base}/datasets/list/${owner}/${slug}`, {
    headers: kaggleAuthHeader(),
    timeoutMs: 60_000,
  });
  // Kaggle returns an object {datasetFiles:[...]} (verified live 2026-09-30);
  // accept a bare array too in case of proxy/mirror variants.
  const list = Array.isArray(payload)
    ? payload
    : (payload as { datasetFiles?: unknown } | null | undefined)?.datasetFiles;
  if (!Array.isArray(list)) return [];
  return list
    .map((f) => {
      const d = f as Record<string, unknown>;
      return {
        name: String(d.name ?? ''),
        totalBytes: typeof d.totalBytes === 'number' ? d.totalBytes : 0,
      };
    })
    .filter((f) => f.name.length > 0);
}

/**
 * Largest CSV we will buffer into a Node string for ingestion.
 * The research run OOM'd fatally (exit 134) on the multi-GB TMDB 930k-movies
 * CSV (2026-09-30): even before hitting V8's ~512MB max string length,
 * buffering a file that size blows the ~4GB runner heap. Above the cap we
 * throw a catchable error instead so callers record a note and move on to
 * the next source. 2026-10-01.
 */
const KAGGLE_CSV_MAX_BYTES = 200 * 1024 * 1024;

/**
 * Read a fetch body into raw bytes, aborting cleanly once the byte budget is
 * exceeded (backstop for file-list sizes that are missing or stale).
 */
async function readBodyCappedBytes(response: Response, maxBytes: number, what: string): Promise<Buffer> {
  if (!response.body) return Buffer.from(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`${what} exceeds the ${Math.round(maxBytes / 1048576)}MB in-memory ingest limit`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Read a fetch body into a string, aborting cleanly once the byte budget is
 * exceeded (backstop for file-list sizes that are missing or stale).
 */
async function readBodyCapped(response: Response, maxBytes: number, what: string): Promise<string> {
  return (await readBodyCappedBytes(response, maxBytes, what)).toString('utf-8');
}

/** True when the buffer starts with the ZIP local-file-header magic. */
export function isZipBuffer(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

/**
 * List the entries of a zip file on disk. Throws when `unzip` is missing or
 * the file is not a readable zip.
 */
export function listZipEntries(zipPath: string): string[] {
  const res = spawnSync('unzip', ['-Z1', zipPath], { encoding: 'utf-8', timeout: 30_000 });
  if (res.status !== 0) {
    const detail = (res.stderr ?? '').toString().trim().slice(0, 200);
    throw new Error(`could not list zip contents (${detail || `unzip exit ${res.status}`})`);
  }
  return (res.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * Extract the first CSV/TSV/TXT entry of a zip held in memory and return its
 * name plus decoded text. The output is capped: exceeding maxBytes throws a
 * catchable "in-memory ingest limit" error so callers fall back to the
 * streaming path instead of OOM-ing the runner.
 */
export function unzipCsvToText(zipBytes: Buffer, maxBytes: number, what: string): { name: string; text: string } {
  const dir = mkdtempSync(join(tmpdir(), 'avm-zip-'));
  const zipPath = join(dir, 'data.zip');
  writeFileSync(zipPath, zipBytes);
  try {
    const pick = listZipEntries(zipPath).find((s) => /\.(csv|tsv|txt)$/i.test(s));
    if (!pick) throw new Error(`${what} is a zip archive containing no CSV/TSV`);
    const res = spawnSync('unzip', ['-p', zipPath, pick], {
      encoding: 'buffer',
      timeout: 60_000,
      maxBuffer: maxBytes,
    });
    if (res.error) {
      const msg = String(res.error);
      if (/ENOBUFS/.test(msg)) {
        throw new Error(`${what} (unzipped ${pick}) exceeds the ${Math.round(maxBytes / 1048576)}MB in-memory ingest limit`);
      }
      throw new Error(`${what}: unzip of ${pick} failed (${msg.slice(0, 200)})`);
    }
    if (res.status !== 0) throw new Error(`${what}: unzip of ${pick} exited ${res.status}`);
    const text = (res.stdout as Buffer).toString('utf-8');
    if (text.length < 50) throw new Error(`${what}: unzipped ${pick} came back empty`);
    return { name: pick, text };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Extract the first CSV/TSV/TXT entry of a zip file to outDir (streams to
 * disk, constant memory) and return its path. Used by the streaming ingest
 * path for datasets whose per-file download returns a zip.
 */
export function unzipCsvToFile(zipPath: string, outDir: string): { name: string; csvPath: string } {
  const pick = listZipEntries(zipPath).find((s) => /\.(csv|tsv|txt)$/i.test(s));
  if (!pick) throw new Error(`zip ${zipPath} contains no CSV/TSV`);
  const csvPath = join(outDir, pick.split('/').pop()!.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'data.csv');
  const fd = openSync(csvPath, 'w');
  try {
    const res = spawnSync('unzip', ['-p', zipPath, pick], {
      stdio: ['ignore', fd, 'pipe'],
      timeout: 600_000,
    });
    if (res.status !== 0) {
      const detail = (res.stderr ?? '').toString().trim().slice(0, 200);
      throw new Error(`unzip of ${pick} exited ${res.status}${detail ? `: ${detail}` : ''}`);
    }
  } finally {
    closeSync(fd);
  }
  return { name: pick, csvPath };
}

/** True when the file at path starts with the ZIP local-file-header magic. */
export function isZipFile(path: string): boolean {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(4);
    if (readSync(fd, head, 0, 4, 0) < 4) return false;
    return isZipBuffer(head);
  } finally {
    closeSync(fd);
  }
}

/**
 * Download the largest .csv inside a Kaggle dataset as text, using the
 * authenticated per-file download endpoint. This avoids — critically — the
 * login-wall HTML that plain page fetches of kaggle.com URLs return (HTTP
 * 200, so it looks like success but has no data).
 *
 * The per-file endpoint usually returns the raw CSV, but for some datasets it
 * returns a ZIP wrapper (2026-10-02: guillemservera/forbes-billionaires-1997-2023
 * came back as PK.. with the CSV inside, which the header sniffer then
 * choked on). ZIP magic is detected and the inner CSV extracted.
 *
 * Throws when credentials are missing, the dataset has no CSV, every CSV is
 * above the in-memory size cap, or the download fails; callers must catch
 * and move on.
 */
export async function kaggleDatasetCsvText(
  ref: string,
  options: { baseUrl?: string } = {},
): Promise<{ fileName: string; text: string }> {
  const files = await kaggleListFiles(ref, options);
  const csvs = files.filter((f) => /\.csv$/i.test(f.name)).sort((a, b) => b.totalBytes - a.totalBytes);
  if (csvs.length === 0) throw new Error(`Kaggle dataset ${ref}: no CSV file found`);
  // Never buffer multi-GB files into a string: prefer the largest CSV that
  // fits the in-memory cap. Throwing here (catchably) is what keeps a huge
  // dataset from fatally OOM-ing the research process.
  const fitting = csvs.filter((f) => f.totalBytes <= KAGGLE_CSV_MAX_BYTES);
  if (fitting.length === 0) {
    const biggest = csvs[0];
    const mb = Math.max(1, Math.round(biggest.totalBytes / 1048576));
    throw new Error(
      `Kaggle dataset ${ref}: largest CSV ${biggest.name} is ~${mb}MB, above the ${KAGGLE_CSV_MAX_BYTES / 1048576}MB in-memory ingest limit — skipping dataset`,
    );
  }
  const base = (options.baseUrl ?? 'https://www.kaggle.com/api/v1').replace(/\/$/, '');
  const [owner, slug] = ref.split('/');
  const fileName = fitting[0].name;
  const response = await fetch(
    `${base}/datasets/download/${owner}/${slug}/${encodeURIComponent(fileName)}`,
    { headers: kaggleAuthHeader() },
  );
  if (!response.ok) throw new Error(`Kaggle file download failed for ${ref}/${fileName}: ${response.status}`);
  // totalBytes is the size inside the dataset bundle; the wire size can
  // differ, so enforce the cap on the actual bytes read as well.
  // Read raw bytes (not a decoded string): some datasets come back as a ZIP
  // wrapper and binary bytes must not be mangled through utf-8 decoding.
  const bytes = await readBodyCappedBytes(response, KAGGLE_CSV_MAX_BYTES, `Kaggle file ${ref}/${fileName}`);
  if (bytes.length < 50) throw new Error(`Kaggle file ${ref}/${fileName} came back empty`);
  if (isZipBuffer(bytes)) {
    const { name, text } = unzipCsvToText(bytes, KAGGLE_CSV_MAX_BYTES, `Kaggle file ${ref}/${fileName}`);
    return { fileName: name, text };
  }
  const text = bytes.toString('utf-8');
  return { fileName, text };
}
// ---------------------------------------------------------------------------
// Streaming Kaggle CSV ingestion (for files above the in-memory cap)
// ---------------------------------------------------------------------------

export interface StreamedKaggleCsv {
  fileName: string;
  /** Temp file holding the full download; caller must delete via cleanup(). */
  tmpPath: string;
  /** Remove the temp file and its parent dir. Safe to call twice. */
  cleanup: () => void;
  totalBytes: number;
  columns: string[];
  /** First data rows, for header sniffing without reading the whole file. */
  sampleRows: string[][];
  delimiter: string;
}

/**
 * Download the largest CSV of a Kaggle dataset by streaming it to a temp file
 * on disk, never buffering the whole body in memory. Datasets above
 * KAGGLE_CSV_MAX_BYTES (e.g. the ~634MB TMDB movies file) cannot go through
 * kaggleDatasetCsvText at all — buffering them OOM'd the runner (exit 134,
 * 2026-09-30) — so this is the fallback that keeps large datasets usable.
 */
export async function kaggleDatasetCsvToFile(
  ref: string,
  options: { baseUrl?: string; sampleRows?: number } = {},
): Promise<StreamedKaggleCsv> {
  const files = await kaggleListFiles(ref, options);
  const csvs = files.filter((f) => /\.csv$/i.test(f.name)).sort((a, b) => b.totalBytes - a.totalBytes);
  if (csvs.length === 0) throw new Error(`Kaggle dataset ${ref}: no CSV file found`);
  const biggest = csvs[0];
  const base = (options.baseUrl ?? 'https://www.kaggle.com/api/v1').replace(/\/$/, '');
  const [owner, slug] = ref.split('/');
  const response = await fetch(
    `${base}/datasets/download/${owner}/${slug}/${encodeURIComponent(biggest.name)}`,
    { headers: kaggleAuthHeader() },
  );
  if (!response.ok) throw new Error(`Kaggle file download failed for ${ref}/${biggest.name}: ${response.status}`);
  if (!response.body) throw new Error(`Kaggle file download for ${ref}/${biggest.name} returned no body`);
  const dir = mkdtempSync(join(tmpdir(), 'avm-kaggle-'));
  const safeName = biggest.name.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'data.csv';
  const tmpPath = join(dir, safeName);
  const out = createWriteStream(tmpPath);
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      await new Promise<void>((resolve, reject) =>
        out.write(chunk, (err) => (err ? reject(err) : resolve())),
      );
    }
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()));
  }
  // The per-file endpoint sometimes returns a ZIP wrapper instead of the raw
  // CSV (2026-10-02: forbes-billionaires). Extract the inner CSV to disk
  // (constant memory) before sniffing columns.
  let dataPath = tmpPath;
  let dataName = biggest.name;
  if (isZipFile(tmpPath)) {
    const { name, csvPath } = unzipCsvToFile(tmpPath, dir);
    dataPath = csvPath;
    dataName = name;
  }
  const delimiter = /\.tsv$/i.test(dataName) ? '\t' : ',';
  const sampleRows: string[][] = [];
  let columns: string[] = [];
  let first = true;
  for await (const row of streamCsvFileRows(dataPath, delimiter)) {
    if (first) {
      columns = row;
      first = false;
      continue;
    }
    if (row.some((c) => c.trim() !== '')) sampleRows.push(row);
    if (sampleRows.length >= (options.sampleRows ?? 500)) break;
  }
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  };
  return { fileName: dataName, tmpPath: dataPath, cleanup, totalBytes: biggest.totalBytes, columns, sampleRows, delimiter };
}

/**
 * Stream the rows of a CSV file (excluding the header) without loading the
 * file into memory. Uses the same quoting rules as parseCsv, keeping parser
 * state across read chunks so quoted fields may span chunk boundaries.
 */
export async function* streamCsvFileRows(tmpPath: string, delimiter = ','): AsyncGenerator<string[]> {
  const stream = createReadStream(tmpPath, { encoding: 'utf8', highWaterMark: 512 * 1024 });
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let sawAny = false;
  for await (const chunk of stream) {
    const text = chunk as string;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      sawAny = true;
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 1;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
        continue;
      }
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        row.push(field);
        field = '';
      } else if (ch === '\n') {
        row.push(field);
        yield row;
        row = [];
        field = '';
      } else if (ch !== '\r') {
        field += ch;
      }
    }
  }
  if (sawAny && (field.length > 0 || row.length > 0)) {
    row.push(field);
    yield row;
  }
}
// ---------------------------------------------------------------------------
// CKAN (data.gov and friends)
// ---------------------------------------------------------------------------

export interface CkanResource {
  name: string;
  url: string;
  format: string;
  datasetTitle: string;
  datasetName: string;
  license?: string;
  lastModified?: string;
}

export async function ckanSearch(
  query: string,
  options: { baseUrl?: string; rows?: number } = {},
): Promise<CkanResource[]> {
  // `catalog.data.gov/api/3/action/package_search` began returning 404
  // (checked 2026-09-21), so several catalogue bases are tried in order and the
  // failure is reported rather than silently returning an empty list.
  const bases = options.baseUrl
    ? [options.baseUrl]
    : ['https://catalog.data.gov/api/3', 'https://data.gov/api/3', 'https://api.data.gov/api/3'];
  let payload: { result?: { results?: Array<Record<string, unknown>> } } | null = null;
  const attempted: string[] = [];
  for (const base of bases) {
    const url = `${base.replace(/\/$/, '')}/action/package_search?q=${encodeURIComponent(query)}&rows=${options.rows ?? 10}`;
    attempted.push(url);
    try {
      payload = await getJson<{ result?: { results?: Array<Record<string, unknown>> } }>(url, {
        headers: { Accept: 'application/json' },
        timeoutMs: 60_000,
        retries: 0,
      });
      break;
    } catch {
      // try the next catalogue base
    }
  }
  if (!payload) {
    throw new Error(
      `CKAN package_search unavailable on all ${attempted.length} candidate bases; last tried: ${attempted[attempted.length - 1]}`,
    );
  }
  const out: CkanResource[] = [];
  for (const pkg of payload.result?.results ?? []) {
    const title = String(pkg.title ?? pkg.name ?? '');
    for (const res of (pkg.resources as Array<Record<string, unknown>>) ?? []) {
      out.push({
        name: String(res.name ?? 'resource'),
        url: String(res.url ?? ''),
        format: String(res.format ?? '').toUpperCase(),
        datasetTitle: title,
        datasetName: String(pkg.name ?? ''),
        license: typeof pkg.license_title === 'string' ? pkg.license_title : undefined,
        lastModified: typeof res.last_modified === 'string' ? res.last_modified : undefined,
      });
    }
  }
  return out;
}
export function ckanCandidates(resources: CkanResource[], sourceName = 'Data.gov'): SourceCandidate[] {
  const definition = definitionFor(sourceName);
  return resources
    .filter((r) => r.url.startsWith('http'))
    .map((r) => ({
      candidateId: candidateId('ckan', `${r.datasetName}-${r.name}`),
      sourceName,
      publisher: hostOf(r.url) || sourceName,
      url: r.url,
      kind: 'dataset' as const,
      accessMethod: (r.format === 'CSV' || r.format === 'JSON' ? 'download' : 'web') as SourceCandidate['accessMethod'],
      title: `${r.datasetTitle} - ${r.name}`,
      retrievedAt: nowIso(),
      license: r.license ?? definition?.license ?? 'UNKNOWN',
      machineReadable: r.format === 'CSV' || r.format === 'JSON' || r.format === 'XLSX',
      authority: 0.75,
      directness: 0.7,
      coverage: 0.6,
      methodologyTransparency: 0.5,
      recency: 0.5,
      consistency: 0.6,
      qualityScore: 0,
      accepts: null,
      primary: false,
      discoveredBy: 'ckan-connector',
      notes: [`resource format: ${r.format || 'unknown'}`],
    }));
}

// ---------------------------------------------------------------------------
// Hugging Face datasets-server
// ---------------------------------------------------------------------------

export async function huggingFaceRows(
  dataset: string,
  options: { config?: string; split?: string; offset?: number; length?: number; baseUrl?: string } = {},
): Promise<{ candidate: SourceCandidate; columns: string[]; rows: unknown[] }> {
  const base = (options.baseUrl ?? 'https://datasets-server.huggingface.co').replace(/\/$/, '');
  const token = env('HUGGINGFACE_TOKEN');
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  const url =
    `${base}/rows?dataset=${encodeURIComponent(dataset)}` +
    `&config=${encodeURIComponent(options.config ?? 'default')}` +
    `&split=${encodeURIComponent(options.split ?? 'train')}` +
    `&offset=${options.offset ?? 0}&length=${options.length ?? 100}`;
  const payload = await getJson<{ features?: Array<{ name?: string }>; rows?: Array<{ row?: unknown }> }>(url, { headers, timeoutMs: 60_000 });
  const definition = definitionFor('Hugging Face Datasets');
  return {
    candidate: {
      candidateId: candidateId('hf', dataset),
      sourceName: 'Hugging Face Datasets',
      publisher: 'Hugging Face',
      url,
      kind: 'dataset',
      accessMethod: 'api',
      title: dataset,
      retrievedAt: nowIso(),
      license: definition?.license ?? 'UNKNOWN',
      machineReadable: true,
      authority: 0.5,
      directness: 0.6,
      coverage: 0.5,
      methodologyTransparency: 0.35,
      recency: 0.6,
      consistency: 0.4,
      qualityScore: 0,
      accepts: null,
      primary: false,
      discoveredBy: 'huggingface-connector',
      notes: ['inspect the dataset card: not an authority for general-world statistics'],
    },
    columns: (payload.features ?? []).map((f) => String(f.name ?? '')),
    rows: payload.rows ?? [],
  };
}

// ---------------------------------------------------------------------------
// Eurostat / OECD / UNdata (SDMX-style)
// ---------------------------------------------------------------------------

export async function eurostatData(
  datasetCode: string,
  params: Record<string, string> = {},
  options: { baseUrl?: string } = {},
): Promise<{ candidate: SourceCandidate; payload: unknown }> {
  const base = (options.baseUrl ?? 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0').replace(/\/$/, '');
  const search = new URLSearchParams({ format: 'JSON', ...params });
  const url = `${base}/data/${datasetCode}?${search.toString()}`;
  const payload = await getJson<unknown>(url, { timeoutMs: 90_000 });
  const definition = definitionFor('Eurostat');
  return {
    candidate: {
      candidateId: candidateId('eurostat', datasetCode),
      sourceName: 'Eurostat',
      publisher: 'Eurostat',
      url,
      kind: 'api',
      accessMethod: 'api',
      title: datasetCode,
      retrievedAt: nowIso(),
      license: definition?.license ?? 'Eurostat reuse policy',
      machineReadable: true,
      authority: 0.9,
      directness: 0.9,
      coverage: 0.8,
      methodologyTransparency: 0.85,
      recency: 0.9,
      consistency: 0.9,
      qualityScore: 0,
      accepts: null,
      primary: false,
      discoveredBy: 'eurostat-connector',
      notes: [`params: ${search.toString()}`],
    },
    payload,
  };
}

export async function oecdData(
  dataflow: string,
  key = 'all',
  options: { baseUrl?: string; startPeriod?: string } = {},
): Promise<{ candidate: SourceCandidate; payload: unknown }> {
  const base = (options.baseUrl ?? 'https://sdmx.oecd.org/public/rest/v1').replace(/\/$/, '');
  const search = new URLSearchParams({ format: 'jsondata' });
  if (options.startPeriod) search.set('startPeriod', options.startPeriod);
  const url = `${base}/data/${dataflow}/${key}?${search.toString()}`;
  const payload = await getJson<unknown>(url, {
    headers: { Accept: 'application/vnd.sdmx.data+json;version=2.0.0' },
    timeoutMs: 90_000,
  });
  const definition = definitionFor('OECD');
  return {
    candidate: {
      candidateId: candidateId('oecd', dataflow),
      sourceName: 'OECD',
      publisher: 'OECD',
      url,
      kind: 'api',
      accessMethod: 'api',
      title: dataflow,
      retrievedAt: nowIso(),
      license: definition?.license ?? 'OECD terms',
      machineReadable: true,
      authority: 0.9,
      directness: 0.85,
      coverage: 0.8,
      methodologyTransparency: 0.8,
      recency: 0.9,
      consistency: 0.85,
      qualityScore: 0,
      accepts: null,
      primary: false,
      discoveredBy: 'oecd-connector',
    },
    payload,
  };
}

export async function unDataQuery(
  query: Record<string, string>,
  options: { baseUrl?: string } = {},
): Promise<{ candidate: SourceCandidate; payload: unknown }> {
  const base = (options.baseUrl ?? 'https://data.un.org/ws/rest').replace(/\/$/, '');
  const search = new URLSearchParams(query);
  const url = `${base}/data?${search.toString()}`;
  const payload = await getJson<unknown>(url, { timeoutMs: 90_000 });
  const definition = definitionFor('UNdata');
  return {
    candidate: {
      candidateId: candidateId('undata', search.toString()),
      sourceName: 'UNdata',
      publisher: 'United Nations Statistics Division',
      url,
      kind: 'api',
      accessMethod: 'api',
      title: query['datasetCode'] ?? 'UNdata series',
      retrievedAt: nowIso(),
      license: definition?.license ?? 'UN terms of use',
      machineReadable: true,
      authority: 0.9,
      directness: 0.85,
      coverage: 0.85,
      methodologyTransparency: 0.75,
      recency: 0.85,
      consistency: 0.85,
      qualityScore: 0,
      accepts: null,
      primary: false,
      discoveredBy: 'undata-connector',
    },
    payload,
  };
}
// ---------------------------------------------------------------------------
// AWS Open Data + discovery directories
// ---------------------------------------------------------------------------

export async function awsOpenDataSearch(query: string, options: { limit?: number } = {}): Promise<SourceCandidate[]> {
  // `https://registry.opendata.aws/index.json` returns 404 (checked 2026-09-21),
  // so the registry is read from its upstream source of truth: one YAML file per
  // dataset in awslabs/open-data-registry, exposed through the GitHub contents API.
  const listing = await getJson<Array<{ name?: string; type?: string }>>(
    'https://api.github.com/repos/awslabs/open-data-registry/contents/datasets',
    { headers: { 'User-Agent': 'analysis-video-maker', Accept: 'application/vnd.github+json' }, timeoutMs: 90_000 },
  );
  if (!Array.isArray(listing)) throw new Error('AWS Open Data registry listing was not a JSON array');
  const needle = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const hits = listing
    .filter((entry) => entry.type === 'file' && typeof entry.name === 'string')
    .map((entry) => ({ name: String(entry.name).replace(/\.yaml$/, ''), file: String(entry.name) }))
    .filter((entry) => needle.length === 0 || needle.some((word) => entry.name.replace(/-/g, ' ').includes(word)))
    .slice(0, options.limit ?? 5);
  return hits.map((entry) => ({
    candidateId: candidateId('aws', entry.name),
    sourceName: 'AWS Open Data Registry',
    publisher: 'AWS Open Data',
    url: `https://registry.opendata.aws/${entry.name}/`,
    kind: 'dataset' as const,
    accessMethod: 'web' as const,
    title: entry.name.replace(/-/g, ' '),
    description: `Registry entry ${entry.file}`,
    retrievedAt: nowIso(),
    license: 'UNKNOWN',
    machineReadable: false,
    authority: 0.7,
    directness: 0.4,
    coverage: 0.5,
    methodologyTransparency: 0.4,
    recency: 0.5,
    consistency: 0.6,
    qualityScore: 0,
    accepts: null,
    primary: false,
    discoveredBy: 'aws-opendata-connector',
    notes: ['licence and access method must be read from the entry before use'],
  }));
}
/** Extract outbound dataset links from a discovery directory page. */
export async function directoryLinks(pageUrl: string, options: { limit?: number } = {}): Promise<Array<{ url: string; title: string }>> {
  const { text } = await getText(pageUrl, { timeoutMs: 60_000 });
  const out: Array<{ url: string; title: string }> = [];
  const seen = new Set<string>();
  const re = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const href = match[1];
    const title = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!/^https?:/.test(href) || seen.has(href)) continue;
    seen.add(href);
    out.push({ url: href, title: title || hostOf(href) });
    if (out.length >= (options.limit ?? 60)) break;
  }
  return out;
}

/** Google Dataset Search is discovery only: the real provider is followed through. */
export async function googleDatasetSearch(
  query: string,
  search: SearchProvider,
  options: { limit?: number } = {},
): Promise<SourceCandidate[]> {
  const results = await search.search(`${query} dataset csv`, { limit: options.limit ?? 8 });
  return results.map((r) => ({
    candidateId: candidateId('gds', r.url),
    sourceName: 'Google Dataset Search',
    publisher: hostOf(r.url) || 'discovery',
    url: r.url,
    kind: 'dataset' as const,
    accessMethod: 'web' as const,
    title: r.title,
    description: r.snippet,
    retrievedAt: nowIso(),
    license: 'UNKNOWN',
    machineReadable: false,
    authority: 0.3,
    directness: 0.2,
    coverage: 0.3,
    methodologyTransparency: 0.2,
    recency: 0.4,
    consistency: 0.3,
    qualityScore: 0,
    accepts: null,
    primary: false,
    discoveredBy: 'google-dataset-search',
    notes: ['discovery index only: follow through to the dataset owner before trusting any value'],
  }));
}

// ---------------------------------------------------------------------------
// User uploads
// ---------------------------------------------------------------------------

export interface UploadedFile {
  path: string;
  kind: 'csv' | 'xlsx' | 'json' | 'pdf' | 'image' | 'txt' | 'unknown';
  role: 'primary' | 'cross-check';
}

export function classifyUpload(path: string): UploadedFile['kind'] {
  const lower = path.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) return 'csv';
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.ods')) return 'xlsx';
  if (lower.endsWith('.json') || lower.endsWith('.jsonl')) return 'json';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (/\.(png|jpe?g|webp|gif)$/.test(lower)) return 'image';
  if (lower.endsWith('.txt')) return 'txt';
  return 'unknown';
}

export function uploadedCandidate(file: UploadedFile): SourceCandidate {
  return {
    candidateId: candidateId('upload', file.path),
    sourceName: 'User upload',
    publisher: 'user-provided',
    url: `upload:${file.path}`,
    kind: 'upload',
    accessMethod: 'manual',
    title: file.path.split(/[\\/]/).pop() ?? file.path,
    retrievedAt: nowIso(),
    license: 'user-provided',
    machineReadable: file.kind === 'csv' || file.kind === 'xlsx' || file.kind === 'json',
    authority: 1,
    directness: 1,
    coverage: 0.6,
    methodologyTransparency: file.kind === 'pdf' ? 0.4 : 0.6,
    recency: 0.8,
    consistency: 0.6,
    qualityScore: 0,
    accepts: null,
    primary: file.role === 'primary',
    discoveredBy: 'upload',
    notes: [
      file.role === 'primary'
        ? 'user instruction: use as the primary dataset'
        : 'user instruction: cross-check only; web research is primary',
      file.kind === 'pdf' || file.kind === 'image'
        ? 'PDF/image extraction is a later-phase connector (currently a documented TODO)'
        : `machine readable: ${file.kind}`,
    ],
  };
}

// ---------------------------------------------------------------------------
// CSV helper (for connectors that return delimited text)
// ---------------------------------------------------------------------------

export function parseCsv(text: string, delimiter = ','): { columns: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const columns = rows.shift() ?? [];
  return { columns, rows: rows.filter((r) => r.some((c) => c.trim() !== '')) };
}

// ---------------------------------------------------------------------------
// companiesmarketcap.com historical market-cap series
// ---------------------------------------------------------------------------
//
// The canonical source for company market-cap HISTORY (every Kaggle/CSV
// candidate is a point-in-time snapshot with no date column, which can never
// form a time series — the 2026-10-02 "World's Largest Companies by Market
// Cap" research failure). Each per-company page
//   https://companiesmarketcap.com/<slug>/marketcap/
// embeds the full daily history as {"d":<unix ts>,"m":<value>} points.
// Verified 2026-10-02 against Apple's page:
//   m is in units of USD 1e5 — 1997-03-31 m=23075 -> ~$2.31B,
//   2020-12-01 m=20864611 -> ~$2.09T, 2026-10-02 m=48408895 -> ~$4.84T.

export interface CompanyMarketCapYear {
  year: number;
  /** Year-end market capitalization in USD. */
  valueUsd: number;
}

export interface CompanyMarketCapHistory {
  company: string;
  slug: string;
  years: CompanyMarketCapYear[];
}

/**
 * Parse a companiesmarketcap.com/<slug>/marketcap/ page: company name from
 * the <title> and the embedded {"d","m"} history series, aggregated to one
 * year-end value per calendar year. Pure and unit-testable.
 */
export function parseCompaniesMarketCapHtml(html: string): { company: string; points: Array<{ ts: number; m: number }> } {
  const titleM = /<title>\s*([^<]+?)\s*-\s*Market capitalization/i.exec(html);
  let company = 'company';
  if (titleM) {
    company = titleM[1].replace(/\s*\([A-Za-z0-9.\-]+\)\s*$/, '').trim() || 'company';
  }
  const points: Array<{ ts: number; m: number }> = [];
  const re = /\{"d":(\d+),"m":(\d+(?:\.\d+)?)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const ts = Number(m[1]);
    const val = Number(m[2]);
    if (Number.isFinite(ts) && ts > 0 && Number.isFinite(val) && val > 0) points.push({ ts, m: val });
  }
  return { company, points };
}

/** Collapse daily {"d","m"} points to year-end (last point per year) USD values. */
export function companiesMarketCapYearEnds(points: Array<{ ts: number; m: number }>): CompanyMarketCapYear[] {
  const byYear = new Map<number, { ts: number; m: number }>();
  for (const p of points) {
    const year = new Date(p.ts * 1000).getUTCFullYear();
    if (year < 1900 || year > 2100) continue;
    const cur = byYear.get(year);
    if (!cur || p.ts > cur.ts) byYear.set(year, p);
  }
  return [...byYear.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, p]) => ({ year, valueUsd: Math.round(p.m * 1e5) }));
}

async function fetchCompaniesMarketCapPage(slug: string, timeoutMs: number): Promise<CompanyMarketCapHistory | null> {
  try {
    const { text } = await getText(`https://companiesmarketcap.com/${slug}/marketcap/`, { timeoutMs });
    const { company, points } = parseCompaniesMarketCapHtml(text);
    const years = companiesMarketCapYearEnds(points);
    if (years.length < 2) return null;
    return { company, slug, years };
  } catch {
    return null;
  }
}

/**
 * Fetch the current top-N companies from the companiesmarketcap.com ranking
 * page (document order == market-cap rank) plus each company's full market-cap
 * history. Returns histories with at least 2 year-points, in rank order.
 */
export async function companiesMarketCapHistories(
  topN: number,
  options: { timeoutMs?: number; concurrency?: number } = {},
): Promise<CompanyMarketCapHistory[]> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const concurrency = options.concurrency ?? 4;
  const { text } = await getText('https://companiesmarketcap.com/', { timeoutMs });
  const slugs: string[] = [];
  const seen = new Set<string>();
  const re = /href="\/([a-z0-9-]+)\/marketcap\/"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      slugs.push(m[1]);
    }
    if (slugs.length >= topN) break;
  }
  if (slugs.length === 0) throw new Error('companiesmarketcap.com ranking page yielded no company slugs');
  const results: CompanyMarketCapHistory[] = [];
  for (let i = 0; i < slugs.length; i += concurrency) {
    const batch = await Promise.all(slugs.slice(i, i + concurrency).map((s) => fetchCompaniesMarketCapPage(s, timeoutMs)));
    for (const h of batch) if (h) results.push(h);
  }
  return results;
}