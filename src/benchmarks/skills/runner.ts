import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { runSession } from './agent.js';
import { runPreflight, printPreflight, preflightOk } from './preflight.js';
import { loadSkills } from './skills-loader.js';
import { prepareWorkspaceCache } from './workspace.js';
import { sessionKeyString } from './contracts.js';
import type { LoadedSkills, RunWriter } from './contracts.js';
import { emitBenchEvent } from '../../core/emitter.js';
import { createRunDir, openRunWriter, appendRunIndex, runIndexEntry, exportSessionsCSV, readTranscript } from '../../core/storage.js';
import { judge, condenseTrace } from './judge.js';
import { buildSummary } from '../../core/summary.js';
import { generateUseCaseReport, generateTranscriptViewer } from '../../core/report.js';
import { redactConfig } from '../../core/config.js';
import type {
  BenchConfig, Condition, ModelConfig, PreflightCheck, RunManifest, RunSummary, SessionKey,
  SessionRecord, TranscriptTurn, UseCase, UseCaseSuite,
} from '../../core/types.js';

export interface UseCaseRunOptions {
  cfg: BenchConfig;
  suite: UseCaseSuite;
  suitePath: string;
  models: ModelConfig[];
  conditions: Condition[];
  cases: UseCase[];
  reps: number;
  concurrency: number;
  outBase?: string;
  resumeDir?: string;
  retryErrors?: boolean;
  skipPreflight?: boolean;
}

export class PreflightFailedError extends Error {
  constructor(public checks: PreflightCheck[]) { super('Preflight failed'); }
}

interface Task { key: SessionKey; model: ModelConfig; useCase: UseCase }

