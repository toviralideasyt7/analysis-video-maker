/**
 * Server-side validation of an uploaded video-input file.
 *
 * Structure is checked against the shared JSON schema; values are checked with
 * rules the schema cannot express (dates parse, values finite, entities
 * referenced by observations exist). Nothing is "fixed" here: a bad file is
 * rejected with the exact reasons so the user can correct it.
 */

import Ajv from 'ajv';
import videoInputSchema from '@avm/shared/schemas/video-input.schema.json';
import { dateKey } from './dates';
import type { VideoInput } from '@avm/shared';

const ajv = new Ajv({ allErrors: true, strict: false });
const validateSchema = ajv.compile(videoInputSchema);

export interface ValidationOutcome {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function validateVideoInputFile(value: unknown): ValidationOutcome {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!validateSchema(value)) {
    for (const error of validateSchema.errors ?? []) {
      errors.push(`${error.instancePath || '/'} ${error.message ?? 'invalid'}`.trim());
    }
    return { ok: false, errors, warnings };
  }

  const input = value as unknown as VideoInput;

  // Dates must parse and be monotonic-able.
  const badDates = new Set<string>();
  for (const obs of input.observations) {
    if (!Number.isFinite(dateKey(obs.date))) badDates.add(obs.date);
  }
  if (badDates.size > 0) {
    errors.push(`unparsable dates: ${Array.from(badDates).slice(0, 5).join(', ')}`);
  }

  for (const [index, obs] of input.observations.entries()) {
    if (!Number.isFinite(obs.value)) errors.push(`observation ${index} (${obs.entity} @ ${obs.date}) has a non-numeric value`);
  }

  // Entities referenced by observations must exist in the entity list when one
  // is supplied - otherwise colors/flags would silently be missing.
  if (input.entities && input.entities.length > 0) {
    const known = new Set<string>();
    for (const entity of input.entities) {
      known.add(entity.id.toLowerCase());
      known.add(entity.name.toLowerCase());
    }
    const missing = new Set<string>();
    for (const obs of input.observations) {
      if (!known.has(obs.entity.trim().toLowerCase())) missing.add(obs.entity);
    }
    if (missing.size > 0) {
      warnings.push(
        `${missing.size} entities have observations but no entry in "entities" (they will get an auto color and no flag): ${Array.from(missing).slice(0, 5).join(', ')}`,
      );
    }
  }

  const distinctDates = new Set(input.observations.map((o) => o.date.trim()));
  if (distinctDates.size < 2) {
    errors.push('at least two distinct dates are needed for a race');
  }

  // A group with no members would render an empty column.
  if (input.groups && input.groups.length > 0 && input.entities) {
    const used = new Set(input.entities.map((e) => e.group).filter(Boolean) as string[]);
    for (const group of input.groups) {
      if (!used.has(group.id)) warnings.push(`group "${group.id}" has no entities and will not be drawn`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}