/**
 * Project state: a file-backed store with resumable checkpoints.
 *
 * Layout (matches the specification):
 *   projects/{projectId}/
 *     project.json      - the state machine + metadata
 *     plan.json         - DataPlan
 *     sources.json      - SourceCandidate[]
 *     dataset.json      - the frozen dataset (versioned)
 *     frames.json       - the Rust frame tape
 *     story.json        - Story
 *     video-spec.json   - VideoSpec
 *     thumbnail.json    - ThumbnailSpec
 *     quality.json      - DataQualityReport
 *     revisions.json    - revision history (rollback target)
 *     render-job.json   - RenderJob
 *     logs/             - agent runs, usage
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Checkpoint,
  CheckpointRecord,
  DataPlan,
  DataQualityReport,
  Dataset,
  RenderJob,
  SourceCandidate,
  Story,
  ThumbnailSpec,
  VideoSpec,
  ProjectStatus,
} from '@avm/shared';
import { cacheDir, logger, projectsDir, type Limits } from './runtime';
import type { FrameTape } from './pipeline';

export interface RevisionRecord {
  revisionId: string;
  at: string;
  instruction: string;
  plan: unknown;
  datasetVersionBefore: number;
  datasetVersionAfter: number;
}

export interface ProjectState {
  projectId: string;
  title: string;
  topic: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  dataPlan?: DataPlan;
  sources: SourceCandidate[];
  dataset?: Dataset;
  frameTape?: FrameTape;
  story?: Story;
  videoSpec?: VideoSpec;
  thumbnail?: ThumbnailSpec;
  quality?: DataQualityReport;
  checkpoints: CheckpointRecord[];
  revisions: RevisionRecord[];
  renderJob?: RenderJob;
  limits: Limits;
  notes: string[];
}

export class ProjectStore {
  constructor(private readonly root: string = projectsDir()) {
    mkdirSync(this.root, { recursive: true });
  }

  dir(projectId: string): string {
    return join(this.root, projectId);
  }

  private artifact(projectId: string, name: string): string {
    return join(this.dir(projectId), name);
  }

  static newProjectId(topic: string): string {
    const slug = topic
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const rand = Math.random().toString(36).slice(2, 8);
    return `${slug || 'project'}-${stamp}-${rand}`;
  }

  create(topic: string, limits: Limits, title?: string): ProjectState {
    const projectId = ProjectStore.newProjectId(topic);
    mkdirSync(this.dir(projectId), { recursive: true });
    mkdirSync(this.artifact(projectId, 'logs'), { recursive: true });
    const now = new Date().toISOString();
    const state: ProjectState = {
      projectId,
      title: title ?? topic,
      topic,
      status: 'DRAFT',
      createdAt: now,
      updatedAt: now,
      sources: [],
      checkpoints: [],
      revisions: [],
      limits,
      notes: [],
    };
    this.save(state);
    return state;
  }

  /**
   * Persist a project.
   *
   * `project.json` holds only the light state (status, checkpoints, revisions,
   * sources). The heavy artifacts - dataset, frame tape, story, video spec -
   * live in their own files and are re-attached by `load()`, so a 13k-row
   * dataset is never duplicated on disk.
   */
  save(state: ProjectState): void {
    state.updatedAt = new Date().toISOString();
    const { dataset, frameTape, videoSpec, thumbnail, story, quality, dataPlan, ...rest } = state;
    writeFileSync(this.artifact(state.projectId, 'project.json'), JSON.stringify(rest, null, 2), 'utf8');
    if (dataPlan) this.writeArtifact(state.projectId, 'plan.json', dataPlan);
    if (state.sources.length > 0) this.writeArtifact(state.projectId, 'sources.json', state.sources);
    if (dataset) this.writeArtifact(state.projectId, 'dataset.json', dataset);
    if (frameTape) this.writeArtifact(state.projectId, 'frames.json', frameTape);
    if (story) this.writeArtifact(state.projectId, 'story.json', story);
    if (videoSpec) this.writeArtifact(state.projectId, 'video-spec.json', videoSpec);
    if (thumbnail) this.writeArtifact(state.projectId, 'thumbnail.json', thumbnail);
    if (quality) this.writeArtifact(state.projectId, 'quality.json', quality);
    if (state.revisions.length > 0) this.writeArtifact(state.projectId, 'revisions.json', state.revisions);
    if (state.renderJob) this.writeArtifact(state.projectId, 'render-job.json', state.renderJob);
  }
  load(projectId: string): ProjectState {
    const file = this.artifact(projectId, 'project.json');
    if (!existsSync(file)) throw new Error(`project ${projectId} not found in ${this.root}`);
    const state = JSON.parse(readFileSync(file, 'utf8')) as ProjectState;
    // Re-attach artifacts that live in their own files.
    state.dataPlan = state.dataPlan ?? this.readArtifact<DataPlan>(projectId, 'plan.json') ?? undefined;
    state.dataset = state.dataset ?? this.readArtifact<Dataset>(projectId, 'dataset.json') ?? undefined;
    state.frameTape = state.frameTape ?? this.readArtifact<FrameTape>(projectId, 'frames.json') ?? undefined;
    state.story = state.story ?? this.readArtifact<Story>(projectId, 'story.json') ?? undefined;
    state.videoSpec = state.videoSpec ?? this.readArtifact<VideoSpec>(projectId, 'video-spec.json') ?? undefined;
    state.thumbnail = state.thumbnail ?? this.readArtifact<ThumbnailSpec>(projectId, 'thumbnail.json') ?? undefined;
    state.quality = state.quality ?? this.readArtifact<DataQualityReport>(projectId, 'quality.json') ?? undefined;
    state.renderJob = state.renderJob ?? this.readArtifact<RenderJob>(projectId, 'render-job.json') ?? undefined;
    const sources = this.readArtifact<SourceCandidate[]>(projectId, 'sources.json');
    if (sources) state.sources = sources;
    const revisions = this.readArtifact<RevisionRecord[]>(projectId, 'revisions.json');
    if (revisions) state.revisions = revisions;
    state.checkpoints = state.checkpoints ?? [];
    state.notes = state.notes ?? [];
    return state;
  }

  list(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }

  remove(projectId: string): void {
    rmSync(this.dir(projectId), { recursive: true, force: true });
  }

  writeArtifact(projectId: string, name: string, data: unknown): string {
    const file = this.artifact(projectId, name);
    mkdirSync(this.dir(projectId), { recursive: true });
    writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8');
    return file;
  }

  readArtifact<T>(projectId: string, name: string): T | null {
    const file = this.artifact(projectId, name);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  }

  setStatus(state: ProjectState, status: ProjectStatus): ProjectState {
    state.status = status;
    this.save(state);
    logger.info('project status', { projectId: state.projectId, status });
    return state;
  }

  checkpoint(state: ProjectState, checkpoint: Checkpoint, payloadHash?: string): ProjectState {
    state.checkpoints.push({ projectId: state.projectId, checkpoint, at: new Date().toISOString(), payloadHash });
    this.save(state);
    logger.info('checkpoint reached', { projectId: state.projectId, checkpoint });
    return state;
  }

  reached(state: ProjectState, checkpoint: Checkpoint): boolean {
    return state.checkpoints.some((c) => c.checkpoint === checkpoint);
  }

  addRevision(state: ProjectState, revision: RevisionRecord): ProjectState {
    state.revisions.push(revision);
    this.save(state);
    return state;
  }

  logsDir(projectId: string): string {
    const dir = this.artifact(projectId, 'logs');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Shared cache root used by the AI and search providers. */
  cacheRoot(): string {
    return cacheDir();
  }
}