function tryExec(cmd: string, args: string[]): string | null {
  try { return execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

function skippedRecord(runId: string, t: Task, reason: string): SessionRecord {
  const now = new Date().toISOString();
  return {
    runId, ...t.key, provider: t.model.provider, providerModel: t.model.model, status: 'skipped',
    error: { kind: 'provider_error', message: reason },
    turns: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, costUsd: null,
    durationMs: 0, modelTimeMs: 0, toolTimeMs: 0, toolCallCount: 0, toolErrors: 0, distinctTools: [],
    firstToolTurn: null, skillsLoaded: [], retries: 0,
    score: null, pass: null, judgeReasoning: null, finalAnswer: '', transcriptPath: '', startedAt: now, endedAt: now,
  };
}

/** Rebuilds summary.json, report.html, transcript.html, sessions.csv from sessions.jsonl. */
export async function finalizeRun(runDir: string, writer: RunWriter = openRunWriter(runDir)): Promise<RunSummary> {
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf-8')) as RunManifest;
  const records = writer.readSessions();
  const summary = buildSummary(manifest.runId, records);
  writer.writeSummary(summary);
  fs.writeFileSync(path.join(runDir, 'report.html'), generateUseCaseReport(manifest, summary, records));
  fs.writeFileSync(path.join(runDir, 'transcript.html'), generateTranscriptViewer());
  await exportSessionsCSV(runDir, records);
  return summary;
}

export async function runUseCaseBenchmark(opts: UseCaseRunOptions): Promise<{ runDir: string; summary: RunSummary }> {
  const { cfg, models, conditions, cases, reps } = opts;

  // ── 1. preflight: prove every model and tool surface works before spending on evals ──
  let preflight: PreflightCheck[] = [];
  if (!opts.skipPreflight) {
    console.log('Running preflight checks…');
    preflight = await runPreflight(cfg, { models, conditions });
    printPreflight(preflight);
    emitBenchEvent({ type: 'uc:preflight', checks: preflight });
    if (!preflightOk(preflight)) throw new PreflightFailedError(preflight);
  }

  // ── 2. run directory (new or resumed) ──
  let runDir: string;
  let runId: string;
  if (opts.resumeDir) {
    runDir = opts.resumeDir;
    runId = (JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf-8')) as RunManifest).runId;
  } else {
    runId = uuidv4();
    runDir = createRunDir(opts.outBase, runId);
  }
  const writer = openRunWriter(runDir);

  const needsSkills = conditions.some((c) => c.endsWith('+skills'));
  const skills: LoadedSkills | undefined = needsSkills ? await loadSkills(cfg.skills) : undefined;
  const workspace = (await prepareWorkspaceCache(cfg)) ?? undefined;

  if (!opts.resumeDir) {
    const suiteRaw = fs.readFileSync(opts.suitePath);
    writer.writeManifest({
      runId,
      startedAt: new Date().toISOString(),
      gitSha: tryExec('git', ['rev-parse', 'HEAD']),
      suite: {
        name: opts.suite.suite, path: opts.suitePath,
        sha256: createHash('sha256').update(suiteRaw).digest('hex'), caseIds: cases.map((c) => c.id),
      },
      skills: { repo: cfg.skills.repo, ref: cfg.skills.ref, resolvedSha: skills?.resolvedSha ?? null },
      circleciCliVersion: tryExec(cfg.cli.binary, ['version']),
      workspace: workspace ? { repo: workspace.repo, ref: workspace.ref, sha: workspace.sha } : null,
      config: redactConfig(cfg),
      models: models.map((m) => m.id),
      conditions,
      repetitions: reps,
      preflight,
    });
  }

  // ── 3. build the session matrix, skipping what's already recorded ──
  const done = writer.completedKeys(!opts.retryErrors);
  const tasks: Task[] = [];
  for (let rep = 1; rep <= reps; rep++)
    for (const useCase of cases)
      for (const condition of conditions)
        for (const model of models) {
          const key: SessionKey = { model: model.id, condition, caseId: useCase.id, rep };
          if (!done.has(sessionKeyString(key))) tasks.push({ key, model, useCase });
        }

  const total = tasks.length;
  console.log(`\nRun dir: ${runDir}`);
  console.log(`Sessions to run: ${total} (${models.length} models × ${conditions.length} conditions × ${cases.length} cases × ${reps} reps${done.size ? `, ${done.size} already recorded` : ''})\n`);
  emitBenchEvent({
    type: 'uc:run:start', runId, suite: opts.suite.suite, models: models.map((m) => m.id),
    conditions, cases: cases.map((c) => c.id), total,
  });

  // ── 4. parallel pool: global cap + per-model cap + per-model circuit breaker ──
  const active = new Map<string, number>();
  const consecutiveProviderErrors = new Map<string, number>();
  const broken = new Set<string>();
  let running = 0;
  let finished = 0;
  const queue = [...tasks];

  const progress = (r: SessionRecord) => {
    finished++;
    const score = r.score === null ? '—' : `${r.score}/5`;
    const err = r.error ? ` [${r.error.kind}: ${r.error.message.slice(0, 80)}]` : '';
    console.log(
      `[${finished}/${total}] ${r.model} · ${r.condition} · ${r.caseId} · r${r.rep} → ${r.status} ` +
      `score=${score} turns=${r.turns} tokens=${r.usage.input + r.usage.output} ${(r.durationMs / 1000).toFixed(1)}s${err}`
    );
    emitBenchEvent({ type: 'uc:session:done', record: r });
  };

  const skipBroken = (modelId: string) => {
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].model.id !== modelId) continue;
      const [t] = queue.splice(i, 1);
      const rec = skippedRecord(runId, t, `circuit breaker: ${cfg.circuitBreakerThreshold} consecutive provider errors for ${modelId}`);
      writer.appendSession(rec);
      progress(rec);
    }
  };

  await new Promise<void>((resolve) => {
    const pump = () => {
      if (queue.length === 0 && running === 0) return resolve();
      while (running < opts.concurrency) {
        const idx = queue.findIndex((t) => (active.get(t.model.id) ?? 0) < (t.model.maxConcurrent ?? Infinity));
        if (idx === -1) break;
        const [t] = queue.splice(idx, 1);
        running++;
        active.set(t.model.id, (active.get(t.model.id) ?? 0) + 1);
        emitBenchEvent({ type: 'uc:session:start', key: t.key });

        runSession({
          runId, cfg, model: t.model, condition: t.key.condition, useCase: t.useCase, rep: t.key.rep, writer, skills, workspace,
          onTurn: (key, turn) => emitBenchEvent({ type: 'uc:session:turn', key, turn }),
        })
          .catch((err): SessionRecord => {
            // runSession records its own errors; this only fires on bugs in the harness itself.
            const rec = skippedRecord(runId, t, `harness error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
            rec.status = 'error';
            rec.error = { kind: 'unknown', message: rec.error!.message };
            writer.appendSession(rec);
            return rec;
          })
          .then((rec) => {
            running--;
            active.set(t.model.id, (active.get(t.model.id) ?? 1) - 1);
            progress(rec);
            if (rec.error?.kind === 'provider_error') {
              const n = (consecutiveProviderErrors.get(t.model.id) ?? 0) + 1;
              consecutiveProviderErrors.set(t.model.id, n);
              if (n >= cfg.circuitBreakerThreshold && !broken.has(t.model.id)) {
                broken.add(t.model.id);
                console.log(`\n⚠ ${t.model.id}: ${n} consecutive provider errors, skipping its remaining sessions\n`);
                skipBroken(t.model.id);
              }
            } else if (rec.status !== 'skipped') {
              consecutiveProviderErrors.set(t.model.id, 0);
            }
            pump();
          });
      }
    };
    pump();
  });

  // ── 5. aggregate + reports ──
  const summary = await finalizeRun(runDir, writer);
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf-8')) as RunManifest;
  // index.jsonl lives next to the runs/ dir the run was written into (benchmarks/uc2/index.jsonl by default).
  appendRunIndex(path.join(path.dirname(path.dirname(path.resolve(runDir))), 'index.jsonl'), runIndexEntry(manifest, runDir, writer.readSessions()));
  emitBenchEvent({ type: 'uc:run:done', runId, runDir, summary });
  return { runDir, summary };
}

/** Re-runs the judge for judge_error sessions (or every answered session with `all`). Appends updated rows; last row per key wins. */
export async function regradeRun(runDir: string, cfg: BenchConfig, suite: UseCaseSuite, all = false): Promise<number> {
  const writer = openRunWriter(runDir);
  const targets = writer.readSessions().filter((r) =>
    all ? r.finalAnswer.trim() && r.status !== 'skipped' : r.status === 'judge_error');
  let n = 0;
  for (const r of targets) {
    const useCase = suite.cases.find((c) => c.id === r.caseId);
    if (!useCase) { console.warn(`skip ${r.caseId}: not in suite`); continue; }
    const turns = readTranscript(path.join(runDir, r.transcriptPath)).filter((l): l is TranscriptTurn => l.type === 'turn');
    try {
      const j = await judge(cfg, useCase, r.finalAnswer, condenseTrace(turns));
      writer.appendSession({
        ...r,
        status: r.status === 'judge_error' ? 'completed' : r.status,
        error: r.error?.kind === 'judge_error' ? undefined : r.error,
        score: j.score, pass: j.pass, judgeReasoning: j.reasoning,
      });
      n++;
      console.log(`${r.model} · ${r.condition} · ${r.caseId} · r${r.rep} → ${j.score}/5`);
    } catch (err) {
      console.error(`${r.model} · ${r.condition} · ${r.caseId} · r${r.rep} → judge failed again: ${err instanceof Error ? err.message : err}`);
    }
  }
  await finalizeRun(runDir, writer);
  return n;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
};

/** Static server for a run dir so report.html can fetch transcripts (fetch() doesn't work over file://). */
export function serveRunDir(runDir: string, port: number): void {
  const root = path.resolve(runDir);
  http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const file = path.resolve(root, '.' + (urlPath === '/' ? '/report.html' : urlPath));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }).listen(port, () => console.log(`Serving ${root} → http://localhost:${port}/report.html`));
}
