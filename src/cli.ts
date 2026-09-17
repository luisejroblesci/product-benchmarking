import 'dotenv/config';
import { program } from 'commander';
import path from 'path';
import { runSidecarBenchmark } from './benchmarks/sidecar/runner.js';
import { runSkillsBenchmark } from './benchmarks/skills/runner.js';
import { saveJSON, loadJSON, exportUC1CSV, exportUC2CSV } from './core/storage.js';
import { generateUC1Report, generateUC2Report, saveReport } from './core/report.js';
import { startUIServer } from './ui/server.js';
import type { ToolConfig, PromptSuite, UC1RunResult, UC2RunResult } from './core/types.js';

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
  .requiredOption('--repo-dir <path>', 'Local path to the cloned target repo')
  .option('--branch <branch>', 'Branch to pull commits from', 'main')
  .option('--n <number>', 'Number of commits to test', '5')
  .option('--commits <shas>', 'Comma-separated specific SHAs to test (overrides --branch/--n)')
  .option('--benchmark-branch <branch>', 'Dedicated branch for CI pushes', 'bench/sidecar-test')
  .option('--out <file>', 'Output JSON file', `results/uc1-run-${Date.now()}.json`)
  .option('--ui', 'Start live dashboard at http://localhost:4321')
  .action(async (opts) => {
    const circleciToken = requireEnv('CIRCLECI_TOKEN');
    let stopUI: (() => void) | undefined;
    if (opts.ui) {
      stopUI = startUIServer(4321);
      // Give the server a moment to start before the runner emits events
      await new Promise((r) => setTimeout(r, 500));
    }
    const result = await runSidecarBenchmark({
      repo: opts.repo,
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

// UC2: skills agent performance
program
  .command('skills')
  .description('Benchmark skills agent performance across tool configurations')
  .requiredOption('--suite <file>', 'Path to JSON prompt suite file')
  .option(
    '--tools <configs>',
    'Comma-separated tool configs to test (cli,mcp-builtin,mcp-remote,api-v1,api-v2,all)',
    'api-v2,all'
  )
  .option('--baseline <file>', 'Prior run JSON for delta comparison (optional)')
  .option('--out <file>', 'Output JSON file', `results/uc2-run-${Date.now()}.json`)
  .action(async (opts) => {
    const circleciToken = requireEnv('CIRCLECI_TOKEN');
    const anthropicApiKey = requireEnv('ANTHROPIC_API_KEY');

    const suite = loadJSON<PromptSuite>(opts.suite);
    const toolConfigs = (opts.tools as string)
      .split(',')
      .map((t) => t.trim() as ToolConfig)
      .map((t) => [t]);

    const result = await runSkillsBenchmark({
      suite,
      toolConfigs,
      circleciToken,
      anthropicApiKey,
    });

    saveJSON(opts.out, result);
    const csvPath = await exportUC2CSV(result, path.dirname(opts.out));
    const reportPath = opts.out.replace('.json', '.html');
    saveReport(generateUC2Report(result, `Skills Benchmark — ${suite.suite}`), reportPath);

    console.log(`\nResults saved:`);
    console.log(`  JSON:   ${opts.out}`);
    console.log(`  CSV:    ${csvPath}`);
    console.log(`  Report: ${reportPath}`);

    const s = result.crossConfigSummary;
    console.log(`\nFastest: ${s.fastestConfig}  |  Lowest tokens: ${s.lowestTokenConfig}  |  Fewest turns: ${s.fewestTurnsConfig}`);
  });

// Generate report from existing run files
program
  .command('report')
  .description('Generate HTML report from a saved run JSON')
  .requiredOption('--runs <file>', 'Path to a UC1 or UC2 run JSON file')
  .option('--title <title>', 'Report title', 'Benchmark Report')
  .option('--out <file>', 'Output HTML file')
  .action((opts) => {
    const data = loadJSON<UC1RunResult | UC2RunResult>(opts.runs);
    const outPath = opts.out ?? opts.runs.replace('.json', '.html');

    let html: string;
    if ('commits' in data) {
      html = generateUC1Report(data as UC1RunResult, opts.title);
    } else {
      html = generateUC2Report(data as UC2RunResult, opts.title);
    }

    saveReport(html, outPath);
    console.log(`Report saved to: ${outPath}`);
  });

program.parse();
