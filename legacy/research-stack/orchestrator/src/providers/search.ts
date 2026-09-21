/**
 * Search + fetch providers.
 *
 * Primary implementation is the Monid proxy API, which fronts the free TinyFish
 * `search` and `fetch` endpoints. The proxy shape is:
 *
 *   POST https://api.monid.ai/v1/inspect
 *     { "provider": "tinyfish", "endpoint": "/search" }
 *   POST https://api.monid.ai/v1/run
 *     { "provider": "tinyfish", "endpoint": "/search", "input": { ... } }
 *
 * The exact `input` payload is discovered at runtime via `inspect`, with the
 * documented shapes as a fallback, so a schema change on the provider side
 * degrades instead of breaking the pipeline.
 */

import { DiskCache, JsonlLog, env, logger } from '../runtime';

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
  publisher?: string;
  kind?: string;
}

export interface FetchResult {
  url: string;
  status: number;
  contentType?: string;
  text?: string;
  json?: unknown;
  bytes?: number;
  via: string;
}

export interface SearchOptions {
  limit?: number;
  signal?: AbortSignal;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  fetch(url: string): Promise<FetchResult>;
}

/** Per-project call budget so a run can never loop forever. */
export class Budget {
  private searches = 0;
  private fetches = 0;
  private aiCalls = 0;

  constructor(
    private readonly maxSearches: number,
    private readonly maxFetches: number,
    private readonly maxAiCalls: number,
  ) {}

  takeSearch(): boolean {
    if (this.searches >= this.maxSearches) return false;
    this.searches += 1;
    return true;
  }

  takeFetch(): boolean {
    if (this.fetches >= this.maxFetches) return false;
    this.fetches += 1;
    return true;
  }

  takeAi(): boolean {
    if (this.aiCalls >= this.maxAiCalls) return false;
    this.aiCalls += 1;
    return true;
  }

  used(): { searches: number; fetches: number; aiCalls: number } {
    return { searches: this.searches, fetches: this.fetches, aiCalls: this.aiCalls };
  }

  exhausted(): boolean {
    return this.searches >= this.maxSearches || this.fetches >= this.maxFetches || this.aiCalls >= this.maxAiCalls;
  }

