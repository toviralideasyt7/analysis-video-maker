/** Shared date key logic (mirrors renderer/src/tape.ts). */

export function dateKey(date: string): number {
  const match = /^(-?\d{1,6})(?:-(\d{1,2}))?/.exec(date.trim());
  if (!match) return Number.NaN;
  return Number(match[1]) * 100 + (match[2] ? Number(match[2]) : 0);
}