import { v4 as uuidv4 } from 'uuid';
import { runAgentCase } from './agent.js';
import { buildToolSet } from './tools/index.js';
import type { ToolConfig, PromptSuite, UC2RunResult, ConfigResult, CaseMetric } from '../../core/types.js';

export interface SkillsRunOptions {
  suite: PromptSuite;
  toolConfigs: ToolConfig[][];
  circleciToken: string;
  anthropicApiKey: string;
}

function buildConfigSummary(cases: CaseMetric[]): ConfigResult['summary'] {
  const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
  return {
    avgTurns: parseFloat(avg(cases.map((c) => c.turns)).toFixed(2)),
    totalInputTokens: cases.reduce((s, c) => s + c.inputTokens, 0),
    totalOutputTokens: cases.reduce((s, c) => s + c.outputTokens, 0),
    totalTokens: cases.reduce((s, c) => s + c.totalTokens, 0),
    avgDurationMs: Math.round(avg(cases.map((c) => c.durationMs))),
    successRate: parseFloat((cases.filter((c) => c.success).length / cases.length).toFixed(3)),
  };
}

function computeCrossConfig(configs: ConfigResult[]): UC2RunResult['crossConfigSummary'] {
  const label = (cfg: ConfigResult) => cfg.tools.join(',');
  const fastest = configs.reduce((a, b) =>
    a.summary.avgDurationMs < b.summary.avgDurationMs ? a : b
  );
  const lowestToken = configs.reduce((a, b) =>
    a.summary.totalTokens < b.summary.totalTokens ? a : b
  );
  const fewestTurns = configs.reduce((a, b) =>
    a.summary.avgTurns < b.summary.avgTurns ? a : b
  );
  return {
    fastestConfig: label(fastest),
    lowestTokenConfig: label(lowestToken),
    fewestTurnsConfig: label(fewestTurns),
  };
}

export async function runSkillsBenchmark(opts: SkillsRunOptions): Promise<UC2RunResult> {
  const { suite, toolConfigs, circleciToken, anthropicApiKey } = opts;

  console.log(`Running skills benchmark: "${suite.suite}" (${suite.cases.length} cases × ${toolConfigs.length} configs)`);

  // Run all tool configs in parallel
  const configResults = await Promise.all(
    toolConfigs.map(async (tools) => {
      const toolSet = buildToolSet(tools, circleciToken);
      console.log(`  Starting config: [${tools.join(', ')}]`);

      const cases = await Promise.all(
        suite.cases.map((c) => runAgentCase(c, toolSet, anthropicApiKey))
      );

      const summary = buildConfigSummary(cases);
      console.log(
        `  Config [${tools.join(', ')}] done — avg turns: ${summary.avgTurns}, ` +
        `total tokens: ${summary.totalTokens}, avg duration: ${(summary.avgDurationMs / 1000).toFixed(1)}s`
      );

      return { tools, cases, summary } satisfies ConfigResult;
    })
  );

  return {
    runId: uuidv4(),
    timestamp: new Date().toISOString(),
    suite: suite.suite,
    configs: configResults,
    crossConfigSummary: computeCrossConfig(configResults),
  };
}
