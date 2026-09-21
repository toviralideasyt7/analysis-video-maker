/**
 * GitHub Actions dispatch.
 *
 * The render layer is GitHub Actions (Remotion + ffmpeg). The backend never
 * renders. Only an APPROVED project may be dispatched, and the token is read
 * from the environment - it is never written to a project artifact.
 */

import { env, logger, redact } from './runtime';
import type { RenderJob } from '@avm/shared';

export interface DispatchInput {
  owner?: string;
  repo?: string;
  workflowFile?: string;
  ref?: string;
  projectId: string;
  videoSpecVersion: number;
  datasetVersion: number;
  artifactBaseUrl?: string;
}

export interface DispatchResult {
  ok: boolean;
  status: number;
  message: string;
  workflowRunUrl?: string;
  runId?: number | null;
}

/**
 * Trigger `workflow_dispatch` for the render workflow.
 *
 * The workflow downloads the approved project bundle (plan/dataset/frames/
 * video-spec) and renders it, so nothing sensitive rides in the dispatch body.
 */
export async function dispatchRender(input: DispatchInput): Promise<DispatchResult> {
  const owner = input.owner ?? env('GITHUB_OWNER');
  const repo = input.repo ?? env('GITHUB_REPO');
  const workflow = input.workflowFile ?? env('GITHUB_WORKFLOW_FILE', 'render-video.yml');
  const token = env('GITHUB_TOKEN');
  const ref = input.ref ?? env('GITHUB_REF', 'main');

  if (!owner || !repo) return { ok: false, status: 0, message: 'GITHUB_OWNER / GITHUB_REPO are not configured' };
  if (!token) return { ok: false, status: 0, message: 'GITHUB_TOKEN is not configured' };

  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref,
        inputs: {
          projectId: input.projectId,
          videoSpecVersion: String(input.videoSpecVersion),
          datasetVersion: String(input.datasetVersion),
          artifactBaseUrl: input.artifactBaseUrl ?? '',
        },
      }),
    });
    const text = await response.text();
    logger.info('github dispatch', { owner, repo, workflow, status: response.status });
    if (response.status === 204) {
      const runId = await latestRunId(owner, repo, workflow, token).catch(() => null);
      return {
        ok: true,
        status: response.status,
        message: 'workflow dispatched',
        runId,
        workflowRunUrl: runId ? `https://github.com/${owner}/${repo}/actions/runs/${runId}` : undefined,
      };
    }
    return { ok: false, status: response.status, message: redact(text).slice(0, 400) };
  } catch (error) {
    return { ok: false, status: 0, message: error instanceof Error ? error.message : String(error) };
  }
}

async function latestRunId(owner: string, repo: string, workflow: string, token: string): Promise<number | null> {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/runs?per_page=1`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { workflow_runs?: Array<{ id?: number }> };
  return body.workflow_runs?.[0]?.id ?? null;
}

export function newRenderJob(input: {
  projectId: string;
  videoSpecVersion: number;
  datasetVersion: number;
  commit?: string;
}): RenderJob {
  return {
    renderJobId: `render_${Date.now()}`,
    projectId: input.projectId,
    commit: input.commit,
    videoSpecVersion: input.videoSpecVersion,
    datasetVersion: input.datasetVersion,
    status: 'queued',
    createdAt: new Date().toISOString(),
    githubRunId: null,
    artifactUrl: null,
  };
}