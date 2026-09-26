/**
 * 1-minute AI health check: probes every configured model with a tiny prompt
 * and reports which ones actually answer.
 *
 *   npx tsx services/orchestrator/src/scripts/ai-health.ts
 *
 * Exit 0 if at least one model works, 1 if all fail. Prints a table the
 * GitHub Actions step (and the frontend) can show verbatim.
 */
import { createAIClient, ROLE_MODELS, type AgentRole, type ModelProvider } from '../providers/ai';

const ROLES: AgentRole[] = ['planner', 'extractor', 'story'];

async function main(): Promise<void> {
  const client = createAIClient();
  console.log(`providers: ${client.providerName}`);
  const seen = new Set<string>();
  const specs: { provider: ModelProvider; model: string }[] = [];
  for (const role of ROLES) {
    for (const s of ROLE_MODELS[role]) {
      const key = `${s.provider}/${s.model}`;
      if (!seen.has(key)) {
        seen.add(key);
        specs.push({ provider: s.provider, model: s.model });
      }
    }
  }
  console.log(`probing ${specs.length} model configs (tiny prompt, ~60s budget)...\n`);
  let okCount = 0;
  for (const s of specs) {
    const started = Date.now();
    try {
      const res = await Promise.race([
        client.complete(
          { prompt: 'Reply with exactly: OK', maxTokens: 8, temperature: 0 },
          `${s.provider}:${s.model}`,
        ),
        // 60s timeout to match fetchWithTimeout. Worker 2 can take 25s+;
        // a 15s timeout here causes false negatives for slow-but-working models.
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout 60s')), 60000)),
      ]);
      const ok = /ok/i.test(res.text ?? '');
      console.log(
        `${ok ? '✅' : '⚠️'} ${s.provider}/${s.model} — ${((Date.now() - started) / 1000).toFixed(1)}s${
          ok ? '' : ` (unexpected reply: ${(res.text ?? '').slice(0, 40)})`
        }`,
      );
      if (ok) okCount++;
    } catch (e) {
      console.log(
        `❌ ${s.provider}/${s.model} — ${((Date.now() - started) / 1000).toFixed(1)}s (${(e instanceof Error ? e.message : String(e)).slice(0, 80)})`,
      );
    }
  }
  console.log(`\n${okCount}/${specs.length} models responding`);
  process.exit(okCount > 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`health check crashed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
