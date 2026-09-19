import { spawn } from 'child_process';
import * as readline from 'readline';
import type { CaseMetric, PromptCase, TurnEntry } from '../../core/types.js';
import type { SessionConfig } from './tools/index.js';

const CIRCLECI_SKILL_PROMPT =
  'You are a CircleCI expert assistant. Use the available CircleCI tools to help ' +
  'users understand their CI/CD pipelines, debug failures, and optimize workflows. ' +
  'Always provide actionable insights based on actual pipeline data.';

export interface TurnData {
  turn: number;
  inputTokens: number;
  outputTokens: number;
  toolsUsed: string[];
  assistantText: string;
  toolCalls: Array<{ name: string; input: unknown }>;
}

export interface AgentRunOptions {
  onTurn?: (data: TurnData) => void;
}

export async function runAgentCase(
  promptCase: PromptCase,
  sessionConfig: SessionConfig,
  options: AgentRunOptions = {}
): Promise<CaseMetric> {
  const start = Date.now();

  const args = [
    '-p', promptCase.prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
  ];
  if (sessionConfig.mcpConfigPath) args.push('--mcp-config', sessionConfig.mcpConfigPath);
  if (sessionConfig.withSkill) args.push('--append-system-prompt', CIRCLECI_SKILL_PROMPT);

  const proc = spawn('claude', args, { env: { ...process.env } });
  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });

  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const toolsUsed = new Set<string>();
  const turnLog: TurnEntry[] = [];
  let success = false;
  let spawnError: Error | undefined;

  await new Promise<void>((resolve) => {
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(line); } catch { return; }

      if (obj.type === 'assistant') {
        turns++;
        type Block = { type: string; name?: string; input?: unknown; text?: string };
        const msg = obj.message as {
          content?: Block[];
          usage?: { input_tokens: number; output_tokens: number };
        };
        const turnInput = msg.usage?.input_tokens ?? 0;
        const turnOutput = msg.usage?.output_tokens ?? 0;
        inputTokens += turnInput;
        outputTokens += turnOutput;

        const toolBlocks = (msg.content ?? []).filter((b) => b.type === 'tool_use');
        const toolNames = toolBlocks.map((b) => b.name ?? '').filter(Boolean);
        for (const t of toolNames) toolsUsed.add(t);

        const assistantText = (msg.content ?? [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('');

        const toolCalls = toolBlocks.map((b) => ({ name: b.name ?? '', input: b.input }));

        turnLog.push({
          turn: turns,
          inputTokens: turnInput,
          outputTokens: turnOutput,
          toolCalls,
          assistantText,
        });

        options.onTurn?.({
          turn: turns,
          inputTokens,
          outputTokens,
          toolsUsed: toolNames,
          assistantText,
          toolCalls,
        });
      }

      if (obj.type === 'result') {
        success = (obj.subtype as string) === 'success' && !(obj.is_error as boolean);
        const usage = obj.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        if (usage) {
          inputTokens = usage.input_tokens ?? inputTokens;
          outputTokens = usage.output_tokens ?? outputTokens;
        }
        if (typeof obj.num_turns === 'number') turns = obj.num_turns;
      }
    });

    proc.on('error', (err) => { spawnError = err; resolve(); });
    rl.on('close', resolve);
  });

  if (spawnError) {
    throw new Error(`Failed to spawn claude: ${spawnError.message}. Is the claude CLI installed?`);
  }

  return {
    id: promptCase.id,
    prompt: promptCase.prompt,
    tags: promptCase.tags,
    turns,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    durationMs: Date.now() - start,
    toolsUsed: Array.from(toolsUsed),
    success,
    turnLog,
  };
}
