/**
 * The data-race composition, polished to read like a top-tier channel video.
 *
 * Layout follows the reference frame measurements; the finish follows broadcast
 * conventions: a real typeface, entering bars that scale in, values that settle,
 * an editorial side-panel hierarchy, and a giant easing year.
 */

import React, { useMemo } from 'react';
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import type { VideoInput } from '@avm/shared';
import { buildTape, REFERENCE, type Tape } from './tape';
import { VISUAL, isDarkColor } from './polish';
import { loadFont } from './fonts';

loadFont();

const FLAG_BASE = 'https://flagcdn.com/w80';

function formatValue(value: number, format: 'comma' | 'compact'): string {
  if (!Number.isFinite(value)) return '0';
  if (format === 'comma') return Math.round(value).toLocaleString('en-US');
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(2)} T`;
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)} B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)} M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)} K`;
  return Math.round(value).toLocaleString('en-US');
}

const GROUP_GLYPHS: Record<string, string> = {
  asia: 'M4 44 L14 30 L30 24 L46 28 L56 18 L70 22 L74 34 L62 44 L46 50 L28 52 Z',
  america: 'M10 14 L26 8 L38 16 L44 30 L38 46 L28 58 L20 50 L14 34 Z',
  africa: 'M12 8 L34 6 L48 16 L52 32 L42 48 L28 56 L16 44 L8 24 Z',
  europe: 'M6 30 L18 12 L38 8 L54 14 L58 26 L46 34 L30 38 L16 40 Z',
  oceania: 'M10 30 L30 18 L52 22 L60 36 L44 50 L22 50 Z',
};

const CONTINENTS = new Set(['asia', 'africa', 'europe', 'america', 'north america', 'south america', 'oceania']);

const GroupGlyph: React.FC<{ id: string; color: string; size: number; label: string }> = ({ id, color, size, label }) => {
  if (CONTINENTS.has(id.toLowerCase())) {
    return (
      <svg width={size} height={size} viewBox="0 0 64 60" style={{ display: 'block' }}>
        <path d={GROUP_GLYPHS[id.toLowerCase()] ?? GROUP_GLYPHS.asia} fill={color} opacity={0.92} />
      </svg>
    );
  }
  return (
    <div
      style={{
        width: size * 0.82,
        height: size * 0.82,
        borderRadius: '50%',
        background: color,
        color: '#ffffff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 800,
        fontSize: size * 0.4,
      }}
    >
      {label.slice(0, 1).toUpperCase()}
    </div>
  );
};

const BrandMark: React.FC = () => (
  <div
    style={{
      width: 58,
      height: 58,
      borderRadius: '50%',
      background: VISUAL.logo,
      display: 'flex',
      alignItems: 'flex-end',
      justifyContent: 'center',
      gap: 4,
      paddingBottom: 16,
      flex: '0 0 auto',
      boxShadow: '0 3px 10px rgba(20,20,20,0.18)',
    }}
  >
    {[15, 24, 20].map((height, index) => (
      <div key={index} style={{ width: 5, height, background: '#fff', borderRadius: 1 }} />
    ))}
  </div>
);

const FlagTile: React.FC<{ code?: string | null; width: number; height: number; radius?: number }> = ({ code, width, height, radius = 4 }) => (
  <div
    style={{
      width,
      height,
      borderRadius: radius,
      overflow: 'hidden',
      background: '#d9dcd6',
      flex: '0 0 auto',
      boxShadow: '0 1px 4px rgba(20,20,20,0.25)',
    }}
  >
    {code ? <Img src={`${FLAG_BASE}/${code}.png`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : null}
  </div>
);

const LogoChip: React.FC<{ url: string; size: number }> = ({ url, size }) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: '50%',
      overflow: 'hidden',
      background: '#ffffff',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: '0 0 auto',
      boxShadow: '0 0 0 1px rgba(20,20,20,0.12)',
    }}
  >
    <Img src={url.startsWith('logos/') ? staticFile(url) : url} style={{ width: '74%', height: '74%', objectFit: 'contain' }} />
  </div>
);

const Pie: React.FC<{ fraction: number; size: number }> = ({ fraction, size }) => {
  const clamped = Math.max(0.02, Math.min(0.85, fraction));
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
        strokeWidth={7}
        strokeLinecap="round"
        strokeDasharray={`${circumference * clamped} ${circumference}`}
        transform={`rotate(-90 ${radius} ${radius})`}
      />
    </svg>
  );
};

