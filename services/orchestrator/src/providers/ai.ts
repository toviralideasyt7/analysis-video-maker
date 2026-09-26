/**
 * AI provider abstraction.
 *
 * Design rules taken straight from the operating notes for the Gemini proxy
 * workers:
 *   - ONE worker per batch; the second worker is a backup used only on 429/502/503;
 *   - pace 1 request / 2s (thinking models 1 request / 4s);
 *   - on 429/502/503 stop that worker for 2-3 minutes instead of hammering it;
 *   - cache answers and never re-ask the same question.
 *
 * The abstraction is deliberately provider-agnostic so a new model can be added
 * without touching the agents.
 */

import { DiskCache, JsonlLog, env, envList, logger, sha256 } from '../runtime';
import { validate, type SchemaName } from '@avm/shared';

export interface AIRequest {
  system?: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AIResponse {
  text: string;
  provider: string;
  model: string;
  cached: boolean;
  durationMs: number;
  usage?: { tokens?: number };
}

export interface AIProvider {
  readonly name: string;
  generate(req: AIRequest): Promise<AIResponse>;
}

export class AIError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'AIError';
  }
}

// ---------------------------------------------------------------------------
// Pacing + cooldown
// ---------------------------------------------------------------------------

class Pacer {
  private lastStart = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly minIntervalMs: number) {}

  /** Serialize calls with a minimum spacing between request starts. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(async () => {
      const wait = this.minIntervalMs - (Date.now() - this.lastStart);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastStart = Date.now();
      return task();
    });
    // Keep the chain alive even when a task rejects.
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** fetch with a hard timeout — a hung upstream fails fast instead of blocking the chain. */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 60000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Gemini web-proxy workers (no API key required)
// ---------------------------------------------------------------------------

export interface GeminiProxyConfig {
  workers: string[];
  models: string[];
  cooldownMs?: number;
  cacheRoot?: string;
}

export class GeminiProxyProvider implements AIProvider {
  readonly name = 'gemini-web-proxy';
  private readonly cooldowns = new Map<string, number>();
  private readonly cache: DiskCache;
  private readonly usage = new JsonlLog('usage.jsonl');
  private activeWorker: number;

  constructor(private readonly config: GeminiProxyConfig) {
    this.cache = new DiskCache('ai', config.cacheRoot);
    this.activeWorker = 0;
  }

  private worker(): string {
    const now = Date.now();
    for (let i = 0; i < this.config.workers.length; i += 1) {
      const index = (this.activeWorker + i) % this.config.workers.length;
      const url = this.config.workers[index];
      const until = this.cooldowns.get(url) ?? 0;
      if (until <= now) {
        this.activeWorker = index;
        return url;
      }
    }
    // Everything is cooling down: return the one that frees up soonest.
    let best = this.config.workers[0];
    let bestUntil = Number.POSITIVE_INFINITY;
    for (const url of this.config.workers) {
      const until = this.cooldowns.get(url) ?? 0;
      if (until < bestUntil) {
        bestUntil = until;
        best = url;
      }
    }
    return best;
  }

  private paceFor(model: string): Pacer {
    const thinking = model.includes('thinking');
    // Pacer per model class keeps the 2s / 4s rule from the operating notes.
    const key = thinking ? 'thinking' : 'standard';
    const existing = this.pacers.get(key);
    if (existing) return existing;
    const pacer = new Pacer(thinking ? 4000 : 2000);
    this.pacers.set(key, pacer);
    return pacer;
  }

  private readonly pacers = new Map<string, Pacer>();

  private cooldownWorker(url: string, status: number): void {
    const ms = this.config.cooldownMs ?? 150_000;
    this.cooldowns.set(url, Date.now() + ms);
    logger.warn('worker cooling down', { worker: url, status, cooldownMs: ms });
    const other = this.config.workers.findIndex((w) => w !== url);
    if (other >= 0) this.activeWorker = other;
  }

  async generate(req: AIRequest): Promise<AIResponse> {
    const model = this.config.models[0] ?? 'gemini-3.7-flash';
    return this.generateWithModel(model, req);
  }

