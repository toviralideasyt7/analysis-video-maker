/**
 * The data-race composition.
 *
 * Layout (1280x720 baseline):
 *   top-left   brand mark
 *   top        big title
 *   top-right  large light date stamp
 *   left 62%   horizontal ranking bars (flag + monogram badge + value)
 *   right 38%  fact box during highlights, otherwise the summary panel
 *   bottom-mid group bar chart (regions/segments), when the data has groups
 *   bottom     notes about held/missing values
 */

import React, { useMemo } from 'react';
import { AbsoluteFill, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Dataset, Story } from '@avm/shared';
import { makeTheme, formatValue, compactNumber } from './theme';
import type { FrameTape } from './frameTape';
import type { RenderInput } from './types';
import {
  BrandMark,
  BigDate,
  Canvas,
  FactBox,
  GroupBarChart,
  HighlightArrow,
  NoteStrip,
  RankingRow,
  ShareGauge,
  SourceCard,
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

/** Pre-compute animated ranks so row movement is smooth rather than jittery. */
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
      existing.value = existing.value + (existing.target - existing.value) * (index === existing.since ? 1 : eased);
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

const BarRace: React.FC<{ input: RenderInput; highlights: Highlight[]; durationInFrames: number; title: string; subtitle?: string; summary: Record<string, unknown> }> = ({
  input,
  highlights,
  durationInFrames,
  title,
  summary,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const theme = makeTheme(input.videoSpec.theme as Record<string, string | number>);
  const tape = input.frameTape;
  const dataset = input.dataset;
  const smoothed = useMemo(() => buildSmoothRanks(tape), [tape]);
  const tapeFrameIndex = Math.min(tape.frames.length - 1, Math.max(0, Math.floor((frame / durationInFrames) * tape.frames.length)));
  const groups = useMemo(() => groupTotals(tape, tapeFrameIndex), [tape, tapeFrameIndex]);
  const tapeFrame = tape.frames[tapeFrameIndex];
  const rankMap = smoothed.ranks[tapeFrameIndex] ?? new Map<string, number>();

  const rowHeight = 50;
  const listTop = 176;
  const barAreaWidth = 620;
  const activeHighlight = highlights.find((h) => frame >= h.atFrame && frame < h.atFrame + fps * 6);

  const headerAppear = spring({ frame, fps, durationInFrames: 18, config: { damping: 200 } });
  const summaryAppear = spring({ frame, fps, durationInFrames: 20, config: { damping: 200 } });

  const topBar = tapeFrame?.bars[0];
  const topEntity = topBar ? tape.entities.find((e) => e.id === topBar.entityId) : undefined;
  const visibleTotal = (tapeFrame?.bars ?? []).reduce((sum, b) => sum + b.value, 0);
  const sharePercent = visibleTotal > 0 && topBar ? ((topBar.value / visibleTotal) * 100).toFixed(0) : '0';
  const finalLabel = tapeFrame?.label ?? '';
  const publishers = `source: ${Array.from(new Set(dataset.observations.map((o) => o.source.publisher))).slice(0, 3).join(', ')}`;
  const crossChecked =
    dataset.stats.verified > 0
      ? `${dataset.stats.verified} cross-checked values`
      : 'single source: values are reported, not cross-verified';

  return (
    <AbsoluteFill>
      <div style={{ position: 'absolute', left: 46, top: 40 }}>
        <BrandMark theme={theme} />
      </div>

      <div style={{ position: 'absolute', left: 130, right: 300, top: 44, opacity: headerAppear }}>
        <div style={{ fontSize: 40, fontWeight: 800, color: theme.primaryText, letterSpacing: '-0.03em', lineHeight: 1.05 }}>{title}</div>
        <div style={{ fontSize: 19, fontWeight: 600, color: theme.secondaryText, marginTop: 4 }}>
          {dataset.metric} · {dataset.stats.observations.toLocaleString('en-US')} observations · {dataset.stats.entities} entities ·{' '}
          {publishers} · {crossChecked}
        </div>
      </div>

      <div style={{ position: 'absolute', right: 46, top: 44, textAlign: 'right' }}>
        <BigDate label={tapeFrame?.label ?? ''} theme={theme} fontSize={64} />
      </div>

      {/* ranking list */}
      <div style={{ position: 'absolute', left: 46, top: listTop, width: 46 + barAreaWidth + 120, height: 720 - listTop - 60 }}>
        {(tapeFrame?.bars ?? []).map((bar) => {
          const entity = tape.entities.find((e) => e.id === bar.entityId);
          if (!entity) return null;
          const animatedRank = rankMap.get(bar.entityId) ?? bar.rank;
          const y = (animatedRank - 1) * rowHeight;
          const appear = spring({ frame: frame - 4, fps, durationInFrames: 16, config: { damping: 200 } });
          return (
            <RankingRow
              key={bar.entityId}
              entity={entity}
              bar={bar}
              theme={theme}
              maxWidth={barAreaWidth}
              widthFraction={bar.width}
              rowHeight={rowHeight}
              unit={dataset.unit}
              y={y}
              appear={appear}
            />
          );
        })}
      </div>

      {/* mover arrow on the bar that climbed the most */}
      {(tapeFrame?.bars ?? []).some((b) => b.isMover) ? (
        <div style={{ position: 'absolute', left: 46 + barAreaWidth + 130, top: listTop }}>
          {(tapeFrame?.bars ?? [])
            .filter((b) => b.isMover && (b.rankDelta ?? 0) > 0)
            .slice(0, 1)
            .map((b) => {
              const entity = tape.entities.find((e) => e.id === b.entityId);
              const animatedRank = rankMap.get(b.entityId) ?? b.rank;
              return (
                <div key={b.entityId} style={{ position: 'absolute', top: (animatedRank - 1) * rowHeight + rowHeight * 0.2, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <HighlightArrow theme={theme} color={theme.accent} appear={1} />
                  <div style={{ fontSize: 15, fontWeight: 800, color: theme.accent, whiteSpace: 'nowrap' }}>
                    +{Math.abs(b.rankDelta ?? 0)} {entity?.name ?? b.entityId}
                  </div>
                </div>
              );
            })}
        </div>
      ) : null}

      {/* right column: fact box while a highlight is active, summary otherwise */}
      <div style={{ position: 'absolute', right: 46, top: listTop, width: 380 }}>
        {activeHighlight ? (
          <FactBox
            heading={activeHighlight.factBox?.heading ?? activeHighlight.headline}
            body={activeHighlight.factBox?.body ?? activeHighlight.detail}
            dateLabel={activeHighlight.factBox?.dateLabel ?? activeHighlight.atLabel}
            wordmark={activeHighlight.factBox?.wordmark ?? tape.entities.find((e) => e.id === activeHighlight.entityId)?.name}
            accentColor={tape.entities.find((e) => e.id === activeHighlight.entityId)?.color}
            theme={theme}
            appear={interpolate(frame, [activeHighlight.atFrame, activeHighlight.atFrame + 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })}
            width={380}
          />
        ) : (
          <div style={{ opacity: summaryAppear, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 14 }}>
            <div style={{ fontSize: 30, fontWeight: 800, color: theme.secondaryText }}>{String(summary.heading ?? dataset.metric)}</div>
            <div style={{ fontSize: 42, fontWeight: 800, color: theme.primaryText }}>{topBar ? formatValue(topBar.value, dataset.unit) : '-'}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: theme.primaryText, marginTop: -6 }}>
              {topEntity?.name ?? ''} leads in {tapeFrame?.label ?? ''}
            </div>
            <ShareGauge
              fraction={visibleTotal > 0 ? (topBar?.value ?? 0) / visibleTotal : 0}
              label={`${sharePercent}% of the top ${(tapeFrame?.bars ?? []).length} total (${formatValue(visibleTotal, dataset.unit)})`}
              color={topEntity?.color ?? theme.accent}
              theme={theme}
              width={380}
              appear={summaryAppear}
            />
            {groups.length > 1 ? (
              <div style={{ marginTop: 6, alignSelf: 'flex-end' }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: theme.secondaryText, marginBottom: 4, textAlign: 'right' }}>
                  by region, {finalLabel}
                </div>
                <GroupBarChart groups={groups} theme={theme} width={360} height={168} appear={summaryAppear} />
              </div>
            ) : null}
          </div>
        )}
      </div>

      <NoteStrip notes={tape.notes} theme={theme} />
    </AbsoluteFill>
  );
};

export const DataRace: React.FC<{ input: RenderInput }> = ({ input }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const theme = makeTheme(input.videoSpec.theme as Record<string, string | number>);
  const spec = input.videoSpec;
  const story = (input.dataset ? undefined : undefined) as Story | undefined;
  void story;

  const offsets: Array<{ id: string; type: string; from: number; to: number; durationInFrames: number; scene: (typeof spec.scenes)[number] }> = [];
  let cursor = 0;
  for (const scene of spec.scenes) {
    const durationInFrames = Math.round(scene.duration * fps);
    offsets.push({ id: scene.id, type: scene.type, from: cursor, to: cursor + durationInFrames, durationInFrames, scene });
    cursor += durationInFrames;
  }

  const raceOffset = offsets.find((o) => o.type === 'bar_race');
  const highlights = ((raceOffset?.scene.props?.highlights as unknown[]) ?? []).map((raw) => {
    const h = raw as Record<string, unknown>;
    return {
      atFrame: Number(h.atFrame ?? 0),
      atLabel: String(h.atLabel ?? ''),
      entityId: String(h.entityId ?? ''),
      headline: String(h.headline ?? ''),
      detail: String(h.detail ?? ''),
      factBox: h.factBox as Highlight['factBox'],
    } satisfies Highlight;
  });
  const summary = ((raceOffset?.scene.props?.summary as Record<string, unknown>) ?? {}) as Record<string, unknown>;
  const raceFrom = raceOffset?.from ?? 0;
  const raceDuration = raceOffset?.durationInFrames ?? input.frameTape.durationInFrames;

  const sourceScene = offsets.find((o) => o.type === 'source_card');
  const endingScene = offsets.find((o) => o.type === 'ending');
  const introScene = offsets.find((o) => o.type === 'intro');
  const titleScene = offsets.find((o) => o.type === 'title');

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
              title={introScene.scene.title ?? ''}
              subtitle={introScene.scene.subtitle}
              theme={theme}
              align="left"
              appear={interpolate(frame - introScene.from, [0, 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })}
              titleSize={46}
              subtitleSize={26}
            />
            <div style={{ marginTop: 34, fontSize: 20, color: theme.secondaryText }}>
              {input.dataset.stats.entities} entities · {input.dataset.stats.observations} observations · {input.dataset.stats.verified} verified ·{' '}
              {input.dataset.stats.unknown} unknown · {input.dataset.stats.conflicting} conflicting
            </div>
          </AbsoluteFill>
        </Sequence>
      ) : null}

      {raceOffset ? (
        <Sequence from={raceOffset.from} durationInFrames={raceOffset.durationInFrames}>
          <BarRace
            input={input}
            highlights={highlights}
            durationInFrames={raceDuration}
            title={spec.metadata.title}
            subtitle={spec.metadata.subtitle}
            summary={summary}
          />
        </Sequence>
      ) : null}

      {endingScene ? (
        <Sequence from={endingScene.from} durationInFrames={endingScene.durationInFrames}>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', padding: '0 110px' }}>
            <TitleBlock
              title={endingScene.scene.title ?? spec.metadata.title}
              theme={theme}
              appear={interpolate(frame - endingScene.from, [0, 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })}
              titleSize={44}
            />
            <div style={{ marginTop: 26, fontSize: 22, color: theme.secondaryText }}>
              {input.dataset.timeRange.start} – {input.dataset.timeRange.end} · {compactNumber(input.dataset.stats.observations)} data points
            </div>
          </AbsoluteFill>
        </Sequence>
      ) : null}

      {sourceScene ? (
        <Sequence from={sourceScene.from} durationInFrames={sourceScene.durationInFrames}>
          <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
            <SourceCard
              sourcesLine={String(sourceScene.scene.props?.sourcesLine ?? '')}
              sources={input.videoSpec.sources.map((s) => ({ url: s.url, publisher: s.publisher }))}
              theme={theme}
              appear={interpolate(frame - sourceScene.from, [0, 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })}
            />
          </AbsoluteFill>
        </Sequence>
      ) : null}
    </Canvas>
  );
};