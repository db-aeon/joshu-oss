/**
 * App-local search over connector markdown mirrors (no LLM, no gbrain round-trip).
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

export type MirrorSearchHit = {
  path: string;
  relativePath: string;
  threadId?: string;
  externalId?: string;
  subject?: string;
  from?: string;
  date?: string;
  snippet: string;
  unread?: boolean;
  messageCount?: number;
};

type ParsedMirror = {
  relativePath: string;
  absolutePath: string;
  frontmatter: Record<string, unknown>;
  body: string;
};

async function listMarkdownFiles(dir: string, baseDir: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw err;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await listMarkdownFiles(full, baseDir, out);
    } else if (ent.isFile() && ent.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

async function readParsedMirror(absolutePath: string, filesRoot: string): Promise<ParsedMirror | null> {
  let raw: string;
  try {
    raw = await readFile(absolutePath, "utf8");
  } catch {
    return null;
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/m.exec(raw);
  if (!match?.[1]) return null;
  let frontmatter: Record<string, unknown> = {};
  try {
    frontmatter = (YAML.parse(match[1]) as Record<string, unknown>) ?? {};
  } catch {
    frontmatter = {};
  }
  const relativePath = path.relative(filesRoot, absolutePath).split(path.sep).join("/");
  return {
    relativePath,
    absolutePath,
    frontmatter,
    body: match[2]?.trim() ?? "",
  };
}

/** Gmail-style inbox order: most recent activity = last message in thread. */
function resolveThreadSortDate(
  frontmatter: Record<string, unknown>,
  threadMessages: Array<{ date?: string }>,
): string | undefined {
  const top = typeof frontmatter.date === "string" ? frontmatter.date.trim() : "";
  if (top) return top;
  for (let i = threadMessages.length - 1; i >= 0; i--) {
    const d = threadMessages[i]?.date?.trim();
    if (d) return d;
  }
  return undefined;
}

function hitSortMs(hit: MirrorSearchHit): number {
  if (!hit.date) return 0;
  const ms = Date.parse(hit.date);
  return Number.isFinite(ms) ? ms : 0;
}

function hitFromMirror(parsed: ParsedMirror, query: string): MirrorSearchHit | null {
  const q = query.trim().toLowerCase();
  const subject = typeof parsed.frontmatter.subject === "string" ? parsed.frontmatter.subject : undefined;
  const from = typeof parsed.frontmatter.from === "string" ? parsed.frontmatter.from : undefined;
  const threadMessages = Array.isArray(parsed.frontmatter.thread_messages)
    ? (parsed.frontmatter.thread_messages as Array<{ date?: string }>)
    : [];
  const date = resolveThreadSortDate(parsed.frontmatter, threadMessages);
  const unread = typeof parsed.frontmatter.unread === "boolean" ? parsed.frontmatter.unread : undefined;
  const haystack = [subject, from, date, parsed.body].filter(Boolean).join("\n").toLowerCase();
  if (q && !haystack.includes(q)) return null;

  const snippet = (parsed.body || subject || from || "").slice(0, 240);
  const threadId =
    typeof parsed.frontmatter.thread_id === "string" ? parsed.frontmatter.thread_id : undefined;
  const externalId =
    typeof parsed.frontmatter.external_id === "string" ? parsed.frontmatter.external_id : undefined;
  const messageCount =
    typeof parsed.frontmatter.message_count === "number"
      ? parsed.frontmatter.message_count
      : threadMessages.length > 0
        ? threadMessages.length
        : undefined;
  return {
    path: parsed.absolutePath,
    relativePath: parsed.relativePath,
    threadId,
    externalId,
    subject,
    from,
    date,
    snippet,
    unread,
    messageCount,
  };
}

export async function searchMailMirrorAcrossDirs(opts: {
  threadsDirs: string[];
  filesRoot: string;
  query?: string;
  unreadOnly?: boolean;
  limit?: number;
}): Promise<MirrorSearchHit[]> {
  const limit = opts.limit ?? 50;
  const merged: MirrorSearchHit[] = [];
  for (const threadsDir of opts.threadsDirs) {
    const batch = await searchMailMirror({
      threadsDir,
      filesRoot: opts.filesRoot,
      query: opts.query,
      unreadOnly: opts.unreadOnly,
      limit,
    });
    merged.push(...batch);
    if (merged.length >= limit) break;
  }
  merged.sort((a, b) => hitSortMs(b) - hitSortMs(a));
  return merged.slice(0, limit);
}

export async function searchMailMirror(opts: {
  threadsDir: string;
  filesRoot: string;
  query?: string;
  unreadOnly?: boolean;
  limit?: number;
}): Promise<MirrorSearchHit[]> {
  const files = await listMarkdownFiles(opts.threadsDir, opts.threadsDir);
  const hits: MirrorSearchHit[] = [];
  const limit = opts.limit ?? 50;

  for (const file of files) {
    const parsed = await readParsedMirror(file, opts.filesRoot);
    if (!parsed) continue;
    if (opts.unreadOnly && parsed.frontmatter.unread !== true) continue;
    const hit = hitFromMirror(parsed, opts.query ?? "");
    if (!hit) continue;
    hits.push(hit);
  }

  // Gmail inbox: newest thread activity first (date = last message in thread).
  hits.sort((a, b) => hitSortMs(b) - hitSortMs(a));
  return hits.slice(0, limit);
}

export async function searchCalendarMirror(opts: {
  eventsDir: string;
  filesRoot: string;
  query?: string;
  limit?: number;
}): Promise<MirrorSearchHit[]> {
  const files = await listMarkdownFiles(opts.eventsDir, opts.eventsDir);
  const hits: MirrorSearchHit[] = [];
  const limit = opts.limit ?? 50;

  for (const file of files) {
    const parsed = await readParsedMirror(file, opts.filesRoot);
    if (!parsed) continue;
    const title = typeof parsed.frontmatter.title === "string" ? parsed.frontmatter.title : undefined;
    const q = (opts.query ?? "").trim().toLowerCase();
    const haystack = [title, parsed.body].filter(Boolean).join("\n").toLowerCase();
    if (q && !haystack.includes(q)) continue;
    hits.push({
      path: parsed.absolutePath,
      relativePath: parsed.relativePath,
      subject: title,
      date: typeof parsed.frontmatter.start === "string" ? parsed.frontmatter.start : undefined,
      snippet: (parsed.body || title || "").slice(0, 240),
    });
    if (hits.length >= limit) break;
  }

  hits.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  return hits;
}
