#!/usr/bin/env tsx
/**
 * Fill in missing entity metadata (flagCode, logoUrl) for a video-input file.
 *
 * Order:
 *   1. built-in country table (offline, deterministic);
 *   2. Monid fetch of a known flag/logo URL pattern (flagcdn by ISO code);
 *   3. AI: ask the model for the ISO-3166 alpha-2 code of an unrecognised name,
 *      then verify the flag asset actually exists before writing it.
 *
 * Writes the enriched file back in place (same path) and reports what changed.
 * This is the only AI/network step in the pipeline, and it only ADDS metadata -
 * it never touches the user's numbers.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateVideoInput, type VideoInput, VideoInputEntity } from '@avm/shared';
import { circleFlagDataUrl } from './sources/flags';

const path = resolve(process.argv[2] ?? '');
if (!path || !existsSync(path)) {
  process.stderr.write('usage: tsx tools/resolve-assets.ts <video-input.json>\n');
  process.exit(2);
}

const input = JSON.parse(readFileSync(path, 'utf8')) as VideoInput;
const check = validateVideoInput(input);
if (!check.valid) {
  process.stderr.write(`refusing to enrich an invalid input:\n - ${check.errors.join('\n - ')}\n`);
  process.exit(1);
}

const COUNTRIES = JSON.parse(readFileSync(resolve('crates/datarace-core/data/countries.json'), 'utf8')) as Array<{
  name: string;
  iso2: string;
  aliases: string[];
}>;

const byName = new Map<string, { iso2: string }>();
for (const country of COUNTRIES) {
  byName.set(country.name.toLowerCase(), { iso2: country.iso2 });
  for (const alias of country.aliases ?? []) byName.set(alias.toLowerCase(), { iso2: country.iso2 });
  byName.set(country.iso2.toLowerCase(), { iso2: country.iso2 });
}

const AGGREGATES = new Set(['xx', 'xo', 'xs', 'xe', 'an', 'xu', 'oc']);

function offlineFlag(name: string): string | null {
  const hit = byName.get(name.trim().toLowerCase());
  if (!hit) return null;
  if (AGGREGATES.has(hit.iso2.toLowerCase())) return null;
  return hit.iso2.toLowerCase();
}

async function urlExists(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
}

/** True when the key looks usable (non-empty, no truncation ellipsis). */
function usableKey(key: string): boolean {
  return key.length > 20 && !key.includes('…') && !key.includes('...');
}

async function aiFlagCode(name: string, apiKey: string): Promise<string | null> {
  const response = await fetch('https://router.bynara.id/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'nex-n2.5-pro',
      messages: [
        {
          role: 'user',
          content: `What is the ISO-3166 alpha-2 country code for the entity "${name}"? Reply with the two-letter code only, or NONE if it is not a country.`,
        },
      ],
      max_tokens: 8,
    }),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = (body.choices?.[0]?.message?.content ?? '').trim().toLowerCase();
  return /^[a-z]{2}$/.test(text) ? text : null;
}

async function downloadLogo(domain: string, outPath: string): Promise<boolean> {
  try {
    const response = await fetch(`https://www.google.com/s2/favicons?domain=${domain}&sz=128`);
    if (!response.ok) return false;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength < 200) return false;
    writeFileSync(outPath, buffer);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const entities: VideoInputEntity[] = input.entities ?? [];
  const resolved: string[] = [];
  const stillMissing: string[] = [];
  const rawNaraKey = process.env.NARA_API_KEY ?? "";
  // A masked/truncated key (chat clients abbreviate secrets with an ellipsis)
  // must not crash the run - AI flag lookup is simply skipped.
  const naraKey = usableKey(rawNaraKey) ? rawNaraKey : "";

  for (const entity of entities) {
    if (entity.flagCode) continue;
    const offline = offlineFlag(entity.name) ?? offlineFlag(entity.id);
    if (offline) {
      entity.flagCode = offline;
      resolved.push(`${entity.name} -> ${offline} (country table)`);
      continue;
    }
    if (naraKey) {
      const code = await aiFlagCode(entity.name, naraKey);
      if (code && !AGGREGATES.has(code)) {
        const url = `https://flagcdn.com/w80/${code}.png`;
        if (await urlExists(url)) {
          entity.flagCode = code;
          resolved.push(`${entity.name} -> ${code} (AI + verified asset)`);
          continue;
        }
      }
    }
    stillMissing.push(entity.name);
  }

  // Logos: fetch a real favicon per entity into public/logos so the render
  // never touches the network (Remotion cancels on a failed image fetch).
  const { mkdirSync } = await import('node:fs');
  const logoDir = resolve('renderer/public/logos');
  const repoPublic = resolve('public/logos');
  mkdirSync(logoDir, { recursive: true });
  mkdirSync(repoPublic, { recursive: true });
  const domains = process.env.LOGO_DOMAINS && process.env.LOGO_DOMAINS !== '{}'
    ? JSON.parse(process.env.LOGO_DOMAINS)
    : ((input as { logoDomains?: Record<string, string> }).logoDomains ?? {});
  for (const entity of entities) {
    const domain = domains[entity.id];
    if (!domain) continue;
    const outPath = resolve(logoDir, `${entity.id}.png`);
    if (existsSync(outPath)) {
      entity.logoUrl = `logos/${entity.id}.png`;
      continue;
    }
    if (await downloadLogo(domain, outPath)) {
      entity.logoUrl = `logos/${entity.id}.png`;
      process.stdout.write(`  logo: ${entity.name} -> logos/${entity.id}.png\n`);
    }
  }

  // Flags: the renderer draws entity.logoUrl, so a flag code alone is not
  // enough. Turn each code into an inline circular-flag SVG data URL. Inlining
  // keeps the render offline (Remotion aborts on a failed remote image fetch)
  // and costs well under 1 KB per country. A code with no asset is dropped
  // rather than guessed.
  const broken: string[] = [];
  let inlined = 0;
  for (const entity of entities) {
    if (!entity.flagCode) continue;
    if (AGGREGATES.has(entity.flagCode.toLowerCase())) {
      entity.flagCode = null;
      continue;
    }
    if (entity.logoUrl) continue;
    const dataUrl = await circleFlagDataUrl(entity.flagCode);
    if (dataUrl) {
      entity.logoUrl = dataUrl;
      inlined += 1;
      continue;
    }
    broken.push(entity.flagCode);
    entity.flagCode = null;
  }
  writeFileSync(path, JSON.stringify(input, null, 1), 'utf8');
  process.stdout.write(`flags resolved: ${resolved.length}\n`);
  for (const line of resolved) process.stdout.write(`  ${line}\n`);
  if (stillMissing.length > 0) process.stdout.write(`no flag for: ${stillMissing.join(', ')} (entity renders without one)\n`);
  if (broken.length > 0) process.stdout.write(`removed broken flag assets: ${broken.join(', ')}\n`);
  process.stdout.write(`flags inlined as images: ${inlined}\n`);
}

main().catch((error) => {
  process.stderr.write(`resolve-assets failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
