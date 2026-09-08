import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Hermes state root (~/.hermes or HERMES_HOME). */
export function hermesHome(): string {
  return process.env.HERMES_HOME?.trim() || path.join(homedir(), ".hermes");
}

/**
 * All Kanban board slugs on this box (ea-* + project-* + custom).
 * Source of truth: ~/.hermes/kanban/boards/<slug>/ — not Projects/ folders.
 */
export function listKanbanBoardSlugs(): string[] {
  const boardsDir = path.join(hermesHome(), "kanban", "boards");
  if (!fs.existsSync(boardsDir)) return [];
  return fs
    .readdirSync(boardsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => name.length > 0)
    .sort();
}
