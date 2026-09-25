// Loads and validates bench.config.json and use-case suites.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ALL_CONDITIONS } from './types.js';
import type { BenchConfig, Condition, ModelConfig, UseCaseSuite } from './types.js';
import type { LoadConfig, LoadSuite } from '../benchmarks/skills/contracts.js';

const PROVIDERS = ['anthropic', 'openai', 'google', 'openai-compatible'] as const;

const nonEmpty = z.string().trim().min(1);
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an environment variable name (e.g. ANTHROPIC_API_KEY), not a key value');

const modelFields = {
  enabled: z.boolean().optional(),
  provider: z.enum(PROVIDERS, { message: `provider must be one of: ${PROVIDERS.join(', ')}` }),
  model: nonEmpty,
  apiKeyEnv: envName,
  baseURL: z.url().optional(),
  maxConcurrent: z.number().int().positive().optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
};

function requireBaseURL(m: { provider: string; baseURL?: string }, ctx: z.RefinementCtx) {
  if (m.provider === 'openai-compatible' && !m.baseURL) {
    ctx.addIssue({ code: 'custom', path: ['baseURL'], message: 'baseURL is required when provider is "openai-compatible"' });
  }
}

const modelSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9._-]+$/, 'id may only contain letters, digits, ".", "_" and "-" (it is used in result paths)'), ...modelFields })
  .superRefine(requireBaseURL);
const judgeSchema = z.object({ id: z.string().optional(), ...modelFields }).superRefine(requireBaseURL);

const pricingSchema = z.object({
  inPerMTok: z.number().nonnegative(),
  outPerMTok: z.number().nonnegative(),
  cacheReadPerMTok: z.number().nonnegative().optional(),
  cacheWritePerMTok: z.number().nonnegative().optional(),
});

const conditionSchema = z.enum(ALL_CONDITIONS as [Condition, ...Condition[]], {
  message: `condition must be one of: ${ALL_CONDITIONS.join(', ')}`,
});

const configSchema = z.object({
  models: z.array(modelSchema).min(1, 'at least one model is required'),
  judge: judgeSchema,
  conditions: z.array(conditionSchema).min(1).default([...ALL_CONDITIONS]),
  repetitions: z.number().int().positive().default(3),
  maxTurns: z.number().int().positive().default(25),
  concurrency: z.number().int().positive().default(8),
  sessionTimeoutMs: z.number().int().positive().default(300_000),
  toolTimeoutMs: z.number().int().positive().default(60_000),
  circuitBreakerThreshold: z.number().int().positive().default(5),
  skills: z.object({
    repo: nonEmpty.default('CircleCI-Public/skills'),
    ref: nonEmpty,
    path: nonEmpty.default('plugins/circleci/skills'),
  }),
  mcp: z.object({
    url: z.url().default('https://mcp.circleci.com/v1/mcp'),
    tokenEnv: envName.default('CIRCLECI_TOKEN'),
  }).prefault({}),
  cli: z.object({
    binary: nonEmpty.default('circleci'),
    tokenEnv: envName.default('CIRCLECI_TOKEN'),
  }).prefault({}),
  target: z.object({
    projectSlug: nonEmpty, orgSlug: nonEmpty.optional(),
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'expected owner/name').optional(), ref: nonEmpty.optional(),
  }),
  pricing: z.record(z.string(), pricingSchema).default({}),
}).superRefine((cfg, ctx) => {
  const seen = new Set<string>();
  cfg.models.forEach((m, i) => {
    if (seen.has(m.id)) ctx.addIssue({ code: 'custom', path: ['models', i, 'id'], message: `duplicate model id "${m.id}"` });
    seen.add(m.id);
  });
  const conds = new Set<string>();
  cfg.conditions.forEach((c, i) => {
    if (conds.has(c)) ctx.addIssue({ code: 'custom', path: ['conditions', i], message: `duplicate condition "${c}"` });
    conds.add(c);
  });
});

const useCaseSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9._-]+$/, 'case id may only contain letters, digits, ".", "_" and "-" (it is used in result paths)'),
  prompt: nonEmpty,
  tags: z.array(z.string()).default([]),
  expected: z.string().optional(),
  rubric: z.array(nonEmpty).optional(),
});

const suiteSchema = z.object({
  suite: nonEmpty,
  description: z.string().default(''),
  cases: z.array(useCaseSchema).min(1, 'suite must contain at least one case'),
}).superRefine((s, ctx) => {
  const seen = new Set<string>();
  s.cases.forEach((c, i) => {
    if (seen.has(c.id)) ctx.addIssue({ code: 'custom', path: ['cases', i, 'id'], message: `duplicate case id "${c.id}"` });
    seen.add(c.id);
  });
});

function readJson(path: string, what: string): unknown {
  const abs = resolve(path);
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch (e) {
    throw new Error(`Cannot read ${what} at ${abs}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON in ${what} ${abs}: ${(e as Error).message}`);
  }
}

function formatIssues(err: z.ZodError): string {
  return err.issues
    .map((i) => `  - ${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('\n');
}

function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, what: string, path: string): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new Error(`Invalid ${what} (${path}):\n${formatIssues(r.error)}`);
  return r.data;
}

export const loadConfig: LoadConfig = (path) =>
  parseOrThrow(configSchema, readJson(path, 'config'), 'config', path) as BenchConfig;

export const loadSuite: LoadSuite = (path) =>
  parseOrThrow(suiteSchema, readJson(path, 'suite'), 'suite', path) as UseCaseSuite;

/**
 * Models to run. Without a filter: every model with enabled !== false.
 * With a filter: exactly the named ids, in filter order (explicitly naming a disabled model runs it).
 * Throws on unknown ids.
 */
export function activeModels(cfg: BenchConfig, filterIds?: string[]): ModelConfig[] {
  const ids = (filterIds ?? []).map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) return cfg.models.filter((m) => m.enabled !== false);
  const byId = new Map(cfg.models.map((m) => [m.id, m]));
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length) {
    throw new Error(`Unknown model id(s): ${unknown.join(', ')}. Known: ${cfg.models.map((m) => m.id).join(', ')}`);
  }
  return [...new Set(ids)].map((id) => byId.get(id)!);
}

/** Returns the names of env vars that are referenced but unset/empty (deduped, sorted). */
export function checkEnv(cfg: BenchConfig, models: ModelConfig[], env: NodeJS.ProcessEnv = process.env): string[] {
  const needed = new Set<string>([
    ...models.map((m) => m.apiKeyEnv),
    cfg.judge.apiKeyEnv,
    cfg.mcp.tokenEnv,
    cfg.cli.tokenEnv,
  ]);
  return [...needed].filter((name) => !env[name]?.trim()).sort();
}

/** Config snapshot for manifest.json. Holds only env var NAMES; deep-cloned so callers can't mutate the live config. */
export function redactConfig(cfg: BenchConfig): BenchConfig {
  return structuredClone(cfg);
}
