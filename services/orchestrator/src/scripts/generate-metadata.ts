/**
 * Generate YouTube-ready metadata (clickbait title, SEO description, tags)
 * for a rendered data-race video, using the repo's AI client (NARA / Gemini).
 *
 *   npx tsx services/orchestrator/src/scripts/generate-metadata.ts \
 *     --project projects/<projectId> [--out projects/<projectId>/renders/metadata.json]
 *
 * Reads video-spec.json + dataset.json for hard facts (topic, entities, range),
 * asks the model for a returned JSON object, and writes it to disk.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createAIClient } from '../providers/ai';
import type { Dataset, VideoSpec } from '@avm/shared';

/** Build a truthful, descriptive YouTube title from the video-spec facts.
 *  Format matches the channel's proven style, e.g.
 *  "Top 15 Car Producing Countries Race (1950–2025)".
 *  Never invented by the model — derived from the spec title + year range. */
function titleCase(s: string): string {
  const small = new Set(['a', 'an', 'the', 'and', 'or', 'by', 'of', 'in', 'on', 'per', 'vs', 'to', 'for', 'with']);
  return s.split(/(\s+|[-/])/).map((tok, i, arr) => {
    if (/^\s+$/.test(tok) || tok === '-' || tok === '/') return tok;
    const prev = arr.slice(0, i).join('');
    const isFirst = prev.trim() === '';
    const low = tok.toLowerCase();
    // keep acronyms / units as-is: GDP, CO2, PPP, $3T, 3D ...
    if (/^[A-Z0-9$]+[0-9]*$/.test(tok) && /[A-Z]/.test(tok) && tok === tok.toUpperCase() && tok.length <= 5) return tok;
    if (!isFirst && small.has(low)) return low;
    return low.charAt(0).toUpperCase() + low.slice(1);
  }).join('');
}

function buildTitle(specTitle: string, yearRange: string): string {
  let t = (specTitle ?? '').trim();
  t = t.replace(/^bar chart race of (the )?/i, '');
  t = t.replace(/\s+by annual.*$/i, '');
  t = t.replace(/,?\s*\d{4}\s*[–—-]\s*\d{2,4}\.?$/i, '');
  t = t.replace(/\s+from\s+\d+.*$/i, '');
  t = t.replace(/\.+$/, '').trim();
  t = titleCase(t);
  if (!/race/i.test(t)) t = `${t} Race`;
  return yearRange ? `${t} (${yearRange})` : t;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const projectDir = resolve(arg('project') ?? '');
  if (!projectDir || !existsSync(projectDir)) {
    process.stderr.write('usage: tsx generate-metadata.ts --project <projectDir> [--out <file>]\n');
    process.exit(2);
  }
  const spec = JSON.parse(readFileSync(join(projectDir, 'video-spec.json'), 'utf8')) as VideoSpec;
  const dataset = JSON.parse(readFileSync(join(projectDir, 'dataset.json'), 'utf8')) as Dataset;

  const title = spec.metadata.title ?? 'Data Race';
  const topic = (spec as any).topic ?? title;
  const entities: string[] = Array.isArray((dataset as any).entities)
    ? (dataset as any).entities.slice(0, 12).map((e: any) => e.name ?? e.id ?? String(e))
    : [];
  const years: number[] = Array.isArray((dataset as any).periods)
    ? (dataset as any).periods.map((p: any) => Number(p.year ?? p)).filter((n: number) => Number.isFinite(n))
    : [];
  let yearRange = '';
  if (years.length) {
    yearRange = `${Math.min(...years)}–${Math.max(...years)}`;
  } else {
    // datasets without a periods array carry timeRange {start,end}
    const tr = (dataset as any).timeRange as { start?: unknown; end?: unknown } | undefined;
    const s = tr?.start != null ? String(tr.start) : '';
    const e = tr?.end != null ? String(tr.end) : '';
    if (s && e) yearRange = `${s}–${e}`;
  }

  // The YouTube title is built deterministically from spec facts — the model
  // must NOT invent it (past runs hallucinated "$3T Giants" / wrong metrics).
  const fixedTitle = buildTitle(title, yearRange);

  const ai = createAIClient();
  const prompt = `You are writing YouTube metadata for a data-visualization channel called "Data Races" that publishes animated bar-chart-race videos.

VIDEO FACTS (these are the ONLY facts you may use — do not invent numbers, dollar amounts, company names, or claims beyond them):
- Fixed video title (do NOT change it, do NOT repeat it as the hook): ${fixedTitle}
- Topic: ${topic}
- Year range: ${yearRange || 'unknown'}
- Top entities shown: ${entities.join(', ') || 'unknown'}

Write:
- Description: 3-5 sentences, keyword-rich, first 2 lines must hook the viewer; include the year range and 3-4 entity names naturally; end with 2-3 hashtags. Every claim must be traceable to the facts above.
- Tags: 12-18 tags, mix of broad ("data visualization", "bar chart race") and specific (topic words, entity names, year range).
- Thumbnail hook: 2-4 ALL-CAPS punchy words for the thumbnail image, true to the facts above (e.g. "NOKIA'S FALL", "CHINA TAKES OVER"). Never generic "DATA RACE".

Return ONLY valid JSON with keys: "description", "tags" (array of strings), "thumbnailHook". No markdown, no commentary.`;

  const raw = await ai.completeRole('story', {
    prompt,
    maxTokens: 1200,
    temperature: 0.8,
  });
  const text = raw.text ?? '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`model did not return JSON: ${text.slice(0, 200)}`);
  const meta = JSON.parse(m[0]) as { description: string; tags: string[]; thumbnailHook?: string };
  if (!meta.description || !Array.isArray(meta.tags)) {
    throw new Error(`bad metadata shape: ${text.slice(0, 200)}`);
  }
  meta.tags = meta.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
  if (!meta.thumbnailHook) meta.thumbnailHook = topic.toUpperCase().split(/\s+/).slice(0, 3).join(' ');

  const out = resolve(arg('out') ?? join(projectDir, 'renders', 'metadata.json'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ project: (spec as any).projectId ?? '', generatedAt: new Date().toISOString(), title: fixedTitle, ...meta }, null, 2));
  process.stdout.write(`metadata written: ${out}\ntitle: ${fixedTitle}\n`);
}

main().catch((e) => {
  process.stderr.write(`metadata generation failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
