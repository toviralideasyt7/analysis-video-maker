#!/usr/bin/env tsx
/**
 * Report a pipeline milestone back to the control plane.
 *
 *   npx tsx tools/notify-control.mts --stage rendering --inputPath inputs/x.json
 *   npx tsx tools/notify-control.mts --videoUrl https://gofile.io/d/xxxx --probe probe.json
 *
 * Env: CALLBACK_URL, HOOK_SECRET, JOB_ID. When either is missing the call is
 * skipped with a notice, so the pipeline still works without a control plane.
 */

import { readFileSync } from 'node:fs';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const callbackUrl = process.env.CALLBACK_URL ?? '';
  const secret = process.env.HOOK_SECRET ?? '';
  const jobId = process.env.JOB_ID ?? '';
  if (!callbackUrl || !secret || !jobId) {
    process.stdout.write('control plane not configured (CALLBACK_URL / HOOK_SECRET / JOB_ID); skipping the report\n');
    return;
  }

  const videoUrl = arg('videoUrl');
  const probePath = arg('probe');
  const payload: Record<string, unknown> = {
    jobId,
    stage: arg('stage') ?? (videoUrl ? 'done' : 'rendering'),
    status: arg('status') ?? (videoUrl ? 'done' : 'rendering'),
    inputPath: arg('inputPath'),
    runUrl: process.env.RUN_URL,
    videoUrl,
    error: arg('error'),
  };
  if (probePath) {
    try {
      payload.probe = JSON.parse(readFileSync(probePath, 'utf8'));
    } catch {
      payload.probe = undefined;
    }
  }

  const response = await fetch(callbackUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hook-secret': secret },
    body: JSON.stringify(payload),
  });
  process.stdout.write(`control plane report -> ${response.status}\n`);
  if (!response.ok) process.exit(1);
}

main().catch((error) => {
  process.stderr.write(`report failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});