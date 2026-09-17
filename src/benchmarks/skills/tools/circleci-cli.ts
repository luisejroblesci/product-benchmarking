import { execFile } from 'child_process';
import { promisify } from 'util';
import type Anthropic from '@anthropic-ai/sdk';

const execFileAsync = promisify(execFile);

export function buildCircleCICliTools(): Anthropic.Tool[] {
  return [
    {
      name: 'circleci_cli_pipeline_list',
      description: 'List recent pipelines using the CircleCI CLI',
      input_schema: {
        type: 'object' as const,
        properties: {
          org_slug: { type: 'string', description: 'Org slug, e.g. github/myorg' },
        },
        required: ['org_slug'],
      },
    },
    {
      name: 'circleci_cli_context_list',
      description: 'List CircleCI contexts for an org using the CircleCI CLI',
      input_schema: {
        type: 'object' as const,
        properties: {
          org_id: { type: 'string', description: 'CircleCI org ID' },
        },
        required: ['org_id'],
      },
    },
    {
      name: 'circleci_cli_config_validate',
      description: 'Validate a CircleCI config file using the CLI',
      input_schema: {
        type: 'object' as const,
        properties: {
          config_path: { type: 'string', description: 'Path to .circleci/config.yml' },
        },
        required: ['config_path'],
      },
    },
  ];
}

export async function handleCircleCICliToolCall(
  name: string,
  input: Record<string, string>
): Promise<string> {
  try {
    if (name === 'circleci_cli_pipeline_list') {
      const { stdout } = await execFileAsync('circleci', [
        'pipeline', 'list', '--org-slug', input.org_slug,
      ]);
      return stdout;
    }
    if (name === 'circleci_cli_context_list') {
      const { stdout } = await execFileAsync('circleci', [
        'context', 'list', 'github', input.org_id,
      ]);
      return stdout;
    }
    if (name === 'circleci_cli_config_validate') {
      const { stdout } = await execFileAsync('circleci', [
        'config', 'validate', input.config_path,
      ]);
      return stdout;
    }
    return JSON.stringify({ error: `Unknown tool: ${name}` });
  } catch (err: unknown) {
    return JSON.stringify({ error: String(err) });
  }
}
