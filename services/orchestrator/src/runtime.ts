/**
 * Runtime utilities: env loading, redaction, logging, disk cache and the bridge
 * to the Rust `datarace` core.
 *
 * Nothing in this module ever writes a secret to a log, a cache file or a
 * project artifact.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

let envLoaded = false;

/** Minimal `.env` loader (walks up from cwd). No dependency, no secrets logged. */
export function loadEnv(): void {
  if (envLoaded) return;
  envLoaded = true;
  let dir = process.cwd();
  for (let depth = 0; depth < 4; depth += 1) {
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
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

export function envList(key: string, fallback: string[] = []): string[] {
  const raw = env(key);
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface Limits {
  maxSearches: number;
  maxSources: number;
  maxAgentRounds: number;
  maxTokens: number;
  maxRenderAttempts: number;
}

export function limits(): Limits {
  return {
    maxSearches: Number(env('MAX_SEARCHES', '60')),
    maxSources: Number(env('MAX_SOURCES', '40')),
    maxAgentRounds: Number(env('MAX_AGENT_ROUNDS', '12')),
    maxTokens: Number(env('MAX_TOKENS', '400000')),
    maxRenderAttempts: Number(env('MAX_RENDER_ATTEMPTS', '2')),
  };
}

export function projectsDir(): string {
  return resolve(env('PROJECTS_DIR', './projects'));
}

export function cacheDir(): string {
  return resolve(env('RENDER_CACHE_DIR', './.cache'));
}

// ---------------------------------------------------------------------------
// Redaction + logging
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9_\-]{12,}/g,
  /monid_live_[A-Za-z0-9]{8,}/g,
  /KGAT_[A-Za-z0-9]{8,}/g,
  /cfk_[A-Za-z0-9]{8,}/g,
  /rnd_[A-Za-z0-9]{8,}/g,
  /\b[A-Fa-f0-9]{32}\b/g,
  /"key"\s*:\s*"[^"]+"/g,
  /Bearer\s+[A-Za-z0-9._\-]{8,}/g,
];

/** Remove anything that looks like a credential before it is logged. */
export function redact(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (m) => (m.startsWith('"key"') ? '"key":"[redacted]"' : '[redacted]'));
  }
  return out;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): Level {
  const raw = env('LOG_LEVEL', 'info').toLowerCase();
  return (['debug', 'info', 'warn', 'error'] as Level[]).includes(raw as Level) ? (raw as Level) : 'info';
}

export function log(level: Level, message: string, extra?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return;
  const stamp = new Date().toISOString();
  const tail = extra ? ` ${redact(JSON.stringify(extra))}` : '';
  process.stderr.write(`${stamp} [${level}] ${redact(message)}${tail}\n`);
}

export const logger = {
  debug: (m: string, e?: Record<string, unknown>) => log('debug', m, e),
  info: (m: string, e?: Record<string, unknown>) => log('info', m, e),
  warn: (m: string, e?: Record<string, unknown>) => log('warn', m, e),
  error: (m: string, e?: Record<string, unknown>) => log('error', m, e),
};

// ---------------------------------------------------------------------------
// Disk cache
// ---------------------------------------------------------------------------

export function sha256(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex');
}

export class DiskCache {
  private readonly dir: string;

  constructor(namespace: string, root?: string) {
    this.dir = join(root ?? cacheDir(), namespace);
    mkdirSync(this.dir, { recursive: true });
  }

  private pathFor(key: string): string {
    return join(this.dir, `${sha256(key)}.json`);
  }

  get<T>(key: string): T | null {
    const p = this.pathFor(key);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  set(key: string, value: unknown): void {
    writeFileSync(this.pathFor(key), JSON.stringify(value), 'utf8');
  }

  size(): number {
    try {
      return readdirSync(this.dir).length;
    } catch {
      return 0;
    }
  }
}

/** Append-only JSONL log used for agent runs and usage accounting. */
export class JsonlLog {
  private readonly file: string;

  constructor(fileName: string, root?: string) {
    const dir = root ?? cacheDir();
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, fileName);
  }

  append(record: Record<string, unknown>): void {
    try {
      appendFileSync(this.file, `${redact(JSON.stringify(record))}\n`, 'utf8');
    } catch {
      /* logging must never break a run */
    }
  }

  read(): Array<Record<string, unknown>> {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return {};
        }
      });
  }

  path(): string {
    return this.file;
  }
}

// ---------------------------------------------------------------------------
// Rust bridge
// ---------------------------------------------------------------------------

export interface RustResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  json: unknown | null;
}

function candidateBinaries(): string[] {
  const list: string[] = [];
  const fromEnv = env('DATARACE_BIN');
  if (fromEnv) list.push(fromEnv);
  // Walk up from cwd looking for a built binary.
  let dir = process.cwd();
  for (let depth = 0; depth < 4; depth += 1) {
    list.push(join(dir, 'target', 'release', process.platform === 'win32' ? 'datarace.exe' : 'datarace'));
    list.push(join(dir, 'target', 'debug', process.platform === 'win32' ? 'datarace.exe' : 'datarace'));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  list.push(process.platform === 'win32' ? 'datarace.exe' : 'datarace');
  return list;
}

let resolvedBin: string | null | undefined;

/** Locate the compiled `datarace` binary, or null when unavailable. */
export function findRustBinary(): string | null {
  if (resolvedBin !== undefined) return resolvedBin;
  for (const candidate of candidateBinaries()) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (existsSync(candidate)) {
        resolvedBin = candidate;
        return resolvedBin;
      }
    } else {
      resolvedBin = candidate; // bare name -> let the OS resolve it
      return resolvedBin;
    }
  }
  resolvedBin = null;
  return null;
}

export function rustAvailable(): boolean {
  return findRustBinary() !== null;
}

/** Invoke the Rust core. Rejects when the process cannot be started. */
export function runRust(args: string[], options: { timeoutMs?: number } = {}): Promise<RustResult> {
  const bin = findRustBinary();
  if (!bin) {
    return Promise.reject(new Error('datarace binary not found; build it with `cargo build --release` or set DATARACE_BIN'));
  }
  return new Promise<RustResult>((resolvePromise, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          child.kill();
        }, options.timeoutMs)
      : null;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (timeout) clearTimeout(timeout);
      reject(err);
    });
    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout);
      let json: unknown | null = null;
      const trimmed = stdout.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          json = JSON.parse(trimmed);
        } catch {
          json = null;
        }
      }
      resolvePromise({ ok: code === 0, exitCode: code, stdout, stderr, json });
    });
  });
}

/** Convenience: run a subcommand that returns JSON, throwing on failure. */
export async function runRustJson<T>(args: string[], options?: { timeoutMs?: number }): Promise<T> {
  const result = await runRust(args, options);
  if (!result.ok || result.json === null) {
    throw new Error(`datarace ${args[0]} failed (exit ${result.exitCode}): ${redact(result.stderr || result.stdout).slice(0, 400)}`);
  }
  return result.json as T;
}