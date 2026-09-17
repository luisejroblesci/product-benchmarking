import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface ChunkResult {
  durationMs: number;
  status: 'pass' | 'fail' | 'error';
  output: string;
}

export async function runChunkValidation(repoDir: string): Promise<ChunkResult> {
  const start = Date.now();

  // Sync local code to the sidecar microVM
  try {
    await execFileAsync('chunk', ['sidecar', 'sync'], { cwd: repoDir });
  } catch (err: unknown) {
    return {
      durationMs: Date.now() - start,
      status: 'error',
      output: String(err),
    };
  }

  // Run validation on the microVM and capture JSON output
  try {
    const { stdout } = await execFileAsync('chunk', ['validate', '--remote', '--json'], {
      cwd: repoDir,
    });
    const durationMs = Date.now() - start;

    let parsed: { status?: string } = {};
    try {
      parsed = JSON.parse(stdout);
    } catch {
      // Non-JSON output — fall back to exit code (success = pass)
    }

    const status = parsed.status === 'fail' ? 'fail' : 'pass';
    return { durationMs, status, output: stdout };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    // Non-zero exit = validation failed (not an error in the tool itself)
    const stderr = (err as { stderr?: string }).stderr ?? String(err);
    const isValidationFail = (err as { code?: number }).code === 1;
    return {
      durationMs,
      status: isValidationFail ? 'fail' : 'error',
      output: stderr,
    };
  }
}
