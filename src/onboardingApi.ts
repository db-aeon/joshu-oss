import type { Request, Response, Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { isNylasConfigured } from "./nylas/config.js";
import { readAgentProfile } from "./nylas/profile.js";
import { readAgentGrant } from "./nylas/store.js";
import { resolveJoshuIdentity } from "./joshuIdentity.js";
import { completeOnboarding } from "./onboarding/workspaceWriter.js";
import {
  EA_LAYOUT_VERSION,
  onboardingDraftPath,
  onboardingStatePath,
  projectsRoot,
  readJsonFile,
  writeJsonFile,
} from "./onboarding/paths.js";
import {
  DEFAULT_ONBOARDING_STATE,
  type OnboardingDraft,
  type OnboardingState,
} from "./onboarding/types.js";

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function readDraftBody(body: unknown): OnboardingDraft | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  const ownerName = typeof o.ownerName === "string" ? o.ownerName.trim() : "";
  const assistantName = typeof o.assistantName === "string" ? o.assistantName.trim() : "";
  if (!ownerName || !assistantName) return null;

  const str = (key: string): string | undefined => {
    const v = o[key];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };

  const vips = Array.isArray(o.vips)
    ? o.vips
        .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === "object"))
        .map((row) => ({
          who: typeof row.who === "string" ? row.who.trim() : "",
          priority: typeof row.priority === "string" ? row.priority.trim() : undefined,
          gatekeepNotes: typeof row.gatekeepNotes === "string" ? row.gatekeepNotes.trim() : undefined,
        }))
        .filter((row) => row.who)
    : undefined;

  const communicationContacts: Record<string, string> | undefined = (() => {
    const raw = o.communicationContacts;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) out[key] = value.trim();
    }
    return Object.keys(out).length > 0 ? out : undefined;
  })();

  return {
    ownerName,
    assistantName,
    bigPicturePriorities: readStringArray(o.bigPicturePriorities),
    bigPictureNotes: str("bigPictureNotes"),
    communicationChannels: readStringArray(o.communicationChannels),
    communicationContacts,
    communicationNotes: str("communicationNotes"),
    onlineTools: readStringArray(o.onlineTools),
    onlineToolsNotes: str("onlineToolsNotes"),
    primaryWorkEmail: str("primaryWorkEmail"),
    personalEmail: str("personalEmail"),
    doNotAccess: str("doNotAccess"),
    updateFormat: str("updateFormat"),
    normalChannel: str("normalChannel"),
    urgentChannel: str("urgentChannel"),
    interruptMeNowMeans: str("interruptMeNowMeans"),
    timezone: str("timezone"),
    workingHoursStart: str("workingHoursStart"),
    workingHoursEnd: str("workingHoursEnd"),
    batchQuestions: str("batchQuestions"),
    biggestOffPlate: str("biggestOffPlate"),
    greatFirst30Days: str("greatFirst30Days"),
    notReadyToHandOver: str("notReadyToHandOver"),
    mostStress: str("mostStress"),
    handleSolo: str("handleSolo"),
    alwaysSurfaceFirst: str("alwaysSurfaceFirst"),
    spendingThreshold: str("spendingThreshold"),
    neverTouchSolo: str("neverTouchSolo"),
    vips,
  };
}

function readOnboardingState(projectRoot: string): OnboardingState {
  return readJsonFile<OnboardingState>(onboardingStatePath(projectRoot)) ?? DEFAULT_ONBOARDING_STATE;
}

export function registerOnboardingRoutes(router: Router, opts: { projectRoot: string }): void {
  router.get("/api/onboarding/status", (_req: Request, res: Response) => {
    try {
      const state = readOnboardingState(opts.projectRoot);
      const agent = readAgentGrant(opts.projectRoot);
      const projects = projectsRoot(opts.projectRoot);
      const identity = resolveJoshuIdentity(opts.projectRoot);
      res.json({
        completed: state.completed,
        completedAt: state.completedAt,
        eaLayoutVersion: EA_LAYOUT_VERSION,
        nylasConfigured: isNylasConfigured(),
        nylasProvisioned: Boolean(agent?.email),
        assistantEmail: agent?.email ?? null,
        projectsReady: Boolean(projects && fs.existsSync(path.join(projects, "other", "about.md"))),
        identity: {
          name: identity.name,
          ownerDisplayName: identity.owner.displayName,
        },
        profile: readAgentProfile(opts.projectRoot),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/api/onboarding/draft", (_req: Request, res: Response) => {
    try {
      const draft = readJsonFile<OnboardingDraft>(onboardingDraftPath(opts.projectRoot));
      res.json({ draft });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put("/api/onboarding/draft", (req: Request, res: Response) => {
    try {
      const draft = readDraftBody(req.body);
      if (!draft) {
        res.status(400).json({ error: "ownerName and assistantName required" });
        return;
      }
      const file = onboardingDraftPath(opts.projectRoot);
      if (!file) {
        res.status(500).json({ error: "draft path unavailable" });
        return;
      }
      writeJsonFile(file, draft);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/api/onboarding/complete", (req: Request, res: Response) => {
    try {
      const draft = readDraftBody(req.body);
      if (!draft) {
        res.status(400).json({ error: "ownerName and assistantName required" });
        return;
      }
      if (!draft.timezone?.trim()) {
        res.status(400).json({ error: "timezone required" });
        return;
      }
      const result = completeOnboarding(opts.projectRoot, draft);
      res.json({
        ok: true,
        filesRoot: result.filesRoot,
        projectsRoot: result.projectsRoot,
        eaLayoutVersion: EA_LAYOUT_VERSION,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}
