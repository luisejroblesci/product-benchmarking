// Loads Agent Skills (SKILL.md folders) from a pinned git ref and exposes them to a model
// with Claude Code-style progressive disclosure: names + descriptions in the system prompt,
// full instructions via `load_skill`, bundled files via `read_skill_file`.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tool } from 'ai';
import { z } from 'zod';
import type { BenchConfig } from '../../core/types.js';
import type { LoadSkills, CreateSkillsSurface, LoadedSkills, SkillMeta, ToolSurface } from './contracts.js';

const execFileP = promisify(execFile);

export const SKILL_TOOL_NAMES = ['load_skill', 'read_skill_file'] as const;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CACHE_ROOT = path.join(REPO_ROOT, '.cache', 'skills');
const MAX_FILE_BYTES = 200 * 1024;
const FULL_SHA = /^[0-9a-f]{40}$/i;

// ── git cache ────────────────────────────────────────────────────────────────

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileP('git', args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

async function headSha(dir: string): Promise<string | null> {
  if (!existsSync(path.join(dir, '.git'))) return null;
  try { return await git(dir, 'rev-parse', 'HEAD'); } catch { return null; }
}

/** Ensures `.cache/skills/<ref>` holds `repo` at `ref`; returns [dir, resolvedSha]. */
async function ensureCheckout(repo: string, ref: string): Promise<[string, string]> {
  const safeRef = ref.replace(/[^A-Za-z0-9._-]/g, '_');
  const dir = path.join(CACHE_ROOT, safeRef);

  // A full SHA is immutable: reuse the cache if HEAD already matches.
  // Branch/tag refs can move, so they are always re-fetched.
  const existing = await headSha(dir);
  if (existing && FULL_SHA.test(ref) && existing.toLowerCase() === ref.toLowerCase()) return [dir, existing];

  await fs.mkdir(CACHE_ROOT, { recursive: true });
  // Fetch into a temp dir, then swap in, so a crash never leaves a half-populated cache.
  const tmp = await fs.mkdtemp(path.join(CACHE_ROOT, `.tmp-${safeRef}-`));
  try {
    await git(tmp, 'init', '--quiet');
    await git(tmp, 'fetch', '--quiet', '--depth', '1', `https://github.com/${repo}.git`, ref);
    await git(tmp, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', 'FETCH_HEAD');
    const sha = await git(tmp, 'rev-parse', 'HEAD');
    if (FULL_SHA.test(ref) && sha.toLowerCase() !== ref.toLowerCase()) {
      throw new Error(`skills: fetched ${repo}@${ref} but HEAD is ${sha}`);
    }
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rename(tmp, dir);
    return [dir, sha];
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true });
    throw err;
  }
}

// ── SKILL.md parsing ────────────────────────────────────────────────────────

function unquote(v: string): string {
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s) as string; } catch { return s.slice(1, -1); }
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

/**
 * Minimal YAML frontmatter parser for top-level string keys: `key: value`, quoted values,
 * plain multi-line continuations, and folded (`>`) / literal (`|`) block scalars with chomping indicators.
 * Nested maps/lists are captured as raw text and ignored by callers.
 */
