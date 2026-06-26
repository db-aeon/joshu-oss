/**
 * Composio OneNote toolkit — read page HTML and list pages.
 * @see https://docs.composio.dev/toolkits/onenote
 */
import { resolveComposioUserId } from "../../composioApi.js";
import { composioToolsExecute } from "../../composio/executeWithModifiers.js";
import { parseOneNoteUrl, requirePageId, type ParsedOneNoteUrl } from "../../onenote/parseUrl.js";
import { COMPOSIO_ONENOTE_TOOLKIT_VERSION } from "./onenoteConfig.js";
import { resolveOnenoteAccount } from "./onenoteAccounts.js";

export type OnenoteExecuteContext = {
  connectedAccountId: string;
};

export type OnenotePageSummary = {
  id: string;
  title?: string;
  contentUrl?: string;
  lastModifiedDateTime?: string;
  createdDateTime?: string;
};

async function executeOnenote(
  projectRoot: string,
  toolSlug: string,
  args: Record<string, unknown>,
  ctx: OnenoteExecuteContext,
): Promise<{ successful: boolean; data?: unknown; error?: string }> {
  const userId = resolveComposioUserId(projectRoot);
  try {
    const result = await composioToolsExecute(
      toolSlug,
      {
        userId,
        connectedAccountId: ctx.connectedAccountId,
        arguments: args,
        version: COMPOSIO_ONENOTE_TOOLKIT_VERSION,
      },
      projectRoot,
    );
    const row = result as { data?: unknown; error?: string; successful?: boolean };
    if (row.successful === false || row.error) {
      return { successful: false, error: row.error || `${toolSlug} failed` };
    }
    return { successful: true, data: row.data ?? result };
  } catch (err) {
    return { successful: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function unwrapData(data: unknown): unknown {
  if (typeof data === "string") return data;
  if (!data || typeof data !== "object") return data;
  const root = data as Record<string, unknown>;
  if (typeof root.data === "string") return root.data;
  if (root.data && typeof root.data === "object") return root.data;
  return data;
}

function unwrapHtml(data: unknown): string {
  const value = unwrapData(data);
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    if (typeof row.content === "string") return row.content;
    if (typeof row.html === "string") return row.html;
  }
  throw new Error("OneNote page content response was not HTML");
}

function unwrapPageList(data: unknown): OnenotePageSummary[] {
  const value = unwrapData(data);
  if (Array.isArray(value)) {
    return value.map(normalizePageSummary).filter((p): p is OnenotePageSummary => Boolean(p));
  }
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    const items = row.value;
    if (Array.isArray(items)) {
      return items.map(normalizePageSummary).filter((p): p is OnenotePageSummary => Boolean(p));
    }
  }
  return [];
}

function normalizePageSummary(row: unknown): OnenotePageSummary | null {
  if (!row || typeof row !== "object") return null;
  const page = row as Record<string, unknown>;
  const id = typeof page.id === "string" ? page.id : undefined;
  if (!id) return null;
  return {
    id,
    title: typeof page.title === "string" ? page.title : undefined,
    contentUrl: typeof page.contentUrl === "string" ? page.contentUrl : undefined,
    lastModifiedDateTime:
      typeof page.lastModifiedDateTime === "string" ? page.lastModifiedDateTime : undefined,
    createdDateTime:
      typeof page.createdDateTime === "string" ? page.createdDateTime : undefined,
  };
}

async function requireOnenoteContext(
  projectRoot: string,
  connectedAccountId?: string,
): Promise<OnenoteExecuteContext> {
  const account = await resolveOnenoteAccount(projectRoot, connectedAccountId);
  if (!account) {
    throw new Error(
      "OneNote is not connected — open Connectors app and connect Microsoft OneNote (Composio ONENOTE toolkit)",
    );
  }
  return { connectedAccountId: account.connectedAccountId };
}

export async function fetchOnenotePageHtml(
  projectRoot: string,
  opts: {
    pageId: string;
    connectedAccountId?: string;
    includeIds?: boolean;
  },
): Promise<string> {
  const ctx = await requireOnenoteContext(projectRoot, opts.connectedAccountId);
  const result = await executeOnenote(
    projectRoot,
    "ONENOTE_GET_ONENOTE_USER_PAGE_CONTENT",
    {
      page_id: opts.pageId,
      user_id: "me",
      ...(opts.includeIds ? { include_ids: true } : {}),
    },
    ctx,
  );
  if (!result.successful) {
    throw new Error(result.error || "Failed to fetch OneNote page HTML");
  }
  return unwrapHtml(result.data);
}

export async function listOnenoteSectionPages(
  projectRoot: string,
  opts: {
    sectionId: string;
    connectedAccountId?: string;
    limit?: number;
  },
): Promise<OnenotePageSummary[]> {
  const ctx = await requireOnenoteContext(projectRoot, opts.connectedAccountId);
  const result = await executeOnenote(
    projectRoot,
    "ONENOTE_LIST_ME_ONENOTE_SECTIONS_PAGES4",
    {
      section_id: opts.sectionId,
      ...(opts.limit ? { top: opts.limit } : {}),
    },
    ctx,
  );
  if (!result.successful) {
    throw new Error(result.error || "Failed to list OneNote section pages");
  }
  return unwrapPageList(result.data);
}

export async function fetchOnenotePageFromUrl(
  projectRoot: string,
  opts: {
    url: string;
    connectedAccountId?: string;
    includeIds?: boolean;
  },
): Promise<{ parsed: ParsedOneNoteUrl; pageId: string; html: string }> {
  const parsed = parseOneNoteUrl(opts.url);
  const pageId = requirePageId(opts.url);
  const html = await fetchOnenotePageHtml(projectRoot, {
    pageId,
    connectedAccountId: opts.connectedAccountId,
    includeIds: opts.includeIds,
  });
  return { parsed, pageId, html };
}
