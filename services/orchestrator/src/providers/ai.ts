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
          fetch(`${worker.replace(/\/$/, '')}/v1/chat/completions`, {
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
    const model = this.config.models[0];
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
      fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify({ model, messages, ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}) }),
      }),
    );
    const text = await response.text();
    if (!response.ok) {
      this.usage.append({ at: new Date().toISOString(), provider: this.name, model, operation: 'generate', ok: false, durationMs: Date.now() - started, status: response.status });
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

export interface AIClient {
  readonly providerName: string;
  complete(req: AIRequest, model?: string): Promise<AIResponse>;
  completeJson<T>(req: AIRequest, schema: SchemaName, model?: string): Promise<T>;
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
      if (depth === 0) {
        return JSON.parse(body.slice(start, i + 1));
      }
    }
  }
  throw new AIError('unterminated JSON in model response');
}

class FacadeClient implements AIClient {
  constructor(private readonly provider: AIProvider) {}

  get providerName(): string {
    return this.provider.name;
  }

  complete(req: AIRequest, model?: string): Promise<AIResponse> {
    if (model && this.provider instanceof GeminiProxyProvider) {
      return this.provider.generateWithModel(model, req);
    }
    return this.provider.generate(req);
  }

  async completeJson<T>(req: AIRequest, schema: SchemaName, model?: string): Promise<T> {
    const withInstruction: AIRequest = {
      ...req,
      prompt: `${req.prompt}\n\n${JSON_INSTRUCTION}`,
    };
    let lastErrors: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.complete(
        attempt === 0
          ? withInstruction
          : {
              ...withInstruction,
              prompt: `${withInstruction.prompt}\n\nYour previous reply was rejected by the schema validator:\n${lastErrors.join('\n')}\nReturn corrected JSON only.`,
            },
        model,
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
}

export interface AIClientOptions {
  cacheRoot?: string;
  provider?: AIProvider;
}

/**
 * Build the default AI client:
 *   1. Gemini web-proxy workers (keyless, primary);
 *   2. Nara router (if a key is present);
 *   3. a mock provider so the pipeline can still be exercised offline.
 */
export function createAIClient(options: AIClientOptions = {}): AIClient {
  if (options.provider) return new FacadeClient(options.provider);

  const workers = envList('GEMINI_WORKER_1')
    .concat(envList('GEMINI_WORKER_2'))
    .filter(Boolean);
  const models = envList('GEMINI_MODELS', ['gemini-3.7-flash', 'gemini-3.6-flash']);

  if (workers.length > 0) {
    return new FacadeClient(new GeminiProxyProvider({ workers, models, cacheRoot: options.cacheRoot }));
  }

  const naraKey = env('NARA_API_KEY');
  if (naraKey) {
    return new FacadeClient(
      new OpenAICompatProvider({
        baseUrl: env('NARA_BASE_URL', 'https://router.bynara.id/v1'),
        apiKey: naraKey,
        models: envList('NARA_MODELS', ['nex-n2.5-pro']),
        label: 'nara',
        cacheRoot: options.cacheRoot,
      }),
    );
  }

  logger.warn('no AI provider configured; falling back to the mock provider');
  return new FacadeClient(
    new MockProvider(() => JSON.stringify({ note: 'mock provider: configure GEMINI_WORKER_1 to use a real model' })),
  );
}

/** Models recommended for each job, from the tested worker notes. */
export const MODEL_ROLES = {
  planner: 'gemini-3.7-flash',
  research: 'gemini-3.7-flash',
  classification: 'gemini-3.6-flash',
  factCheck: 'gemini-3.6-flash',
  dataJudge: 'gemini-3.5-flash-thinking',
  story: 'gemini-3.7-flash',
  video: 'gemini-3.7-flash',
  qa: 'gemini-3.6-flash',
} as const;