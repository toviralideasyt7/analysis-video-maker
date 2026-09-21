import React, { useCallback, useEffect, useState } from 'react';
import { api, type ProjectState, type ProjectSummary } from './api';
import {
  DataPlanView,
  DatasetView,
  Overview,
  QualityView,
  RacePreview,
  SourcesView,
  StoryView,
  VideoSpecView,
  statusColor,
} from './views';

const TABS = ['Overview', 'Data Plan', 'Sources', 'Dataset', 'Preview', 'Story', 'Video Spec', 'Quality', 'Render'] as const;
type Tab = (typeof TABS)[number];

export default function App(): React.ReactElement {
  const [health, setHealth] = useState<{ ok: boolean; rustCore: boolean } | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<ProjectState | null>(null);
  const [topic, setTopic] = useState('World Population by Country 1960-2024');
  const [indicator, setIndicator] = useState('SP.POP.TOTL');
  const [tab, setTab] = useState<Tab>('Overview');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('Keep only the top 10 and drop unverified values.');
  const [dispatchNote, setDispatchNote] = useState<string | null>(null);

  const refreshProjects = useCallback(async () => {
    try {
      const result = await api.listProjects();
      setProjects(result.projects);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, []);

  const loadProject = useCallback(async (id: string) => {
    try {
      const result = await api.getProject(id);
      setProject(result.project);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const h = await api.health();
        setHealth(h);
      } catch {
        setHealth({ ok: false, rustCore: false });
      }
      await refreshProjects();
    })();
  }, [refreshProjects]);

  // Poll while research is in flight so the UI reflects real progress.
  useEffect(() => {
    if (!project) return;
    if (!['PLANNING', 'RESEARCHING', 'EXTRACTING', 'VERIFYING', 'RENDERING'].includes(project.status)) return;
    const timer = setInterval(() => void loadProject(project.projectId), 2500);
    return () => clearInterval(timer);
  }, [project, loadProject]);

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-black/5 bg-white">
        <div className="max-w-[1400px] mx-auto px-6 py-4 flex items-center gap-4">
          <div className="w-9 h-9 rounded-full bg-accent flex items-end justify-center gap-[3px] pb-[8px]">
            <span className="w-[3px] h-3 bg-white rounded" />
            <span className="w-[3px] h-5 bg-white rounded" />
            <span className="w-[3px] h-4 bg-white rounded" />
          </div>
          <div>
            <div className="font-extrabold text-ink leading-tight">analysis-video-maker</div>
            <div className="text-xs text-muted">source-backed data-race research console</div>
          </div>
          <div className="ml-auto flex items-center gap-3 text-xs">
            <span className={`px-2 py-1 rounded font-semibold ${health?.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-accent'}`}>
              backend {health?.ok ? 'online' : 'offline'}
            </span>
            <span className={`px-2 py-1 rounded font-semibold ${health?.rustCore ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
              rust core {health?.rustCore ? 'ready' : 'missing'}
            </span>
          </div>
        </div>
      </header>

      <div className="max-w-[1400px] mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-6">
        <aside className="space-y-4">
          <div className="panel p-4 space-y-3">
            <div className="text-sm font-bold text-ink">New project</div>
            <textarea
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              rows={3}
              className="w-full text-sm border border-black/10 rounded-lg px-3 py-2 outline-none focus:border-accent"
            />
            <input
              value={indicator}
              onChange={(e) => setIndicator(e.target.value)}
              placeholder="World Bank indicator (optional)"
              className="w-full text-sm border border-black/10 rounded-lg px-3 py-2 outline-none focus:border-accent"
            />
            <button
              disabled={busy !== null}
              onClick={() =>
                void run('create+research', async () => {
                  const created = await api.createProject(topic);
                  await api.research(created.project.projectId, { worldBankIndicator: indicator || undefined });
                  setProject(created.project);
                  await refreshProjects();
                })
              }
              className="w-full bg-ink text-white text-sm font-bold rounded-lg py-2 disabled:opacity-50"
            >
              {busy === 'create+research' ? 'Starting research…' : 'Research'}
            </button>
            <div className="text-xs text-muted">
              The backend plans a measurable metric, discovers sources, extracts observations with provenance, verifies
              them and builds the VideoSpec. Rendering happens on GitHub Actions after you approve.
            </div>
          </div>

          <div className="panel p-4">
            <div className="text-sm font-bold text-ink mb-2">Projects</div>
            <div className="space-y-1 max-h-72 overflow-y-auto">
              {projects.length === 0 ? <div className="text-xs text-muted">None yet.</div> : null}
              {projects.map((p) => (
                <button
                  key={p.projectId}
                  onClick={() => void loadProject(p.projectId)}
                  className={`w-full text-left px-3 py-2 rounded-lg hover:bg-surface ${project?.projectId === p.projectId ? 'bg-surface' : ''}`}
                >
                  <div className="text-sm font-semibold text-ink truncate">{p.title}</div>
                  <div className={`text-xs font-semibold ${statusColor(p.status)}`}>{p.status}</div>
                </button>
              ))}
            </div>
          </div>
        </aside>

        <main className="space-y-4 min-w-0">
          {error ? <div className="panel p-3 border-l-4 border-l-accent text-sm text-accent">{error}</div> : null}

          {!project ? (
            <div className="panel p-10 text-center">
              <div className="text-lg font-bold text-ink">No project selected</div>
              <p className="text-sm text-muted mt-2">Enter a topic and press Research, or pick an existing project.</p>
            </div>
          ) : (
            <>
              <div className="panel p-4 flex flex-wrap items-center gap-3">
                <div className="min-w-0">
                  <div className="text-lg font-extrabold text-ink truncate">{project.title}</div>
                  <div className="text-xs text-muted">
                    {project.projectId} · <span className={`font-semibold ${statusColor(project.status)}`}>{project.status}</span>
                  </div>
                </div>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <button
                    disabled={busy !== null}
                    onClick={() =>
                      void run('research', async () => {
                        await api.research(project.projectId, { worldBankIndicator: indicator || undefined });
                        await loadProject(project.projectId);
                      })
                    }
                    className="panel px-3 py-2 text-sm font-semibold hover:bg-surface disabled:opacity-50"
                  >
                    Re-run research
                  </button>
                  <button
                    disabled={busy !== null || project.status !== 'READY_FOR_REVIEW'}
                    onClick={() =>
                      void run('approve', async () => {
                        await api.approve(project.projectId);
                        await loadProject(project.projectId);
                      })
                    }
                    className="panel px-3 py-2 text-sm font-semibold hover:bg-surface disabled:opacity-50"
                  >
                    Approve
                  </button>
                  <button
                    disabled={busy !== null || project.status !== 'APPROVED'}
                    onClick={() =>
                      void run('render', async () => {
                        const result = await api.render(project.projectId);
                        setDispatchNote(result.dispatch.message + (result.dispatch.workflowRunUrl ? ` · ${result.dispatch.workflowRunUrl}` : ''));
                        await loadProject(project.projectId);
                      })
                    }
                    className="bg-accent text-white px-3 py-2 text-sm font-bold rounded-lg disabled:opacity-50"
                  >
                    Render on GitHub
                  </button>
                </div>
              </div>

              {dispatchNote ? <div className="panel p-3 text-xs text-muted">dispatch: {dispatchNote}</div> : null}

              <div className="flex flex-wrap gap-1">
                {TABS.map((t) => (
                  <button key={t} className={`tab ${tab === t ? 'tab-active' : ''}`} onClick={() => setTab(t)}>
                    {t}
                  </button>
                ))}
              </div>

              {tab === 'Overview' ? <Overview project={project} /> : null}
              {tab === 'Data Plan' ? <DataPlanView plan={project.dataPlan} /> : null}
              {tab === 'Sources' ? <SourcesView sources={project.sources} /> : null}
              {tab === 'Dataset' ? (
                <DatasetView
                  dataset={project.dataset}
                  onTopN={(topN) =>
                    void run('dataset-edit', async () => {
                      await api.patchDataset(project.projectId, { topN });
                      await loadProject(project.projectId);
                    })
                  }
                />
              ) : null}
              {tab === 'Preview' ? <RacePreview tape={project.frameTape} unit={project.dataset?.unit ?? 'count'} /> : null}
              {tab === 'Story' ? (
                <div className="space-y-3">
                  <StoryView story={project.story} />
                  <div className="panel p-4 space-y-2">
                    <div className="text-sm font-bold text-ink">Revise in natural language</div>
                    <textarea
                      value={instruction}
                      onChange={(e) => setInstruction(e.target.value)}
                      rows={2}
                      className="w-full text-sm border border-black/10 rounded-lg px-3 py-2 outline-none focus:border-accent"
                    />
                    <button
                      disabled={busy !== null}
                      onClick={() =>
                        void run('revise', async () => {
                          await api.revise(project.projectId, instruction);
                          await loadProject(project.projectId);
                        })
                      }
                      className="bg-ink text-white text-sm font-bold rounded-lg px-3 py-2 disabled:opacity-50"
                    >
                      {busy === 'revise' ? 'Revising…' : 'Apply revision'}
                    </button>
                    {project.revisions.length > 0 ? (
                      <ul className="text-xs text-muted space-y-0.5 list-disc pl-4">
                        {project.revisions.map((r) => (
                          <li key={r.revisionId}>
                            {r.revisionId}: {r.instruction}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {tab === 'Video Spec' ? <VideoSpecView spec={project.videoSpec} /> : null}
              {tab === 'Quality' ? <QualityView quality={project.quality} /> : null}
              {tab === 'Render' ? (
                <div className="panel p-4 space-y-2 text-sm">
                  <div className="font-bold text-ink">Render job</div>
                  {project.renderJob ? (
                    <>
                      <div>status: {project.renderJob.status}</div>
                      <div>github run: {project.renderJob.githubRunId ?? 'not dispatched'}</div>
                      {(project.renderJob.notes ?? []).map((n, i) => (
                        <div key={i} className="text-xs text-muted">
                          {n}
                        </div>
                      ))}
                    </>
                  ) : (
                    <div className="text-muted">Nothing dispatched yet. Approve the project, then press “Render on GitHub”.</div>
                  )}
                </div>
              ) : null}
            </>
          )}
        </main>
      </div>
    </div>
  );
}