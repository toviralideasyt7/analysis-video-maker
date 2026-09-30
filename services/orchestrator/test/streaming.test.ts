import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { streamCsvFileRows } from '../src/connectors';

function writeCsv(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'avm-test-'));
  const p = join(dir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

describe('streamCsvFileRows', () => {
  it('parses rows with quoted fields spanning chunk boundaries', async () => {
    // Force many chunk boundaries by writing a big quoted field.
    const bigCast = `[{"name": "Tom Hanks", "character": "Woody"}, {"name": "Tim Allen", "character": "Buzz"}]`;
    const rows: string[] = [];
    rows.push('title,release_date,revenue,cast');
    rows.push(`Toy Story,1995-11-22,373554033,"${bigCast.replace(/"/g, '""')}"`);
    rows.push(`Forrest Gump,1994-07-06,678226465,"${`[{"name": "Tom Hanks"}]`.replace(/"/g, '""')}"`);
    const p = writeCsv('t.csv', rows.join('\n') + '\n');
    const out: string[][] = [];
    for await (const row of streamCsvFileRows(p)) out.push(row);
    rmSync(join(p, '..'), { recursive: true, force: true });
    expect(out.length).toBe(3);
    expect(out[0]).toEqual(['title', 'release_date', 'revenue', 'cast']);
    expect(out[1][0]).toBe('Toy Story');
    expect(out[1][3]).toContain('"name": "Tom Hanks"');
    expect(out[2][2]).toBe('678226465');
  });

  it('handles a quoted field containing an embedded newline', async () => {
    const p = writeCsv('n.csv', 'a,b\n"x\ny",2\nz,3\n');
    const out: string[][] = [];
    for await (const row of streamCsvFileRows(p)) out.push(row);
    rmSync(join(p, '..'), { recursive: true, force: true });
    expect(out).toEqual([
      ['a', 'b'],
      ['x\ny', '2'],
      ['z', '3'],
    ]);
  });
});
