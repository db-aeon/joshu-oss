import Nylas from "nylas";
import { isNylasConfigured, nylasApiKey, nylasApiUri } from "./config.js";
import type { NylasAgentRecord } from "./store.js";
import { normalizeRfcMessageId, parseRfcMessageIdFromHeaders, type MailHeader } from "../connectors/rfcMessageId.js";

export function getNylasClient(): Nylas | null {
  const apiKey = nylasApiKey();
  if (!apiKey) return null;
  return new Nylas({ apiKey, apiUri: nylasApiUri() });
}

/** Create a Nylas Agent Account mailbox (no Google OAuth). */
export async function createAgentAccount(email: string): Promise<NylasAgentRecord> {
  const apiKey = nylasApiKey();
  if (!apiKey) throw new Error("NYLAS_API_KEY is not set");

  const res = await fetch(`${nylasApiUri()}/v3/connect/custom`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      provider: "nylas",
      settings: { email },
    }),
  });

  const json = (await res.json()) as { data?: { id?: string; email?: string }; error?: { message?: string } };
  if (!res.ok) {
    throw new Error(json.error?.message || `Nylas create agent failed (${res.status})`);
  }

  const grantId = json.data?.id;
  const resolvedEmail = json.data?.email || email;
  if (!grantId) throw new Error("Nylas did not return a grant id");

  return {
    grantId,
    email: resolvedEmail,
    createdAt: new Date().toISOString(),
  };
}

import type { MailRecipient } from "./recipients.js";

export async function sendMessage(
  grantId: string,
  opts: {
    to: MailRecipient[];
    cc?: MailRecipient[];
    bcc?: MailRecipient[];
    subject: string;
    body: string;
    from: string;
    replyToMessageId?: string;
  },
): Promise<string> {
  const nylas = getNylasClient();
  if (!nylas) throw new Error("Nylas is not configured");
  if (opts.to.length === 0) throw new Error("at least one to recipient is required");

  const mapRecipient = (r: MailRecipient) => ({
    email: r.email,
    ...(r.name ? { name: r.name } : {}),
  });

  const { data } = await nylas.messages.send({
    identifier: grantId,
    requestBody: {
      from: [{ email: opts.from }],
      to: opts.to.map(mapRecipient),
      ...(opts.cc?.length ? { cc: opts.cc.map(mapRecipient) } : {}),
      ...(opts.bcc?.length ? { bcc: opts.bcc.map(mapRecipient) } : {}),
      subject: opts.subject,
      body: opts.body,
      ...(opts.replyToMessageId ? { replyToMessageId: opts.replyToMessageId } : {}),
    },
  });

  return data.id;
}

export async function listMessages(
  grantId: string,
  queryParams: {
    limit?: number;
    unread?: boolean;
    searchQueryNative?: string;
    threadId?: string;
    pageToken?: string;
  } = {},
): Promise<
  Array<{
    id: string;
    subject?: string;
    from?: string;
    fromName?: string;
    to?: string[];
    date?: number;
    snippet?: string;
    unread?: boolean;
    threadId?: string;
  }>
> {
  const nylas = getNylasClient();
  if (!nylas) throw new Error("Nylas is not configured");

  const { data } = await nylas.messages.list({
    identifier: grantId,
    queryParams: {
      limit: queryParams.limit ?? 10,
      ...(queryParams.unread ? { unread: true } : {}),
      ...(queryParams.searchQueryNative ? { searchQueryNative: queryParams.searchQueryNative } : {}),
      ...(queryParams.threadId ? { threadId: queryParams.threadId } : {}),
      ...(queryParams.pageToken ? { pageToken: queryParams.pageToken } : {}),
    },
  });

  if (!Array.isArray(data)) {
    console.warn("[nylas] messages.list returned no data array");
    return [];
  }

  return data.map((msg) => ({
    id: msg.id,
    subject: msg.subject,
    from: msg.from?.[0]?.email,
    fromName: msg.from?.[0]?.name,
    to: msg.to?.map((r) => r.email).filter(Boolean),
    date: msg.date,
    snippet: msg.snippet,
    unread: msg.unread,
    threadId: msg.threadId,
  }));
}

