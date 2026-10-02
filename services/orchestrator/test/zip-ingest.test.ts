import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isZipBuffer, isZipFile, unzipCsvToFile, unzipCsvToText } from '../src/connectors';

// ---------------------------------------------------------------------------
// Minimal stored (uncompressed) ZIP builder — pure Node, no external tools,
// so the fixture works on any runner.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildStoredZip(entries: Array<{ name: string; data: string }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf-8');
    const data = Buffer.from(e.data, 'utf-8');
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    const cd = Buffer.alloc(46 + name.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    name.copy(cd, 46);
    parts.push(local, data);
    central.push(cd);
    offset += local.length + data.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, eocd]);
}

const CSV = 'name,year,net_worth_b\nElon Musk,2024,195\nJeff Bezos,2024,194\n';

function makeFixture(): { dir: string; zipPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'avm-ziptest-'));
  const zipPath = join(dir, 'data.zip');
  writeFileSync(
    zipPath,
    buildStoredZip([
      { name: 'all_billionaires_1997_2024.csv', data: CSV },
      { name: 'notes.txt', data: 'readme\n' },
    ]),
  );
  return { dir, zipPath };
}

// Regression test for the 2026-10-02 failure of
// "research: forbes-billionaires-evolution-1997-2024-...": the Kaggle
// per-file download endpoint returned a ZIP wrapper (PK\x03\x04 magic, inner
// file all_billionaires_1997_2024.csv) and the header sniffer choked on the
// raw binary bytes. Kaggle ingest must detect zip magic and extract the CSV.
describe('kaggle zip-wrapper handling', () => {
  it('detects zip magic in buffers and files', () => {
    const { dir, zipPath } = makeFixture();
    try {
      const bytes = readFileSync(zipPath);
      expect(isZipBuffer(bytes)).toBe(true);
      expect(isZipFile(zipPath)).toBe(true);
      expect(isZipBuffer(Buffer.from('name,year\nElon,2024\n', 'utf-8'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('extracts the inner CSV from zip bytes', () => {
    const { dir, zipPath } = makeFixture();
    try {
      const bytes = readFileSync(zipPath);
      const { name, text } = unzipCsvToText(bytes, 200 * 1024 * 1024, 'test zip');
      expect(name).toBe('all_billionaires_1997_2024.csv');
      expect(text).toContain('name,year,net_worth_b');
      expect(text).toContain('Elon Musk,2024,195');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('extracts the inner CSV from a zip file to disk', () => {
    const { dir, zipPath } = makeFixture();
    try {
      const { name, csvPath } = unzipCsvToFile(zipPath, dir);
      expect(name).toBe('all_billionaires_1997_2024.csv');
      expect(readFileSync(csvPath, 'utf-8')).toContain('Jeff Bezos,2024,194');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws a clear error when a zip has no CSV', () => {
    const { dir } = makeFixture();
    try {
      const bad = buildStoredZip([{ name: 'image.png', data: 'not really a png' }]);
      expect(() => unzipCsvToText(bad, 1024 * 1024, 'bad zip')).toThrow(/no CSV/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
