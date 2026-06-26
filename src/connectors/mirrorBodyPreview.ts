/**
 * Build LLM-facing body previews from connector thread mirrors.
 * Mirrors store messages oldest → newest; previews prioritize the latest section.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseGmailThreadMirrorSections } from "./composio/gmailMirrorFormat.js";

const FM_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/** Strip YAML frontmatter from a mirror markdown file. */
export function stripMirrorFrontmatter(raw: string): string {
  return raw.replace(FM_RE, "").trim();
}

/**
 * Prefer the latest ### section body; fill remaining budget from the tail of the prior
 * section so short replies ("Yes, 3pm works") retain scheduling context.
 */
export function buildThreadBodyPreview(bodyMarkdown: string, maxChars = 2000): string {
  const trimmed = bodyMarkdown.trim();
  if (!trimmed) return "";

  const sections = parseGmailThreadMirrorSections(trimmed);
  if (sections.length === 0) {
    return trimmed.slice(0, maxChars);
  }

  const latest = sections[sections.length - 1]!.body.trim();
  if (latest.length >= maxChars) {
    return latest.slice(0, maxChars);
  }

  let preview = latest;
  if (sections.length > 1 && preview.length < maxChars) {
    const prior = sections[sections.length - 2]!.body.trim();
    const remaining = maxChars - preview.length - 2;
    if (remaining > 0 && prior.length > 0) {
      const tail = prior.length > remaining ? prior.slice(-remaining) : prior;
      preview = `${tail}\n\n${preview}`;
    }
  }

  return preview.slice(0, maxChars);
}

export async function readMirrorBodyPreview(
  filesRoot: string,
  sourcePath: string,
  maxChars = 2000,
): Promise<string> {
  const full = path.join(filesRoot, sourcePath);
  try {
    const raw = await readFile(full, "utf8");
    return buildThreadBodyPreview(stripMirrorFrontmatter(raw), maxChars);
  } catch {
    return "";
  }
}
