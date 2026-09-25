import fs from 'fs';
import path from 'path';
import { readSessionsFile, readTranscript, transcriptRelPath } from './storage.js';
import type { SessionRecord, TranscriptEnd, TranscriptHeader, TranscriptTurn, Usage } from './types.js';

export interface InspectFilter { model?: string; condition?: string; caseId?: string; rep?: number }

const tty = !!process.stdout.isTTY;
const color = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  bold: color('1'), dim: color('2'), red: color('31'), green: color('32'), yellow: color('33'),
  blue: color('34'), magenta: color('35'), cyan: color('36'),
};

/** Show more than this many matching sessions only as a list. */
const LIST_THRESHOLD = 6;

function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '–';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
function clip(s: string | undefined | null, n: number): string {
  const t = oneLine(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}
function indent(s: string, pad: string): string {
  return s.split('\n').map((l) => pad + l).join('\n');
}
function usageStr(u: Usage | undefined): string {
  if (!u) return '';
  const parts = [`in ${u.input}`, `out ${u.output}`];
  if (u.cacheRead) parts.push(`cache r ${u.cacheRead}`);
  if (u.cacheWrite) parts.push(`cache w ${u.cacheWrite}`);
  if (u.reasoning) parts.push(`reasoning ${u.reasoning}`);
  return parts.join(' · ');
}
function argsShort(input: unknown): string {
  const o = input as { args?: unknown } | null;
  if (o && Array.isArray(o.args)) return clip(o.args.map(String).join(' '), 100);
  try {
    return clip(JSON.stringify(input), 100);
  } catch {
    return clip(String(input), 100);
  }
}
function statusColor(status: string): string {
  if (status === 'completed') return c.green(status);
  if (status === 'error') return c.red(status);
  if (status === 'judge_error') return c.yellow(status);
  return c.dim(status);
}
function scoreStr(r: { score: number | null; pass: boolean | null }): string {
  if (r.score === null || r.score === undefined) return c.dim('score –');
  const s = `score ${r.score}/5 ${r.pass ? 'pass' : 'fail'}`;
  return r.pass ? c.green(s) : c.red(s);
}

function matches(r: SessionRecord, f: InspectFilter): boolean {
  return (!f.model || r.model === f.model) &&
    (!f.condition || r.condition === f.condition) &&
    (!f.caseId || r.caseId === f.caseId) &&
    (f.rep === undefined || r.rep === f.rep);
}

function listLine(r: SessionRecord): string {
  const tokens = (r.usage?.input ?? 0) + (r.usage?.output ?? 0);
  return `  ${c.bold(r.model)}  ${c.cyan(r.condition.padEnd(10))}  ${r.caseId}  r${r.rep}  ${statusColor(r.status)}  ` +
    `${scoreStr(r)}  ${r.turns} turns  ${tokens} tok  ${fmtMs(r.durationMs)}` +
    (r.error ? `  ${c.red(`${r.error.kind}: ${clip(r.error.message, 60)}`)}` : '');
}

function printTurn(t: TranscriptTurn) {
  const u = t.usage;
  console.log(c.bold(c.blue(`── turn ${t.turn}`)) + c.dim(`  ${fmtMs(t.durationMs)} · ${u ? `${u.input}/${u.output} tok` : ''} · ${t.finishReason}${t.retries ? ` · ${t.retries} retries` : ''}`));
  if (t.reasoning) console.log(c.dim(c.magenta(`  ~ ${clip(t.reasoning, 300)}`)));
  if (t.assistantText) console.log(indent(t.assistantText.trim(), '  '));
  if (t.skillLoaded?.length) console.log(c.yellow(`  [skill loaded: ${t.skillLoaded.join(', ')}]`));
  for (const tc of t.toolCalls ?? []) {
    const meta = [fmtMs(tc.durationMs), `${tc.outputBytes} B`, tc.exitCode !== undefined ? `exit ${tc.exitCode}` : ''].filter(Boolean).join(' · ');
    console.log(`  ${c.cyan('→')} ${c.bold(tc.name)}(${argsShort(tc.input)}) ${c.dim(meta)}`);
    const preview = clip(tc.output, 300);
    const line = `    ← ${tc.isError ? '[ERROR] ' : ''}${preview}`;
    console.log(tc.isError ? c.red(line) : c.dim(line));
    if (tc.blobPath) console.log(c.dim(`      (full: ${tc.blobPath})`));
  }
}

function printEnd(e: TranscriptEnd | undefined, r: SessionRecord | undefined) {
  console.log(c.bold('── end'));
  if (!e) {
    console.log(c.red('  no end block (session crashed or still running)'));
    if (r) console.log(`  record: ${statusColor(r.status)} ${scoreStr(r)}${r.error ? `  ${r.error.kind}: ${r.error.message}` : ''}`);
    return;
  }
  console.log(`  status: ${statusColor(e.status)}${e.error ? c.red(`  ${e.error.kind}: ${e.error.message}`) : ''}`);
  if (e.finalAnswer) console.log(`  final answer:\n${indent(e.finalAnswer.trim(), '    ')}`);
  if (e.judge) {
    console.log(`  judge: ${scoreStr(e.judge)} ${c.dim(`(${e.judge.judgeModel})`)}`);
    console.log(indent(e.judge.reasoning.trim(), '    '));
  } else {
    console.log(c.dim('  judge: not judged'));
  }
  const t = e.totals;
  if (t) {
    console.log(c.dim(`  totals: ${t.turns} turns · ${usageStr(t.usage)} · ${t.costUsd === null ? 'cost –' : `$${t.costUsd.toFixed(4)}`} · ` +
      `${fmtMs(t.durationMs)} (model ${fmtMs(t.modelTimeMs)}, tools ${fmtMs(t.toolTimeMs)}) · ${t.toolCallCount} tool calls (${t.toolErrors} errors)` +
      (t.skillsLoaded?.length ? ` · skills ${t.skillsLoaded.join(', ')}` : '')));
  }
}

function printSession(runDir: string, r: SessionRecord) {
  const rel = r.transcriptPath || transcriptRelPath(r);
  const abs = path.join(runDir, rel);
  const lines = fs.existsSync(abs) ? readTranscript(abs) : [];
  const header = lines.find((l): l is TranscriptHeader => l.type === 'session');
  const turns = lines.filter((l): l is TranscriptTurn => l.type === 'turn');
  const end = lines.find((l): l is TranscriptEnd => l.type === 'end');

  console.log('');
  console.log(c.bold(`━━ ${r.model} · ${r.condition} · ${r.caseId} · r${r.rep}`) + `  ${statusColor(r.status)}  ${scoreStr(r)}`);
  console.log(c.dim(`   ${r.provider}/${r.providerModel} · ${rel}`));
  if (!lines.length) {
    console.log(c.yellow(`   (no transcript at ${rel})`));
    if (r.error) console.log(c.red(`   ${r.error.kind}: ${r.error.message}`));
    return;
  }
  if (header) console.log(c.dim(`   prompt: ${clip(header.userPrompt, 200)}`));
  for (const t of turns) printTurn(t);
  printEnd(end, r);
}

/** Prints turn-by-turn timelines for sessions in a run dir matching `filter`. */
export function inspectRun(runDir: string, filter: InspectFilter = {}): void {
  const records = readSessionsFile(runDir);
  if (!records.length) {
    console.log(c.yellow(`No sessions found in ${path.join(runDir, 'sessions.jsonl')}`));
    return;
  }
  const hits = records.filter((r) => matches(r, filter));
  if (!hits.length) {
    console.log(c.yellow('No sessions match the filter.'));
    console.log(c.dim(`  models: ${[...new Set(records.map((r) => r.model))].join(', ')}`));
    console.log(c.dim(`  conditions: ${[...new Set(records.map((r) => r.condition))].join(', ')}`));
    console.log(c.dim(`  cases: ${[...new Set(records.map((r) => r.caseId))].join(', ')}`));
    return;
  }
  const noFilter = !filter.model && !filter.condition && !filter.caseId && filter.rep === undefined;
  if (hits.length > LIST_THRESHOLD || (noFilter && hits.length > 1)) {
    console.log(c.bold(`${hits.length} matching sessions in ${runDir}:`));
    for (const r of hits) console.log(listLine(r));
    console.log(c.dim('\nNarrow down with --model <id> --condition <cli|cli+skills|mcp|mcp+skills> --case <id> --rep <n> to see turn-by-turn timelines.'));
    return;
  }
  for (const r of hits) printSession(runDir, r);
}
