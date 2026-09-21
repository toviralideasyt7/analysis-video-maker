/**
 * Render CLI.
 *
 *   npx tsx src/render.ts --input <video-input.json> --out <file.mp4> [--thumbnail-only]
 *
 * The user file is validated against the shared schema, the tape is built from
 * it, and Remotion renders. One file in, one MP4 out.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { bundle } from '@remotion/bundler';
import { ensureBrowser, renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { validateVideoInput, type VideoInput } from '@avm/shared';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const inputPath = arg('input');
  if (!inputPath || !existsSync(inputPath)) {
    process.stderr.write('usage: tsx src/render.ts --input <video-input.json> --out <file.mp4> [--thumbnail-only]\n');
    process.exit(2);
  }
  const out = arg('out') ? resolve(arg('out') as string) : resolve('out.mp4');
  const input = JSON.parse(readFileSync(resolve(inputPath), 'utf8')) as VideoInput;

  const check = validateVideoInput(input);
  if (!check.valid) {
    process.stderr.write(`video input failed validation:\n - ${check.errors.join('\n - ')}\n`);
    process.exit(1);
  }

  mkdirSync(dirname(out), { recursive: true });
  const entry = resolve(import.meta.dirname ?? __dirname, 'index.ts');
  process.stdout.write(`bundling ${entry}\n`);
  const bundleLocation = await bundle({ entryPoint: entry, enableCaching: false });
  await ensureBrowser();
  const props = { input };

  // Render a single frame of the main composition - a fast way to review the
  // layout without paying for a full render.
  const stillArg = process.argv.indexOf('--still');
  if (stillArg >= 0) {
    const requested = Number(process.argv[stillArg + 1]);
    const composition = await selectComposition({ serveUrl: bundleLocation, id: 'DataRace', inputProps: props });
    const frame = Number.isFinite(requested) ? Math.max(0, Math.min(composition.durationInFrames - 1, Math.round(requested))) : Math.round(composition.durationInFrames * 0.5);
    const jpg = out.replace(/\.mp4$/, '.jpg');
    await renderStill({ composition, serveUrl: bundleLocation, output: jpg, inputProps: props, imageFormat: 'jpeg', jpegQuality: 92, frame });
    process.stdout.write(`still: ${jpg} (frame ${frame}/${composition.durationInFrames})\n`);
    return;
  }

  if (process.argv.includes('--thumbnail-only')) {
    const composition = await selectComposition({ serveUrl: bundleLocation, id: 'Thumbnail', inputProps: props });
    const png = out.replace(/\.mp4$/, '.jpg');
    await renderStill({ composition, serveUrl: bundleLocation, output: png, inputProps: props, imageFormat: 'jpeg', jpegQuality: 92 });
    process.stdout.write(`thumbnail: ${png}\n`);
    return;
  }

  const composition = await selectComposition({ serveUrl: bundleLocation, id: 'DataRace', inputProps: props });
  process.stdout.write(`rendering ${composition.durationInFrames} frames @ ${composition.fps}fps\n`);
  await renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec: 'h264',
    outputLocation: out,
    inputProps: props,
    // Never exceed the machine's core count: Remotion rejects a concurrency
    // above it, which is exactly what a 2-core CI runner does to a fixed 3.
    concurrency: Math.max(1, Math.min(Number(process.env.RENDER_CONCURRENCY ?? 2), cpus().length)),
    onProgress: ({ renderedFrames }) => {
      if (renderedFrames % 300 === 0) process.stdout.write(`  ${renderedFrames}/${composition.durationInFrames}\n`);
    },
  });
  writeFileSync(
    join(dirname(out), 'render-manifest.json'),
    JSON.stringify({ renderedAt: new Date().toISOString(), out, title: input.title }, null, 2),
  );
  process.stdout.write(`video: ${out}\n`);
}

main().catch((error) => {
  process.stderr.write(`render failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
