/** CSV parsing + CSV -> VideoInput conversion for uploads. */

import type { VideoInput, VideoInputFact } from '@avm/shared';
import { dateKey } from './dates';

export function parseCsv(text: string, delimiter = ','): { columns: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const columns = rows.shift() ?? [];
  return { columns, rows: rows.filter((r) => r.some((c) => c.trim() !== '')) };
}

export interface CsvConvertOptions {
  title: string;
  metric: string;
  unit: string;
  topN?: number;
  secondsPerYear?: number;
}

export function csvToInput(text: string, options: CsvConvertOptions): { input: VideoInput; warnings: string[] } {
  const warnings: string[] = [];
  const table = parseCsv(text, text.includes('\t') && !text.includes(',') ? '\t' : ',');
  const col = (names: string[]): number => {
    const lower = table.columns.map((c) => c.trim().toLowerCase());
    for (const name of names) {
      const index = lower.indexOf(name);
      if (index >= 0) return index;
    }
    return -1;
  };
  const ci = {
    entity: col(['entity', 'country', 'name', 'brand']),
    date: col(['date', 'year', 'time']),
    value: col(['value', 'population', 'amount', 'count', 'total', 'sales']),
    color: col(['color', 'colour']),
    flag: col(['flagcode', 'flag', 'iso2']),
    group: col(['group', 'continent', 'category']),
  };
  if (ci.entity < 0 || ci.date < 0 || ci.value < 0) {
    throw new Error(`the CSV needs entity/date/value columns; found: ${table.columns.join(', ')}`);
  }

  interface EntityRow {
    id: string;
    name: string;
    color?: string;
    flagCode?: string;
    group?: string;
  }
  const entities = new Map<string, EntityRow>();
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
    const existing = entities.get(key);
    if (existing) {
      existing.color = existing.color ?? (ci.color >= 0 ? row[ci.color]?.trim() || undefined : undefined);
      existing.flagCode = existing.flagCode ?? (ci.flag >= 0 ? row[ci.flag]?.trim().toLowerCase() || undefined : undefined);
      existing.group = existing.group ?? (ci.group >= 0 ? row[ci.group]?.trim() || undefined : undefined);
    } else {
      entities.set(key, {
        id: key.replace(/[^a-z0-9]+/g, '-'),
        name,
        color: ci.color >= 0 ? row[ci.color]?.trim() || undefined : undefined,
        flagCode: ci.flag >= 0 ? row[ci.flag]?.trim().toLowerCase() || undefined : undefined,
        group: ci.group >= 0 ? row[ci.group]?.trim() || undefined : undefined,
      } satisfies EntityRow);
    }
    observations.push({ entity: name, date, value });
  }
  if (skipped > 0) warnings.push(`${skipped} rows had no parseable value and were skipped`);

  // World total per period when none was supplied: the sum is what the panel
  // shows, and a sum of the uploaded entities is the only thing we can know.
  const totals = new Map<string, number>();
  for (const obs of observations) {
    totals.set(obs.date.trim(), (totals.get(obs.date.trim()) ?? 0) + obs.value);
  }

  const input: VideoInput = {
    version: '1.0',
    title: options.title,
    metric: options.metric,
    unit: options.unit,
    valueFormat: 'comma',
    settings: {
      topN: options.topN ?? 15,
      secondsPerYear: options.secondsPerYear ?? 0.4,
    },
    entities: entities.values().next().value ? Array.from(entities.values()) : [],
    observations,
    groups: [],
    worldTotal: Array.from(totals.entries())
      .filter(([date]) => Number.isFinite(dateKey(date)))
      .map(([date, value]) => ({ date, value }))
      .sort((a, b) => dateKey(a.date) - dateKey(b.date)),
  };
  return { input, warnings };
}