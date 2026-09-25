// Maps a ModelConfig to a Vercel AI SDK LanguageModel, plus usage/cost/error helpers.
import { APICallError, RetryError, LoadAPIKeyError, NoSuchModelError } from 'ai';
import type { LanguageModel, LanguageModelUsage } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ErrorKind, ModelConfig, PricingEntry, Provider, Usage } from '../../core/types.js';
import type { ResolveModel } from './contracts.js';

type ModelCfg = Omit<ModelConfig, 'id'>;

/** Key under which each provider reads `providerOptions` in generateText. */
const PROVIDER_OPTIONS_KEY: Record<Provider, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  'openai-compatible': 'openaiCompatible',
};

function apiKeyFor(cfg: ModelCfg): string {
  const key = process.env[cfg.apiKeyEnv]?.trim();
  if (!key) {
    throw new Error(
      `Missing API key for ${cfg.provider}/${cfg.model}: environment variable ${cfg.apiKeyEnv} is not set (add it to .env)`,
    );
  }
  return key;
}

/**
 * Note (Anthropic): no thinking/tool_choice overrides are applied here — some models (e.g. Opus 5.5)
 * reject thinking:{type:'disabled'} and forced tool_choice. Provider defaults are used.
 */
export const resolveModel: ResolveModel = (cfg) => {
  const apiKey = apiKeyFor(cfg);
  switch (cfg.provider) {
    case 'anthropic':
      return createAnthropic({ apiKey, ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}) })(cfg.model);
    case 'openai':
      return createOpenAI({ apiKey, ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}) })(cfg.model);
    case 'google':
      return createGoogle({ apiKey, ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}) })(cfg.model);
    case 'openai-compatible': {
      if (!cfg.baseURL) throw new Error(`baseURL is required for openai-compatible model ${cfg.model}`);
      return createOpenAICompatible({ name: 'openai-compatible', baseURL: cfg.baseURL, apiKey, includeUsage: true })(cfg.model);
    }
    default: {
      const p: never = cfg.provider;
      throw new Error(`Unknown provider "${String(p)}"`);
    }
  }
};

/** `providerOptions` for generateText, keyed by the provider's options namespace; undefined when none configured. */
export function providerOptionsFor(cfg: ModelCfg): Record<string, Record<string, any>> | undefined {
  if (!cfg.providerOptions || Object.keys(cfg.providerOptions).length === 0) return undefined;
  return { [PROVIDER_OPTIONS_KEY[cfg.provider]]: cfg.providerOptions as Record<string, any> };
}

/**
 * Maps AI SDK v7 usage to our Usage. `input` is the TOTAL input tokens (includes cacheRead + cacheWrite);
 * `output` is total output tokens (includes reasoning).
 */
export function toUsage(u: LanguageModelUsage | undefined): Usage {
  return {
    input: u?.inputTokens ?? 0,
    output: u?.outputTokens ?? 0,
    cacheRead: u?.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWrite: u?.inputTokenDetails?.cacheWriteTokens ?? 0,
    reasoning: u?.outputTokenDetails?.reasoningTokens ?? 0,
  };
}

/**
 * USD cost for a usage record. Null when there's no pricing entry for the provider model id.
 * Uncached input = input - cacheRead - cacheWrite, billed at inPerMTok; cache reads/writes use their
 * own rates when given, else inPerMTok. Output (incl. reasoning) at outPerMTok.
 */
export function computeCost(pricing: Record<string, PricingEntry>, providerModel: string, usage: Usage): number | null {
  const p = pricing[providerModel];
  if (!p) return null;
  const uncached = Math.max(0, usage.input - usage.cacheRead - usage.cacheWrite);
  const cost =
    uncached * p.inPerMTok +
    usage.cacheRead * (p.cacheReadPerMTok ?? p.inPerMTok) +
    usage.cacheWrite * (p.cacheWritePerMTok ?? p.inPerMTok) +
    usage.output * p.outPerMTok;
  return cost / 1_000_000;
}

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

function errName(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : undefined;
}
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}
function errCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | undefined;
  const c = e?.code ?? e?.cause?.code;
  return typeof c === 'string' ? c : undefined;
}

/** Classifies an error thrown by generateText / generateObject for retry + reporting. */
export function classifyProviderError(err: unknown): { kind: ErrorKind; retryable: boolean; message: string } {
  const message = errMessage(err).slice(0, 2000);

  const name = errName(err);
  if (name === 'AbortError' || name === 'TimeoutError') {
    return { kind: 'timeout', retryable: false, message };
  }

  if (RetryError.isInstance(err)) {
    if (err.reason === 'abort') return { kind: 'timeout', retryable: false, message };
    const inner = classifyProviderError(err.lastError);
    // SDK already retried; still report the inner retryability so the runner can decide on backoff.
    return { ...inner, message: `${message} (last: ${inner.message})`.slice(0, 2000) };
  }

  if (APICallError.isInstance(err)) {
    const s = err.statusCode;
    const body = err.responseBody ? ` — ${err.responseBody.slice(0, 500)}` : '';
    const msg = `${s ?? 'no status'} ${message}${body}`.slice(0, 2000);
    if (s === undefined) return { kind: 'provider_error', retryable: true, message: msg }; // network-level
    if (s === 408 || s === 409 || s === 429 || s >= 500) return { kind: 'provider_error', retryable: true, message: msg };
    return { kind: 'provider_error', retryable: err.isRetryable && ![400, 401, 403, 404].includes(s), message: msg };
  }

  if (LoadAPIKeyError.isInstance(err) || NoSuchModelError.isInstance(err)) {
    return { kind: 'provider_error', retryable: false, message };
  }

  const code = errCode(err);
  if (code && NETWORK_CODES.has(code)) return { kind: 'provider_error', retryable: true, message: `${code}: ${message}` };
  if (err instanceof TypeError && /fetch failed|network/i.test(message)) {
    return { kind: 'provider_error', retryable: true, message };
  }

  return { kind: 'unknown', retryable: false, message };
}
