/**
 * Legacy triage stub reconcile (pre–Kanban-only scheduling).
 * New scheduling mail bypasses triage stubs entirely.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { archiveTriageStub, listActiveTriageStubRelativePaths } from "./triageStubFiles.js";

function parseStubFrontmatter(raw: string): {
  frontmatter: { state?: string; scheduling_case_id?: string };
} | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(raw);
  if (!match) return null;
  const block = match[1]!;
  const frontmatter: { state?: string; scheduling_case_id?: string } = {};
  const stateMatch = /^state:\s*(.+)$/m.exec(block);
  if (stateMatch) frontmatter.state = stateMatch[1]!.trim();
  const caseMatch = /^scheduling_case_id:\s*(.+)$/m.exec(block);
  if (caseMatch) {
    frontmatter.scheduling_case_id = caseMatch[1]!.trim().replace(/^"|"$/g, "");
  }
  return { frontmatter };
}

/** Archive active stubs marked done or linked to legacy MD scheduling cases. */
export async function reconcileLegacySchedulingStubs(filesRoot: string): Promise<number> {
  const seen = new Set<string>();
  let count = 0;

  const archiveOne = async (stubRel: string): Promise<void> => {
    if (seen.has(stubRel)) return;
    seen.add(stubRel);
    if (await archiveTriageStub(filesRoot, stubRel)) count += 1;
  };

  for (const stubRel of await listActiveTriageStubRelativePaths(filesRoot)) {
    const raw = await readFile(path.join(filesRoot, stubRel), "utf8").catch(() => null);
    if (!raw) continue;
    const parsed = parseStubFrontmatter(raw);
    if (!parsed) continue;
    if (parsed.frontmatter.state === "done") {
      await archiveOne(stubRel);
      continue;
    }
    const caseId = parsed.frontmatter.scheduling_case_id;
    if (!caseId) continue;
    try {
      const { findLegacySchedulingCaseById, isLegacyCaseTerminal } = await import(
        "./schedulingCaseLegacy.js"
      );
      const caseRecord = await findLegacySchedulingCaseById(filesRoot, caseId);
      if (caseRecord && isLegacyCaseTerminal(caseRecord.frontmatter.state)) {
        await archiveOne(stubRel);
      }
    } catch {
      /* legacy module unavailable */
    }
  }

  if (count > 0) {
    console.info(`[triage] archived ${count} legacy scheduling stub(s)`);
  }
  return count;
}

/** @deprecated Legacy MD cases — archive linked stubs when case terminal. */
export async function archiveStubsForSchedulingCase(
  filesRoot: string,
  record: { frontmatter: { linked_threads: Array<{ provider: string; thread_id: string; account_key?: string }> } },
): Promise<string[]> {
  const { resolveActiveStubRelativePath } = await import("./triageStubFiles.js");
  const archived: string[] = [];
  for (const linked of record.frontmatter.linked_threads) {
    const stubRel = await resolveActiveStubRelativePath(
      filesRoot,
      linked.provider as "gmail" | "nylas",
      linked.thread_id,
      linked.account_key,
    );
    if (!stubRel) continue;
    if (await archiveTriageStub(filesRoot, stubRel)) {
      archived.push(stubRel);
    }
  }
  return archived;
}
