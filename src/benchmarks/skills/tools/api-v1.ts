import axios from 'axios';
import type Anthropic from '@anthropic-ai/sdk';

export function buildApiV1Tools(): Anthropic.Tool[] {
  return [
    {
      name: 'circleci_v1_get_build_summary',
      description: 'Get recent build summary for a project using CircleCI API v1.1',
      input_schema: {
        type: 'object' as const,
        properties: {
          username: { type: 'string', description: 'GitHub org or user' },
          project: { type: 'string', description: 'Repository name' },
          branch: { type: 'string', description: 'Branch name (optional)' },
          limit: { type: 'number', description: 'Max results (default 10)' },
        },
        required: ['username', 'project'],
      },
    },
    {
      name: 'circleci_v1_trigger_build',
      description: 'Trigger a new build for a project using CircleCI API v1.1',
      input_schema: {
        type: 'object' as const,
        properties: {
          username: { type: 'string' },
          project: { type: 'string' },
          branch: { type: 'string' },
        },
        required: ['username', 'project', 'branch'],
      },
    },
  ];
}

export async function handleApiV1ToolCall(
  name: string,
  input: Record<string, string | number>,
  token: string
): Promise<string> {
  const auth = { auth: { username: token, password: '' } };
  try {
    if (name === 'circleci_v1_get_build_summary') {
      const { username, project, branch, limit = 10 } = input as Record<string, string>;
      const branchPath = branch ? `/tree/${branch}` : '';
      const res = await axios.get(
        `https://circleci.com/api/v1.1/project/github/${username}/${project}${branchPath}`,
        { ...auth, params: { limit } }
      );
      return JSON.stringify(res.data);
    }
    if (name === 'circleci_v1_trigger_build') {
      const { username, project, branch } = input as Record<string, string>;
      const res = await axios.post(
        `https://circleci.com/api/v1.1/project/github/${username}/${project}/tree/${branch}`,
        {},
        auth
      );
      return JSON.stringify(res.data);
    }
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  } catch (err) {
    return JSON.stringify({ error: String(err) });
  }
}
