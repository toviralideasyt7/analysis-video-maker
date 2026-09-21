/**
 * GitHub side of the upload flow.
 *
 * The browser never talks to GitHub. The uploader validates the file, commits
 * it to the repository under `inputs/` and dispatches the render workflow.
 */

import { createHash } from 'node:crypto';
import { env } from './runtime';

export interface CommitResult {
  ok: boolean;
  path: string;
  commitSha?: string;
  error?: string;
}

export interface DispatchResult {
  ok: boolean;
  runUrl?: string;
  error?: string;
}

function token(): string {
  const value = env('GITHUB_TOKEN');
  if (!value) throw new Error('GITHUB_TOKEN is not configured on the uploader');
  return value;
}

function repoInfo(): { owner: string; repo: string } {
  const owner = env('GITHUB_OWNER');
  const repo = env('GITHUB_REPO');
  if (!owner || !repo) throw new Error('GITHUB_OWNER / GITHUB_REPO are not configured on the uploader');
  return { owner, repo };
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${token()}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    ...extra,
  };
}

/** Commit the user file so the render workflow can check it out. */
export async function commitInputFile(fileName: string, content: string): Promise<CommitResult> {
  const { owner, repo } = repoInfo();
  const safeName = fileName.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'video-input.json';
  const path = `inputs/${safeName}`;
  const body = {
    message: `Add video input ${safeName} (upload)`,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: env('GITHUB_BRANCH', 'main'),
  };
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    return { ok: false, path, error: `GitHub contents API returned ${response.status}: ${text.slice(0, 300)}` };
  }
  const parsed = JSON.parse(text) as { content?: { sha?: string } };
  return { ok: true, path, commitSha: parsed.content?.sha };
}

/** Dispatch the render workflow for a committed input file. */
export async function dispatchRender(inputPath: string): Promise<DispatchResult> {
  const { owner, repo } = repoInfo();
  const workflow = env('GITHUB_WORKFLOW_FILE', 'make-video.yml');
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      ref: env('GITHUB_BRANCH', 'main'),
      inputs: { inputPath },
    }),
  });
  if (response.status === 204) {
    return { ok: true, runUrl: `https://github.com/${owner}/${repo}/actions/workflows/${workflow}` };
  }
  const text = await response.text();
  return { ok: false, error: `workflow dispatch returned ${response.status}: ${text.slice(0, 300)}` };
}

/** Stable id for the uploaded file, used in the artifact name. */
export function inputId(fileName: string, content: string): string {
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 8);
  const stem = fileName.replace(/\.[A-Za-z0-9]+$/, '').replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40) || 'video';
  return `${stem}-${hash}`;
}