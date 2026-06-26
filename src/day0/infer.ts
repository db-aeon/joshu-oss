import {
  ALL_ONLINE_TOOLS,
  BIG_PICTURE_PRIORITIES,
  COMMUNICATION_CHANNEL_DEFS,
} from "../onboarding/options.js";
import type { Day0ExtractResult, Day0InferResult, Day0ThreadRow } from "./types.js";
import { collectEmailDomains } from "./extract.js";
import { day0ChatCompletion, parseLlmJson, resolveDay0Model } from "./llm.js";

const PRIORITY_SET = new Set<string>(BIG_PICTURE_PRIORITIES);
const TOOL_SET = new Set<string>(ALL_ONLINE_TOOLS);
const CHANNEL_IDS = new Set(COMMUNICATION_CHANNEL_DEFS.map((d) => d.id));

/** Shared guidance — bulk mail should not drive onboarding inference. */
const IGNORE_NOISE_GUIDANCE = `When summarizing or inferring onboarding fields, IGNORE low-signal mail:
- Newsletters, marketing blasts, retail promos, digests, "view in browser" campaigns
- Automated app/social notifications (LinkedIn, GitHub, Facebook, etc.) unless they prove a core work tool
- Bulk senders (noreply@, newsletters@, marketing@, mailer-daemon) the user never replied to
- Subscription content with no human back-and-forth

FOCUS ON: 1:1 and small-group human threads, clients/partners/vendors, meeting invites, scheduling,
travel, hiring, finance/ops with real people, and senders with genuine two-way conversation.
Do NOT list newsletters or bulk senders as VIPs. Do NOT infer priorities from promo volume.`;

function threadsForInference(extract: Day0ExtractResult): Day0ThreadRow[] {
  const signal = extract.signalThreads ?? extract.threads;
  return signal.length > 0 ? signal : extract.threads;
}

function chunkThreadsByWeek(threads: Day0ThreadRow[]): Day0ThreadRow[][] {
  if (threads.length === 0) return [];
  const byWeek = new Map<string, Day0ThreadRow[]>();
  for (const t of threads) {
    const d = t.dateEpoch ? new Date(t.dateEpoch * 1000) : new Date();
    const weekStart = new Date(d);
    weekStart.setUTCDate(d.getUTCDate() - d.getUTCDay());
    const key = weekStart.toISOString().slice(0, 10);
    const bucket = byWeek.get(key) ?? [];
    bucket.push(t);
    byWeek.set(key, bucket);
  }
  const chunks = [...byWeek.values()];
  // Merge tiny trailing chunks
  const merged: Day0ThreadRow[][] = [];
  let buf: Day0ThreadRow[] = [];
  for (const c of chunks) {
    buf.push(...c);
    if (buf.length >= 25) {
      merged.push(buf);
      buf = [];
    }
  }
  if (buf.length) merged.push(buf);
  return merged.length ? merged : [threads];
}

