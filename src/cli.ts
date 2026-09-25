import 'dotenv/config';
import { program, Command } from 'commander';
import path from 'path';
import { runSidecarBenchmark } from './benchmarks/sidecar/runner.js';
import { runUseCaseBenchmark, finalizeRun, regradeRun, serveRunDir, PreflightFailedError } from './benchmarks/skills/runner.js';
import { runPreflight, printPreflight, preflightOk } from './benchmarks/skills/preflight.js';
import { loadConfig, loadSuite, activeModels } from './core/config.js';
import { inspectRun } from './core/inspect.js';
import { formatTurnsTable } from './core/summary.js';
import { saveJSON, loadJSON, exportUC1CSV } from './core/storage.js';
import { generateUC1Report, saveReport } from './core/report.js';
import { startUIServer } from './ui/server.js';
import { ALL_CONDITIONS } from './core/types.js';
import type { Condition, RunManifest, UC1RunResult } from './core/types.js';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
}

program.name('bench').description('Product benchmarking CLI');

// UC1: sidecar vs traditional pipeline
program
  .command('sidecar')
  .description('Benchmark sidecar vs traditional CI pipeline speed')
  .requiredOption('--repo <org/repo>', 'Target repo, e.g. luisejroblesci/circleci-cli')
  .option('--ci-repo <org/repo>', 'Upstream repo to pull historical CI data from (defaults to --repo)')
  .requiredOption('--repo-dir <path>', 'Local path to the cloned target repo')
  .option('--branch <branch>', 'Branch to pull commits from', 'main')
  .option('--n <number>', 'Number of commits to test', '5')
  .option('--commits <shas>', 'Comma-separated specific SHAs to test (overrides --branch/--n)')
  .option('--benchmark-branch <branch>', 'Dedicated branch for CI pushes', 'bench/sidecar-test')
  .option('--out <file>', 'Output JSON file', `results/uc1-run-${Date.now()}.json`)
  .option('--no-ui', 'Disable the live dashboard (enabled by default)')
  .action(async (opts) => {
    const circleciToken = requireEnv('CIRCLECI_TOKEN');
    let stopUI: (() => void) | undefined;
    if (opts.ui !== false) {
      stopUI = startUIServer(4321);
      // Give the server a moment to start before the runner emits events
      await new Promise((r) => setTimeout(r, 500));
    }
    const result = await runSidecarBenchmark({
      repo: opts.repo,
      ciRepo: opts.ciRepo,
      repoDir: path.resolve(opts.repoDir),
      branch: opts.branch,
      n: parseInt(opts.n, 10),
      commits: opts.commits ? String(opts.commits).split(',') : undefined,
      benchmarkBranch: opts.benchmarkBranch,
      circleciToken,
    });

    saveJSON(opts.out, result);
    const csvPath = await exportUC1CSV(result, path.dirname(opts.out));
    const reportPath = opts.out.replace('.json', '.html');
    saveReport(generateUC1Report(result, `Sidecar vs Traditional — ${result.repo}`), reportPath);

    console.log(`\nResults saved:`);
    console.log(`  JSON:   ${opts.out}`);
    console.log(`  CSV:    ${csvPath}`);
    console.log(`  Report: ${reportPath}`);
    console.log(`\nSpeedup factor: ${result.summary.speedupFactor}×`);
    stopUI?.();
  });

// UC2: use-cases benchmark — models × {cli, mcp} × {skills, no skills}
const list = (v?: string) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);

function loadBench(opts: { config: string; suite: string; models?: string; conditions?: string; cases?: string }) {
  const cfg = loadConfig(opts.config);
  const suite = loadSuite(opts.suite);
  const models = activeModels(cfg, list(opts.models));
  const conditions = (list(opts.conditions) ?? cfg.conditions) as Condition[];
  const bad = conditions.filter((c) => !ALL_CONDITIONS.includes(c));
  if (bad.length) throw new Error(`Unknown condition(s): ${bad.join(', ')}. Valid: ${ALL_CONDITIONS.join(', ')}`);
  const caseIds = list(opts.cases);
  const unknown = caseIds?.filter((id) => !suite.cases.some((c) => c.id === id)) ?? [];
  if (unknown.length) throw new Error(`Unknown case id(s): ${unknown.join(', ')}`);
  const cases = caseIds ? suite.cases.filter((c) => caseIds.includes(c.id)) : suite.cases;
  return { cfg, suite, models, conditions, cases };
}

const benchOptions = (cmd: Command) =>
  cmd
    .option('--config <file>', 'Benchmark config', 'bench.config.json')
    .option('--suite <file>', 'Use-case suite', 'suites/circleci-use-cases.json')
    .option('--models <ids>', 'Comma-separated model ids (default: all enabled)')
    .option('--conditions <list>', `Comma-separated conditions (${ALL_CONDITIONS.join(',')})`);

