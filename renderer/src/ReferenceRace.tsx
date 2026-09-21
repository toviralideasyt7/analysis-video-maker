/**
 * The data-race composition, built to match the reference video frame for frame.
 *
 * Measured from "World Population by Country | 10,000 BC - 2026" (1280x720 @ 60fps):
 *  - background #EFEFEF; red circle logo with a white bar glyph at the top-left;
 *  - title in heavy black next to the logo;
 *  - 15 bar rows on a 42px pitch starting at y=64; bars run FLUSH from x=0 with
 *    square ends and no track or outline;
 *  - inside each bar, right-aligned before the flag: the country name in white;
 *  - the flag sits at the bar end; the value sits AFTER the bar end in black;
 *  - values are full numbers with comma separators, never compacted;
 *  - bar lengths use a compressed (power) scale so the tail stays readable;
 *  - right panel: the current fact (heading + short body + flag tiles), a pale
 *    pie with a thin red wedge, "World Population <total>" and the huge grey year;
 *  - a small vertical chart of the groups (continents) with a glyph per column.
 */

import React, { useMemo } from 'react';
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { VideoInput } from '@avm/shared';
import { buildTape, REFERENCE, type Tape } from './tape';

const FLAG_BASE = 'https://flagcdn.com/w80';

function formatValue(value: number, format: 'comma' | 'compact'): string {
  if (!Number.isFinite(value)) return '0';
  if (format === 'comma') {
    return Math.round(value).toLocaleString('en-US');
  }
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(2)} T`;
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)} B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)} M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)} K`;
  return Math.round(value).toLocaleString('en-US');
}

/** Rough continent silhouettes, drawn in the group colour like the reference. */
const GROUP_GLYPHS: Record<string, string> = {
  asia: 'M4 44 L14 30 L30 24 L46 28 L56 18 L70 22 L74 34 L62 44 L46 50 L28 52 Z',
  america: 'M10 14 L26 8 L38 16 L44 30 L38 46 L28 58 L20 50 L14 34 Z',
  africa: 'M12 8 L34 6 L48 16 L52 32 L42 48 L28 56 L16 44 L8 24 Z',
  europe: 'M6 30 L18 12 L38 8 L54 14 L58 26 L46 34 L30 38 L16 40 Z',
  oceania: 'M10 30 L30 18 L52 22 L60 36 L44 50 L22 50 Z',
};

const GroupGlyph: React.FC<{ id: string; color: string; size: number }> = ({ id, color, size }) => (
  <svg width={size} height={size} viewBox="0 0 64 60" style={{ display: 'block' }}>
    <path d={GROUP_GLYPHS[id.toLowerCase()] ?? GROUP_GLYPHS.asia} fill={color} />
  </svg>
);

const BrandMark: React.FC = () => (
  <div
    style={{
      width: 58,
      height: 58,
      borderRadius: '50%',
      background: '#E1251B',
      display: 'flex',
      alignItems: 'flex-end',
      justifyContent: 'center',
      gap: 4,
      paddingBottom: 15,
      flex: '0 0 auto',
    }}
  >
    {[16, 24, 20].map((height, index) => (
      <div key={index} style={{ width: 5, height, background: '#fff', borderRadius: 1 }} />
    ))}
  </div>
);

const FlagTile: React.FC<{ code?: string | null; width: number; height: number; radius?: number }> = ({ code, width, height, radius = 4 }) => (
  <div style={{ width, height, borderRadius: radius, overflow: 'hidden', background: '#dfe3e8', flex: '0 0 auto' }}>
    {code ? <Img src={`${FLAG_BASE}/${code}.png`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : null}
  </div>
);

const Pie: React.FC<{ fraction: number; size: number }> = ({ fraction, size }) => {
  const clamped = Math.max(0.015, Math.min(0.85, fraction));
  const radius = size / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={radius} cy={radius} r={radius - 1} fill="#F7D6DC" />
      <circle
        cx={radius}
        cy={radius}
        r={radius - 1}
        fill="none"
        stroke="#E0524F"
        strokeWidth={6}
        strokeDasharray={`${circumference * clamped} ${circumference}`}
        transform={`rotate(-90 ${radius} ${radius})`}
      />
    </svg>
  );
};

