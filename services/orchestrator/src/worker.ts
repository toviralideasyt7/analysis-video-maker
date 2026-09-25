/**
 * Cloudflare Workers entry point for the orchestrator API.
 *
 * Adapts the Hono app for Workers: KV for project storage, R2 for videos.
 * Research endpoints work via fetch (AI providers, search).
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { KVProjectStore, type KVNamespaceLike, type WorkerLimits } from './kv-store';

interface Env {
  PROJECTS_KV: KVNamespaceLike;
  VIDEOS_BUCKET?: {
    list(opts?: { prefix?: string }): Promise<{ objects: Array<{ key: string; size: number; uploaded: Date }> }>;
    get(key: string, opts?: { range?: { offset: number; length: number } }): Promise<{
      body: ReadableStream;
      size: number;
    } | null>;
  };
  ALLOWED_ORIGINS?: string;
  PAGES_ORIGIN?: string;
  // AI provider config (set as worker secrets/vars)
  NARA_API_KEY?: string;
  NARA_BASE_URL?: string;
  MONID_API_KEY?: string;
  GEMINI_WORKER_1?: string;
  GEMINI_WORKER_2?: string;
  GEMINI_MODELS?: string;
  GITHUB_OWNER?: string;
  GITHUB_REPO?: string;
  GITHUB_TOKEN?: string;
  // Password gate: when set, all /api/* routes (except /api/health and
  // /api/login) require a session token from POST /api/login.
  APP_PASSWORD?: string;
  // Shared secret the render-video workflow uses to report completion.
  HOOK_SECRET?: string;
}

function getLimits(env: Env): WorkerLimits {
  return {
    maxSearches: 60,
    maxSources: 40,
    maxAgentRounds: 12,
    maxTokens: 400000,
    maxRenderAttempts: 2,
  };
}

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({
  origin: (origin, c) => {
    const allowed = (c.env.ALLOWED_ORIGINS ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
    if (allowed.length === 0) return origin; // allow all if not configured
    return allowed.includes(origin) ? origin : allowed[0];
  },
  allowHeaders: ['Content-Type', 'Authorization'],
}));

app.get('/api/health', (c) =>
  c.json({ ok: true, at: new Date().toISOString(), worker: true })
);

// --- Password gate -------------------------------------------------
// Restores the password protection the original studio had: the frontend
// shows a password screen, POSTs to /api/login, and sends the returned
// session token as `Authorization: Bearer <token>` (or `?token=` for
// <video> tags, which cannot set headers). Sessions live in the same KV
// namespace under `session:` keys, isolated from `project:` keys.

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function sessionKey(token: string): string {
  return `session:${token}`;
}

function extractToken(c: { req: { header(name: string): string | undefined; query(name: string): string | undefined } }): string | null {
  const auth = c.req.header('Authorization') ?? c.req.header('authorization');
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim() || null;
  const q = c.req.query('token');
  return q ? q.trim() || null : null;
}

async function validSession(env: Env, token: string | null): Promise<boolean> {
  if (!token) return false;
  try {
    const raw = await env.PROJECTS_KV.get(sessionKey(token));
    if (!raw) return false;
    const sess = JSON.parse(raw) as { expiresAt?: number };
    if (!sess.expiresAt || sess.expiresAt < Date.now()) {
      await env.PROJECTS_KV.delete(sessionKey(token)).catch(() => undefined);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

app.post('/api/login', async (c) => {
  const expected = c.env.APP_PASSWORD;
  if (!expected) {
    return c.json({ error: 'Password protection is not configured on the server (APP_PASSWORD secret missing)' }, 503);
  }
  const body = (await c.req.json().catch(() => ({}))) as { password?: string };
  if (typeof body.password !== 'string' || body.password !== expected) {
    return c.json({ error: 'Wrong password' }, 401);
  }
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  await c.env.PROJECTS_KV.put(sessionKey(token), JSON.stringify({ createdAt: new Date().toISOString(), expiresAt }));
  return c.json({ ok: true, token, expiresAt: new Date(expiresAt).toISOString() });
});

app.post('/api/logout', async (c) => {
  const token = extractToken(c);
  if (token) await c.env.PROJECTS_KV.delete(sessionKey(token)).catch(() => undefined);
  return c.json({ ok: true });
});

// Everything under /api/* needs a session, except the health check, the
// login itself, and the CI hook (which carries its own secret).
const PUBLIC_API_PATHS = new Set(['/api/health', '/api/login']);
app.use('/api/*', async (c, next) => {
  const path = c.req.path;
  if (PUBLIC_API_PATHS.has(path) || path.startsWith('/api/hooks/')) return next();
  if (await validSession(c.env, extractToken(c))) return next();
  return c.json({ error: 'Unauthorized — please log in' }, 401);
});

// --- Render completion hook ----------------------------------------
// Called by the render-video workflow (if: always()) when a render
// finishes, so projects stop showing RENDERING forever. Authenticated
// with the HOOK_SECRET shared secret, not a user session.
app.post('/api/hooks/render-complete', async (c) => {
  const expected = c.env.HOOK_SECRET;
  if (!expected) return c.json({ error: 'hook not configured' }, 503);
  const given = c.req.header('x-hook-secret') ?? '';
  if (given !== expected) return c.json({ error: 'bad hook secret' }, 403);
  const body = (await c.req.json().catch(() => ({}))) as {
    projectId?: string; status?: string; runId?: number | null; assetName?: string; artifactUrl?: string; error?: string;
  };
  if (!body.projectId) return c.json({ error: 'projectId is required' }, 400);
  const store = new KVProjectStore(c.env.PROJECTS_KV);
  let project;
  try {
    project = await store.load(body.projectId);
  } catch {
    return c.json({ error: 'project not found' }, 404);
  }
  const succeeded = body.status === 'success';
  project.status = succeeded ? 'COMPLETED' : 'FAILED';
  project.updatedAt = new Date().toISOString();
  const prevJob = (project.renderJob ?? {}) as Record<string, unknown>;
  // Prefer the direct temp-host URL the workflow reports (plays straight in
  // the <video> tag with zero worker proxying); fall back to the release
  // proxy path when the workflow only sent an asset name.
  const directUrl = typeof body.artifactUrl === 'string' && /^https?:\/\//i.test(body.artifactUrl.trim())
    ? body.artifactUrl.trim()
    : null;
  project.renderJob = {
    ...prevJob,
    status: succeeded ? 'completed' : 'failed',
    githubRunId: body.runId ?? prevJob.githubRunId ?? null,
    artifactUrl: succeeded
      ? (directUrl ?? (body.assetName ? `/api/renders/file/${encodeURIComponent(body.assetName)}` : prevJob.artifactUrl ?? null))
      : prevJob.artifactUrl ?? null,
    notes: [...((prevJob.notes as string[] | undefined) ?? []), body.error ?? (succeeded ? 'Render completed' : 'Render workflow failed')],
  };
  await store.save(project);
  return c.json({ ok: true, projectId: project.projectId, status: project.status });
});

// --- Projects (KV-backed) ---

app.post('/api/projects', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { topic?: string; title?: string };
  if (!body.topic) return c.json({ error: 'topic is required' }, 400);
  const store = new KVProjectStore(c.env.PROJECTS_KV);
  const state = await store.create(body.topic, getLimits(c.env), body.title);
  return c.json({ project: state }, 201);
});

app.get('/api/projects', async (c) => {
  const store = new KVProjectStore(c.env.PROJECTS_KV);
  const states = await store.list();
  const projects = states.map((s) => ({
    projectId: s.projectId,
    title: s.title,
    topic: s.topic,
    status: s.status,
    updatedAt: s.updatedAt,
  }));
  return c.json({ projects });
});

app.get('/api/projects/:id', async (c) => {
  const store = new KVProjectStore(c.env.PROJECTS_KV);
  try {
    const project = await store.load(c.req.param('id'));
    return c.json({ project });
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
});

app.delete('/api/projects/:id', async (c) => {
  const store = new KVProjectStore(c.env.PROJECTS_KV);
  const id = c.req.param('id');
  try {
    await store.load(id);
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
  await store.remove(id);
  return c.json({ ok: true, deleted: id });
});

// --- Renders ---
// Videos are published as GitHub release assets by the render-video workflow.
// The worker lists them via the GitHub API so new renders appear automatically.

async function listReleaseVideos(env: Env, directByAsset: Map<string, string> = new Map()): Promise<Array<{ filename: string; title: string; sizeBytes: number; createdAt: string; url: string }>> {
  const owner = env.GITHUB_OWNER ?? 'toviralideasyt7';
  const repo = env.GITHUB_REPO ?? 'analysis-video-maker';
  const token = env.GITHUB_TOKEN;
  if (!token) return [];
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/tags/videos-20260922`, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'avm-orchestrator-worker',
      },
    });
    if (!res.ok) return [];
    const release = await res.json() as { assets?: Array<{ name: string; size: number; created_at: string; browser_download_url: string }> };
    const assets = release.assets ?? [];
    return assets
      .filter((a) => a.name.toLowerCase().endsWith('.mp4'))
      .map((a) => ({
        filename: a.name,
        title: a.name.replace(/\.mp4$/i, '').replace(/[-_]/g, ' '),
        sizeBytes: a.size,
        createdAt: a.created_at,
        // Serve through the worker proxy below: the repo is private so the
        // raw browser_download_url 404s for browsers without a GitHub login.
        // When the project reported a direct temp-host URL, use it instead —
        // zero worker proxying, effectively unlimited watching.
        url: directByAsset.get(a.name) ?? `/api/renders/file/${encodeURIComponent(a.name)}`,
      }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  } catch {
    return [];
  }
}

app.get('/api/renders', async (c) => {
  const bucket = c.env.VIDEOS_BUCKET;
  if (bucket) {
    const listed = await bucket.list({ prefix: 'renders/' });
    const renders = listed.objects
      .filter((o) => o.key.toLowerCase().endsWith('.mp4'))
      .map((o) => {
        const filename = o.key.replace(/^renders\//, '');
        return {
          filename,
          title: filename.replace(/\.mp4$/i, '').replace(/[-_]/g, ' '),
          sizeBytes: o.size,
          createdAt: o.uploaded.toISOString(),
          url: `/api/renders/file/${encodeURIComponent(filename)}`,
        };
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return c.json({ renders });
  }
  // Fallback: list videos from the GitHub release.
  // Prefer each project's direct temp-host URL when the workflow reported
  // one: the <video> tag then streams straight from the file host with zero
  // worker proxying (unlimited watching). Release proxy stays as fallback.
  const store = new KVProjectStore(c.env.PROJECTS_KV);
  const directByAsset = new Map<string, string>();
  try {
    const projects = await store.list();
    for (const p of projects) {
      const job = (p.renderJob ?? {}) as Record<string, unknown>;
      const url = typeof job.artifactUrl === 'string' ? job.artifactUrl : '';
      if (p.status === 'COMPLETED' && /^https?:\/\//i.test(url)) {
        directByAsset.set(`${p.projectId}-final.mp4`, url);
      }
    }
  } catch { /* listing projects is best-effort here */ }
  const renders = await listReleaseVideos(c.env, directByAsset);
  return c.json({ renders });
});

