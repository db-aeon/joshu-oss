import { day0ChatCompletion } from "../day0/llm.js";
import {
  readClassifierBodyPreview,
  readMirrorBodyPreview,
} from "../connectors/mirrorBodyPreview.js";
import { isPureAckOrEmptyBody } from "../connectors/emailReplyQuotes.js";
import type { MailCategory, MailDisposition } from "./mailTypes.js";
import { normalizeProjectSlug } from "./mailTypes.js";
import { parseEmailAddress } from "./schedulingTypes.js";

export type SchedulingClassification = {
  scheduling: boolean;
  confidence: number;
};

export type InboundMailClassification = {
  disposition: MailDisposition;
  confidence: number;
  category: MailCategory;
  project_slug: string | null;
  is_new_track: boolean;
  reason: string;
};

export function resolveEaClassifierModel(): string {
  return (
    process.env.JOSHU_EA_CLASSIFIER_MODEL?.trim() ||
    process.env.JOSHU_DAY0_MODEL?.trim() ||
    "openai/gpt-5.4-nano"
  );
}

const CLASSIFIER_THRESHOLD = 0.7;

const MAIL_CLASSIFIER_SYSTEM = `You classify inbound email for an executive assistant at ingest time.
Output JSON only with this shape:
{
  "disposition": "noise" | "info" | "track",
  "confidence": number between 0 and 1,
  "category": string,
  "project_slug": string or null,
  "is_new_track": boolean,
  "reason": "one short line"
}

disposition rules (routing — Joshu queues ALL actionable mail to one ingress; the companion files + may spawn scheduling later):
- noise: spam, marketing, bulk with no action, auto-replies with no follow-up
- info: transactional alerts (security, billing, signup confirm), FYI-only notifications; owner_sent_update with no new action
- track: ANY actionable mail — project filing, follow-up, OR meeting/scheduling content

category examples: transactional, security_alert, marketing, investor_reply, networking, project_work, owner_note, owner_sent_update, family_logistics, waitlist_signup, product_development, scheduling, unknown

Use category=scheduling when the mail is primarily about meeting times, availability, reschedule, or owner delegating the companion to offer slots — even though disposition is still track.

project_slug: optional HINT for Projects/<slug>/ (lowercase-hyphen). Use null when unknown. Standalone cold scheduling with no project context → other. Known project threads → that slug (e.g. joshu-product-development, joshu-waitlist-drip).

is_new_track: hint only — true when likely a new work item; false when clearly a reply/update.

owner_sent_update: owner replying in an existing thread with no new ask — disposition=info, is_new_track=false. **Exception:** owner mail on the **agent Nylas inbox** with substantive new text (status updates, DONE markers, questions, directives) is always disposition=track, category=owner_note — never info/owner_sent_update.

CRITICAL — agent inbox owner mail:
- Any substantive owner message on the agent Nylas inbox (including thread replies marking items DONE, KEEP, or giving status) → disposition=track, category=owner_note.
- Only pure one-line acks (Thanks, OK, Got it) may stay disposition=info.

CRITICAL — reply quotes / owner asks:
- Classify ONLY the sender's NEW text. Ignore quoted reply tails ("On … wrote:", ">", Original Message) and prior companion outbound.
- A short owner question on a reply thread (e.g. "What's on my agenda for tomorrow?") is disposition=track even when the quote is a long FYI upgrade notice.
- Never let quoted companion content flip an owner ask to disposition=info.`;

/** True when ingest hints that the ingress worker should spawn ea-scheduling after filing. */
export function isSchedulingCategoryHint(c: Pick<InboundMailClassification, "category">): boolean {
  return c.category === "scheduling";
}

export async function classifySchedulingEmail(opts: {
  subject?: string;
  from?: string;
  bodyPreview?: string;
}): Promise<SchedulingClassification> {
  const full = await classifyInboundMail(opts);
  return {
    scheduling: isSchedulingCategoryHint(full),
    confidence: full.confidence,
  };
}

/** Collapse legacy scheduling disposition and fill hints for universal mail ingress. */
export function normalizeForIngressRouting(
  c: InboundMailClassification,
): InboundMailClassification {
  let disposition = c.disposition;
  if (disposition === "scheduling") {
    disposition = "track";
  }

  let category = c.category;
  if (category === "unknown" && (c.disposition as string) === "scheduling") {
    category = "scheduling";
  }

  let project_slug = c.project_slug;
  if (isSchedulingCategoryHint({ category }) && !project_slug) {
    project_slug = "other";
  }

  return {
    ...c,
    disposition,
    category,
    project_slug,
  };
}

/**
 * Safety net: substantive owner mail on the agent Nylas inbox must not be archived as
 * info/owner_sent_update. LLM often keys off quoted companion FYI or treats DONE lists
 * as passive updates.
 */
