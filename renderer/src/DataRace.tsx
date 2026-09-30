/**
 * The data-race composition.
 *
 * The data-race composition (1280x720 baseline), in the classic full-bleed style:
 *   header       video title, separated by a hairline
 *   left         ranking bars (name in white bold inside the bar, flag at the
 *                bar end, value in dark type past the flag) - geometrically
 *                confined to x 0..880
 *   right        info panel (x 904..1232): giant live year, headline +
 *                narrative or live leader, featured flags. A RESERVED zone:
 *                bars can never enter it, so overlap is impossible.
 *   (title / intro / ending / source card are their own scenes)
 */

import React, { useMemo } from 'react';
import { AbsoluteFill, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Dataset } from '@avm/shared';
import { makeTheme } from './theme';
import type { FrameTape, FrameTapeEntity } from './frameTape';
import { DEFAULT_FLAG_BASE, type RenderInput } from './types';
import {
  BrandMark,
  Canvas,
  DesignScale,
  InfoPanel,
  RaceHeader,
  RankingRow,
  SpotlightCard,
  TitleBlock,
  formatRaceValue,
} from './components';

interface Highlight {
  atFrame: number;
  atLabel: string;
  entityId: string;
  headline: string;
  detail: string;
  factBox?: { heading: string; body: string; dateLabel?: string; wordmark?: string };
}

/** Row vertical positions glide between the tape's integer ranks
 * (the easing itself lives in the row builder below alongside width/value). */
function easedRank(r0: number, r1: number, te: number): number {
  return r0 + (r1 - r0) * te;
}

