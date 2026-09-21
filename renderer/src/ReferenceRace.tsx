/**
 * The data-race composition, matching the dark boxed reference design.
 *
 * Reference layout (reproduced here):
 *  - near-black canvas, white uppercase title with a red circular mark;
 *  - left: ranked bars, each with a rank number, a left inset, the entity name
 *    inside the bar before its logo chip, and the value after the bar end;
 *  - middle-bottom: a vertical chart of the categories, each column capped with
 *    a lettered disc and a value, with rotated labels underneath;
 *  - right: a bordered "DATA NARRATIVE & INSIGHTS" panel holding the fact (big
 *    logo tiles + text, auto-sized to its content) and a "DATA SUMMARY" box
 *    with the metric total and a coloured breakdown of the categories;
 *  - bottom-right: a circular timeline-progress ring and the giant year.
 */

import React, { useMemo } from 'react';
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { VideoInput } from '@avm/shared';
import { buildTape, type Tape } from './tape';
import { isDarkColor } from './polish';
import { loadFont } from './fonts';

loadFont();

const INK = {
  background: '#0B0B0B',
  panel: '#101010',
  border: '#2C2C2C',
  borderSoft: '#232323',
  title: '#FFFFFF',
  text: '#D8D8D8',
  muted: '#8A8A8A',
  faint: '#5A5A5A',
  year: '#6E6E6E',
  logo: '#E1251B',
} as const;

const ROWS_TOP = 76;
const ROW_PITCH = 30;
const BAR_HEIGHT = 26;
const ROWS = 14;
const BAR_LEFT = 52;
const RANK_LEFT = 14;
const MAX_BAR = 700;
const PANEL_LEFT = 924;
const PANEL_WIDTH = 340;

function formatValue(value: number, mode: 'comma' | 'compact'): string {
  if (!Number.isFinite(value)) return '0';
  if (mode === 'comma') {
    // Whole numbers for large magnitudes (population, tonnes); decimals for
    // small-magnitude metrics such as per-capita values.
    const abs = Math.abs(value);
    const decimals = abs >= 1000 ? 0 : abs >= 10 ? 1 : 2;
    return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(2)} T`;
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)} B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)} M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)} K`;
  return String(Math.round(value));
}

function compact(value: number): string {
  return formatValue(value, 'compact');
}

const BrandMark: React.FC = () => (
  <div
    style={{
      width: 46,
      height: 46,
      borderRadius: '50%',
      background: INK.logo,
      display: 'flex',
      alignItems: 'flex-end',
      justifyContent: 'center',
      gap: 3,
      paddingBottom: 12,
      flex: '0 0 auto',
    }}
  >
    {[12, 19, 16].map((h, i) => (
      <div key={i} style={{ width: 4, height: h, background: '#fff', borderRadius: 1 }} />
    ))}
  </div>
);

const LogoChip: React.FC<{ src?: string | null; size: number; fallback: string; chipBg?: string }> = ({ src, size, fallback, chipBg = '#ffffff' }) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: '50%',
      overflow: 'hidden',
      background: chipBg,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: '0 0 auto',
      color: '#111',
      fontWeight: 800,
      fontSize: size * 0.5,
    }}
  >
    {src ? <Img src={src} style={{ width: '76%', height: '76%', objectFit: 'contain' }} /> : fallback}
  </div>
);