export type NylasThreadSummary = {
  id: string;
  messageIds: string[];
  subject?: string;
  snippet?: string;
  unread?: boolean;
  latestMessageReceivedDate?: number;
};

function mapMessageDetail(data: {
  id: string;
  subject?: string;
  from?: Array<{ email?: string; name?: string }>;
  to?: Array<{ email?: string }>;
  cc?: Array<{ email?: string }>;
  date?: number;
  body?: string;
  snippet?: string;
  unread?: boolean;
  threadId?: string;
  headers?: MailHeader[];
}): NylasMessageDetail {
  const headers = Array.isArray(data.headers) ? data.headers : [];
  const rfcMessageId =
    normalizeRfcMessageId(parseRfcMessageIdFromHeaders(headers)) ?? undefined;
  return {
    id: data.id,
    subject: data.subject,
    from: data.from?.[0]?.email,
    fromName: data.from?.[0]?.name,
    to: data.to?.map((r) => r.email).filter((e): e is string => Boolean(e)),
    cc: data.cc?.map((r) => r.email).filter((e): e is string => Boolean(e)),
    date: data.date,
    body: data.body,
    snippet: data.snippet,
    unread: data.unread,
    threadId: data.threadId,
    rfcMessageId,
  };
}

/** List inbox threads (metadata + full message_ids). Bodies require fetchMessagesInThread. */
export async function listThreads(
  grantId: string,
  queryParams: {
    limit?: number;
    searchQueryNative?: string;
  } = {},
): Promise<NylasThreadSummary[]> {
  const nylas = getNylasClient();
  if (!nylas) throw new Error("Nylas is not configured");

  const { data } = await nylas.threads.list({
    identifier: grantId,
    queryParams: {
      limit: queryParams.limit ?? 20,
      ...(queryParams.searchQueryNative ? { searchQueryNative: queryParams.searchQueryNative } : {}),
    },
  });

  if (!Array.isArray(data)) {
    console.warn("[nylas] threads.list returned no data array");
    return [];
  }

  return data.map((thread) => {
    const row = thread as {
      id: string;
      messageIds?: string[];
      message_ids?: string[];
      subject?: string;
      snippet?: string;
      unread?: boolean;
      latestMessageReceivedDate?: number;
      latest_message_received_date?: number;
    };
    const messageIds = Array.isArray(row.messageIds)
      ? row.messageIds
      : Array.isArray(row.message_ids)
        ? row.message_ids
        : [];
    return {
      id: row.id,
      messageIds,
      subject: row.subject,
      snippet: row.snippet,
      unread: row.unread,
      latestMessageReceivedDate:
        row.latestMessageReceivedDate ?? row.latest_message_received_date,
    };
  });
}

const DEFAULT_THREAD_MESSAGE_CAP = 50;

/** Hydrate all messages in a thread (paginated list, then per-id fallback). */
export async function fetchMessagesInThread(
  grantId: string,
  threadId: string,
  opts: { messageIds?: string[]; maxMessages?: number } = {},
): Promise<NylasMessageDetail[]> {
  const maxMessages = opts.maxMessages ?? DEFAULT_THREAD_MESSAGE_CAP;
  const byId = new Map<string, NylasMessageDetail>();
  let pageToken: string | undefined;

  do {
    const nylas = getNylasClient();
    if (!nylas) throw new Error("Nylas is not configured");

    const response = await nylas.messages.list({
      identifier: grantId,
      queryParams: {
        threadId,
        limit: Math.min(20, maxMessages - byId.size),
        ...(pageToken ? { pageToken } : {}),
      },
    });

    const batch = Array.isArray(response.data) ? response.data : [];
    for (const msg of batch) {
      byId.set(msg.id, mapMessageDetail(msg));
    }

    const next =
      (response as { nextCursor?: string }).nextCursor ??
      (response as { next_cursor?: string }).next_cursor;
    pageToken = typeof next === "string" && next.length > 0 ? next : undefined;
  } while (pageToken && byId.size < maxMessages);

  if (byId.size > 0) {
    const messages = [...byId.values()];
    messages.sort((a, b) => (a.date ?? 0) - (b.date ?? 0));
    return messages.slice(-maxMessages);
  }

  const ids = (opts.messageIds ?? []).slice(-maxMessages);
  for (const id of ids) {
    try {
      byId.set(id, await getMessage(grantId, id));
    } catch {
      /* skip single message failures */
    }
  }

  const messages = [...byId.values()];
  messages.sort((a, b) => (a.date ?? 0) - (b.date ?? 0));
  return messages;
}

