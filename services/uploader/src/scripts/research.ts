#!/usr/bin/env tsx
/**
 * Research CLI for GitHub Actions.
 *
 * Env: TOPIC (required), DATA_URL (optional), TOP_N (optional)
 * Writes: inputs/<slug>.json
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runResearch } from '../research-agent';

function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : undefined;
}

async function main(): Promise<void> {
  const topic = envValue('TOPIC') ?? (existsSync('research-topic.txt') ? readFileSync('research-topic.txt', 'utf8').trim() : undefined);
  if (!topic) {
    process.stderr.write('TOPIC is required (env or research-topic.txt)\n');
    process.exit(2);
  }
  process.stdout.write(`researching: ${topic}\n`);
  const result = await runResearch(
    {
      topic,
      dataUrl: envValue('DATA_URL'),
      topN: envValue('TOP_N') ? Number(envValue('TOP_N')) : undefined,
      layout: envValue('LAYOUT'),
      targetMinutes: envValue('TARGET_MINUTES') ? Number(envValue('TARGET_MINUTES')) : undefined,
    },
    'inputs',
  );

  for (const warning of result.warnings) process.stdout.write(`warn: ${warning}\n`);
  for (const error of result.errors) process.stderr.write(`error: ${error}\n`);

  if (!result.ok || !result.outputPath) {
    process.exit(1);
  }
  process.stdout.write(`input written: ${result.outputPath}\n`);
  // hint for the chained render
  writeFileSync(join('research-topic.txt'), topic);
}

main().catch((error) => {
  process.stderr.write(`research failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});