import { access, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TriageProvider } from "./triageTypes.js";

function stubFilename(provider: TriageProvider, threadId: string, accountKey?: string): string {
  const safe = threadId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
  if (provider === "gmail" && accountKey?.trim()) {
    const acct = accountKey.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 40);
    return `gmail-${acct}-${safe}.stub.md`;
  }
  return `${provider}-${safe}.stub.md`;
}

/** Legacy v2 path before account_key was included in the filename. */
function legacyGmailStubFilename(threadId: string): string {
  const safe = threadId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
  return `gmail-${safe}.stub.md`;
}

function triageDir(filesRoot: string): string {
  return path.join(filesRoot, "Triage");
}

function triageDoneDir(filesRoot: string): string {
  return path.join(triageDir(filesRoot), "_done");
}

type StubFrontmatter = {
  state?: string;
  scheduling_case_id?: string;
  provider?: TriageProvider;
  thread_id?: string;
  account_key?: string;
};

function parseStubFrontmatter(raw: string): { frontmatter: StubFrontmatter; body: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(raw);
  if (!match) return null;
  const block = match[1]!;
  const frontmatter: StubFrontmatter = {};
  const stateMatch = /^state:\s*(.+)$/m.exec(block);
  if (stateMatch) frontmatter.state = stateMatch[1]!.trim();
  const caseMatch = /^scheduling_case_id:\s*(.+)$/m.exec(block);
  if (caseMatch) {
    frontmatter.scheduling_case_id = caseMatch[1]!.trim().replace(/^"|"$/g, "");
  }
  const providerMatch = /^provider:\s*(.+)$/m.exec(block);
  if (providerMatch) frontmatter.provider = providerMatch[1]!.trim() as TriageProvider;
  const threadMatch = /^thread_id:\s*(.+)$/m.exec(block);
  if (threadMatch) frontmatter.thread_id = threadMatch[1]!.trim();
  const accountMatch = /^account_key:\s*(.+)$/m.exec(block);
  if (accountMatch) frontmatter.account_key = accountMatch[1]!.trim();
  return { frontmatter, body: match[2]! };
}

function patchStubFrontmatter(block: string, patch: Record<string, string>): string {
  let next = block;
  for (const [key, value] of Object.entries(patch)) {
    const line = `${key}: ${value}`;
    if (new RegExp(`^${key}:`, "m").test(next)) {
      next = next.replace(new RegExp(`^${key}:.*$`, "m"), line);
    } else {
      next = `${next.trimEnd()}\n${line}`;
    }
  }
  return next;
}

/** Active queue stubs only — excludes `Triage/_done/` and `_snapshots/`. */
export async function listActiveTriageStubRelativePaths(filesRoot: string): Promise<string[]> {
  const dir = triageDir(filesRoot);
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".stub.md"))
    .map((name) => `Triage/${name}`);
}

export async function resolveActiveStubRelativePath(
  filesRoot: string,
  provider: TriageProvider,
  threadId: string,
  accountKey?: string,
): Promise<string | null> {
  const candidates = [
    `Triage/${stubFilename(provider, threadId, accountKey)}`,
    ...(provider === "gmail" ? [`Triage/${legacyGmailStubFilename(threadId)}`] : []),
  ];
  for (const relative of candidates) {
    try {
      await access(path.join(filesRoot, relative));
      return relative;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Move stub to `Triage/_done/` and set `state: done`. Idempotent if already archived. */
export async function archiveTriageStub(filesRoot: string, stubRelativePath: string): Promise<boolean> {
  const normalized = stubRelativePath.replace(/^\/+/, "");
  if (normalized.startsWith("Triage/_done/")) return false;

  const src = path.join(filesRoot, normalized);
  let raw: string;
  try {
    raw = await readFile(src, "utf8");
  } catch {
    return false;
  }

  const parsed = parseStubFrontmatter(raw);
  if (!parsed) return false;

  const doneDir = triageDoneDir(filesRoot);
  await mkdir(doneDir, { recursive: true });
  const filename = path.basename(normalized);
  const dest = path.join(doneDir, filename);
  const originalBlock = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  const frontmatterBlock = patchStubFrontmatter(originalBlock, { state: "done" });
  const body = parsed.body.trimStart();
  await writeFile(dest, `---\n${frontmatterBlock}\n---\n\n${body}`, "utf8");
  await unlink(src).catch(() => undefined);
  return true;
}

async function stubFileExists(filesRoot: string, filename: string): Promise<boolean> {
  try {
    await access(path.join(triageDir(filesRoot), filename));
    return true;
  } catch {
    return false;
  }
}

export async function triageStubExists(
  filesRoot: string,
  provider: TriageProvider,
  threadId: string,
  accountKey?: string,
): Promise<boolean> {
  const primary = stubFilename(provider, threadId, accountKey);
  if (await stubFileExists(filesRoot, primary)) return true;
  if (provider === "gmail") {
    return stubFileExists(filesRoot, legacyGmailStubFilename(threadId));
  }
  return false;
}

export function triageStubFilename(
  provider: TriageProvider,
  threadId: string,
  accountKey?: string,
): string {
  return stubFilename(provider, threadId, accountKey);
}

export async function ensureTriageDir(filesRoot: string): Promise<string> {
  const dir = triageDir(filesRoot);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function writeNewTriageStub(
  filesRoot: string,
  filename: string,
  content: string,
): Promise<void> {
  await writeFile(path.join(triageDir(filesRoot), filename), content, "utf8");
}
