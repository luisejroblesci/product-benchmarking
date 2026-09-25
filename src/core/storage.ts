import fs from 'fs';
import path from 'path';
import { createObjectCsvWriter } from 'csv-writer';
import type {
  UC1RunResult,
  RunManifest, RunSummary, SessionKey, SessionRecord, ToolCallRecord, TranscriptLine,
} from './types.js';
import type { RunWriter, TranscriptWriter } from '../benchmarks/skills/contracts.js';
import { sessionKeyString } from '../benchmarks/skills/contracts.js';

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function saveJSON(filePath: string, data: unknown) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

export function loadJSON<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

export async function exportUC1CSV(run: UC1RunResult, outDir: string) {
  ensureDir(outDir);
  const file = path.join(outDir, `${run.runId}-uc1.csv`);
  const writer = createObjectCsvWriter({
    path: file,
    header: [
      { id: 'sha', title: 'sha' },
      { id: 'message', title: 'message' },
      { id: 'sidecarMs', title: 'sidecar_ms' },
      { id: 'sidecarStatus', title: 'sidecar_status' },
      { id: 'traditionalMs', title: 'traditional_ms' },
      { id: 'traditionalStatus', title: 'traditional_status' },
      { id: 'speedupFactor', title: 'speedup_factor' },
    ],
  });
  await writer.writeRecords(
    run.commits.map((c) => ({
      sha: c.sha,
      message: c.message,
      sidecarMs: c.sidecar.durationMs,
      sidecarStatus: c.sidecar.status,
      traditionalMs: c.traditional.durationMs,
      traditionalStatus: c.traditional.status,
      speedupFactor: (c.traditional.durationMs / c.sidecar.durationMs).toFixed(2),
    }))
  );
  return file;
}

// ─────────────────────────────────────────────────────────────────────────────
// Use-cases benchmark: run directories, sessions.jsonl, transcripts, index
// ─────────────────────────────────────────────────────────────────────────────

export const SESSIONS_FILE = 'sessions.jsonl';
export const MANIFEST_FILE = 'manifest.json';
export const SUMMARY_FILE = 'summary.json';

/** Creates `<baseDir>/<ISO ts, ':'→'-', no ms>Z_<runId[0..8]>` and returns its path. */
export function createRunDir(baseDir = 'benchmarks/uc2/runs', runId: string): string {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  const dir = path.join(baseDir, `${ts}_${runId.slice(0, 8)}`);
  ensureDir(dir);
  return dir;
}

/** Make a string safe to use as a single path segment ('+' is kept). */
function safeSegment(s: string): string {
  const out = String(s).replace(/[\\/\x00-\x1f:*?"<>|]/g, '_');
  return out === '' || /^\.+$/.test(out) ? out.replace(/\./g, '_') || '_' : out;
}

/** Parse a JSONL file; malformed lines (e.g. a truncated last line after a crash) are skipped. */
export function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const out: T[] = [];
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // truncated / partial line — ignore
    }
  }
  return out;
}

function appendJsonl(filePath: string, value: unknown) {
  fs.appendFileSync(filePath, JSON.stringify(value) + '\n');
}

/** Reads sessions.jsonl, keeping only the LAST record per session key (retries supersede). */
export function readSessionsFile(runDir: string): SessionRecord[] {
  const byKey = new Map<string, SessionRecord>();
  for (const r of readJsonl<SessionRecord>(path.join(runDir, SESSIONS_FILE))) {
    if (!r || typeof r !== 'object' || r.model === undefined) continue;
    const k = sessionKeyString(r);
    byKey.delete(k); // re-insert so order reflects the latest write
    byKey.set(k, r);
  }
  return [...byKey.values()];
}

export function transcriptRelPath(key: SessionKey): string {
  return path.posix.join(
    'transcripts', safeSegment(key.model), safeSegment(key.condition),
    `${safeSegment(key.caseId)}.r${key.rep}.jsonl`,
  );
}

