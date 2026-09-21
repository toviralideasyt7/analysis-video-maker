/** Thumbnail composition, built from the same design tokens as the video. */

import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { makeTheme } from './theme';
import type { RenderInput } from './types';
import { BrandMark, LogoBadge } from './components';

export const Thumbnail: React.FC<{ input: RenderInput }> = ({ input }) => {
  const frame = useCurrentFrame();
  const theme = makeTheme(input.videoSpec.theme as Record<string, string | number>);
  const spec = input.thumbnail;
  const appear = interpolate(frame, [0, 8], [0, 1], { extrapolateRight: 'clamp' });
  const entities = (spec?.entities ?? []).slice(0, 3);
  const tapeEntities = input.frameTape.entities;

  return (
    <AbsoluteFill style={{ background: spec?.backgroundColor ?? theme.background, fontFamily: theme.fontFamily }}>
      <div style={{ position: 'absolute', left: 46, top: 40 }}>
        <BrandMark theme={theme} />
      </div>
      <div style={{ position: 'absolute', left: 46, top: 150, width: 900, opacity: appear }}>
        <div style={{ fontSize: 92, fontWeight: 900, color: theme.primaryText, letterSpacing: '-0.04em', lineHeight: 0.98 }}>
          {spec?.title ?? input.videoSpec.metadata.title.toUpperCase()}
        </div>
        <div style={{ fontSize: 54, fontWeight: 800, color: spec?.accentColor ?? theme.accent, letterSpacing: '-0.02em', marginTop: 10 }}>
          {spec?.subtitle ?? input.videoSpec.metadata.subtitle ?? ''}
        </div>
      </div>
      <div style={{ position: 'absolute', left: 46, bottom: 70, display: 'flex', gap: 20, opacity: appear }}>
        {entities.map((name, index) => {
          const entity = tapeEntities.find((e) => e.name === name);
          return <LogoBadge key={name} name={name} color={entity?.color ?? ['#2563eb', '#dc2626', '#059669'][index % 3]} size={74} />;
        })}
      </div>
      <div style={{ position: 'absolute', right: 46, bottom: 60, textAlign: 'right', opacity: appear }}>
        <div style={{ fontSize: 26, fontWeight: 800, color: theme.secondaryText }}>{input.dataset.metric}</div>
        <div style={{ fontSize: 44, fontWeight: 900, color: theme.primaryText }}>
          {input.dataset.timeRange.start}–{input.dataset.timeRange.end}
        </div>
      </div>
    </AbsoluteFill>
  );
};