function groupTotals(tape: FrameTape, frameIndex: number): Array<{ label: string; value: number; color: string }> {
  const frame = tape.frames[Math.min(Math.max(0, frameIndex), tape.frames.length - 1)];
  if (!frame) return [];
  const totals = new Map<string, { value: number; color: string }>();
  for (const bar of frame.bars) {
    const entity = tape.entities.find((e) => e.id === bar.entityId);
    const group = entity?.group ?? 'Other';
    const entry = totals.get(group) ?? { value: 0, color: entity?.color ?? '#111827' };
    entry.value += bar.value;
    totals.set(group, entry);
  }
  return Array.from(totals.entries())
    .map(([label, v]) => ({ label, value: v.value, color: v.color }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);
}

/**
 * The bar-race scene, polished style:
 * header (title left, giant year right, hairline divider), pill bars with page
 * margins and rank numbers, flag + value past the bar end, bordered spotlight
 * card on the right, progress track along the bottom. Values, widths and ranks
 * are eased between the two bracketing tape frames so motion glides.
 */
const BarRace: React.FC<{
  input: RenderInput;
  highlights: Highlight[];
  durationInFrames: number;
  /** Absolute tape-frame range this segment covers (for split races). */
  tapeStart?: number;
  tapeEnd?: number;
}> = ({ input, highlights, durationInFrames, tapeStart = 0, tapeEnd }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const tape = input.frameTape;
  const dataset = input.dataset;
  const story = input.story;
  const flagBaseUrl = input.flagBaseUrl ?? DEFAULT_FLAG_BASE;

  const tapeCount = tape.frames.length;
  const tapeFps = tape.fps || 30;
  const rangeStart = Math.max(0, Math.min(tapeCount - 1, tapeStart));
  const rangeEnd = Math.max(rangeStart, Math.min(tapeCount - 1, tapeEnd ?? tapeCount - 1));

  // Fractional position in tape-frame units within this segment's range; the
  // two bracketing tape frames are interpolated so bars glide smoothly.
  const tapePos = Math.min(
    rangeEnd,
    Math.max(rangeStart, rangeStart + (frame / Math.max(1, durationInFrames)) * (rangeEnd - rangeStart)),
  );
  const i0 = Math.min(tapeCount - 1, Math.floor(tapePos));
  const i1 = Math.min(tapeCount - 1, i0 + 1);
  const t = Math.min(1, Math.max(0, tapePos - i0));
  // Ease the blend so bars accelerate/decelerate instead of moving linearly.
  const te = t * t * (3 - 2 * t);
  const f0 = tape.frames[i0];
  const f1 = tape.frames[i1];

  const entityById = useMemo(() => new Map(tape.entities.map((e) => [e.id, e])), [tape]);
  const labelToTapeIndex = useMemo(() => {
    const m = new Map<string, number>();
    tape.frames.forEach((f, idx) => {
      if (!m.has(f.label)) m.set(f.label, idx);
    });
    return m;
  }, [tape]);

  interface Row {
    id: string;
    value: number;
    widthFrac: number;
    rank: number;
    held: boolean;
    appear: number;
  }

  const { rows, barCount } = useMemo(() => {
    const a = new Map((f0?.bars ?? []).map((b) => [b.entityId, b]));
    const b = new Map((f1?.bars ?? []).map((b) => [b.entityId, b]));
    const ids = new Set<string>([...a.keys(), ...b.keys()]);
    const count = Math.max(f0?.bars.length ?? 0, f1?.bars.length ?? 0, 1);
    const out: Row[] = [];
    for (const id of ids) {
      const ba = a.get(id);
      const bb = b.get(id);
      if (ba && bb) {
        out.push({
          id,
          value: ba.value + (bb.value - ba.value) * te,
          widthFrac: ba.width + (bb.width - ba.width) * te,
          // Rank glides between the tape's INTEGER ranks with the same
          // easing as width/value. (The old exponential smooth-ranks never
          // settled when ranks changed faster than its blend window, so
          // rows sat at fractional positions and overlapped their
          // neighbors -- the C1 QA failures / visibly doubled rows.)
          // At settled tape frames te is 0 or 1, so ranks are exactly
          // integers and rows never overlap.
          rank: easedRank(ba.rank, bb.rank, te),
          held: ba.held ?? bb.held ?? false,
          appear: 1,
        });
      } else if (bb) {
        // entering the top-N: glide up from below the list
        // Width stays at full target (no grow-from-zero) to avoid the
        // "smaller-then-bigger" flicker; only position and opacity animate.
        out.push({
          id,
          value: bb.value,
          widthFrac: bb.width,
          rank: count + 1 + (bb.rank - (count + 1)) * te,
          held: bb.held ?? false,
          appear: te,
        });
      } else if (ba) {
        // leaving the top-N: glide down out of the list
        // Width stays constant (no shrink-to-zero) to avoid flicker;
        // only position and opacity animate.
        out.push({
          id,
          value: ba.value,
          widthFrac: ba.width,
          rank: ba.rank + (count + 1 - ba.rank) * te,
          held: ba.held ?? false,
          appear: 1 - te,
        });
      }
    }
    out.sort((x, y) => x.rank - y.rank);
    return { rows: out.slice(0, count + 2), barCount: count };
  }, [f0, f1, t, te, i0, i1]);

  // Layout zones (design space 1280x720), CONSTANT for the whole video:
  //   header:     y 0..96   (title)
  //   race zone:  x 0..880, y 112..656  (rank numbers, bars, flags, values)
  //   info panel: x 904..1232, y 112..656  (RESERVED - bars can never enter)
  //   progress:   y 688..700  (thin track, full width)
  //
  // The never-overlap guarantee is structural: maxBarWidth is computed once
  // from the tape's longest formatted value label so that even the longest
  // bar + its flag + its value label ends before RACE_RIGHT (880), and the
  // panel starts at 904. RankingRow additionally ellipsis-caps an
  // outside-the-bar name to the remaining space. Overlap is impossible by
  // construction, not by pixel-tuning.
  const RACE_RIGHT = 880;
  const PANEL_X = 904;
  const PANEL_W = 1232 - PANEL_X;
  const raceTop = 112;
  const raceBottom = 656;
  // Row height is CONSTANT for the whole video, based on the tape's topN:
  // bars must never resize as entities enter or leave. Early periods show
  // fewer rows with vacant space below instead of ballooning the first rows
  // big and then shrinking them when newcomers arrive.
  const rowHeight = (raceBottom - raceTop) / Math.max(1, tape.topN || barCount);
  const barX0 = 190;
  const flagSize = Math.min(rowHeight * 0.72, 46);
  const valueFont = Math.max(19, rowHeight * 0.4);
  // Longest formatted value label in the whole tape -> reserved label width.
  // Measured once per video, so maxBarWidth is fixed for every frame.
  const maxValueW = useMemo(() => {
    let longest = 0;
    for (const f of tape.frames) {
      for (const b of f.bars) {
        longest = Math.max(longest, formatRaceValue(b.value, dataset.unit).length);
      }
    }
    return longest * valueFont * 0.58;
  }, [tape, dataset.unit, valueFont]);
  const maxBarWidth = Math.max(
    300,
    RACE_RIGHT - barX0 - 12 - flagSize - 12 - maxValueW - 16,
  );
  const introAppear = interpolate(frame, [0, Math.min(18, durationInFrames)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Right-hand spotlight card -------------------------------------------------
  // Highlight windows are measured in SCREEN time (6s each): with slow-motion
  // pacing a tape-frame window would keep stale text up for nearly a minute.
  const tapeSpan = Math.max(1, rangeEnd - rangeStart);
  const toScreenFrame = (tapeFrame: number) =>
    ((tapeFrame - rangeStart) / tapeSpan) * durationInFrames;
  const activeHighlight = highlights.find((h) => {
    const s = toScreenFrame(h.atFrame);
    return frame >= s && frame < s + 6 * fps;
  });
  // The year always tracks the current period. A highlight only overrides the
  // card's headline/body - it must never freeze the year counter.
  const currentLabel = t < 0.5 ? f0?.label ?? '' : f1?.label ?? '';
  const segment = useMemo(() => {
    if (!story) return undefined;
    let current: (typeof story.sequence)[number] | undefined;
    for (const s of story.sequence) {
      const idx = labelToTapeIndex.get(s.atLabel);
      const curIdx = current ? labelToTapeIndex.get(current.atLabel) ?? -1 : -1;
      if (idx !== undefined && idx <= tapePos && idx > curIdx) current = s;
    }
    return current;
  }, [story, labelToTapeIndex, tapePos]);
  // Card content: an active highlight takes precedence; otherwise a story
  // segment may show - but ONLY for a few screen-seconds after its period
  // begins, with a fade in/out. Stale narrative must never linger on screen
  // (the 1960 card once sat there for the entire race).
  const cardContent = ((): { title?: string; body: string; start: number; end: number } | null => {
    if (activeHighlight) {
      const s = toScreenFrame(activeHighlight.atFrame);
      return {
        title: activeHighlight.headline,
        body: activeHighlight.detail ?? '',
        start: s,
        end: s + 6 * fps,
      };
    }
    if (segment?.text) {
      const idx = labelToTapeIndex.get(segment.atLabel);
      if (idx !== undefined) {
        const s = ((idx - rangeStart) / tapeSpan) * durationInFrames;
        const end = s + 10 * fps;
        if (frame >= s && frame < end) {
          return { body: segment.text, start: s, end };
        }
      }
    }
    return null;
  })();
  const featured = useMemo(() => {
    if (activeHighlight) {
      const e = entityById.get(activeHighlight.entityId);
      return e ? [e] : [];
    }
    return [...rows]
      .sort((x, y) => y.value - x.value)
      .slice(0, 2)
      .map((r) => entityById.get(r.id))
      .filter((e): e is FrameTapeEntity => !!e);
  }, [activeHighlight, rows, entityById]);

  const chromeAppear = interpolate(frame, [0, 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  // Progress across the whole race (all segments), not just this one.
  const progress = tapeCount > 1 ? tapePos / (tapeCount - 1) : 0;

  // Info-panel content: an active highlight or a fresh story segment takes
  // precedence; otherwise the panel shows the live leader (name + value).
  // The year counter always tracks the current period either way.
  const leaderRow = useMemo(() => {
    let best: (typeof rows)[number] | undefined;
    for (const r of rows) {
      if (!best || r.value > best.value) best = r;
    }
    return best;
  }, [rows]);
  const leaderEntity = leaderRow ? entityById.get(leaderRow.id) : undefined;
  const panelKicker = cardContent ? 'SPOTLIGHT' : 'LEADER';
  const panelHeadline = cardContent
    ? cardContent.title
    : leaderEntity?.name;
  const panelBody = cardContent ? cardContent.body : undefined;
  const panelStat = cardContent
    ? undefined
    : leaderRow
      ? formatRaceValue(leaderRow.value, dataset.unit)
      : undefined;

  return (
    <AbsoluteFill style={{ background: '#ffffff' }}>
      <RaceHeader title={input.videoSpec.metadata.title} appear={chromeAppear} />
      {rows.map((row) => {
        const entity = entityById.get(row.id);
        if (!entity) return null;
        return (
          <RankingRow
            key={row.id}
            entity={entity}
            value={row.value}
            widthFrac={row.widthFrac}
            rank={row.rank}
            held={row.held}
            unit={dataset.unit}
            y={raceTop + (row.rank - 1) * rowHeight}
            rowHeight={rowHeight}
            x0={barX0}
            maxBarWidth={maxBarWidth}
            raceRight={RACE_RIGHT}
            appear={Math.max(0, Math.min(1, row.appear * introAppear))}
            flagBaseUrl={flagBaseUrl}
          />
        );
      })}
      {/* Right-side info panel (x 904..1232): giant live year + headline /
          narrative. Ranking rows are geometrically barred from this zone
          (maxBarWidth + ellipsis caps), so it can never overlap a bar. */}
      <InfoPanel
        yearLabel={currentLabel}
        kicker={panelKicker}
        headline={panelHeadline}
        body={panelBody}
        stat={panelStat}
        featured={featured}
        flagBaseUrl={flagBaseUrl}
        appear={chromeAppear}
        x={PANEL_X}
        y={raceTop}
        width={PANEL_W}
        height={raceBottom - raceTop}
      />
      {/* Slim progress track along the very bottom. */}
      <div style={{ position: 'absolute', left: 48, right: 48, top: 690, height: 4, background: '#eef0f3', borderRadius: 2, overflow: 'hidden', opacity: chromeAppear }}>
        <div style={{ width: `${Math.max(0, Math.min(100, progress * 100))}%`, height: '100%', background: '#e11d2e', borderRadius: 2 }} />
      </div>
    </AbsoluteFill>
  );
};


export const DataRace: React.FC<{ input: RenderInput }> = ({ input }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const theme = makeTheme(input.videoSpec.theme as Record<string, string | number>);
  const spec = input.videoSpec;
  const offsets: Array<{ id: string; type: string; from: number; to: number; durationInFrames: number; scene: (typeof spec.scenes)[number] }> = [];
  let cursor = 0;
  for (const scene of spec.scenes) {
    const durationInFrames = Math.round(scene.duration * fps);
    offsets.push({ id: scene.id, type: scene.type, from: cursor, to: cursor + durationInFrames, durationInFrames, scene });
    cursor += durationInFrames;
  }

  const raceOffsets = offsets.filter((o) => o.type === 'bar_race');
  const highlights = raceOffsets.flatMap((o) =>
    (((o.scene.props?.highlights as unknown[]) ?? []) as Record<string, unknown>[]).map((h) => ({
      atFrame: Number(h.atFrame ?? 0),
      atLabel: String(h.atLabel ?? ''),
      entityId: String(h.entityId ?? ''),
      headline: String(h.headline ?? ''),
      detail: String(h.detail ?? ''),
      factBox: h.factBox as Highlight['factBox'],
    })),
  );

  const endingScene = offsets.find((o) => o.type === 'ending');
  const introScene = offsets.find((o) => o.type === 'intro');
  const titleScene = offsets.find((o) => o.type === 'title');
  const factBoxScenes = offsets.filter((o) => o.type === 'fact_box');
  const tapeEntities = input.frameTape.entities;
  const flagBase = input.flagBaseUrl ?? DEFAULT_FLAG_BASE;

  return (
    <Canvas theme={theme}>
      <DesignScale>
      {titleScene ? (
        <Sequence from={titleScene.from} durationInFrames={titleScene.durationInFrames}>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', padding: '0 90px' }}>
            <BrandMark theme={theme} size={74} />
            <div style={{ marginTop: 30, width: '100%' }}>
              <TitleBlock
                title={spec.metadata.title}
                subtitle={spec.metadata.subtitle}
                theme={theme}
                appear={interpolate(frame - titleScene.from, [0, 16], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })}
                titleSize={66}
              />
            </div>
          </AbsoluteFill>
        </Sequence>
      ) : null}

      {introScene ? (
        <Sequence from={introScene.from} durationInFrames={introScene.durationInFrames}>
          <AbsoluteFill style={{ justifyContent: 'center', padding: '0 110px', background: theme.background }}>
            <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '0.22em', color: theme.accent, marginBottom: 22 }}>WHAT THIS SHOWS</div>
            <TitleBlock
              title={introScene.scene.title || spec.metadata.title || ''}
              subtitle={introScene.scene.subtitle}
              theme={theme}
              align="left"
              appear={interpolate(frame - introScene.from, [0, 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })}
              titleSize={46}
              subtitleSize={26}
            />
            <div style={{ marginTop: 36 }}>
              <span
                style={{
                  fontSize: 24,
                  fontWeight: 800,
                  letterSpacing: '0.18em',
                  color: theme.background,
                  background: theme.accent,
                  padding: '12px 30px',
                  borderRadius: 999,
                }}
              >
                {input.dataset.timeRange.start} – {input.dataset.timeRange.end}
              </span>
            </div>
          </AbsoluteFill>
        </Sequence>
      ) : null}

      {raceOffsets.map((o) => {
        const props = (o.scene.props ?? {}) as Record<string, unknown>;
        const tapeRange = Array.isArray(props.tapeRange) ? (props.tapeRange as number[]) : undefined;
        return (
          <Sequence key={o.id} from={o.from} durationInFrames={o.durationInFrames}>
            <BarRace
              input={input}
              highlights={highlights}
              durationInFrames={o.durationInFrames}
              tapeStart={tapeRange?.[0] ?? 0}
              tapeEnd={tapeRange?.[1]}
            />
          </Sequence>
        );
      })}

      {factBoxScenes.map((o) => {
        const props = (o.scene.props ?? {}) as Record<string, unknown>;
        const entityIds = Array.isArray(props.entityIds) ? (props.entityIds as string[]) : [];
        const featured = entityIds
          .map((id) => tapeEntities.find((e) => e.id === id))
          .filter((e): e is (typeof tapeEntities)[number] => !!e);
        const localFrame = frame - o.from;
        return (
          <Sequence key={o.id} from={o.from} durationInFrames={o.durationInFrames}>
            <SpotlightCard
              kicker={String(props.kicker ?? 'SPOTLIGHT')}
              yearLabel={String(props.atLabel ?? '')}
              headline={String(o.scene.title ?? '')}
              body={String(props.body ?? o.scene.subtitle ?? '')}
              featured={featured}
              flagBaseUrl={flagBase}
              appear={interpolate(localFrame, [0, 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })}
            />
          </Sequence>
        );
      })}

      {endingScene ? (
        <Sequence from={endingScene.from} durationInFrames={endingScene.durationInFrames}>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', padding: '0 110px' }}>
            <TitleBlock
              title={endingScene.scene.title ?? spec.metadata.title}
              theme={theme}
              appear={interpolate(frame - endingScene.from, [0, 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })}
              titleSize={44}
            />
            <div style={{ marginTop: 30 }}>
              <span
                style={{
                  fontSize: 22,
                  fontWeight: 800,
                  letterSpacing: '0.18em',
                  color: theme.background,
                  background: theme.accent,
                  padding: '11px 28px',
                  borderRadius: 999,
                }}
              >
                {input.dataset.timeRange.start} – {input.dataset.timeRange.end}
              </span>
            </div>
          </AbsoluteFill>
        </Sequence>
      ) : null}

      </DesignScale>
    </Canvas>
  );
};