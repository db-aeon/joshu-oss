export type MailRecipient = { email: string; name?: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Parse "Name <email@x.com>" or plain email@x.com into validated recipient. */
function parseAddressString(raw: string, fieldName: string): MailRecipient {
  const trimmed = raw.trim();
  const angle = /^(.+?)\s*<([^>]+)>$/.exec(trimmed);
  if (angle) {
    const email = angle[2]?.trim() ?? "";
    if (!EMAIL_RE.test(email)) {
      throw new Error(`invalid ${fieldName} address: ${trimmed}`);
    }
    const name = (angle[1] ?? "").replace(/^["']+|["']+$/g, "").trim();
    return name ? { email, name } : { email };
  }
  if (!EMAIL_RE.test(trimmed)) {
    throw new Error(`invalid ${fieldName} address: ${trimmed}`);
  }
  return { email: trimmed };
}

/** Split "a@x.com, b@y.com" or single address into validated recipients. */
export function parseMailRecipients(raw: unknown, fieldName: string): MailRecipient[] {
  const items: unknown[] = [];
  if (typeof raw === "string") {
    items.push(...raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean));
  } else if (Array.isArray(raw)) {
    items.push(...raw);
  } else if (raw && typeof raw === "object") {
    items.push(raw);
  }

  const out: MailRecipient[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item === "string") {
      const parsed = parseAddressString(item, fieldName);
      const key = parsed.email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(parsed);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const email = readString(row.email);
    if (!email) continue;
    if (!EMAIL_RE.test(email)) {
      throw new Error(`invalid ${fieldName} address: ${email}`);
    }
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const name = readString(row.name);
    out.push(name ? { email, name } : { email });
  }
  return out;
}

export function parseRequiredTo(raw: unknown): MailRecipient[] {
  const list = parseMailRecipients(raw, "to");
  if (list.length === 0) throw new Error("at least one to recipient is required");
  return list;
}

export function parseOptionalRecipients(raw: unknown, fieldName: string): MailRecipient[] | undefined {
  if (raw == null || raw === "") return undefined;
  const list = parseMailRecipients(raw, fieldName);
  return list.length > 0 ? list : undefined;
}
