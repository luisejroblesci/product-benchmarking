// Per-session workspace: a fresh copy of the target repo, so questions like "is my config valid?"
// are asked from inside the project, as a developer would. The repo is fetched once per run into
// .cache/repos/, then copied into each session's temp dir (no state is shared between sessions).
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { tool } from 'ai';
import { z } from 'zod';
import type { BenchConfig } from '../../core/types.js';
import type { ToolSurface } from './contracts.js';

const execFileAsync = promisify(execFile);
const CACHE_ROOT = path.resolve('.cache/repos');
const MAX_READ_BYTES = 200 * 1024;
const MAX_LIST_ENTRIES = 500;

export interface WorkspaceCache { repo: string; ref: string; sha: string; dir: string }

const git = (cwd: string, ...args: string[]) =>
  execFileAsync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

const inflight = new Map<string, Promise<WorkspaceCache>>();

/** Fetches target.repo@target.ref into the cache (once per process) and returns the resolved commit. */
export function prepareWorkspaceCache(cfg: BenchConfig): Promise<WorkspaceCache> | null {
  const { repo, ref = 'main' } = cfg.target;
  if (!repo) return null;
  const key = `${repo}@${ref}`;
  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      const dir = path.join(CACHE_ROOT, repo.replace('/', '__'));
      const url = `https://github.com/${repo}.git`;
      if (!fs.existsSync(path.join(dir, '.git'))) {
        fs.mkdirSync(dir, { recursive: true });
        await git(dir, 'init', '--quiet');
        await git(dir, 'remote', 'add', 'origin', url);
      }
      await git(dir, 'fetch', '--quiet', '--depth', '1', 'origin', ref);
      const isSha = /^[0-9a-f]{40}$/.test(ref);
      // A named branch keeps its name so tools that read the current branch see the real one.
      await git(dir, 'checkout', '--quiet', '--force', ...(isSha ? ['FETCH_HEAD'] : ['-B', ref, 'FETCH_HEAD']));
      await git(dir, 'clean', '-fdxq');
      const sha = (await git(dir, 'rev-parse', 'HEAD')).stdout.trim();
      return { repo, ref, sha, dir };
    })();
    p.catch(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

/** Copies the cached checkout into <sessionDir>/workspace and returns that path. */
export function createWorkspace(cache: WorkspaceCache, sessionDir: string): string {
  const dest = path.join(sessionDir, path.basename(cache.repo));
  fs.cpSync(cache.dir, dest, { recursive: true, verbatimSymlinks: true });
  return dest;
}

function resolveInside(root: string, rel: string): string | null {
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  if (target.split(path.sep).includes('.git')) return null;
  try {
    const real = fs.realpathSync(target);
    const realRoot = fs.realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
  } catch { /* missing file: reported by the caller */ }
  return target;
}

/** Read-only file tools scoped to the workspace. Given to CLI and MCP sessions alike. */
export function createFilesSurface(workspaceDir: string, repo: string): ToolSurface {
  const callMeta: ToolSurface['callMeta'] = new Map();
  const done = (id: string, started: number, isError: boolean, out: string) => {
    callMeta.set(id, { isError, durationMs: Date.now() - started });
    return out;
  };

  const list_files = tool({
    description:
      'List files in the current project checkout (read-only). Paths are relative to the project root. ' +
      'Directories end with "/". Use recursive=true to walk subdirectories.',
    inputSchema: z.object({
      path: z.string().default('.').describe('Directory relative to the project root'),
      recursive: z.boolean().default(false),
    }),
    execute: async ({ path: rel, recursive }, { toolCallId }) => {
      const started = Date.now();
      const dir = resolveInside(workspaceDir, rel);
      if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
        return done(toolCallId, started, true, `Error: "${rel}" is not a directory in the project.`);
      const out: string[] = [];
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          if (e.name === '.git' || out.length >= MAX_LIST_ENTRIES) continue;
          const relPath = path.relative(workspaceDir, path.join(d, e.name));
          out.push(e.isDirectory() ? relPath + '/' : relPath);
          if (recursive && e.isDirectory()) walk(path.join(d, e.name));
        }
      };
      walk(dir);
      const more = out.length >= MAX_LIST_ENTRIES ? `\n… (stopped at ${MAX_LIST_ENTRIES} entries; list a subdirectory)` : '';
      return done(toolCallId, started, false, out.join('\n') + more);
    },
  });

  const read_file = tool({
    description: 'Read a text file from the current project checkout (read-only). Path is relative to the project root.',
    inputSchema: z.object({
      path: z.string().describe('File path relative to the project root, e.g. .circleci/config.yml'),
      offset: z.number().int().min(1).optional().describe('First line to read (1-based)'),
      limit: z.number().int().min(1).optional().describe('Number of lines to read'),
    }),
    execute: async ({ path: rel, offset, limit }, { toolCallId }) => {
      const started = Date.now();
      const file = resolveInside(workspaceDir, rel);
      if (!file) return done(toolCallId, started, true, `Error: "${rel}" is outside the project.`);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile())
        return done(toolCallId, started, true, `Error: "${rel}" does not exist or is not a file.`);
      let text = fs.readFileSync(file, 'utf-8');
      if (offset || limit) {
        const lines = text.split('\n');
        const start = (offset ?? 1) - 1;
        text = lines.slice(start, limit ? start + limit : undefined).join('\n');
      }
      if (Buffer.byteLength(text) > MAX_READ_BYTES)
        text = Buffer.from(text).subarray(0, MAX_READ_BYTES).toString('utf-8') + '\n… (truncated; use offset/limit)';
      return done(toolCallId, started, false, text);
    },
  });

  return {
    kind: 'files',
    tools: { list_files, read_file },
    systemPromptAddendum:
      `The current directory is a checkout of the ${repo} repository. ` +
      'You can inspect its files with the read-only list_files and read_file tools.',
    callMeta,
    close: async () => {},
  };
}
