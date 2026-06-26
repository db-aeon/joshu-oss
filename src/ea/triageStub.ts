import { readFile } from "node:fs/promises";
import { gmailIngestSkipLabel, isGmailJunk } from "./gmailJunk.js";
import {
  isStaleForScheduling,
  shouldSkipSchedulingIngest,
  shouldSkipTriageStub,
} from "./ingestFilters.js";
import {
  classifyInboundMail,
  readBodyPreview,
  shouldActOnMailClassification,
} from "./classifier.js";
import {
  buildMailDedupKey,
  markMailDedupProcessed,
  prepareMailIngestDedup,
} from "./mailDedup.js";
import { resolveAgentAuthorizationForMirror } from "./agentAuthorization.js";
import type { AfterMirrorThreadInput, InboundMailClassification } from "./triageTypes.js";
export type { AfterMirrorThreadInput, TriageProvider } from "./triageTypes.js";
export {
  archiveTriageStub,
  listActiveTriageStubRelativePaths,
  resolveActiveStubRelativePath,
  triageStubExists,
} from "./triageStubFiles.js";
export { reconcileLegacySchedulingStubs } from "./triageSchedulingBridge.js";
import {
  archiveTriageStub,
  ensureTriageDir,
  resolveActiveStubRelativePath,
  triageStubExists,
  triageStubFilename,
  writeNewTriageStub,
} from "./triageStubFiles.js";

