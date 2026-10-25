/** The last steps of a release update or rollback, after the stack services are recreated. */

export interface ReleaseFinishSteps {
  /** Throws when the stack is not healthy in time. */
  waitForHealthy: () => Promise<void>;
  /** Recreates the voice service, when the box runs speech-to-speech voice. */
  recreateVoice?: () => Promise<void>;
  /** Removes old release images (change prune-release-images). */
  pruneImages: () => Promise<void>;
}

/**
 * Wait for health, then recreate the voice service, then remove old release images.
 * The cleanup runs only after the health wait passed: when the stack is not healthy,
 * the update fails and the control plane rolls back, so the old images must stay.
 */
export async function finishReleaseUpdate(steps: ReleaseFinishSteps): Promise<void> {
  await steps.waitForHealthy();
  if (steps.recreateVoice) {
    await steps.recreateVoice();
  }
  await steps.pruneImages();
}