// Streams a release asset through the worker. Needed because the repo is
// private: the raw browser_download_url 404s for any browser that isn't
// logged into GitHub as the repo owner. Range requests are honored (by
// slicing when upstream doesn't) so in-browser video seeking keeps working.
async function proxyReleaseAsset(env: Env, filename: string, range: string | undefined): Promise<Response> {
  const notFound = () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  const owner = env.GITHUB_OWNER ?? 'toviralideasyt7';
  const repo = env.GITHUB_REPO ?? 'analysis-video-maker';
  const token = env.GITHUB_TOKEN;
  if (!token) return notFound();
  const apiHeaders = {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${token}`,
    'User-Agent': 'avm-orchestrator-worker',
  };
  let release: { assets?: Array<{ name: string; size: number; url: string }> };
  try {
    const relRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases/tags/videos-20260922`, { headers: apiHeaders });
    if (!relRes.ok) return notFound();
    release = await relRes.json();
  } catch {
    return notFound();
  }
  const asset = (release.assets ?? []).find((a) => a.name === filename);
  if (!asset) return notFound();

  const dlHeaders: Record<string, string> = {
    'Accept': 'application/octet-stream',
    'Authorization': `Bearer ${token}`,
    'User-Agent': 'avm-orchestrator-worker',
  };
  if (range) dlHeaders['Range'] = range;
  let dl: Response;
  try {
    dl = await fetch(asset.url, { headers: dlHeaders });
  } catch {
    return notFound();
  }
  if (!dl.ok || !dl.body) return notFound();

  const outHeaders: Record<string, string> = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
  };
  if (dl.status === 206) {
    for (const h of ['Content-Length', 'Content-Range']) {
      const v = dl.headers.get(h);
      if (v) outHeaders[h] = v;
    }
    return new Response(dl.body, { status: 206, headers: outHeaders });
  }
  if (range) {
    // Upstream ignored the range: slice the bytes ourselves.
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const buf = await dl.arrayBuffer();
    const size = buf.byteLength;
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size) {
      return new Response('range not satisfiable', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    outHeaders['Content-Length'] = String(end - start + 1);
    outHeaders['Content-Range'] = `bytes ${start}-${end}/${size}`;
    return new Response(buf.slice(start, end + 1), { status: 206, headers: outHeaders });
  }
  outHeaders['Content-Length'] = String(asset.size);
  return new Response(dl.body, { headers: outHeaders });
}

