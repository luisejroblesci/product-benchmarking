// CLI tool surface: a single `circleci` tool that runs the real CircleCI CLI with
// arbitrary arguments (no shell), isolated to the session's temp HOME/cwd.
import { execFile } from 'child_process';
import { tool } from 'ai';
import { z } from 'zod';
import type { BenchConfig } from '../../../core/types.js';
import type { SurfaceContext, ToolSurface } from '../contracts.js';

const MAX_BUFFER = 10 * 1024 * 1024;

/** Neutral note about the benchmark target, shared by the CLI and MCP surfaces. */
export function targetNote(cfg: BenchConfig): string {
  const { projectSlug, orgSlug } = cfg.target;
  return orgSlug
    ? `Target CircleCI project: ${projectSlug} (organization: ${orgSlug}).`
    : `Target CircleCI project: ${projectSlug}.`;
}

/**
 * Minimal env for the CLI. The CLI reads its token from CIRCLE_TOKEN (see `circleci help environment`);
 * CIRCLECI_CLI_TOKEN / CIRCLECI_TOKEN are also set for compatibility with older CLI builds.
 */
export function cliEnv(cfg: BenchConfig, home: string): NodeJS.ProcessEnv {
  const token = process.env[cfg.cli.tokenEnv] ?? '';
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    CIRCLE_TOKEN: token,
    CIRCLECI_CLI_TOKEN: token,
    CIRCLECI_TOKEN: token,
    NO_COLOR: '1',
    CIRCLE_NO_INTERACTIVE: '1',
    CIRCLE_NO_PAGER: '1',
    CIRCLE_SPINNER_DISABLED: '1',
    CIRCLE_NO_TELEMETRY: '1',
    PAGER: 'cat',
  };
}

export interface CliRunResult { output: string; exitCode: number; isError: boolean; durationMs: number }

/** Run the CLI once. Never throws: failures come back as isError with the error text in `output`. */
export function runCli(
  cfg: BenchConfig,
  args: string[],
  sessionDir: string,
  abortSignal?: AbortSignal,
  cwd: string = sessionDir,
): Promise<CliRunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let child: ReturnType<typeof execFile>;
    try {
      child = execFile(
        cfg.cli.binary,
        args,
        {
          cwd,
          env: cliEnv(cfg, sessionDir),
          timeout: cfg.toolTimeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: MAX_BUFFER,
          signal: abortSignal,
          encoding: 'utf8',
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          const durationMs = Date.now() - started;
          const out = String(stdout ?? '');
          const errOut = String(stderr ?? '');
          let exitCode = 0;
          let note = '';
          if (err) {
            const e = err as NodeJS.ErrnoException & { code?: unknown; killed?: boolean; signal?: string | null };
            if (typeof e.code === 'number') {
              exitCode = e.code;
            } else {
              exitCode = -1;
              if (e.name === 'AbortError') note = 'command aborted (session cancelled)';
              else if (e.killed || e.signal) note = `command timed out after ${cfg.toolTimeoutMs}ms`;
              else if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') note = `output exceeded ${MAX_BUFFER} bytes; truncated`;
              else note = e.message;
            }
          }
          const parts: string[] = [];
          if (out) parts.push(out.replace(/\s+$/, ''));
          if (errOut) parts.push(`[stderr]\n${errOut.replace(/\s+$/, '')}`);
          if (note) parts.push(`[error] ${note}`);
          parts.push(`[exit code: ${exitCode}]`);
          resolve({ output: parts.join('\n'), exitCode, isError: exitCode !== 0, durationMs });
        },
      );
    } catch (err) {
      resolve({ output: `[error] ${String(err)}\n[exit code: -1]`, exitCode: -1, isError: true, durationMs: Date.now() - started });
      return;
    }
    // Nothing is ever piped in; close stdin so a stray prompt can't block until timeout.
    child.stdin?.end();
  });
}

export async function createCliSurface(ctx: SurfaceContext): Promise<ToolSurface> {
  const cfg = ctx.config;
  const callMeta: ToolSurface['callMeta'] = new Map();

  const circleci = tool({
    description:
      'Runs the CircleCI CLI (`circleci`) with the given arguments and returns its stdout, stderr and exit code. ' +
      'Pass the arguments without the leading `circleci`, e.g. ["run", "list", "--project", "gh/org/repo"]. ' +
      'No shell is used, so pipes, redirects and globbing are not available. ' +
      'Top-level commands include: run, workflow, job, pipeline, project, testresult, artifact, config, ' +
      'context, envvar, org, orb, policy, my, version. ' +
      '`--help` works on every command and subcommand (e.g. ["job", "--help"]); many commands support `--json`.',
    inputSchema: z.object({
      args: z.array(z.string()).describe('Arguments passed to the circleci binary, one element per argument.'),
    }),
    execute: async ({ args }, { toolCallId, abortSignal }) => {
      const signal = abortSignal && ctx.abortSignal
        ? AbortSignal.any([abortSignal, ctx.abortSignal])
        : (abortSignal ?? ctx.abortSignal);
      const r = await runCli(cfg, args, ctx.sessionDir, signal, ctx.workspaceDir ?? ctx.sessionDir);
      callMeta.set(toolCallId, { isError: r.isError, exitCode: r.exitCode, durationMs: r.durationMs });
      return r.output;
    },
  });

  return {
    kind: 'cli',
    tools: { circleci },
    systemPromptAddendum:
      'The CircleCI CLI (`circleci`) is available through the `circleci` tool. ' +
      'Run `--help` on any command to see its usage. ' + targetNote(cfg),
    callMeta,
    close: async () => {},
  };
}
