// Benchmark safety policy. Sessions run against a real CircleCI account, so anything that
// changes state beyond rerunning a workflow is refused, the same way for the CLI and MCP.
// The refusal goes back to the model as an error tool result, so the session carries on.
import type { ToolSurface } from '../contracts.js';

export const POLICY_NOTE =
  'Blocked by benchmark safety policy: this environment only allows read-only operations and workflow reruns.';

/** CLI commands that are never allowed (auth/config of the CLI itself, raw API, destructive admin areas). */
const BLOCKED_CLI_TOP = new Set([
  'auth', 'setting', 'onboard', 'mcp', 'api', 'dlc', 'certificate', 'signing-config', 'runner', 'completion',
]);

/** Subcommand words that change state. Any of these among the positional args blocks the call. */
const MUTATING_CLI_WORDS = new Set([
  'delete', 'set', 'create', 'cancel', 'trigger', 'publish', 'unpublish', 'purge', 'follow', 'unfollow',
  'link', 'unlink', 'promote', 'rollback', 'remove', 'rm', 'update', 'add', 'import', 'login', 'logout',
  'init', 'open', 'restriction', 'secret', 'increment', 'revoke', 'rotate', 'push', 'upload', 'enable',
  'disable', 'archive', 'approve',
]);

/** MCP tools that change state. rerun_workflow stays allowed. */
export const BLOCKED_MCP_TOOLS = new Set(['cancel_workflow', 'rollback_deploy_component']);

export function checkCliArgs(args: string[]): string | null {
  const positional = args.filter((a) => !a.startsWith('-'));
  if (args.includes('--help') || args.includes('-h') || positional[0] === 'help') return null;
  if (positional.length === 0) return null;
  if (BLOCKED_CLI_TOP.has(positional[0])) return `\`circleci ${positional[0]}\` is not available here.`;
  const bad = positional.slice(1, 4).find((w) => MUTATING_CLI_WORDS.has(w));
  return bad ? `\`${bad}\` changes state and is not available here.` : null;
}

/** Wraps a surface's tools so blocked calls return a policy error instead of executing. */
export function applySafetyPolicy(surface: ToolSurface): ToolSurface {
  for (const [name, t] of Object.entries(surface.tools)) {
    type Exec = (input: unknown, opts: { toolCallId: string }) => unknown;
    const mutable = t as unknown as { execute?: Exec };
    const exec = mutable.execute?.bind(t);
    if (!exec) continue;
    const refuse = (toolCallId: string, why: string) => {
      surface.callMeta.set(toolCallId, { isError: true, durationMs: 0 });
      const text = `${POLICY_NOTE} ${why}`;
      return surface.kind === 'mcp' ? { content: [{ type: 'text', text }], isError: true } : text;
    };
    mutable.execute = (input, opts) => {
      if (surface.kind === 'cli' && name === 'circleci') {
        const why = checkCliArgs(((input as { args?: string[] })?.args ?? []).map(String));
        if (why) return refuse(opts.toolCallId, why);
      }
      if (surface.kind === 'mcp' && BLOCKED_MCP_TOOLS.has(name)) return refuse(opts.toolCallId, `\`${name}\` changes state.`);
      return exec(input, opts);
    };
  }
  return surface;
}
