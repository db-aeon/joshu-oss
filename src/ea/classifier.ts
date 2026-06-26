import { day0ChatCompletion } from "../day0/llm.js";
import { readMirrorBodyPreview } from "../connectors/mirrorBodyPreview.js";
import type { MailCategory, MailDisposition } from "./mailTypes.js";
import { normalizeProjectSlug } from "./mailTypes.js";

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

disposition rules (routing — Joshu queues ALL actionable mail to one ingress; Patrick files + may spawn scheduling later):
- noise: spam, marketing, bulk with no action, auto-replies with no follow-up
- info: transactional alerts (security, billing, signup confirm), FYI-only notifications; Dan owner_sent_update with no new action
- track: ANY actionable mail — project filing, follow-up, OR meeting/scheduling content

category examples: transactional, security_alert, marketing, investor_reply, networking, project_work, owner_note, owner_sent_update, family_logistics, waitlist_signup, product_development, scheduling, unknown

Use category=scheduling when the mail is primarily about meeting times, availability, reschedule, or owner delegating Patrick to offer slots — even though disposition is still track.

project_slug: optional HINT for Projects/<slug>/ (lowercase-hyphen). Use null when unknown. Standalone cold scheduling with no project context → other. Known project threads → that slug (e.g. joshu-product-development, joshu-waitlist-drip).

is_new_track: hint only — true when likely a new work item; false when clearly a reply/update.

owner_sent_update: Dan replying in an existing thread with no new ask — disposition=info, is_new_track=false. If Dan delegates work (e.g. "Copying Patrick to suggest times") → disposition=track, category may be scheduling.`;

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
