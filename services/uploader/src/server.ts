/**
 * Upload API.
 *
 * POST /api/upload        multipart form: file=<video-input.json|csv> [facts=<csv>]
 * GET  /api/health
 * GET  /api/input/:id     the last committed input (for the result page)
 *
 * A JSON file is validated and committed as-is. A CSV is converted to the
 * video-input JSON first (entity,date,value[,color,flagCode,group] plus an
 * optional facts CSV). After a successful commit the render workflow is
 * dispatched and the ids are returned so the browser can link to the run.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitInputFile, dispatchRender, inputId } from './github';
import { env, logger, maxUploadBytes, port, uploadsDir } from './runtime';
import { csvToInput, parseCsv } from './csv';
import { validateVideoInputFile } from './validate';
import type { VideoInputFact } from '@avm/shared';

const app = new Hono();
app.use('*', cors({ origin: env('ALLOWED_ORIGINS', '*').split(',').map((s) => s.trim()).filter(Boolean) }));

const inputs = new Map<string, { path: string; title: string; warnings: string[] }>();

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    repo: `${env('GITHUB_OWNER', '')}/${env('GITHUB_REPO', '')}`,
    githubToken: Boolean(env('GITHUB_TOKEN')),
    maxUploadBytes: maxUploadBytes(),
    at: new Date().toISOString(),
  }),
);

app.post('/api/upload', async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'expected multipart/form-data with a "file" field' }, 400);
  }
  const file = form.get('file');
  if (!(file instanceof File)) return c.json({ error: 'missing "file" field' }, 400);
  if (file.size > maxUploadBytes()) {
    return c.json({ error: `file is too large (${file.size} bytes; limit ${maxUploadBytes()})` }, 413);
  }
  const factsFile = form.get('facts');
  const name = file.name || 'video-input.json';

  let jsonText: string;
  let warnings: string[] = [];
  try {
    if (name.toLowerCase().endsWith('.csv')) {
      const converted = csvToInput(await file.text(), {
        title: String(form.get('title') ?? name.replace(/\.csv$/i, '')),
        metric: String(form.get('metric') ?? 'Total'),
        unit: String(form.get('unit') ?? 'count'),
        topN: form.get('topN') ? Number(form.get('topN')) : undefined,
        secondsPerYear: form.get('secondsPerYear') ? Number(form.get('secondsPerYear')) : undefined,
      });
      const { input: convertedInput, warnings: convertWarnings } = converted;
      if (factsFile instanceof File) {
        convertedInput.facts = csvToFacts(await factsFile.text());
      }
      jsonText = JSON.stringify(convertedInput, null, 2);
      warnings = convertWarnings;
    } else {
      jsonText = await file.text();
    }
  } catch (error) {
    return c.json({ error: `could not read the file: ${error instanceof Error ? error.message : String(error)}` }, 400);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    return c.json({ error: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` }, 400);
  }

  const validation = validateVideoInputFile(parsed);
  if (warnings.length > 0) validation.warnings.push(...warnings);
  if (!validation.ok) {
    return c.json({ error: 'the file failed validation', details: validation.errors }, 422);
  }

  const id = inputId(name, jsonText);
  try {
    writeFileSync(join(uploadsDir(), `${id}.json`), jsonText, 'utf8');
  } catch {
    /* local copy is best-effort; the GitHub commit is what matters */
  }

  const committed = await commitInputFile(`${id}.json`, jsonText);
  if (!committed.ok) {
    return c.json({ error: `could not commit the file to GitHub: ${committed.error}` }, 502);
  }

  const dispatched = await dispatchRender(committed.path);
  if (!dispatched.ok) {
    return c.json({ error: `file committed but the render could not be dispatched: ${dispatched.error}`, inputPath: committed.path }, 502);
  }

  inputs.set(id, { path: committed.path, title: (parsed as { title?: string }).title ?? id, warnings: validation.warnings });
  logger.info('upload accepted', { id, path: committed.path });

  return c.json({
    ok: true,
    id,
    inputPath: committed.path,
    warnings: validation.warnings,
    runUrl: dispatched.runUrl,
    message: 'committed and rendering - the MP4 appears as a workflow artifact when the run finishes',
  });
});

app.get('/api/input/:id', (c) => {
  const state = inputs.get(c.req.param('id'));
  if (!state) return c.json({ error: 'unknown id' }, 404);
  return c.json(state);
});

serve({ fetch: app.fetch, port: port() }, (info) => {
  logger.info('uploader listening', { port: info.port });
});

function csvToFacts(text: string): VideoInputFact[] {
  const table = parseCsv(text, ',');
  const col = (names: string[]): number => {
    const lower = table.columns.map((c) => c.trim().toLowerCase());
    for (const name of names) {
      const index = lower.indexOf(name);
      if (index >= 0) return index;
    }
    return -1;
  };
  const atDate = col(['atdate', 'date', 'year']);
  const heading = col(['heading', 'title']);
  const body = col(['body', 'text', 'fact']);
  const tiles = col(['tiles', 'entities']);
  const out: VideoInputFact[] = [];
  for (const row of table.rows) {
    const date = (row[atDate] ?? '').trim();
    const head = (row[heading] ?? '').trim();
    if (!date || !head) continue;
    out.push({
      atDate: date,
      heading: head,
      body: (row[body] ?? '').trim(),
      tiles: (row[tiles] ?? '').split(';').map((t) => t.trim()).filter(Boolean),
    });
  }
  return out;
}