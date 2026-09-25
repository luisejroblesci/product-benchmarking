// Hosted MCP tool surface: exposes the CircleCI remote MCP server's own tool list as-is.
// A fresh MCP client is opened per surface (i.e. per session) and closed afterwards.
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import type { ToolSet } from 'ai';
import type { BenchConfig } from '../../../core/types.js';
import type { SurfaceContext, ToolSurface } from '../contracts.js';
import { targetNote } from './circleci-cli.js';

async function connect(cfg: BenchConfig): Promise<MCPClient> {
  const token = process.env[cfg.mcp.tokenEnv];
  if (!token) throw new Error(`${cfg.mcp.tokenEnv} is not set`);
  return createMCPClient({
    transport: {
      type: 'http',
      url: cfg.mcp.url,
      headers: { Authorization: `Bearer ${token}` },
    },
  });
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const s = signals.filter((x): x is AbortSignal => !!x);
  return s.length === 0 ? undefined : s.length === 1 ? s[0] : AbortSignal.any(s);
}

export async function createMcpSurface(ctx: SurfaceContext): Promise<ToolSurface> {
  const cfg = ctx.config;
  const client = await connect(cfg);
  const callMeta: ToolSurface['callMeta'] = new Map();

  let raw: ToolSet;
  try {
    raw = (await client.tools()) as unknown as ToolSet;
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }

  const tools: ToolSet = {};
  for (const [name, t] of Object.entries(raw)) {
    const inner = t.execute;
    if (!inner) { tools[name] = t; continue; }
    const baseToModelOutput = t.toModelOutput;
    tools[name] = {
      ...t,
      // The CircleCI server returns most data only in `structuredContent` (the text content is
      // a one-line summary like "Found 2 run(s)"), and the SDK's default conversion forwards
      // `content` only. Append the structured content so the model sees the actual data.
      toModelOutput: async (opts: Parameters<NonNullable<typeof baseToModelOutput>>[0]) => {
        const base = baseToModelOutput
          ? await baseToModelOutput(opts)
          : ({ type: 'json', value: opts.output } as const);
        if (base.type !== 'content') return base;
        const out = opts.output as { structuredContent?: unknown; isError?: boolean } | null;
        const value = [...base.value];
        if (out?.isError && !(value[0]?.type === 'text' && value[0].text.startsWith('Error:'))) {
          value.unshift({ type: 'text', text: 'Error: the tool call failed.' });
        }
        if (out?.structuredContent !== undefined) value.push({ type: 'text', text: JSON.stringify(out.structuredContent) });
        return { type: 'content', value };
      },
      execute: async (input: unknown, options: Parameters<typeof inner>[1]) => {
        const started = Date.now();
        const signal = combineSignals(options?.abortSignal, ctx.abortSignal, AbortSignal.timeout(cfg.toolTimeoutMs));
        try {
          const result = await inner(input, { ...options, abortSignal: signal });
          const isError = !!(result && typeof result === 'object' && (result as { isError?: unknown }).isError === true);
          callMeta.set(options.toolCallId, { isError, durationMs: Date.now() - started });
          return result;
        } catch (err) {
          const e = err as Error;
          const msg = e?.name === 'TimeoutError' ? `tool call timed out after ${cfg.toolTimeoutMs}ms` : (e?.message ?? String(err));
          callMeta.set(options.toolCallId, { isError: true, durationMs: Date.now() - started });
          return errorResult(msg);
        }
      },
    } as typeof t;
  }

  const addendum = [client.instructions?.trim(), targetNote(cfg)].filter(Boolean).join('\n\n');

  return {
    kind: 'mcp',
    tools,
    systemPromptAddendum: addendum,
    callMeta,
    close: async () => { await client.close(); },
  };
}

/** Preflight: names of the tools the MCP server exposes. */
export async function listMcpTools(cfg: BenchConfig): Promise<string[]> {
  const client = await connect(cfg);
  try {
    const res = await client.listTools();
    return res.tools.map((t) => t.name);
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Preflight: an authenticated no-argument, read-only call. Uses `hello` when the server has it,
 * otherwise `get_me` (the hosted CircleCI server has no `hello` tool as of 2026-09).
 * Returns the text content, and throws when the call reports an error.
 */
export async function callMcpHello(cfg: BenchConfig): Promise<string> {
  const client = await connect(cfg);
  try {
    const names = new Set((await client.listTools()).tools.map((t) => t.name));
    const name = names.has('hello') ? 'hello' : names.has('get_me') ? 'get_me' : null;
    if (!name) throw new Error('MCP server exposes neither `hello` nor `get_me`');
    const res = await client.callTool({ name, arguments: {} });
    const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? [];
    const text = content.map((c) => (c.type === 'text' ? c.text ?? '' : JSON.stringify(c))).join('\n');
    if ((res as { isError?: boolean }).isError) throw new Error(`${name} returned an error: ${text}`);
    return `${name}: ${text}`;
  } finally {
    await client.close().catch(() => {});
  }
}
