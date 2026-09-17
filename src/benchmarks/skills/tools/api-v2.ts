import axios from 'axios';
import type Anthropic from '@anthropic-ai/sdk';

export function buildApiV2Tools(token: string): Anthropic.Tool[] {
  const headers = { 'Circle-Token': token, 'Content-Type': 'application/json' };

  return [
    {
      name: 'circleci_get_pipeline',
      description: 'Get the most recent pipelines for a project on CircleCI (API v2)',
      input_schema: {
        type: 'object' as const,
        properties: {
          org: { type: 'string', description: 'GitHub org or user name' },
          repo: { type: 'string', description: 'Repository name' },
          branch: { type: 'string', description: 'Branch to filter by (optional)' },
        },
        required: ['org', 'repo'],
      },
    },
    {
      name: 'circleci_get_workflow',
      description: 'Get workflows for a pipeline ID on CircleCI (API v2)',
      input_schema: {
        type: 'object' as const,
        properties: {
          pipeline_id: { type: 'string', description: 'CircleCI pipeline ID' },
        },
        required: ['pipeline_id'],
      },
    },
    {
      name: 'circleci_trigger_pipeline',
      description: 'Trigger a new pipeline for a project on CircleCI (API v2)',
      input_schema: {
        type: 'object' as const,
        properties: {
          org: { type: 'string' },
          repo: { type: 'string' },
          branch: { type: 'string' },
        },
        required: ['org', 'repo', 'branch'],
      },
    },
  ];

  // Tool call executor — attached separately via handleToolCall
}

export async function handleApiV2ToolCall(
  name: string,
  input: Record<string, string>,
  token: string
): Promise<string> {
  const h = { 'Circle-Token': token };
  try {
    if (name === 'circleci_get_pipeline') {
      const { org, repo, branch } = input;
      const params = branch ? { branch } : {};
      const res = await axios.get(
        `https://circleci.com/api/v2/project/github/${org}/${repo}/pipeline`,
        { headers: h, params }
      );
      return JSON.stringify(res.data);
    }
    if (name === 'circleci_get_workflow') {
      const res = await axios.get(
        `https://circleci.com/api/v2/pipeline/${input.pipeline_id}/workflow`,
        { headers: h }
      );
      return JSON.stringify(res.data);
    }
    if (name === 'circleci_trigger_pipeline') {
      const { org, repo, branch } = input;
      const res = await axios.post(
        `https://circleci.com/api/v2/project/github/${org}/${repo}/pipeline`,
        { branch },
        { headers: { ...h, 'Content-Type': 'application/json' } }
      );
      return JSON.stringify(res.data);
    }
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  } catch (err: unknown) {
    return JSON.stringify({ error: String(err) });
  }
}
