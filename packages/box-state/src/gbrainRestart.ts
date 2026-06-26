/**
 * Reinitialize gbrain after hard factory reset wipes GBRAIN_HOME.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RestartGbrainResult {
  ok: boolean;
  error?: string;
}

function bashScript(projectRoot: string, script: string, gbrainHome?: string, timeoutMs = 180_000) {
  const env: NodeJS.ProcessEnv = { ...process.env, APP_DIR: projectRoot };
  if (gbrainHome) env.GBRAIN_HOME = gbrainHome;
  return execFileAsync("bash", [script], {
    cwd: projectRoot,
    env,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });
}

/** Stop gbrain serve + MCP HTTP before wiping GBRAIN_HOME (avoids EBUSY on rmdir). */
export async function stopGbrainStack(
  projectRoot: string,
  gbrainHome?: string,
): Promise<RestartGbrainResult> {
  try {
    await bashScript(projectRoot, `${projectRoot}/scripts/stop-gbrain.sh`, gbrainHome, 60_000);
    return { ok: true };
  } catch (err) {
    const message =
      err instanceof Error && "stderr" in err
        ? `${err.message}\n${String((err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? "")}`.trim()
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, error: message };
  }
}

/** Stop stale gbrain processes and re-run boot init (PGLite + sync + MCP HTTP). */
export async function restartGbrainStack(
  projectRoot: string,
  gbrainHome?: string,
): Promise<RestartGbrainResult> {
  try {
    await bashScript(projectRoot, `${projectRoot}/scripts/stop-gbrain.sh`, gbrainHome);
    await bashScript(projectRoot, `${projectRoot}/scripts/start-gbrain.sh`, gbrainHome);
    await bashScript(projectRoot, `${projectRoot}/scripts/start-gbrain-mcp-http.sh`, gbrainHome);
    return { ok: true };
  } catch (err) {
    const message =
      err instanceof Error && "stderr" in err
        ? `${err.message}\n${String((err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? "")}`.trim()
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, error: message };
  }
}
