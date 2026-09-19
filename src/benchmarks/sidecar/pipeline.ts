import axios from 'axios';

export interface PipelineResult {
  pipelineId: string;
  durationMs: number;
  status: 'success' | 'failed' | 'error' | 'canceled';
}

type WorkflowStatus = 'success' | 'failed' | 'error' | 'canceled' | 'running' | 'on_hold' | 'failing' | 'unauthorized';

interface CIPipeline {
  id: string;
  vcs: { revision: string };
  created_at: string;
}

interface CIWorkflow {
  id: string;
  status: WorkflowStatus;
  created_at: string;
  stopped_at: string | null;
}

function isTerminal(status: WorkflowStatus): boolean {
  return ['success', 'failed', 'error', 'canceled'].includes(status);
}

// Pipelines that ran longer than this are stuck/timed-out and excluded from results.
const MAX_CI_DURATION_MS = 30 * 60_000; // 30 min

// Find recent pipelines on the given branch that have a terminal CI result.
export async function fetchRecentPipelines(
  repo: string,
  branch: string,
  token: string,
  limit = 200
): Promise<CIPipeline[]> {
  const [org, repoName] = repo.split('/');
  const results: CIPipeline[] = [];
  let pageToken: string | undefined;

  while (results.length < limit) {
    const res = await axios.get<{ items: CIPipeline[]; next_page_token?: string }>(
      `https://circleci.com/api/v2/project/github/${org}/${repoName}/pipeline`,
      { headers: { 'Circle-Token': token }, params: { branch, ...(pageToken ? { 'page-token': pageToken } : {}) } }
    );
    results.push(...res.data.items);
    if (!res.data.next_page_token || results.length >= limit) break;
    pageToken = res.data.next_page_token;
  }

  return results.slice(0, limit);
}

// Get the historical duration and status for a pipeline that has already run.
export async function getHistoricalResult(pipelineId: string, token: string): Promise<PipelineResult | null> {
  const res = await axios.get<{ items: CIWorkflow[] }>(
    `https://circleci.com/api/v2/pipeline/${pipelineId}/workflow`,
    { headers: { 'Circle-Token': token } }
  );
  const workflows = res.data.items;
  if (workflows.length === 0 || !workflows.every((w) => isTerminal(w.status))) return null;

  const overallStatus: PipelineResult['status'] = workflows.some((w) => w.status === 'failed')
    ? 'failed'
    : workflows.some((w) => w.status === 'error')
    ? 'error'
    : workflows.some((w) => w.status === 'canceled')
    ? 'canceled'
    : 'success';

  // Duration = latest stopped_at - earliest created_at across all workflows
  const starts = workflows.map((w) => new Date(w.created_at).getTime());
  const ends = workflows.map((w) => (w.stopped_at ? new Date(w.stopped_at).getTime() : null)).filter(Boolean) as number[];
  if (ends.length === 0) return null;

  const durationMs = Math.max(...ends) - Math.min(...starts);
  if (durationMs > MAX_CI_DURATION_MS) return null; // exclude stuck/timed-out pipelines
  return { pipelineId, durationMs, status: overallStatus };
}
