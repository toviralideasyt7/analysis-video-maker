/**
 * The data-race composition.
 *
 * Modelled on the reference animation the user supplied (a data-races.com clip):
 *  - near-black canvas with a faint teal vignette, no gridlines, no panels;
 *  - title and subtitle top-left, over the chart;
 *  - a narrow left gutter holding a flag card and a rank badge (a medal with a
 *    trophy for the top three, a dark numbered disc below that);
 *  - chunky bars with rounded ends and a horizontal gradient fill, the leader
 *    ringed in gold;
 *  - the name inside the bar, the value just after the bar end;
 *  - a very large translucent year lower-right, behind everything;
 *  - value tick labels along the bottom; one line of fact text lower-left.
 *
 * Row positions come from the tape's collision-free `slot`, so two bars can never
 * be drawn on the same line.
 */

import React, { useMemo } from 'react';
import { AbsoluteFill, Img, useCurrentFrame } from 'remotion';
import type { VideoInput } from '@avm/shared';
import { buildTape, type Tape } from './tape';
import { isDarkColor } from './polish';
import { loadFont } from './fonts';

loadFont();

const INK = {
  background: '#050706',
  vignette: '#0B1A16',
  title: '#FFFFFF',
  subtitle: '#9AA3A0',
  axis: '#8A9492',
  value: '#EDEDED',
  gold: '#F2C14E',
  silver: '#C6CCD2',
  bronze: '#C58A5A',
  badge: '#1B1F1E',
  badgeText: '#D8DEDC',
  fact: '#8E9795',
  source: '#7C8785',
} as const;

type LayoutId = 'standard' | 'dense' | 'focus';

/** Three densities, picked from the shape of the data. */
const PROFILES: Record<LayoutId, { rows: number; pitch: number; barHeight: number }> = {
  standard: { rows: 10, pitch: 46, barHeight: 38 },
  dense: { rows: 12, pitch: 39, barHeight: 32 },
  focus: { rows: 7, pitch: 62, barHeight: 50 },
};

export function chooseLayout(input: VideoInput, tape: Tape): LayoutId {
  const explicit = (input.settings as { layout?: string } | undefined)?.layout;
  if (explicit === 'standard' || explicit === 'dense' || explicit === 'focus') return explicit;
  if (tape.entities.length >= 45 || tape.topN >= 13) return 'dense';
  if (tape.topN <= 7) return 'focus';
  return 'standard';
}

const FLAG_LEFT = 26;
const BADGE_LEFT = 76;
const BAR_LEFT = 132;
const RIGHT_MARGIN = 34;
const ROWS_TOP = 104;
const VALUE_ROOM = 104;