export const ReferenceRace: React.FC<{ input: VideoInput }> = ({ input }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const tape: Tape = useMemo(() => buildTape(input), [input]);
  if (frame >= tape.durationInFrames) {
    return <AbsoluteFill style={{ background: REFERENCE.backgroundColor }} />;
  }
  return <RaceBody input={input} tape={tape} frame={frame} fps={fps} />;
};

const RaceBody: React.FC<{ input: VideoInput; tape: Tape; frame: number; fps: number }> = ({ input, tape, frame, fps }) => {
  const format = input.valueFormat ?? 'comma';
  const entityById = useMemo(() => new Map(tape.entities.map((e) => [e.id, e])), [tape]);
  const entityByName = useMemo(() => new Map(tape.entities.map((e) => [e.name.toLowerCase(), e])), [tape]);
  const frameData = tape.frames[Math.min(frame, tape.frames.length - 1)];
  const shown = frameData.bars.slice(0, tape.topN);

  // Smooth vertical motion: animated rank per entity, cubic ease over ~9 frames.
  const smoothedRank = useMemo(() => {
    const map = new Map<string, { value: number; target: number; since: number }>();
    const out: Array<Map<string, number>> = [];
    tape.frames.forEach((frameState, index) => {
      for (const bar of frameState.bars.slice(0, tape.topN)) {
        const entry = map.get(bar.entityId);
        if (!entry) {
          map.set(bar.entityId, { value: bar.rank, target: bar.rank, since: index });
          continue;
        }
        if (entry.target !== bar.rank) {
          entry.target = bar.rank;
          entry.since = index;
        }
        const progress = Math.min(1, (index - entry.since) / 9);
        const eased = 1 - (1 - progress) ** 3;
        entry.value += (entry.target - entry.value) * (index === entry.since ? 1 : eased);
      }
      out.push(new Map(Array.from(map.entries()).map(([id, v]) => [id, v.value])));
    });
    return out;
  }, [tape]);

  const rankMap = smoothedRank[Math.min(frame, smoothedRank.length - 1)] ?? new Map<string, number>();
  const appear = spring({ frame: frame - 3, fps, durationInFrames: 16, config: { damping: 200 } });

  const factIndex = frameData.factIndex;
  const fact = factIndex === null ? null : tape.facts[factIndex];
  const worldTotal = frameData.worldTotal ?? 0;
  const topBar = shown[0];
  const leaderShare = worldTotal > 0 && topBar ? topBar.value / worldTotal : 0;

  const compactTotal = formatValue(worldTotal, 'compact');

  return (
    <AbsoluteFill style={{ background: input.settings?.backgroundColor ?? REFERENCE.backgroundColor, fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif', overflow: 'hidden' }}>
      {/* header */}
      <div style={{ position: 'absolute', left: 8, top: 5, display: 'flex', alignItems: 'center', gap: 14, opacity: appear }}>
        <BrandMark />
        <div style={{ fontSize: 40, fontWeight: 800, color: '#1A1A1A', letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>
          {input.title}
        </div>
      </div>

      {/* ranking bars: flush from x=0 */}
      <div style={{ position: 'absolute', left: 0, top: 64, width: '100%' }}>
        {shown.map((bar) => {
          const entity = entityById.get(bar.entityId);
          const animatedRank = rankMap.get(bar.entityId) ?? bar.rank;
          const y = (animatedRank - 1) * REFERENCE.rowPitch;
          const barWidth = Math.max(6, bar.widthFraction * REFERENCE.maxBarX);
          const dark = isDark(entity?.color ?? '#333333');
          return (
            <div key={bar.entityId} style={{ position: 'absolute', left: 0, top: y, height: REFERENCE.barHeight, width: '100%' }}>
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  height: '100%',
                  width: barWidth,
                  background: entity?.color ?? '#333333',
                  opacity: bar.held ? 0.75 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  gap: 8,
                  paddingRight: 6,
                }}
              >
                <div
                  style={{
                    color: dark ? '#1A1A1A' : '#FFFFFF',
                    fontWeight: 700,
                    // Shrink to fit the space between the bar start and the flag,
                    // so a long name stays readable instead of being clipped.
                    fontSize: Math.max(13, Math.min(21, 21 * Math.max(0.62, (barWidth - 66) / (0.56 * (entity?.name ?? bar.entityId).length * 21)))),
                    whiteSpace: 'nowrap',
                  }}
                >
                  {entity?.name ?? bar.entityId}
                </div>
                <FlagTile code={entity?.flagCode} width={45} height={32} />
              </div>
              <div
                style={{
                  position: 'absolute',
                  left: barWidth + 10,
                  top: 0,
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  fontSize: 21,
                  fontWeight: 700,
                  color: '#1A1A1A',
                  fontVariantNumeric: 'tabular-nums',
                  whiteSpace: 'nowrap',
                }}
              >
                {formatValue(bar.value, format)}
              </div>
            </div>
          );
        })}
      </div>

      {/* side panel: fact + pie + world total + year */}
      <div style={{ position: 'absolute', left: 730, top: 235, width: 545 }}>
        {fact ? (
          <div style={{ opacity: interpolate(frame, [fact.fromFrame, Math.min(fact.toFrame, fact.fromFrame + 10)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) }}>
            <div style={{ fontSize: 34, fontWeight: 800, color: '#1A1A1A', textAlign: 'right' }}>{fact.heading}</div>
            {fact.body ? (
              <div style={{ marginTop: 12, fontSize: 26, lineHeight: 1.3, color: '#7C7C7C', textAlign: 'right' }}>{fact.body}</div>
            ) : null}
            {fact.tiles.length > 0 ? (
              <div style={{ display: 'flex', gap: 12, marginTop: 16, justifyContent: 'flex-start' }}>
                {fact.tiles.slice(0, 2).map((tile) => {
                  // Tiles may name an entity by id, display name or flag code.
                  const key = tile.trim().toLowerCase();
                  const entity = entityById.get(key) ?? entityByName.get(key) ?? tape.entities.find((e) => e.flagCode === key);
                  return <FlagTile key={tile} code={entity?.flagCode ?? key} width={95} height={75} radius={6} />;
                })}
              </div>
            ) : null}
          </div>
        ) : null}

        <div style={{ position: 'absolute', top: 245, left: 48, display: 'flex', alignItems: 'center', gap: 18 }}>
          <Pie fraction={leaderShare} size={105} />
          <div>
            <div style={{ fontSize: 34, fontWeight: 800, color: '#1A1A1A' }}>{input.metric}</div>
            <div style={{ fontSize: 58, fontWeight: 800, color: '#B9B9B9', lineHeight: 1.05 }}>{compactTotal}</div>
          </div>
        </div>

        <div
          style={{
            position: 'absolute',
            top: 340,
            right: 0,
            fontSize: 135,
            fontWeight: 800,
            color: '#C2C2C2',
            lineHeight: 1,
            letterSpacing: '-0.02em',
            whiteSpace: 'nowrap',
          }}
        >
          {frameData.dateLabel}
        </div>
      </div>

      {/* mini group chart */}
      {frameData.groups.length > 0 ? (
        <div style={{ position: 'absolute', left: 430, top: 335, width: 335, height: 365, display: 'flex', alignItems: 'flex-end', gap: 18 }}>
          {frameData.groups.map((group) => {
            const max = Math.max(...frameData.groups.map((g) => g.value), 1);
            const h = Math.max(4, (group.value / max) * 210);
            return (
              <div key={group.id} style={{ width: 58, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
                <GroupGlyph id={group.id} color={group.color} size={44} />
                <div style={{ fontSize: 15, fontWeight: 700, color: '#1A1A1A', margin: '6px 0 4px', fontVariantNumeric: 'tabular-nums' }}>
                  {formatValue(group.value, format)}
                </div>
                <div style={{ width: '100%', height: h, background: group.color }} />
                <div style={{ fontSize: 16, fontWeight: 700, color: '#1A1A1A', marginTop: 6, writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
                  {group.label}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {tape.notes.length > 0 && frame < tape.introFrames + 60 ? (
        <div style={{ position: 'absolute', left: 10, bottom: 6, fontSize: 12, color: '#9aa0a6' }}>{tape.notes[0]}</div>
      ) : null}
    </AbsoluteFill>
  );
};

function isDark(hexColor: string): boolean {
  const hex = hexColor.replace('#', '');
  if (hex.length !== 6) return false;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b < 140;
}