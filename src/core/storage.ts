import fs from 'fs';
import path from 'path';
import { createObjectCsvWriter } from 'csv-writer';
import type { UC1RunResult, UC2RunResult } from './types.js';

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function saveJSON(filePath: string, data: unknown) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function loadJSON<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

export async function exportUC1CSV(run: UC1RunResult, outDir: string) {
  ensureDir(outDir);
  const file = path.join(outDir, `${run.runId}-uc1.csv`);
  const writer = createObjectCsvWriter({
    path: file,
    header: [
      { id: 'sha', title: 'sha' },
      { id: 'message', title: 'message' },
      { id: 'sidecarMs', title: 'sidecar_ms' },
      { id: 'sidecarStatus', title: 'sidecar_status' },
      { id: 'traditionalMs', title: 'traditional_ms' },
      { id: 'traditionalStatus', title: 'traditional_status' },
      { id: 'speedupFactor', title: 'speedup_factor' },
    ],
  });
  await writer.writeRecords(
    run.commits.map((c) => ({
      sha: c.sha,
      message: c.message,
      sidecarMs: c.sidecar.durationMs,
      sidecarStatus: c.sidecar.status,
      traditionalMs: c.traditional.durationMs,
      traditionalStatus: c.traditional.status,
      speedupFactor: (c.traditional.durationMs / c.sidecar.durationMs).toFixed(2),
    }))
  );
  return file;
}

export async function exportUC2CSV(run: UC2RunResult, outDir: string) {
  ensureDir(outDir);
  const file = path.join(outDir, `${run.runId}-uc2.csv`);
  const writer = createObjectCsvWriter({
    path: file,
    header: [
      { id: 'tools', title: 'tools' },
      { id: 'caseId', title: 'case_id' },
      { id: 'turns', title: 'turns' },
      { id: 'inputTokens', title: 'input_tokens' },
      { id: 'outputTokens', title: 'output_tokens' },
      { id: 'totalTokens', title: 'total_tokens' },
      { id: 'durationMs', title: 'duration_ms' },
      { id: 'toolsUsed', title: 'tools_used' },
      { id: 'success', title: 'success' },
    ],
  });
  const rows = run.configs.flatMap((cfg) =>
    cfg.cases.map((c) => ({
      tools: cfg.tools.join(','),
      caseId: c.id,
      turns: c.turns,
      inputTokens: c.inputTokens,
      outputTokens: c.outputTokens,
      totalTokens: c.totalTokens,
      durationMs: c.durationMs,
      toolsUsed: c.toolsUsed.join(','),
      success: c.success,
    }))
  );
  await writer.writeRecords(rows);
  return file;
}