export type NylasMessageDetail = {
  id: string;
  subject?: string;
  from?: string;
  fromName?: string;
  to?: string[];
  cc?: string[];
  date?: number;
  body?: string;
  snippet?: string;
  unread?: boolean;
  threadId?: string;
  /** RFC 5322 Message-ID header (normalized), when present. */
  rfcMessageId?: string;
};

export async function getMessage(grantId: string, messageId: string): Promise<NylasMessageDetail> {
  const nylas = getNylasClient();
  if (!nylas) throw new Error("Nylas is not configured");

  const { data } = await nylas.messages.find({
    identifier: grantId,
    messageId,
  });

  return mapMessageDetail({
    id: data.id,
    subject: data.subject,
    from: data.from,
    to: data.to,
    cc: data.cc,
    date: data.date,
    body: data.body,
    snippet: data.snippet,
    unread: data.unread,
    threadId: data.threadId,
    headers: (data as { headers?: MailHeader[] }).headers,
  });
}

export type NylasEventSummary = {
  id: string;
  calendarId?: string;
  title?: string;
  description?: string;
  location?: string;
  when?: unknown;
  startTime?: number;
  endTime?: number;
  busy?: boolean;
  status?: string;
};

function eventTimes(when: unknown): { startTime?: number; endTime?: number } {
  if (!when || typeof when !== "object") return {};
  const w = when as Record<string, unknown>;
  if (typeof w.startTime === "number" && typeof w.endTime === "number") {
    return { startTime: w.startTime, endTime: w.endTime };
  }
  if (typeof w.time === "number") {
    return { startTime: w.time, endTime: w.time };
  }
  return {};
}

function mapEvent(event: {
  id: string;
  calendarId?: string;
  title?: string;
  description?: string;
  location?: string;
  when?: unknown;
  busy?: boolean;
  status?: string;
}): NylasEventSummary {
  const times = eventTimes(event.when);
  return {
    id: event.id,
    calendarId: event.calendarId,
    title: event.title,
    description: event.description,
    location: event.location,
    when: event.when,
    ...times,
    busy: event.busy,
    status: event.status,
  };
}

export async function listEvents(
  grantId: string,
  queryParams: {
    calendarId?: string;
    start?: number;
    end?: number;
    limit?: number;
  } = {},
): Promise<NylasEventSummary[]> {
  const nylas = getNylasClient();
  if (!nylas) throw new Error("Nylas is not configured");

  const calendarId = queryParams.calendarId || "primary";
  try {
    const { data } = await nylas.events.list({
      identifier: grantId,
      queryParams: {
        calendarId,
        limit: queryParams.limit ?? 50,
        ...(queryParams.start != null ? { start: String(queryParams.start) } : {}),
        ...(queryParams.end != null ? { end: String(queryParams.end) } : {}),
      },
    });
    if (!Array.isArray(data)) {
      console.warn("[nylas] events.list returned no data array");
      return [];
    }
    return data.map(mapEvent);
  } catch (err) {
    console.warn(`[nylas] events.list failed: ${(err as Error).message}`);
    return [];
  }
}