function yamlQuote(value: string): string {
  if (!/[:#\n"']/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function latestMessageChanged(input: AfterMirrorThreadInput): boolean {
  const prior = input.priorLatestMessageId?.trim();
  const latest = input.messageId?.trim();
  if (!prior || !latest) return true;
  return prior !== latest;
}

function buildMinimalStubLines(input: AfterMirrorThreadInput, state: string): string[] {
  const received = input.receivedAt ?? new Date().toISOString();
  return [
    "---",
    `state: ${state}`,
    `provider: ${input.provider}`,
    ...(input.accountKey ? [`account_key: ${input.accountKey}`] : []),
    `thread_id: ${input.threadId}`,
    `source_path: ${input.sourcePath}`,
    `subject: ${yamlQuote(input.subject ?? "")}`,
    `from: ${yamlQuote(input.from ?? "")}`,
    `received_at: ${received}`,
    ...(input.messageId ? [`message_id: ${input.messageId}`] : []),
    "---",
    "",
    "# Triage",
    "",
    "Read body at `source_path` (under JOSHU_FILES_ROOT). Policy flags live on the ea-mail-ingress Kanban task.",
    "",
  ];
}

async function writeInfoStubAndArchive(input: AfterMirrorThreadInput): Promise<void> {
  const { filesRoot, provider, threadId, accountKey } = input;
  if (await triageStubExists(filesRoot, provider, threadId, accountKey)) {
    const rel = await resolveActiveStubRelativePath(filesRoot, provider, threadId, accountKey);
    if (rel) await archiveTriageStub(filesRoot, rel).catch(() => {});
    return;
  }
  await ensureTriageDir(filesRoot);
  const filename = triageStubFilename(provider, threadId, accountKey);
  await writeNewTriageStub(
    filesRoot,
    filename,
    buildMinimalStubLines(input, "done").join("\n"),
  );
  await archiveTriageStub(filesRoot, `Triage/${filename}`).catch(() => {});
}

async function routeMailByClassification(
  input: AfterMirrorThreadInput,
  classification: InboundMailClassification,
  latestMessageId: string,
  dedupKey: string,
): Promise<boolean> {
  const { filesRoot, provider, threadId, accountKey, subject, from, rfcMessageId } = input;

  if (classification.disposition === "noise") {
    console.info(`[triage] noise skip ${provider}/${threadId}: ${classification.reason}`);
    await markMailDedupProcessed({
      filesRoot,
      dedupKey,
      provider,
      threadId,
      subject,
      rfcMessageId,
      classification,
    }).catch(() => {});
    return true;
  }

  if (classification.disposition === "info") {
    await writeInfoStubAndArchive(input);
    await markMailDedupProcessed({
      filesRoot,
      dedupKey,
      provider,
      threadId,
      subject,
      rfcMessageId,
      messageId: latestMessageId,
      classification,
    }).catch(() => {});
    return true;
  }

  if (classification.disposition === "track" && shouldActOnMailClassification(classification)) {
    const projectRoot = input.projectRoot;
    const authorization = await resolveAgentAuthorizationForMirror({
      filesRoot,
      sourcePath: input.sourcePath,
      provider,
      from: input.from,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      accountEmail: input.accountEmail,
      category: classification.category,
      projectRoot,
    });
    const schedulingHint =
      classification.category === "scheduling" && authorization.scheduling_eligible;

    if (!authorization.agent_authorized && classification.category === "scheduling") {
      console.info(
        `[triage] scheduling mail file-only ${provider}/${threadId} (${authorization.reason})`,
      );
    }

    if (!(await triageStubExists(filesRoot, provider, threadId, accountKey))) {
      await ensureTriageDir(filesRoot);
      const filename = triageStubFilename(provider, threadId, accountKey);
      await writeNewTriageStub(
        filesRoot,
        filename,
        buildMinimalStubLines(input, "new").join("\n"),
      );
    }
    const { forwardTrackMail } = await import("./mailIngress.js");
    await forwardTrackMail({
      ...input,
      messageId: latestMessageId,
      classification: {
        category: classification.category,
        project_slug: classification.project_slug,
        is_new_track: classification.is_new_track,
        reason: classification.reason,
        scheduling_hint: schedulingHint,
        authorization,
      },
    });
    await markMailDedupProcessed({
      filesRoot,
      dedupKey,
      provider,
      threadId,
      subject,
      rfcMessageId,
      messageId: latestMessageId,
      classification,
      authorization,
    }).catch(() => {});
    return true;
  }

  return false;
}

export async function createTriageStubAfterMirror(input: AfterMirrorThreadInput): Promise<void> {
  const {
    filesRoot,
    provider,
    threadId,
    accountKey,
    sourcePath,
    subject,
    from,
    receivedAt,
    labels,
    classify = true,
    skipTriageStubs = false,
    projectRoot,
    messageId,
    rfcMessageId,
  } = input;

  if (shouldSkipTriageStub({ from, projectRoot })) {
    console.info(
      `[triage] skip stub for agent-sent thread ${provider}/${threadId} (from joshu)`,
    );
    return;
  }

  if (provider === "gmail" && isGmailJunk(labels)) {
    const skipLabel = gmailIngestSkipLabel(labels);
    console.info(
      `[triage] skip stub for gmail thread ${threadId}${skipLabel ? ` (label: ${skipLabel})` : ""}`,
    );
    return;
  }

  if (skipTriageStubs) {
    return;
  }

  const latestMessageId = messageId?.trim() || `${threadId}-${receivedAt ?? "unknown"}`;

  const runClassifier =
    classify &&
    !process.env.JOSHU_EA_CLASSIFIER_DISABLED?.trim() &&
    latestMessageChanged(input);

  let bodyPreview = "";
  let dedupKey = "";
  if (runClassifier) {
    bodyPreview = await readBodyPreview(filesRoot, sourcePath);
    dedupKey = buildMailDedupKey({ subject, receivedAt, bodyPreview, rfcMessageId });
    const dedup = await prepareMailIngestDedup({
      filesRoot,
      provider,
      threadId,
      subject,
      receivedAt,
      bodyPreview,
      rfcMessageId,
    });
    if (dedup.action === "skip_duplicate") {
      const via = dedup.primary.rfc_message_id ? `rfc:${dedup.primary.rfc_message_id}` : dedup.dedupKey;
      console.info(
        `[triage] skip duplicate mail ${provider}/${threadId} (${via}; primary ${dedup.primary.provider}/${dedup.primary.thread_id})`,
      );
      return;
    }
    dedupKey = dedup.dedupKey;
  }

  if (runClassifier && !shouldSkipSchedulingIngest({ from, receivedAt, projectRoot })) {
    const classification = await classifyInboundMail({ subject, from, bodyPreview });
    if (await routeMailByClassification(input, classification, latestMessageId, dedupKey)) {
      return;
    }
  } else if (runClassifier && shouldSkipSchedulingIngest({ from, receivedAt, projectRoot })) {
    const reason = isStaleForScheduling(receivedAt) ? "stale" : "agent";
    console.info(`[triage] skip mail classify for ${provider}/${threadId} (${reason})`);
  }

  if (await triageStubExists(filesRoot, provider, threadId, accountKey)) {
    return;
  }

  await ensureTriageDir(filesRoot);
  const filename = triageStubFilename(provider, threadId, accountKey);
  await writeNewTriageStub(
    filesRoot,
    filename,
    buildMinimalStubLines(input, "new").join("\n"),
  );
}

/** @deprecated Scheduling no longer uses triage stubs — kept for legacy stub reads. */
export async function readStubSchedulingFields(
  filesRoot: string,
  stubRelativePath: string,
): Promise<{ scheduling_case_id?: string; scheduling_queued?: boolean }> {
  try {
    const raw = await readFile(`${filesRoot}/${stubRelativePath}`.replace(/\/+/g, "/"), "utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(raw);
    if (!match) return {};
    const block = match[1]!;
    const caseMatch = /^scheduling_case_id:\s*(.+)$/m.exec(block);
    const queuedMatch = /^scheduling_queued:\s*(true|false)$/m.exec(block);
    return {
      ...(caseMatch ? { scheduling_case_id: caseMatch[1]!.trim().replace(/^"|"$/g, "") } : {}),
      ...(queuedMatch ? { scheduling_queued: queuedMatch[1] === "true" } : {}),
    };
  } catch {
    return {};
  }
}

export { reconcileLegacySchedulingStubs as reconcileTerminalSchedulingStubs } from "./triageSchedulingBridge.js";
