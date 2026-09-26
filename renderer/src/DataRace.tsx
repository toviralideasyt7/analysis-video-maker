/**
 * The data-race composition.
 *
 * The data-race composition (1280x720 baseline), in the classic full-bleed style:
 *   full height  ranking bars from the left edge (name in white bold inside the
 *                bar, flag at the bar end, value in dark type past the flag)
 *   right        era panel: giant year, era headline + narrative, featured flags
 *   (no header during the race; title / ending / source card are own scenes)
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
  EraPanel,
  RaceHeader,
  RaceProgress,
  RankingRow,
  SidePanel,
  SpotlightCard,
  TitleBlock,
} from './components';

interface Highlight {
  atFrame: number;
  atLabel: string;
  entityId: string;
  headline: string;
  detail: string;
  factBox?: { heading: string; body: string; dateLabel?: string; wordmark?: string };
}

interface SmoothRanks {
  ranks: Map<string, number>[];
}

/** Pre-compute animated ranks so row movement eases instead of snapping. */
function buildSmoothRanks(tape: FrameTape, blendFrames = 12): SmoothRanks {
  const smoothed: Map<string, number>[] = [];
  const displayed = new Map<string, { value: number; target: number; since: number }>();
  tape.frames.forEach((frame, index) => {
    for (const bar of frame.bars) {
      const existing = displayed.get(bar.entityId);
      if (!existing) {
        displayed.set(bar.entityId, { value: bar.rank, target: bar.rank, since: index });
        continue;
      }
      if (existing.target !== bar.rank) {
        existing.target = bar.rank;
        existing.since = index;
      }
      const progress = Math.min(1, (index - existing.since) / Math.max(1, blendFrames));
      const eased = 1 - (1 - progress) ** 3;
      existing.value = existing.value + (existing.target - existing.value) * eased;
    }
    smoothed.push(new Map(Array.from(displayed.entries()).map(([id, v]) => [id, v.value])));
  });
  return { ranks: smoothed };
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
  const smoothRanks = useMemo(() => buildSmoothRanks(tape), [tape]);
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
    const s0 = smoothRanks.ranks[i0];
    const s1 = smoothRanks.ranks[i1];
    const out: Row[] = [];
    for (const id of ids) {
      const ba = a.get(id);
      const bb = b.get(id);
      if (ba && bb) {
        const r0 = s0?.get(id) ?? ba.rank;
        const r1 = s1?.get(id) ?? bb.rank;
        out.push({
          id,
          value: ba.value + (bb.value - ba.value) * te,
          widthFrac: ba.width + (bb.width - ba.width) * te,
          rank: r0 + (r1 - r0) * te,
          held: ba.held ?? bb.held ?? false,
          appear: 1,
        });
      } else if (bb) {
        // entering the top-N: glide up from below the list
        // Width stays at full target (no grow-from-zero) to avoid the
        // "smaller-then-bigger" flicker; only position and opacity animate.
        const r1 = s1?.get(id) ?? bb.rank;
        out.push({
          id,
          value: bb.value,
          widthFrac: bb.width,
          rank: count + 1 + (r1 - (count + 1)) * te,
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
  }, [f0, f1, t, te, i0, i1, smoothRanks]);

  // Layout: header occupies the top 96px; bars live between y=112 and y=648.
  const raceTop = 112;
  const raceBottom = 648;
  // Row height is CONSTANT for the whole video, based on the tape's topN:
  // bars must never resize as entities enter or leave. Early periods show
  // fewer rows with vacant space below instead of ballooning the first rows
  // big and then shrinking them when newcomers arrive.
  const rowHeight = (raceBottom - raceTop) / Math.max(1, tape.topN || barCount);
  const barX0 = 96;
  // The spotlight card lives at x=960. The race width is CONSTANT on purpose:
  // it used to be `740 - 150 * panelAppear`, so every time the spotlight card
  // faded in or out (once per story segment - i.e. nearly every year) ALL bars
  // visibly shrank and grew back even though no value changed. That read as
  // the bars "refreshing"/resetting on every year tick. 600 keeps the
  // leader's flag + value labels clear of the card (x=960) at all times
  // (worst case: 96 + 600 + 12 + 46 + 12 + ~180px value < 960), so the card
  // can fade freely without moving a single bar.
  const maxBarWidth = 600;
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
  const cardAppear = cardContent
    ? interpolate(
        frame,
        [cardContent.start, cardContent.start + 12, cardContent.end - 12, cardContent.end],
        [0, 1, 1, 0],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
      )
    : 0;

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

  const panelAppear = cardAppear;
  const chromeAppear = interpolate(frame, [0, 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  // Progress across the whole race (all segments), not just this one.
  const progress = tapeCount > 1 ? tapePos / (tapeCount - 1) : 0;

  return (
    <AbsoluteFill style={{ background: '#ffffff' }}>
      <RaceHeader title={input.videoSpec.metadata.title} yearLabel={currentLabel} appear={chromeAppear} />
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
            appear={Math.max(0, Math.min(1, row.appear * introAppear))}
            flagBaseUrl={flagBaseUrl}
          />
        );
      })}
      {/* Right-side panel: fills empty space with topic visual + leader info.
          Hidden when the spotlight card is active (it takes the same space). */}
      {!cardContent && (() => {
        const leaderRow = rows.find((r) => Math.round(r.rank) === 1);
        const leaderEntity = leaderRow ? entityById.get(leaderRow.id) : undefined;
        if (!leaderRow || !leaderEntity) return null;
        // Topic label based on video title (CAR for car videos, etc.)
        const title = input.videoSpec.metadata.title.toLowerCase();
        let icon = 'DATA RACE';
        if (title.includes('car') || title.includes('vehicle') || title.includes('auto')) icon = 'CAR PRODUCTION';
        else if (title.includes('population')) icon = 'POPULATION';
        else if (title.includes('pollut')) icon = 'CO2 EMISSIONS';
        else if (title.includes('phone') || title.includes('browser')) icon = 'TECH RACE';
        // Format value without decimals
        const formattedValue = Math.round(leaderRow.value).toLocaleString();
        return (
          <SidePanel
            leaderName={leaderEntity.name}
            leaderValue={formattedValue}
            leaderColor={leaderEntity.color}
            yearLabel={currentLabel}
            topicIcon={icon}
            appear={chromeAppear}
          />
        );
      })()}
      {cardContent ? (
        <EraPanel
          title={cardContent.title}
          body={cardContent.body}
          featured={featured}
          flagBaseUrl={flagBaseUrl}
          appear={panelAppear}
        />
      ) : null}
      <RaceProgress
        progress={progress}
        caption={`Source: ${input.videoSpec.sources[0]?.publisher ?? 'multiple sources'}`}
        appear={chromeAppear}
      />
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

    </Canvas>
  );
};