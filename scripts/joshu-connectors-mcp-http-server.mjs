#!/usr/bin/env node
/**
 * Thin Joshu connectors MCP over HTTP (actions + sync — not mail search; use gbrain for recall).
 *
 * Env: JOSHU_CONNECTORS_MCP_PORT (default 8795), JOSHU_PORT / PUBLIC_BASE_PATH for REST callbacks
 */
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import {
  connectorsToolBlockReason,
  defaultMcpToolPolicy,
  mcpToolPolicyFromApi,
} from "./lib/mcp-tool-policy.mjs";

const PORT = Number.parseInt(process.env.JOSHU_CONNECTORS_MCP_PORT || "8795", 10);
const HOST = process.env.JOSHU_CONNECTORS_MCP_HOST?.trim() || "127.0.0.1";
const JOSHU_BASE = (process.env.JOSHU_CONNECTORS_API_BASE || "http://127.0.0.1:8788/joshu").replace(/\/+$/, "");

function log(msg) {
  process.stderr.write(`${msg}\n`);
}

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function formatJoshuApiError(path, res, text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("<") || trimmed.includes("<title>Not Found</title>")) {
    return (
      `Joshu API unreachable at ${JOSHU_BASE}${path} — got HTML ${res.status} (wrong host or Joshu down). ` +
      `Verify Joshu is running: curl -fsS ${JOSHU_BASE}/api/instance/version`
    );
  }
  if (trimmed.length > 400) {
    return `${trimmed.slice(0, 400)}…`;
  }
  return trimmed;
}

