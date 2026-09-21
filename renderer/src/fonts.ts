/**
 * Load Inter at render time via Remotion's Google Fonts helper.
 *
 * This is what makes the video look typeset rather than default-browser: the
 * reference uses a heavy geometric sans, and Inter at weight 700/800 with
 * tabular numerals is the closest freely-licensable match. The call is
 * idempotent and failures are non-fatal (the render still works with the
 * fallback stack).
 */

import { staticFile } from 'remotion';

declare module 'remotion' {
  // continue; the type is provided by @remotion/google-fonts at runtime
}

let done = false;

export function loadFont(): void {
  if (done) return;
  done = true;
  try {
    // Loaded lazily so environments without the package still render.
    void import('@remotion/google-fonts/Inter')
      .then(({ loadFont: loadInter }) => loadInter('normal', { weights: ['400', '600', '700', '800', '900'] }))
      .catch(() => undefined);
  } catch {
    void staticFile;
  }
}