function formatValue(value: number, mode: 'comma' | 'compact'): string {
  if (!Number.isFinite(value)) return '0';
  if (mode === 'comma') {
    const abs = Math.abs(value);
    const decimals = abs >= 1000 ? 0 : abs >= 10 ? 1 : 2;
    return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(1)}T`;
  if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(Math.round(value));
}

const compact = (value: number): string => formatValue(value, 'compact');
const valueText = (value: number, magnitude: number): string =>
  magnitude >= 1e6 ? formatValue(value, 'compact') : formatValue(value, 'comma');

/** Lighten a #rrggbb colour toward white; used for the bar gradient. */
function lighten(hex: string, amount: number): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return hex;
  const value = Number.parseInt(match[1], 16);
  const mix = (channel: number): number => Math.round(channel + (255 - channel) * amount);
  const r = mix((value >> 16) & 255);
  const g = mix((value >> 8) & 255);
  const b = mix(value & 255);
  return `rgb(${r}, ${g}, ${b})`;
}

const Trophy: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="#141414">
    <path d="M7 4h10v5a5 5 0 0 1-10 0V4z" />
    <path d="M11 14h2v3h-2z" />
    <path d="M8 17h8v3H8z" />
    <path d="M7 5H4.5v2A3.5 3.5 0 0 0 8 10.5V9H6.5V7H7z" />
    <path d="M17 5h2.5v2A3.5 3.5 0 0 1 16 10.5V9h1.5V7H17z" />
  </svg>
);

const RankBadge: React.FC<{ rank: number }> = ({ rank }) => {
  const medal = rank === 1 ? INK.gold : rank === 2 ? INK.silver : rank === 3 ? INK.bronze : null;
  if (medal) {
    return (
      <div style={{ width: 24, height: 24, borderRadius: '50%', background: medal, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Trophy size={15} />
      </div>
    );
  }
  return (
    <div
      style={{
        width: 24, height: 24, borderRadius: '50%', background: INK.badge,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 11.5, fontWeight: 700, color: INK.badgeText,
      }}
    >
      {rank}
    </div>
  );
};

/** Rectangular flag card; falls back to the entity initial. */
const FlagCard: React.FC<{ src?: string | null; fallback: string }> = ({ src, fallback }) => (
  <div
    style={{
      width: 34, height: 24, borderRadius: 3, overflow: 'hidden', background: '#FFFFFF',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: '#111', fontWeight: 800, fontSize: 12, flex: '0 0 auto',
    }}
  >
    {src ? <Img src={src} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : fallback}
  </div>
);

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
      map.set(entity.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), entity);
      if (entity.flagCode) map.set(entity.flagCode, entity);
    }
    return map;
  }, [tape]);

  const lastFrame = tape.durationInFrames - 1;
  const safeFrame = Math.max(0, Math.min(lastFrame, frame));
  const frameData = tape.frames[safeFrame];
  if (!frameData) return <AbsoluteFill style={{ background: INK.background }} />;

  const appear = Math.min(1, Math.max(0, (frame - 2) / 18));
  const magnitude = frameData.bars[0]?.value ?? 0;
  const scalePower = tape.scalePower;
  const shown = frameData.bars.filter((bar) => bar.slot <= rows).slice(0, rows);
  const fact = frameData.factIndex === null ? null : tape.facts[frameData.factIndex];

  const bandBottom = ROWS_TOP + rows * profile.pitch;
  const maxBar = Math.max(80, 1280 - RIGHT_MARGIN - BAR_LEFT - VALUE_ROOM);
  const year = frameData.dateLabel;
  const subtitle = `${input.metric}${input.unit ? ' · ' + input.unit : ''} · ${tape.dateLabels[0] ?? ''} - ${tape.dateLabels[tape.dateLabels.length - 1] ?? ''}`;

  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(118% 92% at 20% 108%, #164034 0%, #0A1712 40%, ${INK.background} 68%)`,
        fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif',
        overflow: 'hidden',
      }}
    >
      {/* giant translucent year, behind everything */}
      <div
        style={{
          position: 'absolute', right: 24, bottom: 6, fontSize: 118, fontWeight: 800,
          color: 'rgba(255,255,255,0.085)', lineHeight: 1, letterSpacing: '-0.04em',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {year}
      </div>

      {/* title + subtitle */}
      <div style={{ position: 'absolute', left: 30, top: 20, opacity: appear }}>
        <div style={{ fontSize: 34, fontWeight: 800, color: INK.title, letterSpacing: '-0.01em', lineHeight: 1.1 }}>
          {input.title}
        </div>
        <div style={{ fontSize: 14, fontWeight: 500, color: INK.subtitle, marginTop: 5, letterSpacing: '0.01em' }}>
          {subtitle}
        </div>
      </div>

      {/* ranked rows */}
      <div style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: bandBottom, opacity: appear }}>
        {shown.map((bar) => {
          const entity = entityIndex.get(bar.entityId);
          const name = entity?.name ?? bar.entityId;
          const y = ROWS_TOP + (bar.slot - 1) * profile.pitch;
          const width = Math.max(8, bar.widthFraction * maxBar);
          const fill = entity?.color ?? '#3A3A3A';
          const onDark = isDarkColor(fill);
          const fitted = Math.floor((width - 18) / Math.max(6, name.length * 0.56));
          const showName = fitted >= 9;
          const nameSize = Math.max(9, Math.min(20, fitted));
          const leader = bar.rank === 1;
          const edgeFade = Math.max(0, Math.min(1, (rows - bar.slot) / 0.7));

          return (
            <div key={bar.entityId} style={{ position: 'absolute', left: 0, top: y, height: profile.barHeight, width: '100%', opacity: edgeFade }}>
              <div style={{ position: 'absolute', left: FLAG_LEFT, top: '50%', transform: 'translateY(-50%)' }}>
                <FlagCard src={entity?.logoUrl} fallback={name.slice(0, 1).toUpperCase()} />
              </div>
              <div style={{ position: 'absolute', left: BADGE_LEFT, top: '50%', transform: 'translateY(-50%)' }}>
                <RankBadge rank={bar.rank} />
              </div>

              {/* gold ring on the leader */}
              {leader ? (
                <div
                  style={{
                    position: 'absolute', left: BAR_LEFT - 3, top: -3, height: profile.barHeight + 6,
                    width: width + 6, border: `3px solid ${INK.gold}`, borderRadius: 7,
                    boxShadow: '0 0 18px rgba(242,193,78,0.35)',
                  }}
                />
              ) : null}

              <div
                style={{
                  position: 'absolute', left: BAR_LEFT, top: 0, height: profile.barHeight, width,
                  background: `linear-gradient(90deg, ${fill} 0%, ${lighten(fill, 0.32)} 100%)`,
                  borderRadius: 4, display: 'flex', alignItems: 'center',
                  paddingLeft: 11, overflow: 'hidden',
                }}
              >
                <span
                  style={{
                    color: onDark ? '#FFFFFF' : '#101010', fontWeight: 700, fontSize: nameSize,
                    whiteSpace: 'nowrap', textShadow: onDark ? '0 1px 2px rgba(0,0,0,0.5)' : 'none',
                  }}
                >
                  {showName ? name : null}
                </span>
              </div>

              <div
                style={{
                  position: 'absolute', left: BAR_LEFT + width + 9, top: 0, height: profile.barHeight,
                  display: 'flex', alignItems: 'center', whiteSpace: 'nowrap',
                  fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
                  color: leader ? INK.gold : INK.value,
                  textShadow: '0 1px 2px rgba(0,0,0,0.6)',
                }}
              >
                {showName ? `${compact(bar.value)}` : `${name}  ${compact(bar.value)}`}
              </div>
            </div>
          );
        })}
      </div>

      {/* faint baseline and tick marks under the bars */}       <div style={{ position: 'absolute', left: BAR_LEFT, top: bandBottom, width: maxBar, height: 1, background: 'rgba(255,255,255,0.10)' }} />       {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (         <div           key={`tick-${ratio}`}           style={{             position: 'absolute', left: BAR_LEFT + Math.pow(ratio, scalePower) * maxBar,             top: bandBottom, width: 1, height: 6, background: 'rgba(255,255,255,0.20)',           }}         />       ))}        {/* bottom value ticks */}
      {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
        const value = magnitude * Math.pow(ratio, 1 / scalePower);
        const x = BAR_LEFT + Math.pow(ratio, scalePower) * maxBar;
        return (
          <div
            key={ratio}
            style={{
              position: 'absolute', left: Math.max(BAR_LEFT - 10, x - 26), top: bandBottom + 8,
              width: 62, textAlign: 'center', fontSize: 11, color: INK.axis,
            }}
          >
            {compact(value)}
          </div>
        );
      })}

      {/* one line of fact text, lower left */}
      {fact ? (
        <div style={{ position: 'absolute', left: 30, top: bandBottom + 26, width: 860, display: 'flex', alignItems: 'baseline', whiteSpace: 'nowrap', overflow: 'hidden', opacity: appear }}>
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.14em', color: INK.gold, textTransform: 'uppercase' }}>
            {fact.heading}
          </span>
          {fact.body ? (
            <span style={{ fontSize: 12.5, color: INK.fact, marginLeft: 8 }}>
              {fact.body.length > 110 ? fact.body.slice(0, 110) + "…" : fact.body}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* source */}
      {input.sources ? (
        <div style={{ position: 'absolute', left: 30, bottom: 14, fontSize: 10.5, color: INK.source }}>
          {input.sources.slice(0, 120)}
        </div>
      ) : null}

      {tape.notes.length > 0 && frame < tape.introFrames + 90 ? (
        <div style={{ position: 'absolute', right: 24, bottom: 14, fontSize: 10.5, color: INK.source }}>{tape.notes[0]}</div>
      ) : null}
    </AbsoluteFill>
  );
};
