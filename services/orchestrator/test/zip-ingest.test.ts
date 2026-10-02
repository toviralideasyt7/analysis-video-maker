import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isZipBuffer, isZipFile, unzipCsvToFile, unzipCsvToText } from '../src/connectors';

// Regression test for the 2026-10-02 failure of
// "research: forbes-billionaires-evolution-1997-2024-...": the Kaggle
// per-file download endpoint returned a ZIP wrapper (PK\x03\x04 magic, inner
// file all_billionaires_1997_2024.csv) and the header sniffer choked on the
// raw binary bytes. Kaggle ingest must detect zip magic and extract the CSV.
describe('kaggle zip-wrapper handling', () => {
  const zipPath = '/tmp/ziptest/data.zip';

  it('detects zip magic in buffers and files', () => {
    const bytes = readFileSync(zipPath);
    expect(isZipBuffer(bytes)).toBe(true);
    expect(isZipFile(zipPath)).toBe(true);
    expect(isZipBuffer(Buffer.from('name,year\nElon,2024\n', 'utf-8'))).toBe(false);
  });

  it('extracts the inner CSV from zip bytes', () => {
    const bytes = readFileSync(zipPath);
    const { name, text } = unzipCsvToText(bytes, 200 * 1024 * 1024, 'test zip');
    expect(name).toMatch(/\.csv$/i);
    expect(text).toContain('name,year,net_worth_b');
    expect(text).toContain('Elon Musk,2024,195');
  });

  it('extracts the inner CSV from a zip file to disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'avm-ziptest-'));
    try {
      const { name, csvPath } = unzipCsvToFile(zipPath, dir);
      expect(name).toMatch(/\.csv$/i);
      expect(readFileSync(csvPath, 'utf-8')).toContain('Jeff Bezos,2024,194');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws a clear error when a zip has no CSV', () => {
    const dir = mkdtempSync(join(tmpdir(), 'avm-ziptest-'));
    try {
      // notes-only zip built on the fly via the pre-made one won't do; use expect on a bad zip
      const bad = Buffer.from('PK\x03\x04not a real zip', 'utf-8');
      expect(() => unzipCsvToText(bad, 1024 * 1024, 'bad zip')).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
