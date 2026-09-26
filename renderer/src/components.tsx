/**
 * Reusable visual components.
 *
 * Everything is deterministic: the same frame always produces the same pixels.
 * No remote fonts, no remote images except optional flag assets, and no
 * third-party logos - entity identity is rendered as a monogram badge.
 */

import React, { useState } from 'react';
import { AbsoluteFill, Img, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { DEFAULT_FLAG_BASE } from './types';
import { compactNumber, formatValue, type Theme } from './theme';
import type { FrameTapeBar, FrameTapeEntity } from './frameTape';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** The small circular accent mark in the top-left corner. */
export const BrandMark: React.FC<{ theme: Theme; size?: number }> = ({ theme, size = 54 }) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: '50%',
      background: theme.accent,
      display: 'flex',
      alignItems: 'flex-end',
      justifyContent: 'center',
      gap: size * 0.11,
      paddingBottom: size * 0.26,
      boxSizing: 'border-box',
      boxShadow: '0 6px 18px rgba(17,24,39,0.18)',
    }}
  >
    {[0.5, 0.85, 0.65].map((factor, index) => (
      <div
        key={index}
        style={{
          width: size * 0.11,
          height: size * 0.52 * factor,
          background: '#ffffff',
          borderRadius: size * 0.05,
        }}
      />
    ))}
  </div>
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
 * Flag image with a monogram fallback. Flag CDNs can hiccup (or be blocked);
 * a broken-image glyph on a YouTube video is worse than no flag at all, so a
 * failed load swaps to the entity's LogoBadge.
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
  const srcUrl = entity.flagDataUri ?? (entity.flagCode ? `${baseUrl}/${variant}/${entity.flagCode}.png` : undefined);
  if (!srcUrl || failed) {
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
  appear: number;
  flagBaseUrl: string;
}

