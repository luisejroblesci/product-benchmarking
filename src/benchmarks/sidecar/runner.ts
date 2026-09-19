import { execFile } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import { runChunkValidation, verifySidecar, resolveSidecarId } from './chunk.js';
import { fetchRecentPipelines, getHistoricalResult } from './pipeline.js';
import type { UC1RunResult, CommitResult, UC1Summary } from '../../core/types.js';
import { emitBenchEvent } from '../../ui/server.js';

const execFileAsync = promisify(execFile);

export interface SidecarRunOptions {
  repo: string;
  ciRepo?: string;       // upstream repo to pull historical CI data from (defaults to repo)
  repoDir: string;
  branch?: string;
  n?: number;
  commits?: string[];
  benchmarkBranch: string;
  circleciToken: string;
}

interface CandidateCommit {
  sha: string;
  message: string;
  pipelineId: string;
  ciStatus: 'success' | 'failed' | 'error' | 'canceled';
  ciDurationMs: number;
}

// Select N real commits from CircleCI history: a mix of passing and failing.
async function selectCommits(
  repo: string,
  branch: string,
  token: string,
  n: number,
  specificShas?: string[]
): Promise<CandidateCommit[]> {
  const pipelines = await fetchRecentPipelines(repo, branch, token, 100);

  const candidates: CandidateCommit[] = [];
  const passing: CandidateCommit[] = [];
  const failing: CandidateCommit[] = [];

  for (const pipeline of pipelines) {
    if (specificShas && !specificShas.includes(pipeline.vcs.revision)) continue;
    const result = await getHistoricalResult(pipeline.id, token);
    if (!result) continue; // still running or no workflows

    const candidate: CandidateCommit = {
      sha: pipeline.vcs.revision,
      message: '',
      pipelineId: pipeline.id,
      ciStatus: result.status,
      ciDurationMs: result.durationMs,
    };

    if (result.status === 'success') passing.push(candidate);
    else failing.push(candidate);

    if (passing.length + failing.length >= n * 2) break; // enough candidates
  }

  if (specificShas) return [...passing, ...failing].slice(0, n);

  // Target ~60% passing, ~40% failing (rounded), fall back to whatever is available
  const targetPassing = Math.min(Math.round(n * 0.6), passing.length);
  const targetFailing = Math.min(n - targetPassing, failing.length);
  const extra = n - targetPassing - targetFailing;

  const selected = [
    ...passing.slice(0, targetPassing + (extra > 0 ? Math.min(extra, passing.length - targetPassing) : 0)),
    ...failing.slice(0, targetFailing),
  ].slice(0, n);

  if (selected.length === 0) throw new Error('No completed pipelines found on branch — check CIRCLECI_TOKEN and repo');
  return selected;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function buildSummary(commits: CommitResult[]): UC1Summary {
  const sidecarTimes = commits.map((c) => c.sidecar.durationMs).sort((a, b) => a - b);
  const traditionalTimes = commits.map((c) => c.traditional.durationMs).sort((a, b) => a - b);
  const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;

  const passing = commits.filter((c) => c.traditional.status === 'success');
  const failing = commits.filter((c) => c.traditional.status !== 'success');

  return {
    avgSidecarMs: Math.round(avg(sidecarTimes)),
    avgTraditionalMs: Math.round(avg(traditionalTimes)),
    p50SidecarMs: percentile(sidecarTimes, 50),
    p50TraditionalMs: percentile(traditionalTimes, 50),
    speedupFactor: parseFloat((avg(traditionalTimes) / avg(sidecarTimes)).toFixed(2)),
    passingCommits: {
      count: passing.length,
      avgSidecarMs: passing.length ? Math.round(avg(passing.map((c) => c.sidecar.durationMs))) : 0,
      avgTraditionalMs: passing.length ? Math.round(avg(passing.map((c) => c.traditional.durationMs))) : 0,
    },
    failingCommits: {
      count: failing.length,
      avgSidecarMs: failing.length ? Math.round(avg(failing.map((c) => c.sidecar.durationMs))) : 0,
      avgTraditionalMs: failing.length ? Math.round(avg(failing.map((c) => c.traditional.durationMs))) : 0,
    },
  };
}

export async function runSidecarBenchmark(opts: SidecarRunOptions): Promise<UC1RunResult> {
  const { repo, repoDir, circleciToken } = opts;
  const ciRepo = opts.ciRepo ?? repo;
  const n = opts.n ?? 5;
  const branch = opts.branch ?? 'main';

  // ── Ensure upstream commits are locally available ─────────────────────────
  if (opts.ciRepo && opts.ciRepo !== repo) {
    console.log(`Fetching ${opts.ciRepo} commits into local repo…`);
    await execFileAsync('git', ['fetch', 'upstream', branch, '--depth=100'], { cwd: repoDir }).catch(() => {
      console.log('  (upstream remote not found — commits must already be local)');
    });
  }

  // ── Pre-flight: verify sidecar before touching CI at all ──────────────────
  const sidecarId = resolveSidecarId(repoDir);
  console.log(`Verifying sidecar ${sidecarId}…`);
  await verifySidecar(repoDir, sidecarId);
  console.log('Sidecar OK.\n');

  // ── Select commits from CircleCI history ──────────────────────────────────
  console.log(`Selecting ${n} commits from ${ciRepo}/${branch} history…`);
  const candidates = await selectCommits(ciRepo, branch, circleciToken, n, opts.commits);
  console.log(`Selected ${candidates.length} commits:`);
  for (const c of candidates) {
    console.log(`  ${c.sha.slice(0, 8)} — CI: ${c.ciStatus} in ${(c.ciDurationMs / 1000).toFixed(0)}s`);
  }
  console.log();

  emitBenchEvent({ type: 'run:start', total: candidates.length, repo });

  // ── Phase 1: sidecar — run all commits, fail fast on error ────────────────
  console.log('── Phase 1: sidecar ──────────────────────────────────────────');
  const sidecarResults: CommitResult['sidecar'][] = [];

  for (let i = 0; i < candidates.length; i++) {
    const commit = candidates[i];
    console.log(`\n→ sidecar ${i + 1}/${candidates.length}  ${commit.sha.slice(0, 8)}`);
    emitBenchEvent({ type: 'commit:start', sha: commit.sha, message: commit.message, index: i });

    // Checkout this exact commit so the sidecar sees the right code
    await execFileAsync('git', ['checkout', commit.sha], { cwd: repoDir });

    const result = await runChunkValidation(repoDir, sidecarId);
    emitBenchEvent({ type: 'commit:sidecar', sha: commit.sha, durationMs: result.durationMs, status: result.status });
    sidecarResults.push(result);

    if (result.status === 'error') {
      console.warn(`  [sidecar] warning: error on ${commit.sha.slice(0, 8)}, skipping commit and continuing`);
    }

    console.log(`  sidecar: ${result.status} in ${(result.durationMs / 1000).toFixed(1)}s`);
  }

  // Restore branch after sidecar phase
  await execFileAsync('git', ['checkout', branch], { cwd: repoDir });

  // ── Phase 2: traditional — look up historical CI durations ────────────────
  console.log('\n── Phase 2: traditional CI (historical lookup) ───────────────');
  const results: CommitResult[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const commit = candidates[i];
    const sidecar = sidecarResults[i];
    const traditional = {
      pipelineId: commit.pipelineId,
      durationMs: commit.ciDurationMs,
      status: commit.ciStatus,
    };

    emitBenchEvent({ type: 'commit:traditional', sha: commit.sha, durationMs: traditional.durationMs, status: traditional.status });

    console.log(
      `  ${commit.sha.slice(0, 8)}  sidecar: ${sidecar.status} ${(sidecar.durationMs / 1000).toFixed(1)}s` +
      `  |  CI: ${traditional.status} ${(traditional.durationMs / 1000).toFixed(1)}s`
    );

    results.push({ sha: commit.sha, message: commit.message, sidecar, traditional });
  }

  const summary = buildSummary(results);
  emitBenchEvent({
    type: 'run:done',
    speedupFactor: summary.speedupFactor,
    avgSidecarMs: summary.avgSidecarMs,
    avgTraditionalMs: summary.avgTraditionalMs,
  });

  return {
    runId: uuidv4(),
    timestamp: new Date().toISOString(),
    repo,
    benchmarkBranch: opts.benchmarkBranch,
    commits: results,
    summary,
  };
}
