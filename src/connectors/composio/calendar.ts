/**
 * Composio Google Calendar toolkit — list calendars + sync events across all connected accounts.
 */
import { getOrCreateComposioSession, resolveComposioUserId } from "../../composioApi.js";
import { composioToolsExecute } from "../../composio/executeWithModifiers.js";

export type CalendarExecuteContext = {
  connectedAccountId: string;
};

export type GoogleCalendarEntry = {
  id: string;
  summary?: string;
  accessRole?: string;
  primary?: boolean;
  selected?: boolean;
};

export type GoogleCalendarEventSummary = {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: string;
  end?: string;
  calendarId?: string;
  calendarSummary?: string;
  /** ACL role on this calendar for the connected Google account. */
  accessRole?: string;
  /** Google event status — cancelled events do not block availability. */
  status?: string;
  /** Google transparency: opaque (busy, default) or transparent (free / show-as-available). */
  transparency?: "opaque" | "transparent";
  /** Whether this event occupies FreeBusy time — derived from status + transparency. */
  blocksAvailability?: boolean;
};

export type GoogleCalendarFreeBusyInterval = {
  start: string;
  end: string;
};

export type GoogleCalendarFreeSlotsResult = {
  timeMin: string;
  timeMax: string;
  timezone: string;
  items: string[];
  calendars: Record<
    string,
    {
      busy: GoogleCalendarFreeBusyInterval[];
      free: GoogleCalendarFreeBusyInterval[];
      errors?: unknown[];
    }
  >;
};

function toolkitVersion(): string | undefined {
  return process.env.JOSHU_COMPOSIO_GOOGLECALENDAR_VERSION?.trim() || undefined;
}

