import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { generateText, stepCountIs, wrapLanguageModel } from 'ai';
import type { LanguageModelMiddleware, StepResult, ToolSet } from 'ai';
import type {
  BenchConfig, Condition, ErrorKind, ModelConfig, SessionKey, SessionRecord, SessionStatus,
  SessionTotals, ToolCallRecord, TranscriptTurn, UseCase, Usage, JudgeResult,
} from '../../core/types.js';
import type { LoadedSkills, RunWriter, ToolSurface } from './contracts.js';
import { resolveModel, providerOptionsFor, computeCost, toUsage, classifyProviderError } from './providers.js';
import { createSurfaceForCondition, mergeSurfaces } from './tools/index.js';
import { createSkillsSurface, SKILL_TOOL_NAMES } from './skills-loader.js';
import { judge, condenseTrace } from './judge.js';
import { spillToolOutput } from '../../core/storage.js';
import { createWorkspace, createFilesSurface } from './workspace.js';
import type { WorkspaceCache } from './workspace.js';

const BASE_SYSTEM_PROMPT =
  'You are an assistant helping a developer with their CircleCI projects. ' +
  'Answer the user\'s question using only the tools provided to you. ' +
  'Ground every claim in data you actually retrieved; if you cannot retrieve something, say so. ' +
  'Do not change anything in the project beyond what the user explicitly asks for. ' +
  'Finish with a clear, direct answer to the question.';

const MAX_PROVIDER_RETRIES = 3;

export interface SessionParams {
  runId: string;
  cfg: BenchConfig;
  model: ModelConfig;
  condition: Condition;
  useCase: UseCase;
  rep: number;
  writer: RunWriter;
  skills?: LoadedSkills;
  workspace?: WorkspaceCache;
  onTurn?: (key: SessionKey, turn: TranscriptTurn) => void;
}

class SessionError extends Error {
  constructor(public kind: ErrorKind, message: string) { super(message); }
}

/** Retries transient provider errors per model call, counting attempts for the trace. */
function retryMiddleware(counter: { retries: number }, signal: AbortSignal): LanguageModelMiddleware {
  return {
    wrapGenerate: async ({ doGenerate }) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await doGenerate();
        } catch (err) {
          const c = classifyProviderError(err);
          if (!c.retryable || attempt >= MAX_PROVIDER_RETRIES || signal.aborted) throw err;
          counter.retries++;
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt + Math.random() * 500));
        }
      }
    },
  };
}

function stringifyOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object' && 'content' in output && Array.isArray((output as { content: unknown[] }).content)) {
    // MCP-style { content: [{type:'text', text}] }
    const parts = (output as { content: Array<{ type?: string; text?: string }> }).content;
    if (parts.every((p) => p.type === 'text')) return parts.map((p) => p.text ?? '').join('\n');
  }
  try { return JSON.stringify(output, null, 2); } catch { return String(output); }
}

const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite, reasoning: a.reasoning + b.reasoning,
});

