/**
 * One JSON state file with serialized read-modify-write transactions in this
 * process. The file is written to a temporary file and renamed, so a reader never
 * sees half a file. Owner reminders and team memberships keep their state here.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export class JsonStateStore<T> {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    /** Builds the state from the parsed file, or from undefined when the file does not exist. */
    private readonly normalize: (raw: unknown) => T,
    private readonly label: string,
  ) {}

  private async readUnlocked(): Promise<T> {
    try {
      return this.normalize(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.normalize(undefined);
      throw new Error(`${this.label} state read failed: ${(error as Error).message}`);
    }
  }

  private async writeUnlocked(state: T): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.file);
  }

  /** Run `mutate` on the current state; write when it returns changed=true. */
  transaction<R>(mutate: (state: T) => { result: R; changed: boolean }): Promise<R> {
    const run = this.tail.catch(() => undefined).then(async () => {
      const state = await this.readUnlocked();
      const { result, changed } = mutate(state);
      if (changed) await this.writeUnlocked(state);
      return result;
    });
    this.tail = run;
    return run;
  }

  read(): Promise<T> {
    return this.transaction((state) => ({ result: structuredClone(state), changed: false }));
  }
}
