/** EA Day-1 intake payload — maps to workspace/client-profile.md sections 1–4. */
export interface OnboardingVipRow {
  who: string;
  priority?: string;
  gatekeepNotes?: string;
}

export interface OnboardingDraft {
  ownerName: string;
  assistantName: string;

  /** Multi-select priorities from Welcome big-picture step. */
  bigPicturePriorities?: string[];
  bigPictureNotes?: string;

  /** How the principal prefers to communicate (channel ids from options). */
  communicationChannels?: string[];
  /** Contact detail per selected channel id (email, phone, handle, …). */
  communicationContacts?: Record<string, string>;
  communicationNotes?: string;

  /** Apps and services the assistant may need access to. */
  onlineTools?: string[];
  onlineToolsNotes?: string;

  primaryWorkEmail?: string;
  personalEmail?: string;
  doNotAccess?: string;
  updateFormat?: string;
  urgentChannel?: string;
  interruptMeNowMeans?: string;
  timezone?: string;
  workingHoursStart?: string;
  workingHoursEnd?: string;
  batchQuestions?: string;
  vips?: OnboardingVipRow[];

  /** Legacy free-text fields (older drafts / migrations). */
  biggestOffPlate?: string;
  greatFirst30Days?: string;
  notReadyToHandOver?: string;
  mostStress?: string;
  normalChannel?: string;
  handleSolo?: string;
  alwaysSurfaceFirst?: string;
  spendingThreshold?: string;
  neverTouchSolo?: string;
}

export interface OnboardingState {
  schemaVersion: 1;
  completed: boolean;
  completedAt: string | null;
  version: 1;
}

export const DEFAULT_ONBOARDING_STATE: OnboardingState = {
  schemaVersion: 1,
  completed: false,
  completedAt: null,
  version: 1,
};
