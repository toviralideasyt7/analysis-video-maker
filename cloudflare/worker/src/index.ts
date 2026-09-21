/**
 * Control plane for the video pipeline.
 *
 * Cloudflare free tier only: a Worker for the API, D1 for the durable job
 * record, KV for sessions. No R2 - finished videos live on gofile.io and the
 * Worker only stores the link.
 *
 * Routes
 *   POST /api/login                  {password} -> session cookie
 *   POST /api/logout
 *   GET  /api/me
 *   POST /api/jobs                   {topic, dataUrl?, layout?, topN?, targetMinutes?}
 *   GET  /api/jobs                   newest first, with a compact event trail
 *   GET  /api/jobs/:id
 *   POST /api/hooks/render-complete  internal: the workflow reports the gofile link
 *   GET  /api/health
 *
 * Flow: the browser posts a topic, the Worker records the job in D1 and
 * dispatches research.yml on GitHub with the job id. The workflow researches,
 * renders, uploads the MP4 to gofile.io, then calls render-complete, so a page
 * refresh at any point rebuilds the whole view from D1.
 */

export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  RESEARCH_WORKFLOW: string;
  ALLOWED_ORIGIN: string;
  GH_TOKEN?: string;
  HOOK_SECRET?: string;
  APP_PASSWORD?: string;
}

/**
 * Default gate password. Move it to a Worker secret
 * (`wrangler secret put APP_PASSWORD`) so it stops living in the repository.
 */
const DEFAULT_PASSWORD = 'BloggingJi@7';
const SESSION_COOKIE = 'avm_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

const now = (): string => new Date().toISOString();

function corsHeaders(env: Env, request: Request): Record<string, string> {
  const origin = request.headers.get('origin') ?? '';
  const allowed = env.ALLOWED_ORIGIN === '*' ? origin || '*' : env.ALLOWED_ORIGIN;
  return {
    'access-control-allow-origin': allowed,
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'content-type, x-hook-secret',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    vary: 'origin',
  };
}

function json(data: unknown, status: number, env: Env, request: Request): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(env, request) },
  });
}

/** Compare without leaking length or position through timing. */
function safeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

async function currentSession(env: Env, request: Request): Promise<string | null> {
  const token = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
  if (!token) return null;
  const found = await env.SESSIONS.get(`session:${token}`);
  return found ? token : null;
}

async function createSession(env: Env, request: Request): Promise<string> {
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const expires = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await env.SESSIONS.put(`session:${token}`, now(), { expirationTtl: SESSION_TTL_SECONDS });
  await env.DB.prepare('INSERT OR REPLACE INTO sessions (token, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?)')
    .bind(token, now(), expires, request.headers.get('user-agent') ?? '')
    .run();
  return token;
}

async function logEvent(env: Env, jobId: string, kind: string, detail?: string): Promise<void> {
  await env.DB.prepare('INSERT INTO events (job_id, at, kind, detail) VALUES (?, ?, ?, ?)')
    .bind(jobId, now(), kind, detail ?? null)
    .run();
}