  async generateWithModel(model: string, req: AIRequest): Promise<AIResponse> {
    const messages: Array<{ role: string; content: string }> = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push({ role: 'user', content: req.prompt });

    const cacheKey = sha256(JSON.stringify({ provider: this.name, model, messages, maxTokens: req.maxTokens ?? null }));
    const hit = this.cache.get<AIResponse>(cacheKey);
    if (hit) {
      this.usage.append({ at: new Date().toISOString(), provider: this.name, model, operation: 'generate', cached: true, ok: true, durationMs: 0 });
      return { ...hit, cached: true };
    }

    const pacer = this.paceFor(model);
    let lastError: unknown = null;
    const attempts = Math.max(2, this.config.workers.length + 1);

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const worker = this.worker();
      const started = Date.now();
      try {
        const response = await pacer.run(() =>
          fetchWithTimeout(`${worker.replace(/\/$/, '')}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              messages,
              ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
              ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
            }),
          }),
        );

        const text = await response.text();
        if (!response.ok) {
          const retryable = RETRYABLE_STATUS.has(response.status);
          this.usage.append({
            at: new Date().toISOString(),
            provider: this.name,
            model,
            operation: 'generate',
            ok: false,
            durationMs: Date.now() - started,
            status: response.status,
          });
          if (retryable) {
            this.cooldownWorker(worker, response.status);
            lastError = new AIError(`worker returned ${response.status}`, response.status, true);
            continue;
          }
          throw new AIError(`worker returned ${response.status}: ${text.slice(0, 200)}`, response.status, false);
        }

        const parsed = JSON.parse(text) as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { total_tokens?: number };
        };
        const content = parsed.choices?.[0]?.message?.content ?? '';
        const result: AIResponse = {
          text: content,
          provider: this.name,
          model,
          cached: false,
          durationMs: Date.now() - started,
          usage: { tokens: parsed.usage?.total_tokens },
        };
        this.cache.set(cacheKey, result);
        this.usage.append({
          at: new Date().toISOString(),
          provider: this.name,
          model,
          operation: 'generate',
          ok: true,
          durationMs: result.durationMs,
          tokens: result.usage?.tokens,
        });
        return result;
      } catch (error) {
        if (error instanceof AIError && !error.retryable) throw error;
        lastError = error;
        this.cooldownWorker(worker, 0);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    throw lastError instanceof Error ? lastError : new AIError('gemini proxy exhausted all workers');
  }

  async listModels(): Promise<string[]> {
    const results: string[] = [];
    for (const worker of this.config.workers) {
      try {
        const res = await fetch(`${worker.replace(/\/$/, '')}/v1/models`);
        if (res.ok) {
          const body = (await res.json()) as { data?: Array<{ id?: string }> };
          for (const m of body.data ?? []) if (m.id) results.push(m.id);
        }
      } catch {
        /* a worker being down is not fatal */
      }
    }
    return Array.from(new Set(results));
  }
}

// ---------------------------------------------------------------------------
// Generic OpenAI-compatible provider (Nara router, any other gateway)
// ---------------------------------------------------------------------------

export interface OpenAICompatConfig {
  baseUrl: string;
  apiKey: string;
  models: string[];
  label: string;
  cacheRoot?: string;
}

export class OpenAICompatProvider implements AIProvider {
  readonly name: string;
  private readonly cache: DiskCache;
  private readonly usage = new JsonlLog('usage.jsonl');
  private readonly pacer = new Pacer(2000);

  constructor(private readonly config: OpenAICompatConfig) {
    this.name = config.label;
    this.cache = new DiskCache('ai', config.cacheRoot);
  }

  async generate(req: AIRequest): Promise<AIResponse> {
    return this.generateWithModel(this.config.models[0] ?? '', req);
  }

  /** Run a request on a specific upstream model. */
  async generateWithModel(model: string, req: AIRequest): Promise<AIResponse> {
    if (!model) throw new AIError(`${this.name}: no model configured`);
    if (!this.config.apiKey) throw new AIError(`${this.name}: missing API key`);

    const messages: Array<{ role: string; content: string }> = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push({ role: 'user', content: req.prompt });

    const cacheKey = sha256(JSON.stringify({ provider: this.name, model, messages }));
    const hit = this.cache.get<AIResponse>(cacheKey);
    if (hit) return { ...hit, cached: true };

    const started = Date.now();
    const response = await this.pacer.run(() =>
      fetchWithTimeout(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify({ model, messages, ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}) }),
      }),
    );
    const text = await response.text();
    if (!response.ok) {
      this.usage.append({ at: new Date().toISOString(), provider: this.name, model, operation: 'generate', ok: false, durationMs: Date.now() - started, status: response.status });
      if (RETRYABLE_STATUS.has(response.status)) {
        // Retry for real before falling over to the next model: a burst 429 on a
        // shared router is usually gone after a short wait.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const retryAfter = Number(response.headers.get('retry-after'));
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2500 * (attempt + 1);
          logger.warn('retrying provider request', { provider: this.name, model, status: response.status, waitMs });
          await new Promise((r) => setTimeout(r, waitMs));
          const retry = await this.pacer.run(() =>
            fetchWithTimeout(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.apiKey}` },
              body: JSON.stringify({ model, messages, ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}) }),
            }),
          );
          if (retry.ok) {
            const retryText = await retry.text();
            const retryParsed = JSON.parse(retryText) as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } };
            const ok: AIResponse = {
              text: retryParsed.choices?.[0]?.message?.content ?? '',
              provider: this.name,
              model,
              cached: false,
              durationMs: Date.now() - started,
              usage: { tokens: retryParsed.usage?.total_tokens },
            };
            this.cache.set(cacheKey, ok);
            this.usage.append({ at: new Date().toISOString(), provider: this.name, model, operation: 'generate', ok: true, durationMs: ok.durationMs, tokens: ok.usage?.tokens, retried: true });
            return ok;
          }
        }
      }
      throw new AIError(`${this.name} returned ${response.status}: ${text.slice(0, 200)}`, response.status, RETRYABLE_STATUS.has(response.status));
    }
    const parsed = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } };
    const result: AIResponse = {
      text: parsed.choices?.[0]?.message?.content ?? '',
      provider: this.name,
      model,
      cached: false,
      durationMs: Date.now() - started,
      usage: { tokens: parsed.usage?.total_tokens },
    };
    this.cache.set(cacheKey, result);
    this.usage.append({ at: new Date().toISOString(), provider: this.name, model, operation: 'generate', ok: true, durationMs: result.durationMs, tokens: result.usage?.tokens });
    return result;
  }
}

