export type ToolConfig = 'cli' | 'mcp-builtin' | 'mcp-remote' | 'api-v1' | 'api-v2' | 'all';

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
