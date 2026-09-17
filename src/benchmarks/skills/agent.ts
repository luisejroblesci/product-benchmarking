import Anthropic from '@anthropic-ai/sdk';
import type { CaseMetric, PromptCase } from '../../core/types.js';
import type { ToolSet } from './tools/index.js';

const MAX_TURNS = 20;

export async function runAgentCase(
  promptCase: PromptCase,
  toolSet: ToolSet,
  apiKey: string
): Promise<CaseMetric> {
  const client = new Anthropic({ apiKey });
  const start = Date.now();

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: promptCase.prompt },
  ];

  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const toolsUsed = new Set<string>();
  let success = false;

  while (turns < MAX_TURNS) {
    turns++;

    const response = await client.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      tools: toolSet.tools,
      messages,
    });

    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;

    if (response.stop_reason === 'end_turn') {
      success = true;
      break;
    }

    if (response.stop_reason !== 'tool_use') {
      break;
    }

    // Collect tool calls
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    );

    // Push assistant message
    messages.push({ role: 'assistant', content: response.content });

    // Execute all tool calls and collect results
    const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolUseBlocks.map(async (block) => {
        toolsUsed.add(block.name);
        const result = await toolSet.handle(block.name, block.input as Record<string, string>);
        return {
          type: 'tool_result' as const,
          tool_use_id: block.id,
          content: result,
        };
      })
    );

    messages.push({ role: 'user', content: toolResults });
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
  };
}
