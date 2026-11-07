/** Mail ingress + project track Kanban constants (parallel to schedulingTypes). */

export const EA_MAIL_INGRESS_BOARD = "ea-mail-ingress";
export const EA_PLAYBOOK_SKILL = "ea-playbook";
/** Skill of the mail ingress worker (the ingress sections of the old ea-playbook). */
export const EA_MAIL_INGRESS_SKILL = "ea-mail-ingress";
/** Skill of the mail track worker and the project filing rules. */
export const EA_MAIL_TRACK_SKILL = "ea-mail-track";
/** Skills that Hermes preloads for the worker of a mail ingress task. */
export const MAIL_INGRESS_TASK_SKILLS = [EA_MAIL_INGRESS_SKILL, EA_MAIL_TRACK_SKILL];
/** Skills that Hermes preloads for the worker of a mail track task. */
export const MAIL_TRACK_TASK_SKILLS = [EA_MAIL_TRACK_SKILL];

export type MailDisposition = "noise" | "info" | "scheduling" | "track";

export type MailCategory =
  | "scheduling"
  | "transactional"
  | "security_alert"
  | "marketing"
  | "newsletter_broadcast"
  | "investor_reply"
  | "networking"
  | "project_work"
  | "owner_note"
  | "owner_sent_update"
  | "family_logistics"
  | "waitlist_signup"
  | "product_development"
  | "unknown";

/** Board slug for Projects/<folder-slug>/ */
export function projectBoardSlug(folderSlug: string): string {
  const s = folderSlug
    .trim()
    .toLowerCase()
    .replace(/^project-/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s ? `project-${s}` : "project-other";
}

export function normalizeProjectSlug(raw: string | null | undefined): string {
  const s = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^project-/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "other";
}

export function parseEmailAddress(from?: string): string | null {
  const raw = from?.trim();
  if (!raw) return null;
  const match = /<([^>]+)>/.exec(raw);
  if (match) return match[1]!.trim().toLowerCase();
  if (raw.includes("@")) return raw.toLowerCase();
  return null;
}
