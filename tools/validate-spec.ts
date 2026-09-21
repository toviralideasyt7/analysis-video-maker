#!/usr/bin/env tsx
/**
 * CI gate: validate an approved project bundle before rendering.
 *
 *   npx tsx tools/validate-spec.ts <projectDir>
 *
 * Checks:
 *   1. video-spec.json  passes the shared JSON Schema + semantic rules;
 *   2. every scene duration is positive and the total matches the metadata;
 *   3. every scene props.assets reference resolves to a declared asset;
 *   4. dataset.json + frames.json are present and non-empty.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { semanticVideoSpecProblems, validateDataQualityReport, validateVideoSpec } from '@avm/shared';

const dir = resolve(process.argv[2] ?? '');
if (!dir || !existsSync(dir)) {
  process.stderr.write('usage: tsx tools/validate-spec.ts <projectDir>\n');
  process.exit(2);
}

const problems: string[] = [];
const read = (name: string): unknown => {
  const path = join(dir, name);
  if (!existsSync(path)) {
    problems.push(`missing file: ${name}`);
    return null;
  }
  return JSON.parse(readFileSync(path, 'utf8'));
};

const spec = read('video-spec.json');
const dataset = read('dataset.json');
const tape = read('frames.json');
const quality = existsSync(join(dir, 'quality.json')) ? JSON.parse(readFileSync(join(dir, 'quality.json'), 'utf8')) : null;

if (spec) {
  const schema = validateVideoSpec(spec);
  if (!schema.valid) problems.push(...schema.errors.map((e) => `video-spec: ${e}`));
  problems.push(...semanticVideoSpecProblems(spec as Parameters<typeof semanticVideoSpecProblems>[0]));
  const declaredAssets = new Set(((spec as { assets?: Array<{ url: string }> }).assets ?? []).map((a) => a.url));
  for (const scene of (spec as { scenes: Array<{ id: string; props?: Record<string, unknown> }> }).scenes) {
    for (const ref of ((scene.props?.assets as string[] | undefined) ?? [])) {
      if (!declaredAssets.has(ref)) problems.push(`scene ${scene.id} references undeclared asset ${ref}`);
    }
  }
}

if (dataset) {
  const observations = (dataset as { observations?: unknown[] }).observations ?? [];
  if (observations.length === 0) problems.push('dataset has no observations');
  for (const o of observations as Array<{ value: number | null; status: string }>) {
    if (o.value === null && o.status !== 'UNKNOWN') {
      problems.push('a null value is not marked UNKNOWN');
      break;
    }
  }
}

if (tape) {
  const frames = (tape as { frames?: unknown[] }).frames ?? [];
  if (frames.length === 0) problems.push('frame tape is empty');
}

if (quality) {
  const report = validateDataQualityReport(quality);
  if (!report.valid) problems.push(...report.errors.map((e) => `quality: ${e}`));
  if ((quality as { passed?: boolean }).passed === false) {
    problems.push(`quality gate failed with ${(quality as { violations?: number }).violations} violations`);
  }
}

if (problems.length > 0) {
  process.stderr.write(`validation failed for ${dir}:\n`);
  for (const p of problems) process.stderr.write(` - ${p}\n`);
  process.exit(1);
}
process.stdout.write(`spec ok: ${dir}\n`);