export function biasOwnerAgentInboxClassification(opts: {
  classification: InboundMailClassification;
  provider?: string;
  from?: string;
  ownerEmails: Iterable<string>;
  /** Quote-stripped latest-message preview used for classify. */
  classifierBodyPreview?: string;
}): InboundMailClassification {
  const c = opts.classification;
  const provider = (opts.provider ?? "").trim().toLowerCase();
  if (provider !== "nylas") return c;

  const fromAddr = parseEmailAddress(opts.from);
  if (!fromAddr) return c;
  const owners = new Set<string>();
  for (const raw of opts.ownerEmails) {
    const addr = parseEmailAddress(raw) ?? raw.trim().toLowerCase();
    if (addr?.includes("@")) owners.add(addr);
  }
  if (!owners.has(fromAddr)) return c;

  const preview = (opts.classifierBodyPreview ?? "").trim();
  if (isPureAckOrEmptyBody(preview)) return c;

  const category =
    c.category === "owner_sent_update" ? ("owner_note" as MailCategory) : c.category;

  if (
    c.disposition === "info" ||
    c.disposition === "noise" ||
    c.category === "owner_sent_update"
  ) {
    return normalizeForIngressRouting({
      ...c,
      disposition: "track",
      category,
      reason: `${c.reason} (owner_nylas_substantive_override)`.slice(0, 200),
    });
  }

  return c;
}

export async function classifyInboundMail(opts: {
  subject?: string;
  from?: string;
  bodyPreview?: string;
}): Promise<InboundMailClassification> {
  const subject = opts.subject?.trim() || "(no subject)";
  const from = opts.from?.trim() || "(unknown)";
  const body = (opts.bodyPreview ?? "").trim().slice(0, 2000);
  const user = `From: ${from}\nSubject: ${subject}\n\n${body || "(empty body)"}`;

  try {
    const raw = await day0ChatCompletion(
      [
        { role: "system", content: MAIL_CLASSIFIER_SYSTEM },
        { role: "user", content: user },
      ],
      {
        json: true,
        maxTokens: 256,
        model: resolveEaClassifierModel(),
        traceName: "ea-mail-classifier",
        generationName: "classify-inbound-mail",
        tags: ["ea", "mail", "classifier"],
        metadata: { subject, from },
      },
    );
    return normalizeInboundClassification(JSON.parse(raw) as Record<string, unknown>);
  } catch (err) {
    console.warn(`[ea-classifier] mail classify failed: ${(err as Error).message}`);
    return normalizeForIngressRouting({
      disposition: "track",
      confidence: 0,
      category: "unknown",
      project_slug: "other",
      is_new_track: true,
      reason: "classifier_error_fallback",
    });
  }
}

function normalizeInboundClassification(parsed: Record<string, unknown>): InboundMailClassification {
  const dispositionRaw = String(parsed.disposition ?? "track").trim().toLowerCase();
  const disposition: MailDisposition =
    dispositionRaw === "noise" || dispositionRaw === "info" || dispositionRaw === "track"
      ? dispositionRaw
      : dispositionRaw === "scheduling"
        ? "track"
        : "track";

  let confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.min(1, Math.max(0, parsed.confidence))
      : disposition === "track"
        ? 0.5
        : 0.2;

  const category = String(parsed.category ?? "unknown").trim().toLowerCase() as MailCategory;
  const project_slug = parsed.project_slug
    ? normalizeProjectSlug(String(parsed.project_slug))
    : null;
  const is_new_track = parsed.is_new_track !== false;
  const reason = String(parsed.reason ?? "").trim().slice(0, 200) || "classified";

  // Low confidence → safe fallback to track/other for human review
  if (confidence < CLASSIFIER_THRESHOLD && disposition !== "noise") {
    return normalizeForIngressRouting({
      disposition: "track",
      confidence,
      category: category || "unknown",
      project_slug: project_slug ?? "other",
      is_new_track,
      reason: `${reason} (low confidence)`,
    });
  }

  return normalizeForIngressRouting({
    disposition,
    confidence,
    category: category || "unknown",
    project_slug,
    is_new_track,
    reason,
  });
}

export function shouldQueueScheduling(classification: SchedulingClassification): boolean {
  return classification.scheduling && classification.confidence >= CLASSIFIER_THRESHOLD;
}

export function shouldActOnMailClassification(c: InboundMailClassification): boolean {
  return c.confidence >= CLASSIFIER_THRESHOLD || c.disposition === "track";
}

export async function readBodyPreview(
  filesRoot: string,
  sourcePath: string,
  maxChars = 2000,
): Promise<string> {
  return readMirrorBodyPreview(filesRoot, sourcePath, maxChars);
}

/** Quote-stripped latest-message preview for disposition routing. */
export async function readBodyPreviewForClassify(
  filesRoot: string,
  sourcePath: string,
  maxChars = 2000,
): Promise<string> {
  return readClassifierBodyPreview(filesRoot, sourcePath, maxChars);
}
