/**
 * Turns a VideoInput into the exact per-frame state of a data-race video that
 * matches the reference animation.
 *
 * What the reference does (measured from frames of
 * "World Population by Country | 10,000 BC - 2026", 1280x720 @ 60fps):
 *
 *  - one continuous timeline; values interpolate between years, never step;
 *  - ranks re-sort smoothly - a bar slides vertically to its new position;
 *  - the date label ticks in whole years (1875 -> 1876), never a fraction;
 *  - bar length uses a compressed scale (power ~0.8), so a 24x difference in
 *    value reads as a ~13x difference in length and the tail stays legible;
 *  - 15 rows, bar height 38-40px on a 42px pitch, starting at y=64;
 *  - the world total, the group series and the fact panel follow the same clock.
 */

import type { VideoInput, VideoInputEntity, VideoInputFact } from '@avm/shared';

export interface TapeBar {
  entityId: string;
  value: number;
  rank: number;
  widthFraction: number;
  held: boolean;
}

export interface TapeFrame {
  index: number;
  dateLabel: string;
  t: number;
  bars: TapeBar[];
  worldTotal: number | null;
  groups: Array<{ id: string; label: string; value: number; color: string }>;
  factIndex: number | null;
}

export interface Tape {
  version: '1.0';
  fps: number;
  width: number;
  height: number;
  topN: number;
  scalePower: number;
  introFrames: number;
  outroFrames: number;
  durationInFrames: number;
  dates: string[];
  dateLabels: string[];
  entities: Array<{
    id: string;
    name: string;
    color: string;
    flagCode?: string | null;
    logoUrl?: string | null;
    group?: string | null;
  }>;
  frames: TapeFrame[];
  facts: Array<{ heading: string; body?: string; tiles: string[]; fromFrame: number; toFrame: number }>;
  notes: string[];
}

export const REFERENCE = {
  width: 1280,
  height: 720,
  fps: 60,
  topN: 15,
  rowPitch: 42,
  barHeight: 38,
  maxBarX: 1125,
  scalePower: 0.8,
  secondsPerYear: 0.4,
  introSeconds: 2.5,
  outroSeconds: 4,
  backgroundColor: '#efefef',
} as const;

interface Series {
  entityId: string;
  values: Array<number | null>;
}

export function dateKey(date: string): number {
  const match = /^(-?\d{1,6})(?:-(\d{1,2}))?/.exec(date.trim());
  if (!match) return Number.NaN;
  return Number(match[1]) * 100 + (match[2] ? Number(match[2]) : 0);
}

export function dateLabel(date: string): string {
  const trimmed = date.trim();
  const match = /^(-?\d{1,6})(?:-\d{1,2})?/.exec(trimmed);
  if (!match) return trimmed;
  const year = Number(match[1]);
  return year < 0 ? `${Math.abs(year)} bC` : String(year);
}

export function normalizeEntityKey(value: string): string {
  return value.trim().toLowerCase();
}

function buildSeries(input: VideoInput, entityId: string, dates: string[]): Series {
  const byDate = new Map<string, number>();
  for (const obs of input.observations) {
    if (normalizeEntityKey(obs.entity) === normalizeEntityKey(entityId)) {
      byDate.set(String(dateKey(obs.date)), obs.value);
    }
  }
  return { entityId, values: dates.map((d) => byDate.get(String(dateKey(d))) ?? null) };
}

const PALETTE = [
  '#F15A22', '#E8241F', '#1F7A46', '#00A24B', '#B31B24', '#FFD617', '#1F8A44',
  '#9E1D22', '#0F6B3C', '#8C1A1E', '#12652F', '#1B3F9E', '#E01B24', '#2E6FDB',
  '#C2410C', '#0E7490', '#7C3AED', '#B45309', '#15803D', '#BE123C',
];

function defaultColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

const FLAG_GUESS: Record<string, string> = {
  india: 'in', china: 'cn', 'united states': 'us', usa: 'us', indonesia: 'id', pakistan: 'pk',
  brazil: 'br', nigeria: 'ng', bangladesh: 'bd', russia: 'ru', mexico: 'mx', japan: 'jp',
  ethiopia: 'et', philippines: 'ph', egypt: 'eg', vietnam: 'vn', 'dr congo': 'cd', turkey: 'tr',
  iran: 'ir', germany: 'de', thailand: 'th', 'united kingdom': 'gb', france: 'fr', italy: 'it',
  'south africa': 'za', myanmar: 'mm', kenya: 'ke', 'south korea': 'kr', colombia: 'co',
  spain: 'es', argentina: 'ar', ukraine: 'ua', sudan: 'sd', uganda: 'ug', iraq: 'iq',
  afghanistan: 'af', poland: 'pl', canada: 'ca', morocco: 'ma', 'saudi arabia': 'sa',
  peru: 'pe', malaysia: 'my', ghana: 'gh', australia: 'au', taiwan: 'tw', 'sri lanka': 'lk',
  romania: 'ro', chile: 'cl', netherlands: 'nl', belgium: 'be', czechia: 'cz', sweden: 'se',
  portugal: 'pt', greece: 'gr', hungary: 'hu', israel: 'il', switzerland: 'ch', austria: 'at',
  'north korea': 'kp', syria: 'sy', cambodia: 'kh', senegal: 'sn', zambia: 'zm', mali: 'ml',
  niger: 'ne', chad: 'td', somalia: 'so', zimbabwe: 'zw', angola: 'ao', mozambique: 'mz',
};

