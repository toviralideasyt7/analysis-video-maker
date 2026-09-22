/**
 * Shared contract types for the whole platform.
 *
 * These mirror the JSON Schemas in `../schemas/*.json`. The schemas are the
 * runtime gate; these types are the compile-time view. Keep both in sync.
 *
 * Hard rules encoded here:
 *  - a missing measurement is `value: null` with `status: "UNKNOWN"`;
 *  - every observation carries provenance;
 *  - derived values must declare their formula and inputs.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type DataStatus =
  | 'VERIFIED'
  | 'SUPPORTED'
  | 'ESTIMATED'
  | 'UNKNOWN'
  | 'CONFLICTING'
  | 'REJECTED';

export type Frequency = 'annual' | 'quarterly' | 'monthly' | 'weekly' | 'daily' | 'unknown';

export type MissingDataPolicy = 'STRICT' | 'INTERPOLATION_ALLOWED' | 'ESTIMATION_ALLOWED';

export type ProjectStatus =
  | 'DRAFT'
  | 'PLANNING'
  | 'RESEARCHING'
  | 'EXTRACTING'
  | 'VERIFYING'
  | 'READY_FOR_REVIEW'
  | 'REVISION_REQUESTED'
  | 'APPROVED'
  | 'RENDERING'
  | 'RENDERED'
  | 'FAILED';

export type Checkpoint =
  | 'PLAN_COMPLETE'
  | 'SOURCES_COMPLETE'
  | 'EXTRACTION_COMPLETE'
  | 'NORMALIZATION_COMPLETE'
  | 'VERIFICATION_COMPLETE'
  | 'DATASET_COMPLETE'
  | 'STORY_COMPLETE'
  | 'VIDEOSPEC_COMPLETE'
  | 'APPROVED'
  | 'RENDER_COMPLETE';

export type EntityResolutionStatus = 'resolved' | 'ambiguous' | 'unresolved';

// ---------------------------------------------------------------------------
// Data plan
// ---------------------------------------------------------------------------

export interface DateRange {
  start: string;
  end: string;
}

export interface MetricInterpretation {
  id: string;
  label: string;
  description: string;
  measurableDefinition: string;
  caveats?: string[];
  recommended?: boolean;
}

export interface DataPlan {
  version: '1.0';
  topic: string;
  metric: string;
  metricAmbiguous: boolean;
  interpretations: MetricInterpretation[];
  chosenInterpretationId?: string;
  entityType: string;
  timeRange: DateRange;
  frequency: Frequency;
  geography?: string;
  requiredFields: string[];
  candidateEntities: string[];
  preferredSources: string[];
  knownRisks: string[];
  missingDataPolicy: MissingDataPolicy;
  targetEntityCount: number;
  generatedBy: AgentProvenance;
}

export interface AgentProvenance {
  agent: string;
  model?: string;
  provider?: string;
  at: string;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export interface SourceDefinition {
  name: string;
  type: 'api' | 'dataset' | 'search' | 'report' | 'directory' | 'upload';
  url: string;
  domains: string[];
  categories: string[];
  accessMethod: 'api' | 'download' | 'web' | 'manual';
  priority: number;
  requiresAuth: boolean;
  license: string;
  notes?: string;
}

export interface SourceCandidate {
  candidateId: string;
  sourceName: string;
  publisher: string;
  url: string;
  kind: 'api' | 'dataset' | 'report' | 'web' | 'upload';
  accessMethod: 'api' | 'download' | 'web' | 'manual';
  title?: string;
  description?: string;
  publishedAt?: string;
  retrievedAt: string;
  license?: string;
  machineReadable: boolean;
  authority: number;
  directness: number;
  coverage: number;
  methodologyTransparency: number;
  recency: number;
  consistency: number;
  qualityScore: number;
  accepts: boolean | null;
  primary: boolean;
  discoveredBy: string;
  notes?: string[];
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

export interface SourceRef {
  url: string;
  publisher: string;
  title?: string;
  publishedAt?: string | null;
  retrievedAt: string;
  identifier?: string;
}

export interface EvidenceRef {
  quoteOrExcerpt?: string;
  page?: number;
  table?: string;
  figure?: string;
  section?: string;
  endpoint?: string;
  queryParams?: Record<string, unknown>;
  responseTimestamp?: string;
  apiVersion?: string;
  datasetUrl?: string;
  datasetVersion?: string;
  fileName?: string;
  columns?: string[];
  rowIdentifier?: string;
  screenshotUrl?: string;
}

export interface DerivedInfo {
  method: 'calculated';
  formula: string;
  inputs: string[];
  sourceObservations: string[];
}

export interface Observation {
  observationId: string;
  entity: { id: string; name: string; iso2?: string | null; flagCode?: string | null; group?: string | null };
  entityResolution?: EntityResolutionStatus;
  date: string;
  frequency: Frequency;
  value: number | null;
  unit: string;
  unitDimension?: string;
  geography?: string;
  source: SourceRef;
  evidence?: EvidenceRef;
  method: 'direct' | 'calculated' | 'estimated';
  status: DataStatus;
  confidence?: number;
  derived?: DerivedInfo;
}

export interface Conflict {
  conflictId: string;
  entityId: string;
  date: string;
  metric: string;
  unit: string;
  candidates: Array<{ observationId: string; value: number; sourceUrl: string; status: DataStatus }>;
  reason: string;
  resolved: boolean;
  resolutionNote?: string;
}

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

export interface Dataset {
  datasetId: string;
  projectId: string;
  name: string;
  metric: string;
  unit: string;
  timeRange: DateRange;
  frequency: Frequency;
  missingDataPolicy: MissingDataPolicy;
  version: number;
  frozen: boolean;
  observations: Observation[];
  conflicts: Conflict[];
  stats: {
    observations: number;
    entities: number;
    verified: number;
    supported: number;
    estimated: number;
    unknown: number;
    conflicting: number;
    rejected: number;
  };
  createdAt: string;
}

export interface DataQualityCheck {
  name: string;
  passed: boolean;
  violations: number;
  details: string[];
}

export interface DataQualityReport {
  observations: number;
  entities: number;
  checks: DataQualityCheck[];
  violations: number;
  passed: boolean;
  generatedAt: string;
  engine?: 'rust' | 'typescript';
}

// ---------------------------------------------------------------------------
// Story + VideoSpec
// ---------------------------------------------------------------------------

export interface StoryHighlight {
  atLabel: string;
  entityId: string;
  headline: string;
  detail: string;
  factBox?: { heading: string; body: string; dateLabel?: string; wordmark?: string };
}

export interface Story {
  version: '1.0';
  title: string;
  subtitle: string;
  hook: string;
  setup: string;
  sequence: Array<{ atLabel: string; text: string }>;
  highlights: StoryHighlight[];
  ending: string;
  sourcesLine: string;
  generatedBy: AgentProvenance;
}

export type SceneType =
  | 'title'
  | 'subtitle'
  | 'intro'
  | 'bar_race'
  | 'horizontal_rank_bars'
  | 'number_counter'
  | 'rank_change'
  | 'highlight'
  | 'comparison'
  | 'timeline'
  | 'map'
  | 'ending'
  | 'source_card'
  | 'fact_box'
  | 'continent_chart'
  | 'pie_summary';

export interface Scene {
  id: string;
  type: SceneType;
  duration: number;
  title?: string;
  subtitle?: string;
  datasetRef?: string;
  entities?: string[];
  props?: Record<string, unknown>;
}

export interface VideoSpec {
  version: '1.0';
  metadata: {
    title: string;
    subtitle?: string;
    language: string;
    durationSeconds: number;
  };
  canvas: { width: number; height: number; fps: number };
  theme: Record<string, string | number>;
  datasetRef: string;
  scenes: Scene[];
  assets: AssetRef[];
  sources: SourceRef[];
}

export interface AssetRef {
  assetId: string;
  entityId?: string;
  type: 'logo' | 'photo' | 'icon' | 'flag' | 'map' | 'background' | 'font' | 'audio';
  url: string;
  source: string;
  license: string;
  retrievedAt: string;
  localPath?: string;
  hash?: string;
}

export interface ThumbnailSpec {
  version: '1.0';
  title: string;
  subtitle: string;
  entities: string[];
  assets: string[];
  layout: 'ranking' | 'split' | 'versus' | 'spotlight';
  backgroundColor?: string;
  accentColor?: string;
}

// ---------------------------------------------------------------------------
// Jobs / project state
// ---------------------------------------------------------------------------

export interface RenderJob {
  renderJobId: string;
  projectId: string;
  commit?: string;
  videoSpecVersion: number;
  datasetVersion: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  createdAt: string;
  githubRunId?: number | null;
  artifactUrl?: string | null;
  notes?: string[];
}

export interface UsageRecord {
  at: string;
  provider: string;
  model?: string;
  operation: string;
  tokens?: number;
  durationMs: number;
  estimatedCost?: number;
  cached?: boolean;
  ok: boolean;
}

export interface CheckpointRecord {
  projectId: string;
  checkpoint: Checkpoint;
  at: string;
  payloadHash?: string;
}