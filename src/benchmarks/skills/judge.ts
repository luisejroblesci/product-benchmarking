// LLM-as-judge for the use-cases benchmark.
//
// Structured output strategy: `generateText` + `output: Output.object({ schema })`, with NO tools
// and NO toolChoice. For @ai-sdk/anthropic the default `structuredOutputMode: 'auto'` maps this to
// native structured outputs (`output_config.format`) for every current Claude model, and the
// provider refuses to fall back to the forced-tool "jsonTool" path for models that reject forced
// tool_choice (claude-opus-5-5). Thinking is left at provider defaults (never disabled), and no
// sampling params are sent. If structured output fails for any reason (unsupported by the
// provider, schema mismatch, empty output), we retry once with a plain-text call that asks for
// JSON only, and parse the first JSON object out of the text.
//
// Pass rule: pass is computed deterministically as `score >= PASS_THRESHOLD` (3), not taken from
// the judge model, so pass rate is always consistent with the score. Rubrics express criteria,
// not pass rules.
import { generateText, Output, NoObjectGeneratedError } from 'ai';
import { z } from 'zod';
import type { BenchConfig, JudgeResult, TranscriptTurn, UseCase } from '../../core/types.js';
import type { Judge } from './contracts.js';
import { resolveModel, providerOptionsFor } from './providers.js';

export const PASS_THRESHOLD = 3;
const JUDGE_MAX_RETRIES = 3;
const JUDGE_MAX_OUTPUT_TOKENS = 8192;

export const GENERIC_RUBRIC: string[] = [
  'Correctness: every factual claim about the project (runs, workflows, jobs, tests, durations, errors) is grounded in the tool evidence in the trace.',
  'Relevance: the answer directly addresses the question that was asked, for the target project.',
  'Actionability: the answer gives concrete next steps, identifiers, or commands the user can act on.',
  'Honesty: no fabricated data; gaps or missing permissions/data are stated plainly rather than papered over.',
];

const judgeSchema = z.object({
  reasoning: z.string().describe('Brief justification, citing rubric criteria and trace evidence.'),
  score: z.number().int().describe('Integer 0-5.'),
});
type JudgeOutput = z.infer<typeof judgeSchema>;

type JudgeModelCfg = BenchConfig['judge'];

export interface StructuredCallOptions<T> {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  abortSignal?: AbortSignal;
  maxOutputTokens?: number;
  maxRetries?: number;
}

export interface StructuredCallResult<T> {
  value: T;
  /** 'structured' = native structured output parsed; 'text-fallback' = JSON parsed from plain text. */
  mode: 'structured' | 'text-fallback';
}

