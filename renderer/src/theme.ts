/**
 * Visual identity.
 *
 * Deliberately original: a clean white canvas, one accent red, big black
 * headline type and generous spacing. Entity logos are rendered as monogram
 * badges in the entity's own colour, so no third-party artwork is embedded and
 * no copyrighted asset has to be shipped.
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
  background: '#ffffff',
  surface: '#f4f5f7',
  primaryText: '#111827',
  secondaryText: '#6b7280',
  mutedText: '#c8ccd4',
  accent: '#e11d2e',
  barTrack: '#eef0f3',
  fontFamily: 'Inter, "Segoe UI", system-ui, -apple-system, sans-serif',
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