app.get('/api/renders/file/:filename', async (c) => {
  const filename = c.req.param('filename');
  if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    return c.json({ error: 'invalid filename' }, 400);
  }
  if (!filename.toLowerCase().endsWith('.mp4')) return c.json({ error: 'not a video' }, 400);
  
  const bucket = c.env.VIDEOS_BUCKET;
  // No R2 bucket: proxy the asset from the private GitHub release instead so
  // browsers don't need a GitHub login (raw release URLs 404 for them).
  if (!bucket) return proxyReleaseAsset(c.env, filename, c.req.header('range'));

  const range = c.req.header('range');
  let obj;
  const headers: Record<string, string> = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
  };
  
  if (range) {
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    if (match) {
      // Get object size first via a head-like request
      const full = await bucket.get(`renders/${filename}`);
      if (!full) return c.json({ error: 'not found' }, 404);
      const size = full.size;
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : size - 1;
      const clampedEnd = Math.min(end, size - 1);
      obj = await bucket.get(`renders/${filename}`, {
        range: { offset: start, length: clampedEnd - start + 1 },
      });
      if (!obj) return c.json({ error: 'not found' }, 404);
      headers['Content-Length'] = String(clampedEnd - start + 1);
      headers['Content-Range'] = `bytes ${start}-${clampedEnd}/${size}`;
      return new Response(obj.body, { status: 206, headers });
    }
  }
  
  obj = await bucket.get(`renders/${filename}`);
  if (!obj) return c.json({ error: 'not found' }, 404);
  headers['Content-Length'] = String(obj.size);
  return new Response(obj.body, { headers });
});

