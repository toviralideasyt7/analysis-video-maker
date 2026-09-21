#!/usr/bin/env tsx
/**
 * Upload a rendered MP4 to gofile.io and print the public page URL.
 *
 *   npx tsx tools/upload-gofile.mts <file> [--json out.json]
 *
 * gofile has no API key requirement for this flow, so it works from GitHub
 * Actions without any account:
 *   1. GET  https://api.gofile.io/servers          -> pick a server
 *   2. POST https://api.gofile.io/accounts         -> guest token
 *   3. POST https://<server>.gofile.io/contents/uploadfile (multipart) -> page URL
 *
 * The caller (the render workflow) is responsible for passing the resulting
 * downloadPage back to the control plane.
 */

import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: tsx tools/upload-gofile.mts <file> [--json out.json]\n');
  process.exit(2);
}
const path = resolve(file);
statSync(path);

async function pickServer(): Promise<string> {
  const response = await fetch('https://api.gofile.io/servers');
  if (!response.ok) throw new Error(`servers returned ${response.status}`);
  const body = (await response.json()) as { data?: { servers?: Array<{ name?: string }> } };
  const name = body.data?.servers?.[0]?.name;
  if (!name) throw new Error('no gofile server available');
  return name;
}

async function guestToken(): Promise<string> {
  const response = await fetch('https://api.gofile.io/accounts', { method: 'POST' });
  if (!response.ok) throw new Error(`accounts returned ${response.status}`);
  const body = (await response.json()) as { data?: { token?: string } };
  if (!body.data?.token) throw new Error('no gofile guest token');
  return body.data.token;
}

/** Send the bytes in one bounded stream so a large MP4 never sits in memory twice. */
async function upload(server: string, token: string, body: FormData): Promise<{ downloadPage: string; fileId: string; name: string }> {
  const response = await fetch(`https://${server}.gofile.io/contents/uploadfile`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`upload returned ${response.status}: ${text.slice(0, 300)}`);
  const parsed = JSON.parse(text) as { status?: string; data?: { downloadPage?: string; fileId?: string; fileName?: string } };
  if (parsed.status !== 'ok' || !parsed.data?.downloadPage) {
    throw new Error(`upload rejected: ${text.slice(0, 300)}`);
  }
  return { downloadPage: parsed.data.downloadPage, fileId: parsed.data.fileId ?? '', name: parsed.data.fileName ?? basename(path) };
}

async function main(): Promise<void> {
  const bytes = readFileSync(path);
  const [server, token] = await Promise.all([pickServer(), guestToken()]);
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)]), basename(path));
  const result = await upload(server, token, form);
  const jsonAt = process.argv.indexOf('--json');
  if (jsonAt >= 0 && process.argv[jsonAt + 1]) {
    writeFileSync(process.argv[jsonAt + 1], JSON.stringify(result, null, 2), 'utf8');
  }
  process.stdout.write(`gofile: ${result.downloadPage}\n`);
}

main().catch((error) => {
  process.stderr.write(`gofile upload failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});