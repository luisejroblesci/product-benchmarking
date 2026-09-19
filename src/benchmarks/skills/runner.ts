import { v4 as uuidv4 } from 'uuid';
import { runAgentCase } from './agent.js';
import { buildSessionConfig, cleanupSessionConfig } from './tools/index.js';
import { emitBenchEvent } from '../../core/emitter.js';
import { saveJSON, exportUC2CSV } from '../../core/storage.js';
import { generateUC2Report, saveReport } from '../../core/report.js';
import type { ToolConfig, PromptSuite, UC2RunResult, ConfigResult, CaseMetric } from '../../core/types.js';
import path from 'path';

export interface SkillsRunOptions {
  suite: PromptSuite;
  toolConfigs: ToolConfig[][];
  circleciToken: string;
  withSkill?: boolean;
  casesFilter?: string[];    // case IDs to run; undefined = all
  outDir?: string;
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
  const fastest = configs.reduce((a, b) => a.summary.avgDurationMs < b.summary.avgDurationMs ? a : b);
  const lowestToken = configs.reduce((a, b) => a.summary.totalTokens < b.summary.totalTokens ? a : b);
  const fewestTurns = configs.reduce((a, b) => a.summary.avgTurns < b.summary.avgTurns ? a : b);
  return {
    fastestConfig: label(fastest),
    lowestTokenConfig: label(lowestToken),
    fewestTurnsConfig: label(fewestTurns),
  };
}

export async function runSkillsBenchmark(opts: SkillsRunOptions): Promise<UC2RunResult> {
  const { suite, toolConfigs, circleciToken, withSkill = false, outDir = 'results' } = opts;

  const activeCases = opts.casesFilter?.length
    ? suite.cases.filter((c) => opts.casesFilter!.includes(c.id))
    : suite.cases;

  console.log(
    `Running skills benchmark: "${suite.suite}" ` +
    `(${activeCases.length} cases × ${toolConfigs.length} configs, skill=${withSkill})`
  );

  emitBenchEvent({
    type: 'uc2:run:start',
    suite: suite.suite,
    totalCases: activeCases.length,
    configs: toolConfigs.map((t) => t.join(',')),
    cases: activeCases.map((c) => c.id),
  });

  const configResults = await Promise.all(
    toolConfigs.map(async (tools) => {
      const configLabel = tools.join(',');
      const sessionConfig = buildSessionConfig(tools, circleciToken, withSkill);
      console.log(`  Starting config: [${configLabel}]`);

      try {
        const cases = await Promise.all(
          activeCases.map((c) => {
            emitBenchEvent({ type: 'uc2:case:start', caseId: c.id, config: configLabel });
            return runAgentCase(c, sessionConfig, {
              onTurn: (data) => {
                emitBenchEvent({
                  type: 'uc2:case:turn',
                  caseId: c.id,
                  config: configLabel,
                  turn: data.turn,
                  totalTokens: data.inputTokens + data.outputTokens,
                  toolsUsed: data.toolsUsed,
                  assistantText: data.assistantText,
                  toolCalls: data.toolCalls,
                });
              },
            }).then((metric) => {
              emitBenchEvent({
                type: 'uc2:case:done',
                caseId: c.id,
                config: configLabel,
                turns: metric.turns,
                totalTokens: metric.totalTokens,
                durationMs: metric.durationMs,
                success: metric.success,
                toolsUsed: metric.toolsUsed,
              });
              return metric;
            });
          })
        );

        const summary = buildConfigSummary(cases);
        console.log(
          `  Config [${configLabel}] done — avg turns: ${summary.avgTurns}, ` +
          `total tokens: ${summary.totalTokens}, avg duration: ${(summary.avgDurationMs / 1000).toFixed(1)}s`
        );
        emitBenchEvent({
          type: 'uc2:config:done',
          config: configLabel,
          summary: {
            avgTurns: summary.avgTurns,
            totalTokens: summary.totalTokens,
            avgDurationMs: summary.avgDurationMs,
            successRate: summary.successRate,
          },
        });

        return { tools, cases, summary } satisfies ConfigResult;
      } finally {
        cleanupSessionConfig(sessionConfig);
      }
    })
  );

  const crossConfigSummary = computeCrossConfig(configResults);
  const result: UC2RunResult = {
    runId: uuidv4(),
    timestamp: new Date().toISOString(),
    suite: suite.suite,
    configs: configResults,
    crossConfigSummary,
  };

  const outFile = path.join(outDir, `uc2-run-${Date.now()}.json`);
  saveJSON(outFile, result);
  await exportUC2CSV(result, outDir);
  saveReport(generateUC2Report(result, `Skills Benchmark — ${suite.suite}`), outFile.replace('.json', '.html'));

  emitBenchEvent({ type: 'uc2:run:done', crossConfigSummary, resultFile: outFile });

  return result;
}