// --- Research (simplified for Workers - delegates to full pipeline) ---
// Note: Full research pipeline requires the Node.js backend. For now,
// the worker supports project CRUD and video serving. Research can be
// triggered via the GitHub Actions workflow.

// --- Research: dispatch the GitHub Actions research workflow ---
// This is what moves a project out of DRAFT: the workflow runs the full
// research pipeline (plan -> sources -> dataset -> story -> VideoSpec) and
// commits the resulting bundle to bundles/<projectId>/ in the repo itself,
// so the Render tab works right after.
app.post('/api/projects/:id/research', async (c) => {
  const id = c.req.param('id');
  const store = new KVProjectStore(c.env.PROJECTS_KV);
  let project;
  try {
    project = await store.load(id);
  } catch {
    return c.json({ error: 'project not found' }, 404);
  }

  const owner = c.env.GITHUB_OWNER ?? 'toviralideasyt7';
  const repo = c.env.GITHUB_REPO ?? 'analysis-video-maker';
  const token = c.env.GITHUB_TOKEN;
  if (!token) {
    return c.json({ error: 'GitHub token not configured on worker (GITHUB_TOKEN secret missing)' }, 500);
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    worldBankIndicator?: string; topN?: number | string; skipAi?: boolean;
    fromYear?: string | number; toYear?: string | number; prompt?: string;
  };
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 2000) : '';

  const dispatchRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/research.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'avm-orchestrator-worker',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          topic: project.topic,
          projectId: id,
          prompt,
          worldBankIndicator: String(body.worldBankIndicator ?? ''),
          topN: String(body.topN ?? 10),
          framesPerTransition: '20',
          fromYear: String(body.fromYear ?? ''),
          toYear: String(body.toYear ?? ''),
          skipAi: body.skipAi ? 'true' : 'false',
        },
      }),
    }
  );

  if (!dispatchRes.ok) {
    const errText = await dispatchRes.text();
    return c.json({ error: `GitHub dispatch failed: ${dispatchRes.status} ${errText.slice(0, 200)}` }, 502);
  }

  project.status = 'RESEARCHING';
  project.updatedAt = new Date().toISOString();
  // Agent mode: the user described the video in plain words. Remember the
  // prompt and auto-start the render as soon as research lands.
  if (prompt) {
    (project as Record<string, unknown>).prompt = prompt;
    (project as Record<string, unknown>).autoRender = true;
  }
  await store.save(project);

  return c.json({
    accepted: true,
    status: 'RESEARCHING',
    autoRender: !!prompt,
    message: prompt
      ? 'Research dispatched. The video will start rendering automatically when research finishes.'
      : 'Research dispatched. This page updates automatically when the data bundle lands.',
    workflowRunUrl: `https://github.com/${owner}/${repo}/actions/workflows/research.yml`,
  });
});

