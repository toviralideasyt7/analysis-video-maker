/**
 * Composition input contract.
 *
 * A render needs three files produced by the orchestrator:
 *   video-spec.json  (VideoSpec)      - what to show
 *   dataset.json     (Dataset)        - the verified observations and provenance
 *   frames.json      (FrameTape)      - the pre-computed per-frame bar state
 */

import type { Dataset, ThumbnailSpec, VideoSpec } from '@avm/shared';
import type { FrameTape } from './frameTape';

export interface RenderInput {
  videoSpec: VideoSpec;
  dataset: Dataset;
  frameTape: FrameTape;
  thumbnail?: ThumbnailSpec;
  /** Base URL for entity flags; `{code}` is replaced by the ISO-3166 alpha-2 code. */
  flagBaseUrl?: string;
}

export const DEFAULT_FLAG_BASE = 'https://flagcdn.com/w80';