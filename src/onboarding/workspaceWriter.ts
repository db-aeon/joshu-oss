import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveJoshuFilesPaths } from "../joshuFilesPaths.js";
import { updateAgentProfile } from "../nylas/profile.js";
import { readAgentGrant } from "../nylas/store.js";
import { writeJoshuIdentity } from "../joshuIdentity.js";
import type { OnboardingDraft } from "./types.js";
import { DEFAULT_ONBOARDING_STATE, type OnboardingState } from "./types.js";
import { syncEaCronJobs } from "./eaCronJobs.js";
import { bootstrapEaSchedulingKanban } from "./eaKanbanBootstrap.js";
import {
  EA_LAYOUT_VERSION,
  eaVersionPath,
  joshuFilesRoot,
  onboardingDraftPath,
  onboardingStatePath,
  projectsRoot,
  readJsonFile,
  writeJsonFile,
} from "./paths.js";

function line(value: string | undefined, fallback = "—"): string {
  const v = value?.trim();
  return v || fallback;
}

function applyPlaceholders(text: string, vars: Record<string, string>): string {
  let out = text;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{{${key}}}`).join(value);
  }
  return out;
}

function templatePath(projectRoot: string, rel: string): string {
  return path.join(projectRoot, "templates", "ea", rel);
}

function slugifyProject(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "project";
}

function ensureEaLayoutSeeded(projectRoot: string): void {
  const bootstrap = path.join(projectRoot, "scripts", "bootstrap-executive-assistant.sh");
  if (!fs.existsSync(bootstrap)) return;
  const paths = resolveJoshuFilesPaths(projectRoot);
  const env: NodeJS.ProcessEnv = { ...process.env, EA_LAYOUT_VERSION };
  if (paths?.arozData) env.AROZ_DATA = paths.arozData;
  env.APP_DIR = projectRoot;
  execFileSync("bash", [bootstrap], { env, stdio: "pipe" });
}

function resolveProfileEmails(draft: OnboardingDraft): {
  primaryWorkEmail?: string;
  personalEmail?: string;
} {
  const contacts = draft.communicationContacts ?? {};
  return {
    primaryWorkEmail: contacts["work-email"] ?? draft.primaryWorkEmail,
    personalEmail: contacts["personal-email"] ?? draft.personalEmail,
  };
}

function withResolvedEmails(draft: OnboardingDraft): OnboardingDraft {
  const emails = resolveProfileEmails(draft);
  return {
    ...draft,
    primaryWorkEmail: emails.primaryWorkEmail,
    personalEmail: emails.personalEmail,
  };
}

function legacyBigPicture(draft: OnboardingDraft): string[] {
  const legacy = [
    draft.biggestOffPlate?.trim() ? `Biggest off plate: ${draft.biggestOffPlate.trim()}` : "",
    draft.greatFirst30Days?.trim() ? `Great first 30 days: ${draft.greatFirst30Days.trim()}` : "",
    draft.notReadyToHandOver?.trim() ? `Not ready to hand over: ${draft.notReadyToHandOver.trim()}` : "",
    draft.mostStress?.trim() ? `Most stress: ${draft.mostStress.trim()}` : "",
  ].filter(Boolean);
  return legacy;
}

function seedProjectFolder(
  projectDir: string,
  title: string,
  ownerName: string,
  notes?: string,
  projectRoot?: string,
): void {
  fs.mkdirSync(projectDir, { recursive: true });
  const aboutPath = path.join(projectDir, "about.md");
  const todoPath = path.join(projectDir, "todo.md");

  if (!fs.existsSync(aboutPath)) {
    const tpl =
      projectRoot && fs.existsSync(templatePath(projectRoot, "Projects/_template/about.md"))
        ? fs.readFileSync(templatePath(projectRoot, "Projects/_template/about.md"), "utf8")
        : `---
title: "${title}"
urgency: 3
importance: 3
status: active
owner_decisions_pending: false
---

Outcome: _(one sentence)_

Deadline: —

Constraints: …
`;
    fs.writeFileSync(
      aboutPath,
      applyPlaceholders(tpl, { PROJECT_TITLE: title, OWNER_NAME: ownerName }),
    );
    if (notes?.trim()) {
      fs.appendFileSync(aboutPath, `\nWelcome notes:\n\n${notes.trim()}\n`);
    }
  }

  if (!fs.existsSync(todoPath)) {
    const tpl =
      projectRoot && fs.existsSync(templatePath(projectRoot, "Projects/_template/todo.md"))
        ? fs.readFileSync(templatePath(projectRoot, "Projects/_template/todo.md"), "utf8")
        : `# Tasks — ${title}

| Task | Owner | Due | Waiting on | Blocker | Status |
|------|-------|-----|------------|---------|--------|
| | agent | | — | — | open |
`;
    fs.writeFileSync(todoPath, applyPlaceholders(tpl, { PROJECT_TITLE: title }));
  }
}

function seedProjectsFromDraft(projectRoot: string, draft: OnboardingDraft): void {
  const root = projectsRoot(projectRoot);
  if (!root) return;

  const owner = line(draft.ownerName, "Principal");
  const priorities =
    draft.bigPicturePriorities?.length ? draft.bigPicturePriorities : legacyBigPicture(draft);

  for (const priority of priorities) {
    const title = priority.trim();
    if (!title) continue;
    const slug = slugifyProject(title);
    if (slug === "other" || slug === "_system" || slug === "_archive" || slug === "_template") {
      continue;
    }
    seedProjectFolder(path.join(root, slug), title, owner, draft.bigPictureNotes, projectRoot);
  }

  seedProjectFolder(path.join(root, "other"), "Other", owner, undefined, projectRoot);
}

function refreshSummaryEmailTemplate(projectRoot: string, draft: OnboardingDraft): void {
  const root = projectsRoot(projectRoot);
  if (!root) return;
  const dest = path.join(root, "_system", "summary-email.md");
  const src = templatePath(projectRoot, "Projects/_system/summary-email.md");
  if (!fs.existsSync(src)) return;
  const text = applyPlaceholders(fs.readFileSync(src, "utf8"), {
    OWNER_NAME: line(draft.ownerName, "Principal"),
  });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text);
}

export function completeOnboarding(
  projectRoot: string,
  draft: OnboardingDraft,
): { filesRoot: string; projectsRoot: string } {
  ensureEaLayoutSeeded(projectRoot);

  const paths = resolveJoshuFilesPaths(projectRoot);
  if (!paths) throw new Error("Could not resolve Joshu files paths (set JOSHU_AROZ_USER)");

  const filesRoot = paths.filesRoot;
  const projects = path.join(filesRoot, "Projects");
  if (!fs.existsSync(projects)) {
    throw new Error("Projects path unavailable after EA bootstrap");
  }

  const agent = readAgentGrant(projectRoot);
  const assistantEmail = agent?.email ?? "";
  const resolved = withResolvedEmails(draft);

  const statePath = onboardingStatePath(projectRoot);
  if (!statePath) throw new Error("Onboarding state path unavailable");
  const existingState =
    readJsonFile<OnboardingState>(statePath) ?? DEFAULT_ONBOARDING_STATE;

  updateAgentProfile(
    {
      ownerName: resolved.ownerName,
      assistantName: resolved.assistantName,
      primaryWorkEmail: resolved.primaryWorkEmail,
      personalEmail: resolved.personalEmail,
      timezone: resolved.timezone,
      spendingThreshold: resolved.spendingThreshold,
      urgentChannel: resolved.urgentChannel,
      workingHoursStart: resolved.workingHoursStart,
      workingHoursEnd: resolved.workingHoursEnd,
    },
    projectRoot,
  );

  writeJoshuIdentity(
    {
      name: resolved.assistantName,
      owner: { displayName: resolved.ownerName },
      source: "local",
    },
    projectRoot,
  );

  seedProjectsFromDraft(projectRoot, resolved);
  refreshSummaryEmailTemplate(projectRoot, resolved);

  const versionFile = eaVersionPath(projectRoot);
  if (versionFile) {
    fs.writeFileSync(versionFile, `ea-layout: ${EA_LAYOUT_VERSION}\n`);
  }

  const state: OnboardingState = {
    ...DEFAULT_ONBOARDING_STATE,
    completed: true,
    completedAt: existingState.completedAt ?? new Date().toISOString(),
  };
  writeJsonFile(statePath, state);

  const draftFile = onboardingDraftPath(projectRoot);
  if (draftFile) writeJsonFile(draftFile, resolved);

  void bootstrapEaSchedulingKanban(projectRoot).then((result) => {
    if (!result.ok) {
      console.warn(`[onboarding] EA Kanban bootstrap skipped: ${result.error ?? "unknown"}`);
    }
  });

  void syncEaCronJobs(resolved).then((result) => {
    if (!result.ok) {
      console.warn(`[onboarding] EA cron sync skipped: ${result.error ?? "unknown error"}`);
      return;
    }
    console.info(
      `[onboarding] EA cron v2 synced (created=${result.created}, updated=${result.updated}, ` +
        `morning=${result.schedules.morning}, evening=${result.schedules.eod})`,
    );
  });

  return { filesRoot, projectsRoot: projects };
}