// Polled by the frontend while a project is RESEARCHING. Research is done
// when its bundle lands in the repo (the research workflow commits
// bundles/<projectId>/ itself on success); the status then flips to READY.
app.get('/api/projects/:id/research/status', async (c) => {
  const id = c.req.param('id');
  const store = new KVProjectStore(c.env.PROJECTS_KV);
  let project;
  try {
    project = await store.load(id);
  } catch {
    return c.json({ error: 'project not found' }, 404);
  }

  const owner = c.env.GITHUB_OWNER ?? 'toviralideasyt7';
  const repo = c.env.GITHUB_REPO ?? 'analysis-video-maker';
  const token = c.env.GITHUB_TOKEN;
  let bundleReady = false;
  if (token) {
    try {
      const check = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/bundles/${id}`,
        {
          headers: {
            'Accept': 'application/vnd.github+json',
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'avm-orchestrator-worker',
          },
        }
      );
      bundleReady = check.ok;
    } catch {
      bundleReady = false;
    }
  }

  if (bundleReady && project.status === 'RESEARCHING') {
    project.status = 'READY';
    project.updatedAt = new Date().toISOString();
    await store.save(project);
  }

  // If the research workflow itself failed, surface that instead of leaving
  // the project stuck on RESEARCHING forever (frontend would poll forever).
  let researchError: string | null = null;
  if (!bundleReady && project.status === 'RESEARCHING' && token) {
    try {
      const runsRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/actions/workflows/research.yml/runs?per_page=5&event=workflow_dispatch`,
        {
          headers: {
            'Accept': 'application/vnd.github+json',
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'avm-orchestrator-worker',
          },
        }
      );
      if (runsRes.ok) {
        const runs = (await runsRes.json()) as { workflow_runs?: { name?: string; conclusion?: string | null; display_title?: string; html_url?: string }[] };
        const failed = (runs.workflow_runs ?? []).find(
          (r) => r.conclusion === 'failure' && (r.display_title ?? '').includes(id)
        );
        if (failed) {
          project.status = 'FAILED';
          researchError = `Research workflow failed (${failed.display_title ?? 'run'}). See ${failed.html_url ?? 'GitHub Actions'} for the log.`;
          (project as Record<string, unknown>).error = researchError;
          project.updatedAt = new Date().toISOString();
          await store.save(project);
        }
      }
    } catch {
      // leave RESEARCHING; next poll retries
    }
  }

  // Agent mode: research just landed and the user asked for a hands-off run —
  // fire the render immediately so prompt -> video needs zero clicks.
  const wantsAutoRender = (project as Record<string, unknown>).autoRender === true;
  let autoRenderDispatched = false;
  if (project.status === 'READY' && wantsAutoRender) {
    const result = await dispatchRenderWorkflow(c.env, id);
    if (result.ok) {
      (project as Record<string, unknown>).autoRender = false;
      project.status = 'RENDERING';
      project.updatedAt = new Date().toISOString();
      await store.save(project);
      autoRenderDispatched = true;
    }
  }

  return c.json({ status: project.status, bundleReady, autoRenderDispatched, error: researchError ?? (project as Record<string, unknown>).error ?? null });
});