  /** True while there is still budget left for more calls. */
  remaining(): boolean {
    return !this.exhausted();
  }
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/**
 * Direct HTTP fetch with a browser user-agent (some providers 403 otherwise).
 *
 * Always bounded by a timeout: an unbounded fetch is how a run hangs forever on
 * one slow host.
 */
export async function directFetch(url: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (init.signal) {
    const outer = init.signal;
    outer.addEventListener('abort', () => controller.abort(), { once: true });
  }
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: '*/*',
        ...(init.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
  const contentType = response.headers.get('content-type') ?? undefined;
  const text = await response.text();
  let json: unknown = undefined;
  if (contentType && (contentType.includes('json') || text.trimStart().startsWith('{') || text.trimStart().startsWith('['))) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  return {
    url,
    status: response.status,
    contentType,
    text: text.length > 4_000_000 ? text.slice(0, 4_000_000) : text,
    json,
    bytes: text.length,
    via: 'direct',
  };
}

export interface MonidConfig {
  baseUrl: string;
  apiKey: string;
  searchProvider: string;
  searchEndpoint: string;
  fetchEndpoint: string;
  cacheRoot?: string;
  /** Wall-clock budget for one proxy call. */
  timeoutMs?: number;
}

export class MonidProvider implements SearchProvider {
  readonly name = 'monid-tinyfish';
  private readonly cache: DiskCache;
  private readonly usage = new JsonlLog('search-usage.jsonl');
  private inspected = new Set<string>();

  constructor(
    private readonly config: MonidConfig,
    private readonly budget?: Budget,
  ) {
    this.cache = new DiskCache('search', config.cacheRoot);
  }

  configured(): boolean {
    return Boolean(this.config.apiKey);
  }

  private async call(endpoint: 'inspect' | 'run', body: Record<string, unknown>): Promise<unknown> {
    if (!this.config.apiKey) throw new Error('MONID_API_KEY is not configured');
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 60_000);
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/${endpoint}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    this.usage.append({
      at: new Date().toISOString(),
      proxy: 'monid',
      endpoint,
      ok: response.ok,
      status: response.status,
      durationMs: Date.now() - started,
    });
    if (!response.ok) {
      throw new Error(`monid ${endpoint} returned ${response.status}: ${text.slice(0, 200)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  /** Discover the provider's input schema once, then cache it in-process. */
  async inspect(endpoint: string): Promise<unknown> {
    const key = `${this.config.searchProvider}${endpoint}`;
    if (!this.inspected.has(key)) {
      try {
        const info = await this.call('inspect', { provider: this.config.searchProvider, endpoint });
        this.cache.set(`inspect:${key}`, info);
        this.inspected.add(key);
        return info;
      } catch (error) {
        logger.warn('monid inspect failed, using documented shapes', { endpoint, error: String(error) });
        this.inspected.add(key);
      }
    }
    return this.cache.get(`inspect:${key}`);
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const limit = options.limit ?? 10;
    if (this.budget && !this.budget.takeSearch()) {
      logger.warn('search budget exhausted');
      return [];
    }
    const cacheKey = `search:${this.config.searchProvider}:${query}:${limit}`;
    const cached = this.cache.get<SearchResult[]>(cacheKey);
    if (cached) return cached;

    await this.inspect(this.config.searchEndpoint);
    // Shapes verified against `POST /v1/inspect {provider:"tinyfish",endpoint:"/search"}`:
    //   queryParams.query (string) is the documented field; `purpose` is an
    //   optional ranking hint. The remaining shapes are kept as fallbacks for a
    //   provider-side schema change.
    const candidates: Array<Record<string, unknown>> = [
      { queryParams: { query, purpose: 'find a machine-readable dataset with numbers over time' } },
      { queryParams: { query } },
      { queryParams: { q: query } },
      { body: { query } },
      { query },
    ];
    for (const input of candidates) {
      try {
        const raw = (await this.call('run', {
          provider: this.config.searchProvider,
          endpoint: this.config.searchEndpoint,
          input,
        })) as Record<string, unknown>;
        const results = normaliseSearchResults(raw, limit);
        if (results.length > 0) {
          this.cache.set(cacheKey, results);
          return results;
        }
      } catch (error) {
        logger.warn('monid search attempt failed', { shape: JSON.stringify(input).slice(0, 80), error: String(error) });
      }
    }
    return [];
  }

  async fetch(url: string): Promise<FetchResult> {
    if (this.budget && !this.budget.takeFetch()) {
      logger.warn('fetch budget exhausted');
      throw new Error('fetch budget exhausted');
    }
    const cacheKey = `fetch:${url}`;
    const cached = this.cache.get<FetchResult>(cacheKey);
    if (cached) return cached;

    if (this.config.apiKey) {
      await this.inspect(this.config.fetchEndpoint);
      // Verified shape: POST /v1/run {provider:"tinyfish", endpoint:"/fetch",
      // input:{ body: { urls: [...], format: "markdown" } }}. 1-10 URLs per call.
      for (const input of [
        { body: { urls: [url], format: 'markdown', purpose: 'read the dataset page or download link' } },
        { body: { urls: [url] } },
        { body: { url } },
        { queryParams: { url } },
        { url },
      ]) {
        try {
          const raw = (await this.call('run', {
            provider: this.config.searchProvider,
            endpoint: this.config.fetchEndpoint,
            input,
          })) as Record<string, unknown>;
          const text = extractFetchedText(raw);
          if (text !== undefined) {
            const result: FetchResult = {
              url,
              status: 200,
              text,
              json: tryJson(text),
              bytes: text.length,
              contentType: 'text/html',
              via: 'monid',
            };
            this.cache.set(cacheKey, result);
            return result;
          }
        } catch (error) {
          logger.warn('monid fetch attempt failed, falling back to direct', { url, error: String(error) });
        }
      }
    }
    const direct = await directFetch(url);
    this.cache.set(cacheKey, direct);
    return direct;
  }
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Tolerant extraction of a search result list from an unknown proxy shape. */
export function normaliseSearchResults(raw: unknown, limit: number): SearchResult[] {
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
        out.push({
          title: String(node.title ?? node.name ?? url),
          url,
          snippet: typeof node.snippet === 'string' ? node.snippet : typeof node.description === 'string' ? node.description : undefined,
          publisher: typeof node.site_name === 'string' ? node.site_name : typeof node.publisher === 'string' ? node.publisher : hostOf(url),
        });
        return;
      }
      for (const key of ['output', 'results', 'data', 'items', 'organic', 'web', 'hits', 'value', 'content', 'searchResults']) {
        if (key in node) walk(node[key], depth + 1);
      }
    }
  };
  walk(raw, 0);
  return out.slice(0, limit);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Build the default search provider from environment configuration. */
export function createSearchProvider(budget?: Budget, cacheRoot?: string): MonidProvider {
  return new MonidProvider(
    {
      baseUrl: env('MONID_BASE_URL', 'https://api.monid.ai/v1'),
      apiKey: env('MONID_API_KEY'),
      searchProvider: env('MONID_SEARCH_PROVIDER', 'tinyfish'),
      searchEndpoint: env('MONID_SEARCH_ENDPOINT', '/search'),
      fetchEndpoint: env('MONID_FETCH_ENDPOINT', '/fetch'),
      cacheRoot,
    },
    budget,
  );
}
/** Pull the page text out of a TinyFish `/fetch` envelope (`output.results[].text`). */
export function extractFetchedText(raw: unknown): string | undefined {
  const node = raw as Record<string, unknown> | null;
  if (!node || typeof node !== 'object') return undefined;
  const output = node.output as Record<string, unknown> | undefined;
  const results = (output?.results ?? node.results) as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(results)) {
    for (const entry of results) {
      for (const key of ['text', 'content', 'markdown', 'body']) {
        if (typeof entry[key] === 'string' && (entry[key] as string).length > 0) return entry[key] as string;
      }
    }
  }
  for (const key of ['text', 'content', 'body']) {
    if (typeof node[key] === 'string') return node[key] as string;
  }
  return undefined;
}