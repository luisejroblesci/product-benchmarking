export type ToolConfig = 'cli' | 'mcp-builtin' | 'mcp-remote' | 'api-v1' | 'api-v2' | 'all';

// SSE event union shared by server + runner
export type BenchEvent =
  // UC1
  | { type: 'run:start'; total: number; repo: string }
  | { type: 'commit:start'; sha: string; message: string; index: number }
  | { type: 'commit:sidecar'; sha: string; durationMs: number; status: string }
  | { type: 'commit:traditional'; sha: string; durationMs: number; status: string }
  | { type: 'commit:skip'; sha: string; reason: string }
  | { type: 'run:done'; speedupFactor: number; avgSidecarMs: number; avgTraditionalMs: number }
  // UC2
  | { type: 'uc2:run:start'; suite: string; totalCases: number; configs: string[]; cases: string[] }
  | { type: 'uc2:case:start'; caseId: string; config: string }
  | {
      type: 'uc2:case:turn';
      caseId: string; config: string; turn: number; totalTokens: number;
      toolsUsed: string[];
      assistantText: string;
      toolCalls: Array<{ name: string; input: unknown }>;
    }
  | {
      type: 'uc2:case:done';
      caseId: string; config: string; turns: number; totalTokens: number;
      durationMs: number; success: boolean; toolsUsed: string[];
    }
  | {
      type: 'uc2:config:done';
      config: string;
      summary: { avgTurns: number; totalTokens: number; avgDurationMs: number; successRate: number };
    }
  | {
      type: 'uc2:run:done';
      crossConfigSummary: { fastestConfig: string; lowestTokenConfig: string; fewestTurnsConfig: string };
      resultFile: string;
    };

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

// UC2 types
export interface TurnEntry {
  turn: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: Array<{ name: string; input: unknown; result: string }>;
  assistantText: string;
}

export interface CaseMetric {
  id: string;
  prompt: string;
  tags: string[];
  turns: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  toolsUsed: string[];
  success: boolean;
  turnLog: TurnEntry[];
}

export interface ConfigResult {
  tools: ToolConfig[];
  cases: CaseMetric[];
  summary: {
    avgTurns: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    avgDurationMs: number;
    successRate: number;
  };
}

export interface UC2RunResult {
  runId: string;
  timestamp: string;
  suite: string;
  configs: ConfigResult[];
  crossConfigSummary: {
    fastestConfig: string;
    lowestTokenConfig: string;
    fewestTurnsConfig: string;
  };
}

// Prompt suite
export interface PromptCase {
  id: string;
  prompt: string;
  tags: string[];
}

export interface PromptSuite {
  suite: string;
  description: string;
  cases: PromptCase[];
}