export const ReferenceRace: React.FC<{ input: VideoInput }> = ({ input }) => {
  const frame = useCurrentFrame();
  const tape: Tape = useMemo(() => buildTape(input), [input]);
  if (frame >= tape.durationInFrames) {
    return <AbsoluteFill style={{ background: VISUAL.background }} />;
  }
  return <RaceBody input={input} tape={tape} frame={frame} />;
};

const RaceBody: React.FC<{ input: VideoInput; tape: Tape; frame: number }> = ({ input, tape, frame }) => {
  const { fps } = useVideoConfig();
  const format = input.valueFormat ?? 'comma';
  const entityById = useMemo(() => new Map(tape.entities.map((e) => [e.id, e])), [tape]);
  const entityByName = useMemo(() => new Map(tape.entities.map((e) => [e.name.toLowerCase(), e])), [tape]);
  const frameData = tape.frames[Math.min(frame, tape.frames.length - 1)];
  const shown = frameData.bars.slice(0, tape.topN);
  const introFrames = tape.introFrames;

  // Animated ranks: cubic ease over ~10 frames.
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
  const worldTotal = frameData.worldTotal ?? 0;
  const topBar = shown[0];
  const leaderShare = worldTotal > 0 && topBar ? topBar.value / worldTotal : 0;

  const titleProgress = interpolate(frame, [0, introFrames], [0, 1], { extrapolateRight: 'clamp' });
  const titleX = (1 - titleProgress) * -60;

  const outroStart = tape.durationInFrames - tape.outroFrames;
  const outroFade =
    frame >= outroStart
      ? interpolate(frame, [outroStart, outroStart + Math.max(8, tape.outroFrames / 2)], [1, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
      : 1;

  return (
    <AbsoluteFill style={{ background: VISUAL.background, fontFamily: 'Inter, "Segoe UI", system-ui, sans-serif', overflow: 'hidden' }}>
      {/* header */}
      <div style={{ position: 'absolute', left: 8, top: 5, display: 'flex', alignItems: 'center', gap: 14, opacity: appear, transform: `translateX(${titleX}px)` }}>
        <BrandMark />
        <div style={{ fontSize: 40, fontWeight: 800, color: VISUAL.titleColor, letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>{input.title}</div>
      </div>

      {/* bars */}
      <div style={{ position: 'absolute', left: 0, top: VISUAL.rowsTop, width: '100%', opacity: outroFade }}>
        {shown.map((bar) => {
          const entity = entityById.get(bar.entityId);
          const name = entity?.name ?? bar.entityId;
          const color = entity?.color ?? '#444444';
          const animatedRank = rankMap.get(bar.entityId) ?? bar.rank;
          const y = (animatedRank - 1) * VISUAL.rowPitch;
          const barWidth = Math.max(6, bar.widthFraction * VISUAL.maxBarX);
          const dark = isDarkColor(color);

          const enterProgress = interpolate(frame, [introFrames, introFrames + 14], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
          const scale = frame < introFrames + 14 ? 0.9 + 0.1 * enterProgress : 1;
          const width = barWidth * scale;

          const availableForName = Math.max(60, width - 66);
          const estimatedTextWidth = name.length * 11.6;
          const nameSize = Math.min(21, Math.max(12.5, (availableForName / estimatedTextWidth) * 21));

          return (
            <div key={bar.entityId} style={{ position: 'absolute', left: 0, top: y, height: VISUAL.barHeight, width: '100%' }}>
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  height: '100%',
                  width,
                  background: color,
                  opacity: bar.held ? 0.8 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  gap: 8,
                  paddingRight: 7,
                  boxShadow: bar.rank === 1 ? 'inset -4px 0 0 rgba(255,255,255,0.35)' : undefined,
                }}
              >
                <div style={{ color: dark ? VISUAL.nameColorDark : VISUAL.nameColorLight, fontWeight: 700, fontSize: nameSize, whiteSpace: 'nowrap' }}>
                  {name}
                </div>
                {entity?.logoUrl ? (
                  <LogoChip url={entity.logoUrl} size={30} />
                ) : (
                  <div
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: '50%',
                      background: 'rgba(255,255,255,0.28)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flex: '0 0 auto',
                      color: dark ? VISUAL.nameColorDark : '#ffffff',
                      fontWeight: 800,
                      fontSize: 14,
                    }}
                  >
                    {name.slice(0, 1).toUpperCase()}
                  </div>
                )}
              </div>
              <div
                style={{
                  position: 'absolute',
                  left: width + 10,
                  top: 0,
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  fontSize: Math.min(21, 21 * Math.max(0.72, 165 / (12.5 * formatValue(bar.value, format).length))),
                  fontWeight: 700,
                  color: VISUAL.valueColor,
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

      {/* side panel: fact, then metric block, then giant year */}
      <div style={{ position: 'absolute', left: 730, top: 235, width: 545, opacity: outroFade }}>
        {fact ? (
          <div style={{ opacity: interpolate(frame, [fact.fromFrame, Math.min(fact.toFrame, fact.fromFrame + 12)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) }}>
            <div style={{ fontSize: 34, fontWeight: 800, color: VISUAL.factHeading, textAlign: 'right', letterSpacing: '-0.01em' }}>{fact.heading}</div>
            {fact.body ? <div style={{ marginTop: 12, fontSize: 25, lineHeight: 1.32, color: VISUAL.factBody, textAlign: 'right' }}>{fact.body}</div> : null}
            {fact.tiles.length > 0 ? (
              <div style={{ display: 'flex', gap: 12, marginTop: 18, justifyContent: 'flex-start' }}>
                {fact.tiles.slice(0, 2).map((tile) => {
                  const key = tile.trim().toLowerCase();
                  const entity = entityById.get(key) ?? entityByName.get(key) ?? tape.entities.find((e) => e.flagCode === key);
                  if (entity?.logoUrl) {
                    return (
                      <div
                        key={tile}
                        style={{
                          width: 95,
                          height: 75,
                          borderRadius: 10,
                          overflow: 'hidden',
                          background: '#ffffff',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          boxShadow: '0 1px 5px rgba(20,20,20,0.2)',
                        }}
                      >
                        <Img src={entity.logoUrl.startsWith('logos/') ? staticFile(entity.logoUrl) : entity.logoUrl} style={{ width: '70%', height: '70%', objectFit: 'contain' }} />
                      </div>
                    );
                  }
                  return <FlagTile key={tile} code={entity?.flagCode ?? key} width={95} height={75} radius={8} />;
                })}
              </div>
            ) : null}
          </div>
        ) : null}

        <div style={{ position: 'absolute', top: 250, left: 40, display: 'flex', alignItems: 'center', gap: 20 }}>
          <div style={{ position: 'relative' }}>
            <Pie fraction={leaderShare} size={104} />
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 23, fontWeight: 800, color: '#E0524F' }}>
              {Math.round(leaderShare * 100)}%
            </div>
          </div>
          <div>
            <div style={{ fontSize: 25, fontWeight: 700, color: VISUAL.factBody }}>{input.metric}</div>
            <div style={{ fontSize: 54, fontWeight: 800, color: VISUAL.titleColor, lineHeight: 1.08 }}>{formatValue(worldTotal, format === 'comma' ? 'compact' : format)}</div>
          </div>
        </div>

        <div style={{ position: 'absolute', top: 385, right: 0, fontSize: 148, fontWeight: 800, color: VISUAL.yearColor, lineHeight: 1, letterSpacing: '-0.02em', whiteSpace: 'nowrap' }}>
          {frameData.dateLabel}
        </div>
      </div>

      {/* group chart */}
      {frameData.groups.length > 0 ? (
        <div style={{ position: 'absolute', left: 430, top: 350, width: 320, height: 350, display: 'flex', alignItems: 'flex-end', gap: 18, opacity: outroFade }}>
          {frameData.groups.map((group) => {
            const max = Math.max(...frameData.groups.map((g) => g.value), 1);
            const h = Math.max(4, (group.value / max) * 205);
            return (
              <div key={group.id} style={{ width: 58, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
                <GroupGlyph id={group.id} label={group.label} color={group.color} size={44} />
                <div style={{ fontSize: 15, fontWeight: 700, color: VISUAL.titleColor, margin: '6px 0 4px', fontVariantNumeric: 'tabular-nums' }}>
                  {formatValue(group.value, format === 'comma' ? 'compact' : format)}
                </div>
                <div style={{ width: '100%', height: h, background: group.color, borderRadius: '3px 3px 0 0' }} />
                <div style={{ fontSize: 16, fontWeight: 700, color: VISUAL.titleColor, marginTop: 6, writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>{group.label}</div>
              </div>
            );
          })}
        </div>
      ) : null}

      {tape.notes.length > 0 && frame < introFrames + 60 ? <div style={{ position: 'absolute', left: 10, bottom: 6, fontSize: 12, color: '#9aa0a6' }}>{tape.notes[0]}</div> : null}
    </AbsoluteFill>
  );
};
