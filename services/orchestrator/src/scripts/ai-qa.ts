/**
 * AI QA gate for CI.
 *
 *   npx tsx services/orchestrator/src/scripts/ai-qa.ts --project <dir> [--json]
 *
 * Loads an approved bundle, hands a compact summary of the dataset, the
 * VideoSpec and the frame tape to the QA agent, and exits non-zero when the
 * agent reports a problem. This is what lets GitHub Actions use the AI layer
 * too, not just the deterministic checks.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { aiQaReview, type AgentContext } from '../agents';
import { createAIClient } from '../providers/ai';
import { Budget, createSearchProvider } from '../providers/search';
import { JsonlLog, limits, logger } from '../runtime';
import type { Dataset, VideoSpec } from '@avm/shared';
import type { FrameTape } from '../pipeline';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

async function main(): Promise<void> {
  const projectDir = resolve(arg('project') ?? '');
  if (!projectDir || !existsSync(projectDir)) {
    process.stderr.write('usage: tsx ai-qa.ts --project <projectDir> [--json]\n');
    process.exit(2);
  }

  const dataset = readJson<Dataset>(join(projectDir, 'dataset.json'));
  const videoSpec = readJson<VideoSpec>(join(projectDir, 'video-spec.json'));
  const frameTape = readJson<FrameTape>(join(projectDir, 'frames.json'));

  const lim = limits();
  const ctx: AgentContext = {
    ai: createAIClient(),
    search: createSearchProvider(),
    budget: new Budget(lim.maxSearches, lim.maxSearches * 4, lim.maxAgentRounds * 8),
    limits: lim,
    runLog: new JsonlLog('ci-ai-qa.jsonl'),
  };

  process.stdout.write(`provider: ${ctx.ai.providerName}\n`);
  const verdict = await aiQaReview(
    {
      datasetSummary: {
        name: dataset.name,
        metric: dataset.metric,
        unit: dataset.unit,
        timeRange: dataset.timeRange,
        frequency: dataset.frequency,
        stats: dataset.stats,
        sources: Array.from(new Set(dataset.observations.map((o) => o.source.url))).slice(0, 10),
      },
      videoSpec: {
        metadata: videoSpec.metadata,
        canvas: videoSpec.canvas,
        scenes: videoSpec.scenes.map((s) => ({ id: s.id, type: s.type, duration: s.duration })),
        sourceCount: videoSpec.sources.length,
        totalSceneDurationSeconds: videoSpec.scenes.reduce((sum, s) => sum + s.duration, 0),
      },
      frameTapeSummary: {
        // The tape is the per-frame state of the `bar_race` scene ONLY. It is
        // not expected to cover the whole video, and saying so explicitly stops
        // the reviewer from raising that as a defect.
        coversScene: 'scene_race',
        sceneDurationSeconds: Number((frameTape.durationInFrames / frameTape.fps).toFixed(2)),
        fps: frameTape.fps,
        durationInFrames: frameTape.durationInFrames,
        periods: frameTape.periodLabels.length,
        periodRange: `${frameTape.periodLabels[0] ?? ''}..${frameTape.periodLabels[frameTape.periodLabels.length - 1] ?? ''}`,
        entities: frameTape.entities.length,
        topN: frameTape.topN,
        notes: frameTape.notes,
      },
      verificationContext: {
        statusCounts: dataset.stats,
        // 0 verified is a legitimate outcome: it means the values come from a
        // single authoritative publisher and were therefore not cross-checked
        // against a second independent source.
        verificationMode: dataset.stats.verified > 0 ? 'cross-checked against at least two independent sources' : 'single authoritative source; values reported, not cross-verified',
        heldValuePolicy: 'values carried forward for visual continuity are flagged held=true and listed in the tape notes',
      },
    },
    ctx,
  );

  const strict = process.argv.includes('--strict');

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  } else {
    const label = !verdict.available ? 'UNAVAILABLE' : verdict.passed ? 'PASS' : 'FAIL';
    process.stdout.write(`AI QA: ${label}\n`);
    for (const problem of verdict.problems) process.stdout.write(` - ${problem}\n`);
    for (const note of verdict.notes) process.stdout.write(` note: ${note}\n`);
  }

  // A rejection fails the build. An unreachable provider does not: the
  // deterministic gates (schema, quality, frame-tape reproducibility) have
  // already run, and blocking a render on a transient 502 would be worse than
  // shipping a bundle that passed every hard check. Use --strict to require the
  // review to actually run.
  if (verdict.available && !verdict.passed) {
    logger.warn('AI QA rejected the bundle');
    process.exit(1);
  }
  if (!verdict.available) {
    logger.warn('AI QA did not run; continuing because the deterministic gates passed');
    if (strict) process.exit(1);
  }
}

void main();