/**
 * Owner reminder records in <files>/.joshu/owner-reminders/state.json (owner files
 * volume, like the realtime-goal broker). Writes are serialized in this process.
 */
import path from "node:path";

import { JsonStateStore } from "../jsonStateStore.js";
import { resolveJoshuFilesPaths } from "../joshuFilesPaths.js";
import type { OwnerReminderState } from "./types.js";

export function ownerReminderStateDir(projectRoot: string): string {
  const explicit = process.env.JOSHU_OWNER_REMINDERS_STATE_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  const filesRoot = resolveJoshuFilesPaths(projectRoot)?.filesRoot;
  return filesRoot
    ? path.join(filesRoot, ".joshu", "owner-reminders")
    : path.join(projectRoot, ".local", "owner-reminders");
}

export class OwnerReminderStore extends JsonStateStore<OwnerReminderState> {
  constructor(dir: string) {
    super(
      path.join(dir, "state.json"),
      (raw) => {
        const parsed = (raw ?? {}) as Partial<OwnerReminderState>;
        return { version: 1, reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [] };
      },
      "owner reminder",
    );
  }
}
