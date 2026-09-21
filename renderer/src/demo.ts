import type { VideoInput } from '@avm/shared';

/** Placeholder so Remotion Studio always has something valid to render. */
export function demoInput(): VideoInput {
  return {
    version: '1.0',
    title: 'Data Race',
    metric: 'World Population',
    unit: 'people',
    observations: [
      { entity: 'India', date: '1900', value: 100 },
      { entity: 'China', date: '1900', value: 90 },
    ],
  };
}