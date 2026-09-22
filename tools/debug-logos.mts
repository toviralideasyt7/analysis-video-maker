import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const domains = process.argv.slice(2);
const dir = resolve('.openclaw/tmp/logo-probe');
mkdirSync(dir, { recursive: true });

for (const domain of domains) {
  const clean = domain.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  const sources = [
    `https://www.google.com/s2/favicons?domain=${clean}&sz=256`,
    `https://${clean}/apple-touch-icon.png`,
    `https://${clean}/favicon.ico`,
  ];
  let ok = '';
  for (const url of sources) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength < 300) continue;
      writeFileSync(resolve(dir, `${clean.replace(/[^a-z0-9.]/gi, '_')}.png`), buffer);
      ok = `${url} (${buffer.byteLength} bytes)`;
      break;
    } catch { /* next */ }
  }
  console.log(`  ${clean.padEnd(22)} ${ok || 'NONE'}`);
}