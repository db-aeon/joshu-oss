/**
 * Owner mobile offer, Joshu side: save the caller ID of an unlocked phone call
 * as the owner mobile. The voice service decides when to offer and checks the
 * reply of the owner; this module decides whether the box may save the number.
 * Spec: openspec change `voice-save-owner-mobile`, capability `owner-mobile-offer`.
 */
import {
  formatPhoneDisplay,
  normalizeE164,
  normalizeOwnerMobile,
  resolveOwnerCaller,
  resolvePhoneNumber,
} from "./resolve.js";
import { writeTelephoneSettingsFile } from "./store.js";

export type OwnerMobileFromCallResult =
  | { status: "saved"; ownerCaller: string; ownerCallerDisplay: string }
  /** The box already has an owner mobile (Telephone setting or `TWILIO_OWNER_CALLER`). */
  | { status: "already_set"; ownerCallerDisplay: string }
  /** Not a plausible mobile, or the box number. */
  | { status: "invalid" };

/** Run the onboarding reconcile in the background, so the owner-mobile setup card closes. */
export function reconcileOnboardingInBackground(projectRoot: string, reason: string): void {
  void import("../onboarding/reconcileOnboardingBoard.js")
    .then(({ reconcileOnboardingBoard }) => reconcileOnboardingBoard(projectRoot))
    .catch((err) => {
      console.warn(`[onboarding] reconcile after ${reason}: ${(err as Error).message}`);
    });
}

/**
 * Save `caller` as the owner mobile. Never replaces an owner mobile, and
 * writes only the Telephone setting `ownerCaller`.
 */
export function saveOwnerMobileFromCall(
  projectRoot: string,
  caller: string,
  reconcile: (projectRoot: string, reason: string) => void = reconcileOnboardingInBackground,
): OwnerMobileFromCallResult {
  const current = resolveOwnerCaller(projectRoot);
  if (current) return { status: "already_set", ownerCallerDisplay: formatPhoneDisplay(current) };
  const ownerCaller = normalizeOwnerMobile(caller);
  if (!ownerCaller) return { status: "invalid" };
  const boxNumber = resolvePhoneNumber(projectRoot);
  if (boxNumber && normalizeE164(boxNumber) === ownerCaller) return { status: "invalid" };
  writeTelephoneSettingsFile({ ownerCaller }, projectRoot);
  reconcile(projectRoot, "owner mobile saved from call");
  return { status: "saved", ownerCaller, ownerCallerDisplay: formatPhoneDisplay(ownerCaller) };
}
