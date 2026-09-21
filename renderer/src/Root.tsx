import React from 'react';
import { Composition } from 'remotion';
import { ReferenceRace } from './ReferenceRace';
import { Thumbnail } from './Thumbnail';
import type { VideoInput } from '@avm/shared';
import { demoInput } from './demo';
import { buildTape } from './tape';

/**
 * One composition driven by the user file. `calculateMetadata` derives the
 * duration, fps and canvas from the input, so the user file is the single
 * source of truth.
 */
export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="DataRace"
      component={ReferenceRace}
      durationInFrames={300}
      fps={60}
      width={1280}
      height={720}
      defaultProps={{ input: demoInput() }}
      calculateMetadata={({ props }) => {
        const input = (props as { input?: VideoInput }).input;
        if (!input) return {};
        const tape = buildTape(input);
        return {
          durationInFrames: tape.durationInFrames,
          fps: tape.fps,
          width: tape.width,
          height: tape.height,
        };
      }}
    />
    <Composition
      id="Thumbnail"
      component={Thumbnail}
      durationInFrames={1}
      fps={60}
      width={1280}
      height={720}
      defaultProps={{ input: demoInput() }}
      calculateMetadata={({ props }) => {
        const input = (props as { input?: VideoInput }).input;
        if (!input) return {};
        const tape = buildTape(input);
        return { width: tape.width, height: tape.height };
      }}
    />
  </>
);