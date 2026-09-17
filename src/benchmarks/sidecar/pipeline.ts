import { execFile } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';

const execFileAsync = promisify(execFile);

export interface PipelineResult {
  pipelineId: string;
  durationMs: number;
  status: 'success' | 'failed' | 'error' | 'canceled';
}

const POLL_INTERVAL_MS = 5_000;
const TIMEOUT_MS = 30 * 60_000; // 30 min max

type WorkflowStatus = 'success' | 'failed' | 'error' | 'canceled' | 'running' | 'on_hold' | 'failing' | 'unauthorized';

async function getPipelineWorkflows(pipelineId: string, token: string) {
  const res = await axios.get<{ items: Array<{ id: string; status: WorkflowStatus; stopped_at: string | null }> }>(
    `https://circleci.com/api/v2/pipeline/${pipelineId}/workflow`,
    { headers: { 'Circle-Token': token } }
  );
  return res.data.items;
}

function isTerminal(status: WorkflowStatus): boolean {
  return ['success', 'failed', 'error', 'canceled'].includes(status);
}

export async function pushAndMeasure(
  repoDir: string,
  sha: string,
  benchmarkBranch: string,
  repo: string,
  token: string
): Promise<PipelineResult> {
  const start = Date.now();

  // Force-push this commit to the benchmark branch
  try {
    await execFileAsync('git', ['push', 'origin', `${sha}:refs/heads/${benchmarkBranch}`, '--force'], {
      cwd: repoDir,
    });
  } catch (err) {
    return { pipelineId: '', durationMs: Date.now() - start, status: 'error' };
  }

  // Give CircleCI a moment to register the push before polling
  await new Promise((r) => setTimeout(r, 3_000));

  // Find the pipeline triggered by this push
  let pipelineId = '';
  const [org, repoName] = repo.split('/');
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await axios.get<{ items: Array<{ id: string; vcs: { revision: string }; created_at: string }> }>(
      `https://circleci.com/api/v2/project/github/${org}/${repoName}/pipeline`,
      {
        headers: { 'Circle-Token': token },
        params: { branch: benchmarkBranch },
      }
    );
    const match = res.data.items.find((p) => p.vcs.revision === sha);
    if (match) {
      pipelineId = match.id;
      break;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }

  if (!pipelineId) {
    return { pipelineId: '', durationMs: Date.now() - start, status: 'error' };
  }

  // Poll until all workflows reach a terminal state
  const deadline = start + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const workflows = await getPipelineWorkflows(pipelineId, token);
    if (workflows.length > 0 && workflows.every((w) => isTerminal(w.status))) {
      const overallStatus = workflows.some((w) => w.status === 'failed')
        ? 'failed'
        : workflows.some((w) => w.status === 'error')
        ? 'error'
        : workflows.some((w) => w.status === 'canceled')
        ? 'canceled'
        : 'success';
      return { pipelineId, durationMs: Date.now() - start, status: overallStatus };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  return { pipelineId, durationMs: Date.now() - start, status: 'error' };
}