// --- Render: dispatch the GitHub Actions render-video workflow ---
// Shared by the manual Render button and the agent auto-render below.
async function dispatchRenderWorkflow(env: Env, id: string): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const owner = env.GITHUB_OWNER ?? 'toviralideasyt7';
  const repo = env.GITHUB_REPO ?? 'analysis-video-maker';
  const token = env.GITHUB_TOKEN;
  if (!token) {
    return { ok: false, status: 500, error: 'GitHub token not configured on worker (GITHUB_TOKEN secret missing)' };
  }

  // The render-video workflow reads the bundle from bundles/<projectId>/ in the repo.
  // Never silently fall back to another bundle: rendering the wrong video for
  // a project (and overwriting its release asset) is worse than refusing.
  let bundleExists = false;
  try {
    const check = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/bundles/${id}`,
      { headers: { 'Accept': 'application/vnd.github+json', 'Authorization': `Bearer ${token}`, 'User-Agent': 'avm-orchestrator-worker' } }
    );
    bundleExists = check.ok;
  } catch { bundleExists = false; }
  if (!bundleExists) {
    return {
      ok: false,
      status: 409,
      error: `No renderable bundle for this project yet (bundles/${id}/ not found in the repo). Run the research workflow first so a bundle is committed, then render.`,
    };
  }

  const dispatchRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/render-video.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'avm-orchestrator-worker',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          projectId: id,
          renderScale: '0.5',
          skipAiQa: 'true',
        },
      }),
    }
  );

  if (!dispatchRes.ok) {
    const errText = await dispatchRes.text();
    return { ok: false, status: 502, error: `GitHub dispatch failed: ${dispatchRes.status} ${errText.slice(0, 200)}` };
  }
  return { ok: true };
}

app.post('/api/projects/:id/render', async (c) => {
  const id = c.req.param('id');
  const store = new KVProjectStore(c.env.PROJECTS_KV);
  let project;
  try {
    project = await store.load(id);
  } catch {
    return c.json({ error: 'project not found' }, 404);
  }

  const owner = c.env.GITHUB_OWNER ?? 'toviralideasyt7';
  const repo = c.env.GITHUB_REPO ?? 'analysis-video-maker';
  const result = await dispatchRenderWorkflow(c.env, id);
  if (!result.ok) return c.json({ error: result.error }, result.status as 409 | 500 | 502);

  // Mark project as rendering
  project.status = 'RENDERING';
  project.updatedAt = new Date().toISOString();
  await store.save(project);

  return c.json({
    renderJob: { status: 'DISPATCHED', projectId: id },
    dispatch: {
      ok: true,
      message: 'Render dispatched. Watch the Videos tab — the video appears when the workflow finishes.',
      workflowRunUrl: `https://github.com/${owner}/${repo}/actions/workflows/render-video.yml`,
    },
  });
});

// Polled by the frontend while a project is RENDERING. When the workflow
// reports back via /api/hooks/render-complete the status flips to
// COMPLETED/FAILED and the finished video URL is included.
app.get('/api/projects/:id/render/status', async (c) => {
  const id = c.req.param('id');
  const store = new KVProjectStore(c.env.PROJECTS_KV);
  let project;
  try {
    project = await store.load(id);
  } catch {
    return c.json({ error: 'project not found' }, 404);
  }
  const renderJob = (project.renderJob ?? null) as Record<string, unknown> | null;
  let videoUrl: string | null = null;
  if (project.status === 'COMPLETED' && renderJob?.artifactUrl) {
    videoUrl = String(renderJob.artifactUrl);
  } else if (project.status === 'COMPLETED') {
    // Fall back to the release asset the workflow publishes.
    const asset = `${id}-final.mp4`;
    const videos = await listReleaseVideos(c.env);
    const match = videos.find((v) => v.filename === asset);
    if (match) videoUrl = match.url;
  }
  return c.json({ renderJob, status: project.status, videoUrl });
});

export default app;