async function executeCalendar(
  projectRoot: string,
  toolSlug: string,
  args: Record<string, unknown>,
  ctx: CalendarExecuteContext,
): Promise<{ successful: boolean; data?: unknown; error?: string }> {
  const userId = resolveComposioUserId(projectRoot);
  const version = toolkitVersion();

  try {
    const result = await composioToolsExecute(
      toolSlug,
      {
        userId,
        connectedAccountId: ctx.connectedAccountId,
        arguments: args,
        ...(version ? { version } : { dangerouslySkipVersionCheck: true }),
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

function unwrapData(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") return {};
  const root = data as Record<string, unknown>;
  if (root.data && typeof root.data === "object" && !Array.isArray(root.data)) {
    return root.data as Record<string, unknown>;
  }
  return root;
}

function readTransparency(
  row: Record<string, unknown>,
): "opaque" | "transparent" | undefined {
  const value = row.transparency;
  if (value === "transparent" || value === "opaque") return value;
  return undefined;
}

function readEventStatus(row: Record<string, unknown>): string | undefined {
  return typeof row.status === "string" ? row.status : undefined;
}

/** Whether a Google event occupies FreeBusy time (opaque + not cancelled). */
export function eventBlocksAvailability(ev: {
  status?: string;
  transparency?: "opaque" | "transparent";
}): boolean {
  if (ev.status === "cancelled") return false;
  if (ev.transparency === "transparent") return false;
  return true;
}

export function enrichGoogleCalendarEvents(
  events: GoogleCalendarEventSummary[],
): GoogleCalendarEventSummary[] {
  return events.map((ev) => ({
    ...ev,
    blocksAvailability: eventBlocksAvailability(ev),
  }));
}

function readEventTimes(row: Record<string, unknown>): { start?: string; end?: string } {
  const start = row.start as Record<string, unknown> | string | undefined;
  const end = row.end as Record<string, unknown> | string | undefined;
  return {
    start:
      typeof start === "string"
        ? start
        : typeof start?.dateTime === "string"
          ? start.dateTime
          : typeof start?.date === "string"
            ? start.date
            : undefined,
    end:
      typeof end === "string"
        ? end
        : typeof end?.dateTime === "string"
          ? end.dateTime
          : typeof end?.date === "string"
            ? end.date
            : undefined,
  };
}

function accessRoleByCalendarId(
  calendars: GoogleCalendarEntry[],
): Map<string, { accessRole?: string; summary?: string }> {
  const map = new Map<string, { accessRole?: string; summary?: string }>();
  for (const cal of calendars) {
    map.set(cal.id, { accessRole: cal.accessRole, summary: cal.summary });
  }
  return map;
}

function extractAllCalendarEvents(
  data: unknown,
  calendars: GoogleCalendarEntry[],
): GoogleCalendarEventSummary[] {
  const inner = unwrapData(data);
  const roles = accessRoleByCalendarId(calendars);
  const out: GoogleCalendarEventSummary[] = [];

  const summaryView = inner.summary_view;
  if (Array.isArray(summaryView) && summaryView.length > 0) {
    for (const row of summaryView) {
      if (!row || typeof row !== "object") continue;
      const ev = row as Record<string, unknown>;
      const id = typeof ev.event_id === "string" ? ev.event_id : typeof ev.id === "string" ? ev.id : "";
      if (!id) continue;
      const calendarSummary = typeof ev.calendar === "string" ? ev.calendar : undefined;
      const calendarId =
        calendars.find((c) => c.summary === calendarSummary || c.id === calendarSummary)?.id ??
        calendarSummary;
      const meta = calendarId ? roles.get(calendarId) : undefined;
      const transparency = readTransparency(ev);
      const status = readEventStatus(ev);
      out.push({
        id,
        summary: typeof ev.title === "string" ? ev.title : typeof ev.summary === "string" ? ev.summary : undefined,
        start: typeof ev.start === "string" ? ev.start : undefined,
        end: typeof ev.end === "string" ? ev.end : undefined,
        calendarId,
        calendarSummary: calendarSummary ?? meta?.summary,
        accessRole: meta?.accessRole,
        status,
        transparency,
        blocksAvailability: eventBlocksAvailability({ status, transparency }),
      });
    }
    return out;
  }

  const items = inner.events ?? inner.items;
  if (!Array.isArray(items)) return out;

  for (const ev of items) {
    if (!ev || typeof ev !== "object") continue;
    const row = ev as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : "";
    if (!id) continue;
    const calendarId =
      typeof row.calendarId === "string"
        ? row.calendarId
        : typeof row.calendar_id === "string"
          ? row.calendar_id
          : typeof row.organizer === "object" && row.organizer && typeof (row.organizer as Record<string, unknown>).email === "string"
            ? ((row.organizer as Record<string, unknown>).email as string)
            : undefined;
    const meta = calendarId ? roles.get(calendarId) : undefined;
    const times = readEventTimes(row);
    const transparency = readTransparency(row);
    const status = readEventStatus(row);
    out.push({
      id,
      summary: typeof row.summary === "string" ? row.summary : typeof row.title === "string" ? row.title : undefined,
      description: typeof row.description === "string" ? row.description : undefined,
      location: typeof row.location === "string" ? row.location : undefined,
      start: times.start,
      end: times.end,
      calendarId,
      calendarSummary: meta?.summary ?? calendarId,
      accessRole: meta?.accessRole,
      status,
      transparency,
      blocksAvailability: eventBlocksAvailability({ status, transparency }),
    });
  }
  return out;
}

/** Calendars visible to a connected Google account (includes shared/subscribed calendars). */
export async function fetchGoogleCalendarList(
  projectRoot: string,
  ctx: CalendarExecuteContext,
): Promise<GoogleCalendarEntry[]> {
  const result = await executeCalendar(projectRoot, "GOOGLECALENDAR_LIST_CALENDARS", { show_hidden: true }, ctx);
  if (!result.successful) {
    throw new Error(result.error || "GOOGLECALENDAR_LIST_CALENDARS failed");
  }
  const inner = unwrapData(result.data);
  const items = inner.calendars ?? inner.items;
  if (!Array.isArray(items)) return [];
  const out: GoogleCalendarEntry[] = [];
  for (const row of items) {
    if (!row || typeof row !== "object") continue;
    const cal = row as Record<string, unknown>;
    const id = typeof cal.id === "string" ? cal.id : "";
    if (!id) continue;
    out.push({
      id,
      summary: typeof cal.summary === "string" ? cal.summary : undefined,
      accessRole: typeof cal.accessRole === "string" ? cal.accessRole : undefined,
      primary: cal.primary === true,
      selected: cal.selected === true,
    });
  }
  return out;
}

/** Events across all calendars for one connected Google Calendar OAuth account. */
export async function fetchGoogleCalendarEventsForAccount(
  projectRoot: string,
  ctx: CalendarExecuteContext,
  opts: {
    maxResults?: number;
    daysBack?: number;
    daysForward?: number;
    /** ISO8601 — overrides daysBack when set with timeMax. */
    timeMin?: string;
    /** ISO8601 — overrides daysForward when set with timeMin. */
    timeMax?: string;
  } = {},
): Promise<GoogleCalendarEventSummary[]> {
  const calendars = await fetchGoogleCalendarList(projectRoot, ctx);
  const now = new Date();
  const daysBack = opts.daysBack ?? 7;
  const daysForward = opts.daysForward ?? 14;
  const timeMin =
    opts.timeMin?.trim() ||
    new Date(now.getTime() - daysBack * 24 * 3600 * 1000).toISOString();
  const timeMax =
    opts.timeMax?.trim() ||
    new Date(now.getTime() + daysForward * 24 * 3600 * 1000).toISOString();

  const result = await executeCalendar(
    projectRoot,
    "GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS",
    {
      time_min: timeMin,
      time_max: timeMax,
      max_results: opts.maxResults ?? 120,
      response_detail: "full",
    },
    ctx,
  );

  if (!result.successful) {
    throw new Error(result.error || "GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS failed");
  }
  return extractAllCalendarEvents(result.data, calendars);
}

function readFreeBusyIntervals(value: unknown): GoogleCalendarFreeBusyInterval[] {
  if (!Array.isArray(value)) return [];
  const out: GoogleCalendarFreeBusyInterval[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const interval = row as Record<string, unknown>;
    const start = typeof interval.start === "string" ? interval.start : undefined;
    const end = typeof interval.end === "string" ? interval.end : undefined;
    if (start && end) out.push({ start, end });
  }
  return out;
}

function parseFreeSlotsPayload(data: unknown): Omit<GoogleCalendarFreeSlotsResult, "items" | "timezone"> {
  const inner = unwrapData(data);
  const responseData =
    inner.response_data && typeof inner.response_data === "object"
      ? (inner.response_data as Record<string, unknown>)
      : inner;

  const timeMin =
    typeof responseData.timeMin === "string"
      ? responseData.timeMin
      : typeof responseData.time_min === "string"
        ? responseData.time_min
        : "";
  const timeMax =
    typeof responseData.timeMax === "string"
      ? responseData.timeMax
      : typeof responseData.time_max === "string"
        ? responseData.time_max
        : "";

  const calendars: GoogleCalendarFreeSlotsResult["calendars"] = {};
  const calendarsNode = responseData.calendars;
  if (calendarsNode && typeof calendarsNode === "object" && !Array.isArray(calendarsNode)) {
    for (const [calendarId, raw] of Object.entries(calendarsNode as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const cal = raw as Record<string, unknown>;
      calendars[calendarId] = {
        busy: readFreeBusyIntervals(cal.busy),
        free: readFreeBusyIntervals(cal.free),
        ...(cal.errors ? { errors: cal.errors as unknown[] } : {}),
      };
    }
  }

  // Some Composio versions flatten busy/free at the top level for a single calendar.
  if (Object.keys(calendars).length === 0) {
    const busy = readFreeBusyIntervals(responseData.busy);
    const free = readFreeBusyIntervals(responseData.free);
    if (busy.length > 0 || free.length > 0) {
      calendars.primary = { busy, free };
    }
  }

  return { timeMin, timeMax, calendars };
}

/** Live Google FreeBusy — respects transparent ("free") events; use for scheduling availability. */
export async function fetchGoogleCalendarFreeSlots(
  projectRoot: string,
  ctx: CalendarExecuteContext,
  opts: {
    items?: string[];
    timeMin: string;
    timeMax: string;
    timezone: string;
  },
): Promise<GoogleCalendarFreeSlotsResult> {
  const { resolveOwnerCalendarFreeBusyItems } = await import("./calendarAvailability.js");
  const items = await resolveOwnerCalendarFreeBusyItems(projectRoot, ctx, opts.items);
  const result = await executeCalendar(
    projectRoot,
    "GOOGLECALENDAR_FIND_FREE_SLOTS",
    {
      items,
      time_min: opts.timeMin,
      time_max: opts.timeMax,
      timezone: opts.timezone,
    },
    ctx,
  );

  if (!result.successful) {
    throw new Error(result.error || "GOOGLECALENDAR_FIND_FREE_SLOTS failed");
  }

  const parsed = parseFreeSlotsPayload(result.data);
  return {
    ...parsed,
    timezone: opts.timezone,
    items,
  };
}