const ProgressRing: React.FC<{ progress: number; size: number }> = ({ progress, size }) => {
  const clamped = Math.max(0.005, Math.min(1, progress));
  const r = size / 2 - 5;
  const c = 2 * Math.PI * r;
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#2A2A2A" strokeWidth={5} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="#FFFFFF"
          strokeWidth={5}
          strokeLinecap="round"
          strokeDasharray={`${c * clamped} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: size * 0.3, fontWeight: 800, color: '#FFFFFF' }}></div>
    </div>
  );
};

export const ReferenceRace: React.FC<{ input: VideoInput }> = ({ input }) => {
  const frame = useCurrentFrame();
  const tape: Tape = useMemo(() => buildTape(input), [input]);
  if (frame >= tape.durationInFrames) {
    return <AbsoluteFill style={{ background: INK.background }} />;
  }
  return <RaceBody input={input} tape={tape} frame={frame} />;
};

const RaceBody: React.FC<{ input: VideoInput; tape: Tape; frame: number }> = ({ input, tape, frame }) => {
  const { fps } = useVideoConfig();
  const entityById = useMemo(() => new Map(tape.entities.map((e) => [e.id, e])), [tape]);
  const frameData = tape.frames[Math.min(frame, tape.frames.length - 1)];
  const shown = frameData.bars.slice(0, ROWS);
  const introFrames = tape.introFrames;

  // Smooth vertical motion for rank changes.
  const smoothedRank = useMemo(() => {
    const map = new Map<string, { value: number; target: number; since: number }>();
    const out: Array<Map<string, number>> = [];
    tape.frames.forEach((fs, index) => {
      for (const bar of fs.bars.slice(0, ROWS)) {
        const entry = map.get(bar.entityId);
        if (!entry) {
          map.set(bar.entityId, { value: bar.rank, target: bar.rank, since: index });
          continue;
        }
        if (entry.target !== bar.rank) {
          entry.target = bar.rank;
          entry.since = index;
        }
        const progress = Math.min(1, (index - entry.since) / 10);
        entry.value += (entry.target - entry.value) * (1 - (1 - progress) ** 3);
      }
      out.push(new Map(Array.from(map.entries()).map(([id, v]) => [id, v.value])));
    });
    return out;
  }, [tape]);

  const rankMap = smoothedRank[Math.min(frame, smoothedRank.length - 1)] ?? new Map<string, number>();
  const appear = spring({ frame: frame - 2, fps, durationInFrames: 18, config: { damping: 200 } });

  const fact = frameData.factIndex === null ? null : tape.facts[frameData.factIndex];
  const total = frameData.worldTotal ?? 0;
  const topBar = shown[0];

  const raceStart = introFrames;
  const raceEnd = tape.durationInFrames - tape.outroFrames;
  const progress = raceEnd > raceStart ? Math.max(0, Math.min(1, (frame - raceStart) / (raceEnd - raceStart))) : 1;

  const outroStart = tape.durationInFrames - tape.outroFrames;
  const outroFade =
    frame >= outroStart
      ? interpolate(frame, [outroStart, outroStart + Math.max(8, tape.outroFrames / 2)], [1, 0.15], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
      : 1;

  const breakdown = [...frameData.groups].sort((a, b) => b.value - a.value).slice(0, 5);
  const groupMax = Math.max(...frameData.groups.map((g) => g.value), 1);

  return (
    <AbsoluteFill style={{ background: INK.background, fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif', overflow: 'hidden' }}>
      {/* header */}
      <div style={{ position: 'absolute', left: 14, top: 12, display: 'flex', alignItems: 'center', gap: 12, opacity: appear }}>
        <BrandMark />
        <div style={{ fontSize: 33, fontWeight: 800, color: INK.title, letterSpacing: '0.01em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
          {input.title}
        </div>
      </div>

      {/* ranked bars */}
      <div style={{ position: 'absolute', left: 0, top: ROWS_TOP, width: 720, opacity: frameData.isFinalHold ? 0.3 : outroFade }}>
        {shown.map((bar) => {
          const entity = entityById.get(bar.entityId);
          const name = entity?.name ?? bar.entityId;
          const animatedRank = rankMap.get(bar.entityId) ?? bar.rank;
          const y = (animatedRank - 1) * ROW_PITCH;
          const barWidth = Math.max(10, bar.widthFraction * MAX_BAR);
          const available = Math.max(46, barWidth - 54);
          const nameSize = Math.min(19, Math.max(11, (available / (name.length * 10.4)) * 19));
          const labelColor = isDarkColor(entity?.color ?? '#3A3A3A') ? '#FFFFFF' : '#101010';
          // A short bar cannot hold its own label: the right-aligned name would
          // overflow past the left edge and be clipped (e.g. "Mexico" -> "exico").
          // When it does not fit, draw the label beside the value instead.
          const estimatedLabel = name.length * nameSize * 0.56 + 19 + 14;
          const insideLabel = barWidth >= estimatedLabel;

          return (
            <div key={bar.entityId} style={{ position: 'absolute', left: 0, top: y, height: BAR_HEIGHT, width: '100%' }}>
              <div
                style={{
                  position: 'absolute',
                  left: RANK_LEFT,
                  top: 0,
                  width: 28,
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  fontSize: 15,
                  fontWeight: 700,
                  color: bar.rank <= 3 ? INK.text : INK.muted,
                }}
              >
                {bar.rank}
              </div>
              <div
                style={{
                  position: 'absolute',
                  left: BAR_LEFT,
                  top: 0,
                  height: '100%',
                  width: barWidth,
                  background: entity?.color ?? '#3A3A3A',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  gap: 6,
                  paddingRight: 4,
                  opacity: bar.held ? 0.85 : 1,
                }}
              >
                {insideLabel ? (
                  <>
                    <div style={{ color: labelColor, fontWeight: 700, fontSize: nameSize, whiteSpace: 'nowrap' }}>
                      {name}
                    </div>
                    <LogoChip src={entity?.logoUrl} size={19} fallback={name.slice(0, 1).toUpperCase()} />
                  </>
                ) : null}
              </div>
              <div
                style={{
                  position: 'absolute',
                  left: BAR_LEFT + barWidth + 10,
                  top: 0,
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  fontSize: 16,
                  fontWeight: 700,
                  color: INK.title,
                  fontVariantNumeric: 'tabular-nums',
                  gap: 6,
                  whiteSpace: 'nowrap',
                }}
              >
                {insideLabel ? null : (
                  <>
                    <span style={{ color: INK.text, fontWeight: 700, fontSize: 15 }}>{name}</span>
                    <LogoChip src={entity?.logoUrl} size={17} fallback={name.slice(0, 1).toUpperCase()} />
                  </>
                )}
                {formatValue(bar.value, 'comma')}
              </div>
            </div>
          );
        })}
      </div>

      {/* narrative panel */}
      <div style={{ position: 'absolute', left: PANEL_LEFT, top: 60, width: PANEL_WIDTH, opacity: outroFade }}>
        <div style={{ border: `1px solid ${INK.border}`, borderRadius: 6, background: INK.panel, padding: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.16em', color: INK.text, textAlign: 'center', paddingBottom: 9, borderBottom: `1px solid ${INK.borderSoft}` }}>
            DATA NARRATIVE &amp; INSIGHTS
          </div>

          {fact ? (
            <div style={{ marginTop: 12, border: `1px solid ${INK.border}`, borderRadius: 5, padding: '12px 14px' }}>
              <div style={{ fontSize: 21, fontWeight: 800, color: INK.title, textAlign: 'center', textTransform: 'uppercase', letterSpacing: '0.02em' }}>
                {fact.heading}
              </div>
              {fact.tiles.length > 0 ? (
                <div style={{ display: 'flex', gap: 10, justifyContent: 'center', margin: '12px 0' }}>
                  {fact.tiles.slice(0, 2).map((tile) => {
                    const key = tile.trim().toLowerCase();
                    const entity = entityById.get(key) ?? tape.entities.find((e) => e.name.toLowerCase() === key || e.flagCode === key);
                    return <LogoChip key={tile} src={entity?.logoUrl} size={76} fallback={(entity?.name ?? tile).slice(0, 1).toUpperCase()} />;
                  })}
                </div>
              ) : null}
              {fact.body ? <div style={{ fontSize: 16.5, lineHeight: 1.35, color: INK.text, textAlign: 'center' }}>{fact.body}</div> : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* summary panel */}
      <div style={{ position: 'absolute', left: PANEL_LEFT, top: 330, width: PANEL_WIDTH, opacity: outroFade }}>
        <div style={{ border: `1px solid ${INK.border}`, borderRadius: 6, background: INK.panel, padding: '10px 14px' }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.16em', color: INK.muted, textAlign: 'center' }}>DATA SUMMARY</div>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 12, marginTop: 6 }}>
            <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.1em', color: INK.text }}>{input.metric.toUpperCase()}:</span>
            <span style={{ fontSize: 27, fontWeight: 800, color: INK.title, fontVariantNumeric: 'tabular-nums' }}>{compact(total)}</span>
          </div>
          {breakdown.length > 0 ? (
            <>
              <div style={{ borderTop: `1px solid ${INK.borderSoft}`, margin: '10px 0 8px' }} />
              <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.14em', color: INK.muted, textAlign: 'center' }}>FOCUS CONTEXT BREAKDOWN</div>
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
                {breakdown.map((g, index) => (
                  <div key={g.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 20, height: 20, borderRadius: '50%', background: g.color, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 11 }}>
                      {g.label.slice(0, 1).toUpperCase()}
                    </div>
                    <div style={{ flex: 1, fontSize: 13.5, fontWeight: 600, color: INK.text }}>{g.label}</div>
                    <div
                      style={{
                        minWidth: 78,
                        textAlign: 'right',
                        fontSize: 13.5,
                        fontWeight: 800,
                        color: '#101010',
                        background: g.color,
                        borderRadius: 3,
                        padding: '2px 7px',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {compact(g.value)}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>

      {/* timeline progress + giant year */}
      <div style={{ position: 'absolute', right: 18, bottom: 16, display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'none', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', color: INK.muted, textAlign: 'right', lineHeight: 1.2 }}>
            DATA
            <br />
            PROGRESS
          </div>
          <ProgressRing progress={frameData.t} size={74} />
        </div>
        <div style={{ fontSize: 92, fontWeight: 800, color: INK.year, lineHeight: 1, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>
          {frameData.dateLabel}
        </div>
      </div>

      {tape.notes.length > 0 && frame < introFrames + 60 ? (
        <div style={{ position: 'absolute', left: 14, bottom: 8, fontSize: 11, color: INK.faint }}>{tape.notes[0]}</div>
      ) : null}
    </AbsoluteFill>
  );
};