export function openRunWriter(runDir: string): RunWriter {
  ensureDir(runDir);
  const sessionsPath = path.join(runDir, SESSIONS_FILE);
  // If a previous process crashed mid-write, terminate the partial line so new appends stay parseable.
  if (fs.existsSync(sessionsPath)) {
    const size = fs.statSync(sessionsPath).size;
    if (size > 0) {
      const fd = fs.openSync(sessionsPath, 'r');
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      fs.closeSync(fd);
      if (last[0] !== 0x0a) fs.appendFileSync(sessionsPath, '\n');
    }
  }

  return {
    runDir,
    writeManifest(m: RunManifest) {
      saveJSON(path.join(runDir, MANIFEST_FILE), m);
    },
    appendSession(r: SessionRecord) {
      appendJsonl(sessionsPath, r);
    },
    completedKeys(includeErrors: boolean): Set<string> {
      const keys = new Set<string>();
      for (const r of readSessionsFile(runDir)) {
        if (includeErrors || r.status === 'completed' || r.status === 'judge_error') keys.add(sessionKeyString(r));
      }
      return keys;
    },
    readSessions() {
      return readSessionsFile(runDir);
    },
    writeSummary(s: RunSummary) {
      saveJSON(path.join(runDir, SUMMARY_FILE), s);
    },
    openTranscript(key: SessionKey): TranscriptWriter {
      const relPath = transcriptRelPath(key);
      const abs = path.join(runDir, relPath);
      ensureDir(path.dirname(abs));
      if (fs.existsSync(abs)) {
        const base = abs.slice(0, -'.jsonl'.length);
        let n = 1;
        while (fs.existsSync(`${base}.attempt${n}.jsonl`)) n++;
        fs.renameSync(abs, `${base}.attempt${n}.jsonl`);
      }
      fs.writeFileSync(abs, '');
      const blobRelDir = relPath.slice(0, -'.jsonl'.length) + '.blobs';
      return {
        relPath,
        append(line: TranscriptLine) {
          appendJsonl(abs, line);
        },
        writeBlob(callId: string, content: string): string {
          const dirAbs = path.join(runDir, blobRelDir);
          ensureDir(dirAbs);
          const id = safeSegment(callId);
          // Never overwrite a blob from a previous attempt (older transcripts still reference it).
          let name = `${id}.txt`;
          for (let i = 2; fs.existsSync(path.join(dirAbs, name)); i++) name = `${id}.${i}.txt`;
          fs.writeFileSync(path.join(dirAbs, name), content);
          return path.posix.join(blobRelDir, name);
        },
      };
    },
  };
}

/** Truncate a string to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function utf8Prefix(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf-8');
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--; // back off continuation bytes
  return buf.subarray(0, end).toString('utf-8');
}

/**
 * §7a spill rule: outputs ≤ inlineLimit bytes stay inline; larger ones are written in full to a blob
 * and the record keeps a `previewBytes` preview plus the blob path.
 */
export function spillToolOutput(
  tw: TranscriptWriter,
  callId: string,
  output: string,
  inlineLimit = 64 * 1024,
  previewBytes = 4096,
): Pick<ToolCallRecord, 'output' | 'outputBytes' | 'truncated' | 'blobPath'> {
  const outputBytes = Buffer.byteLength(output, 'utf-8');
  if (outputBytes <= inlineLimit) return { output, outputBytes, truncated: false };
  const blobPath = tw.writeBlob(callId, output);
  return { output: utf8Prefix(output, previewBytes), outputBytes, truncated: true, blobPath };
}

/** Reads a transcript JSONL; tolerates a truncated last line. */
export function readTranscript(filePath: string): TranscriptLine[] {
  return readJsonl<TranscriptLine>(filePath).filter(
    (l) => l && typeof l === 'object' && (l.type === 'session' || l.type === 'turn' || l.type === 'end'),
  );
}

