import fs from "node:fs";
import path from "node:path";

import type { ProactiveCandidate } from "./types.js";
import { latestHardDateMs } from "./stale.js";

/** Extract YAML-ish frontmatter urgency / deadline from about.md. */
export function readProjectSignals(filesRoot: string, projectSlug: string | undefined): {
  urgency: number | null;
  deadline: string | null;
  earliestDue: string | null;
} {
  if (!projectSlug) {
    return { urgency: null, deadline: null, earliestDue: null };
  }
  const aboutPath = path.join(filesRoot, "Projects", projectSlug, "about.md");
  let urgency: number | null = null;
  let deadline: string | null = null;
  if (fs.existsSync(aboutPath)) {
    const text = fs.readFileSync(aboutPath, "utf8");
    const urgMatch = /^urgency:\s*(\d+)/m.exec(text);
    if (urgMatch) urgency = Number.parseInt(urgMatch[1]!, 10);
    const dlMatch = /^deadline:\s*(.+)$/m.exec(text);
    if (dlMatch) deadline = dlMatch[1]!.trim();
  }

  const todoPath = path.join(filesRoot, "Projects", projectSlug, "todo.md");
  let earliestDue: string | null = null;
  if (fs.existsSync(todoPath)) {
    const lines = fs.readFileSync(todoPath, "utf8").split("\n");
    for (const line of lines) {
      if (!line.includes("|")) continue;
      const cols = line.split("|").map((c) => c.trim());
      if (cols.length < 4) continue;
      const due = cols[3]?.trim();
      if (!due || due === "Due" || due === "—" || due === "-") continue;
      if (!earliestDue || due < earliestDue) earliestDue = due;
    }
  }

  return { urgency, deadline, earliestDue };
}

function parseIsoDate(value: string | null | undefined): number | null {
  if (!value?.trim()) return null;
  const t = Date.parse(value.trim());
  return Number.isFinite(t) ? t : null;
}

function dueScoreFromDaysUntil(daysUntil: number): number {
  // Lower score = higher priority. Future due soon wins; long-past loses.
  if (daysUntil < -14) return 1000;
  if (daysUntil <= 0) return 300 + Math.min(Math.abs(daysUntil), 14);
  if (daysUntil <= 1) return 10;
  if (daysUntil <= 3) return 30;
  return 100;
}

/** Lower score = higher priority. */
export function rankCandidate(
  input: Omit<ProactiveCandidate, "rankScore" | "rankSignals"> & {
    createdAt?: string | null;
    priority?: number;
  },
  filesRoot: string,
): ProactiveCandidate {
  const signals = readProjectSignals(filesRoot, input.projectSlug);
  const now = Date.now();
  const createdMs = parseIsoDate(input.createdAt);
  const ageHours = createdMs ? (now - createdMs) / 3_600_000 : 0;

  const taskText = `${input.title}\n${input.body ?? ""}`;
  const taskDateMs = latestHardDateMs(taskText);

  const dueMs =
    parseIsoDate(signals.earliestDue) ??
    parseIsoDate(signals.deadline) ??
    taskDateMs ??
    null;

  let score = 0;
  if (dueMs !== null) {
    const daysUntil = (dueMs - now) / 86_400_000;
    score += dueScoreFromDaysUntil(daysUntil);
  } else {
    score += 200;
  }

  if (signals.urgency !== null && Number.isFinite(signals.urgency)) {
    score += signals.urgency * 5;
  }

  score += Math.max(0, 10 - (input.priority ?? 0));
  score += Math.min(ageHours, 168);

  return {
    ...input,
    rankScore: score,
    rankSignals: {
      dueDate: signals.earliestDue ?? signals.deadline,
      urgency: signals.urgency,
      taskPriority: input.priority,
      ageHours: Math.round(ageHours * 10) / 10,
    },
  };
}

export function sortCandidates(candidates: ProactiveCandidate[]): ProactiveCandidate[] {
  return [...candidates].sort((a, b) => a.rankScore - b.rankScore);
}

export function projectSlugFromBoard(board: string): string | undefined {
  const m = /^project-(.+)$/.exec(board.trim());
  return m?.[1]?.trim() || undefined;
}
