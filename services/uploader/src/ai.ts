/**
 * Minimal AI client for the research agent (runs inside GitHub Actions).
 * Roles route to the working models first; failures fall through the chain.
 */

import { env } from './runtime';

export interface AIRequest {
  system?: string;
  prompt: string;
  maxTokens?: number;
}

export interface AIResponse {
  text: string;
  provider: string;
  model: string;
}

export class AIError extends Error {}

export type AgentRole = 'planner' | 'extractor' | 'story';

const NARA = 'https://router.bynara.id/v1';

const ROLE_MODELS: Record<AgentRole, Array<{ provider: 'nara' | 'gemini'; model: string }>> = {
  planner: [
    { provider: 'nara', model: 'nex-n2.5-pro' },
    { provider: 'gemini', model: 'gemini-3.7-flash' },
  ],
  extractor: [
    { provider: 'nara', model: 'nex-n2.5-pro' },
    { provider: 'gemini', model: 'gemini-3.6-flash' },
  ],
  story: [
    { provider: 'gemini', model: 'gemini-3.7-flash' },
    { provider: 'nara', model: 'nex-n2.5-pro' },
  ],
};

function usable(key: string): boolean {
  return key.length > 20 && !key.includes('…') && !key.includes('...');
}

async function callNara(model: string, req: AIRequest): Promise<AIResponse> {
  const key = env('NARA_API_KEY');
  if (!usable(key)) throw new AIError('NARA_API_KEY missing or masked');
  const response = await fetch(`${NARA}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        ...(req.system ? [{ role: 'system', content: req.system }] : []),
        { role: 'user', content: req.prompt },
      ],
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
    }),
  });
  if (!response.ok) throw new AIError(`nara ${response.status}`);
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return { text: body.choices?.[0]?.message?.content ?? '', provider: 'nara', model };
}

async function callGemini(model: string, req: AIRequest): Promise<AIResponse> {
  const workers = [env('GEMINI_WORKER_1'), env('GEMINI_WORKER_2')].filter(Boolean);
  if (workers.length === 0) throw new AIError('no gemini worker configured');
  let lastError: unknown = null;
  for (const worker of workers) {
    try {
      const response = await fetch(`${worker.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            ...(req.system ? [{ role: 'system', content: req.system }] : []),
            { role: 'user', content: req.prompt },
          ],
          ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        }),
      });
      if (!response.ok) {
        lastError = new AIError(`gemini ${response.status}`);
        continue;
      }
      const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return { text: body.choices?.[0]?.message?.content ?? '', provider: 'gemini', model };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new AIError('gemini failed');
}

export interface AIClient {
  completeRole(role: AgentRole, req: AIRequest): Promise<AIResponse>;
  /** completeRole + JSON extraction + one repair retry. Schema-agnostic. */
  completeJsonRole<T>(role: AgentRole, req: AIRequest): Promise<T>;
}

export function createAIClient(): AIClient {
  const raw = async (role: AgentRole, req: AIRequest): Promise<AIResponse> => {
    let lastError: unknown = null;
    for (const spec of ROLE_MODELS[role]) {
      try {
        return spec.provider === 'nara' ? await callNara(spec.model, req) : await callGemini(spec.model, req);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new AIError(`no model for role ${role}`);
  };

  return {
    completeRole: (role: AgentRole, req: AIRequest) => raw(role, req),
    async completeJsonRole<T>(role: AgentRole, req: AIRequest): Promise<T> {
      const instruction = `${req.prompt}\n\nCRITICAL OUTPUT RULE: reply with a single valid JSON document and nothing else.`;
      let lastErrors = '';
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await raw(role, attempt === 0 ? { ...req, prompt: instruction } : { ...req, prompt: `${instruction}\n\nPrevious reply was invalid JSON or wrong shape: ${lastErrors}. Return corrected JSON only.` });
        try {
          return extractJson(response.text) as T;
        } catch (error) {
          lastErrors = error instanceof Error ? error.message : String(error);
        }
      }
      throw new AIError(`JSON extraction failed: ${lastErrors}`);
    },
  };
}
/** Pull the first balanced JSON object/array out of a model reply. */
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
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
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