export interface RunIndexEntry {
  runId: string;
  runDir: string;
  startedAt: string;
  models: string[];
  conditions: string[];
  sessions: number;
  completed: number;
  errors: number;
  passRate: number | null;
  meanScore: number | null;
  costUsd: number | null;
}

/** Builds the headline index entry for a run from its manifest and (deduped) records. */
export function runIndexEntry(manifest: RunManifest, runDir: string, records: SessionRecord[]): RunIndexEntry {
  const judged = records.filter((r) => r.score !== null && r.score !== undefined);
  const costs = records.map((r) => r.costUsd).filter((c): c is number => typeof c === 'number');
  return {
    runId: manifest.runId,
    runDir,
    startedAt: manifest.startedAt,
    models: manifest.models,
    conditions: manifest.conditions,
    sessions: records.length,
    completed: records.filter((r) => r.status === 'completed' || r.status === 'judge_error').length,
    errors: records.filter((r) => r.status === 'error').length,
    passRate: judged.length ? judged.filter((r) => r.pass === true).length / judged.length : null,
    meanScore: judged.length ? judged.reduce((a, r) => a + (r.score as number), 0) / judged.length : null,
    costUsd: costs.length ? costs.reduce((a, c) => a + c, 0) : null,
  };
}

export function appendRunIndex(indexPath = 'benchmarks/uc2/index.jsonl', entry: RunIndexEntry) {
  ensureDir(path.dirname(indexPath));
  appendJsonl(indexPath, entry);
}

/** Writes `<runDir>/sessions.csv` with one flattened row per session. */
export async function exportSessionsCSV(runDir: string, records: SessionRecord[]): Promise<string> {
  ensureDir(runDir);
  const file = path.join(runDir, 'sessions.csv');
  const cols = [
    'runId', 'model', 'provider', 'providerModel', 'condition', 'caseId', 'rep', 'status',
    'errorKind', 'errorMessage', 'score', 'pass', 'turns', 'inputTokens', 'outputTokens',
    'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens', 'costUsd', 'durationMs',
    'modelTimeMs', 'toolTimeMs', 'toolCallCount', 'toolErrors', 'distinctTools', 'firstToolTurn',
    'skillsLoaded', 'retries', 'startedAt', 'endedAt', 'transcriptPath', 'judgeReasoning', 'finalAnswer',
  ];
  const writer = createObjectCsvWriter({ path: file, header: cols.map((id) => ({ id, title: id })) });
  await writer.writeRecords(
    records.map((r) => ({
      runId: r.runId,
      model: r.model,
      provider: r.provider,
      providerModel: r.providerModel,
      condition: r.condition,
      caseId: r.caseId,
      rep: r.rep,
      status: r.status,
      errorKind: r.error?.kind ?? '',
      errorMessage: r.error?.message ?? '',
      score: r.score ?? '',
      pass: r.pass ?? '',
      turns: r.turns,
      inputTokens: r.usage?.input ?? 0,
      outputTokens: r.usage?.output ?? 0,
      cacheReadTokens: r.usage?.cacheRead ?? 0,
      cacheWriteTokens: r.usage?.cacheWrite ?? 0,
      reasoningTokens: r.usage?.reasoning ?? 0,
      totalTokens: (r.usage?.input ?? 0) + (r.usage?.output ?? 0),
      costUsd: r.costUsd ?? '',
      durationMs: r.durationMs,
      modelTimeMs: r.modelTimeMs,
      toolTimeMs: r.toolTimeMs,
      toolCallCount: r.toolCallCount,
      toolErrors: r.toolErrors,
      distinctTools: (r.distinctTools ?? []).join(';'),
      firstToolTurn: r.firstToolTurn ?? '',
      skillsLoaded: (r.skillsLoaded ?? []).join(';'),
      retries: r.retries,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      transcriptPath: r.transcriptPath,
      judgeReasoning: r.judgeReasoning ?? '',
      finalAnswer: r.finalAnswer,
    })),
  );
  return file;
}
