import { Temporal } from "@js-temporal/polyfill";

/** ICU legacy abbreviations accepted by Intl but rejected by Temporal. */
const LEGACY_TZ_ALIASES: Record<string, string> = {
  PST: "America/Los_Angeles",
  PDT: "America/Los_Angeles",
  MST: "America/Denver",
  MDT: "America/Denver",
  CST: "America/Chicago",
  CDT: "America/Chicago",
  EST: "America/New_York",
  EDT: "America/New_York",
};

/** Map legacy ICU zone ids (e.g. PST) to canonical IANA names Temporal accepts. */
export function normalizeIanaTimezone(timezone: string): string {
  const trimmed = timezone.trim();
  if (!trimmed) return trimmed;
  const alias = LEGACY_TZ_ALIASES[trimmed.toUpperCase()];
  return alias ?? trimmed;
}

/** True when Temporal can resolve the zone (stricter than Intl alone). */
export function isValidIanaTimezone(timezone: string): boolean {
  const normalized = normalizeIanaTimezone(timezone);
  if (!normalized) return false;
  try {
    Temporal.Now.instant().toZonedDateTimeISO(normalized);
    return true;
  } catch {
    return false;
  }
}
