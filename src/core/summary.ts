import { ALL_CONDITIONS } from './types.js';
import type { CellSummary, Condition, RunSummary, SessionRecord, ToolSurfaceKind } from './types.js';

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Linear-interpolated percentile (p in 0..100) of an unsorted list; null when empty. */
export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = (p / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

/** Total tokens for a session = input + output (reasoning is counted within output by the AI SDK). */
export const totalTokens = (r: SessionRecord) => (r.usage?.input ?? 0) + (r.usage?.output ?? 0);

/** A session "ran to completion" when the agent finished, regardless of whether judging succeeded. */
const finished = (r: SessionRecord) => r.status === 'completed' || r.status === 'judge_error';
const judged = (r: SessionRecord) => r.score !== null && r.score !== undefined;

function passAndScore(rs: SessionRecord[]) {
  const j = rs.filter(judged);
  return {
    passRate: j.length ? j.filter((r) => r.pass === true).length / j.length : null,
    meanScore: mean(j.map((r) => r.score as number)),
  };
}

function orderedConditions(records: SessionRecord[]): Condition[] {
  const present = new Set(records.map((r) => r.condition));
  const known = ALL_CONDITIONS.filter((c) => present.has(c));
  const unknown = [...present].filter((c) => !ALL_CONDITIONS.includes(c));
  return [...known, ...unknown];
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export function cellSummary(model: string, condition: Condition, rs: SessionRecord[]): CellSummary {
  const fin = rs.filter(finished);
  const errors = rs.filter((r) => r.status === 'error').length;
  const costs = rs.map((r) => r.costUsd).filter((c): c is number => typeof c === 'number');
  const durations = fin.map((r) => r.durationMs);
  return {
    model,
    condition,
    sessions: rs.length,
    completed: rs.filter((r) => r.status === 'completed').length,
    errors,
    skipped: rs.filter((r) => r.status === 'skipped').length,
    judgeErrors: rs.filter((r) => r.status === 'judge_error').length,
    ...passAndScore(rs),
    errorRate: rs.length ? errors / rs.length : 0,
    avgTurns: mean(fin.map((r) => r.turns)),
    avgTotalTokens: mean(fin.map(totalTokens)),
    // Cost includes errored sessions too: they still spent tokens.
    totalCostUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    p50DurationMs: percentile(durations, 50),
    p90DurationMs: percentile(durations, 90),
    avgToolCalls: mean(fin.map((r) => r.toolCallCount)),
    avgToolErrors: mean(fin.map((r) => r.toolErrors)),
  };
}

const diff = (a: number | null | undefined, b: number | null | undefined) =>
  a === null || a === undefined || b === null || b === undefined ? null : a - b;

/**
 * Aggregates (deduped) session records into per model×condition cells, per-case rows and skills deltas.
 * Pass rate / mean score are over judged sessions (score != null); averages and latency percentiles are
 * over sessions that ran to completion (status completed or judge_error); errorRate = errors / sessions.
 */
export function buildSummary(runId: string, records: SessionRecord[]): RunSummary {
  const models = uniq(records.map((r) => r.model));
  const conditions = orderedConditions(records);

  const cells: CellSummary[] = [];
  for (const m of models) {
    for (const c of conditions) {
      const rs = records.filter((r) => r.model === m && r.condition === c);
      if (rs.length) cells.push(cellSummary(m, c, rs));
    }
  }

  const byCase: RunSummary['byCase'] = [];
  for (const caseId of uniq(records.map((r) => r.caseId))) {
    for (const m of models) {
      for (const c of conditions) {
        const rs = records.filter((r) => r.caseId === caseId && r.model === m && r.condition === c);
        if (!rs.length) continue;
        const fin = rs.filter(finished);
        byCase.push({
          caseId, condition: c, model: m, ...passAndScore(rs),
          avgTurns: mean(fin.map((r) => r.turns)), unfinished: rs.length - fin.length,
        });
      }
    }
  }

  const skillsDelta: RunSummary['skillsDelta'] = [];
  const surfaces: ToolSurfaceKind[] = ['cli', 'mcp'];
  for (const m of models) {
    for (const surface of surfaces) {
      const withS = cells.find((x) => x.model === m && x.condition === `${surface}+skills`);
      const without = cells.find((x) => x.model === m && x.condition === surface);
      if (!withS || !without) continue;
      skillsDelta.push({
        model: m,
        surface,
        passRateDelta: diff(withS.passRate, without.passRate),
        meanScoreDelta: diff(withS.meanScore, without.meanScore),
        tokensDelta: diff(withS.avgTotalTokens, without.avgTotalTokens),
      });
    }
  }

  return { runId, generatedAt: new Date().toISOString(), cells, byCase, skillsDelta };
}

/**
 * Plain-text turns table: one row per case, one column per model × condition, plus an average row.
 * `*` marks cells where some session didn't finish (those are excluded from the number).
 */
export function formatTurnsTable(summary: RunSummary, caseOrder: string[] = []): string {
  const cols = summary.cells.map((c) => ({ model: c.model, condition: c.condition }));
  const present = uniq(summary.byCase.map((b) => b.caseId));
  const caseIds = [...caseOrder.filter((id) => present.includes(id)), ...present.filter((id) => !caseOrder.includes(id))];
  const fmt = (n: number | null) => (n === null ? '–' : Number.isInteger(n) ? String(n) : n.toFixed(1));
  const header = ['case', ...cols.map((c) => `${c.model} ${c.condition}`)];
  const rows = caseIds.map((id) => [id, ...cols.map((c) => {
    const b = summary.byCase.find((x) => x.caseId === id && x.model === c.model && x.condition === c.condition);
    return b ? fmt(b.avgTurns) + (b.unfinished ? '*' : '') : '–';
  })]);
  rows.push(['average', ...summary.cells.map((c) => fmt(c.avgTurns))]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((v, i) => (i === 0 ? v.padEnd(widths[i]) : v.padStart(widths[i]))).join('  ');
  const hasStar = rows.some((r) => r.some((v) => v.endsWith('*')));
  return [line(header), ...rows.map(line), ...(hasStar ? ['* some sessions did not finish; excluded from the count'] : [])].join('\n');
}
