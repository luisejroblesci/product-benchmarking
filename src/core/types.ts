// SSE event union shared by server + runner
export type BenchEvent =
  | UseCaseEvent
  // UC1
  | { type: 'run:start'; total: number; repo: string }
  | { type: 'commit:start'; sha: string; message: string; index: number }
  | { type: 'commit:sidecar'; sha: string; durationMs: number; status: string }
  | { type: 'commit:traditional'; sha: string; durationMs: number; status: string }
  | { type: 'commit:skip'; sha: string; reason: string }
  | { type: 'run:done'; speedupFactor: number; avgSidecarMs: number; avgTraditionalMs: number };

// UC1 types
export interface CommitResult {
  sha: string;
  message: string;
  sidecar: {
    durationMs: number;
    status: 'pass' | 'fail' | 'error';
    output?: string;
  };
  traditional: {
    pipelineId: string;
    durationMs: number;
    status: 'success' | 'failed' | 'error' | 'canceled';
  };
}

export interface UC1Summary {
  avgSidecarMs: number;
  avgTraditionalMs: number;
  p50SidecarMs: number;
  p50TraditionalMs: number;
  speedupFactor: number;
  passingCommits: { avgSidecarMs: number; avgTraditionalMs: number; count: number };
  failingCommits: { avgSidecarMs: number; avgTraditionalMs: number; count: number };
}

export interface UC1RunResult {
  runId: string;
  timestamp: string;
  repo: string;
  benchmarkBranch: string;
  commits: CommitResult[];
  summary: UC1Summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// Use-cases benchmark (UC2 v2): models × {cli, mcp} × {skills, no skills}
// ─────────────────────────────────────────────────────────────────────────────

export type Provider = 'anthropic' | 'openai' | 'google' | 'openai-compatible';
export type Condition = 'cli+skills' | 'cli' | 'mcp+skills' | 'mcp';
export const ALL_CONDITIONS: Condition[] = ['cli+skills', 'cli', 'mcp+skills', 'mcp'];
export type ToolSurfaceKind = 'cli' | 'mcp';

export interface ModelConfig {
  id: string;               // stable id used in results paths, e.g. "sonnet-5"
  enabled?: boolean;        // default true; false keeps the entry but skips it
  provider: Provider;
  model: string;            // provider model id, e.g. "claude-sonnet-5"
  apiKeyEnv: string;        // env var holding the key
  baseURL?: string;         // required for openai-compatible
  maxConcurrent?: number;   // per-model concurrency cap
  providerOptions?: Record<string, unknown>;
}

export interface PricingEntry { inPerMTok: number; outPerMTok: number; cacheReadPerMTok?: number; cacheWritePerMTok?: number }

export interface BenchConfig {
  models: ModelConfig[];
  judge: Omit<ModelConfig, 'id'> & { id?: string };
  conditions: Condition[];
  repetitions: number;
  maxTurns: number;
  concurrency: number;
  sessionTimeoutMs: number;
  toolTimeoutMs: number;
  circuitBreakerThreshold: number;
  skills: { repo: string; ref: string; path: string };
  mcp: { url: string; tokenEnv: string };
  cli: { binary: string; tokenEnv: string };
  target: { projectSlug: string; orgSlug?: string; repo?: string; ref?: string };  // repo: "owner/name" cloned as each session's workspace
  pricing: Record<string, PricingEntry>;   // keyed by provider model id
}

export interface UseCase {
  id: string;
  prompt: string;
  tags: string[];
  expected?: string;
  rubric?: string[];
}

export interface UseCaseSuite {
  suite: string;
  description: string;
  cases: UseCase[];
}

export type SessionStatus = 'completed' | 'error' | 'skipped' | 'judge_error';
export type ErrorKind = 'provider_error' | 'tool_error' | 'timeout' | 'max_turns' | 'judge_error' | 'setup_error' | 'unknown';

export interface SessionKey { model: string; condition: Condition; caseId: string; rep: number }

// input = total prompt tokens INCLUDING cacheRead/cacheWrite; output INCLUDES reasoning. Total tokens = input + output.
export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number }

