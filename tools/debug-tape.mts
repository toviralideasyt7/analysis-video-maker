import { readFileSync } from 'node:fs';
import { buildTape } from '../renderer/src/tape';
import type { VideoInput } from '@avm/shared';

const input = JSON.parse(readFileSync(process.argv[2], 'utf8')) as VideoInput;
const tape = buildTape(input);
console.log('topN=' + tape.topN + ' duration=' + tape.durationInFrames + ' intro=' + tape.introFrames + ' dates=' + tape.dates.length);
console.log('facts: ' + tape.facts.length);
for (const f of tape.facts) console.log('  ' + f.fromFrame + '-' + f.toFrame + '  ' + f.heading);
for (const frame of [500, 5000, 20000, 28800, 34500, 35000]) {
  const fd = tape.frames[frame];
  if (!fd) { console.log(frame + ': no frame'); continue; }
  const top = fd.bars.slice(0, 14).map((b) => b.rank + ':' + b.slot.toFixed(2) + '=' + Math.round(b.value)).join(' ');
  console.log('frame ' + frame + ' label=' + fd.dateLabel + ' bars=' + fd.bars.length + ' total=' + Math.round(fd.worldTotal ?? 0));
  console.log('   ' + top);
  console.log('   factIndex=' + fd.factIndex);
}