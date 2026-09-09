/**
 * Bootstrap Hermes Kanban board for EA onboarding prompts (Welcome / reconcile).
 */
import { resolveJoshuFilesPaths } from "../joshuFilesPaths.js";
import { ensureEaOnboardingBoard } from "../hermesKanbanBridge.js";

export type EaOnboardingKanbanBootstrapResult = {
  ok: boolean;
  error?: string;
};

/** Best-effort — does not throw. */
export async function bootstrapEaOnboardingKanban(
  projectRoot: string,
): Promise<EaOnboardingKanbanBootstrapResult> {
  const paths = resolveJoshuFilesPaths(projectRoot);
  if (!paths?.filesRoot) {
    return { ok: false, error: "JOSHU_FILES_ROOT unavailable" };
  }
  try {
    const result = await ensureEaOnboardingBoard(paths.filesRoot);
    if (!result.success) {
      return { ok: false, error: result.error ?? "kanban board setup failed" };
    }
    console.info("[onboarding] EA onboarding Kanban board ready (ea-onboarding)");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
