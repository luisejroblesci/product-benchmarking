import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ToolConfig } from '../../../core/types.js';

export interface SessionConfig {
  tools: ToolConfig[];
  mcpConfigPath?: string;
  withSkill: boolean;
}

export function buildSessionConfig(
  configs: ToolConfig[],
  circleciToken: string,
  withSkill = false
): SessionConfig {
  const resolved: ToolConfig[] = configs.includes('all')
    ? ['mcp-builtin', 'mcp-remote']
    : configs;

  const mcpServers: Record<string, object> = {};

  if (resolved.includes('mcp-remote')) {
    mcpServers['circleci-remote'] = {
      type: 'sse',
      url: 'https://mcp.circleci.com/sse',
      headers: { Authorization: `Bearer ${circleciToken}` },
    };
  }

  if (resolved.includes('mcp-builtin') || resolved.includes('cli')) {
    mcpServers['circleci'] = {
      type: 'stdio',
      command: 'circleci',
      args: ['mcp', 'serve'],
      env: { CIRCLECI_CLI_TOKEN: circleciToken },
    };
  }

  if (Object.keys(mcpServers).length === 0) {
    // api-v1, api-v2 — no MCP; runs as a no-tools baseline
    return { tools: configs, withSkill };
  }

  const configPath = join(
    tmpdir(),
    `bench-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2));

  return { tools: configs, mcpConfigPath: configPath, withSkill };
}

export function cleanupSessionConfig(config: SessionConfig): void {
  if (config.mcpConfigPath) {
    try { unlinkSync(config.mcpConfigPath); } catch {}
  }
}
