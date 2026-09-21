/**
 * Small shared HTTP helpers for the direct-download data sources.
 *
 * Every source module in this folder talks to a public endpoint that needs no
 * API key and no browser. Keeping them dependency-free means the research agent
 * can run them inside GitHub Actions without extra setup.
 */

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** Non-browser UA: Kaggle serves an HTML reCAPTCHA page (HTTP 200) to browsers. */
export const TOOL_UA = 'curl/8.9.1';

export interface FetchOptions extends RequestInit {
  /** User-Agent to send. Defaults to BROWSER_UA. */
  ua?: string;
  /** Retry attempts for transient failures. Defaults to 3. */
  tries?: number;
  /** Per-request timeout in ms. Defaults to 45000. */
  timeoutMs?: number;
}

export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const { ua = BROWSER_UA, tries = 3, timeoutMs = 45_000, ...init } = options;
  let lastError: unknown;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: { 'user-agent': ua, ...(init.headers as Record<string, string> | undefined) },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < tries) await new Promise((done) => setTimeout(done, 400 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const text = await fetchText(url, { ...options, headers: { accept: 'application/json', ...(options.headers as Record<string, string> | undefined) } });
  return JSON.parse(text) as T;
}

export async function head(url: string, options: FetchOptions = {}): Promise<{ status: number; headers: Record<string, string> }> {
  const { ua = BROWSER_UA, timeoutMs = 30_000, ...init } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, method: 'HEAD', signal: controller.signal, headers: { 'user-agent': ua } });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
    return { status: response.status, headers };
  } finally {
    clearTimeout(timer);
  }
}

/** RFC-4180 CSV / TSV field splitter (handles quoted fields and doubled quotes). */
export function splitDelimitedLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i += 1; } else { quoted = false; }
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) { out.push(field); field = ''; }
    else if (ch !== '\r') field += ch;
  }
  out.push(field);
  return out;
}

export interface Table {
  columns: string[];
  rows: string[][];
  delimiter: string;
}

/** Parse a CSV or TSV document into a header plus untyped rows. */
export function parseDelimited(text: string, delimiter?: string): Table {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) return { columns: [], rows: [], delimiter: ',' };
  const delim = delimiter ?? (lines[0].includes('\t') ? '\t' : ',');
  const columns = splitDelimitedLine(lines[0], delim).map((h) => h.trim());
  const rows = lines.slice(1).map((line) => splitDelimitedLine(line, delim));
  return { columns, rows, delimiter: delim };
}

/** Pick the first column whose lowercased header contains any of the hints. */
export function findColumn(columns: string[], hints: string[]): number {
  const lower = columns.map((c) => c.trim().toLowerCase());
  for (const hint of hints) {
    const exact = lower.findIndex((c) => c === hint);
    if (exact >= 0) return exact;
  }
  for (const hint of hints) {
    const partial = lower.findIndex((c) => c.includes(hint));
    if (partial >= 0) return partial;
  }
  return -1;
}

/** Parse a number that may carry thousands separators or a percent sign. */
export function numeric(raw: string | undefined): number {
  if (raw === undefined) return Number.NaN;
  const cleaned = raw.trim().replace(/[",\s]/g, '').replace(/%$/, '');
  if (cleaned === '' || cleaned === '-') return Number.NaN;
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : Number.NaN;
}

/** True when the body looks like a delimited table rather than prose. */
export function looksLikeTable(text: string): boolean {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  if (lines.length < 3) return false;
  const delim = lines[0].includes('\t') ? '\t' : ',';
  return lines[0].split(delim).length >= 3;
}

/** Extract every image URL we can find in a raw HTML document. */
export function extractImageUrls(html: string): string[] {
  const found = new Set<string>();
  const add = (value: string | undefined): void => {
    if (!value) return;
    const decoded = value.replace(/&amp;/g, '&').trim();
    if (decoded.startsWith('data:')) return;
    if (/\.(png|jpe?g|webp|svg|gif|avif)(\?|$)/i.test(decoded) || decoded.includes('/_next/image') || decoded.includes('/image')) {
      found.add(decoded);
    }
  };
  for (const match of html.matchAll(/<img[^>]+?src=["']([^"']+)["']/gi)) add(match[1]);
  for (const match of html.matchAll(/<img[^>]+?srcset=["']([^"']+)["']/gi)) {
    for (const part of match[1].split(',')) add(part.trim().split(/\s+/)[0]);
  }
  for (const match of html.matchAll(/<source[^>]+?srcset=["']([^"']+)["']/gi)) {
    for (const part of match[1].split(',')) add(part.trim().split(/\s+/)[0]);
  }
  for (const match of html.matchAll(/(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*?content=["']([^"']+)["']/gi)) add(match[1]);
  for (const match of html.matchAll(/(?:content)=["']([^"']+)["'][^>]*?(?:property|name)=["'](?:og:image|twitter:image)["']/gi)) add(match[1]);
  for (const match of html.matchAll(/(?:https?:)?\/\/[^"'\s)]+?\/_next\/image\?url=([^"'&\s)]+)/gi)) add(decodeURIComponent(match[1]));
  return Array.from(found);
}

/** Turn an absolute image URL into an embeddable data URL. */
export function toDataUrl(bytes: Buffer | string, mime: string): string {
  const buffer = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
  return `data:${mime};base64,${buffer.toString('base64')}`;
}