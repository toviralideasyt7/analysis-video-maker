/**
 * Kaggle - public dataset search and download with a username/key pair.
 *
 *   search    GET https://www.kaggle.com/api/v1/datasets/list?search=<q>&pageSize=<n>
 *   view      GET https://www.kaggle.com/api/v1/datasets/view/<owner>/<slug>
 *   download  GET https://www.kaggle.com/api/v1/datasets/download/<owner>/<slug>
 *             GET https://www.kaggle.com/api/v1/datasets/download/<owner>/<slug>/<fileName>
 *
 * IMPORTANT: Kaggle answers a browser User-Agent with an HTML reCAPTCHA page and
 * HTTP 200, so the request must send a tool-style UA (curl/...) instead. See
 * TOOL_UA in http.ts.
 *
 * Credentials come from KAGGLE_USERNAME / KAGGLE_KEY and are never logged.
 *
 * Verified live 2026-09-21: datasets/list returned JSON 200 with a tool UA.
 */

import { fetchText, fetchJson, TOOL_UA } from './http';

export const KAGGLE_API = 'https://www.kaggle.com/api/v1';

export interface KaggleCredentials {
  username: string;
  key: string;
}

/** Read credentials from the environment, ignoring masked placeholder values. */
export function kaggleCredentials(env: NodeJS.ProcessEnv = process.env): KaggleCredentials | null {
  const username = (env.KAGGLE_USERNAME ?? '').trim();
  const key = (env.KAGGLE_KEY ?? '').trim();
  if (!username || !key) return null;
  if (/[\u2026]|\.\.\.|\*\*\*/.test(key)) return null;   // masked value pasted into chat
  return { username, key };
}

function authHeader(credentials: KaggleCredentials): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.key}`, 'utf8').toString('base64')}` };
}

export interface KaggleDataset {
  ref: string;              // owner/slug
  title: string;
  subtitle?: string;
  url?: string;
  totalBytes?: number;
  downloadCount?: number;
  lastUpdated?: string;
  licenseName?: string;
  usabilityRating?: number;
  thumbnailImageUrl?: string;
}

export async function searchKaggleDatasets(
  query: string,
  options: { pageSize?: number; credentials?: KaggleCredentials } = {},
): Promise<KaggleDataset[]> {
  const credentials = options.credentials ?? kaggleCredentials();
  if (!credentials) throw new Error('Kaggle credentials missing (KAGGLE_USERNAME / KAGGLE_KEY)');
  const pageSize = options.pageSize ?? 10;
  const url = `${KAGGLE_API}/datasets/list?search=${encodeURIComponent(query)}&pageSize=${pageSize}`;
  const text = await fetchText(url, { ua: TOOL_UA, headers: authHeader(credentials) });
  const parsed = JSON.parse(text) as Array<Record<string, unknown>>;
  return parsed.map((item) => ({
    ref: String(item.ref ?? ''),
    title: String(item.title ?? item.titleNullable ?? ''),
    subtitle: (item.subtitle as string | undefined) ?? undefined,
    url: (item.url as string | undefined) ?? undefined,
    totalBytes: Number(item.totalBytes ?? 0) || undefined,
    downloadCount: Number(item.downloadCount ?? 0) || undefined,
    lastUpdated: (item.lastUpdated as string | undefined) ?? undefined,
    licenseName: (item.licenseName as string | undefined) ?? undefined,
    usabilityRating: Number(item.usabilityRating ?? 0) || undefined,
    thumbnailImageUrl: (item.thumbnailImageUrl as string | undefined) ?? undefined,
  })).filter((dataset) => Boolean(dataset.ref));
}

export interface KaggleFile {
  name: string;
  size?: number;
  totalBytes?: number;
}

/**
 * List the files inside a dataset (no download). Note the asymmetry: dataset
 * metadata lives at /datasets/view/<ref>, but the file listing is
 * /datasets/list/<ref> and returns { datasetFiles: [ { name, totalBytes } ] }.
 */
export async function listKaggleFiles(ref: string, credentials = kaggleCredentials()): Promise<KaggleFile[]> {
  if (!credentials) throw new Error('Kaggle credentials missing');
  const data = await fetchJson<{ datasetFiles?: Array<Record<string, unknown>> }>(
    `${KAGGLE_API}/datasets/list/${ref}`,
    { ua: TOOL_UA, headers: authHeader(credentials) },
  );
  return (data.datasetFiles ?? []).map((item) => ({
    name: String(item.name ?? ''),
    totalBytes: Number(item.totalBytes ?? 0) || undefined,
  })).filter((file) => Boolean(file.name));
}

/** Direct download URL for a whole dataset (zip) or one file inside it. */
export const kaggleDownloadUrl = (ref: string, fileName?: string): string =>
  fileName ? `${KAGGLE_API}/datasets/download/${ref}/${fileName}` : `${KAGGLE_API}/datasets/download/${ref}`;

/** Download a single file as text (CSV/JSON) - gives the table without unzip. */
export async function downloadKaggleText(ref: string, fileName: string, credentials = kaggleCredentials()): Promise<string> {
  if (!credentials) throw new Error('Kaggle credentials missing');
  return fetchText(kaggleDownloadUrl(ref, fileName), { ua: TOOL_UA, headers: authHeader(credentials), timeoutMs: 120_000 });
}