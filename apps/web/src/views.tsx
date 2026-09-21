/**
 * Dashboard views.
 *
 * The browser preview uses the SAME data contract as the Remotion renderer
 * (frames.json), which is what keeps the preview and the final MP4 aligned.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { DataQualityReport, Dataset, SourceCandidate, Story, VideoSpec } from '@avm/shared';
import type { FrameTape, ProjectState } from './api';

export const statusColor = (status: string): string => {
  if (status === 'READY_FOR_REVIEW' || status === 'APPROVED' || status === 'RENDERED') return 'text-emerald-600';
  if (status === 'FAILED') return 'text-accent';
  if (status === 'DRAFT') return 'text-muted';
  return 'text-amber-600';
};

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="panel px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="text-2xl font-extrabold text-ink">{value}</div>
      {hint ? <div className="text-xs text-muted mt-1">{hint}</div> : null}
    </div>
  );
}

export function Overview({ project }: { project: ProjectState }) {
  const stats = project.dataset?.stats;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Sources" value={project.sources.length} hint={`${project.sources.filter((s) => s.accepts !== false).length} usable`} />
        <Stat label="Observations" value={stats?.observations ?? 0} hint={`${stats?.entities ?? 0} entities`} />
        <Stat label="Verified" value={stats?.verified ?? 0} hint={`${stats?.unknown ?? 0} unknown · ${stats?.conflicting ?? 0} conflicting`} />
        <Stat label="Quality" value={project.quality ? (project.quality.passed ? 'PASS' : `${project.quality.violations} issues`) : '—'} hint={project.quality?.engine ?? ''} />
      </div>

      <div className="panel p-4">
        <div className="text-sm font-bold text-ink mb-2">Pipeline checkpoints</div>
        <div className="flex flex-wrap gap-2">
          {project.checkpoints.length === 0 ? <span className="text-sm text-muted">No run yet.</span> : null}
          {project.checkpoints.map((c) => (
            <span key={c.checkpoint + c.at} className="text-xs font-semibold px-2 py-1 rounded bg-surface text-ink">
              {c.checkpoint}
            </span>
          ))}
        </div>
        {project.notes.length > 0 ? (
          <ul className="mt-3 text-xs text-muted space-y-1 list-disc pl-4">
            {project.notes.slice(-8).map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

export function DataPlanView({ plan }: { plan: Record<string, unknown> | undefined }) {
  if (!plan) return <p className="text-sm text-muted">No plan yet.</p>;
  const interpretations = (plan.interpretations as Array<Record<string, unknown>> | undefined) ?? [];
  return (
    <div className="space-y-4">
      {plan.metricAmbiguous ? (
        <div className="panel p-4 border-l-4 border-l-amber-500">
          <div className="font-bold text-ink">This topic is ambiguous — confirm the measurement before publishing</div>
          <div className="text-sm text-muted mt-1">
            The planner produced explicit interpretations instead of silently choosing one.
          </div>
        </div>
      ) : null}
      <div className="panel p-4 space-y-2">
        <Row label="Topic" value={String(plan.topic ?? '')} />
        <Row label="Metric" value={String(plan.metric ?? '')} />
        <Row label="Entity type" value={String(plan.entityType ?? '')} />
        <Row label="Range" value={`${(plan.timeRange as { start?: string })?.start ?? ''} – ${(plan.timeRange as { end?: string })?.end ?? ''}`} />
        <Row label="Frequency" value={String(plan.frequency ?? '')} />
        <Row label="Missing-data policy" value={String(plan.missingDataPolicy ?? '')} />
      </div>
      {interpretations.length > 0 ? (
        <div className="panel p-4">
          <div className="font-bold text-ink mb-2">Metric interpretations</div>
          <div className="space-y-2">
            {interpretations.map((i) => (
              <div key={String(i.id)} className="border border-black/5 rounded-lg p-3">
                <div className="font-semibold text-ink">{String(i.label ?? '')}</div>
                <div className="text-sm text-muted">{String(i.measurableDefinition ?? '')}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {Array.isArray(plan.knownRisks) && (plan.knownRisks as string[]).length > 0 ? (
        <div className="panel p-4">
          <div className="font-bold text-ink mb-2">Known risks</div>
          <ul className="text-sm text-muted list-disc pl-4 space-y-1">
            {(plan.knownRisks as string[]).map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 text-sm">
      <span className="w-40 shrink-0 text-muted">{label}</span>
      <span className="font-medium text-ink break-all">{value}</span>
    </div>
  );
}

export function SourcesView({ sources }: { sources: SourceCandidate[] }) {
  if (sources.length === 0) return <p className="text-sm text-muted">No sources discovered yet.</p>;
  return (
    <div className="panel overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-surface text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            <th className="px-3 py-2">Source</th>
            <th className="px-3 py-2">Type</th>
            <th className="px-3 py-2">Machine readable</th>
            <th className="px-3 py-2">Quality</th>
            <th className="px-3 py-2">Decision</th>
          </tr>
        </thead>
        <tbody>
          {sources.slice(0, 60).map((s) => (
            <tr key={s.candidateId} className="border-t border-black/5">
              <td className="px-3 py-2">
                <div className="font-semibold text-ink">{s.sourceName}</div>
                <a href={s.url} target="_blank" rel="noreferrer" className="text-xs text-blue-600 break-all">
                  {s.url}
                </a>
              </td>
              <td className="px-3 py-2 text-muted">{s.kind}</td>
              <td className="px-3 py-2">{s.machineReadable ? 'yes' : 'no'}</td>
              <td className="px-3 py-2 font-semibold">{s.qualityScore.toFixed(2)}</td>
              <td className="px-3 py-2">{s.accepts === null ? '—' : s.accepts ? 'accepted' : 'rejected'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DatasetView({ dataset, onTopN }: { dataset?: Dataset; onTopN?: (topN: number) => void }) {
  const [filter, setFilter] = useState('');
  if (!dataset) return <p className="text-sm text-muted">No dataset yet.</p>;
  const rows = dataset.observations
    .filter((o) => filter === '' || o.entity.name.toLowerCase().includes(filter.toLowerCase()))
    .filter((o) => o.value !== null)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 300);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter by entity"
          className="panel px-3 py-2 text-sm w-64 outline-none"
        />
        {onTopN ? (
          <button className="panel px-3 py-2 text-sm font-semibold hover:bg-surface" onClick={() => onTopN(10)}>
            keep top 10 per period
          </button>
        ) : null}
      </div>
      <div className="panel overflow-hidden max-h-[560px] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="bg-surface text-left text-xs uppercase tracking-wide text-muted sticky top-0">
            <tr>
              <th className="px-3 py-2">Entity</th>
              <th className="px-3 py-2">Date</th>
              <th className="px-3 py-2">Value</th>
              <th className="px-3 py-2">Unit</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Source</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.observationId} className="border-t border-black/5">
                <td className="px-3 py-1.5 font-medium text-ink">{o.entity.name}</td>
                <td className="px-3 py-1.5 text-muted">{o.date}</td>
                <td className="px-3 py-1.5 tabular-nums">{o.value?.toLocaleString('en-US')}</td>
                <td className="px-3 py-1.5 text-muted">{o.unit}</td>
                <td className="px-3 py-1.5">
                  <span className={o.status === 'VERIFIED' ? 'text-emerald-600 font-semibold' : o.status === 'CONFLICTING' ? 'text-accent font-semibold' : o.status === 'UNKNOWN' ? 'text-muted' : ''}>
                    {o.status}
                  </span>
                </td>
                <td className="px-3 py-1.5">
                  <a href={o.source.url} target="_blank" rel="noreferrer" className="text-xs text-blue-600">
                    {o.source.publisher}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">
        {dataset.stats.observations} observations · {dataset.stats.verified} verified · {dataset.stats.unknown} unknown (shown as missing, never guessed) · version {dataset.version}
        {dataset.frozen ? ' · frozen' : ''}
      </p>
    </div>
  );
}

export function RacePreview({ tape, unit }: { tape?: FrameTape; unit: string }) {
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const raf = useRef<number | null>(null);
  const total = tape?.frames.length ?? 0;

  useEffect(() => {
    if (!playing || total === 0) return;
    let last = performance.now();
    const tick = (now: number) => {
      if (now - last > 1000 / 30) {
        last = now;
        setFrame((f) => (f + 1) % total);
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [playing, total]);

  const current = tape?.frames[Math.min(frame, Math.max(0, total - 1))];
  const entityMap = useMemo(() => new Map((tape?.entities ?? []).map((e) => [e.id, e])), [tape]);

  if (!tape || total === 0) return <p className="text-sm text-muted">No frame tape yet — run research first.</p>;

  return (
    <div className="space-y-3">
      <div className="panel p-4 bg-white">
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-bold text-ink">Browser preview · {current?.label}</div>
          <div className="flex items-center gap-2">
            <button className="panel px-3 py-1.5 text-sm font-semibold" onClick={() => setPlaying((p) => !p)}>
              {playing ? 'Pause' : 'Play'}
            </button>
            <input
              type="range"
              min={0}
              max={Math.max(0, total - 1)}
              value={frame}
              onChange={(e) => {
                setPlaying(false);
                setFrame(Number(e.target.value));
              }}
              className="w-64"
            />
            <span className="text-xs text-muted tabular-nums">
              {frame}/{total - 1}
            </span>
          </div>
        </div>
        <div className="space-y-1.5">
          {(current?.bars ?? []).map((bar) => {
            const entity = entityMap.get(bar.entityId);
            return (
              <div key={bar.entityId} className="flex items-center gap-3">
                <div className="w-40 text-right text-sm font-bold text-ink truncate">{entity?.name ?? bar.entityId}</div>
                <div className="w-10 text-center text-xs font-bold text-muted">{entity?.flagCode?.toUpperCase() ?? entity?.group?.slice(0, 3).toUpperCase() ?? ''}</div>
                <div className="flex-1 h-6 bg-surface rounded relative overflow-hidden">
                  <div
                    className="h-full rounded"
                    style={{ width: `${Math.max(1, bar.width * 100)}%`, background: entity?.color ?? '#111827', opacity: bar.held ? 0.55 : 1 }}
                  />
                </div>
                <div className="w-24 text-sm font-extrabold tabular-nums text-right">{bar.value >= 1000 ? `${(bar.value / 1000).toFixed(1)}K` : bar.value.toFixed(2)}</div>
                <div className="w-12 text-xs font-bold text-accent">{bar.isMover ? `▲${Math.abs(bar.rankDelta ?? 0)}` : ''}</div>
              </div>
            );
          })}
        </div>
        <div className="mt-3 text-xs text-muted">unit: {unit} · {tape.periodLabels.length} periods · {total} frames</div>
        {tape.notes.length > 0 ? (
          <ul className="mt-2 text-xs text-muted list-disc pl-4 space-y-0.5">
            {tape.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

export function StoryView({ story }: { story?: Story }) {
  if (!story) return <p className="text-sm text-muted">No story yet.</p>;
  return (
    <div className="space-y-3">
      <div className="panel p-4">
        <div className="text-xl font-extrabold text-ink">{story.title}</div>
        <div className="text-sm text-muted">{story.subtitle}</div>
        <p className="mt-3 text-sm text-ink">{story.hook}</p>
        <p className="text-sm text-muted">{story.setup}</p>
      </div>
      {story.highlights.length > 0 ? (
        <div className="grid md:grid-cols-2 gap-3">
          {story.highlights.map((h, i) => (
            <div key={i} className="panel p-4">
              <div className="text-xs uppercase tracking-wide text-muted">{h.atLabel}</div>
              <div className="font-bold text-ink">{h.headline}</div>
              <p className="text-sm text-muted mt-1">{h.detail}</p>
              {h.factBox ? (
                <div className="mt-3 border-l-4 border-l-accent pl-3">
                  <div className="font-bold text-ink">{h.factBox.heading}</div>
                  <p className="text-sm text-muted">{h.factBox.body}</p>
                  {h.factBox.dateLabel ? <div className="text-2xl font-extrabold text-muted">{h.factBox.dateLabel}</div> : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <div className="panel p-4 text-sm text-muted">
        <div className="font-bold text-ink">Ending</div>
        {story.ending}
      </div>
    </div>
  );
}

export function VideoSpecView({ spec }: { spec?: VideoSpec }) {
  if (!spec) return <p className="text-sm text-muted">No video spec yet.</p>;
  return (
    <div className="space-y-3">
      <div className="panel p-4 space-y-1 text-sm">
        <Row label="Title" value={spec.metadata.title} />
        <Row label="Duration" value={`${spec.metadata.durationSeconds}s`} />
        <Row label="Canvas" value={`${spec.canvas.width}×${spec.canvas.height} @ ${spec.canvas.fps}fps`} />
        <Row label="Dataset ref" value={spec.datasetRef} />
        <Row label="Sources" value={String(spec.sources.length)} />
      </div>
      <div className="panel overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2">Scene</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Duration</th>
            </tr>
          </thead>
          <tbody>
            {spec.scenes.map((s) => (
              <tr key={s.id} className="border-t border-black/5">
                <td className="px-3 py-2 font-medium">{s.id}</td>
                <td className="px-3 py-2 text-muted">{s.type}</td>
                <td className="px-3 py-2 tabular-nums">{s.duration.toFixed(2)}s</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="panel p-4">
        <summary className="cursor-pointer text-sm font-bold text-ink">Raw VideoSpec JSON</summary>
        <pre className="mt-2 text-xs overflow-x-auto whitespace-pre-wrap break-all text-muted">{JSON.stringify(spec, null, 2)}</pre>
      </details>
    </div>
  );
}

export function QualityView({ quality }: { quality?: DataQualityReport }) {
  if (!quality) return <p className="text-sm text-muted">No quality report yet.</p>;
  return (
    <div className="space-y-3">
      <div className={`panel p-4 border-l-4 ${quality.passed ? 'border-l-emerald-500' : 'border-l-accent'}`}>
        <div className="font-bold text-ink">
          {quality.passed ? 'All checks passed' : `${quality.violations} violations`}
        </div>
        <div className="text-xs text-muted">engine: {quality.engine ?? 'unknown'} · {quality.observations} observations · {quality.entities} entities</div>
      </div>
      <div className="panel overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2">Check</th>
              <th className="px-3 py-2">Result</th>
              <th className="px-3 py-2">Details</th>
            </tr>
          </thead>
          <tbody>
            {quality.checks.map((c) => (
              <tr key={c.name} className="border-t border-black/5 align-top">
                <td className="px-3 py-2 font-medium">{c.name}</td>
                <td className={`px-3 py-2 font-bold ${c.passed ? 'text-emerald-600' : 'text-accent'}`}>{c.passed ? 'pass' : `${c.violations}`}</td>
                <td className="px-3 py-2 text-xs text-muted">
                  {c.details.slice(0, 3).map((d, i) => (
                    <div key={i}>{d}</div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}