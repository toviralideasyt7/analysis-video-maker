import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import type { VideoInput } from '@avm/shared';
import { buildTape } from './tape';

export const Thumbnail: React.FC<{ input: VideoInput }> = ({ input }) => {
  const frame = useCurrentFrame();
  const appear = interpolate(frame, [0, 5], [0, 1], { extrapolateRight: 'clamp' });
  const tape = buildTape(input);
  const last = tape.frames[tape.frames.length - 1];
  const top = (last?.bars ?? []).slice(0, 3);
  const byId = new Map(tape.entities.map((e) => [e.id, e]));

  return (
    <AbsoluteFill style={{ background: '#EFEFEF', fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif' }}>
      <div style={{ position: 'absolute', left: 8, top: 5, width: 58, height: 58, borderRadius: '50%', background: '#E1251B' }} />
      <div style={{ position: 'absolute', left: 60, top: 190, width: 1150, opacity: appear }}>
        <div style={{ fontSize: 96, fontWeight: 900, color: '#1A1A1A', letterSpacing: '-0.03em', lineHeight: 1 }}>
          {input.title.toUpperCase()}
        </div>
      </div>
      <div style={{ position: 'absolute', left: 60, bottom: 80, display: 'flex', gap: 18, opacity: appear }}>
        {top.map((bar, index) => {
          const entity = byId.get(bar.entityId);
          return (
            <div key={bar.entityId} style={{ width: 190, height: 120, background: entity?.color ?? '#333', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 900, fontSize: 30 }}>
              {entity?.name ?? bar.entityId}
            </div>
          );
        })}
      </div>
      <div style={{ position: 'absolute', right: 60, bottom: 80, textAlign: 'right', opacity: appear }}>
        <div style={{ fontSize: 30, fontWeight: 800, color: '#7C7C7C' }}>{input.metric}</div>
        <div style={{ fontSize: 60, fontWeight: 900, color: '#1A1A1A' }}>{tape.dates[tape.dates.length - 1]}</div>
      </div>
    </AbsoluteFill>
  );
};