// ── transcript lines (transcripts/<model>/<condition>/<caseId>.r<rep>.jsonl) ──
export interface TranscriptHeader extends SessionKey {
  type: 'session';
  runId: string;
  provider: Provider;
  providerModel: string;
  systemPrompt: string;
  userPrompt: string;
  toolNames: string[];
  skillsAvailable: string[];
  startedAt: string;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
  output: string;           // inline output or preview when spilled
  outputBytes: number;
  truncated: boolean;       // true when full output was spilled to blobPath
  blobPath?: string;        // relative to run dir
  isError: boolean;
  exitCode?: number;
  durationMs?: number;
}

export interface TranscriptTurn {
  type: 'turn';
  turn: number;             // 1-based
  startedAt: string;
  durationMs: number;
  reasoning?: string;
  assistantText: string;
  toolCalls: ToolCallRecord[];
  skillLoaded?: string[];
  usage: Usage;
  finishReason: string;
  retries: number;
}

export interface JudgeResult { score: number; pass: boolean; reasoning: string; judgeModel: string }

export interface SessionTotals {
  turns: number;
  usage: Usage;
  costUsd: number | null;
  durationMs: number;
  modelTimeMs: number;
  toolTimeMs: number;
  toolCallCount: number;
  toolErrors: number;
  distinctTools: string[];
  firstToolTurn: number | null;
  skillsLoaded: string[];
  retries: number;
}

export interface TranscriptEnd {
  type: 'end';
  status: SessionStatus;
  error?: { kind: ErrorKind; message: string };
  finalAnswer: string;
  totals: SessionTotals;
  judge: JudgeResult | null;
  endedAt: string;
}

export type TranscriptLine = TranscriptHeader | TranscriptTurn | TranscriptEnd;

// ── sessions.jsonl row ──
export interface SessionRecord extends SessionKey, SessionTotals {
  runId: string;
  provider: Provider;
  providerModel: string;
  status: SessionStatus;
  error?: { kind: ErrorKind; message: string };
  score: number | null;
  pass: boolean | null;
  judgeReasoning: string | null;
  finalAnswer: string;
  transcriptPath: string;   // relative to run dir
  startedAt: string;
  endedAt: string;
}

export interface PreflightCheck { name: string; target: string; ok: boolean; detail: string; durationMs: number }

export interface RunManifest {
  runId: string;
  startedAt: string;
  gitSha: string | null;
  suite: { name: string; path: string; sha256: string; caseIds: string[] };
  skills: { repo: string; ref: string; resolvedSha: string | null };
  circleciCliVersion: string | null;
  workspace: { repo: string; ref: string; sha: string } | null;
  config: BenchConfig;      // snapshot; contains env var NAMES only, never keys
  models: string[];
  conditions: Condition[];
  repetitions: number;
  preflight: PreflightCheck[];
}

export interface CellSummary {
  model: string;
  condition: Condition;
  sessions: number;
  completed: number;
  errors: number;
  skipped: number;
  judgeErrors: number;
  passRate: number | null;      // over completed + judged sessions
  meanScore: number | null;
  errorRate: number;
  avgTurns: number | null;
  avgTotalTokens: number | null;
  totalCostUsd: number | null;
  p50DurationMs: number | null;
  p90DurationMs: number | null;
  avgToolCalls: number | null;
  avgToolErrors: number | null;
}

export interface RunSummary {
  runId: string;
  generatedAt: string;
  cells: CellSummary[];                                 // model × condition
  byCase: Array<{
    caseId: string; condition: Condition; model: string; passRate: number | null; meanScore: number | null;
    avgTurns: number | null;   // over sessions that ran to completion
    unfinished: number;        // sessions that errored or were skipped (excluded from avgTurns)
  }>;
  skillsDelta: Array<{ model: string; surface: ToolSurfaceKind; passRateDelta: number | null; meanScoreDelta: number | null; tokensDelta: number | null }>;
}

// Live dashboard events for the use-cases benchmark
export type UseCaseEvent =
  | { type: 'uc:run:start'; runId: string; suite: string; models: string[]; conditions: Condition[]; cases: string[]; total: number }
  | { type: 'uc:preflight'; checks: PreflightCheck[] }
  | { type: 'uc:session:start'; key: SessionKey }
  | { type: 'uc:session:turn'; key: SessionKey; turn: TranscriptTurn }
  | { type: 'uc:session:done'; record: SessionRecord }
  | { type: 'uc:run:done'; runId: string; runDir: string; summary: RunSummary };
