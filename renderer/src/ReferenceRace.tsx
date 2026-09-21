/**
 * The data-race composition.
 *
 * Layout follows the approved mockup:
 *  - near-black canvas with faint vertical gridlines and a bottom axis;
 *  - no full-width title: the first bar row starts at the very top;
 *  - left gutter per row: circular flag, then a rank badge (a medal with a
 *    trophy for the top three, a numbered disc below that), then the bar;
 *  - the name sits inside the bar on the left, the value just after the bar end
 *    (gold for the leader, white for the rest);
 *  - the two leading rows may run past the right column; every other row stops
 *    short of it, which is what keeps long bars out of the panel;
 *  - right column, top to bottom: DATA NARRATIVE & INSIGHTS, then DATA SUMMARY,
 *    then a compact KEY MOMENTS list - the facts live below the two blocks so a
 *    long fact can never disturb the chart;
 *  - bottom right: the giant year with the timeline progress ring.
 *
 * Row y positions come from the tape's collision-free `slot`, so two bars can
 * never be drawn on the same line.
 */

import React, { useMemo } from 'react';
import { AbsoluteFill, Img, useCurrentFrame } from 'remotion';
import type { VideoInput } from '@avm/shared';
import { buildTape, type Tape } from './tape';
import { isDarkColor } from './polish';
import { loadFont } from './fonts';

loadFont();

const INK = {
  background: '#0A0A0A',
  grid: '#171717',
  panel: '#0F0F0F',
  border: '#2A2A2A',
  borderSoft: '#202020',
  title: '#FFFFFF',
  text: '#D6D6D6',
  muted: '#8A8A8A',
  faint: '#565656',
  year: '#4E4E4E',
  gold: '#F2C14E',
  silver: '#C6CCD2',
  bronze: '#C58A5A',
} as const;

type LayoutId = 'standard' | 'dense' | 'focus';

/** Three densities, picked from the shape of the data. */
const PROFILES: Record<LayoutId, { rows: number; pitch: number; barHeight: number }> = {
  standard: { rows: 12, pitch: 52, barHeight: 34 },
  dense: { rows: 14, pitch: 45, barHeight: 28 },
  focus: { rows: 8, pitch: 74, barHeight: 48 },
};

/**
 * Choose a density for this dataset. An explicit settings.layout wins; otherwise
 * a wide field of entities reads better dense and a short race reads better big.
 */
export function chooseLayout(input: VideoInput, tape: Tape): LayoutId {
  const explicit = (input.settings as { layout?: string } | undefined)?.layout;
  if (explicit === 'standard' || explicit === 'dense' || explicit === 'focus') return explicit;
  if (tape.entities.length >= 45 || tape.topN >= 14) return 'dense';
  if (tape.topN <= 8) return 'focus';
  return 'standard';
}

const ROWS_TOP = 20;
const RANK_LEFT = 14;
const BADGE_LEFT = 46;
const BAR_LEFT = 86;
const PANEL_LEFT = 922;
const PANEL_WIDTH = 286;
const VALUE_ROOM = 118;
const LONG_ROWS = 2;
const LONG_RIGHT = 1248;

