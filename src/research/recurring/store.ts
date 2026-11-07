/**
 * The recurring report store (design decision D1): one folder `<files>/Research/Recurring/<slug>/`
 * for each recurring report, with `setup.json`, `stories.json`, `README.md`, `updates/`, and
 * `migration/`. The folder `Recurring` does not match the pattern of report identifiers, so the scan
 * of one-time Research reports does not see it. Writes of one recurring report are serialized in
 * this process, and each file is written to a temporary file first and then renamed.
 */

import fs from "node:fs";
import path from "node:path";
import { researchDir, slugifyTopic, type ReportRoots } from "../store.js";
import { describeSchedule } from "./schedule.js";
import { researchSourceLabel, type RecurringSetup, type StoriesFile, type UpdateFile } from "./types.js";

export const RECURRING_DIR_NAME = "Recurring";
export const RECURRING_ID_PATTERN = /^rr_[0-9a-f]{8}$/;
export const CHANNEL_LABELS = { email: "email", sms: "text message", slack: "Slack", telegram: "Telegram" } as const;

export function recurringDir(roots: ReportRoots): string {
  return path.join(researchDir(roots), RECURRING_DIR_NAME);
}

/** Write a file through a temporary file in the same folder, so a reader never sees half a file. */
export function writeFileAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function writeJson(file: string, value: unknown): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** The setup in plain words, so that gbrain indexes it and the owner can read it in the files. */
export function setupReadme(setup: RecurringSetup): string {
  const lines = [
    `# ${setup.name}`,
    "",
    `This is a recurring report of your companion. State: ${setup.state}.`,
    "",
    `- Schedule: ${describeSchedule(setup.schedule)}`,
    `- Channel: ${CHANNEL_LABELS[setup.channel]}`,
    `- Sources: ${setup.sources === "auto" ? "Auto" : setup.sources.map((s) => researchSourceLabel(s)).join(", ")}`,
    `- Notes: ${setup.notes || "none"}`,
    "",
    "## Parts",
    "",
    ...setup.lanes.map((lane) => {
      const picks = setup.sources === "auto" && lane.plan ? ` (sources: ${lane.plan.picks.map((s) => researchSourceLabel(s)).join(", ")})` : "";
      return `- ${lane.topic}${picks}`;
    }),
    "",
    "Each report update is in the folder `updates`, with its themes and links in `update.md`.",
    "",
  ];
  return lines.join("\n");
}

export const EMPTY_STORIES: StoriesFile = { schemaVersion: 1, nextNumber: 1, stories: [] };

export function readStoriesFile(file: string): StoriesFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<StoriesFile>;
    return {
      schemaVersion: 1,
      nextNumber: typeof parsed.nextNumber === "number" ? parsed.nextNumber : 1,
      stories: Array.isArray(parsed.stories) ? parsed.stories : [],
    };
  } catch {
    return structuredClone(EMPTY_STORIES);
  }
}

export function writeStoriesFile(file: string, stories: StoriesFile): void {
  writeJson(file, stories);
}

export class RecurringStore {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(readonly roots: ReportRoots) {}

  get dir(): string {
    return recurringDir(this.roots);
  }

  folder(setup: Pick<RecurringSetup, "slug">): string {
    return path.join(this.dir, setup.slug);
  }

  /** Every recurring report, deleted ones included, the oldest first. */
  list(): RecurringSetup[] {
    if (!fs.existsSync(this.dir)) return [];
    const out: RecurringSetup[] = [];
    for (const name of fs.readdirSync(this.dir)) {
      try {
        const setup = JSON.parse(fs.readFileSync(path.join(this.dir, name, "setup.json"), "utf8")) as RecurringSetup;
        if (RECURRING_ID_PATTERN.test(setup.id) && setup.slug === name) out.push(setup);
      } catch {
        /* not a recurring report folder */
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): RecurringSetup | null {
    if (!RECURRING_ID_PATTERN.test(id)) return null;
    return this.list().find((s) => s.id === id) ?? null;
  }

  /** A free folder name for a new recurring report. */
  newSlug(name: string): string {
    const base = slugifyTopic(name);
    if (!fs.existsSync(path.join(this.dir, base))) return base;
    for (let n = 2; ; n += 1) if (!fs.existsSync(path.join(this.dir, `${base}-${n}`))) return `${base}-${n}`;
  }

  /** Make the folder of a new recurring report. */
  create(setup: RecurringSetup): RecurringSetup {
    const folder = this.folder(setup);
    fs.mkdirSync(path.join(folder, "updates"), { recursive: true });
    fs.mkdirSync(path.join(folder, "migration"), { recursive: true });
    writeStoriesFile(path.join(folder, "stories.json"), EMPTY_STORIES);
    this.write(setup);
    return setup;
  }

  private write(setup: RecurringSetup): void {
    const folder = this.folder(setup);
    writeJson(path.join(folder, "setup.json"), setup);
    writeFileAtomic(path.join(folder, "README.md"), setupReadme(setup));
  }

  /**
   * Change one recurring report under its lock. `fn` changes the setup in place and returns a
   * result; returning `false` as `changed` skips the write. Returns null when the report is unknown.
   */
  async update<T>(id: string, fn: (setup: RecurringSetup) => { result: T; changed: boolean }, now = new Date()): Promise<{ setup: RecurringSetup; result: T } | null> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const run = previous.then(() => {
      const setup = this.get(id);
      if (!setup) return null;
      const { result, changed } = fn(setup);
      if (changed) {
        setup.updatedAt = now.toISOString();
        this.write(setup);
      }
      return { setup: structuredClone(setup), result };
    });
    this.locks.set(id, run.catch(() => undefined));
    return run;
  }
}

/** The report updates of a folder, newest first. */
export function readUpdates(folder: string): UpdateFile[] {
  const dir = path.join(folder, "updates");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}-\d{4}$/.test(name))
    .sort()
    .reverse()
    .flatMap((name) => {
      try {
        return [JSON.parse(fs.readFileSync(path.join(dir, name, "update.json"), "utf8")) as UpdateFile];
      } catch {
        return [];
      }
    });
}
