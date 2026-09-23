import { bundle } from '@remotion/bundler';
import { ensureBrowser, renderStill, selectComposition } from '@remotion/renderer';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const projectDir = resolve(process.argv[2]);
const outDir = resolve(process.argv[3]);
const frames = process.argv.slice(4).map(Number);
mkdirSync(outDir, { recursive: true });

const readJson = <T,>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const input = {
  videoSpec: readJson(join(projectDir, 'video-spec.json')),
  dataset: readJson(join(projectDir, 'dataset.json')),
  frameTape: readJson(join(projectDir, 'frames.json')),
  thumbnail: existsSync(join(projectDir, 'thumbnail.json')) ? readJson(join(projectDir, 'thumbnail.json')) : undefined,
  story: existsSync(join(projectDir, 'story.json')) ? readJson(join(projectDir, 'story.json')) : undefined,
};
// embed flagDataUri already in frames.json entities; skip flag fetching
const bundleLocation = await bundle({ entryPoint: resolve('src/index.ts'), onProgress: () => {} });
await ensureBrowser();
const composition = await selectComposition({ serveUrl: bundleLocation, id: 'DataRace', inputProps: { input } });
console.log('duration:', composition.durationInFrames, 'fps:', composition.fps);
for (const f of frames) {
  const out = join(outDir, `frame-${f}.png`);
  await renderStill({ composition, serveUrl: bundleLocation, output: out, inputProps: { input }, imageFormat: 'png', frame: Math.min(f, composition.durationInFrames - 1) });
  console.log('still:', out);
}
process.exit(0);