function guessFlagCode(name: string): string | null {
  return FLAG_GUESS[name.trim().toLowerCase()] ?? null;
}

export interface TapeOptions {
  fps?: number;
  width?: number;
  height?: number;
  topN?: number;
  scalePower?: number;
  secondsPerYear?: number;
  introSeconds?: number;
  outroSeconds?: number;
}

export function buildTape(input: VideoInput, options: TapeOptions = {}): Tape {
  const notes: string[] = [];
  const fps = options.fps ?? input.canvas?.fps ?? REFERENCE.fps;
  const width = options.width ?? input.canvas?.width ?? REFERENCE.width;
  const height = options.height ?? input.canvas?.height ?? REFERENCE.height;
  const topN = options.topN ?? input.settings?.topN ?? REFERENCE.topN;
  const scalePower = options.scalePower ?? input.settings?.scalePower ?? REFERENCE.scalePower;
  const secondsPerYear = options.secondsPerYear ?? input.settings?.secondsPerYear ?? REFERENCE.secondsPerYear;
  const introSeconds = options.introSeconds ?? input.settings?.introSeconds ?? REFERENCE.introSeconds;
  const outroSeconds = options.outroSeconds ?? input.settings?.outroSeconds ?? REFERENCE.outroSeconds;

  const allDates = Array.from(new Set(input.observations.map((o) => o.date.trim())));
  const dates = allDates.filter((d) => Number.isFinite(dateKey(d))).sort((a, b) => dateKey(a) - dateKey(b));
  const skipped = allDates.length - dates.length;
  if (skipped > 0) notes.push(`${skipped} observation dates could not be parsed and were dropped`);
  if (dates.length === 0) throw new Error('no usable dates in observations');

  const labels = dates.map((d) => dateLabel(d));

  const entityById = new Map<string, VideoInputEntity>();
  const entityByName = new Map<string, VideoInputEntity>();
  for (const entity of input.entities ?? []) {
    entityById.set(normalizeEntityKey(entity.id), entity);
    entityByName.set(normalizeEntityKey(entity.name), entity);
  }
  const resolveEntity = (key: string): VideoInputEntity =>
    entityById.get(normalizeEntityKey(key)) ??
    entityByName.get(normalizeEntityKey(key)) ?? {
      id: key.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name: key.trim(),
    };

  const observedEntities = Array.from(new Set(input.observations.map((o) => o.entity)));
  const entitiesMeta = observedEntities.map((key) => {
    const entity = resolveEntity(key);
    return {
      id: entity.id,
      name: entity.name,
      color: entity.color ?? defaultColor(entity.id),
      flagCode: entity.flagCode === undefined ? guessFlagCode(entity.name) : entity.flagCode,
      logoUrl: entity.logoUrl ?? null,
      group: entity.group ?? null,
    };
  });
  const metaByKey = new Map(entitiesMeta.map((m) => [normalizeEntityKey(m.id), m]));
  const metaByName = new Map(entitiesMeta.map((m) => [normalizeEntityKey(m.name), m]));
  const metaFor = (key: string) => metaByKey.get(normalizeEntityKey(key)) ?? metaByName.get(normalizeEntityKey(key));

  const seriesList: Series[] = observedEntities.map((key) => buildSeries(input, key, dates));

  const yearFrames = Math.max(1, Math.round(secondsPerYear * fps));
  const introFrames = Math.max(0, Math.round(introSeconds * fps));
  const outroFrames = Math.max(0, Math.round(outroSeconds * fps));
  const framesPerPeriod = yearFrames;
  const raceFrames = (dates.length - 1) * framesPerPeriod + 1;
  const durationInFrames = introFrames + raceFrames + outroFrames;

  const facts: Tape['facts'] = [];
  const inputFacts: VideoInputFact[] = input.facts ?? [];
  const frameForDate = (target: number, fallback: number): number => {
    for (let i = 0; i < dates.length; i += 1) {
      if (dateKey(dates[i]) >= target) return introFrames + i * framesPerPeriod;
    }
    return fallback;
  };
  inputFacts.forEach((fact, index) => {
    const key = dateKey(fact.atDate);
    const fromFrame = frameForDate(key, introFrames + raceFrames);
    const next = inputFacts[index + 1];
    const toFrame = next ? frameForDate(dateKey(next.atDate), introFrames + raceFrames) : introFrames + raceFrames;
    if (fromFrame < toFrame) {
      facts.push({ heading: fact.heading, body: fact.body ?? '', tiles: fact.tiles ?? [], fromFrame, toFrame });
    }
  });

  const worldByDate = new Map<string, number>();
  if (input.worldTotal && input.worldTotal.length > 0) {
    for (const point of input.worldTotal) worldByDate.set(String(dateKey(point.date)), point.value);
  }

  const groupDefs = (input.groups ?? []).map((g, index) => ({
    id: g.id,
    label: g.label,
    color: g.color ?? defaultColor(`group-${index}`),
  }));

  const frames: TapeFrame[] = [];
  let heldNotes = 0;

  for (let frame = 0; frame < durationInFrames; frame += 1) {
    const racePos = frame - introFrames;
    const clampedRace = Math.max(0, Math.min(raceFrames - 1, racePos));
    const periodIndex = Math.min(dates.length - 1, Math.floor(clampedRace / framesPerPeriod));
    const t = periodIndex >= dates.length - 1 ? 1 : (clampedRace - periodIndex * framesPerPeriod) / framesPerPeriod;

    const bars: TapeBar[] = [];
    for (const series of seriesList) {
      const meta = metaFor(series.entityId);
      const a = series.values[periodIndex];
      const b = periodIndex + 1 < series.values.length ? series.values[periodIndex + 1] : undefined;
      let value: number;
      let held = false;
      if (a === null && (b === null || b === undefined)) continue;
      if (a === null) {
        value = b as number;
        held = true;
      } else if (b === undefined || b === null) {
        value = a;
      } else {
        // Ease inside the transition: the reference never moves linearly; values
        // glide with a slight ease-out so each year lands with a settle.
        const eased = t * t * (3 - 2 * t); // smoothstep
        value = a + (b - a) * eased;
      }
      if (held) heldNotes += 1;
      bars.push({ entityId: meta?.id ?? series.entityId, value, rank: 0, widthFraction: 0, held });
    }

    bars.sort((x, y) => y.value - x.value || x.entityId.localeCompare(y.entityId));
    bars.forEach((bar, index) => {
      bar.rank = index + 1;
    });

    const maxValue = bars.length > 0 ? bars[0].value : 0;
    for (const bar of bars) {
      const ratio = maxValue > 0 ? bar.value / maxValue : 0;
      bar.widthFraction = Math.pow(ratio, scalePower);
    }

    const worldTotal = worldByDate.get(String(dateKey(dates[periodIndex]))) ?? sumOf(bars);

    const groups = groupDefs.map((group) => {
      let value = 0;
      for (const series of seriesList) {
        const meta = metaFor(series.entityId);
        if (!meta || meta.group !== group.id) continue;
        const a = series.values[periodIndex];
        const b = periodIndex + 1 < series.values.length ? series.values[periodIndex + 1] : undefined;
        if (a === null && (b === null || b === undefined)) continue;
        const valueHere = a === null ? (b as number) : b === undefined || b === null ? a : a + ((b as number) - a) * t;
        value += valueHere;
      }
      return { id: group.id, label: group.label, value, color: group.color };
    });

    let factIndex: number | null = null;
    for (let i = 0; i < facts.length; i += 1) {
      if (frame >= facts[i].fromFrame && frame < facts[i].toFrame) {
        factIndex = i;
        break;
      }
    }

    frames.push({ index: frame, dateLabel: labels[periodIndex], t, bars, worldTotal, groups, factIndex });
  }

  // A group that never has any member data is a definition left in the file
  // with nothing behind it - drop it instead of drawing an empty column.
  const groupTotals = new Map<string, number>();
  for (const frameState of frames) {
    for (const group of frameState.groups) {
      groupTotals.set(group.id, (groupTotals.get(group.id) ?? 0) + group.value);
    }
  }
  for (const frameState of frames) {
    frameState.groups = frameState.groups.filter((g) => (groupTotals.get(g.id) ?? 0) > 0);
  }

  if (heldNotes > 0) {
    notes.push(`${heldNotes} bar-frames carry a held (non-observed) value forward for visual continuity`);
  }

  return {
    version: '1.0',
    fps,
    width,
    height,
    topN,
    scalePower,
    introFrames,
    outroFrames,
    durationInFrames,
    dates,
    dateLabels: labels,
    entities: entitiesMeta,
    frames,
    facts,
    notes,
  };
}

function sumOf(bars: TapeBar[]): number {
  let sum = 0;
  for (const bar of bars) sum += bar.value;
  return sum;
}