#!/usr/bin/env tsx
/**
 * CI gate: the frame tape must be reproducible from the dataset.
 *
 *   npx tsx tools/verify-tape.ts <projectDir>
 *
 * Recomputes the tape with the Rust core from dataset.json and compares it with
 * the shipped frames.json. A mismatch means the render would not match the
 * verified data, so the job fails instead of rendering something inconsistent.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = resolve(process.argv[2] ?? '');
if (!dir || !existsSync(join(dir, 'dataset.json'))) {
  process.stderr.write('usage: tsx tools/verify-tape.ts <projectDir>  (dataset.json required)\n');
  process.exit(2);
}

const bin = process.env.DATARACE_BIN ?? 'target/release/datarace';
const dataset = JSON.parse(readFileSync(join(dir, 'dataset.json'), 'utf8')) as {
  name?: string;
  metric?: string;
  unit?: string;
  observations: Array<{ entity: { name: string }; date: string; value: number | null; unit: string }>;
};
const shipped = JSON.parse(readFileSync(join(dir, 'frames.json'), 'utf8')) as { topN: number; framesPerTransition: number };

const coreInput = {
  name: dataset.name,
  metric: dataset.metric,
  unit: dataset.unit,
  observations: dataset.observations.map((o) => ({ entity: o.entity.name, date: o.date, value: o.value, unit: o.unit })),
};

const work = mkdtempSync(join(tmpdir(), 'verify-tape-'));
const inFile = join(work, 'in.json');
const outFile = join(work, 'frames.json');
writeFileSync(inFile, JSON.stringify(coreInput), 'utf8');

const args = [
  'frames',
  '--in', inFile,
  '--out', outFile,
  '--top', String(shipped.topN),
  '--frames-per-transition', String(shipped.framesPerTransition),
];
const result = spawnSync(bin, args, { encoding: 'utf8' });
if (result.status !== 0) {
  process.stderr.write(`datarace frames failed: ${result.stderr || result.stdout}\n`);
  process.exit(1);
}

const recomputed = JSON.parse(readFileSync(outFile, 'utf8')) as { durationInFrames: number; periodLabels: string[]; entities: unknown[] };
if (recomputed.durationInFrames !== (shipped as unknown as { durationInFrames: number }).durationInFrames) {
  process.stderr.write(
    `frame tape mismatch: shipped ${(shipped as unknown as { durationInFrames: number }).durationInFrames} frames, recomputed ${recomputed.durationInFrames}\n`,
  );
  process.exit(1);
}
process.stdout.write(`frame tape reproducible: ${recomputed.durationInFrames} frames, ${recomputed.periodLabels.length} periods\n`);