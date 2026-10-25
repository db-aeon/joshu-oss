import type { Request, Response, Router } from "express";
import { verifyArozosDesktopSession } from "../httpLocalhost.js";
import { voiceLocalServiceAuthorized } from "../realtimeGoals/voiceCallback.js";
import { reconcileOnboardingInBackground, saveOwnerMobileFromCall } from "./ownerMobileFromCall.js";
import {
  normalizeE164,
  normalizeOwnerMobile,
  readTelephoneStatus,
  resolveThinkPassword,
  type TelephoneStatus,
} from "./resolve.js";
import { writeTelephoneSettingsFile, type TelephoneSettingsUpdate } from "./store.js";

/** Two spoken English words (or a short phrase) — keep STT-friendly. */
function validateThinkPassword(raw: string): string {
  const value = raw.trim().replace(/\s+/g, " ");
  if (value.length < 3) {
    throw new Error("Passphrase must be at least 3 characters");
  }
  if (value.length > 64) {
    throw new Error("Passphrase must be 64 characters or fewer");
  }
  // Prefer words/spaces/apostrophes; reject control chars.
  if (!/^[\w\s'-]+$/u.test(value)) {
    throw new Error("Passphrase may only use letters, numbers, spaces, apostrophes, and hyphens");
  }
  return value;
}

/** Weak PINs are the first thing anyone tries. */
const WEAK_PINS = /^(\d)\1+$|^(0123|1234|2345|3456|4567|5678|6789|123456|234567|345678|456789|12345678|0000|1111|4321|654321|87654321)$/;

function validatePin(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (!/^\d{4,8}$/.test(value)) throw new Error("PIN must be 4 to 8 digits");
  if (WEAK_PINS.test(value)) throw new Error("That PIN is too easy to guess — avoid repeated or sequential digits");
  return value;
}

/**
 * Caddy sends every /joshu/* request here without a login check. Only the
 * ArozOS desktop of the owner (or a direct localhost client) may read or change
 * the Telephone settings.
 */
async function requireDesktopSession(req: Request, res: Response): Promise<boolean> {
  if (await verifyArozosDesktopSession(req)) return true;
  res.status(401).json({ error: "desktop_session_required" });
  return false;
}

/** Telephone status for the apps. The passphrase only comes back from the passphrase route. */
function telephoneStatusForApps(projectRoot: string): Omit<TelephoneStatus, "thinkPassword"> {
  const { thinkPassword: _passphrase, ...status } = readTelephoneStatus(projectRoot);
  return status;
}

export function registerTelephoneRoutes(
  router: Router,
  opts: {
    projectRoot: string;
    /** Tests replace the background onboarding reconcile. */
    reconcileOnboarding?: (projectRoot: string, reason: string) => void;
  },
): void {
  const { projectRoot } = opts;
  const reconcileOnboarding = opts.reconcileOnboarding ?? reconcileOnboardingInBackground;

  router.get("/api/telephone", async (req: Request, res: Response) => {
    if (!(await requireDesktopSession(req, res))) return;
    try {
      res.json({ ok: true, telephone: telephoneStatusForApps(projectRoot) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /** Button Show of the Telephone app. POST, so that no prefetch or cache keeps the passphrase. */
  router.post("/api/telephone/passphrase", async (req: Request, res: Response) => {
    if (!(await requireDesktopSession(req, res))) return;
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, thinkPassword: resolveThinkPassword(projectRoot) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put("/api/telephone", async (req: Request, res: Response) => {
    if (!(await requireDesktopSession(req, res))) return;
    const body = (req.body ?? {}) as {
      thinkPassword?: string;
      phoneNumber?: string;
      ownerCaller?: string;
      pin?: string;
      trustVerifiedCallerId?: boolean;
    };
    try {
      const updates: TelephoneSettingsUpdate = {};
      if (typeof body.pin === "string") updates.pin = validatePin(body.pin);
      if (typeof body.trustVerifiedCallerId === "boolean") {
        updates.trustVerifiedCallerId = body.trustVerifiedCallerId;
      }
      if (typeof body.thinkPassword === "string") {
        updates.thinkPassword = validateThinkPassword(body.thinkPassword);
      }
      if (typeof body.phoneNumber === "string") {
        const n = normalizeE164(body.phoneNumber);
        if (body.phoneNumber.trim() && !n) {
          throw new Error("Phone number looks invalid");
        }
        updates.phoneNumber = n;
      }
      if (typeof body.ownerCaller === "string") {
        const n = normalizeOwnerMobile(body.ownerCaller);
        if (body.ownerCaller.trim() && !n) {
          throw new Error("Owner mobile looks invalid — use a full number with country code (e.g. +1…)");
        }
        updates.ownerCaller = n;
      }
      if (!Object.keys(updates).length) {
        res.status(400).json({
          error: "Provide thinkPassword, phoneNumber, ownerCaller, pin, and/or trustVerifiedCallerId",
        });
        return;
      }
      writeTelephoneSettingsFile(updates, projectRoot);
      if (updates.ownerCaller !== undefined) reconcileOnboarding(projectRoot, "telephone save");
      const notes: string[] = [];
      if (updates.thinkPassword !== undefined) {
        notes.push("Passphrase saved. New inbound calls will use it immediately.");
      }
      if (updates.pin !== undefined) {
        notes.push(updates.pin ? "PIN saved. Callers can key it in instead of saying the passphrase." : "PIN removed.");
      }
      if (updates.trustVerifiedCallerId !== undefined) {
        notes.push(
          updates.trustVerifiedCallerId
            ? "Calls from your verified mobile number skip the passphrase."
            : "Every call asks for the passphrase again.",
        );
      }
      if (updates.ownerCaller !== undefined) {
        notes.push(
          updates.ownerCaller
            ? "Owner mobile saved. SMS approvals and the owner voice greeting use it immediately."
            : "Owner mobile cleared. SMS approvals stay off until a number is set again.",
        );
      }
      res.json({
        ok: true,
        telephone: telephoneStatusForApps(projectRoot),
        note: notes.join(" ") || "Saved.",
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Owner mobile offer: the voice service saves the caller ID of an unlocked
   * call after the owner said yes. Never replaces an owner mobile.
   */
  router.post("/api/telephone/owner-mobile/from-call", (req: Request, res: Response) => {
    if (!voiceLocalServiceAuthorized(req)) {
      res.status(403).json({ error: "voice service auth required" });
      return;
    }
    const body = (req.body ?? {}) as { callSid?: unknown; caller?: unknown };
    const callSid = typeof body.callSid === "string" ? body.callSid.trim() : "";
    const caller = typeof body.caller === "string" ? body.caller.trim() : "";
    if (!callSid || !caller) {
      res.status(400).json({ status: "invalid", error: "callSid and caller are required" });
      return;
    }
    try {
      const result = saveOwnerMobileFromCall(projectRoot, caller, reconcileOnboarding);
      const lastDigits = caller.replace(/\D/g, "").slice(-4);
      console.info(`[telephone] owner mobile from call call=${callSid} number=…${lastDigits} status=${result.status}`);
      const httpStatus = result.status === "saved" ? 200 : result.status === "already_set" ? 409 : 400;
      res.status(httpStatus).json(result);
    } catch (err) {
      res.status(500).json({ status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  });
}