benchOptions(program.command('usecases'))
  .description('Run the use-cases benchmark across models and tool/skills conditions')
  .option('--cases <ids>', 'Comma-separated case ids (default: all)')
  .option('--reps <n>', 'Repetitions per session (default: config)')
  .option('--concurrency <n>', 'Max parallel sessions (default: config)')
  .option('--out <dir>', 'Base directory for run dirs', 'benchmarks/uc2/runs')
  .option('--resume <runDir>', 'Resume a run, skipping sessions already recorded')
  .option('--retry-errors', 'With --resume, also rerun sessions that errored or were skipped')
  .option('--skip-preflight', 'Skip preflight checks')
  .option('--no-ui', 'Disable the live dashboard (enabled by default)')
  .action(async (opts) => {
    const b = loadBench(opts);
    let stopUI: (() => void) | undefined;
    if (opts.ui !== false) {
      stopUI = startUIServer(4321);
      await new Promise((r) => setTimeout(r, 500));
    }
    try {
      const { runDir, summary } = await runUseCaseBenchmark({
        ...b,
        suitePath: opts.suite,
        reps: opts.reps ? Number(opts.reps) : b.cfg.repetitions,
        concurrency: opts.concurrency ? Number(opts.concurrency) : b.cfg.concurrency,
        outBase: opts.out,
        resumeDir: opts.resume,
        retryErrors: Boolean(opts.retryErrors),
        skipPreflight: Boolean(opts.skipPreflight),
      });
      console.log('\nmodel × condition   pass   score  errors');
      for (const c of summary.cells) {
        const pct = c.passRate === null ? '  —  ' : `${(c.passRate * 100).toFixed(0).padStart(3)}%`;
        const score = c.meanScore === null ? ' — ' : c.meanScore.toFixed(2);
        console.log(`${`${c.model} · ${c.condition}`.padEnd(20)} ${pct}  ${score}  ${c.errors + c.skipped}/${c.sessions}`);
      }
      console.log('\nTurns by case:');
      console.log(formatTurnsTable(summary, b.cases.map((c) => c.id)));
      console.log(`\nResults: ${runDir}`);
      console.log(`Report:  npx tsx src/cli.ts serve ${runDir}   (then open /report.html)`);
      console.log(`Inspect: npx tsx src/cli.ts inspect ${runDir} --case <id>`);
    } catch (err) {
      if (err instanceof PreflightFailedError) {
        console.error('\nPreflight failed; no sessions were run. Fix the ✗ rows above (or pass --skip-preflight).');
        process.exitCode = 1;
      } else throw err;
    } finally {
      stopUI?.();
    }
  });

benchOptions(program.command('preflight'))
  .description('Check that every configured model and tool surface works, without running evals')
  .action(async (opts) => {
    const { cfg, models, conditions } = loadBench(opts);
    const checks = await runPreflight(cfg, { models, conditions });
    printPreflight(checks);
    if (!preflightOk(checks)) process.exitCode = 1;
  });

program
  .command('inspect <runDir>')
  .description('Print turn-by-turn timelines for sessions in a run')
  .option('--model <id>')
  .option('--condition <c>')
  .option('--case <id>')
  .option('--rep <n>')
  .action((runDir, opts) => {
    inspectRun(runDir, { model: opts.model, condition: opts.condition, caseId: opts.case, rep: opts.rep ? Number(opts.rep) : undefined });
  });

program
  .command('judge <runDir>')
  .description('Re-grade sessions in a run whose judge call failed (or all, with --all)')
  .option('--config <file>', 'Benchmark config', 'bench.config.json')
  .option('--suite <file>', 'Use-case suite', 'suites/circleci-use-cases.json')
  .option('--all', 'Re-grade every session with a final answer')
  .action(async (runDir, opts) => {
    const n = await regradeRun(runDir, loadConfig(opts.config), loadSuite(opts.suite), Boolean(opts.all));
    console.log(`Re-graded ${n} session(s); summary and report regenerated.`);
  });

program
  .command('finalize <runDir>')
  .description('Regenerate summary.json, report.html and sessions.csv from sessions.jsonl')
  .action(async (runDir) => {
    const summary = await finalizeRun(runDir);
    const manifest = loadJSON<RunManifest>(path.join(runDir, 'manifest.json'));
    console.log(formatTurnsTable(summary, manifest.suite?.caseIds ?? []));
    console.log(`\nRegenerated reports in ${runDir}`);
  });

program
  .command('serve <runDir>')
  .description('Serve a run directory so report.html and the transcript viewer work in a browser')
  .option('--port <n>', 'Port', '4322')
  .action((runDir, opts) => {
    serveRunDir(runDir, Number(opts.port));
  });

// Generate report from existing run files
program
  .command('report')
  .description('Generate HTML report from a saved UC1 run JSON')
  .requiredOption('--runs <file>', 'Path to a UC1 run JSON file (UC2 runs: use `finalize`)')
  .option('--title <title>', 'Report title', 'Benchmark Report')
  .option('--out <file>', 'Output HTML file')
  .action((opts) => {
    const data = loadJSON<UC1RunResult>(opts.runs);
    const outPath = opts.out ?? opts.runs.replace('.json', '.html');
    saveReport(generateUC1Report(data, opts.title), outPath);
    console.log(`Report saved to: ${outPath}`);
  });

program.parse();