export function parseFrontmatter(src: string): { data: Record<string, string>; body: string } {
  const text = src.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(text);
  if (!m) return { data: {}, body: text };
  const lines = m[1].split('\n');
  const body = text.slice(m[0].length);
  const data: Record<string, string> = {};

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const km = /^([A-Za-z0-9_-]+):(?:[ \t]+(.*))?$/.exec(line);
    if (!km) { i++; continue; }
    const key = km[1];
    let raw = (km[2] ?? '').trim();
    if (!/^["']/.test(raw)) raw = raw.replace(/(^|\s)#.*$/, '').trim(); // plain scalars: drop trailing comment
    i++;

    // collect indented (or blank) continuation lines
    const cont: string[] = [];
    while (i < lines.length && (/^[ \t]+/.test(lines[i]) || lines[i].trim() === '')) {
      cont.push(lines[i]);
      i++;
    }
    while (cont.length && cont[cont.length - 1].trim() === '') cont.pop();

    const block = /^([|>])([+-]?)\d*$/.exec(raw);
    if (block) {
      const indent = Math.min(...cont.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
      const stripped = cont.map((l) => (l.trim() ? l.slice(Number.isFinite(indent) ? indent : 0) : ''));
      let value: string;
      if (block[1] === '|') {
        value = stripped.join('\n');
      } else {
        // folded: single newlines become spaces, blank lines become newlines
        value = '';
        for (const l of stripped) {
          if (l === '') value += '\n';
          else value += value && !value.endsWith('\n') ? ` ${l}` : l;
        }
      }
      value = value.replace(/\n+$/, '');
      data[key] = block[2] === '-' || value === '' ? value : `${value}\n`; // strip vs clip/keep chomping
    } else if (raw === '') {
      data[key] = cont.map((l) => l.trim()).join('\n'); // nested structure: raw text
    } else {
      // plain or quoted scalar, possibly continued on indented lines
      const joined = [raw, ...cont.map((l) => l.trim())].filter(Boolean).join(' ');
      data[key] = unquote(joined);
    }
  }
  return { data, body };
}

async function listFiles(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true });
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, r)));
    else if (e.isFile() && r !== 'SKILL.md') out.push(r);
  }
  return out.sort();
}

