/** Search + fetch for the research agent (Monid proxy -> TinyFish, direct fallback). */

import { env } from './runtime';

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface FetchResult {
  url: string;
  status: number;
  text?: string;
}

export interface SearchProvider {
  search(query: string, options?: { limit?: number }): Promise<SearchResult[]>;
  fetch(url: string): Promise<FetchResult>;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export async function directFetch(url: string, timeoutMs = 45_000): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { 'User-Agent': UA }, signal: controller.signal });
    const text = await response.text();
    return { url, status: response.status, text: text.slice(0, 400_000) };
  } finally {
    clearTimeout(timer);
  }
}

function normaliseResults(raw: unknown, limit: number): SearchResult[] {
  const out: SearchResult[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 6 || out.length >= limit) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (value && typeof value === 'object') {
      const node = value as Record<string, unknown>;
      const url = (node.url ?? node.link ?? node.href) as string | undefined;
      if (typeof url === 'string' && url.startsWith('http')) {
        out.push({ title: String(node.title ?? url), url, snippet: typeof node.snippet === 'string' ? node.snippet : undefined });
        return;
      }
      for (const key of ['output', 'results', 'data', 'items', 'organic']) {
        if (key in node) walk(node[key], depth + 1);
      }
    }
  };
  walk(raw, 0);
  return out;
}

export function createSearchProvider(): SearchProvider {
  const apiKey = env('MONID_API_KEY');
  const base = env('MONID_BASE_URL', 'https://api.monid.ai/v1');
  const usable = apiKey.length > 20 && !apiKey.includes('…') && !apiKey.includes('...');

  return {
    async search(query, options) {
      const limit = options?.limit ?? 8;
      if (usable) {
        try {
          const response = await fetch(`${base}/run`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              provider: 'tinyfish',
              endpoint: '/search',
              input: { queryParams: { query, purpose: 'find a machine-readable historical dataset' } },
            }),
          });
          if (response.ok) {
            return normaliseResults(await response.json(), limit);
          }
        } catch {
          /* fall through */
        }
      }
      return [];
    },
    async fetch(url) {
      // A thin proxy response (JS-rendered pages) gets a direct retry.
      const direct = await directFetch(url);
      if ((direct.text?.length ?? 0) > 20000) return direct;
      if (usable) {
        for (const input of [
          { body: { urls: [url], format: 'markdown' } },
          { body: { urls: [url] } },
        ]) {
          try {
            const response = await fetch(`${base}/run`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ provider: 'tinyfish', endpoint: '/fetch', input }),
            });
            if (response.ok) {
              const raw = (await response.json()) as Record<string, unknown>;
              const output = raw.output as Record<string, unknown> | undefined;
              const results = (output?.results ?? raw.results) as Array<Record<string, unknown>> | undefined;
              const text = Array.isArray(results)
                ? results.map((r) => String(r.text ?? r.content ?? '')).find((t) => t.length > 0)
                : undefined;
              if (text) return { url, status: 200, text };
            }
          } catch {
            /* fall through */
          }
        }
      }
      return directFetch(url);
    },
  };
}