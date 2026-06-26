import { randomUUID } from "node:crypto";
import { readAgentGrant } from "../nylas/store.js";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEmails(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(/[,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      if (typeof item === "string") out.push(item.trim());
      else if (item && typeof item === "object" && "email" in item) {
        const email = readString((item as { email?: unknown }).email);
        if (email) out.push(email);
      }
    }
    return out.filter(Boolean);
  }
  return [];
}

/** Silent-success shape for Nylas send (matches REST route). */
export function stubNylasSendResponse(
  args: Record<string, unknown>,
  projectRoot = process.cwd(),
): Record<string, unknown> {
  const agent = readAgentGrant(projectRoot);
  const to = normalizeEmails(args.to);
  const cc = normalizeEmails(args.cc);
  return {
    ok: true,
    messageId: `blocked-${randomUUID()}`,
    from: agent?.email ?? "agent@joshu.local",
    to,
    ...(cc.length ? { cc } : {}),
  };
}

/** Plausible Composio tool success for silent deny. */
export function stubComposioToolResponse(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const name = toolName.trim().toUpperCase();
  if (name.includes("SEND") || name.includes("REPLY")) {
    return {
      successful: true,
      data: {
        id: `blocked-${randomUUID()}`,
        messageId: `blocked-${randomUUID()}`,
        recipient_email: readString(args.recipient_email) || normalizeEmails(args.to)[0] || "",
      },
    };
  }
  if (name.includes("CALENDAR") || name.includes("EVENT")) {
    return {
      successful: true,
      data: {
        id: `blocked-${randomUUID()}`,
        event_id: `blocked-${randomUUID()}`,
        htmlLink: "",
      },
    };
  }
  if (name.includes("SLACK")) {
    return {
      successful: true,
      data: {
        ok: true,
        ts: `${Date.now()}.000000`,
        channel: readString(args.channel) || readString(args.channel_id),
      },
    };
  }
  return { successful: true, data: { id: `blocked-${randomUUID()}` } };
}

/** Plausible browser tool success for silent deny (Hermes expects JSON string). */
export function stubBrowserActionResponse(
  kind: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const action = kind.trim().toLowerCase();
  if (action === "click") {
    return {
      success: true,
      clicked: readString(args.ref).replace(/^@+/, ""),
      url: readString(args.url) || "",
    };
  }
  if (action === "type") {
    return {
      success: true,
      typed: readString(args.text),
      element: readString(args.ref).replace(/^@+/, ""),
    };
  }
  if (action === "press") {
    return { success: true, pressed: readString(args.key) };
  }
  if (action === "evaluate" || action === "submit") {
    return { success: true, result: null };
  }
  return { success: true };
}
