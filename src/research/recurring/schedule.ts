/**
 * The schedule of a recurring report (design decision D1): a Hermes cron expression with one number
 * in the minute field, so that each run starts at a fixed time of day. Hermes runs it in the owner
 * timezone (spec `hermes-cron-timezone`). The plugin tools and the form of the Research app build
 * the expression from days and times.
 */

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export type ScheduleResult = { ok: true; schedule: string } | { ok: false; error: string };

/** A day as a number (0 is Sunday), from a number, a day name, or its first three letters. */
function dayNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isInteger(raw) && raw >= 0 && raw <= 7 ? raw % 7 : null;
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (/^[0-7]$/.test(s)) return Number(s) % 7;
  const i = DAY_NAMES.findIndex((d) => s.length >= 3 && d.startsWith(s));
  return i >= 0 ? i : null;
}

/** `HH:MM` (24 hours), `7`, `7am`, or `5:30 pm` to hours and minutes. */
function parseTime(raw: unknown): { h: number; m: number } | null {
  const s = typeof raw === "string" ? raw.trim().toLowerCase().replace(/\s+/g, "") : typeof raw === "number" ? String(raw) : "";
  const match = s.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
  if (!match) return null;
  let h = Number(match[1]);
  const m = match[2] ? Number(match[2]) : 0;
  if (match[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (match[3] === "pm" ? 12 : 0);
  }
  return h <= 23 && m <= 59 ? { h, m } : null;
}

/** The day field: `*`, a range like `1-5`, or a list like `1,3`. */
function dayField(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 7) return "*";
  const contiguous = sorted.length > 2 && sorted.every((d, i) => i === 0 || d === sorted[i - 1]! + 1);
  return contiguous ? `${sorted[0]}-${sorted.at(-1)}` : sorted.join(",");
}

/**
 * The cron expression of days and times. All times must have the same minute, because the minute
 * field has one number. An empty list of days means every day.
 */
export function buildSchedule(days: unknown, times: unknown): ScheduleResult {
  const dayList = Array.isArray(days) ? days : days === undefined || days === null || days === "" ? [] : [days];
  const nums: number[] = [];
  for (const d of dayList) {
    const n = dayNumber(d);
    if (n === null) return { ok: false, error: `unknown day "${String(d)}"` };
    nums.push(n);
  }
  const timeList = Array.isArray(times) ? times : [times];
  const parsed = timeList.map(parseTime);
  if (!parsed.length || parsed.some((t) => t === null)) return { ok: false, error: "time is required, for example 07:00" };
  const minutes = new Set(parsed.map((t) => t!.m));
  if (minutes.size > 1) return { ok: false, error: "all times of a recurring report must have the same minutes, for example 07:00 and 17:00" };
  const hours = [...new Set(parsed.map((t) => t!.h))].sort((a, b) => a - b);
  return { ok: true, schedule: `${parsed[0]!.m} ${hours.join(",")} * * ${nums.length ? dayField(nums) : "*"}` };
}

/** Check a cron expression: five fields, one number in the minute field. */
export function checkSchedule(raw: unknown): ScheduleResult {
  const schedule = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  const fields = schedule.split(" ");
  if (fields.length !== 5 || !fields.every((f) => /^[\d*\-,/]+$/.test(f))) {
    return { ok: false, error: `invalid schedule "${schedule}" (use a cron expression like "0 7 * * 1-5")` };
  }
  if (!/^\d{1,2}$/.test(fields[0]!) || Number(fields[0]) > 59) {
    return { ok: false, error: "a recurring report runs at fixed times (the minute field must be one number)" };
  }
  if (!/^[\d,]+$/.test(fields[1]!) || fields[1]!.split(",").some((h) => !h || Number(h) > 23)) {
    return { ok: false, error: "a recurring report runs at fixed hours (the hour field must be numbers)" };
  }
  return { ok: true, schedule };
}

/** The days of the day field, 0 is Sunday. */
export function scheduleDays(schedule: string): number[] {
  const field = schedule.split(" ")[4] ?? "*";
  if (field === "*") return [0, 1, 2, 3, 4, 5, 6];
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const range = part.match(/^(\d)-(\d)$/);
    if (range) for (let d = Number(range[1]); d <= Number(range[2]); d += 1) out.add(d % 7);
    else if (/^\d$/.test(part)) out.add(Number(part) % 7);
  }
  return [...out].sort((a, b) => a - b);
}

/** The times of the schedule as `HH:MM`. */
export function scheduleTimes(schedule: string): string[] {
  const [m, h] = schedule.split(" ");
  return (h ?? "").split(",").filter(Boolean).map((hour) => `${hour.padStart(2, "0")}:${(m ?? "0").padStart(2, "0")}`);
}

function clock(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h! < 12 ? "am" : "pm";
  return `${((h! + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** The schedule in words, for example "7:00 am, Monday to Friday". */
export function describeSchedule(schedule: string): string {
  const days = scheduleDays(schedule);
  const times = scheduleTimes(schedule).map(clock).join(" and ");
  let when: string;
  if (days.length === 7) when = "every day";
  else if (days.join() === "1,2,3,4,5") when = "Monday to Friday";
  else if (days.join() === "0,6") when = "Saturday and Sunday";
  else if (days.length === 1) when = `${DAY_LABELS[days[0]!]}s`;
  else when = days.map((d) => DAY_LABELS[d]).join(", ");
  return `${times}, ${when}`;
}