async function dispatchResearch(env: Env, job: { id: string; topic: string; dataUrl: string | null; layout: string | null; topN: number | null; targetMinutes: number | null }, request: Request): Promise<{ ok: boolean; error?: string }> {
  if (!env.GH_TOKEN) return { ok: false, error: 'GH_TOKEN is not configured on the Worker' };
  const workflow = env.RESEARCH_WORKFLOW || 'research.yml';
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`;
  const origin = new URL(request.url).origin;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'avm-control',
    },
    body: JSON.stringify({
      ref: env.GITHUB_BRANCH || 'main',
      inputs: {
        topic: job.topic,
        dataUrl: job.dataUrl ?? '',
        topN: String(job.topN ?? 12),
        jobId: job.id,
        layout: job.layout ?? 'auto',
        targetMinutes: String(job.targetMinutes ?? 10),
        callbackUrl: `${origin}/api/hooks/render-complete`,
      },
    }),
  });
  if (response.status === 204) return { ok: true };
  const text = await response.text();
  return { ok: false, error: `GitHub dispatch returned ${response.status}: ${text.slice(0, 240)}` };
}

async function handleJobs(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as
    | { topic?: string; dataUrl?: string; layout?: string; topN?: number; targetMinutes?: number }
    | null;
  const topic = (body?.topic ?? '').trim();
  if (!topic) return json({ error: 'topic is required' }, 400, env, request);

  const layout = ['auto', 'standard', 'dense', 'focus'].includes(body?.layout ?? 'auto') ? (body?.layout ?? 'auto') : 'auto';
  const topN = Number.isFinite(body?.topN) ? Math.max(3, Math.min(20, Number(body?.topN))) : 12;
  const targetMinutes = Number.isFinite(body?.targetMinutes) ? Math.max(1, Math.min(30, Number(body?.targetMinutes))) : 10;

  const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await env.DB.prepare(
    'INSERT INTO jobs (id, topic, data_url, layout, top_n, target_minutes, status, stage, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, topic, body?.dataUrl?.trim() || null, layout, topN, targetMinutes, 'queued', 'queued', now(), now())
    .run();
  await logEvent(env, id, 'created', `topic=${topic}`);

  const dispatched = await dispatchResearch(env, { id, topic, dataUrl: body?.dataUrl?.trim() || null, layout, topN, targetMinutes }, request);
  if (!dispatched.ok) {
    await env.DB.prepare('UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?')
      .bind('failed', dispatched.error ?? 'dispatch failed', now(), id)
      .run();
    await logEvent(env, id, 'dispatch_failed', dispatched.error);
    return json({ error: dispatched.error, id }, 502, env, request);
  }

  await env.DB.prepare('UPDATE jobs SET status = ?, stage = ?, updated_at = ? WHERE id = ?')
    .bind('researching', 'dispatched to GitHub', now(), id)
    .run();
  await logEvent(env, id, 'dispatched', 'research workflow started');
  return json({ ok: true, id }, 201, env, request);
}

async function listJobs(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') ?? 25)));
  const jobs = await env.DB.prepare(
    'SELECT id, topic, status, stage, video_url, error, created_at, updated_at FROM jobs ORDER BY created_at DESC LIMIT ?',
  )
    .bind(limit)
    .all<Record<string, unknown>>();
  const ids = (jobs.results ?? []).map((row) => String(row.id));
  let events: Array<Record<string, unknown>> = [];
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const found = await env.DB.prepare(
      `SELECT job_id, at, kind, detail FROM events WHERE job_id IN (${placeholders}) ORDER BY id DESC LIMIT 200`,
    )
      .bind(...ids)
      .all<Record<string, unknown>>();
    events = found.results ?? [];
  }
  const grouped: Record<string, Array<Record<string, unknown>>> = {};
  for (const event of events) {
    const key = String(event.job_id);
    grouped[key] = grouped[key] ?? [];
    if (grouped[key].length < 5) grouped[key].push(event);
  }
  return json({ jobs: (jobs.results ?? []).map((job) => ({ ...job, events: grouped[String(job.id)] ?? [] })) }, 200, env, request);
}

async function getJob(id: string, request: Request, env: Env): Promise<Response> {
  const job = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!job) return json({ error: 'unknown job' }, 404, env, request);
  const events = await env.DB.prepare('SELECT at, kind, detail FROM events WHERE job_id = ? ORDER BY id ASC LIMIT 100')
    .bind(id)
    .all<Record<string, unknown>>();
  return json({ job, events: events.results ?? [] }, 200, env, request);
}

async function renderComplete(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get('x-hook-secret') ?? '';
  if (!env.HOOK_SECRET || !safeEqual(secret, env.HOOK_SECRET)) {
    return json({ error: 'bad hook secret' }, 401, env, request);
  }
  const body = (await request.json().catch(() => null)) as
    | { jobId?: string; videoUrl?: string; stage?: string; status?: string; probe?: unknown; inputPath?: string; runUrl?: string; error?: string }
    | null;
  const jobId = (body?.jobId ?? '').trim();
  if (!jobId) return json({ error: 'jobId is required' }, 400, env, request);

  const status = body?.status ?? (body?.videoUrl ? 'done' : 'failed');
  await env.DB.prepare(
    'UPDATE jobs SET status = ?, stage = ?, video_url = COALESCE(?, video_url), input_path = COALESCE(?, input_path), github_run_url = COALESCE(?, github_run_url), probe_json = COALESCE(?, probe_json), error = ?, updated_at = ? WHERE id = ?',
  )
    .bind(
      status,
      body?.stage ?? status,
      body?.videoUrl ?? null,
      body?.inputPath ?? null,
      body?.runUrl ?? null,
      body?.probe ? JSON.stringify(body.probe) : null,
      body?.error ?? null,
      now(),
      jobId,
    )
    .run();
  await logEvent(env, jobId, status, body?.videoUrl ?? body?.stage ?? body?.error ?? undefined);
  return json({ ok: true }, 200, env, request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env, request) });

    if (url.pathname === '/api/health') {
      return json({ ok: true, repo: `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`, github: Boolean(env.GH_TOKEN), at: now() }, 200, env, request);
    }

    if (url.pathname === '/api/login' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as { password?: string } | null;
      const expected = env.APP_PASSWORD || DEFAULT_PASSWORD;
      if (!body?.password || !safeEqual(body.password, expected)) {
        return json({ error: 'wrong password' }, 401, env, request);
      }
      const token = await createSession(env, request);
      const response = json({ ok: true }, 200, env, request);
      response.headers.append(
        'set-cookie',
        `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${SESSION_TTL_SECONDS}`,
      );
      return response;
    }

    if (url.pathname === '/api/hooks/render-complete' && request.method === 'POST') {
      return renderComplete(request, env);
    }

    if (url.pathname.startsWith('/api/')) {
      const session = await currentSession(env, request);
      if (!session) return json({ error: 'not signed in' }, 401, env, request);

      if (url.pathname === '/api/me') return json({ ok: true, signedIn: true }, 200, env, request);
      if (url.pathname === '/api/logout' && request.method === 'POST') {
        const token = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
        if (token) await env.SESSIONS.delete(`session:${token}`);
        const response = json({ ok: true }, 200, env, request);
        response.headers.append('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0`);
        return response;
      }
      if (url.pathname === '/api/jobs' && request.method === 'POST') return handleJobs(request, env);
      if (url.pathname === '/api/jobs' && request.method === 'GET') return listJobs(request, env);
      const match = /^\/api\/jobs\/([A-Za-z0-9_]+)$/.exec(url.pathname);
      if (match && request.method === 'GET') return getJob(match[1], request, env);
    }

    return json({ error: 'not found' }, 404, env, request);
  },
};
