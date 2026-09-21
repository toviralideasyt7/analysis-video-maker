/**
 * Ask the Planner for a DataPlan (real AI call through the Gemini workers).
 *
 * Usage: npm run demo:plan
 *        npx tsx src/scripts/demo-plan.ts "Best Selling Video Games 1980-2026"
 */

import { createAIClient } from '../providers/ai';
import { planTopic, type AgentContext } from '../agents';
import { Budget, createSearchProvider } from '../providers/search';
import { JsonlLog, limits } from '../runtime';

async function main(): Promise<void> {
  const topic = process.argv.slice(2).join(' ') || 'Most Popular Cell Phone Brands in the World';
  const lim = limits();
  const ctx: AgentContext = {
    ai: createAIClient(),
    search: createSearchProvider(),
    budget: new Budget(lim.maxSearches, lim.maxSearches * 4, lim.maxAgentRounds * 8),
    limits: lim,
    runLog: new JsonlLog('agent-runs.jsonl'),
  };
  process.stdout.write(`Provider: ${ctx.ai.providerName}\nTopic: ${topic}\n\n`);
  const plan = await planTopic(topic, ctx, { entityCount: 10 });
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

void main();