async function probeJoshuUpstream() {
  try {
    const res = await fetch(`${JOSHU_BASE}/api/instance/version`, {
      signal: AbortSignal.timeout(3_000),
    });
    const ct = res.headers.get("content-type") || "";
    if (!res.ok) {
      return { ok: false, detail: `HTTP ${res.status}` };
    }
    if (!ct.includes("json")) {
      return { ok: false, detail: "non-JSON response (wrong host?)" };
    }
    return { ok: true, detail: "" };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function joshuApiError(path, res, text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  // Prefer rich learning feedback when Joshu returns structured mail errors
  // (e.g. reply_subject_mismatch with expectedSubject + hint).
  if (json && typeof json === "object" && (json.hint || json.expectedSubject || json.reason)) {
    const parts = [
      typeof json.error === "string" ? json.error : null,
      typeof json.reason === "string" ? json.reason : null,
      typeof json.hint === "string" ? json.hint : null,
      typeof json.expectedSubject === "string"
        ? `expectedSubject=${JSON.stringify(json.expectedSubject)}`
        : null,
      typeof json.gotSubject === "string" ? `gotSubject=${JSON.stringify(json.gotSubject)}` : null,
    ].filter(Boolean);
    if (parts.length > 0) {
      throw new Error(parts.join(" | "));
    }
  }
  const message = json.error || json.raw || formatJoshuApiError(path, res, text);
  throw new Error(typeof message === "string" ? message : `HTTP ${res.status}`);
}

async function joshuPost(path, body) {
  const res = await fetch(`${JOSHU_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) {
    joshuApiError(path, res, text);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return json;
}

async function joshuGet(path) {
  const res = await fetch(`${JOSHU_BASE}${path}`);
  const text = await res.text();
  if (!res.ok) {
    joshuApiError(path, res, text);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return json;
}

async function joshuPatch(path, body) {
  const res = await fetch(`${JOSHU_BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) {
    joshuApiError(path, res, text);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return json;
}

async function joshuDelete(path) {
  const res = await fetch(`${JOSHU_BASE}${path}`, { method: "DELETE" });
  const text = await res.text();
  if (!res.ok) {
    joshuApiError(path, res, text);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return json;
}

/** @param {unknown} raw */
function buildEventQuery(raw) {
  const params = new URLSearchParams();
  if (raw && typeof raw === "object") {
    const q = /** @type {Record<string, unknown>} */ (raw);
    if (q.start != null) params.set("start", String(q.start));
    if (q.end != null) params.set("end", String(q.end));
    if (q.date != null) params.set("date", String(q.date));
    if (q.timezone != null) params.set("timezone", String(q.timezone));
    if (q.timeZone != null) params.set("timezone", String(q.timeZone));
    if (q.limit != null) params.set("limit", String(q.limit));
    const cal = q.calendarId ?? q.calendar_id;
    if (cal != null) params.set("calendar_id", String(cal));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** Pass local slot fields through to REST for server-side epoch conversion. */
function eventBodyFromArgs(args) {
  if (!args || typeof args !== "object") return {};
  const a = /** @type {Record<string, unknown>} */ (args);
  return {
    title: a.title,
    startTime: a.startTime,
    endTime: a.endTime,
    date: a.date,
    startLocal: a.startLocal ?? a.start_local ?? a.startTimeLocal,
    endLocal: a.endLocal ?? a.end_local ?? a.endTimeLocal,
    timezone: a.timezone ?? a.timeZone,
    description: a.description,
    location: a.location,
    participants: a.participants,
    notifyParticipants: a.notifyParticipants,
    calendarId: a.calendarId ?? a.calendar_id,
  };
}

/** Hermes exposes MCP tools as mcp_<server>_<tool>; some clients forward that verbatim. */
const HERMES_TOOL_PREFIX = "mcp_joshu_connectors_";

/**
 * @param {string | undefined} raw
 * @returns {string}
 */
function normalizeToolName(raw) {
  const name = String(raw ?? "").trim();
  if (!name) return "";
  if (name.startsWith(HERMES_TOOL_PREFIX)) {
    return name.slice(HERMES_TOOL_PREFIX.length);
  }
  return name;
}

const TOOLS = [
  {
    name: "connectors_sync_now",
    description:
      "Trigger connector mirror sync to markdown under joshu's files. Use gbrain query for mail search, not this tool.",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: ["nylas", "gmail", "all"],
          description: "Which connector to sync (default all)",
        },
        limit: { type: "number", description: "Max messages per provider (default 40)" },
        connectedAccountId: {
          type: "string",
          description: "Gmail only: sync a specific connected account (omit = all Gmail accounts)",
        },
      },
    },
  },
  {
    name: "connectors_status",
    description: "Last sync times and connector availability on this box.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "nylas_send_message",
    description:
      "Send email from the Nylas agent mailbox. Use to + cc for multi-party scheduling (one reply-all). Do not pass comma-separated addresses in to. When replyToMessageId is set, subject must match the parent message exactly (only Re:/Fwd: prefix differences allowed) or the API returns reply_subject_mismatch — do not decorate subjects.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          description: "Primary recipient(s): email string, comma-separated string, or array of emails/objects",
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
            {
              type: "array",
              items: {
                type: "object",
                properties: { email: { type: "string" }, name: { type: "string" } },
                required: ["email"],
              },
            },
          ],
        },
        cc: {
          description: "CC recipients (same formats as to) — use for guests on owner thread replies",
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
            {
              type: "array",
              items: {
                type: "object",
                properties: { email: { type: "string" }, name: { type: "string" } },
                required: ["email"],
              },
            },
          ],
        },
        bcc: {
          description: "BCC recipients (same formats as to)",
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        subject: {
          type: "string",
          description:
            "Email subject. On replies (replyToMessageId set), copy the parent subject exactly from the thread mirror — do not append availability, names, or task titles (Gmail will fork a new conversation).",
        },
        body: { type: "string" },
        replyToMessageId: {
          type: "string",
          description:
            "Nylas message id you are continuing. Requires matching subject (see subject). Use message_id / external_id from the mirror.",
        },
        sourcePath: {
          type: "string",
          description:
            "Relative mirror path under JOSHU_FILES_ROOT (e.g. connectors/mail/gmail/.../threads/<id>.md). Required for thread replies when authorization may have changed — pass from meeting task source_paths.",
        },
        source_path: {
          type: "string",
          description: "Alias for sourcePath",
        },
        kanbanTaskId: {
          type: "string",
          description:
            "ea-scheduling meeting task id (e.g. t_…). When set, Joshu rewrites that task's block_reason after action-guard approve/deny so status does not stay on 'awaiting owner approval' after mail delivers.",
        },
        kanban_task_id: {
          type: "string",
          description: "Alias for kanbanTaskId",
        },
        threadId: {
          type: "string",
          description: "Optional mail thread id for audit/context (with kanbanTaskId).",
        },
        thread_id: {
          type: "string",
          description: "Alias for threadId",
        },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "nylas_get_message",
    description: "Fetch a single Nylas message by id (live API). Prefer gbrain for search.",
    inputSchema: {
      type: "object",
      properties: { messageId: { type: "string" } },
      required: ["messageId"],
    },
  },
  {
    name: "nylas_get_profile",
    description:
      "Read agent/owner profile (timezone, working hours, emails). Use before scheduling — do not read .joshu from disk.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "nylas_update_profile",
    description:
      "Persist owner/agent profile fields (especially timezone once confirmed). Updates .joshu/nylas/profile.json for future Kanban runs.",
    inputSchema: {
      type: "object",
      properties: {
        timezone: { type: "string", description: "IANA TZ e.g. America/Los_Angeles" },
        primaryWorkEmail: { type: "string" },
        ownerName: { type: "string" },
        assistantName: { type: "string" },
        assistantEmail: { type: "string" },
        workingHoursStart: { type: "string" },
        workingHoursEnd: { type: "string" },
      },
    },
  },
  {
    name: "google_calendar_find_free_slots",
    description:
      "Live owner Google Calendar FreeBusy via Composio GOOGLECALENDAR_FIND_FREE_SLOTS — SOURCE OF TRUTH for owner busy/free. Respects Google 'Show as free' (transparent) events. Omit items to query primary + owner personal Gmail calendars (from profile + connected account). Returns per-calendar busy/free plus calendars.combined (union busy — use combined.free for scheduling). date+timezone or timeMin+timeMax. Do NOT use google_calendar_list_events for availability.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD — one local day when used with timezone" },
        timezone: { type: "string", description: "IANA TZ with date, e.g. America/Los_Angeles" },
        timeMin: { type: "string", description: "ISO/local start — alternative to date+timezone" },
        timeMax: { type: "string", description: "ISO/local end (exclusive) — alternative to date+timezone" },
        items: {
          type: "array",
          description:
            "Calendar ids to query. Omit for default: primary + personalEmail + selected Gmail calendars on the connected account.",
          items: { type: "string" },
        },
        minDurationMinutes: {
          type: "number",
          description: "Filter free[] to intervals at least this long (default 30)",
        },
        connectedAccountId: { type: "string", description: "Composio connected account (omit = default)" },
      },
    },
  },
  {
    name: "google_calendar_list_events",
    description:
      "Live owner Google Calendar event list via Composio — titles, times, transparency. NOT for busy/free (use google_calendar_find_free_slots). Each event includes blocksAvailability: false when Google 'Show as free'. Owner may edit calendars; do not use Nylas or stale mirrors.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD — one local day when used with timezone" },
        timezone: { type: "string", description: "IANA TZ with date, e.g. America/Los_Angeles" },
        daysBack: { type: "number", description: "Days before now (default 1) when date omitted" },
        daysForward: { type: "number", description: "Days after now (default 14) when date omitted" },
        limit: { type: "number", description: "Max events (default 120)" },
        connectedAccountId: { type: "string", description: "Composio connected account (omit = default)" },
      },
    },
  },
  {
    name: "onenote_fetch_page_content",
    description:
      "Fetch OneNote page HTML via Composio (Microsoft Graph). Pass a OneDrive Doc.aspx URL or pageId. Requires OneNote connected in Connectors app.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "OneDrive/OneNote web URL (Doc.aspx wd=target(...))",
        },
        pageId: { type: "string", description: "OneNote page UUID" },
        sectionId: { type: "string", description: "With listPages=true, list pages in section" },
        listPages: {
          type: "boolean",
          description: "List pages in sectionId instead of fetching HTML",
        },
        includeIds: {
          type: "boolean",
          description: "Include element IDs in returned HTML (for updates)",
        },
        connectedAccountId: { type: "string" },
      },
    },
  },
  {
    name: "nylas_list_events",
    description:
      "Agent Nylas calendar only (coordination ledger — holds Patrick placed). NOT owner availability; owner may change real calendars. Use google_calendar_find_free_slots for busy/free.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD — full local day window when used with timezone" },
        timezone: { type: "string", description: "IANA TZ with date, e.g. America/Los_Angeles" },
        start: { type: "number", description: "Unix start (inclusive) — alternative to date+timezone" },
        end: { type: "number", description: "Unix end (inclusive) — alternative to date+timezone" },
        limit: { type: "number", description: "Max events (default 50)" },
        calendarId: { type: "string", description: "Default primary" },
      },
    },
  },
  {
    name: "nylas_get_event",
    description: "Fetch one agent calendar event by id (verify after create/update).",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string" },
        calendarId: { type: "string" },
      },
      required: ["eventId"],
    },
  },
  {
    name: "nylas_create_event",
    description:
      "Create event on agent Nylas calendar. Pass date+startLocal+endLocal+timezone (preferred) or startTime/endTime epochs. Always include participants (owner primaryWorkEmail + confirmed attendees).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD (with startLocal/endLocal/timezone)" },
        startLocal: { type: "string", description: "Local start HH:mm or HH:mm:ss" },
        endLocal: { type: "string", description: "Local end HH:mm or HH:mm:ss" },
        startTime: { type: "number", description: "Unix start — alternative to date+startLocal+endLocal" },
        endTime: { type: "number", description: "Unix end — alternative to date+startLocal+endLocal" },
        timezone: { type: "string", description: "IANA TZ, e.g. America/Los_Angeles" },
        description: { type: "string" },
        location: { type: "string" },
        participants: {
          type: "array",
          description: "Invitees — always include owner primaryWorkEmail",
          items: {
            type: "object",
            properties: {
              email: { type: "string" },
              name: { type: "string" },
            },
            required: ["email"],
          },
        },
        notifyParticipants: {
          type: "boolean",
          description: "Send calendar invites (default true)",
        },
        calendarId: { type: "string" },
      },
      required: ["title"],
    },
  },
  {
    name: "nylas_update_event",
    description: "Update agent calendar event (reschedule, add participants, cancel details).",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string" },
        title: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD with startLocal/endLocal/timezone" },
        startLocal: { type: "string" },
        endLocal: { type: "string" },
        startTime: { type: "number" },
        endTime: { type: "number" },
        timezone: { type: "string" },
        description: { type: "string" },
        location: { type: "string" },
        participants: {
          type: "array",
          items: {
            type: "object",
            properties: {
              email: { type: "string" },
              name: { type: "string" },
            },
            required: ["email"],
          },
        },
        notifyParticipants: { type: "boolean" },
        calendarId: { type: "string" },
      },
      required: ["eventId"],
    },
  },
  {
    name: "nylas_delete_event",
    description: "Delete/cancel an agent calendar event.",
    inputSchema: {
      type: "object",
      properties: {
        eventId: { type: "string" },
        calendarId: { type: "string" },
      },
      required: ["eventId"],
    },
  },
  {
    name: "scheduling_list_meeting_tasks",
    description:
      "List open meeting tasks on Kanban board ea-scheduling (ready, running, blocked, todo). Includes task body, block_reason, and recent kanban comments (outreach / handoff history). Use before claiming mail was not sent.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "scheduling_create_meeting_task",
    description:
      "Create a meeting task on Kanban board ea-scheduling (Joshu bridge). Required from ingress — never use kanban_create for meetings.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Ingress message_id (idempotency)" },
        sourcePath: { type: "string", description: "Relative mail mirror path under JOSHU_FILES_ROOT" },
        threadId: { type: "string", description: "Mail thread id — Joshu returns existing open meeting on same thread" },
        provider: { type: "string", description: "gmail or nylas" },
        subject: { type: "string" },
        from: { type: "string", description: "From header e.g. Dan B <dan@example.com>" },
        timezone: { type: "string", description: "IANA timezone if known" },
        title: { type: "string", description: "Optional Kanban task title" },
        body: { type: "string", description: "Optional full meeting task body YAML" },
      },
      required: ["messageId", "sourcePath"],
    },
  },
  {
    name: "scheduling_handoff_meeting_task",
    description:
      "Ingress match: deliver new mail to a meeting on ea-scheduling — append source_path + ingress_handoff to task body, comment summary. Joshu queues one meeting-worker evaluation if task was blocked; worker decides book vs kanban_block (e.g. still 'let me find a time').",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        sourcePath: { type: "string", description: "Mail mirror path under JOSHU_FILES_ROOT" },
        messageId: { type: "string" },
        from: { type: "string" },
        summary: { type: "string", description: "Neutral summary of this mail — do not decide if waiting is over" },
      },
      required: ["taskId", "sourcePath", "messageId", "summary"],
    },
  },
  {
    name: "scheduling_comment_meeting_task",
    description: "Simple comment on ea-scheduling (e.g. link after create). For ingress match on replies use scheduling_handoff_meeting_task.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        body: { type: "string" },
      },
      required: ["taskId", "body"],
    },
  },
  {
    name: "scheduling_unblock_meeting_task",
    description: "Manual unblock on ea-scheduling (ops/debug).",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Meeting task_id on ea-scheduling" },
      },
      required: ["taskId"],
    },
  },
  {
    name: "scheduling_ingress_pending",
    description:
      "@deprecated v4 — use per-email ingress Kanban tasks. List pending JSONL ingress events.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mark_scheduling_ingress_processed",
    description:
      "Mark ingress event(s) processed after routing to a meeting Kanban task (task_id = meeting identity).",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Ingress event ids from scheduling_ingress_pending",
        },
        meetingTaskId: {
          type: "string",
          description: "Kanban task_id for the meeting project",
        },
      },
      required: ["ids"],
    },
  },
  {
    name: "mail_list_track_tasks",
    description:
      "List open mail track tasks on project-<slug> (ready, running, blocked, todo). Use from ea-mail-ingress worker — Hermes kanban_list cannot cross boards.",
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: {
          type: "string",
          description: "Projects/<slug>/ folder name, e.g. joshu-product-development",
        },
      },
      required: ["projectSlug"],
    },
  },
  {
    name: "mail_create_track_task",
    description:
      "Create a blocked mail track task on project-<slug> (Joshu bridge). Required from mail ingress — not Hermes kanban_create.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string" },
        sourcePath: { type: "string", description: "Mail mirror path under JOSHU_FILES_ROOT" },
        projectSlug: { type: "string" },
        provider: { type: "string", enum: ["gmail", "nylas"] },
        threadId: { type: "string" },
        subject: { type: "string" },
        from: { type: "string" },
        category: { type: "string" },
        isNewTrack: { type: "boolean" },
        title: { type: "string" },
      },
      required: ["messageId", "sourcePath", "projectSlug", "threadId"],
    },
  },
  {
    name: "mail_handoff_track_task",
    description:
      "Mail ingress match: deliver new mail to an existing track on project-<slug> — append source_path + mail_handoff. Queues worker evaluation if task was blocked.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        projectSlug: { type: "string" },
        sourcePath: { type: "string" },
        messageId: { type: "string" },
        from: { type: "string" },
        summary: { type: "string", description: "Neutral summary — do not decide if waiting is over" },
      },
      required: ["taskId", "projectSlug", "sourcePath", "messageId", "summary"],
    },
  },
  {
    name: "archive_scheduling_stubs",
    description:
      "Legacy: move linked Triage stubs to Triage/_done/ after an old MD scheduling case is confirmed or cancelled. New Kanban-only scheduling does not use MD cases.",
    inputSchema: {
      type: "object",
      properties: {
        caseId: { type: "string", description: "scheduling case_id from Kanban task body" },
        caseRelativePath: {
          type: "string",
          description: "Optional path e.g. Projects/other/scheduling/meet-….md",
        },
        stubRelativePath: {
          type: "string",
          description: "Optional single stub e.g. Triage/nylas-….stub.md",
        },
      },
    },
  },
  {
    name: "reconcile_triage_stubs",
    description:
      "Archive any Triage stubs whose scheduling case is terminal, or already marked state: done but still in the active queue.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "project_kanban_ensure_board",
    description:
      "Ensure a Hermes Kanban board project-<slug> exists for ea-project-kanban kickoff. Uses Joshu bridge (not Hermes CLI). Slug is the Projects/<slug>/ folder name.",
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: {
          type: "string",
          description: "Project folder slug, e.g. joshu-waitlist-drip (board becomes project-joshu-waitlist-drip)",
        },
        name: { type: "string", description: "Display name for the board" },
        description: { type: "string", description: "Board description" },
      },
      required: ["projectSlug"],
    },
  },
  {
    name: "project_kanban_create_triage_root",
    description:
      "Create a triage root card on project-<slug> for auto-decompose (ea-project-kanban). Ensures the board exists first. Body should follow references/decomposition-template.md.",
    inputSchema: {
      type: "object",
      properties: {
        projectSlug: {
          type: "string",
          description: "Project folder slug, e.g. joshu-waitlist-drip",
        },
        title: { type: "string", description: "Root card title" },
        body: { type: "string", description: "Triage root card body (YAML/markdown per decomposition template)" },
        name: { type: "string", description: "Optional board display name when ensuring board" },
        description: { type: "string", description: "Optional board description when ensuring board" },
      },
      required: ["projectSlug", "title", "body"],
    },
  },
];

