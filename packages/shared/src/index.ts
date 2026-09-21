export * from './types';
export * from './validate';

export const SCHEMA_IDS = {
  dataPlan: 'schemas/data-plan.schema.json',
  observation: 'schemas/observation.schema.json',
  videoSpec: 'schemas/video-spec.schema.json',
  thumbnailSpec: 'schemas/thumbnail-spec.schema.json',
  story: 'schemas/story.schema.json',
  dataQualityReport: 'schemas/data-quality-report.schema.json',
  renderJob: 'schemas/render-job.schema.json',
} as const;