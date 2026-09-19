import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execFileAsync = promisify(execFile);

const PREFLIGHT_TIMEOUT_MS = 60_000;

interface ChunkConfig {
  commands?: Array<{ name: string; run: string; role: string; timeout?: number; remote?: boolean }>;
}

function readGateCommands(repoDir: string): Array<{ name: string; run: string; timeoutMs: number }> {
  const configFile = path.join(repoDir, '.chunk', 'config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8')) as ChunkConfig;
  return (config.commands ?? [])
    .filter((c) => c.role === 'gate' && c.remote !== false)
    .map((c) => ({ name: c.name, run: c.run, timeoutMs: (c.timeout ?? 300) * 1000 }));
}

export function resolveSidecarId(repoDir: string): string {
  const poolFile = path.join(repoDir, '.chunk', 'validate-pool.json');
  try {
    const pool = JSON.parse(fs.readFileSync(poolFile, 'utf8')) as { sidecar_ids?: string[] };
    const id = pool.sidecar_ids?.[0];
    if (!id) throw new Error('sidecar_ids is empty');
    return id;
  } catch (err) {
    throw new Error(
      `Cannot resolve sidecar ID from ${poolFile}: ${err}\n` +
      `Run: chunk sidecar setup`
    );
  }
}

export async function verifySidecar(repoDir: string, sidecarId: string): Promise<void> {
  // 1. Verify SSH/rsync connectivity
  try {
    await execFileAsync('chunk', ['sidecar', 'sync', '--sidecar-id', sidecarId], {
      cwd: repoDir,
      timeout: PREFLIGHT_TIMEOUT_MS,
    });
  } catch (err: unknown) {
    const msg = (err as { stderr?: string; message?: string }).stderr ?? String(err);
    throw new Error(`Sidecar pre-flight failed: sync error — ${msg}\nRun: chunk sidecar setup`);
  }

  // 2. Verify Go is available on the microVM
  try {
    await execFileAsync(
      'chunk', ['sidecar', 'exec', '--sidecar-id', sidecarId, '--command', 'go', '--', 'version'],
      { cwd: repoDir, timeout: PREFLIGHT_TIMEOUT_MS }
    );
  } catch (err: unknown) {
    const msg = (err as { stderr?: string; message?: string }).stderr ?? String(err);
    throw new Error(`Sidecar pre-flight failed: Go not found on sidecar — ${msg}\nRun: chunk sidecar setup`);
  }
}

export interface ChunkResult {
  durationMs: number;
  status: 'pass' | 'fail' | 'error';
  output: string;
}

export async function runChunkValidation(repoDir: string, sidecarId: string): Promise<ChunkResult> {
  const start = Date.now();

  // Sync local code to the sidecar microVM
  console.log('  [sidecar] syncing code to microVM…');
  try {
    await execFileAsync('chunk', ['sidecar', 'sync', '--sidecar-id', sidecarId], { cwd: repoDir });
  } catch (err: unknown) {
    console.log('  [sidecar] sync failed');
    return { durationMs: Date.now() - start, status: 'error', output: String(err) };
  }

  // Run each remote gate command via sidecar exec (avoids TTY requirement of `chunk validate --remote`)
  console.log('  [sidecar] running gate commands on microVM…');
  const gates = readGateCommands(repoDir);
  const outputs: string[] = [];

  for (const gate of gates) {
    console.log(`  [sidecar] → ${gate.name}: ${gate.run}`);
    try {
      const { stdout, stderr } = await execFileAsync(
        'chunk',
        ['sidecar', 'exec', '--sidecar-id', sidecarId, '--command', 'sh', '--', '-c', `cd /home/user/circleci-cli && ${gate.run}`],
        { cwd: repoDir, timeout: gate.timeoutMs, maxBuffer: 50 * 1024 * 1024 }
      );
      outputs.push(stdout || stderr);
    } catch (err: unknown) {
      const durationMs = Date.now() - start;
      const stderr = (err as { stderr?: string }).stderr ?? '';
      const stdout = (err as { stdout?: string }).stdout ?? '';
      const code = (err as { code?: number }).code;
      const killed = (err as { killed?: boolean }).killed;
      const output = stderr || stdout || String(err);
      // exit code 1 or 201 = remote command failed (tests/lint failed); anything else = tool/setup error
      // chunk sidecar exec wraps remote exit codes — remote exit 1 surfaces as 201
      const status: ChunkResult['status'] = (code === 1 || code === 201) ? 'fail' : 'error';
      console.log(`  [sidecar] done — ${status} on gate "${gate.name}" (${(durationMs / 1000).toFixed(1)}s) [exit=${code} killed=${killed}]`);
      return { durationMs, status, output };
    }
  }

  const durationMs = Date.now() - start;
  console.log(`  [sidecar] done — pass (${(durationMs / 1000).toFixed(1)}s)`);
  return { durationMs, status: 'pass', output: outputs.join('\n') };
}
