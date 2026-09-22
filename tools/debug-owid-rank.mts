import { searchOwidCharts } from '@avm/shared';

const topic = process.argv[2] ?? 'world population by country';
const charts = await searchOwidCharts(topic);
const words = (v: string) => v.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
const stop = new Set(['the', 'and', 'per', 'for', 'with', 'from', 'by', 'of', 'in', 'to', 'a', 'total']);
const tokens = words(topic).filter((t) => !stop.has(t));
const topicPhrase = words(topic).join(' ');
const score = (title: string): [number, number, number] => {
  const tw = words(title);
  const tp = tw.join(' ');
  const exact = topicPhrase.includes(tp) || tp.includes(topicPhrase) ? 1 : 0;
  const overlap = tokens.reduce((s, t) => s + (tw.includes(t) ? 1 : 0), 0);
  return [exact, overlap, -tw.length];
};
console.log('tokens', tokens.join(','), '| phrase', topicPhrase);
for (const chart of charts) {
  const s = score(chart.title);
  console.log(`  [${s.join(',')}] ${chart.type.padEnd(13)} ${chart.title}  -> ${chart.slug}`);
}