/** @type {Map<string, { transport: StreamableHTTPServerTransport; server: Server }>} */
const sessions = new Map();

/** @type {import("./lib/mcp-tool-policy.mjs").McpToolPolicy | null} */
let cachedMcpToolPolicy = null;

async function loadMcpToolPolicy() {
  if (cachedMcpToolPolicy) return cachedMcpToolPolicy;
  try {
    const res = await fetch(`${JOSHU_BASE}/api/mcp-tool-policy`);
    const payload = await res.json();
    cachedMcpToolPolicy = mcpToolPolicyFromApi(payload);
  } catch {
    cachedMcpToolPolicy = defaultMcpToolPolicy();
  }
  return cachedMcpToolPolicy;
}

async function handleTool(name, args) {
  const policy = await loadMcpToolPolicy();
  const blockReason = connectorsToolBlockReason(name, policy);
  if (blockReason) {
    return {
      content: [{ type: "text", text: blockReason }],
      isError: true,
    };
  }
  if (name === "connectors_sync_now") {
    const provider = args?.provider ?? "all";
    const limit = args?.limit ?? 40;
    const results = {};
    if (provider === "nylas" || provider === "all") {
      results.nylas = await joshuPost("/api/connectors/mail/nylas/sync", { limit });
    }
    if (provider === "gmail" || provider === "all") {
      results.gmail = await joshuPost("/api/connectors/mail/gmail/sync", {
        limit,
        ...(args?.connectedAccountId ? { connectedAccountId: args.connectedAccountId } : {}),
      });
    }
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  }
  if (name === "connectors_status") {
    const status = await joshuGet("/api/connectors/status");
    return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
  }
  if (name === "nylas_send_message") {
    const sourcePath = args.sourcePath ?? args.source_path;
    const kanbanTaskId = args.kanbanTaskId ?? args.kanban_task_id ?? args.taskId ?? args.task_id;
    const threadId = args.threadId ?? args.thread_id;
    const out = await joshuPost("/api/nylas/messages/send", {
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      subject: args.subject,
      body: args.body,
      replyToMessageId: args.replyToMessageId,
      ...(sourcePath ? { sourcePath: String(sourcePath) } : {}),
      ...(kanbanTaskId ? { kanbanTaskId: String(kanbanTaskId) } : {}),
      ...(threadId ? { threadId: String(threadId) } : {}),
    });
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
  if (name === "nylas_get_message") {
    const out = await joshuGet(`/api/nylas/messages/${encodeURIComponent(args.messageId)}`);
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
  if (name === "nylas_get_profile") {
    const out = await joshuGet("/api/nylas/profile");
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
  if (name === "nylas_update_profile") {
    const out = await joshuPost("/api/nylas/profile", {
      timezone: args?.timezone,
      primaryWorkEmail: args?.primaryWorkEmail ?? args?.primary_work_email,
      ownerName: args?.ownerName ?? args?.owner_name,
      assistantName: args?.assistantName ?? args?.assistant_name,
      assistantEmail: args?.assistantEmail ?? args?.assistant_email,
      workingHoursStart: args?.workingHoursStart ?? args?.working_hours_start,
      workingHoursEnd: args?.workingHoursEnd ?? args?.working_hours_end,
    });
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
  if (name === "google_calendar_find_free_slots") {
    const params = new URLSearchParams();
    if (args?.date != null) params.set("date", String(args.date));
    const tz = args?.timezone ?? args?.timeZone;
    if (tz != null) params.set("timezone", String(tz));
    const timeMin = args?.timeMin ?? args?.time_min;
    const timeMax = args?.timeMax ?? args?.time_max;
    if (timeMin != null) params.set("timeMin", String(timeMin));
    if (timeMax != null) params.set("timeMax", String(timeMax));
    if (args?.minDurationMinutes != null) {
      params.set("minDurationMinutes", String(args.minDurationMinutes));
    }
    const items = args?.items;
    if (Array.isArray(items) && items.length > 0) {
      params.set("items", items.map(String).join(","));
    } else if (typeof items === "string" && items.trim()) {
      params.set("items", items.trim());
    }
    const acct = args?.connectedAccountId ?? args?.connected_account_id;
    if (acct != null) params.set("connectedAccountId", String(acct));
    const qs = params.toString();
    const out = await joshuGet(`/api/connectors/calendar/google/free-slots${qs ? `?${qs}` : ""}`);
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
  if (name === "google_calendar_list_events") {
    const params = new URLSearchParams();
    if (args?.date != null) params.set("date", String(args.date));
    const tz = args?.timezone ?? args?.timeZone;
    if (tz != null) params.set("timezone", String(tz));
    if (args?.daysBack != null) params.set("daysBack", String(args.daysBack));
    if (args?.daysForward != null) params.set("daysForward", String(args.daysForward));
    if (args?.limit != null) params.set("limit", String(args.limit));
    const acct = args?.connectedAccountId ?? args?.connected_account_id;
    if (acct != null) params.set("connectedAccountId", String(acct));
    const qs = params.toString();
    const out = await joshuGet(`/api/connectors/calendar/google/events${qs ? `?${qs}` : ""}`);
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
  if (name === "onenote_fetch_page_content") {
    const listPages = args?.listPages === true;
    const sectionId = readString(args?.sectionId ?? args?.section_id);
    const acct = args?.connectedAccountId ?? args?.connected_account_id;
    if (listPages) {
      if (!sectionId) throw new Error("sectionId required when listPages=true");
      const params = new URLSearchParams();
      params.set("limit", String(args?.limit ?? 50));
      if (acct != null) params.set("connectedAccountId", String(acct));
      const out = await joshuGet(
        `/api/connectors/onenote/sections/${encodeURIComponent(sectionId)}/pages?${params}`,
      );
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    }
    const url = readString(args?.url);
    const pageId = readString(args?.pageId ?? args?.page_id);
    if (url) {
      const out = await joshuPost("/api/connectors/onenote/fetch-url", {
        url,
        connectedAccountId: acct,
        includeIds: args?.includeIds === true,
      });
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    }
    if (!pageId) throw new Error("url or pageId required");
    const params = new URLSearchParams({ pageId });
    if (args?.includeIds === true) params.set("includeIds", "true");
    if (acct != null) params.set("connectedAccountId", String(acct));
    const out = await joshuGet(`/api/connectors/onenote/page-content?${params}`);
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
  if (name === "nylas_list_events") {
    const out = await joshuGet(`/api/nylas/events${buildEventQuery(args)}`);
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
  if (name === "nylas_get_event") {
    const cal = args?.calendarId ?? args?.calendar_id;
    const qs = cal ? `?calendar_id=${encodeURIComponent(String(cal))}` : "";
    const out = await joshuGet(`/api/nylas/events/${encodeURIComponent(args.eventId)}${qs}`);
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
  if (name === "nylas_create_event") {
    const out = await joshuPost("/api/nylas/events", eventBodyFromArgs(args));
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
  if (name === "nylas_update_event") {
    const { eventId, calendarId, calendar_id, ...rest } = args ?? {};
    const out = await joshuPatch(`/api/nylas/events/${encodeURIComponent(eventId)}`, {
      ...eventBodyFromArgs(rest),
      calendarId: calendarId ?? calendar_id,
    });
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
  if (name === "nylas_delete_event") {
    const cal = args?.calendarId ?? args?.calendar_id;
    const qs = cal ? `?calendar_id=${encodeURIComponent(String(cal))}` : "";
    const out = await joshuDelete(`/api/nylas/events/${encodeURIComponent(args.eventId)}${qs}`);
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
  if (name === "scheduling_list_meeting_tasks") {
    const out = await joshuGet("/api/ea/scheduling/meetings");
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
  if (name === "scheduling_create_meeting_task") {
    const out = await joshuPost("/api/ea/scheduling/meetings", {
      messageId: args?.messageId ?? args?.message_id,
      sourcePath: args?.sourcePath ?? args?.source_path,
      threadId: args?.threadId ?? args?.thread_id,
      provider: args?.provider,
      subject: args?.subject,
      from: args?.from,
      timezone: args?.timezone,
      title: args?.title,
      body: args?.body,
    });
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
  if (name === "scheduling_handoff_meeting_task") {
    const taskId = args?.taskId ?? args?.task_id;
    if (!taskId) throw new Error("taskId required");
    const out = await joshuPost(
      `/api/ea/scheduling/meetings/${encodeURIComponent(String(taskId))}/handoff`,
      {
        sourcePath: args?.sourcePath ?? args?.source_path,
        messageId: args?.messageId ?? args?.message_id,
        from: args?.from,
        summary: args?.summary,
      },
    );
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
  if (name === "scheduling_unblock_meeting_task") {
    const taskId = args?.taskId ?? args?.task_id;
    if (!taskId) throw new Error("taskId required");
    const out = await joshuPost(
      `/api/ea/scheduling/meetings/${encodeURIComponent(String(taskId))}/unblock`,
      {},
    );
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
  if (name === "scheduling_comment_meeting_task") {
    const taskId = args?.taskId ?? args?.task_id;
    const out = await joshuPost(`/api/ea/scheduling/meetings/${encodeURIComponent(taskId)}/comment`, {
      body: args?.body,
    });
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
  if (name === "mail_list_track_tasks") {
    const slug = args?.projectSlug ?? args?.project_slug ?? args?.slug ?? "other";
    const out = await joshuGet(
      `/api/ea/mail/tracks?projectSlug=${encodeURIComponent(String(slug))}`,
    );
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
  if (name === "mail_create_track_task") {
    const out = await joshuPost("/api/ea/mail/tracks", {
      messageId: args?.messageId ?? args?.message_id,
      sourcePath: args?.sourcePath ?? args?.source_path,
      projectSlug: args?.projectSlug ?? args?.project_slug ?? args?.slug,
      provider: args?.provider,
      threadId: args?.threadId ?? args?.thread_id,
      subject: args?.subject,
      from: args?.from,
      category: args?.category,
      isNewTrack: args?.isNewTrack ?? args?.is_new_track,
      title: args?.title,
    });
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
  if (name === "mail_handoff_track_task") {
    const taskId = args?.taskId ?? args?.task_id;
    if (!taskId) throw new Error("taskId required");
    const out = await joshuPost(
      `/api/ea/mail/tracks/${encodeURIComponent(String(taskId))}/handoff`,
      {
        projectSlug: args?.projectSlug ?? args?.project_slug ?? args?.slug,
        sourcePath: args?.sourcePath ?? args?.source_path,
        messageId: args?.messageId ?? args?.message_id,
        from: args?.from,
        summary: args?.summary,
      },
    );
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
  if (name === "scheduling_ingress_pending") {
    const out = await joshuGet("/api/ea/scheduling/ingress");
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
  if (name === "mark_scheduling_ingress_processed") {
    const out = await joshuPost("/api/ea/scheduling/ingress/mark-processed", {
      ids: args?.ids ?? args?.eventIds ?? args?.event_ids,
      meetingTaskId: args?.meetingTaskId ?? args?.meeting_task_id ?? args?.taskId ?? args?.task_id,
    });
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
  if (name === "archive_scheduling_stubs") {
    const out = await joshuPost("/api/ea/triage/archive-stubs", {
      caseId: args?.caseId ?? args?.case_id,
      caseRelativePath: args?.caseRelativePath ?? args?.case_relative_path,
      stubRelativePath: args?.stubRelativePath ?? args?.stub_relative_path,
    });
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
  if (name === "reconcile_triage_stubs") {
    const out = await joshuPost("/api/ea/triage/reconcile-stubs", {});
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
  if (name === "project_kanban_ensure_board") {
    const out = await joshuPost("/api/ea/project-kanban/boards", {
      projectSlug: args?.projectSlug ?? args?.project_slug ?? args?.slug,
      name: args?.name,
      description: args?.description,
    });
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
  if (name === "project_kanban_create_triage_root") {
    const out = await joshuPost("/api/ea/project-kanban/triage-root", {
      projectSlug: args?.projectSlug ?? args?.project_slug ?? args?.slug,
      title: args?.title,
      body: args?.body,
      name: args?.name,
      description: args?.description,
    });
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  }
  return {
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
    isError: true,
  };
}

async function createMcpServer() {
  const server = new Server(
    { name: "joshu-connectors-mcp-http", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const policy = await loadMcpToolPolicy();
    const tools = TOOLS.filter((t) => !connectorsToolBlockReason(t.name, policy));
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const rawName = request.params.name;
      const name = normalizeToolName(rawName);
      if (rawName && name !== rawName) {
        log(`MCP tool name normalized: ${rawName} -> ${name}`);
      }
      return await handleTool(name, request.params.arguments ?? {});
    } catch (err) {
      return {
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  });

  return server;
}

async function main() {
  const app = createMcpExpressApp({ host: HOST });

  app.get("/health", async (_req, res) => {
    const joshu = await probeJoshuUpstream();
    const ready = joshu.ok;
    res.status(ready ? 200 : 503).json({
      ok: ready,
      ready,
      service: "joshu-connectors-mcp",
      joshu: { ok: joshu.ok, base: JOSHU_BASE, detail: joshu.detail || undefined },
    });
  });

  app.all("/mcp", async (req, res) => {
    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId = typeof sessionIdHeader === "string" ? sessionIdHeader : undefined;

    try {
      let session = sessionId ? sessions.get(sessionId) : undefined;

      if (!session && req.method === "POST") {
        const body = req.body;
        const messages = Array.isArray(body) ? body : body ? [body] : [];
        const isInit = messages.some((m) => isInitializeRequest(m));
        if (isInit) {
          let sessionEntry;
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              if (sessionEntry) sessions.set(sid, sessionEntry);
              log(`MCP session ${sid} initialized`);
            },
            onsessionclosed: (sid) => {
              sessions.delete(sid);
            },
          });
          const server = await createMcpServer();
          sessionEntry = { transport, server };
          await server.connect(transport);
          session = sessionEntry;
        }
      }

      if (!session) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid MCP session" },
          id: null,
        });
        return;
      }

      await session.transport.handleRequest(req, res, req.body);
    } catch (err) {
      log(`MCP error: ${err instanceof Error ? err.message : err}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal error" },
          id: null,
        });
      }
    }
  });

  app.listen(PORT, HOST, () => {
    log(`joshu connectors MCP HTTP on http://${HOST}:${PORT}/mcp (REST base ${JOSHU_BASE})`);
  });
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
