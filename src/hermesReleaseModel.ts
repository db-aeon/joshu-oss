/**
 * The release owns the Hermes model (change release-hermes-model). Cron jobs pinned to a model
 * that the control plane used to write into instance.env would stay on that model after a
 * release changes it, so the Joshu API removes those pins at start.
 */
import { callCronBridge } from "./hermesCronBridge.js";
import { CONTROL_PLANE_HERMES_MODELS } from "./joshuOpenRouterDefaults.js";

export async function unpinCronJobsFromControlPlaneModels(): Promise<{ unpinned: number }> {
  const result = await callCronBridge({ action: "unpin_models", models: [...CONTROL_PLANE_HERMES_MODELS] });
  if (result.success === false) {
    throw new Error(typeof result.error === "string" ? result.error : "cron unpin failed");
  }
  return { unpinned: Array.isArray(result.unpinned) ? result.unpinned.length : 0 };
}