// ---------------------------------------------------------------------------
// Official Google Gemini API (generativelanguage.googleapis.com)
// ---------------------------------------------------------------------------

export interface GeminiOfficialConfig {
  apiKey: string;
  cacheRoot?: string;
}

export class GeminiOfficialProvider implements AIProvider {
  readonly name = 'gemini-official';
  private readonly cache: DiskCache;
  private readonly usage = new JsonlLog('usage.jsonl');
  private readonly pacer = new Pacer(1500);

  constructor(private readonly config: GeminiOfficialConfig) {
    this.cache = new DiskCache('ai', config.cacheRoot);
  }

  async generate(req: AIRequest): Promise<AIResponse> {
    return this.generateWithModel('gemini-3.8-flash', req);
  }

  /** Run a request on a specific official model (e.g. gemini-2.5-flash). */
  async generateWithModel(model: string, req: AIRequest): Promise<AIResponse> {
    if (!this.config.apiKey) throw new AIError('gemini-official: missing API key');

    const parts: Array<{ text: string }> = [];
    if (req.system) parts.push({ text: `System: ${req.system}` });
    parts.push({ text: req.prompt });

    const cacheKey = sha256(JSON.stringify({ provider: this.name, model, parts }));
    const hit = this.cache.get<AIResponse>(cacheKey);
    if (hit) return { ...hit, cached: true };

    const started = Date.now();
    const body: Record<string, unknown> = { contents: [{ parts }] };
    if (req.maxTokens || req.temperature !== undefined) {
      body.generationConfig = {
        ...(req.maxTokens ? { maxOutputTokens: req.maxTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      };
    }
    const doFetch = (apiVersion: string) =>
      fetchWithTimeout(
        `https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:generateContent?key=${this.config.apiKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      );
    let response = await this.pacer.run(() => doFetch('v1beta'));
    // If v1beta 404s (model not in beta), try the stable v1 API before giving up.
    if (response.status === 404) {
      logger.warn('gemini-official v1beta 404, trying v1', { model });
      response = await this.pacer.run(() => doFetch('v1'));
    }
    const text = await response.text();
    if (!response.ok) {
      this.usage.append({ at: new Date().toISOString(), provider: this.name, model, operation: 'generate', ok: false, durationMs: Date.now() - started, status: response.status });
      throw new AIError(`gemini-official returned ${response.status}: ${text.slice(0, 200)}`, response.status, RETRYABLE_STATUS.has(response.status));
    }
    const parsed = JSON.parse(text) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { totalTokenCount?: number };
    };
    const outText = (parsed.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    const result: AIResponse = {
      text: outText,
      provider: this.name,
      model,
      cached: false,
      durationMs: Date.now() - started,
      usage: { tokens: parsed.usageMetadata?.totalTokenCount },
    };
    this.cache.set(cacheKey, result);
    this.usage.append({ at: new Date().toISOString(), provider: this.name, model, operation: 'generate', ok: true, durationMs: result.durationMs, tokens: result.usage?.tokens });
    return result;
  }
}

// ---------------------------------------------------------------------------
// Mock provider (tests, offline runs)
// ---------------------------------------------------------------------------

export class MockProvider implements AIProvider {
  readonly name = 'mock';
  constructor(private readonly responder: (req: AIRequest) => string) {}
  async generate(req: AIRequest): Promise<AIResponse> {
    return { text: this.responder(req), provider: this.name, model: 'mock', cached: false, durationMs: 0 };
  }
}

// ---------------------------------------------------------------------------
// Client facade
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Role routing
// ---------------------------------------------------------------------------

export type ModelProvider = 'gemini' | 'gemini-official' | 'nara' | 'mock';

export interface ModelSpec {
  provider: ModelProvider;
  model: string;
}

/**
 * The job of each agent, and the models tried for it in order.
 *
 * Selection is deliberately explicit: picking the best source is a reasoning
 * task (a frontier model), while planning and QA are throughput tasks (fast
 * flash models). Gemini proxy workers are keyless and cheap; Nara carries the
 * hard reasoning roles. Every role has a cross-provider fallback so one
 * exhausted provider never stops a run.
 */
export type AgentRole =
  | 'planner'
  | 'queryScout'
  | 'sourcePicker'
  | 'extractor'
  | 'factCheck'
  | 'dataJudge'
  | 'story'
  | 'video'
  | 'qa';

/**
 * Model priority per role.
 *
 * Order (user-specified):
 *   1. Gemini proxy workers (GEMINI_WORKER_1/2) — primary when healthy
 *   2. NARA router free models — agnes-3-flash, agnes-2.5-flash,
 *      nemotron-3-ultra-free, jev, then the remaining free models
 *      (nemotron-3-super-free, nemotron-3.5-lightning-free,
 *      ling-3.0-flash-sante-free, ling-3.0-flash-fin-free, space-bunny-alpha)
 *   3. Official Google Gemini API (GEMINI_API_KEY) — final fallback
 *
 * If every model fails, the client throws a clear error naming the role.
 */
const GEMINI_PROXY: ModelSpec[] = [
  { provider: 'gemini', model: 'gemini-3.7-flash' },
  { provider: 'gemini', model: 'gemini-3.6-flash' },
];

const NARA_FREE: ModelSpec[] = [
  { provider: 'nara', model: 'agnes-3-flash' },
  { provider: 'nara', model: 'agnes-2.5-flash' },
  { provider: 'nara', model: 'nemotron-3-ultra-free' },
  { provider: 'nara', model: 'jev' },
  { provider: 'nara', model: 'nemotron-3-super-free' },
  { provider: 'nara', model: 'nemotron-3.5-lightning-free' },
  { provider: 'nara', model: 'ling-3.0-flash-sante-free' },
  { provider: 'nara', model: 'ling-3.0-flash-fin-free' },
  { provider: 'nara', model: 'space-bunny-alpha' },
];

const GEMINI_OFFICIAL: ModelSpec[] = [
  { provider: 'gemini-official', model: 'gemini-3.8-flash' },
  { provider: 'gemini-official', model: 'gemini-3-flash-preview' },
];

const FULL_CHAIN: ModelSpec[] = [...GEMINI_PROXY, ...NARA_FREE, ...GEMINI_OFFICIAL];

export const ROLE_MODELS: Record<AgentRole, ModelSpec[]> = {
  planner: FULL_CHAIN,
  queryScout: FULL_CHAIN,
  sourcePicker: FULL_CHAIN,
  extractor: FULL_CHAIN,
  factCheck: FULL_CHAIN,
  dataJudge: FULL_CHAIN,
  story: FULL_CHAIN,
  video: FULL_CHAIN,
  qa: FULL_CHAIN,
};
export interface AIClient {
  /** Names of the configured providers, for logging and the health endpoint. */
  readonly providerName: string;
  complete(req: AIRequest, model?: string): Promise<AIResponse>;
  completeJson<T>(req: AIRequest, schema: SchemaName, model?: string): Promise<T>;
  /** Run a request on the model chosen for a role, with cross-provider fallback. */
  completeRole(role: AgentRole, req: AIRequest): Promise<AIResponse>;
  completeJsonRole<T>(role: AgentRole, req: AIRequest, schema: SchemaName): Promise<T>;
}

const JSON_INSTRUCTION =
  'CRITICAL OUTPUT RULE: reply with a single valid JSON document and nothing else. No prose, no markdown fences, no commentary.';

export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : trimmed;
  const start = body.search(/[[{]/);
  if (start < 0) throw new AIError('response contained no JSON');
  const opener = body[start];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) return JSON.parse(body.slice(start, i + 1));
    }
  }
  throw new AIError('unterminated JSON in model response');
}

/** Repair-aware JSON call used by every agent. */
async function jsonWithRepair<T>(
  run: (req: AIRequest) => Promise<AIResponse>,
  req: AIRequest,
  schema: SchemaName,
): Promise<T> {
  const withInstruction: AIRequest = { ...req, prompt: `${req.prompt}\n\n${JSON_INSTRUCTION}` };
  let lastErrors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await run(
      attempt === 0
        ? withInstruction
        : {
            ...withInstruction,
            prompt: `${withInstruction.prompt}\n\nYour previous reply was rejected by the schema validator:\n${lastErrors.join('\n')}\nReturn corrected JSON only.`,
          },
    );
    let parsed: unknown;
    try {
      parsed = extractJson(response.text);
    } catch (error) {
      lastErrors = [error instanceof Error ? error.message : 'unparsable JSON'];
      continue;
    }
    const check = validate(schema, parsed);
    if (check.valid) return parsed as T;
    lastErrors = check.errors;
  }
  throw new AIError(`model output failed ${schema} validation: ${lastErrors.join('; ')}`);
}

export interface AIClientOptions {
  cacheRoot?: string;
  provider?: AIProvider;
  /** Overrides for tests; merged over the environment-derived providers. */
  providers?: Partial<Record<ModelProvider, AIProvider>>;
}

class RoutingClient implements AIClient {
  constructor(
    private readonly providers: Partial<Record<ModelProvider, AIProvider>>,
    private readonly fallback: AIProvider,
  ) {}

  get providerName(): string {
    const names = Object.entries(this.providers).filter(([, p]) => p).map(([name]) => name);
    return names.length > 0 ? names.join('+') : this.fallback.name;
  }

  private providerFor(provider: ModelProvider): AIProvider | undefined {
    return this.providers[provider];
  }

  private async run(spec: ModelSpec, req: AIRequest): Promise<AIResponse> {
    const provider = this.providerFor(spec.provider);
    if (!provider) throw new AIError(`${spec.provider} provider is not configured`);
    if (provider instanceof GeminiProxyProvider) return provider.generateWithModel(spec.model, req);
    if (provider instanceof OpenAICompatProvider) return provider.generateWithModel(spec.model, req);
    if (provider instanceof GeminiOfficialProvider) return provider.generateWithModel(spec.model, req);
    return provider.generate(req);
  }

  complete(req: AIRequest, model?: string): Promise<AIResponse> {
    if (model && model.includes(':')) {
      const [provider, name] = model.split(':', 2);
      return this.run({ provider: provider as ModelProvider, model: name }, req);
    }
    if (this.providers.gemini) return this.run({ provider: 'gemini', model: model ?? 'gemini-3.7-flash' }, req);
    if (this.providers.nara) return this.run({ provider: 'nara', model: model ?? 'gemini-3.8-flash-high' }, req);
    return this.fallback.generate(req);
  }

  completeJson<T>(req: AIRequest, schema: SchemaName, model?: string): Promise<T> {
    return jsonWithRepair<T>((r) => this.complete(r, model), req, schema);
  }

  async completeRole(role: AgentRole, req: AIRequest): Promise<AIResponse> {
    const chain = ROLE_MODELS[role];
    let lastError: unknown = null;
    for (const spec of chain) {
      if (!this.providerFor(spec.provider)) continue;
      try {
        const response = await this.run(spec, req);
        logger.debug('role served', { role, provider: spec.provider, model: spec.model });
        return response;
      } catch (error) {
        lastError = error;
        logger.warn('role model failed, trying the next one', { role, model: spec.model, error: String(error) });
      }
    }
    if (!this.fallback) {
      throw lastError instanceof Error ? lastError : new AIError(`no model available for role ${role}`);
    }
    return this.fallback.generate(req);
  }

  completeJsonRole<T>(role: AgentRole, req: AIRequest, schema: SchemaName): Promise<T> {
    return jsonWithRepair<T>((r) => this.completeRole(role, r), req, schema);
  }
}

/**
 * Build the default AI client.
 *
 * Providers are assembled from the environment; a routing client then picks the
 * best available model per role (see `ROLE_MODELS`).
 */
export function createAIClient(options: AIClientOptions = {}): AIClient {
  if (options.provider) return new RoutingClient({}, options.provider);

  const workers = envList('GEMINI_WORKER_1').concat(envList('GEMINI_WORKER_2')).filter(Boolean);
  const models = envList('GEMINI_MODELS', ['gemini-3.7-flash', 'gemini-3.6-flash']);
  const providers: Partial<Record<ModelProvider, AIProvider>> = { ...(options.providers ?? {}) };

  if (!providers.gemini && workers.length > 0) {
    providers.gemini = new GeminiProxyProvider({ workers, models, cacheRoot: options.cacheRoot });
  }
  if (!providers.nara) {
    const naraKey = env('NARA_API_KEY');
    if (naraKey) {
      providers.nara = new OpenAICompatProvider({
        baseUrl: env('NARA_BASE_URL', 'https://router.bynara.id/v1'),
        apiKey: naraKey,
        models: envList('NARA_MODELS', ['nex-n2.5-pro']),
        label: 'nara',
        cacheRoot: options.cacheRoot,
      });
    } else {
      logger.warn('NARA_API_KEY is not set; the Nara reasoning models are unavailable');
    }
  }
  if (!providers['gemini-official']) {
    const geminiKey = env('GEMINI_API_KEY');
    if (geminiKey) {
      providers['gemini-official'] = new GeminiOfficialProvider({ apiKey: geminiKey, cacheRoot: options.cacheRoot });
    } else {
      logger.warn('GEMINI_API_KEY is not set; the official Gemini API fallback is unavailable');
    }
  }

  const fallback = new MockProvider(() =>
    JSON.stringify({ note: 'mock provider: configure GEMINI_WORKER_1 or NARA_API_KEY for real models' }),
  );
  const client = new RoutingClient(providers, fallback);
  logger.info('ai providers ready', { providers: client.providerName });
  return client;
}

/**
 * A Nara call needs an explicit model, so the OpenAI-compatible adapter stores
 * its primary model. Roles that name a different Nara model are routed through
 * `completeRole`, which builds a per-model request.
 */
export const NARA_REASONING_MODELS = [
  'claude-opus-5',
  'gemini-3.1-pro-high',
  'nex-n2.5-pro',
  'gemini-3.8-flash-high',
  'agnes-3-flash',
] as const;