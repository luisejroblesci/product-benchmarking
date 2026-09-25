// Shared interfaces between the use-cases benchmark modules.
// Implementations: providers.ts, tools/*.ts, skills-loader.ts, judge.ts, preflight.ts,
// src/core/config.ts, src/core/storage.ts, src/core/inspect.ts.
import type { LanguageModel, ToolSet } from 'ai';
import type {
  BenchConfig, ModelConfig, UseCase, UseCaseSuite, JudgeResult, PreflightCheck,
  RunManifest, RunSummary, SessionKey, SessionRecord, TranscriptLine, ToolCallRecord,
} from '../../core/types.js';

/** Context handed to a tool surface when a session starts. One per session — never shared. */
export interface SurfaceContext {
  config: BenchConfig;
  /** Fresh temp dir used as HOME and cwd for this session; created and deleted by the caller. */
  sessionDir: string;
  /** Fresh checkout of the target repo inside sessionDir; the CLI runs here and file tools are scoped to it. */
  workspaceDir?: string;
  abortSignal?: AbortSignal;
}

/** A set of tools exposed to the model for one session. */
export interface ToolSurface {
  kind: 'cli' | 'mcp' | 'skills' | 'files';
  tools: ToolSet;
  /** Appended to the base system prompt (e.g. CLI usage notes, MCP server instructions, skills list). */
  systemPromptAddendum?: string;
  /** Metadata for a finished tool call (exit code, error flag) keyed by toolCallId, filled in by execute(). */
  callMeta: Map<string, Pick<ToolCallRecord, 'isError' | 'exitCode' | 'durationMs'>>;
  close(): Promise<void>;
}

export interface SkillMeta {
  name: string;
  description: string;
  dir: string;              // absolute path to the skill directory
  files: string[];          // bundled files, relative to dir (excluding SKILL.md)
}

export interface LoadedSkills {
  repo: string;
  ref: string;
  resolvedSha: string;
  root: string;             // absolute path to the skills directory in the cache
  skills: SkillMeta[];
}

/** Writes a run directory. Every method is safe to call from concurrent sessions. */
export interface RunWriter {
  runDir: string;
  writeManifest(m: RunManifest): void;
  /** Append one line to sessions.jsonl (serialized, flushed immediately). */
  appendSession(r: SessionRecord): void;
  /** Keys already present in sessions.jsonl; with includeErrors=false, error/skipped rows are excluded so they get retried. */
  completedKeys(includeErrors: boolean): Set<string>;
  readSessions(): SessionRecord[];
  writeSummary(s: RunSummary): void;
  /** Opens a per-session transcript; returns its path relative to runDir. */
  openTranscript(key: SessionKey): TranscriptWriter;
}

export interface TranscriptWriter {
  relPath: string;
  append(line: TranscriptLine): void;
  /** Store a large tool output in full; returns the blob path relative to runDir. */
  writeBlob(callId: string, content: string): string;
}

export const sessionKeyString = (k: SessionKey) => `${k.model}|${k.condition}|${k.caseId}|${k.rep}`;

// ── function signatures each module must export ──
export type LoadConfig = (path: string) => BenchConfig;
export type LoadSuite = (path: string) => UseCaseSuite;
export type ResolveModel = (cfg: Omit<ModelConfig, 'id'>) => LanguageModel;
export type CreateCliSurface = (ctx: SurfaceContext) => Promise<ToolSurface>;
export type CreateMcpSurface = (ctx: SurfaceContext) => Promise<ToolSurface>;
export type LoadSkills = (cfg: BenchConfig['skills']) => Promise<LoadedSkills>;
export type CreateSkillsSurface = (skills: LoadedSkills) => ToolSurface;
export type Judge = (
  cfg: BenchConfig,
  useCase: UseCase,
  finalAnswer: string,
  trace: string,
  abortSignal?: AbortSignal,
) => Promise<JudgeResult>;
export type RunPreflight = (
  cfg: BenchConfig,
  opts: { models: ModelConfig[]; conditions: BenchConfig['conditions'] },
) => Promise<PreflightCheck[]>;
