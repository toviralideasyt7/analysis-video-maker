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
  const yearRange = years.length ? `${Math.min(...years)}-${Math.max(...years)}` : '';

  const ai = createAIClient();
  const prompt = `You are a YouTube SEO expert for a data-visualization channel called "Data Races" that publishes animated bar-chart-race videos.

VIDEO FACTS (use only these facts, do not invent data):
- Topic: ${topic}
- Title working draft: ${title}
- Year range: ${yearRange || 'unknown'}
- Top entities shown: ${entities.join(', ') || 'unknown'}

Write YouTube metadata that maximizes click-through rate and search ranking.
Rules:
- Title: under 70 characters, curiosity gap, big numbers, NO clickbait lies (must stay true to the facts above).
- Description: 3-5 sentences, keyword-rich, first 2 lines must hook the viewer; include the year range and 3-4 entity names naturally; end with 2-3 hashtags.
- Tags: 12-18 tags, mix of broad ("data visualization", "bar chart race") and specific (topic words, entity names, year range).
- Thumbnail hook: 2-4 ALL-CAPS punchy words for the thumbnail image that create curiosity WITHOUT repeating the title (e.g. title "Best-Selling Game Consoles of All Time" -> hook "NOBODY BEATS THIS"). Must be true to the facts.

Return ONLY valid JSON with keys: "title", "description", "tags" (array of strings), "thumbnailHook". No markdown, no commentary.`;

  const raw = await ai.completeRole('story', {
    prompt,
    maxTokens: 1200,
    temperature: 0.8,
  });
  const text = raw.text ?? '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`model did not return JSON: ${text.slice(0, 200)}`);
  const meta = JSON.parse(m[0]) as { title: string; description: string; tags: string[]; thumbnailHook?: string };
  if (!meta.title || !meta.description || !Array.isArray(meta.tags)) {
    throw new Error(`bad metadata shape: ${text.slice(0, 200)}`);
  }
  meta.tags = meta.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20);
  if (!meta.thumbnailHook) meta.thumbnailHook = title.toUpperCase().split(/\s+/).slice(0, 3).join(' ');

  const out = resolve(arg('out') ?? join(projectDir, 'renders', 'metadata.json'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ project: (spec as any).projectId ?? '', generatedAt: new Date().toISOString(), ...meta }, null, 2));
  process.stdout.write(`metadata written: ${out}\ntitle: ${meta.title}\n`);
}

main().catch((e) => {
  process.stderr.write(`metadata generation failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
