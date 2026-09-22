/**
 * End-to-end research run: topic -> plan -> sources -> observations ->
 * verification -> dataset -> frame tape -> story -> VideoSpec.
 *
 * Usage:
 *   npx tsx src/scripts/demo-research.ts "World Population by Country 1960-2024" --indicator SP.POP.TOTL
 *   npx tsx src/scripts/demo-research.ts "Life expectancy over time" --owid life-expectancy
 *   npx tsx src/scripts/demo-research.ts "..." --skip-ai
 */

import { researchTopic } from '../research';
import { rustAvailable } from '../runtime';

/** Split argv into positional words and `--flag value` pairs, without leaking flag values into the topic. */
function parseArgv(argv: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, 'true');
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgv(process.argv.slice(2));
  const topic = positional.join(' ').trim() || 'World Population by Country';
  const numeric = (key: string): number | undefined => {
    const raw = flags.get(key);
    return raw === undefined ? undefined : Number(raw);
  };

  process.stdout.write(`rust core: ${rustAvailable() ? 'available' : 'MISSING (frame tape will fail)'}\n`);
  process.stdout.write(`topic: ${topic}\n`);

  const from = flags.get('from');
  const to = flags.get('to');
  const result = await researchTopic({
    topic,
    timeRange: from && to ? { start: from, end: to } : undefined,
    owidSlug: flags.get('owid'),
    worldBankIndicator: flags.get('indicator'),
    topN: numeric('topn') ?? 10,
    framesPerTransition: numeric('frames') ?? 30,
    skipAi: flags.get('skip-ai') === 'true',
    entityCount: numeric('entities'),
  });

  const dir = result.store.dir(result.state.projectId);
  process.stdout.write(`\nproject: ${result.state.projectId}\nstatus:  ${result.state.status}\npath:    ${dir}\n`);
  process.stdout.write(`\nsummary:\n${JSON.stringify(result.summary, null, 2)}\n`);
  if (result.errors.length > 0) {
    process.stdout.write(`\nerrors:\n${result.errors.map((e) => ` - ${e}`).join('\n')}\n`);
  }
  process.stdout.write(`\ncheckpoints: ${result.state.checkpoints.map((c) => c.checkpoint).join(', ')}\n`);
  if (!result.summary.observations) process.exit(3);
}
void main();