function formatValue(value: number, mode: 'comma' | 'compact'): string {
  if (!Number.isFinite(value)) return '0';
  if (mode === 'comma') {
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

const compact = (value: number): string => formatValue(value, 'compact');

/** After-bar values switch to compact once the numbers get long. */
const valueText = (value: number, magnitude: number): string =>
  magnitude >= 1e6 ? formatValue(value, 'compact') : formatValue(value, 'comma');

const Trophy: React.FC<{ size: number; color: string; flat?: boolean }> = ({ size, color, flat }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={flat ? color : 'none'} stroke={color} strokeWidth={2} strokeLinejoin="round">
    <path d="M7 4h10v5a5 5 0 0 1-10 0V4z" fill={color} stroke="none" />
    <path d="M7 5H4.5v2A3.5 3.5 0 0 0 8 10.5" />
    <path d="M17 5h2.5v2A3.5 3.5 0 0 1 16 10.5" />
    <path d="M11 14h2v3h-2z" fill={color} stroke="none" />
    <path d="M8 17h8v3H8z" fill={color} stroke="none" />
  </svg>
);

const RankBadge: React.FC<{ rank: number }> = ({ rank }) => {
  const medal = rank === 1 ? INK.gold : rank === 2 ? INK.silver : rank === 3 ? INK.bronze : null;
  if (medal) {
    return (
      <div
        style={{
          width: 26,
          height: 26,
          borderRadius: '50%',
          background: medal,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 0 0 1px rgba(255,255,255,0.18) inset',
        }}
      >
        <Trophy size={17} color="#141414" flat />
      </div>
    );
  }
  return (
    <div
      style={{
        width: 26,
        height: 26,
        borderRadius: '50%',
        border: `1px solid ${INK.border}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12,
        fontWeight: 700,
        color: INK.muted,
      }}
    >
      {rank}
    </div>
  );
};

const LogoChip: React.FC<{ src?: string | null; size: number; fallback: string }> = ({ src, size, fallback }) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: '50%',
      overflow: 'hidden',
      background: '#FFFFFF',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: '0 0 auto',
      color: '#111',
      fontWeight: 800,
      fontSize: size * 0.5,
    }}
  >
    {src ? <Img src={src} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : fallback}
  </div>
);

const ProgressRing: React.FC<{ progress: number; size: number }> = ({ progress, size }) => {
  const clamped = Math.max(0.01, Math.min(1, progress));
  const r = size / 2 - 5;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#242424" strokeWidth={4} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="#FFFFFF"
        strokeWidth={4}
        strokeLinecap="round"
        strokeDasharray={`${c * clamped} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
};

const kicker: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: '0.16em',
  color: INK.muted,
};

export const ReferenceRace: React.FC<{ input: VideoInput }> = ({ input }) => {
  const frame = useCurrentFrame();
  const tape: Tape = useMemo(() => buildTape(input), [input]);
  const layoutId = useMemo(() => chooseLayout(input, tape), [input, tape]);
  const profile = PROFILES[layoutId];
  const rows = Math.min(profile.rows, tape.topN);

  const entityIndex = useMemo(() => {
    const map = new Map<string, Tape['entities'][number]>();
    for (const entity of tape.entities) {
      map.set(entity.id, entity);
      map.set(entity.name.toLowerCase(), entity);
      if (entity.flagCode) map.set(entity.flagCode, entity);
      map.set(entity.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), entity);
    }
    return map;
  }, [tape]);

  const lastFrame = tape.durationInFrames - 1;
  const safeFrame = Math.max(0, Math.min(lastFrame, frame));
  const frameData = tape.frames[safeFrame];
  if (!frameData) return <AbsoluteFill style={{ background: INK.background }} />;

  const appear = Math.min(1, Math.max(0, (frame - 4) / 22));
  const outroFade = 1;
  const magnitude = frameData.bars[0]?.value ?? 0;
  const scalePower = tape.scalePower;
  // in from below appears once it crosses into the band, so it can never land
  // on top of the bottom axis labels.
  const shown = frameData.bars.filter((bar) => bar.slot <= rows).slice(0, rows);
  const fact = frameData.factIndex === null ? null : tape.facts[frameData.factIndex];
  const moments = tape.facts.filter((entry) => entry.fromFrame <= safeFrame).slice(-4);

  /** Absolute frame -> the date label the tape shows for it. */
  const labelForFrame = (absolute: number): string =>
    tape.frames[Math.max(0, Math.min(tape.frames.length - 1, absolute))]?.dateLabel ?? '';

  // axis labels underneath.
  const barsBottom = ROWS_TOP + (rows + 0.7) * profile.pitch;
  const bandBottom = ROWS_TOP + rows * profile.pitch;
  const maxShort = Math.max(60, PANEL_LEFT - 16 - BAR_LEFT - VALUE_ROOM);
  const barX = (value: number): number => {
    const ratio = magnitude > 0 ? Math.max(0, value / magnitude) : 0;
    return BAR_LEFT + Math.pow(ratio, scalePower) * maxShort;
  };

  const tilesOf = (ids: string[]): Array<{ key: string; src?: string | null; label: string }> =>
    ids.slice(0, 2).map((id) => {
      const found = entityIndex.get(id) ?? entityIndex.get(id.toLowerCase());
      return { key: id, src: found?.logoUrl ?? null, label: found?.name ?? id };
    });

  return (
    <AbsoluteFill style={{ background: INK.background, fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif', overflow: 'hidden' }}>
      {/* faint vertical gridlines + bottom axis, on the short-bar scale */}
      {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
        const x = BAR_LEFT + Math.pow(ratio, scalePower) * maxShort;
        return (
          <React.Fragment key={ratio}>
            <div style={{ position: 'absolute', left: x, top: ROWS_TOP + LONG_ROWS * profile.pitch, width: 1, height: barsBottom - (ROWS_TOP + LONG_ROWS * profile.pitch), background: INK.grid }} />
          </React.Fragment>
        );
      })}

      {/* ranked rows */}
      <div style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: barsBottom, opacity: appear }}>
        {shown.map((bar) => {
          const entity = entityIndex.get(bar.entityId);
          const name = entity?.name ?? bar.entityId;
          const y = ROWS_TOP + (bar.slot - 1) * profile.pitch;
          // bar that is still sliding down cannot keep a long bar under the panel.
          const maxRight = bar.slot <= LONG_ROWS ? LONG_RIGHT : PANEL_LEFT - 16;
          const maxBar = Math.max(60, maxRight - BAR_LEFT - VALUE_ROOM);
          const width = Math.max(6, bar.widthFraction * maxBar);
          const fill = entity?.color ?? '#3A3A3A';
          const onDark = isDarkColor(fill);
          // is a good estimate for Inter bold; below 9px the row reads as a bar
          // with no label rather than a half word.
          const fittedName = Math.floor((width - 20) / Math.max(6, name.length * 0.56));
          const showName = fittedName >= 9;
          const nameSize = Math.max(9, Math.min(16, fittedName));
          const value = valueText(bar.value, magnitude);
          const edgeFade = Math.max(0, Math.min(1, (rows - bar.slot) / 0.7));
          return (
            <div key={bar.entityId} style={{ position: 'absolute', left: 0, top: y, height: profile.barHeight, width: '100%', opacity: edgeFade }}>
              <div style={{ position: 'absolute', left: RANK_LEFT, top: '50%', transform: 'translateY(-50%)' }}>
                <LogoChip src={entity?.logoUrl} size={26} fallback={name.slice(0, 1).toUpperCase()} />
              </div>
              <div style={{ position: 'absolute', left: BADGE_LEFT, top: '50%', transform: 'translateY(-50%)' }}>
                <RankBadge rank={bar.rank} />
              </div>
              <div
                style={{
                  position: 'absolute',
                  left: BAR_LEFT,
                  top: 0,
                  height: profile.barHeight,
                  width,
                  background: fill,
                  display: 'flex',
                  alignItems: 'center',
                  paddingLeft: 10,
                  overflow: 'hidden',
                }}
              >
                <span style={{ color: onDark ? '#FFFFFF' : '#101010', fontWeight: 700, fontSize: nameSize, whiteSpace: 'nowrap' }}>{showName ? name : null}</span>
              </div>
              <div
                style={{
                  position: 'absolute',
                  left: BAR_LEFT + width + 10,
                  top: 0,
                  height: profile.barHeight,
                  display: 'flex',
                  alignItems: 'center',
                  fontSize: 15,
                  fontWeight: 700,
                  whiteSpace: 'nowrap',
                  fontVariantNumeric: 'tabular-nums',
                  color: bar.rank === 1 ? INK.gold : INK.title,
                }}
              >
                {showName ? value : name}
              </div>
            </div>
          );
        })}
      </div>

      {/* axis labels */}
      {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
        <div
          key={`t-${ratio}`}
          style={{
            position: 'absolute',
            left: Math.max(0, barX(magnitude * Math.pow(ratio, 1 / scalePower)) - 22),
            top: barsBottom + 4,
            width: 60,
            textAlign: 'center',
            fontSize: 10.5,
            color: INK.faint,
            opacity: Math.max(0, outroFade),
          }}
        >
          {compact(magnitude * Math.pow(ratio, 1 / scalePower))}
        </div>
      ))}

      {/* right column: narrative, summary, then the facts below both */}
      <div style={{ position: 'absolute', left: PANEL_LEFT, top: ROWS_TOP + LONG_ROWS * profile.pitch + 10, width: PANEL_WIDTH, display: 'flex', flexDirection: 'column', gap: 9 }}>
        <div style={{ border: `1px solid ${INK.border}`, background: INK.panel, padding: '11px 13px 12px' }}>
          <div style={{ ...kicker, paddingBottom: 8, borderBottom: `1px solid ${INK.borderSoft}`, textAlign: 'center' }}>
            DATA NARRATIVE &amp; INSIGHTS
          </div>
          {fact ? (
            <div style={{ paddingTop: 10 }}>
              <div style={{ fontSize: 13.5, fontWeight: 800, color: INK.title, textTransform: 'uppercase', letterSpacing: '0.02em', lineHeight: 1.25 }}>
                {fact.heading}
              </div>
              {fact.tiles.length > 0 ? (
                <div style={{ display: 'flex', gap: 10, padding: '9px 0 8px' }}>
                  {tilesOf(fact.tiles).map((tile) => (
                    <LogoChip key={tile.key} src={tile.src} size={38} fallback={tile.label.slice(0, 1).toUpperCase()} />
                  ))}
                </div>
              ) : null}
              {fact.body ? (
                <div
                  style={{
                    fontSize: 13,
                    lineHeight: 1.42,
                    color: INK.text,
                    display: '-webkit-box',
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {fact.body}
                </div>
              ) : null}
            </div>
          ) : (
            <div style={{ paddingTop: 10, fontSize: 12.5, color: INK.faint }}>No insight for this period.</div>
          )}
        </div>

        <div style={{ border: `1px solid ${INK.border}`, background: INK.panel, padding: '10px 13px' }}>
          <div style={{ ...kicker, paddingBottom: 7 }}>DATA SUMMARY</div>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: INK.muted, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              {input.metric}
            </span>
            <span style={{ fontSize: 21, fontWeight: 800, color: INK.title, fontVariantNumeric: 'tabular-nums' }}>
              {compact(frameData.worldTotal ?? 0)}
            </span>
          </div>
        </div>

        {moments.length > 0 ? (
          <div style={{ border: `1px solid ${INK.border}`, background: INK.panel, padding: '10px 13px 11px' }}>
            <div style={{ ...kicker, paddingBottom: 8, borderBottom: `1px solid ${INK.borderSoft}` }}>KEY MOMENTS</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 9 }}>
              {moments.map((entry) => {
                const active = fact !== null && entry.fromFrame === fact.fromFrame;
                return (
                  <div key={`${entry.fromFrame}-${entry.heading}`} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <span style={{ fontSize: 11, fontWeight: 800, color: active ? INK.gold : INK.faint, fontVariantNumeric: 'tabular-nums', minWidth: 62 }}>
                      {labelForFrame(entry.fromFrame)}
                    </span>
                    <span style={{ fontSize: 11.5, lineHeight: 1.3, color: active ? INK.text : INK.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {entry.heading}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>

      {/* bottom right: progress ring + giant year */}
      <div style={{ position: 'absolute', right: 18, bottom: 12, display: 'flex', alignItems: 'center', gap: 14 }}>
        <ProgressRing progress={frameData.t} size={62} />
        <div style={{ fontSize: 96, fontWeight: 800, color: INK.year, lineHeight: 0.9, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums' }}>
          {frameData.dateLabel}
        </div>
      </div>

      {tape.notes.length > 0 && frame < tape.introFrames + 90 ? (
        <div style={{ position: 'absolute', left: 14, bottom: 8, fontSize: 10.5, color: INK.faint }}>{tape.notes[0]}</div>
      ) : null}
    </AbsoluteFill>
  );
};
