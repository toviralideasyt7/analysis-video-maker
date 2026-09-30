/**
 * Visual identity — reference-style DARK theme.
 *
 * Matches the "most popular websites" reference: pure black canvas,
 * white text, brand-colored bars with logos embedded at the bar's left
 * edge, values in white bold right-aligned to the bar end, huge white
 * year bottom-center, and a dark info card on the right with accent
 * border, headline, body, and image.
 */

export interface Theme {
  background: string;
  surface: string;
  primaryText: string;
  secondaryText: string;
  mutedText: string;
  accent: string;
  barTrack: string;
  fontFamily: string;
}

export const DEFAULT_THEME: Theme = {
  background: '#000000',
  surface: '#111111',
  primaryText: '#ffffff',
  secondaryText: '#a0a0a0',
  mutedText: '#555555',
  accent: '#e11d2e',
  barTrack: '#1a1a1a',
  fontFamily: '"Eczar", Georgia, serif',
};

export function makeTheme(overrides: Record<string, string | number> | undefined): Theme {
  if (!overrides) return DEFAULT_THEME;
  const out: Theme = { ...DEFAULT_THEME };
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === 'string' && key in out) {
      (out as unknown as Record<string, string>)[key] = value;
    }
  }
  return out;
}

export function formatValue(value: number, unit: string): string {
  if (!Number.isFinite(value)) return '-';
  if (unit === 'percent') return `${value.toFixed(2)}%`;
  return compactNumber(value);
}

export function compactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(2)} T`;
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)} B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)} M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)} K`;
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  return value.toFixed(2);
}