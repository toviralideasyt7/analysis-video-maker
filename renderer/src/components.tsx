/**
 * Reusable visual components.
 *
 * Everything is deterministic: the same frame always produces the same pixels.
 * No remote fonts at render time, and all flag/logo assets are embedded as
 * data URIs by the render CLI before rendering starts.
 */

import React, { useState } from 'react';
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { DEFAULT_FLAG_BASE } from './types';
import { compactNumber, formatValue, type Theme } from './theme';
import type { FrameTapeBar, FrameTapeEntity } from './frameTape';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Channel logo — the user-supplied globe mark, served from renderer/public. */
export const ChannelLogo: React.FC<{ size?: number; style?: React.CSSProperties }> = ({ size = 54, style }) => (
  <Img
    src={staticFile('channel-logo.png')}
    style={{ width: size, height: size, objectFit: 'contain', ...style }}
  />
);

/** Country flag chip with a text fallback when the asset cannot be loaded. */
export const FlagChip: React.FC<{ code?: string; label?: string; theme: Theme; size?: number }> = ({ code, label, theme, size = 34 }) => {
  const width = size * 1.45;
  return (
    <div
      style={{
        width,
        height: size,
        borderRadius: size * 0.22,
        overflow: 'hidden',
        background: theme.surface,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.42,
        fontWeight: 700,
        color: theme.secondaryText,
        flex: '0 0 auto',
        boxShadow: '0 1px 3px rgba(17,24,39,0.16)',
      }}
    >
      {code ? <Img src={`${DEFAULT_FLAG_BASE}/${code}.png`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : (label ?? '').slice(0, 3).toUpperCase()}
    </div>
  );
};

/** Monogram badge standing in for a brand logo, in the entity's own colour. */
export const LogoBadge: React.FC<{ name: string; color: string; size?: number; invert?: boolean }> = ({ name, color, size = 44, invert = false }) => {
  const initials = name
    .split(/[\s.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.26,
        background: invert ? '#ffffff' : color,
        color: invert ? color : '#ffffff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 800,
        fontSize: size * 0.42,
        letterSpacing: '-0.02em',
        flex: '0 0 auto',
        boxShadow: '0 2px 6px rgba(17,24,39,0.2)',
      }}
    >
      {initials || name.slice(0, 2).toUpperCase()}
    </div>
  );
};

/**
 * Flag image with logo + monogram fallbacks. Priority: the entity's embedded
 * brand logo (favicon) for domain-like entities, then the flag, then the
 * monogram badge. A failed load swaps down one level.
 */
export const FlagImage: React.FC<{
  entity: FrameTapeEntity;
  size: number;
  variant?: 'w80' | 'w160';
  style?: React.CSSProperties;
  invertBadge?: boolean;
  baseUrl?: string;
}> = ({ entity, size, variant = 'w160', style, invertBadge = false, baseUrl = DEFAULT_FLAG_BASE }) => {
  const [failed, setFailed] = useState(false);
  const srcUrl = failed
    ? undefined
    : (entity.logoDataUri ??
      entity.flagDataUri ??
      (entity.flagCode ? `${baseUrl}/${variant}/${entity.flagCode}.png` : undefined));
  if (!srcUrl) {
    return <LogoBadge name={entity.name} color={entity.color} size={size} invert={invertBadge} />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={srcUrl}
      onError={() => setFailed(true)}
      style={{ height: size, borderRadius: 4, ...style }}
    />
  );
};

// ---------------------------------------------------------------------------
// Ranking rows
// ---------------------------------------------------------------------------

export interface RankingRowProps {
  entity: FrameTapeEntity;
  /** Interpolated bar state in render space. */
  value: number;
  widthFrac: number;
  rank: number;
  held: boolean;
  unit: string;
  y: number;
  rowHeight: number;
  /** X where the bar starts (page margin applied by the parent). */
  x0: number;
  maxBarWidth: number;
  /** Hard right edge (design px) the row's content may never cross. */
  raceRight: number;
  appear: number;
  flagBaseUrl: string;
}

