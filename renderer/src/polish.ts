/**
 * Shared visual settings + helpers for the reference look, tuned so the video
 * reads like a top-tier data-race channel rather than a debug chart.
 */

export const VISUAL = {
  background: '#f2f1ee',
  titleColor: '#141414',
  valueColor: '#141414',
  nameColorLight: '#FFFFFF',
  nameColorDark: '#141414',
  factHeading: '#141414',
  factBody: '#6E6E6E',
  yearColor: '#C7C7C7',
  panelMetric: '#B4B4B4',
  logo: '#E1251B',
  /** Longest bar ends here on a 1280 canvas (measured from the reference). */
  maxBarX: 1024,
  rowPitch: 42,
  barHeight: 38,
  rowsTop: 66,
  /** Weeks per frame when secondsPerYear is interpreted as pacing. */
} as const;

/** The reference eases bar motion with a light overshoot near period ends. */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** Subtle scale-in used when a bar enters the top N. */
export function enterScale(progress: number): number {
  return 0.92 + 0.08 * Math.min(1, Math.max(0, progress));
}

/** True when the hex colour is dark enough to need white text on top. */
export function isDarkColor(hex: string): boolean {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return false;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b < 150;
}