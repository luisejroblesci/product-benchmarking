import { execFile } from 'child_process';
import { promisify } from 'util';
import type Anthropic from '@anthropic-ai/sdk';

const execFileAsync = promisify(execFile);

// MCP built-in CLI adapter — invokes the CircleCI MCP server locally via the circleci CLI
export function buildMcpBuiltinTools(): Anthropic.Tool[] {
  return [
    {
      name: 'mcp_builtin_list_tools',
      description: 'List available tools from the CircleCI MCP built-in CLI server',
      input_schema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'mcp_builtin_call_tool',
      description: 'Call a tool on the CircleCI MCP built-in CLI server',
      input_schema: {
        type: 'object' as const,
        properties: {
          tool_name: { type: 'string', description: 'Name of the MCP tool to call' },
          arguments: { type: 'string', description: 'JSON-encoded arguments object' },
        },
        required: ['tool_name', 'arguments'],
      },
    },
  ];
}

export async function handleMcpBuiltinToolCall(
  name: string,
  input: Record<string, string>
): Promise<string> {
  try {
    if (name === 'mcp_builtin_list_tools') {
      const { stdout } = await execFileAsync('circleci', ['mcp', 'tools', 'list']);
      return stdout;
    }
    if (name === 'mcp_builtin_call_tool') {
      const args = JSON.parse(input.arguments ?? '{}') as Record<string, unknown>;
      const argFlags = Object.entries(args).flatMap(([k, v]) => [`--${k}`, String(v)]);
      const { stdout } = await execFileAsync('circleci', [
        'mcp', 'tools', 'call', input.tool_name, ...argFlags,
      ]);
      return stdout;
    }
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  } catch (err) {
    return JSON.stringify({ error: String(err) });
  }
}
