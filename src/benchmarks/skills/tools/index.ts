import type Anthropic from '@anthropic-ai/sdk';
import type { ToolConfig } from '../../../core/types.js';
import { buildApiV2Tools, handleApiV2ToolCall } from './api-v2.js';
import { buildApiV1Tools, handleApiV1ToolCall } from './api-v1.js';
import { buildCircleCICliTools, handleCircleCICliToolCall } from './circleci-cli.js';
import { buildMcpRemoteTools, handleMcpRemoteToolCall } from './mcp-remote.js';
import { buildMcpBuiltinTools, handleMcpBuiltinToolCall } from './mcp-builtin.js';

export interface ToolSet {
  tools: Anthropic.Tool[];
  handle: (name: string, input: Record<string, string>) => Promise<string>;
}

export function buildToolSet(configs: ToolConfig[], circleciToken: string): ToolSet {
  const allConfigs: ToolConfig[] = configs.includes('all')
    ? ['cli', 'mcp-builtin', 'mcp-remote', 'api-v1', 'api-v2']
    : configs;

  const tools: Anthropic.Tool[] = [];
  if (allConfigs.includes('api-v2')) tools.push(...buildApiV2Tools(circleciToken));
  if (allConfigs.includes('api-v1')) tools.push(...buildApiV1Tools());
  if (allConfigs.includes('cli')) tools.push(...buildCircleCICliTools());
  if (allConfigs.includes('mcp-remote')) tools.push(...buildMcpRemoteTools(circleciToken));
  if (allConfigs.includes('mcp-builtin')) tools.push(...buildMcpBuiltinTools());

  const handle = async (name: string, input: Record<string, string>): Promise<string> => {
    if (name.startsWith('circleci_get_') || name.startsWith('circleci_trigger_')) {
      return handleApiV2ToolCall(name, input, circleciToken);
    }
    if (name.startsWith('circleci_v1_')) {
      return handleApiV1ToolCall(name, input, circleciToken);
    }
    if (name.startsWith('circleci_cli_')) {
      return handleCircleCICliToolCall(name, input);
    }
    if (name.startsWith('mcp_remote_')) {
      return handleMcpRemoteToolCall(name, input, circleciToken);
    }
    if (name.startsWith('mcp_builtin_')) {
      return handleMcpBuiltinToolCall(name, input);
    }
    return JSON.stringify({ error: `No handler for tool: ${name}` });
  };

  return { tools, handle };
}
