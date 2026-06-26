import {
  onboardingDraftPath,
  readJsonFile,
  writeJsonFile,
} from "../onboarding/paths.js";
import type { OnboardingDraft } from "../onboarding/types.js";
import { isGmailConnected, runMailSync } from "../connectors/syncHelpers.js";
import { listGmailRegistryAccounts } from "../connectors/composio/gmailAccounts.js";
import { day0StatePath } from "./paths.js";
import { extractDay0Signals } from "./extract.js";
import { inferDay0Draft } from "./infer.js";
import { isDay0LlmConfigured, resolveDay0Model } from "./llm.js";
import { mergeDay0IntoDraft } from "./mergeDraft.js";
import type { Day0ColdStartResult, Day0State } from "./types.js";
import { DEFAULT_DAY0_STATE } from "./types.js";

function readDay0State(projectRoot: string): Day0State {
  return readJsonFile<Day0State>(day0StatePath(projectRoot)) ?? DEFAULT_DAY0_STATE;
}

function writeDay0State(projectRoot: string, state: Day0State): void {
  const file = day0StatePath(projectRoot);
  if (!file) throw new Error("day0 state path unavailable");
  writeJsonFile(file, state);
}

function patchDay0State(projectRoot: string, patch: Partial<Day0State>): Day0State {
  const next: Day0State = { ...readDay0State(projectRoot), ...patch, schemaVersion: 1 };
  writeDay0State(projectRoot, next);
  return next;
}

async function resolveScopedAccountIds(
  projectRoot: string,
  requested?: string,
): Promise<string[]> {
  const accounts = await listGmailRegistryAccounts(projectRoot);
  const scoped = requested
    ? accounts.filter((a) => a.connectedAccountId === requested)
    : accounts.filter((a) => a.enabled !== false);
  return scoped.map((a) => a.connectedAccountId);
}

function resolveDraftNames(
  existing: OnboardingDraft | null,
  ownerName?: string,
  assistantName?: string,
): { ownerName: string; assistantName: string } | null {
  const owner = ownerName?.trim() || existing?.ownerName?.trim();
  const assistant = assistantName?.trim() || existing?.assistantName?.trim();
  if (!owner || !assistant) return null;
  return { ownerName: owner, assistantName: assistant };
}

export async function runDay0ColdStart(
  projectRoot: string,
  opts: {
    force?: boolean;
    connectedAccountId?: string;
    ownerName?: string;
    assistantName?: string;
  } = {},
): Promise<Day0ColdStartResult> {
  const prior = readDay0State(projectRoot);
  if (prior.status === "completed" && !opts.force) {
    const draft = readJsonFile<OnboardingDraft>(onboardingDraftPath(projectRoot));
    return {
      ok: true,
      skipped: true,
      draft,
      day0: prior,
    };
  }

  if (!(await isGmailConnected(projectRoot))) {
    return {
      ok: false,
      error: "Gmail not connected — connect in Connectors first",
      day0: patchDay0State(projectRoot, {
        status: "failed",
        error: "Gmail not connected",
      }),
    };
  }

  if (!isDay0LlmConfigured()) {
    return {
      ok: false,
      error: "Day 0 LLM not configured — set OPENROUTER_API_KEY",
      day0: patchDay0State(projectRoot, {
        status: "failed",
        error: "LLM not configured",
      }),
    };
  }

  const existingDraft = readJsonFile<OnboardingDraft>(onboardingDraftPath(projectRoot));
  const names = resolveDraftNames(existingDraft, opts.ownerName, opts.assistantName);
  if (!names) {
    return {
      ok: false,
      error: "ownerName and assistantName required (in draft or request body)",
      day0: prior,
    };
  }

  const connectedAccountIds = await resolveScopedAccountIds(
    projectRoot,
    opts.connectedAccountId,
  );
  if (connectedAccountIds.length === 0) {
    return {
      ok: false,
      error: "No enabled Gmail accounts found",
      day0: prior,
    };
  }

  let state = patchDay0State(projectRoot, {
    status: "syncing",
    startedAt: new Date().toISOString(),
    completedAt: undefined,
    error: undefined,
    connectedAccountIds,
    connectedAccountId: opts.connectedAccountId,
    model: resolveDay0Model(),
    warnings: [],
  });

  try {
    const sync = await runMailSync(projectRoot, "gmail", {
      days: 30,
      messageLimit: 500,
      syncCalendar: true,
      allMail: true,
      connectedAccountId: opts.connectedAccountId,
      calendarDaysBack: 30,
      calendarDaysForward: 14,
      classifyTriage: false,
      skipTriageStubs: true,
    });

    if (!sync.ok && !sync.threadsWritten) {
      throw new Error(sync.error ?? "Gmail sync failed");
    }

    state = patchDay0State(projectRoot, { status: "extracting" });
    const extract = await extractDay0Signals(projectRoot, {
      connectedAccountId: opts.connectedAccountId,
    });

    state = patchDay0State(projectRoot, { status: "inferring" });
    const inferred = await inferDay0Draft(extract);

    state = patchDay0State(projectRoot, { status: "merging" });
    const baseDraft: OnboardingDraft = {
      ...(existingDraft ?? {}),
      ownerName: names.ownerName,
      assistantName: names.assistantName,
    };
    const { draft, fieldsFilled } = mergeDay0IntoDraft(baseDraft, inferred);

    const draftFile = onboardingDraftPath(projectRoot);
    if (!draftFile) throw new Error("draft path unavailable");
    writeJsonFile(draftFile, draft);

    state = patchDay0State(projectRoot, {
      status: "completed",
      completedAt: new Date().toISOString(),
      threadsAnalyzed: extract.threads.length,
      eventsAnalyzed: extract.events.length,
      fieldsFilled,
      warnings: inferred.warnings,
    });

    return {
      ok: true,
      draft,
      day0: state,
      stats: {
        threadsWritten: sync.threadsWritten,
        eventsWritten: sync.eventsWritten,
        threadsAnalyzed: extract.threads.length,
        eventsAnalyzed: extract.events.length,
        accountsSynced: sync.accountsSynced,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state = patchDay0State(projectRoot, {
      status: "failed",
      error: message,
      completedAt: new Date().toISOString(),
    });
    return { ok: false, error: message, day0: state };
  }
}

export function getDay0Status(projectRoot: string): Day0State {
  return readDay0State(projectRoot);
}
