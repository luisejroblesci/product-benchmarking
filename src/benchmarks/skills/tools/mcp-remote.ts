import axios from 'axios';
import type Anthropic from '@anthropic-ai/sdk';

// Remote MCP adapter — calls the CircleCI Remote MCP endpoint
// Docs: https://circleci.com/docs/guides/toolkit/circleci-mcp-overview/
const MCP_BASE = 'https://mcp.circleci.com';

export function buildMcpRemoteTools(token: string): Anthropic.Tool[] {
  return [
    {
      name: 'mcp_remote_get_pipelines',
      description: 'Get recent pipelines via CircleCI Remote MCP',
      input_schema: {
        type: 'object' as const,
        properties: {
          project_slug: { type: 'string', description: 'e.g. github/org/repo' },
        },
        required: ['project_slug'],
      },
    },
    {
      name: 'mcp_remote_get_workflow_status',
      description: 'Get workflow status for a pipeline via CircleCI Remote MCP',
      input_schema: {
        type: 'object' as const,
        properties: {
          pipeline_id: { type: 'string' },
        },
        required: ['pipeline_id'],
      },
    },
  ];
}

export async function handleMcpRemoteToolCall(
  name: string,
  input: Record<string, string>,
  token: string
): Promise<string> {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  try {
    if (name === 'mcp_remote_get_pipelines') {
      const res = await axios.post(
        `${MCP_BASE}/tools/call`,
        { name: 'get_pipelines', arguments: { project_slug: input.project_slug } },
        { headers }
      );
      return JSON.stringify(res.data);
    }
    if (name === 'mcp_remote_get_workflow_status') {
      const res = await axios.post(
        `${MCP_BASE}/tools/call`,
        { name: 'get_workflow_status', arguments: { pipeline_id: input.pipeline_id } },
        { headers }
      );
      return JSON.stringify(res.data);
    }
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  } catch (err) {
    return JSON.stringify({ error: String(err) });
  }
}