export async function getEvent(
  grantId: string,
  eventId: string,
  calendarId = "primary",
): Promise<NylasEventSummary> {
  const nylas = getNylasClient();
  if (!nylas) throw new Error("Nylas is not configured");

  const { data } = await nylas.events.find({
    identifier: grantId,
    eventId,
    queryParams: { calendarId },
  });

  return mapEvent(data);
}

export async function createEvent(
  grantId: string,
  opts: {
    calendarId?: string;
    title: string;
    startTime: number;
    endTime: number;
    timezone?: string;
    description?: string;
    location?: string;
    participants?: Array<{ email: string; name?: string }>;
    notifyParticipants?: boolean;
  },
): Promise<NylasEventSummary> {
  const nylas = getNylasClient();
  if (!nylas) throw new Error("Nylas is not configured");

  const calendarId = opts.calendarId || "primary";
  const tz = opts.timezone || "UTC";

  const { data } = await nylas.events.create({
    identifier: grantId,
    queryParams: {
      calendarId,
      notifyParticipants: opts.notifyParticipants ?? true,
    },
    requestBody: {
      title: opts.title,
      when: {
        startTime: opts.startTime,
        endTime: opts.endTime,
        startTimezone: tz,
        endTimezone: tz,
      },
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.location ? { location: opts.location } : {}),
      ...(opts.participants?.length
        ? {
            participants: opts.participants.map((p) => ({
              email: p.email,
              ...(p.name ? { name: p.name } : {}),
              status: "noreply" as const,
            })),
          }
        : {}),
    },
  });

  return mapEvent(data);
}

export async function updateEvent(
  grantId: string,
  eventId: string,
  opts: {
    calendarId?: string;
    title?: string;
    startTime?: number;
    endTime?: number;
    timezone?: string;
    description?: string;
    location?: string;
    participants?: Array<{ email: string; name?: string }>;
    notifyParticipants?: boolean;
  },
): Promise<NylasEventSummary> {
  const nylas = getNylasClient();
  if (!nylas) throw new Error("Nylas is not configured");

  const calendarId = opts.calendarId || "primary";
  const requestBody: Record<string, unknown> = {};
  if (opts.title) requestBody.title = opts.title;
  if (opts.description) requestBody.description = opts.description;
  if (opts.location) requestBody.location = opts.location;
  if (opts.startTime != null && opts.endTime != null) {
    const tz = opts.timezone || "UTC";
    requestBody.when = {
      startTime: opts.startTime,
      endTime: opts.endTime,
      startTimezone: tz,
      endTimezone: tz,
    };
  }
  if (opts.participants?.length) {
    requestBody.participants = opts.participants.map((p) => ({
      email: p.email,
      ...(p.name ? { name: p.name } : {}),
      status: "noreply",
    }));
  }

  const { data } = await nylas.events.update({
    identifier: grantId,
    eventId,
    queryParams: {
      calendarId,
      notifyParticipants: opts.notifyParticipants ?? true,
    },
    requestBody,
  });

  return mapEvent(data);
}

export async function destroyEvent(
  grantId: string,
  eventId: string,
  calendarId = "primary",
): Promise<void> {
  const nylas = getNylasClient();
  if (!nylas) throw new Error("Nylas is not configured");

  await nylas.events.destroy({
    identifier: grantId,
    eventId,
    queryParams: { calendarId },
  });
}

export async function updateMessage(
  grantId: string,
  messageId: string,
  patch: { unread?: boolean; starred?: boolean },
): Promise<NylasMessageDetail> {
  const nylas = getNylasClient();
  if (!nylas) throw new Error("Nylas is not configured");

  const { data } = await nylas.messages.update({
    identifier: grantId,
    messageId,
    requestBody: patch,
  });

  return {
    id: data.id,
    subject: data.subject,
    from: data.from?.[0]?.email,
    fromName: data.from?.[0]?.name,
    to: data.to?.map((r) => r.email).filter(Boolean),
    cc: data.cc?.map((r) => r.email).filter(Boolean),
    date: data.date,
    body: data.body,
    snippet: data.snippet,
    unread: data.unread,
    threadId: data.threadId,
  };
}
