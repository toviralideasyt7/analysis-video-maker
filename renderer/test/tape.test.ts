import { describe, expect, it } from 'vitest';
import { buildTape, dateKey, dateLabel } from '../src/tape';
import type { VideoInput } from '@avm/shared';

const input: VideoInput = {
  version: '1.0',
  title: 'Test',
  metric: 'World Population',
  unit: 'people',
  observations: [
    { entity: 'India', date: '1900', value: 100 },
    { entity: 'China', date: '1900', value: 90 },
    { entity: 'India', date: '1901', value: 200 },
    { entity: 'China', date: '1901', value: 180 },
    { entity: 'India', date: '1902', value: 400 },
    { entity: 'China', date: '1902', value: 200 },
  ],
  entities: [
    { id: 'india', name: 'India', color: '#F15A22', flagCode: 'in', group: 'asia' },
    { id: 'china', name: 'China', color: '#E8241F', flagCode: 'cn', group: 'asia' },
  ],
  groups: [{ id: 'asia', label: 'Asia', color: '#E1251B' }],
  facts: [{ atDate: '1901', heading: 'A century turns', body: 'Growth accelerates.' }],
};

describe('tape', () => {
  it('runs one continuous timeline at the reference geometry', () => {
    const tape = buildTape(input);
    expect(tape.fps).toBe(60);
    expect(tape.topN).toBe(15);
    expect(tape.durationInFrames).toBeGreaterThan(60);
    expect(tape.dates).toEqual(['1900', '1901', '1902']);
  });

  it('interpolates values smoothly between years', () => {
    const tape = buildTape(input, { secondsPerYear: 1, introSeconds: 0, outroSeconds: 0 });
    const mid = tape.frames[Math.round(tape.frames.length / 2)];
    const india = mid.bars.find((b) => b.entityId === 'india');
    expect(india?.value).toBeGreaterThanOrEqual(100);
    expect(india?.value).toBeLessThanOrEqual(400);
  });

  it('compresses bar length with the power scale', () => {
    const tape = buildTape(input);
    const first = tape.frames[tape.introFrames];
    const [top, second] = first.bars;
    expect(top.value / second.value).toBeCloseTo(100 / 90, 5);
    expect(top.widthFraction / second.widthFraction).toBeCloseTo(
      Math.pow(top.value / second.value, tape.scalePower),
      5,
    );
  });

  it('ticks the date label in whole years only', () => {
    const tape = buildTape(input, { secondsPerYear: 1, introSeconds: 0, outroSeconds: 0 });
    const labels = new Set(tape.frames.map((f) => f.dateLabel));
    expect(labels).toEqual(new Set(['1900', '1901', '1902']));
  });

  it('shows the fact from its date until the next fact', () => {
    const tape = buildTape(input, { secondsPerYear: 1, introSeconds: 0, outroSeconds: 0 });
    const shownAtSomeFrame = tape.frames.some((f) => f.factIndex === 0);
    expect(shownAtSomeFrame).toBe(true);
    const before = tape.frames[0];
    expect(before.factIndex === null || before.factIndex === 0).toBe(true);
  });

  it('sums groups per frame', () => {
    const tape = buildTape(input);
    const first = tape.frames[tape.introFrames];
    expect(first.groups[0].value).toBeCloseTo(190, 5);
  });

  it('parses negative years for bC labels', () => {
    expect(dateKey('-3000')).toBe(-300000);
    expect(dateLabel('-3000')).toBe('3000 bC');
  });
});