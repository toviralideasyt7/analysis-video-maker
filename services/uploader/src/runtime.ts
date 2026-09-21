/** Minimal env access for the uploader (walks up to the repo .env). */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

let loaded = false;

export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  let dir = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      for (const raw of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = value;
      }
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

export function env(key: string, fallback = ''): string {
  loadEnv();
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
}

export function port(): number {
  return Number(env('PORT_UPLOADER', env('PORT', '8790')));
}

export function maxUploadBytes(): number {
  return Number(env('MAX_UPLOAD_BYTES', '20000000'));
}

export function uploadsDir(): string {
  return resolve(env('UPLOADS_DIR', './uploads'));
}

export const UPLOAD_LIMITS = { maxUploadBytes };
// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): Level {
  const raw = env('LOG_LEVEL', 'info').toLowerCase();
  return (['debug', 'info', 'warn', 'error'] as Level[]).includes(raw as Level) ? (raw as Level) : 'info';
}

function write(level: Level, message: string, extra?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return;
  const stamp = new Date().toISOString();
  const tail = extra ? ` ${JSON.stringify(extra)}` : '';
  process.stderr.write(`${stamp} [${level}] ${message}${tail}\n`);
}

export const logger = {
  debug: (m: string, e?: Record<string, unknown>) => write('debug', m, e),
  info: (m: string, e?: Record<string, unknown>) => write('info', m, e),
  warn: (m: string, e?: Record<string, unknown>) => write('warn', m, e),
  error: (m: string, e?: Record<string, unknown>) => write('error', m, e),
};