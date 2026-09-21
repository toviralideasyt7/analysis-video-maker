/**
 * Runtime validation against the JSON Schemas in `../schemas`.
 *
 * The schemas are the gate between AI output and the renderer: nothing reaches
 * Remotion without passing `validateVideoSpec`.
 */

import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import dataPlanSchema from '../schemas/data-plan.schema.json';
import observationSchema from '../schemas/observation.schema.json';
import videoSpecSchema from '../schemas/video-spec.schema.json';
import thumbnailSpecSchema from '../schemas/thumbnail-spec.schema.json';
import storySchema from '../schemas/story.schema.json';
import dataQualitySchema from '../schemas/data-quality-report.schema.json';
import renderJobSchema from '../schemas/render-job.schema.json';
import agentOutputsSchema from '../schemas/agent-outputs.schema.json';
import videoInputSchema from '../schemas/video-input.schema.json';

export type SchemaName =
  | 'dataPlan'
  | 'observation'
  | 'videoSpec'
  | 'thumbnailSpec'
  | 'story'
  | 'dataQualityReport'
  | 'renderJob'
  | 'scouting'
  | 'sourceSelection'
  | 'extractedRows'
  | 'aiQaVerdict'
  | 'revisionPlan'
  | 'videoInput';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const rawSchemas: Partial<Record<SchemaName, object>> = {
  dataPlan: dataPlanSchema as object,
  observation: observationSchema as object,
  videoSpec: videoSpecSchema as object,
  thumbnailSpec: thumbnailSpecSchema as object,
  story: storySchema as object,
  dataQualityReport: dataQualitySchema as object,
  renderJob: renderJobSchema as object,
  videoInput: videoInputSchema as object,
};

let cached: Record<SchemaName, ValidateFunction> | null = null;

// Agent-output contracts live as `definitions` in one document, so they are
// registered once and referenced by pointer.
const AGENT_OUTPUT_DEFS = ['scouting', 'sourceSelection', 'extractedRows', 'aiQaVerdict', 'revisionPlan'] as const;

function compilers(): Record<SchemaName, ValidateFunction> {
  if (cached) return cached;
  const ajv = new Ajv({ allErrors: true, strict: false });
  const out = {} as Record<SchemaName, ValidateFunction>;
  for (const [name, schema] of Object.entries(rawSchemas)) {
    if (!schema) continue;
    out[name as SchemaName] = ajv.compile(schema);
  }
  ajv.addSchema(agentOutputsSchema, 'agentOutputs');
  for (const def of AGENT_OUTPUT_DEFS) {
    const fn = ajv.getSchema(`agentOutputs#/definitions/${def}`);
    if (fn) out[def] = fn;
  }
  cached = out;
  return out;
}

function format(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors || errors.length === 0) return [];
  return errors.map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`.trim());
}

export function validate(name: SchemaName, value: unknown): ValidationResult {
  const fn = compilers()[name];
  const valid = fn(value) as boolean;
  return { valid, errors: valid ? [] : format(fn.errors) };
}

export function validateVideoSpec(value: unknown): ValidationResult {
  return validate('videoSpec', value);
}

export function validateDataPlan(value: unknown): ValidationResult {
  return validate('dataPlan', value);
}

export function validateObservation(value: unknown): ValidationResult {
  return validate('observation', value);
}

export function validateStory(value: unknown): ValidationResult {
  return validate('story', value);
}

export function validateThumbnailSpec(value: unknown): ValidationResult {
  return validate('thumbnailSpec', value);
}

export function validateDataQualityReport(value: unknown): ValidationResult {
  return validate('dataQualityReport', value);
}

export function validateRenderJob(value: unknown): ValidationResult {
  return validate('renderJob', value);
}

export function validateVideoInput(value: unknown): ValidationResult {
  return validate('videoInput', value);
}

/** Throwing variant used where a downstream step must not proceed. */
export function assertVideoSpec(value: unknown): void {
  const result = validateVideoSpec(value);
  if (!result.valid) {
    throw new Error(`VideoSpec failed schema validation:\n - ${result.errors.join('\n - ')}`);
  }
}

/**
 * Semantic checks a JSON Schema cannot express. An empty array means the spec
 * is renderable.
 */
export function semanticVideoSpecProblems(spec: {
  metadata?: { durationSeconds?: number };
  scenes?: Array<{ id?: string; type?: string; duration?: number }>;
}): string[] {
  const problems: string[] = [];
  const scenes = spec.scenes ?? [];
  if (scenes.length === 0) {
    problems.push('spec has no scenes');
    return problems;
  }
  const ids = new Set<string>();
  for (const scene of scenes) {
    if (scene.id) {
      if (ids.has(scene.id)) problems.push(`duplicate scene id: ${scene.id}`);
      ids.add(scene.id);
    }
    if (!scene.duration || scene.duration <= 0) {
      problems.push(`scene ${scene.id ?? '(no id)'} has a non-positive duration`);
    }
  }
  const total = scenes.reduce((sum, s) => sum + (s.duration ?? 0), 0);
  const declared = spec.metadata?.durationSeconds;
  if (typeof declared === 'number' && Math.abs(total - declared) > Math.max(2, declared * 0.05)) {
    problems.push(
      `declared duration ${declared}s does not match summed scene durations ${total.toFixed(1)}s`,
    );
  }
  return problems;
}