export async function runSession(p: SessionParams): Promise<SessionRecord> {
  const { cfg, model, condition, useCase, rep, runId, writer } = p;
  const key: SessionKey = { model: model.id, condition, caseId: useCase.id, rep };
  const startedAt = new Date();
  const tw = writer.openTranscript(key);
  const sessionDir = mkdtempSync(join(tmpdir(), 'bench-session-'));
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new SessionError('timeout', `session exceeded ${cfg.sessionTimeoutMs}ms`)), cfg.sessionTimeoutMs);

  const turns: TranscriptTurn[] = [];
  const retryCounter = { retries: 0 };
  let surface: ToolSurface | undefined;
  let status: SessionStatus = 'completed';
  let error: { kind: ErrorKind; message: string } | undefined;
  let finalAnswer = '';
  let judgeResult: JudgeResult | null = null;

  try {
    const workspaceDir = p.workspace ? createWorkspace(p.workspace, sessionDir) : undefined;
    const surfaces: ToolSurface[] = [];
    if (workspaceDir) surfaces.push(createFilesSurface(workspaceDir, p.workspace!.repo));
    surfaces.push(await createSurfaceForCondition(condition, { config: cfg, sessionDir, workspaceDir, abortSignal: abort.signal }));
    if (condition.endsWith('+skills')) {
      if (!p.skills) throw new SessionError('setup_error', 'skills condition without loaded skills');
      surfaces.push(createSkillsSurface(p.skills));
    }
    surface = mergeSurfaces(surfaces);
    const system = [BASE_SYSTEM_PROMPT, ...surfaces.map((s) => s.systemPromptAddendum).filter(Boolean)].join('\n\n');

    tw.append({
      type: 'session', runId, ...key, provider: model.provider, providerModel: model.model,
      systemPrompt: system, userPrompt: useCase.prompt, toolNames: Object.keys(surface.tools),
      skillsAvailable: condition.endsWith('+skills') ? p.skills!.skills.map((s) => s.name) : [],
      startedAt: startedAt.toISOString(),
    });

    const callMeta = surface.callMeta;
    let stepStart = Date.now();
    let retriesAtStepStart = 0;

    const onStepFinish = (step: StepResult<ToolSet>) => {
      const now = Date.now();
      const results = new Map<string, { output: unknown; isError: boolean }>();
      for (const part of step.content) {
        if (part.type === 'tool-result') results.set(part.toolCallId, { output: part.output, isError: false });
        if (part.type === 'tool-error') results.set(part.toolCallId, { output: String((part as { error?: unknown }).error), isError: true });
      }
      const toolCalls: ToolCallRecord[] = step.toolCalls.map((tc) => {
        const res = results.get(tc.toolCallId);
        const meta = callMeta.get(tc.toolCallId);
        const spilled = spillToolOutput(tw, tc.toolCallId, stringifyOutput(res?.output ?? ''));
        return {
          id: tc.toolCallId, name: tc.toolName, input: tc.input, ...spilled,
          isError: Boolean(res?.isError || meta?.isError), exitCode: meta?.exitCode, durationMs: meta?.durationMs,
        };
      });
      const skillLoaded = step.toolCalls
        .filter((tc) => tc.toolName === 'load_skill' && !callMeta.get(tc.toolCallId)?.isError)
        .map((tc) => String((tc.input as { name?: string })?.name ?? ''));
      const turn: TranscriptTurn = {
        type: 'turn', turn: turns.length + 1, startedAt: new Date(stepStart).toISOString(), durationMs: now - stepStart,
        reasoning: step.reasoningText || undefined, assistantText: step.text, toolCalls,
        skillLoaded: skillLoaded.length ? skillLoaded : undefined, usage: toUsage(step.usage),
        finishReason: step.finishReason, retries: retryCounter.retries - retriesAtStepStart,
      };
      turns.push(turn);
      tw.append(turn);
      p.onTurn?.(key, turn);
      stepStart = now;
      retriesAtStepStart = retryCounter.retries;
    };

    const result = await generateText({
      model: wrapLanguageModel({
        model: resolveModel(model) as Parameters<typeof wrapLanguageModel>[0]['model'],
        middleware: retryMiddleware(retryCounter, abort.signal),
      }),
      system,
      prompt: useCase.prompt,
      tools: surface.tools,
      stopWhen: stepCountIs(cfg.maxTurns),
      maxRetries: 0,
      abortSignal: abort.signal,
      providerOptions: providerOptionsFor(model) as never,
      onStepFinish,
    });

    finalAnswer = result.text;
    const last = turns[turns.length - 1];
    if (turns.length >= cfg.maxTurns && last?.finishReason === 'tool-calls') {
      status = 'error';
      error = { kind: 'max_turns', message: `stopped after ${cfg.maxTurns} turns without a final answer` };
    }
  } catch (err) {
    status = 'error';
    const reason = abort.signal.reason;
    if (err instanceof SessionError) error = { kind: err.kind, message: err.message };
    else if (abort.signal.aborted && reason instanceof SessionError) error = { kind: reason.kind, message: reason.message };
    else {
      const c = classifyProviderError(err);
      error = { kind: c.kind, message: c.message };
    }
    finalAnswer = turns.map((t) => t.assistantText).filter(Boolean).pop() ?? '';
  } finally {
    clearTimeout(timer);
    try { await surface?.close(); } catch { /* best effort */ }
    rmSync(sessionDir, { recursive: true, force: true });
  }

  // Judge anything that produced an answer (including max_turns partial answers).
  if (finalAnswer.trim() && (status === 'completed' || error?.kind === 'max_turns')) {
    try {
      judgeResult = await judge(cfg, useCase, finalAnswer, condenseTrace(turns));
    } catch (err) {
      if (status === 'completed') status = 'judge_error';
      error ??= { kind: 'judge_error', message: err instanceof Error ? err.message : String(err) };
    }
  } else if (status === 'completed') {
    // Finished cleanly but said nothing: a real failure, graded as zero without calling the judge.
    judgeResult = { score: 0, pass: false, reasoning: 'Empty final answer.', judgeModel: 'n/a' };
  }

  const totals = computeTotals(cfg, model, turns, startedAt, retryCounter.retries);
  const endedAt = new Date().toISOString();
  tw.append({ type: 'end', status, error, finalAnswer, totals, judge: judgeResult, endedAt });

  const record: SessionRecord = {
    runId, ...key, ...totals, provider: model.provider, providerModel: model.model, status, error,
    score: judgeResult?.score ?? null, pass: judgeResult?.pass ?? null, judgeReasoning: judgeResult?.reasoning ?? null,
    finalAnswer, transcriptPath: tw.relPath, startedAt: startedAt.toISOString(), endedAt,
  };
  writer.appendSession(record);
  return record;
}

function computeTotals(cfg: BenchConfig, model: ModelConfig, turns: TranscriptTurn[], startedAt: Date, retries: number): SessionTotals {
  const usage = turns.reduce((u, t) => addUsage(u, t.usage), emptyUsage());
  const calls = turns.flatMap((t) => t.toolCalls);
  const toolTimeMs = calls.reduce((s, c) => s + (c.durationMs ?? 0), 0);
  const durationMs = Date.now() - startedAt.getTime();
  const firstToolIdx = turns.findIndex((t) => t.toolCalls.length > 0);
  const skillCalls = new Set<string>(SKILL_TOOL_NAMES);
  return {
    turns: turns.length,
    usage,
    costUsd: computeCost(cfg.pricing, model.model, usage),
    durationMs,
    modelTimeMs: Math.max(0, turns.reduce((s, t) => s + t.durationMs, 0) - toolTimeMs),
    toolTimeMs,
    toolCallCount: calls.filter((c) => !skillCalls.has(c.name)).length,
    toolErrors: calls.filter((c) => c.isError).length,
    distinctTools: [...new Set(calls.map((c) => c.name))],
    firstToolTurn: firstToolIdx === -1 ? null : firstToolIdx + 1,
    skillsLoaded: [...new Set(turns.flatMap((t) => t.skillLoaded ?? []))],
    retries,
  };
}
