// Preflight checks for the use-cases benchmark. Every check runs in parallel and is timed;
// any failure should abort the run before a single session starts (see preflightOk()).
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { generateText, stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { ALL_CONDITIONS } from '../../core/types.js';
import type { BenchConfig, ModelConfig, PreflightCheck } from '../../core/types.js';
import type { RunPreflight } from './contracts.js';
import { checkEnv } from '../../core/config.js';
import { resolveModel, providerOptionsFor, classifyProviderError } from './providers.js';
import { judgeStructuredCall } from './judge.js';
import { createCliSurface, runCli } from './tools/circleci-cli.js';
import { listMcpTools, callMcpHello } from './tools/mcp-remote.js';
import { loadSkills } from './skills-loader.js';
import { prepareWorkspaceCache } from './workspace.js';
import fs from 'fs';

type CheckOutcome = { ok: boolean; detail: string };

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function timed(
  name: string,
  target: string,
  fn: () => Promise<CheckOutcome>,
  describeError: (err: unknown) => string = errText,
): Promise<PreflightCheck> {
  const started = Date.now();
  try {
    const r = await fn();
    return { name, target, ok: r.ok, detail: oneLine(r.detail), durationMs: Date.now() - started };
  } catch (err) {
    return { name, target, ok: false, detail: oneLine(describeError(err)), durationMs: Date.now() - started };
  }
}

const providerErr = (err: unknown) => {
  const c = classifyProviderError(err);
  return `${c.kind}: ${c.message}`;
};

/** Model ping: a real generateText with a trivial `echo` tool; passes only if the tool was called. */
async function pingModel(cfg: Omit<ModelConfig, 'id'>): Promise<CheckOutcome> {
  let echoed: string | null = null;
  const echo = tool({
    description: 'Echoes the given text back.',
    inputSchema: z.object({ text: z.string() }),
    execute: async ({ text }) => { echoed = text; return text; },
  });
  const providerOptions = providerOptionsFor(cfg);
  const res = await generateText({
    model: resolveModel(cfg),
    prompt: "Call the echo tool with text 'ok', then reply done.",
    tools: { echo },
    stopWhen: stepCountIs(2),
    maxOutputTokens: 1024,
    maxRetries: 2,
    ...(providerOptions ? { providerOptions } : {}),
  });
  const calls = res.steps.flatMap((s) => s.toolCalls).filter((c) => c.toolName === 'echo');
  if (calls.length === 0) {
    return { ok: false, detail: `no tool call (tool calling is required); finish=${res.finishReason}; text=${res.text.slice(0, 60)}` };
  }
  const tokens = res.totalUsage?.totalTokens;
  return { ok: true, detail: `echo(${JSON.stringify(echoed)}) called; reply=${JSON.stringify(res.text.slice(0, 40))}${tokens != null ? `; ${tokens} tok` : ''}` };
}

async function judgeStructured(cfg: BenchConfig['judge']): Promise<CheckOutcome> {
  const { value, mode } = await judgeStructuredCall(cfg, {
    system: 'You are a test harness. Follow the instruction exactly.',
    prompt: 'Return an object with ok set to true and word set to "ready".',
    schema: z.object({ ok: z.boolean(), word: z.string() }),
    maxOutputTokens: 2048,
    maxRetries: 2,
  });
  return { ok: value.ok === true, detail: `mode=${mode}; ${JSON.stringify(value)}` };
}

async function cliVersion(cfg: BenchConfig): Promise<CheckOutcome> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bench-preflight-cli-'));
  try {
    const r = await runCli(cfg, ['version'], dir);
    return { ok: !r.isError, detail: r.output.replace(/\[exit code: \d+\]/, '').trim() || `exit ${r.exitCode}` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Authenticated read-only call through the real CLI surface (same tool/env a session gets). */
async function cliAuth(cfg: BenchConfig): Promise<CheckOutcome> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bench-preflight-cli-'));
  const surface = await createCliSurface({ config: cfg, sessionDir: dir });
  try {
    const t = surface.tools.circleci as { execute?: (input: unknown, opts: unknown) => unknown } | undefined;
    if (!t?.execute) return { ok: false, detail: 'CLI surface has no executable `circleci` tool' };
    const args = ['run', 'list', '--project', cfg.target.projectSlug, '--limit', '1', '--json'];
    const toolCallId = 'preflight-cli-auth';
    const out = String(await t.execute({ args }, { toolCallId, messages: [] }));
    const meta = surface.callMeta.get(toolCallId);
    const failed = meta ? meta.isError : !/\[exit code: 0\]/.test(out);
    const body = out.replace(/\[exit code: -?\d+\]\s*$/, '').trim();
    if (failed) return { ok: false, detail: `circleci ${args.join(' ')} → exit ${meta?.exitCode ?? '?'}: ${body.slice(0, 200)}` };
    let summary = body.slice(0, 80);
    try {
      const parsed = JSON.parse(body) as unknown;
      const first = Array.isArray(parsed) ? parsed[0] : (parsed as { items?: unknown[] })?.items?.[0];
      const f = (first ?? {}) as Record<string, unknown>;
      summary = first
        ? `latest run ${String(f.number ?? f.id ?? '?')}${f.state || f.status ? ` (${String(f.state ?? f.status)})` : ''}`
        : 'authenticated; 0 runs';
    } catch { /* non-JSON output: keep the raw preview */ }
    return { ok: true, detail: `circleci run list --project … ok: ${summary}` };
  } finally {
    await surface.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

/** Tools the benchmark relies on; the hosted server has no `hello` (callMcpHello uses `get_me`). */
const EXPECTED_MCP_TOOLS = ['list_runs', 'get_job_logs', 'get_me'];

async function mcpTools(cfg: BenchConfig): Promise<CheckOutcome> {
  const names = await listMcpTools(cfg);
  if (names.length === 0) return { ok: false, detail: 'MCP server returned no tools' };
  const missing = EXPECTED_MCP_TOOLS.filter((n) => !names.includes(n));
  if (missing.length) return { ok: false, detail: `missing expected tools: ${missing.join(', ')}; got: ${names.join(', ')}` };
  return { ok: true, detail: `${names.length} tools: ${names.join(', ')}` };
}

async function mcpHello(cfg: BenchConfig): Promise<CheckOutcome> {
  const text = await callMcpHello(cfg);
  return { ok: true, detail: text };
}

async function skillsCheck(cfg: BenchConfig): Promise<CheckOutcome> {
  const s = await loadSkills(cfg.skills);
  const valid = s.skills.filter((k) => k.name?.trim() && k.description?.trim());
  const shaOk = s.resolvedSha === cfg.skills.ref;
  const problems: string[] = [];
  if (valid.length === 0) problems.push('no skill with name+description');
  if (!shaOk) problems.push(`resolvedSha ${s.resolvedSha} !== ref ${cfg.skills.ref}`);
  const list = valid.map((k) => k.name).join(', ');
  return {
    ok: problems.length === 0,
    detail: problems.length ? problems.join('; ') : `${valid.length} skills @ ${s.resolvedSha.slice(0, 12)}: ${list}`,
  };
}

async function configCheck(cfg: BenchConfig, models: ModelConfig[], conditions: BenchConfig['conditions']): Promise<CheckOutcome> {
  const problems: string[] = [];
  const missing = checkEnv(cfg, models);
  if (missing.length) problems.push(`missing env: ${missing.join(', ')}`);
  if (models.length === 0) problems.push('no models selected');
  if (conditions.length === 0) problems.push('no conditions selected');
  const bad = conditions.filter((c) => !ALL_CONDITIONS.includes(c));
  if (bad.length) problems.push(`unknown conditions: ${bad.join(', ')}`);
  return {
    ok: problems.length === 0,
    detail: problems.length ? problems.join('; ') : `env ok; ${models.length} model(s); conditions: ${conditions.join(', ')}`,
  };
}

export const runPreflight: RunPreflight = async (cfg, { models, conditions }) => {
  const jobs: Array<Promise<PreflightCheck>> = [];
  jobs.push(timed('config/env', 'bench.config', () => configCheck(cfg, models, conditions)));

  for (const m of models) {
    jobs.push(timed('model: tool call', `${m.id} (${m.provider}/${m.model})`, () => pingModel(m), providerErr));
  }
  const judgeTarget = `judge (${cfg.judge.provider}/${cfg.judge.model})`;
  jobs.push(timed('model: tool call', judgeTarget, () => pingModel(cfg.judge), providerErr));
  jobs.push(timed('judge: structured output', judgeTarget, () => judgeStructured(cfg.judge), providerErr));

  if (conditions.some((c) => c.startsWith('cli'))) {
    jobs.push(timed('cli: version', cfg.cli.binary, () => cliVersion(cfg)));
    jobs.push(timed('cli: auth read', cfg.target.projectSlug, () => cliAuth(cfg)));
  }
  if (conditions.some((c) => c.startsWith('mcp'))) {
    jobs.push(timed('mcp: list tools', cfg.mcp.url, () => mcpTools(cfg)));
    jobs.push(timed('mcp: hello/get_me', cfg.mcp.url, () => mcpHello(cfg)));
  }
  if (cfg.target.repo) {
    jobs.push(timed('workspace: checkout', `${cfg.target.repo}@${cfg.target.ref ?? 'main'}`, async () => {
      const ws = await prepareWorkspaceCache(cfg)!;
      const hasConfig = fs.existsSync(path.join(ws.dir, '.circleci', 'config.yml'));
      return { ok: true, detail: `${ws.sha.slice(0, 12)}${hasConfig ? ' · .circleci/config.yml present' : ' · no .circleci/config.yml'}` };
    }));
  }
  if (conditions.some((c) => c.includes('+skills'))) {
    jobs.push(timed('skills: load', `${cfg.skills.repo}@${cfg.skills.ref.slice(0, 12)}`, () => skillsCheck(cfg)));
  }

  // timed() never rejects, but allSettled keeps one bad check from hiding the others regardless.
  const settled = await Promise.allSettled(jobs);
  return settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : { name: `check #${i + 1}`, target: '?', ok: false, detail: oneLine(errText(s.reason)), durationMs: 0 },
  );
};

export function preflightOk(checks: PreflightCheck[]): boolean {
  return checks.length > 0 && checks.every((c) => c.ok);
}

export function printPreflight(checks: PreflightCheck[], log: (line: string) => void = console.log): void {
  const DETAIL_MAX = 100;
  const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const rows = checks.map((c) => ({
    mark: c.ok ? '✓' : '✗',
    name: c.name,
    target: trunc(c.target, 48),
    ms: `${c.durationMs}ms`,
    detail: trunc(oneLine(c.detail), DETAIL_MAX),
  }));
  const w = {
    name: Math.max(5, ...rows.map((r) => r.name.length)),
    target: Math.max(6, ...rows.map((r) => r.target.length)),
    ms: Math.max(4, ...rows.map((r) => r.ms.length)),
  };
  log(`  ${'check'.padEnd(w.name)}  ${'target'.padEnd(w.target)}  ${'time'.padStart(w.ms)}  detail`);
  for (const r of rows) {
    log(`${r.mark} ${r.name.padEnd(w.name)}  ${r.target.padEnd(w.target)}  ${r.ms.padStart(w.ms)}  ${r.detail}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  log(failed ? `Preflight: ${failed}/${checks.length} check(s) failed.` : `Preflight: all ${checks.length} checks passed.`);
}
