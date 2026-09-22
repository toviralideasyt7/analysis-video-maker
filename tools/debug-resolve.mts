import { resolveOwidTable } from '@avm/shared';

const topics = process.argv.slice(2);
for (const topic of topics) {
  const table = await resolveOwidTable(topic);
  if (!table) { console.log(`  ${topic}  ->  (nothing)`); continue; }
  const years = table.rows.map((r) => r.year);
  console.log(`  ${topic}\n     -> ${table.slug}  "${table.title}"  rows=${table.rows.length}  years=${Math.min(...years)}..${Math.max(...years)}`);
}