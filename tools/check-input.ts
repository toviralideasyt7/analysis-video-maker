#!/usr/bin/env tsx
/** CI gate: validate a video-input file before rendering. */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateVideoInput } from '@avm/shared';

const path = resolve(process.argv[2] ?? '');
if (!path || !existsSync(path)) {
  process.stderr.write('usage: tsx tools/check-input.ts <video-input.json>\n');
  process.exit(2);
}
const value = JSON.parse(readFileSync(path, 'utf8'));
const result = validateVideoInput(value);
if (!result.valid) {
  process.stderr.write(`invalid video input ${path}:\n`);
  for (const error of result.errors) process.stderr.write(` - ${error}\n`);
  process.exit(1);
}
process.stdout.write(`input ok: ${path}\n`);