/**
 * One ranking bar in the polished race style:
 * rank number in the left margin, pill-shaped bar with a soft shadow, entity
 * name in white bold LEFT-aligned inside the bar, flag attached to the bar
 * end, value in dark type just past the flag. When the name cannot fit inside
 * even at the minimum readable size it is set outside past the value - it is
 * always rendered exactly once, never dropped.
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
  appear,
  flagBaseUrl,
}) => {
  const barHeight = rowHeight - 16;
  // Bar width is strictly proportional to value: widthFrac is value/maxValue
  // from the frame tape. The minimum is a stub only (4px) so the pill still
  // renders - a large clamp (this used to be 110px) makes every small bar
  // identical width and destroys the visual ranking. Names that cannot fit
  // inside a narrow bar are rendered outside past the value (see below).
  const barW = Math.max(4, widthFrac * maxBarWidth);
  const baseFont = Math.max(20, rowHeight * 0.44);
  const flagSize = Math.min(rowHeight * 0.72, 46);
  const valueFont = Math.max(19, rowHeight * 0.4);

  // Does the name fit inside the bar at a readable size? Estimate width with
  // a 0.58 average glyph ratio for bold type.
  const MIN_INSIDE_FONT = 20;
  const estimateWidth = (fontSize: number) => entity.name.length * fontSize * 0.58;
  const insideAvailable = barW - 44; // 24px left pad + 20px right pad
  let insideFont = baseFont;
  if (estimateWidth(baseFont) > insideAvailable) {
    insideFont = (insideAvailable / Math.max(1, entity.name.length)) * 1.72;
  }
  const nameFitsInside = insideFont >= MIN_INSIDE_FONT;
  const nameFont = nameFitsInside ? Math.min(baseFont, insideFont) : baseFont;
  const rankLabel = String(Math.max(1, Math.round(rank)));

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
      {/* rank number in the left margin */}
      <div
        style={{
          position: 'absolute',
          left: x0 - 46,
          top: 0,
          bottom: 0,
          width: 36,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          fontSize: Math.max(18, rowHeight * 0.36),
          fontWeight: 800,
          color: '#9ca3af',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {rankLabel}
      </div>

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
          boxShadow: '0 4px 16px rgba(17,24,39,0.20), 0 1px 4px rgba(17,24,39,0.14)',
          opacity: held ? 0.55 : 1,
          overflow: 'hidden',
        }}
      >
        {/* premium gloss: bright top sheen fading into a soft bottom shade */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
            borderRadius: 'inherit',
            background:
              'linear-gradient(180deg, rgba(255,255,255,0.38) 0%, rgba(255,255,255,0.10) 42%, rgba(255,255,255,0) 62%, rgba(0,0,0,0.12) 100%)',
            pointerEvents: 'none',
          }}
        />
        {/* name: white bold, left-aligned inside the bar (only when it fits) */}
        {nameFitsInside ? (
          <div
            style={{
              position: 'absolute',
              left: 22,
              top: 0,
              bottom: 0,
              display: 'flex',
              alignItems: 'center',
              whiteSpace: 'nowrap',
              color: '#ffffff',
              fontWeight: 800,
              fontSize: nameFont,
              letterSpacing: '-0.01em',
              textShadow: '0 1px 3px rgba(0,0,0,0.28)',
              zIndex: 1,
            }}
          >
            {entity.name}
          </div>
        ) : null}
      </div>

      {/* flag + value + (outside name when it can't fit inside), in one row */}
      <div
        style={{
          position: 'absolute',
          left: x0 + barW + 12,
          top: 0,
          bottom: 0,
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <div style={{ marginRight: 12 }}>
          <FlagImage entity={entity} size={flagSize} variant="w80" invertBadge baseUrl={flagBaseUrl} style={{ boxShadow: '0 1px 3px rgba(0,0,0,0.25)' }} />
        </div>

        {/* value in dark type past the flag */}
        <div
          style={{
            whiteSpace: 'nowrap',
            fontSize: valueFont,
            fontWeight: 700,
            color: '#1f2937',
            fontVariantNumeric: 'tabular-nums',
            marginRight: nameFitsInside ? 0 : 14,
          }}
        >
          {formatRaceValue(value, unit)}
        </div>

        {/* name outside the bar when too narrow to hold it - always rendered */}
        {!nameFitsInside ? (
          <div
            style={{
              whiteSpace: 'nowrap',
              color: '#1f2937',
              fontWeight: 800,
              fontSize: nameFont,
              letterSpacing: '-0.01em',
            }}
          >
            {entity.name}
          </div>
        ) : null}
      </div>
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
// Era panel (the right-hand column: giant year, era title, narrative, flags)
// ---------------------------------------------------------------------------

export interface EraPanelProps {
  title?: string;
  body?: string;
  featured: FrameTapeEntity[];
  flagBaseUrl: string;
  appear: number;
}

/**
 * The right-hand panel: a bordered card with a soft shadow so it reads as a
 * distinct surface instead of text floating in empty space. It sits LOW on
 * the right (below the main bar zone) so it never overlaps the leader's
 * value label at the top.
 */
export const EraPanel: React.FC<EraPanelProps> = ({ title, body, featured, flagBaseUrl, appear }) => {
  const accent = featured[0]?.color ?? '#e11d2e';
  return (
    <div
      style={{
        position: 'absolute',
        left: 730,
        top: 120,
        width: 520,
        background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
        border: '2px solid #e5e7eb',
        borderLeft: `8px solid ${accent}`,
        borderRadius: 24,
        boxShadow: '0 24px 64px rgba(17,24,39,0.18)',
        padding: '32px 32px 36px',
        opacity: appear,
        transform: `translateY(${(1 - appear) * 16}px) scale(${0.95 + appear * 0.05})`,
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: '0.28em', color: accent, marginBottom: 14 }}>✨ SPOTLIGHT</div>
      {title ? (
        <div style={{ fontSize: 40, fontWeight: 900, color: '#111111', lineHeight: 1.15, letterSpacing: '-0.02em' }}>{title}</div>
      ) : null}
      {body ? (
        <div style={{ marginTop: 14, fontSize: 22, fontWeight: 500, color: '#4b5563', lineHeight: 1.5 }}>
          {formatNarrativeNumbers(body)}
        </div>
      ) : null}
      {featured.length > 0 ? (
        <div style={{ marginTop: 20, display: 'flex', gap: 12, alignItems: 'center' }}>
          {featured.slice(0, 2).map((entity) => (
            <div
              key={entity.id}
              style={{
                borderRadius: 10,
                padding: 3,
                background: `linear-gradient(135deg, ${entity.color}, ${entity.color}88)`,
                boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
              }}
            >
              <FlagImage
                entity={entity}
                size={62}
                variant="w160"
                baseUrl={flagBaseUrl}
                style={{ borderRadius: 7, display: 'block', background: '#fff' }}
              />
            </div>
          ))}
          {featured[0] ? (
            <div style={{ fontSize: 17, fontWeight: 800, color: '#111827', lineHeight: 1.25 }}>{featured[0].name}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

/**
 * The race header: video title on the left, the giant current-year counter on
 * the right, separated from the race by a hairline. Gives the scene its frame.
 */
export const RaceHeader: React.FC<{ title: string; yearLabel: string; appear: number }> = ({ title, yearLabel, appear }) => (
  <div
    style={{
      position: 'absolute',
      left: 0,
      right: 0,
      top: 0,
      height: 96,
      display: 'flex',
      alignItems: 'center',
      padding: '0 48px',
      background: '#ffffff',
      borderBottom: '1px solid #e5e7eb',
      opacity: appear,
    }}
  >
    <div style={{ fontSize: 27, fontWeight: 800, color: '#111827', letterSpacing: '-0.02em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 760 }}>
      {title}
    </div>
    <div style={{ marginLeft: 'auto', fontSize: 68, fontWeight: 800, color: '#111827', letterSpacing: '-0.03em', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
      {yearLabel}
    </div>
  </div>
);

/** Thin progress track along the bottom of the race scene. */
export const RaceProgress: React.FC<{ progress: number; caption: string; appear: number }> = ({ progress, caption, appear }) => (
  <div style={{ position: 'absolute', left: 48, right: 48, bottom: 26, opacity: appear }}>
    <div style={{ height: 6, background: '#eef0f3', borderRadius: 3, overflow: 'hidden' }}>
      <div style={{ width: `${Math.max(0, Math.min(100, progress * 100))}%`, height: '100%', background: '#e11d2e', borderRadius: 3 }} />
    </div>
    <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', fontSize: 14, fontWeight: 600, color: '#9ca3af' }}>
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
  <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', background: '#ffffff' }}>
    <div
      style={{
        width: 880,
        background: '#ffffff',
        border: '1px solid #e5e7eb',
        borderRadius: 28,
        boxShadow: '0 24px 64px rgba(17,24,39,0.12)',
        padding: '54px 64px 58px',
        opacity: appear,
        transform: `translateY(${(1 - appear) * 24}px)`,
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: '0.3em', color: '#e11d2e', marginBottom: 18 }}>{kicker}</div>
      <div style={{ fontSize: 120, fontWeight: 800, color: '#111827', letterSpacing: '-0.04em', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
        {yearLabel}
      </div>
      <div style={{ marginTop: 22, fontSize: 46, fontWeight: 800, color: '#111827', letterSpacing: '-0.02em', lineHeight: 1.2 }}>{headline}</div>
      <div style={{ marginTop: 18, fontSize: 25, fontWeight: 500, color: '#5c5c5c', lineHeight: 1.5 }}>{formatNarrativeNumbers(body)}</div>
      {featured.length > 0 ? (
        <div style={{ marginTop: 30, display: 'flex', gap: 16, justifyContent: 'center' }}>
          {featured.slice(0, 3).map((entity) => (
            <FlagImage
              key={entity.id}
              entity={entity}
              size={96}
              variant="w160"
              baseUrl={flagBaseUrl}
              style={{ borderRadius: 8, boxShadow: '0 2px 10px rgba(0,0,0,0.22)' }}
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
      backgroundColor: theme.background,
      fontFamily: theme.fontFamily,
      backgroundImage: `radial-gradient(circle at 50% 45%, ${theme.background} 55%, #eef0f3 100%)`,
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
/** Right-side panel: car illustration + topic title box, like the reference.
 * Shows when no spotlight is active. */
export interface SidePanelProps {
  topicTitle: string; // e.g. "TOP CAR PRODUCING COUNTRIES"
  yearRange: string;  // e.g. "1950-2025"
  carColor: string;   // car body color
  appear: number;
}

/** Simple side-view car SVG. */
const CarIllustration: React.FC<{ color: string }> = ({ color }) => (
  <svg viewBox="0 0 400 160" width="100%" height="140" style={{ display: 'block' }}>
    {/* Body */}
    <path
      d="M20 110 L40 70 L90 65 L120 35 L260 35 L290 65 L370 70 L380 110 L360 115 L340 115 L330 100 L80 100 L70 115 L40 115 Z"
      fill={color}
      stroke="#1a1a1a"
      strokeWidth="3"
    />
    {/* Windows */}
    <path d="M130 42 L155 42 L155 62 L125 62 Z" fill="#2d3748" />
    <path d="M165 42 L250 42 L270 62 L165 62 Z" fill="#2d3748" />
    {/* Wheels */}
    <circle cx="110" cy="115" r="28" fill="#1a1a1a" />
    <circle cx="110" cy="115" r="14" fill="#cbd5e0" />
    <circle cx="110" cy="115" r="6" fill="#4a5568" />
    <circle cx="300" cy="115" r="28" fill="#1a1a1a" />
    <circle cx="300" cy="115" r="14" fill="#cbd5e0" />
    <circle cx="300" cy="115" r="6" fill="#4a5568" />
    {/* Headlight */}
    <ellipse cx="365" cy="85" rx="10" ry="6" fill="#fefcbf" stroke="#1a1a1a" strokeWidth="2" />
    {/* Taillight */}
    <ellipse cx="25" cy="85" rx="8" ry="6" fill="#fc8181" stroke="#1a1a1a" strokeWidth="2" />
    {/* Door line */}
    <line x1="205" y1="42" x2="205" y2="100" stroke="#1a1a1a" strokeWidth="2" />
    {/* Handle */}
    <rect x="215" y="68" width="18" height="5" rx="2" fill="#1a1a1a" />
  </svg>
);

export const SidePanel: React.FC<SidePanelProps> = ({
  topicTitle,
  yearRange,
  carColor,
  appear,
}) => (
  <div
    style={{
      position: 'absolute',
      left: 750,
      top: 130,
      width: 480,
      opacity: appear,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
    }}
  >
    {/* Car illustration */}
    <div style={{ width: 420, marginBottom: 10 }}>
      <CarIllustration color={carColor} />
    </div>
    {/* Green topic box */}
    <div
      style={{
        width: 440,
        background: 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
        borderRadius: 8,
        padding: '28px 24px',
        boxShadow: '0 12px 32px rgba(34,197,94,0.3)',
        textAlign: 'center',
      }}
    >
      <div style={{
        fontSize: 38,
        fontWeight: 900,
        color: '#ffffff',
        lineHeight: 1.2,
        letterSpacing: '0.02em',
        textShadow: '0 2px 8px rgba(0,0,0,0.2)',
      }}>
        {topicTitle}
      </div>
      <div style={{
        marginTop: 8,
        fontSize: 44,
        fontWeight: 900,
        color: '#ffffff',
        letterSpacing: '0.05em',
        textShadow: '0 2px 8px rgba(0,0,0,0.2)',
      }}>
        {yearRange}
      </div>
    </div>
  </div>
);
