/**
 * Bootstrap Hermes Kanban board for EA scheduling (Welcome / factory).
 */
import { resolveJoshuFilesPaths } from "../joshuFilesPaths.js";
import { ensureEaSchedulingBoard } from "../hermesKanbanBridge.js";

export type EaKanbanBootstrapResult = {
  ok: boolean;
  error?: string;
};

/** Best-effort — does not throw. */
export async function bootstrapEaSchedulingKanban(projectRoot: string): Promise<EaKanbanBootstrapResult> {
  const paths = resolveJoshuFilesPaths(projectRoot);
  if (!paths?.filesRoot) {
    return { ok: false, error: "JOSHU_FILES_ROOT unavailable" };
  }
  try {
    const result = await ensureEaSchedulingBoard(paths.filesRoot);
    if (!result.success) {
      return { ok: false, error: result.error ?? "kanban board setup failed" };
    }
    console.info(`[onboarding] EA scheduling Kanban board ready (ea-scheduling)`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
