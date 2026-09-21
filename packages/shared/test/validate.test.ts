import { describe, expect, it } from 'vitest';
import {
  semanticVideoSpecProblems,
  validateDataPlan,
  validateObservation,
  validateVideoSpec,
} from '../src/validate';

const VALID_SPEC = {
  version: '1.0',
  metadata: { title: 'Most Popular Cell Phone Brands', subtitle: '2000-2012', language: 'en', durationSeconds: 120 },
  canvas: { width: 1280, height: 720, fps: 30 },
  theme: { background: '#ffffff', primaryText: '#111111', fontFamily: 'Inter' },
  datasetRef: 'dataset_1',
  scenes: [
    { id: 's1', type: 'title', duration: 6 },
    { id: 's2', type: 'bar_race', duration: 108, datasetRef: 'dataset_1' },
    { id: 's3', type: 'ending', duration: 6 },
  ],
  assets: [],
  sources: [{ url: 'https://example.com/x.csv', publisher: 'Example', retrievedAt: '2026-09-21T00:00:00Z' }],
};

describe('video spec schema', () => {
  it('accepts a valid spec', () => {
    expect(validateVideoSpec(VALID_SPEC).valid).toBe(true);
  });

  it('rejects an unknown scene type', () => {
    const bad = { ...VALID_SPEC, scenes: [{ id: 'x', type: 'hologram', duration: 3 }] };
    expect(validateVideoSpec(bad).valid).toBe(false);
  });

  it('rejects a spec without scenes', () => {
    const bad = { ...VALID_SPEC, scenes: [] };
    expect(validateVideoSpec(bad).valid).toBe(false);
  });

  it('flags a duration mismatch semantically', () => {
    const problems = semanticVideoSpecProblems({ ...VALID_SPEC, metadata: { durationSeconds: 400 } });
    expect(problems.some((p) => p.includes('does not match'))).toBe(true);
  });

  it('flags duplicate scene ids', () => {
    const problems = semanticVideoSpecProblems({
      metadata: { durationSeconds: 12 },
      scenes: [
        { id: 'a', type: 'title', duration: 6 },
        { id: 'a', type: 'ending', duration: 6 },
      ],
    });
    expect(problems.some((p) => p.includes('duplicate scene id'))).toBe(true);
  });
});

describe('observation schema', () => {
  it('accepts a verified observation', () => {
    const ok = validateObservation({
      observationId: 'obs_00001',
      entity: { id: 'india', name: 'India', iso2: 'IN', flagCode: 'in' },
      date: '2001-01-01',
      frequency: 'annual',
      value: 1053.9,
      unit: 'count',
      source: { url: 'https://data.worldbank.org/', publisher: 'World Bank', retrievedAt: '2026-09-21T00:00:00Z' },
      method: 'direct',
      status: 'VERIFIED',
      confidence: 0.9,
    });
    expect(ok.valid).toBe(true);
  });

  it('requires a null value to be UNKNOWN', () => {
    const bad = validateObservation({
      observationId: 'obs_00002',
      entity: { id: 'india', name: 'India' },
      date: '2020-01-01',
      frequency: 'annual',
      value: null,
      unit: 'count',
      source: { url: 'https://x.test', publisher: 'X', retrievedAt: '2026-09-21T00:00:00Z' },
      method: 'direct',
      status: 'VERIFIED',
    });
    expect(bad.valid).toBe(false);
  });
});

describe('data plan schema', () => {
  it('requires the missing data policy', () => {
    const bad = validateDataPlan({
      version: '1.0',
      topic: 'x',
      metric: 'y',
      entityType: 'country',
      timeRange: { start: '1990', end: '2020' },
      frequency: 'annual',
      requiredFields: ['entity'],
    });
    expect(bad.valid).toBe(false);
  });

  it('accepts a complete plan', () => {
    const ok = validateDataPlan({
      version: '1.0',
      topic: 'Most popular cell phone brands',
      metric: 'global market share',
      metricAmbiguous: true,
      interpretations: [{ id: 'a', label: 'Units shipped', measurableDefinition: 'annual units shipped' }],
      entityType: 'brand',
      timeRange: { start: '2000', end: '2012' },
      frequency: 'annual',
      requiredFields: ['entity', 'date', 'value', 'unit', 'source'],
      candidateEntities: ['Nokia'],
      preferredSources: ['Statista'],
      knownRisks: ['paywalled'],
      missingDataPolicy: 'STRICT',
      targetEntityCount: 15,
    });
    expect(ok.valid).toBe(true);
  });
});