/**
 * One ranking bar in the reference dark style
 * (https://www.youtube.com/watch?v=UR94qGirkwM):
 * entity name in WHITE, left of the bar in a fixed name column (x 24..172,
 * truncated with ellipsis); pill-shaped brand-colored bar starting at x0
 * (190) with the entity logo embedded at the bar's LEFT edge; value in
 * WHITE bold, right-aligned to the bar's right end (inside the bar, or just
 * past the end when the bar is too narrow to hold it). The leader row gets
 * a "!" badge. Geometry is capped so rows can never cross raceRight (880):
 * the name column is fixed-width, and maxBarWidth (computed by the parent
 * from the tape's longest value label) bounds the bar + outside value.
 */
export const RankingRow: React.FC<RankingRowProps> = ({
  entity,
  value,
  widthFrac,
  rank,
  held,
  unit,
  y,
  rowHeight,
  x0,
  maxBarWidth,
  raceRight,
  appear,
  flagBaseUrl,
}) => {
  // Bar height matches the QA gate's bar_h = min(row_h - 10, 46).
  const barHeight = Math.min(rowHeight - 10, 46);
  // Bar width is strictly proportional to value: widthFrac is value/maxValue
  // from the frame tape. The minimum is a stub only (4px) so the pill still
  // renders - a large clamp makes every small bar identical width and
  // destroys the visual ranking.
  const barW = Math.max(4, widthFrac * maxBarWidth);
  const nameFont = Math.max(20, rowHeight * 0.42);
  const valueFont = Math.max(19, rowHeight * 0.4);
  const formattedValue = formatRaceValue(value, unit);
  const isLeader = Math.round(rank) === 1;
  // Value sits inside the bar's right end when it fits; otherwise just past
  // the bar end (still white). Either way the row's rightward extent stays
  // left of raceRight: maxBarWidth already reserves the longest value label.
  const valueW = formattedValue.length * valueFont * 0.58;
  const valueFitsInside = barW >= valueW + 56; // logo + padding + value
  const logoSize = Math.max(24, barHeight - 10);

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: y,
        height: rowHeight,
        width: '100%',
        opacity: appear,
        transform: `translateY(${(1 - appear) * 14}px)`,
      }}
    >
      {/* entity name: white, left of the bar, fixed column x 24..172 */}
      <div
        style={{
          position: 'absolute',
          left: 24,
          top: 0,
          bottom: 0,
          width: 148,
          display: 'flex',
          alignItems: 'center',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          color: '#ffffff',
          fontWeight: 800,
          fontSize: nameFont,
          letterSpacing: '-0.01em',
        }}
      >
        {entity.name}
      </div>

      {/* "!" badge on the leader bar */}
      {isLeader ? (
        <div
          style={{
            position: 'absolute',
            left: x0 - 36,
            top: (rowHeight - 26) / 2,
            width: 26,
            height: 26,
            borderRadius: '50%',
            background: '#e11d2e',
            color: '#ffffff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 900,
            fontSize: 17,
            lineHeight: 1,
          }}
        >
          !
        </div>
      ) : null}

      {/* bar */}
      <div
        style={{
          position: 'absolute',
          left: x0,
          top: (rowHeight - barHeight) / 2,
          height: barHeight,
          width: barW,
          background: entity.color,
          borderRadius: barHeight / 2,
          opacity: held ? 0.55 : 1,
          overflow: 'hidden',
        }}
      >
        {/* logo embedded at the bar's left edge */}
        <div
          style={{
            position: 'absolute',
            left: 5,
            top: (barHeight - logoSize) / 2,
            width: logoSize,
            height: logoSize,
            borderRadius: logoSize * 0.24,
            overflow: 'hidden',
            background: 'rgba(255,255,255,0.92)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <FlagImage entity={entity} size={logoSize} variant="w80" baseUrl={flagBaseUrl} style={{ borderRadius: logoSize * 0.24 }} />
        </div>
        {/* value: white bold, right-aligned to the bar end */}
        {valueFitsInside ? (
          <div
            style={{
              position: 'absolute',
              right: 14,
              top: 0,
              bottom: 0,
              display: 'flex',
              alignItems: 'center',
              whiteSpace: 'nowrap',
              color: '#ffffff',
              fontWeight: 800,
              fontSize: valueFont,
              fontVariantNumeric: 'tabular-nums',
              textShadow: '0 1px 3px rgba(0,0,0,0.35)',
            }}
          >
            {formattedValue}
          </div>
        ) : null}
      </div>

      {/* value just past the bar end when the bar is too narrow to hold it */}
      {!valueFitsInside ? (
        <div
          style={{
            position: 'absolute',
            left: x0 + barW + 10,
            top: 0,
            bottom: 0,
            display: 'flex',
            alignItems: 'center',
            whiteSpace: 'nowrap',
            color: '#ffffff',
            fontWeight: 800,
            fontSize: valueFont,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {formattedValue}
        </div>
      ) : null}
    </div>
  );
};

/** Race-style value formatting: full numbers with separators, like the reference. */
export function formatRaceValue(value: number, unit: string): string {
  if (!Number.isFinite(value)) return '-';
  if (unit === 'percent') return `${value.toFixed(2)}%`;
  if (unit === 'currency') return `$${Math.round(value).toLocaleString('en-US')}`;
  if (unit === 'count') return Math.round(value).toLocaleString('en-US');
  // Units that read better with a suffix ("35.3M km²" not "35.3M").
  const suffix: Record<string, string> = { 'km²': ' km²', 'km2': ' km²' };
  const s = suffix[unit];
  if (s) return `${compactNumber(value)}${s}`;
  return compactNumber(value);
}

/**
 * Insert thousand separators into bare long digit runs inside narrative text
 * (e.g. story copy like "a population of 667070000" renders as "667,070,000").
 * Years (4 digits) and already-separated numbers are left untouched.
 */
export function formatNarrativeNumbers(text: string): string {
  return text.replace(/\b\d{5,}\b/g, (m) => Number(m).toLocaleString('en-US'));
}

// ---------------------------------------------------------------------------
// Top axis ticks + faint gridlines (reference dark style).
// ---------------------------------------------------------------------------

export interface AxisTicksProps {
  /** Tape-global max value (the widthFrac denominator: width = value/max). */
  maxValue: number;
  unit: string;
  /** X where bars start (190). */
  x0: number;
  /** Pixel width of a full-scale bar. */
  maxBarWidth: number;
  /** Y of the tick labels. */
  top: number;
  /** Y where the gridlines end (race zone bottom). */
  bottom: number;
  appear: number;
}

/** Nice round tick values in (0, max], e.g. max=8.3B -> [2B, 4B, 6B, 8B]. */
function niceTickValues(max: number, count = 4): number[] {
  if (!(max > 0)) return [];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm > 5 ? 10 : norm > 2 ? 5 : norm > 1 ? 2 : 1) * mag;
  const ticks: number[] = [];
  for (let v = step; v < max * 0.9999; v += step) ticks.push(v);
  return ticks;
}

/**
 * X-axis labels at the TOP of the race zone with faint vertical gridlines,
 * like the reference (2B/4B/6B/8B). Tick x positions use the same scale as
 * the bars (x0 + value/maxValue * maxBarWidth) so labels always agree with
 * bar lengths.
 */
export const AxisTicks: React.FC<AxisTicksProps> = ({
  maxValue,
  unit,
  x0,
  maxBarWidth,
  top,
  bottom,
  appear,
}) => {
  const ticks = niceTickValues(maxValue, 4);
  if (ticks.length === 0) return null;
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', opacity: appear, pointerEvents: 'none' }}>
      {ticks.map((v) => {
        const x = x0 + (v / maxValue) * maxBarWidth;
        return (
          <div key={v}>
            {/* faint gridline through the race zone */}
            <div
              style={{
                position: 'absolute',
                left: x,
                top: top + 26,
                width: 1,
                height: Math.max(0, bottom - top - 26),
                background: 'rgba(255,255,255,0.09)',
              }}
            />
            {/* tick label */}
            <div
              style={{
                position: 'absolute',
                left: x - 60,
                top,
                width: 120,
                textAlign: 'center',
                fontSize: 20,
                fontWeight: 700,
                color: '#8a8a8a',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {compactNumber(v)}
            </div>
          </div>
        );
      })}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Right-side info panel (the "never overlap" zone).
// ---------------------------------------------------------------------------

export interface InfoPanelProps {
  /** Current period label, e.g. "2022" - always live, never frozen. */
  yearLabel: string;
  /** Small caps kicker, e.g. "SPOTLIGHT" or "LEADER". */
  kicker: string;
  /** Headline, e.g. highlight headline or leader name. */
  headline?: string;
  /** Narrative body, up to a few lines. */
  body?: string;
  /** Big stat line, e.g. the leader's formatted value. */
  stat?: string;
  /** Optional story image (data URI) rendered inside the card. */
  imageDataUri?: string;
  featured: FrameTapeEntity[];
  flagBaseUrl: string;
  appear: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Right-side info card in the reference dark style: near-black card
 * (#111111) with a colored accent border, kicker + live year, headline,
 * body, story image, big stat and featured logos. It lives in a RESERVED
 * zone (x 904..1232 in design space) that ranking rows are geometrically
 * barred from entering (maxBarWidth caps bars at x 880), so the panel can
 * never overlap a bar, value or name - by construction, not by pixel-tuning.
 */
export const InfoPanel: React.FC<InfoPanelProps> = ({
  yearLabel,
  kicker,
  headline,
  body,
  stat,
  imageDataUri,
  featured,
  flagBaseUrl,
  appear,
  x,
  y,
  width,
  height,
}) => {
  const accent = featured[0]?.color ?? '#e11d2e';
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width,
        height,
        background: '#111111',
        border: '1px solid rgba(255,255,255,0.14)',
        borderLeft: `6px solid ${accent}`,
        borderRadius: 18,
        boxShadow: '0 18px 44px rgba(0,0,0,0.55)',
        boxSizing: 'border-box',
        padding: '24px 24px 20px',
        opacity: appear,
        transform: `translateX(${(1 - appear) * 26}px)`,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* kicker */}
      <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: '0.28em', color: accent }}>
        {kicker}
      </div>
      {/* hero year — big bold Eczar, the live period label as a design element */}
      <div
        style={{
          marginTop: 6,
          fontSize: 64,
          fontWeight: 900,
          color: '#ffffff',
          letterSpacing: '-0.03em',
          lineHeight: 1,
          fontFamily: 'Eczar, serif',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {yearLabel}
      </div>
      {/* headline */}
      {headline ? (
        <div
          style={{
            marginTop: 10,
            fontSize: 30,
            fontWeight: 800,
            color: '#ffffff',
            lineHeight: 1.18,
            letterSpacing: '-0.02em',
            display: '-webkit-box',
            WebkitLineClamp: 3,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {headline}
        </div>
      ) : null}
      {/* body */}
      {body ? (
        <div
          style={{
            marginTop: 10,
            fontSize: 17,
            fontWeight: 500,
            color: '#a0a0a0',
            lineHeight: 1.45,
            display: '-webkit-box',
            WebkitLineClamp: 4,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {formatNarrativeNumbers(body)}
        </div>
      ) : null}
      {/* story image */}
      {imageDataUri ? (
        <div style={{ marginTop: 14, borderRadius: 12, overflow: 'hidden', flex: '0 1 auto', minHeight: 0 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageDataUri}
            alt=""
            style={{ width: '100%', height: '100%', maxHeight: 220, objectFit: 'cover', display: 'block' }}
          />
        </div>
      ) : null}
      {/* big stat */}
      {stat ? (
        <div style={{ marginTop: 'auto', paddingTop: 12 }}>
          <div style={{ fontSize: 40, fontWeight: 900, color: '#ffffff', letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' }}>
            {stat}
          </div>
        </div>
      ) : null}
      {/* featured logos */}
      {featured.length > 0 ? (
        <div style={{ marginTop: stat ? 10 : 'auto', paddingTop: 10, display: 'flex', gap: 12, alignItems: 'center' }}>
          {featured.slice(0, 3).map((entity) => (
            <div
              key={entity.id}
              style={{
                borderRadius: 12,
                padding: 3,
                background: 'rgba(255,255,255,0.92)',
                boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
              }}
            >
              <FlagImage
                entity={entity}
                size={54}
                variant="w160"
                baseUrl={flagBaseUrl}
                style={{ borderRadius: 8, display: 'block' }}
              />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

/**
 * The race header: video title top-left in white on the black canvas,
 * like the reference. The x-axis ticks sit just below it.
 */
export const RaceHeader: React.FC<{ title: string; appear: number }> = ({ title, appear }) => (
  <div
    style={{
      position: 'absolute',
      left: 0,
      top: 0,
      padding: '20px 48px',
      opacity: appear,
    }}
  >
    <div style={{
      fontSize: 30,
      fontWeight: 800,
      color: '#ffffff',
      letterSpacing: '-0.01em',
      lineHeight: 1.25,
      maxWidth: 1080,
      display: '-webkit-box',
      WebkitLineClamp: 2,
      WebkitBoxOrient: 'vertical',
      overflow: 'hidden',
    }}>
      {title}
    </div>
  </div>
);

/** Thin progress track along the bottom of the race scene. */
export const RaceProgress: React.FC<{ progress: number; caption: string; appear: number }> = ({ progress, caption, appear }) => (
  <div style={{ position: 'absolute', left: 48, right: 48, bottom: 26, opacity: appear }}>
    <div style={{ height: 6, background: '#1a1a1a', borderRadius: 3, overflow: 'hidden' }}>
      <div style={{ width: `${Math.max(0, Math.min(100, progress * 100))}%`, height: '100%', background: '#e11d2e', borderRadius: 3 }} />
    </div>
    <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', fontSize: 14, fontWeight: 600, color: '#8a8a8a' }}>
      <span>{caption}</span>
      <span>{Math.round(Math.max(0, Math.min(1, progress)) * 100)}%</span>
    </div>
  </div>
);

export interface SpotlightCardProps {
  kicker: string;
  yearLabel: string;
  headline: string;
  body: string;
  featured: FrameTapeEntity[];
  flagBaseUrl: string;
  appear: number;
}

/** Full-scene decade-spotlight card: the race pauses and a key moment is told. */
export const SpotlightCard: React.FC<SpotlightCardProps> = ({ kicker, yearLabel, headline, body, featured, flagBaseUrl, appear }) => (
  <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', background: '#000000' }}>
    <div
      style={{
        width: 880,
        background: '#111111',
        border: '1px solid rgba(255,255,255,0.14)',
        borderRadius: 28,
        boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        padding: '54px 64px 58px',
        opacity: appear,
        transform: `translateY(${(1 - appear) * 24}px)`,
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: '0.3em', color: '#e11d2e', marginBottom: 18 }}>{kicker}</div>
      <div style={{ fontSize: 120, fontWeight: 800, color: '#ffffff', letterSpacing: '-0.04em', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
        {yearLabel}
      </div>
      <div style={{ marginTop: 22, fontSize: 46, fontWeight: 800, color: '#ffffff', letterSpacing: '-0.02em', lineHeight: 1.2 }}>{headline}</div>
      <div style={{ marginTop: 18, fontSize: 25, fontWeight: 500, color: '#a0a0a0', lineHeight: 1.5 }}>{formatNarrativeNumbers(body)}</div>
      {featured.length > 0 ? (
        <div style={{ marginTop: 30, display: 'flex', gap: 16, justifyContent: 'center' }}>
          {featured.slice(0, 3).map((entity) => (
            <FlagImage
              key={entity.id}
              entity={entity}
              size={96}
              variant="w160"
              baseUrl={flagBaseUrl}
              style={{ borderRadius: 8, boxShadow: '0 2px 10px rgba(0,0,0,0.5)' }}
            />
          ))}
        </div>
      ) : null}
    </div>
  </AbsoluteFill>
);

/** Share gauge: the leader's slice of the visible total. */
export const ShareGauge: React.FC<{ fraction: number; label: string; theme: Theme; color: string; width: number; appear: number }> = ({
  fraction,
  label,
  theme,
  color,
  width,
  appear,
}) => {
  const clamped = Math.max(0.02, Math.min(1, fraction));
  return (
    <div style={{ width, opacity: appear }}>
      <div style={{ height: 16, background: theme.barTrack, borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ width: `${clamped * 100}%`, height: '100%', background: color, borderRadius: 8 }} />
      </div>
      <div style={{ marginTop: 6, fontSize: 15, fontWeight: 700, color: theme.secondaryText, textAlign: 'right' }}>{label}</div>
    </div>
  );
};
/** Vertical bar chart used for the secondary "by group" panel. */
export const GroupBarChart: React.FC<{
  groups: Array<{ label: string; value: number; color: string }>;
  theme: Theme;
  width: number;
  height: number;
  appear: number;
}> = ({ groups, theme, width, height, appear }) => {
  const max = Math.max(1, ...groups.map((g) => g.value));
  const columnWidth = width / Math.max(1, groups.length);
  return (
    <div style={{ width, height, display: 'flex', alignItems: 'flex-end', gap: columnWidth * 0.22, opacity: appear }}>
      {groups.map((group) => {
        // Keep a minimum height so a small value still reads as a bar, not a rule.
        const h = Math.max(6, (group.value / max) * height * 0.72);
        return (
          <div key={group.label} style={{ width: columnWidth * 0.78, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
            <div style={{ fontSize: height * 0.075, fontWeight: 700, color: theme.secondaryText, marginBottom: height * 0.03, fontVariantNumeric: 'tabular-nums' }}>
              {compactNumber(group.value)}
            </div>
            <div style={{ width: '100%', height: h, background: group.color, borderRadius: `${height * 0.05}px ${height * 0.05}px 0 0` }} />
            <div style={{ fontSize: height * 0.075, fontWeight: 700, color: theme.primaryText, marginTop: height * 0.035, textAlign: 'center' }}>
              {group.label}
            </div>
          </div>
        );
      })}
    </div>
  );
};

/** Pale ring used beside the summary number. */
export const PieSummary: React.FC<{ fraction: number; theme: Theme; size?: number }> = ({ fraction, theme, size = 92 }) => {
  const clamped = Math.max(0.03, Math.min(1, fraction));
  const radius = size / 2 - 6;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={radius} fill="#fde8ea" stroke={theme.primaryText} strokeWidth={1.5} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={theme.accent}
        strokeWidth={radius * 0.62}
        strokeDasharray={`${circumference * clamped} ${circumference}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
};

/** Large light date stamp, e.g. "09/2008". */
export const BigDate: React.FC<{ label: string; theme: Theme; fontSize: number }> = ({ label, theme, fontSize }) => (
  <div style={{ fontSize, fontWeight: 800, color: theme.mutedText, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
    {label}
  </div>
);

/** Animated value that counts up between two frames. */
export const NumberCounter: React.FC<{ from: number; to: number; progress: number; unit: string; theme: Theme; fontSize: number }> = ({ from, to, progress, unit, theme, fontSize }) => {
  const value = from + (to - from) * progress;
  return (
    <div style={{ fontSize, fontWeight: 800, color: theme.primaryText, fontVariantNumeric: 'tabular-nums' }}>
      {formatValue(value, unit)}
    </div>
  );
};

export const useAppear = (startFrame: number, durationInFrames = 12): number => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - startFrame, fps, durationInFrames, config: { damping: 200 } });
};

export const fadeBetween = (frame: number, start: number, end: number): number =>
  interpolate(frame, [start, end], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
// ---------------------------------------------------------------------------
// Fact box (the "Nokia Peak" panel from the reference layout)
// ---------------------------------------------------------------------------

export interface FactBoxProps {
  heading: string;
  body: string;
  dateLabel?: string;
  wordmark?: string;
  theme: Theme;
  appear: number;
  width: number;
  accentColor?: string;
}

export const FactBox: React.FC<FactBoxProps> = ({ heading, body, dateLabel, wordmark, theme, appear, width, accentColor }) => (
  <div
    style={{
      width,
      opacity: appear,
      transform: `translateY(${(1 - appear) * 18}px)`,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-end',
      gap: 18,
    }}
  >
    <div style={{ width: '100%', height: 6, borderRadius: 3, background: accentColor ?? theme.accent, opacity: 0.9 }} />
    <div style={{ width: '100%', fontSize: 46, fontWeight: 800, color: theme.primaryText, letterSpacing: '-0.02em', textAlign: 'right' }}>{heading}</div>
    <div style={{ width: '100%', fontSize: 24, fontWeight: 600, color: theme.secondaryText, lineHeight: 1.35, textAlign: 'right' }}>{body}</div>
    {wordmark ? (
      <div style={{ width: '100%', fontSize: 62, fontWeight: 900, color: accentColor ?? theme.primaryText, letterSpacing: '-0.04em', textAlign: 'right', lineHeight: 1 }}>
        {wordmark}
      </div>
    ) : null}
    {dateLabel ? <BigDate label={dateLabel} theme={theme} fontSize={72} /> : null}
  </div>
);

// ---------------------------------------------------------------------------
// Highlight arrow
// ---------------------------------------------------------------------------

export const HighlightArrow: React.FC<{ theme: Theme; color: string; appear: number; size?: number }> = ({ color, appear, size = 34 }) => (
  <div
    style={{
      width: size,
      height: size,
      opacity: appear,
      transform: `translateX(${(1 - appear) * 10}px)`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color,
      fontSize: size,
      fontWeight: 900,
      lineHeight: 1,
    }}
  >
    ▲
  </div>
);

// ---------------------------------------------------------------------------
// Title + source card
// ---------------------------------------------------------------------------

export const TitleBlock: React.FC<{ title: string; subtitle?: string; theme: Theme; appear: number; titleSize?: number; subtitleSize?: number; align?: 'center' | 'left' }> = ({
  title,
  subtitle,
  theme,
  appear,
  titleSize = 64,
  subtitleSize = 28,
  align = 'center',
}) => (
  <div style={{ width: '100%', textAlign: align, opacity: appear, transform: `translateY(${(1 - appear) * 16}px)` }}>
    <div style={{ fontSize: titleSize, fontWeight: 800, color: theme.primaryText, letterSpacing: '-0.03em', lineHeight: 1.08 }}>{title}</div>
    {subtitle ? <div style={{ fontSize: subtitleSize, fontWeight: 600, color: theme.secondaryText, marginTop: titleSize * 0.28 }}>{subtitle}</div> : null}
  </div>
);

export const SourceCard: React.FC<{ sourcesLine: string; sources: Array<{ url: string; publisher: string }>; theme: Theme; appear: number }> = ({
  sourcesLine,
  sources,
  theme,
  appear,
}) => (
  <div style={{ width: '86%', opacity: appear, display: 'flex', flexDirection: 'column', gap: 26 }}>
    <div style={{ fontSize: 44, fontWeight: 800, color: theme.primaryText, letterSpacing: '-0.02em' }}>Sources</div>
    <div style={{ fontSize: 24, fontWeight: 600, color: theme.secondaryText }}>{sourcesLine}</div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {sources.slice(0, 8).map((source) => (
        <div key={source.url} style={{ fontSize: 19, color: theme.secondaryText, borderLeft: `4px solid ${theme.accent}`, paddingLeft: 14 }}>
          <span style={{ fontWeight: 700, color: theme.primaryText }}>{source.publisher}</span> — {source.url}
        </div>
      ))}
    </div>
    <div style={{ fontSize: 17, color: theme.mutedText }}>Every value in this video is traceable to one of the sources above. Missing values are shown as missing, never guessed.</div>
  </div>
);

// ---------------------------------------------------------------------------
// Canvas chrome
// ---------------------------------------------------------------------------

export const Canvas: React.FC<{ theme: Theme; children: React.ReactNode }> = ({ theme, children }) => (
  <AbsoluteFill
    style={{
      backgroundColor: '#000000',
      fontFamily: theme.fontFamily,
    }}
  >
    {children}
  </AbsoluteFill>
);

export const NoteStrip: React.FC<{ notes: string[]; theme: Theme; opacity?: number }> = ({ notes, theme, opacity = 0.62 }) => {
  if (notes.length === 0) return null;
  return (
    <div style={{ position: 'absolute', left: 46, bottom: 20, maxWidth: 1000, fontSize: 15, lineHeight: 1.35, color: theme.secondaryText, opacity }}>
      {notes.slice(0, 2).map((note, index) => (
        <div key={index}>• {note}</div>
      ))}
    </div>
  );
};
/**
 * Design-space scaler: the whole layout is authored in 1280x720 coordinates;
 * this wrapper scales it to the composition's real canvas (e.g. 1920x1080)
 * so one layout serves every output resolution without re-tuning geometry.
 */
export const DesignScale: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { width } = useVideoConfig();
  const scale = width / 1280;
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: 1280,
        height: 720,
        transform: `scale(${scale})`,
        transformOrigin: 'top left',
      }}
    >
      {children}
    </div>
  );
};
