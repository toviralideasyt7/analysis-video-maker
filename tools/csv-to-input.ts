#!/usr/bin/env tsx
/**
 * Convert a simple CSV into the video-input JSON.
 *
 *   npx tsx tools/csv-to-input.ts --in data.csv --out input.json --title "..." --metric "..." --unit "..."
 *
 * CSV columns (header required):
 *   entity,date,value            (required - one row per entity per period)
 *   color,flagCode,group        (optional - first non-empty value per entity wins)
 *
 * Optional second file for facts: --facts facts.csv with columns
 *   atDate,heading,body,tiles    (tiles = entity ids/names separated by ";")
 *
 * The converter never invents numbers: a row without a parseable value is
 * reported and skipped.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseCsv } from '../legacy/research-stack/orchestrator/src/connectors';
import type { VideoInput, VideoInputFact } from '@avm/shared';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function column(columns: string[], names: string[]): number {
  const lower = columns.map((c) => c.trim().toLowerCase());
  for (const name of names) {
    const index = lower.indexOf(name);
    if (index >= 0) return index;
  }
  return -1;
}

function main(): void {
  const inPath = arg('in');
  if (!inPath) {
    process.stderr.write('usage: tsx csv-to-input.ts --in <data.csv> --out <video-input.json> --title "..." --metric "..." --unit "..."\n');
    process.exit(2);
  }
  const text = readFileSync(resolve(inPath), 'utf8');
  const table = parseCsv(text, text.includes('\t') && !text.includes(',') ? '\t' : ',');
  const ci = {
    entity: column(table.columns, ['entity', 'country', 'name', 'brand']),
    date: column(table.columns, ['date', 'year', 'time']),
    value: column(table.columns, ['value', 'population', 'amount', 'count', 'total', 'sales']),
    color: column(table.columns, ['color', 'colour']),
    flag: column(table.columns, ['flagcode', 'flag', 'iso2']),
    group: column(table.columns, ['group', 'continent', 'category']),
  };
  if (ci.entity < 0 || ci.date < 0 || ci.value < 0) {
    process.stderr.write(`CSV needs entity/date/value columns; found: ${table.columns.join(', ')}\n`);
    process.exit(1);
  }

  const entities = new Map<string, { id: string; name: string; color?: string; flagCode?: string; group?: string }>();
  const observations: VideoInput['observations'] = [];
  let skipped = 0;

  for (const row of table.rows) {
    const name = (row[ci.entity] ?? '').trim();
    const date = (row[ci.date] ?? '').trim();
    const rawValue = (row[ci.value] ?? '').trim().replace(/[",\s]/g, '');
    if (!name || !date) continue;
    const value = rawValue === '' ? Number.NaN : Number.parseFloat(rawValue);
    if (!Number.isFinite(value)) {
      skipped += 1;
      continue;
    }
    const key = name.toLowerCase();
    if (!entities.has(key)) {
      entities.set(key, {
        id: key.replace(/[^a-z0-9]+/g, '-'),
        name,
        color: ci.color >= 0 ? row[ci.color]?.trim() || undefined : undefined,
        flagCode: ci.flag >= 0 ? row[ci.flag]?.trim().toLowerCase() || undefined : undefined,
        group: ci.group >= 0 ? row[ci.group]?.trim() || undefined : undefined,
      });
    } else {
      const existing = entities.get(key)!;
      existing.color = existing.color ?? (ci.color >= 0 ? row[ci.color]?.trim() || undefined : undefined);
      existing.flagCode = existing.flagCode ?? (ci.flag >= 0 ? row[ci.flag]?.trim().toLowerCase() || undefined : undefined);
      existing.group = existing.group ?? (ci.group >= 0 ? row[ci.group]?.trim() || undefined : undefined);
    }
    observations.push({ entity: name, date, value });
  }

  const facts: VideoInputFact[] = [];
  const factsPath = arg('facts');
  if (factsPath) {
    const factTable = parseCsv(readFileSync(resolve(factsPath), 'utf8'), ',');
    const fc = {
      atDate: column(factTable.columns, ['atdate', 'date', 'year']),
      heading: column(factTable.columns, ['heading', 'title']),
      body: column(factTable.columns, ['body', 'text', 'fact']),
      tiles: column(factTable.columns, ['tiles', 'entities']),
    };
    for (const row of factTable.rows) {
      const atDate = (row[fc.atDate] ?? '').trim();
      const heading = (row[fc.heading] ?? '').trim();
      if (!atDate || !heading) continue;
      facts.push({
        atDate,
        heading,
        body: (row[fc.body] ?? '').trim(),
        tiles: (row[fc.tiles] ?? '').split(';').map((t) => t.trim()).filter(Boolean),
      });
    }
  }

  const input: VideoInput = {
    version: '1.0',
    title: arg('title') ?? basename(inPath).replace(/\.[a-z]+$/i, ''),
    metric: arg('metric') ?? 'Total',
    unit: arg('unit') ?? 'count',
    valueFormat: (arg('format') as 'comma' | 'compact') ?? 'comma',
    settings: {
      topN: arg('topn') ? Number(arg('topn')) : 15,
      secondsPerYear: arg('seconds-per-year') ? Number(arg('seconds-per-year')) : 0.4,
    },
    entities: Array.from(entities.values()),
    observations,
    facts,
  };

  writeFileSync(resolve(arg('out') ?? 'video-input.json'), JSON.stringify(input, null, 2), 'utf8');
  process.stdout.write(`entities=${entities.size} observations=${observations.length} facts=${facts.length} skipped=${skipped}\n`);
}

main();