async function parseSkills(root: string): Promise<SkillMeta[]> {
  if (!existsSync(root)) throw new Error(`skills: path not found in checkout: ${root}`);
  const skills: SkillMeta[] = [];
  for (const e of await fs.readdir(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const skillMd = path.join(dir, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    const { data } = parseFrontmatter(await fs.readFile(skillMd, 'utf8'));
    const name = (data.name ?? '').trim() || e.name;
    const description = (data.description ?? '').replace(/\s+/g, ' ').trim();
    skills.push({ name, description, dir, files: await listFiles(dir) });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

// ── loadSkills (memoized per repo@ref@path) ────────────────────────────────

const loadCache = new Map<string, Promise<LoadedSkills>>();
const checkoutCache = new Map<string, Promise<[string, string]>>();

/** One checkout per repo@ref per process, shared by every loadSkills caller. */
function checkoutOnce(repo: string, ref: string): Promise<[string, string]> {
  const key = `${repo}@${ref}`;
  let p = checkoutCache.get(key);
  if (!p) {
    p = ensureCheckout(repo, ref);
    p.catch(() => checkoutCache.delete(key));
    checkoutCache.set(key, p);
  }
  return p;
}

export const loadSkills: LoadSkills = (cfg: BenchConfig['skills']) => {
  const key = `${cfg.repo}@${cfg.ref}:${cfg.path}`;
  let p = loadCache.get(key);
  if (!p) {
    p = (async () => {
      const [dir, resolvedSha] = await checkoutOnce(cfg.repo, cfg.ref);
      const root = path.join(dir, cfg.path);
      return { repo: cfg.repo, ref: cfg.ref, resolvedSha, root, skills: await parseSkills(root) };
    })();
    p.catch(() => loadCache.delete(key)); // allow retry after a failure
    loadCache.set(key, p);
  }
  return p;
};

// ── tool surface ────────────────────────────────────────────────────────────

export function buildSkillsAddendum(skills: LoadedSkills): string {
  const list = skills.skills.map((s) => `- ${s.name}: ${s.description}`).join('\n');
  return [
    '## Available skills',
    '',
    'Skills are packaged instructions for specific kinds of tasks. The following skills are available:',
    '',
    list,
    '',
    'Before starting a task that matches a skill\'s description, call `load_skill` with the skill name to read its full instructions, then follow them using the tools available to you. If a skill references bundled files, read them with `read_skill_file`. Only load skills that are relevant to the task.',
  ].join('\n');
}

export const createSkillsSurface: CreateSkillsSurface = (skills: LoadedSkills): ToolSurface => {
  const callMeta: ToolSurface['callMeta'] = new Map();
  const byName = new Map(skills.skills.map((s) => [s.name, s]));
  const validNames = skills.skills.map((s) => s.name).join(', ');
  const unknown = (name: string) => `Error: unknown skill "${name}". Valid skill names: ${validNames}`;

  const load_skill = tool({
    description: 'Load a skill by name and return its full instructions (SKILL.md) plus a list of bundled files.',
    inputSchema: z.object({ name: z.string().describe('Skill name, exactly as listed in "Available skills"') }),
    execute: async ({ name }, { toolCallId }) => {
      const t0 = Date.now();
      const skill = byName.get(name);
      if (!skill) {
        callMeta.set(toolCallId, { isError: true, durationMs: Date.now() - t0 });
        return unknown(name);
      }
      try {
        const { body } = parseFrontmatter(await fs.readFile(path.join(skill.dir, 'SKILL.md'), 'utf8'));
        const files = skill.files.length
          ? `\n\n---\nBundled files (read with read_skill_file):\n${skill.files.map((f) => `- ${f}`).join('\n')}`
          : '';
        callMeta.set(toolCallId, { isError: false, durationMs: Date.now() - t0 });
        return `# Skill: ${skill.name}\n\n${body.trim()}${files}`;
      } catch (err) {
        callMeta.set(toolCallId, { isError: true, durationMs: Date.now() - t0 });
        return `Error: failed to read skill "${name}": ${(err as Error).message}`;
      }
    },
  });

  const read_skill_file = tool({
    description: 'Read a file bundled with a skill (e.g. a reference or script listed by load_skill, or a relative path mentioned in its instructions).',
    inputSchema: z.object({
      name: z.string().describe('Skill name'),
      path: z.string().describe('File path relative to the skill directory, as listed by load_skill or referenced in the skill instructions'),
    }),
    execute: async ({ name, path: rel }, { toolCallId }) => {
      const t0 = Date.now();
      const fail = (msg: string) => {
        callMeta.set(toolCallId, { isError: true, durationMs: Date.now() - t0 });
        return msg;
      };
      const skill = byName.get(name);
      if (!skill) return fail(unknown(name));
      // Paths resolve relative to the skill dir. Anything under the skills root is allowed, because
      // skills cross-reference siblings (e.g. builds -> `../config/references/test-results.md`);
      // anything outside it is rejected.
      const target = path.resolve(skill.dir, rel);
      const inside = path.relative(skills.root, target);
      if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
        return fail(`Error: path "${rel}" is outside the skills directory`);
      }
      try {
        // Resolve symlinks too, so a link inside the skill can't escape it.
        const [realRoot, realTarget] = await Promise.all([fs.realpath(skills.root), fs.realpath(target)]);
        const realRel = path.relative(realRoot, realTarget);
        if (!realRel || realRel.startsWith('..') || path.isAbsolute(realRel)) {
          return fail(`Error: path "${rel}" is outside the skills directory`);
        }
        const stat = await fs.stat(realTarget);
        if (!stat.isFile()) return fail(`Error: "${rel}" is not a file. Bundled files: ${skill.files.join(', ') || '(none)'}`);
        const buf = await fs.readFile(realTarget);
        let content = buf.subarray(0, MAX_FILE_BYTES).toString('utf8');
        if (buf.length > MAX_FILE_BYTES) content += `\n\n[truncated: file is ${buf.length} bytes, showing first ${MAX_FILE_BYTES}]`;
        callMeta.set(toolCallId, { isError: false, durationMs: Date.now() - t0 });
        return content;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return fail(`Error: file "${rel}" not found in skill "${name}". Bundled files: ${skill.files.join(', ') || '(none)'}`);
        return fail(`Error: failed to read "${rel}": ${(err as Error).message}`);
      }
    },
  });

  return {
    kind: 'skills',
    tools: { load_skill, read_skill_file },
    systemPromptAddendum: buildSkillsAddendum(skills),
    callMeta,
    close: async () => {},
  };
};
