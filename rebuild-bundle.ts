/** Rebuild a project's frames.json / story.json / video-spec.json from its dataset.json. */
import { readFileSync, writeFileSync } from 'node:fs';
import { buildFrameTape, deterministicStory, buildVideoSpec } from './services/orchestrator/src/pipeline';

const projectId = process.argv[2];
if (!projectId) {
  console.error('usage: rebuild-bundle.ts <projectId>');
  process.exit(1);
}
const dir = `services/orchestrator/projects/${projectId}`;

async function main() {
  const dataset = JSON.parse(readFileSync(`${dir}/dataset.json`, 'utf8'));
  console.log(`[${projectId}] dataset: ${dataset.observations.length} observations`);

  const tape = await buildFrameTape(dataset, { topN: 10 });
  console.log(`[${projectId}] tape: ${tape.frames.length} frames, ${tape.periodLabels.length} periods, topN=${tape.topN}`);
  console.log(`[${projectId}] last periods: ${tape.periodLabels.slice(-3).join(', ')}`);
  const lastBars = tape.frames[tape.frames.length - 1]?.bars.slice(0, 5) ?? [];
  for (const b of lastBars) {
    const e = tape.entities.find((x) => x.id === b.entityId);
    console.log(`  final #${b.rank} ${e?.name} ${Math.round(b.value).toLocaleString()} held=${b.held}`);
  }

  const story = deterministicStory(dataset, tape);
  console.log(`[${projectId}] story facts: ${story.sequence.length}`);
  for (const s of story.sequence) console.log(`  - ${s.text}`);

  const spec = buildVideoSpec({ dataset, story, tape });
  console.log(`[${projectId}] spec duration: ${(spec.metadata.durationSeconds / 60).toFixed(1)} min`);

  writeFileSync(`${dir}/frames.json`, JSON.stringify(tape));
  writeFileSync(`${dir}/story.json`, JSON.stringify(story, null, 2));
  writeFileSync(`${dir}/video-spec.json`, JSON.stringify(spec, null, 2));
  console.log(`[${projectId}] wrote frames.json / story.json / video-spec.json`);
}

main().catch((e) => {
  console.error('REBUILD FAILED:', e);
  process.exit(1);
});