function formatThreadForPrompt(t: Day0ThreadRow): string {
  return [
    `- [${t.date?.slice(0, 10) ?? "?"}] ${t.subject ?? "(no subject)"}`,
    t.accountEmail ? `  Mailbox: ${t.accountEmail}` : null,
    `  From: ${t.from ?? "?"}`,
    t.to?.length ? `  To: ${t.to.join(", ")}` : null,
    `  Snippet: ${t.bodySnippet.slice(0, 280)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatExtractContext(extract: Day0ExtractResult): string {
  const mailboxLines =
    extract.accountEmails && extract.accountEmails.length > 0
      ? extract.accountEmails
          .map((email) => {
            const count = extract.accountThreadCounts?.[email];
            return count != null ? `${email} (${count} threads)` : email;
          })
          .join(", ")
      : (extract.accountEmail ?? "unknown");

  const topPeople = extract.topCorrespondents
    .slice(0, 15)
    .map((c) => `${c.displayName ?? c.address} <${c.address}> (${c.count} threads)`)
    .join("\n");
  const domains = collectEmailDomains(extract.threads).join(", ");
  const events = extract.events
    .slice(0, 30)
    .map((e) => `- ${e.start?.slice(0, 16) ?? "?"} ${e.title ?? "(event)"}`)
    .join("\n");
  const urls = extract.urls.slice(0, 25).join("\n");

  return [
    `Connected mailboxes: ${mailboxLines}`,
    extract.emailRoles?.primaryWorkEmail
      ? `Likely work email: ${extract.emailRoles.primaryWorkEmail}`
      : null,
    extract.emailRoles?.personalEmail
      ? `Likely personal email: ${extract.emailRoles.personalEmail}`
      : null,
    `Total threads synced: ${extract.threads.length}`,
    extract.noiseThreadCount != null && extract.noiseThreadCount > 0
      ? `Filtered as junk/newsletter/bulk (excluded from LLM): ${extract.noiseThreadCount}`
      : null,
    `Signal threads for analysis: ${threadsForInference(extract).length}`,
    `Top correspondents:\n${topPeople || "(none)"}`,
    `Email domains: ${domains || "(none)"}`,
    extract.workingHoursHint
      ? `Send-time working hours hint: ${extract.workingHoursHint.start}-${extract.workingHoursHint.end} UTC`
      : null,
    `Calendar events (${extract.events.length}):\n${events || "(none)"}`,
    `Sample URLs:\n${urls || "(none)"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const INFER_SCHEMA = `{
  "bigPicturePriorities": string[] (only from allowed list),
  "bigPictureNotes": string,
  "communicationChannels": string[] (channel ids: work-email, personal-email, phone, sms, whatsapp, telegram, slack, google-chat),
  "communicationContacts": { "work-email"?: string, "personal-email"?: string, ... },
  "communicationNotes": string,
  "onlineTools": string[] (only from allowed tools list when evidence exists),
  "onlineToolsNotes": string,
  "primaryWorkEmail": string,
  "personalEmail": string,
  "timezone": string (IANA e.g. America/New_York),
  "workingHoursStart": "HH:MM",
  "workingHoursEnd": "HH:MM",
  "vips": [{ "who": string, "priority"?: string, "gatekeepNotes"?: string }],
  "confidence": { "fieldName": "high"|"medium"|"low" },
  "warnings": string[]
}`;

function sanitizeInferResult(raw: Day0InferResult): Day0InferResult {
  const out: Day0InferResult = {};

  if (Array.isArray(raw.bigPicturePriorities)) {
    out.bigPicturePriorities = raw.bigPicturePriorities.filter((p) => PRIORITY_SET.has(p));
  }
  if (typeof raw.bigPictureNotes === "string" && raw.bigPictureNotes.trim()) {
    out.bigPictureNotes = raw.bigPictureNotes.trim();
  }
  if (Array.isArray(raw.communicationChannels)) {
    out.communicationChannels = raw.communicationChannels.filter((c) => CHANNEL_IDS.has(c));
  }
  if (raw.communicationContacts && typeof raw.communicationContacts === "object") {
    const contacts: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.communicationContacts)) {
      if (CHANNEL_IDS.has(k) && typeof v === "string" && v.trim()) contacts[k] = v.trim();
    }
    if (Object.keys(contacts).length) out.communicationContacts = contacts;
  }
  if (typeof raw.communicationNotes === "string" && raw.communicationNotes.trim()) {
    out.communicationNotes = raw.communicationNotes.trim();
  }
  if (Array.isArray(raw.onlineTools)) {
    out.onlineTools = raw.onlineTools.filter((t) => TOOL_SET.has(t));
  }
  if (typeof raw.onlineToolsNotes === "string" && raw.onlineToolsNotes.trim()) {
    out.onlineToolsNotes = raw.onlineToolsNotes.trim();
  }
  for (const key of [
    "primaryWorkEmail",
    "personalEmail",
    "timezone",
    "workingHoursStart",
    "workingHoursEnd",
  ] as const) {
    const v = raw[key];
    if (typeof v === "string" && v.trim()) out[key] = v.trim();
  }
  if (Array.isArray(raw.vips)) {
    out.vips = raw.vips
      .filter((v) => v && typeof v.who === "string" && v.who.trim())
      .map((v) => ({
        who: v.who.trim(),
        priority: typeof v.priority === "string" ? v.priority.trim() : undefined,
        gatekeepNotes:
          typeof v.gatekeepNotes === "string" ? v.gatekeepNotes.trim() : undefined,
      }))
      .slice(0, 12);
  }
  if (raw.confidence && typeof raw.confidence === "object") {
    out.confidence = raw.confidence;
  }
  if (Array.isArray(raw.warnings)) {
    out.warnings = raw.warnings.filter((w) => typeof w === "string" && w.trim()).slice(0, 10);
  }
  return out;
}

async function summarizeChunk(
  extract: Day0ExtractResult,
  threads: Day0ThreadRow[],
  chunkIndex: number,
  totalChunks: number,
): Promise<Record<string, unknown>> {
  if (threads.length === 0) {
    return { topics: [], people: [], urgencySignals: [], toolMentions: [], notes: "" };
  }

  const threadBlock = threads.map(formatThreadForPrompt).join("\n");
  const system = `You summarize email threads for executive-assistant onboarding. Output JSON only.
Fields: topics (string[]), people (string[]), urgencySignals (string[]), toolMentions (string[]), notes (string).

${IGNORE_NOISE_GUIDANCE}

If every thread in this chunk is junk/newsletter, return empty arrays and notes: "".`;
  const user = `Chunk ${chunkIndex + 1}/${totalChunks}. Mailboxes: ${(extract.accountEmails ?? [extract.accountEmail]).filter(Boolean).join(", ") || "?"}\n\nThreads (pre-filtered; still skip any remaining bulk):\n${threadBlock}`;
  const raw = await day0ChatCompletion(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    {
      json: true,
      maxTokens: 4096,
      traceName: "joshu-day0-infer",
      generationName: "summarize-chunk",
      tags: ["day0", "infer", "chunk"],
      metadata: { chunkIndex, totalChunks },
    },
  );
  return parseLlmJson<Record<string, unknown>>(raw);
}

function compactChunkSummaries(summaries: Record<string, unknown>[]): unknown[] {
  return summaries.map((s) => ({
    topics: Array.isArray(s.topics) ? s.topics.slice(0, 12) : s.topics,
    people: Array.isArray(s.people) ? s.people.slice(0, 15) : s.people,
    urgencySignals: Array.isArray(s.urgencySignals) ? s.urgencySignals.slice(0, 8) : s.urgencySignals,
    toolMentions: Array.isArray(s.toolMentions) ? s.toolMentions.slice(0, 10) : s.toolMentions,
    notes: typeof s.notes === "string" ? s.notes.slice(0, 400) : s.notes,
  }));
}

export async function inferDay0Draft(extract: Day0ExtractResult): Promise<Day0InferResult> {
  const allowedPriorities = BIG_PICTURE_PRIORITIES.join(" | ");
  const allowedTools = ALL_ONLINE_TOOLS.join(" | ");

  const signalThreads = threadsForInference(extract);
  const chunks = chunkThreadsByWeek(signalThreads);
  const chunkSummaries: Record<string, unknown>[] = [];
  for (let i = 0; i < chunks.length; i++) {
    chunkSummaries.push(await summarizeChunk(extract, chunks[i]!, i, chunks.length));
  }

  const system = `You infer Welcome onboarding fields from email/calendar signals for an executive assistant setup.
Rules:
- Use ONLY allowed priority labels and online tools when evidence exists.
- Keep people names and email addresses literal from the data.
- When multiple mailboxes are connected, treat corporate/custom domains as work and consumer domains (gmail.com, icloud.com, etc.) as personal unless evidence says otherwise.
- Do NOT invent spending thresholds, decision authority, or passwords.

${IGNORE_NOISE_GUIDANCE}

Output valid JSON matching this schema:\n${INFER_SCHEMA}`;

  const user = [
    formatExtractContext(extract),
    "",
    "Weekly chunk summaries:",
    JSON.stringify(compactChunkSummaries(chunkSummaries)),
    "",
    `Allowed bigPicturePriorities: ${allowedPriorities}`,
    `Allowed onlineTools: ${allowedTools}`,
    "",
    "Produce final onboarding inference JSON.",
  ].join("\n");

  const raw = await day0ChatCompletion(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    {
      json: true,
      maxTokens: 16384,
      traceName: "joshu-day0-infer",
      generationName: "infer-onboarding-draft",
      tags: ["day0", "infer", "draft"],
    },
  );

  const parsed = sanitizeInferResult(parseLlmJson<Day0InferResult>(raw));

  const roles = extract.emailRoles;
  if (roles?.primaryWorkEmail && !parsed.primaryWorkEmail) {
    parsed.primaryWorkEmail = roles.primaryWorkEmail;
  }
  if (roles?.personalEmail && !parsed.personalEmail) {
    parsed.personalEmail = roles.personalEmail;
  }

  if (parsed.primaryWorkEmail && !parsed.communicationContacts?.["work-email"]) {
    parsed.communicationChannels = [...(parsed.communicationChannels ?? []), "work-email"].filter(
      (v, i, a) => a.indexOf(v) === i,
    );
    parsed.communicationContacts = {
      ...(parsed.communicationContacts ?? {}),
      "work-email": parsed.primaryWorkEmail,
    };
  }
  if (parsed.personalEmail && !parsed.communicationContacts?.["personal-email"]) {
    parsed.communicationChannels = [...(parsed.communicationChannels ?? []), "personal-email"].filter(
      (v, i, a) => a.indexOf(v) === i,
    );
    parsed.communicationContacts = {
      ...(parsed.communicationContacts ?? {}),
      "personal-email": parsed.personalEmail,
    };
  }

  // Legacy single-mailbox fallback
  if (
    extract.accountEmail &&
    !parsed.primaryWorkEmail &&
    !parsed.personalEmail &&
    !parsed.communicationContacts?.["work-email"]
  ) {
    parsed.primaryWorkEmail = extract.accountEmail;
    parsed.communicationChannels = [...(parsed.communicationChannels ?? []), "work-email"].filter(
      (v, i, a) => a.indexOf(v) === i,
    );
    parsed.communicationContacts = {
      ...(parsed.communicationContacts ?? {}),
      "work-email": extract.accountEmail,
    };
  }
  if (extract.workingHoursHint?.start && !parsed.workingHoursStart) {
    parsed.workingHoursStart = extract.workingHoursHint.start;
  }
  if (extract.workingHoursHint?.end && !parsed.workingHoursEnd) {
    parsed.workingHoursEnd = extract.workingHoursHint.end;
  }

  // Seed VIPs from top correspondents if LLM returned none (already noise-filtered in extract)
  if (!parsed.vips?.length && extract.topCorrespondents.length) {
    parsed.vips = extract.topCorrespondents.slice(0, 8).map((c) => ({
      who: c.displayName ? `${c.displayName} <${c.address}>` : c.address,
      gatekeepNotes: `Frequent correspondent (${c.count} threads in last 30 days)`,
    }));
  }

  parsed.warnings = [
    ...(parsed.warnings ?? []),
    extract.noiseThreadCount
      ? `Excluded ${extract.noiseThreadCount} junk/newsletter threads from analysis`
      : "",
    `Model: ${resolveDay0Model()}`,
  ].filter(Boolean);

  return parsed;
}

/** Incremental sweep: digest only, no full draft rewrite. */
export async function inferDay0SweepDigest(
  extract: Day0ExtractResult,
  sinceLabel: string,
): Promise<string> {
  const signal = threadsForInference(extract);
  const threadBlock = signal.slice(0, 60).map(formatThreadForPrompt).join("\n");
  const system = `You produce a concise triage digest for an executive assistant. Markdown output, not JSON.
Sections: New/changed threads, People, Urgent signals, Suggested VIP updates, Optional running-log bullet.

${IGNORE_NOISE_GUIDANCE}`;
  const user = `Since ${sinceLabel}. ${signal.length} signal threads (${extract.threads.length} total synced).\n\n${threadBlock}`;
  return day0ChatCompletion(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    {
      maxTokens: 2048,
      traceName: "joshu-day0-sweep",
      generationName: "sweep-digest",
      tags: ["day0", "sweep"],
      metadata: { sinceLabel },
    },
  );
}
