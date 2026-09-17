import { execFile } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import { runChunkValidation } from './chunk.js';
import { pushAndMeasure } from './pipeline.js';
import type { UC1RunResult, CommitResult, UC1Summary } from '../../core/types.js';
import { emitBenchEvent } from '../../ui/server.js';

const execFileAsync = promisify(execFile);

export interface SidecarRunOptions {
  repo: string;
  repoDir: string;
  branch?: string;
  n?: number;
  commits?: string[];
  benchmarkBranch: string;
  circleciToken: string;
}

async function touchesGoFiles(repoDir: string, sha: string): Promise<boolean> {
  const { stdout } = await execFileAsync(
    'git',
    ['diff-tree', '--no-commit-id', '-r', '--name-only', sha],
    { cwd: repoDir }
  );
  return stdout.split('\n').some((f) => f.endsWith('.go'));
}

async function getCommits(repoDir: string, branch: string, n: number): Promise<Array<{ sha: string; message: string }>> {
  // Fetch more candidates than needed so we can filter for .go-touching commits
  const { stdout } = await execFileAsync(
    'git',
    ['log', `origin/${branch}`, '--format=%H|%s', `-${n * 5}`],
    { cwd: repoDir }
  );
  const all = stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, ...rest] = line.split('|');
      return { sha, message: rest.join('|') };
    });

  // Only keep commits that touch .go files — sidecar gates only fire on those
  const filtered: Array<{ sha: string; message: string }> = [];
  for (const commit of all) {
    if (filtered.length >= n) break;
    if (await touchesGoFiles(repoDir, commit.sha)) {
      filtered.push(commit);
    }
  }
  return filtered;
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
  const { repo, repoDir, benchmarkBranch, circleciToken } = opts;

  let commitList: Array<{ sha: string; message: string }>;
  if (opts.commits && opts.commits.length > 0) {
    commitList = await Promise.all(
      opts.commits.map(async (sha) => {
        const { stdout } = await execFileAsync('git', ['log', '-1', '--format=%s', sha], { cwd: repoDir });
        return { sha, message: stdout.trim() };
      })
    );
  } else {
    const branch = opts.branch ?? 'main';
    const n = opts.n ?? 5;
    commitList = await getCommits(repoDir, branch, n);
  }

  emitBenchEvent({ type: 'run:start', total: commitList.length, repo });
  console.log(`Running benchmark on ${commitList.length} commits...`);

  // Ensure we start from the tip of the branch (the chunk sync baseline).
  // We revert each commit ON TOP of HEAD so the bundle always moves forward —
  // chunk cannot sync backwards in history.
  const branch = opts.branch ?? 'main';
  await execFileAsync('git', ['checkout', branch], { cwd: repoDir });

  const results: CommitResult[] = [];
  const benchEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'bench@bench',
    GIT_COMMITTER_NAME: 'bench', GIT_COMMITTER_EMAIL: 'bench@bench',
  };

  for (const commit of commitList) {
    console.log(`\n→ ${commit.sha.slice(0, 7)} ${commit.message.slice(0, 60)}`);
    emitBenchEvent({ type: 'commit:start', sha: commit.sha, message: commit.message, index: results.length });

    // Revert this commit to produce a new forward-moving commit on top of HEAD.
    // After measuring, we revert-the-revert to restore the working branch.
    let revertFailed = false;
    try {
      await execFileAsync('git', ['revert', '--no-edit', commit.sha], { cwd: repoDir, env: benchEnv });
    } catch (err) {
      revertFailed = true;
      const reason = 'revert had conflicts';
      console.log(`  skipping — ${reason}: ${String(err).split('\n')[0]}`);
      emitBenchEvent({ type: 'commit:skip', sha: commit.sha, reason });
      await execFileAsync('git', ['revert', '--abort'], { cwd: repoDir }).catch(() => {});
    }

    if (revertFailed) continue;

    const appliedSha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim();

    // Launch both paths in parallel
    const [sidecarResult, pipelineResult] = await Promise.all([
      runChunkValidation(repoDir).then((r) => {
        emitBenchEvent({ type: 'commit:sidecar', sha: commit.sha, durationMs: r.durationMs, status: r.status });
        return r;
      }),
      pushAndMeasure(repoDir, appliedSha, benchmarkBranch, repo, circleciToken).then((r) => {
        emitBenchEvent({ type: 'commit:traditional', sha: commit.sha, durationMs: r.durationMs, status: r.status });
        return r;
      }),
    ]);

    console.log(
      `  sidecar: ${sidecarResult.status} in ${(sidecarResult.durationMs / 1000).toFixed(1)}s  |  ` +
      `traditional: ${pipelineResult.status} in ${(pipelineResult.durationMs / 1000).toFixed(1)}s`
    );

    results.push({
      sha: commit.sha,
      message: commit.message,
      sidecar: sidecarResult,
      traditional: pipelineResult,
    });

    // Revert-the-revert to restore the branch for the next iteration
    await execFileAsync('git', ['revert', '--no-edit', 'HEAD'], { cwd: repoDir, env: benchEnv });

    if (sidecarResult.status === 'error') {
      console.error(`\nStopping: sidecar errored on ${commit.sha.slice(0, 7)} — check chunk setup and try again.`);
      break;
    }
    if (pipelineResult.status === 'error') {
      console.error(`\nStopping: pipeline errored on ${commit.sha.slice(0, 7)} — check CIRCLECI_TOKEN and branch permissions.`);
      break;
    }
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
    benchmarkBranch,
    commits: results,
    summary,
  };
}
