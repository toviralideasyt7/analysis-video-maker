import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, compactNumber, formatValue, makeTheme } from '../src/theme';

describe('theme', () => {
  it('keeps defaults and applies overrides', () => {
    const theme = makeTheme({ accent: '#00aa88', background: '#000000', fontFamily: 'Test' });
    expect(theme.accent).toBe('#00aa88');
    expect(theme.background).toBe('#000000');
    expect(theme.surface).toBe(DEFAULT_THEME.surface);
  });

  it('ignores numeric overrides that are not colours used as strings', () => {
    const theme = makeTheme({ background: 12345 });
    expect(theme.background).toBe(DEFAULT_THEME.background);
  });
});

describe('formatting', () => {
  it('formats percentages with two decimals', () => {
    expect(formatValue(38.0512, 'percent')).toBe('38.05%');
  });

  it('compacts large counts', () => {
    expect(compactNumber(1_205_000_000)).toBe('1.21 B');
    expect(compactNumber(411_912_956)).toBe('411.9 M');
    expect(compactNumber(259_700)).toBe('259.7 K');
    expect(compactNumber(1841)).toBe('1.8 K');
  });

  it('is stable for non-finite input', () => {
    expect(formatValue(Number.NaN, 'count')).toBe('-');
  });
});