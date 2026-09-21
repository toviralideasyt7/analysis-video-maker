import { describe, expect, it } from 'vitest';
import { csvToInput, parseCsv } from '../src/csv';
import { validateVideoInputFile } from '../src/validate';

const CSV = [
  'entity,date,value,color,flagCode,group',
  'India,1960,449000000,#F15A22,in,Asia',
  'China,1960,660000000,#E8241F,cn,Asia',
  'India,1970,555000000,,in,Asia',
  'China,1970,818000000,,cn,Asia',
  'India,bad-row,,in,Asia',
].join('\n');

const FACTS = ['atDate,heading,body,tiles', '1970,Seventies,Growth accelerates.,India;China'].join('\n');

describe('parseCsv', () => {
  it('parses quoted fields and skips empty rows', () => {
    const table = parseCsv('a,b\n"1,5",x\n\n');
    expect(table.columns).toEqual(['a', 'b']);
    expect(table.rows).toEqual([['1,5', 'x']]);
  });
});

describe('csvToInput', () => {
  it('converts entity/date/value plus metadata columns', () => {
    const { input, warnings } = csvToInput(CSV, { title: 'T', metric: 'Pop', unit: 'people' });
    expect(input.entities).toHaveLength(2);
    expect(input.observations).toHaveLength(4);
    const india = input.entities?.find((e) => e.name === 'India');
    expect(india?.color).toBe('#F15A22');
    expect(india?.flagCode).toBe('in');
    expect(india?.group).toBe('Asia');
    expect(warnings.some((w) => w.includes('1 rows'))).toBe(true);
    expect(input.worldTotal?.find((w) => w.date === '1960')?.value).toBe(1109000000);
  });
});

describe('validateVideoInputFile', () => {
  it('accepts a good converted file', () => {
    const { input } = csvToInput(CSV, { title: 'T', metric: 'Pop', unit: 'people' });
    const result = validateVideoInputFile(input);
    expect(result.ok).toBe(true);
  });

  it('rejects a file with fewer than two dates', () => {
    const { input } = csvToInput('entity,date,value\nIndia,1960,1\nChina,1960,2', { title: 'T', metric: 'M', unit: 'u' });
    const result = validateVideoInputFile(input);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('two distinct dates'))).toBe(true);
  });

  it('warns when observations reference unknown entities', () => {
    const raw = {
      version: '1.0',
      title: 'T',
      metric: 'M',
      unit: 'u',
      entities: [{ id: 'india', name: 'India' }],
      observations: [
        { entity: 'india', date: '1960', value: 1 },
        { entity: 'india', date: '1970', value: 2 },
        { entity: 'atlantis', date: '1960', value: 3 },
      ],
    };
    const result = validateVideoInputFile(raw);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes('atlantis'))).toBe(true);
  });

  it('rejects an unparsable date', () => {
    const { input } = csvToInput(CSV.replace('bad-row', 'bad-date'), { title: 'T', metric: 'M', unit: 'u' });
    const result = validateVideoInputFile({ ...input, observations: [...input.observations, { entity: 'India', date: 'long ago', value: 5 }] });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('unparsable dates'))).toBe(true);
  });
});