/** Extract and parse the first top-level JSON object from free text (handles ```json fences). */
export function parseJsonFromText(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text].filter((s): s is string => !!s);
  for (const c of candidates) {
    const start = c.indexOf('{');
    if (start < 0) continue;
    // Walk to the matching closing brace, respecting strings.
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try { return JSON.parse(c.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  throw new Error(`no JSON object found in judge output: ${text.slice(0, 200)}`);
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted || (err instanceof Error && err.name === 'AbortError');
}

/** HTTP status of a provider error, unwrapping RetryError.lastError / cause. */
function statusOf(err: unknown, depth = 0): number | undefined {
  if (!err || typeof err !== 'object' || depth > 4) return undefined;
  const e = err as { statusCode?: unknown; lastError?: unknown; cause?: unknown };
  if (typeof e.statusCode === 'number') return e.statusCode;
  return statusOf(e.lastError, depth + 1) ?? statusOf(e.cause, depth + 1);
}

/**
 * One structured-output call against the judge model: native structured output first, then a
 * plain-text JSON fallback. Shared by judge() and the preflight judge check.
 */
export async function judgeStructuredCall<T>(
  cfg: JudgeModelCfg,
  opts: StructuredCallOptions<T>,
): Promise<StructuredCallResult<T>> {
  const model = resolveModel(cfg);
  const providerOptions = providerOptionsFor(cfg);
  const maxRetries = opts.maxRetries ?? JUDGE_MAX_RETRIES;
  const maxOutputTokens = opts.maxOutputTokens ?? JUDGE_MAX_OUTPUT_TOKENS;

  let firstErr: unknown;
  let firstText = '';
  try {
    const res = await generateText({
      model,
      system: opts.system,
      prompt: opts.prompt,
      output: Output.object({ schema: opts.schema, name: 'judgement' }),
      maxRetries,
      maxOutputTokens,
      abortSignal: opts.abortSignal,
      ...(providerOptions ? { providerOptions } : {}),
    });
    firstText = res.text ?? '';
    try {
      return { value: opts.schema.parse(res.output), mode: 'structured' };
    } catch (e) {
      // Output missing/invalid: try parsing whatever text came back before another call.
      firstErr = e;
      if (firstText) {
        const parsed = opts.schema.safeParse(parseJsonSafe(firstText));
        if (parsed.success) return { value: parsed.data, mode: 'text-fallback' };
      }
    }
  } catch (e) {
    if (isAbort(e, opts.abortSignal)) throw e;
    // Auth, not-found, rate-limit and 5xx errors would fail the text fallback too; only a 400
    // (e.g. structured output unsupported) or a non-HTTP error is worth a second attempt.
    const status = statusOf(e);
    if (status !== undefined && status !== 400) throw e;
    firstErr = e;
    if (NoObjectGeneratedError.isInstance(e) && e.text) {
      const parsed = opts.schema.safeParse(parseJsonSafe(e.text));
      if (parsed.success) return { value: parsed.data, mode: 'text-fallback' };
    }
  }

  // Plain-text fallback: no output spec, no tools; ask for raw JSON.
  try {
    const res = await generateText({
      model,
      system: `${opts.system}\n\nRespond with ONLY a single JSON object, no prose and no code fences.`,
      prompt: opts.prompt,
      maxRetries,
      maxOutputTokens,
      abortSignal: opts.abortSignal,
      ...(providerOptions ? { providerOptions } : {}),
    });
    return { value: opts.schema.parse(parseJsonFromText(res.text)), mode: 'text-fallback' };
  } catch (e) {
    if (isAbort(e, opts.abortSignal)) throw e;
    const a = firstErr instanceof Error ? firstErr.message : String(firstErr);
    const b = e instanceof Error ? e.message : String(e);
    const err = new Error(`judge structured output failed: ${a.slice(0, 300)} | text fallback failed: ${b.slice(0, 300)}`);
    (err as Error & { cause?: unknown }).cause = e;
    throw err;
  }
}

function parseJsonSafe(text: string): unknown {
  try { return parseJsonFromText(text); } catch { return undefined; }
}

const JUDGE_SYSTEM = [
  'You are a strict, impartial grader for a CircleCI assistant benchmark.',
  'An AI agent was given a user question about a real CircleCI project and had tools (CircleCI CLI or CircleCI MCP) to query live data.',
  'You receive the question, a rubric, optionally a reference expectation, a condensed trace of the tool calls the agent made with their outputs, and the agent\'s final answer.',
  'Grade the FINAL ANSWER against the rubric. Rules:',
  '- Treat the tool trace as the only source of truth about the project. Penalize any specific claim (IDs, statuses, test names, durations, errors, people, numbers) that the trace does not support; fabricated data is a severe failure.',
  '- Judge the answer, not the tool choice: do not reward or penalize which tools or how many calls were used, only whether the answer is correct, grounded, and useful.',
  '- If the project genuinely lacks the requested data (per the trace), a clear, honest answer saying so with evidence can score well.',
  '- A reference expectation, when given, describes what a good answer looks like; the live data may differ, so prefer the trace when they conflict.',
  'Scoring (integer): 5 = fully correct, grounded, complete, actionable; 4 = correct and grounded with minor gaps; 3 = mostly correct and useful, some gaps or weak grounding; 2 = partially addresses the question or contains an unsupported claim; 1 = mostly wrong, ungrounded, or unhelpful; 0 = no answer, refusal, or fabricated.',
  'Keep reasoning under 150 words.',
].join('\n');

export function buildJudgePrompt(useCase: UseCase, finalAnswer: string, trace: string): string {
  const rubric = useCase.rubric?.length ? useCase.rubric : GENERIC_RUBRIC;
  const parts = [
    `<question>\n${useCase.prompt}\n</question>`,
    `<rubric>\n${rubric.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n</rubric>`,
  ];
  if (useCase.expected) parts.push(`<reference_expectation>\n${useCase.expected}\n</reference_expectation>`);
  parts.push(`<tool_trace>\n${trace.trim() || '(no tool calls)'}\n</tool_trace>`);
  parts.push(`<final_answer>\n${finalAnswer.trim() || '(empty)'}\n</final_answer>`);
  parts.push('Return JSON: {"reasoning": string, "score": integer 0-5}.');
  return parts.join('\n\n');
}

export const judge: Judge = async (cfg, useCase, finalAnswer, trace, abortSignal) => {
  const judgeModel = cfg.judge.id ?? cfg.judge.model;
  const { value } = await judgeStructuredCall<JudgeOutput>(cfg.judge, {
    system: JUDGE_SYSTEM,
    prompt: buildJudgePrompt(useCase, finalAnswer, trace),
    schema: judgeSchema,
    abortSignal,
  });
  const score = Math.max(0, Math.min(5, Math.round(value.score)));
  const result: JudgeResult = {
    score,
    pass: score >= PASS_THRESHOLD,
    reasoning: value.reasoning.trim(),
    judgeModel,
  };
  return result;
};

// ── trace condensing ──

function shortInput(input: unknown, max = 200): string {
  let s: string;
  if (input == null) s = '';
  else if (typeof input === 'string') s = input;
  else if (typeof input === 'object') {
    const o = input as Record<string, unknown>;
    // CLI-style inputs read best as a command line.
    if (Array.isArray(o.args) && o.args.every((a) => typeof a === 'string')) s = (o.args as string[]).join(' ');
    else if (typeof o.command === 'string' && Object.keys(o).length === 1) s = o.command;
    else { try { s = JSON.stringify(input); } catch { s = String(input); } }
  } else s = String(input);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Condense a transcript into a tool-call trace for the judge: one entry per tool call with its
 * name, short input, status, and the first ~600 chars of output. When the result exceeds maxChars,
 * whole entries are dropped from the middle (the first and last calls are the most informative).
 */
export function condenseTrace(turns: TranscriptTurn[], maxChars = 12000): string {
  const OUT_CHARS = 600;
  const entries: string[] = [];
  let n = 0;
  for (const t of turns) {
    for (const c of t.toolCalls ?? []) {
      n++;
      const status = c.isError ? ` [ERROR${c.exitCode != null ? ` exit=${c.exitCode}` : ''}]` : (c.exitCode != null && c.exitCode !== 0 ? ` [exit=${c.exitCode}]` : '');
      const out = (c.output ?? '').trim();
      const outShort = out.length > OUT_CHARS ? `${out.slice(0, OUT_CHARS)}… [+${out.length - OUT_CHARS} chars]` : out;
      const more = c.truncated ? ` (full output ${c.outputBytes} bytes)` : '';
      entries.push(`#${n} turn ${t.turn} ${c.name}(${shortInput(c.input)})${status}${more}\n${outShort || '(empty output)'}`);
    }
  }
  if (entries.length === 0) return '(no tool calls)';

  const sep = '\n\n';
  const full = entries.join(sep);
  if (full.length <= maxChars) return full;

  // Keep entries from both ends, alternating, until the budget is spent.
  const marker = (k: number) => `… [${k} tool call(s) omitted] …`;
  const budget = maxChars - marker(entries.length).length - sep.length * 2;
  const head: string[] = [];
  const tail: string[] = [];
  let used = 0, i = 0, j = entries.length - 1, takeHead = true;
  while (i <= j) {
    const e = takeHead ? entries[i] : entries[j];
    if (used + e.length + sep.length > budget) break;
    used += e.length + sep.length;
    if (takeHead) head.push(entries[i++]); else tail.unshift(entries[j--]);
    takeHead = !takeHead;
  }
  const omitted = entries.length - head.length - tail.length;
  if (head.length === 0 && tail.length === 0) {
    // A single entry is larger than the budget: hard-trim the middle of the text.
    const half = Math.floor((maxChars - 40) / 2);
    return `${full.slice(0, half)}\n… [trimmed] …\n${full.slice(-half)}`;
  }
  return [...head, marker(omitted), ...tail].join(sep);
}
