import { execFile as execFileCb } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const ENSURE_CAMOFOX_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "ensure-camofox-container.sh",
);

interface DockerInspectState {
  Running?: boolean;
  Status?: string;
}

export class DockerSupervisor {
  private restarting = false;
  private lastError?: string;
  private lastRestartAt = 0;

  constructor(
    private readonly opts: {
      dockerBin: string;
      containerName: string;
      enabled: boolean;
      cooldownMs: number;
    },
  ) {}

  get enabled(): boolean {
    return this.opts.enabled;
  }

  async report() {
    if (!this.opts.enabled) {
      return { enabled: false, containerName: this.opts.containerName };
    }

    const state = await this.inspectState().catch((err: Error) => {
      this.lastError = err.message;
      return null;
    });

    return {
      enabled: true,
      containerName: this.opts.containerName,
      running: state?.Running,
      status: state?.Status,
      lastError: this.lastError,
      restarting: this.restarting,
    };
  }

  async ensureRunning(reason: string) {
    if (!this.opts.enabled || this.restarting) return this.report();
    if (Date.now() - this.lastRestartAt < this.opts.cooldownMs) return this.report();

    this.restarting = true;
    this.lastError = undefined;
    try {
      const state = await this.inspectState().catch(() => null);
      if (!state) {
        console.log(`[joshu] Camofox container ${this.opts.containerName} missing; creating (${reason})`);
        await execFile("bash", [ENSURE_CAMOFOX_SCRIPT], {
          timeout: 120_000,
          env: { ...process.env, CAMOFOX_CONTAINER: this.opts.containerName },
        });
        this.lastRestartAt = Date.now();
        return this.report();
      }
      const action = state.Running ? "restart" : "start";
      await execFile(this.opts.dockerBin, [action, this.opts.containerName], { timeout: 60_000 });
      this.lastRestartAt = Date.now();
      console.log(`[joshu] docker ${action} ${this.opts.containerName} (${reason})`);
    } catch (err) {
      this.lastError = (err as Error).message;
      console.warn(`[joshu] Camofox recovery failed: ${this.lastError}`);
    } finally {
      this.restarting = false;
    }
    return this.report();
  }

  async restart(reason: string) {
    if (!this.opts.enabled || this.restarting) return this.report();

    this.restarting = true;
    this.lastError = undefined;
    try {
      await execFile(this.opts.dockerBin, ["restart", this.opts.containerName], { timeout: 60_000 });
      this.lastRestartAt = Date.now();
      console.log(`[joshu] docker restart ${this.opts.containerName} (${reason})`);
    } catch (err) {
      this.lastError = (err as Error).message;
    } finally {
      this.restarting = false;
    }
    return this.report();
  }

  private async inspectState(): Promise<DockerInspectState> {
    const { stdout } = await execFile(
      this.opts.dockerBin,
      ["inspect", "--format", "{{json .State}}", this.opts.containerName],
      { timeout: 10_000 },
    );
    return JSON.parse(stdout.trim()) as DockerInspectState;
  }
}
