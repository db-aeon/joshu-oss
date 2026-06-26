#!/usr/bin/env node
/**
 * Gather deterministic inputs for ea-time-block plan JSON (calendar + file context).
 *
 * Usage:
 *   node scripts/gather-time-block-input.mjs --stdout
 *   node scripts/gather-time-block-input.mjs -o Planning/.time-block-plan-2026-06-18.json
 *   node scripts/gather-time-block-input.mjs --date 2026-06-18 --timezone America/Los_Angeles
 *
 * Calendar: Joshu GET /joshu/api/connectors/calendar/google/events (preferred), then mirror scan.
 * Agent fills gaps (deep work, shallow, buffers) and merges carryover/taskGroups before render.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_TIMEZONE = "America/Los_Angeles";
const DEFAULT_WORK_HOURS = { start: "09:00", end: "17:00" };
const PROJECT_SKIP = new Set(["_archive", "_system", "_template"]);

function parseArgs(argv) {
  const args = {
    date: null,
    timezone: DEFAULT_TIMEZONE,
    output: null,
    stdout: false,
    filesRoot: process.env.JOSHU_FILES_ROOT?.trim() || null,
    apiBase: process.env.JOSHU_API_BASE?.trim() || null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stdout") args.stdout = true;
    else if (a === "--date" && argv[i + 1]) args.date = argv[++i];
    else if (a === "--timezone" && argv[i + 1]) args.timezone = argv[++i];
    else if (a === "--files-root" && argv[i + 1]) args.filesRoot = path.resolve(argv[++i]);
    else if (a === "--api-base" && argv[i + 1]) args.apiBase = argv[++i].replace(/\/+$/, "");
    else if (a === "-o" && argv[i + 1]) args.output = path.resolve(argv[++i]);
    else if (!a.startsWith("-") && !args.output && !args.stdout) args.output = path.resolve(a);
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (!args.stdout && !args.output) args.stdout = true;
  return args;
}

function resolveFilesRoot(explicit) {
  if (explicit && fs.existsSync(explicit)) return path.resolve(explicit);
  const arozData = process.env.AROZ_DATA?.trim() || path.join(process.cwd(), ".local", "arozos-data");
  const joshuDir = process.env.JOSHU_FILES_DIR_NAME?.trim() || "joshu's files";
  const usersRoot = path.join(arozData, "files", "users");
  if (!fs.existsSync(usersRoot)) throw new Error(`Users root not found: ${usersRoot}`);
  const overrideUser = process.env.JOSHU_AROZ_USER?.trim();
  const users = overrideUser
    ? [overrideUser]
    : fs
        .readdirSync(usersRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== "admin")
        .map((e) => e.name);
  for (const user of users) {
    const filesRoot = path.join(usersRoot, user, "Desktop", joshuDir);
    if (fs.existsSync(filesRoot)) return path.resolve(filesRoot);
  }
  throw new Error("Could not resolve joshu files root — set JOSHU_FILES_ROOT");
}

function resolveApiBase(explicit) {
  if (explicit) return explicit.replace(/\/+$/, "");
  const port = process.env.JOSHU_PORT?.trim() || "8788";
  const basePath = process.env.PUBLIC_BASE_PATH?.trim() || "/joshu";
  return `http://127.0.0.1:${port}${basePath}`;
}

function isoToLocalDate(iso, timezone) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(d);
}

function isoToLocalHHMM(iso, timezone) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

function addDays(dateStr, delta) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return dt.toISOString().slice(0, 10);
}

function formatTitle(dateStr, timezone) {
  const d = new Date(`${dateStr}T12:00:00`);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(d);
  const month = new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short" }).format(d);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: timezone, day: "numeric" }).format(d);
  return `Time block — ${weekday} ${month} ${day}`;
}

function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) return {};
  try {
    return YAML.parse(m[1]) ?? {};
  } catch {
    return {};
  }
}

function relFromFilesRoot(filesRoot, absPath) {
  return path.relative(filesRoot, absPath).split(path.sep).join("/");
}

function safeEventToken(eventId) {
  return String(eventId).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

/** Build map eventId → relative mirror path under files root. */
function indexCalendarMirrors(filesRoot) {
  const index = new Map();
  const calendarRoot = path.join(filesRoot, "connectors", "calendar");
  if (!fs.existsSync(calendarRoot)) return index;

  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!ent.name.endsWith(".md")) continue;
      const rel = relFromFilesRoot(filesRoot, abs);
      const fm = parseFrontmatter(fs.readFileSync(abs, "utf8"));
      const externalId = fm.external_id ?? fm.externalId;
      if (externalId) index.set(String(externalId), rel);
      const token = safeEventToken(ent.name.replace(/\.md$/, ""));
      if (!index.has(token)) index.set(token, rel);
    }
  }
  walk(calendarRoot);
  return index;
}

function mirrorPathForEvent(index, eventId) {
  if (!eventId) return null;
  return index.get(eventId) ?? index.get(safeEventToken(eventId)) ?? null;
}

async function fetchLiveCalendarEvents(apiBase, date, timezone) {
  const url = `${apiBase}/api/connectors/calendar/google/events?date=${encodeURIComponent(date)}&timezone=${encodeURIComponent(timezone)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return { events: [], source: "api_error", error: `${res.status}` };
    const body = await res.json();
    return { events: Array.isArray(body.events) ? body.events : [], source: "live_api" };
  } catch (err) {
    return { events: [], source: "api_unreachable", error: err instanceof Error ? err.message : String(err) };
  }
}

function scanMirrorEvents(filesRoot, date, timezone) {
  const index = indexCalendarMirrors(filesRoot);
  const out = [];
  for (const [id, relPath] of index.entries()) {
    if (!relPath.includes("/events/")) continue;
    const abs = path.join(filesRoot, relPath);
    if (!fs.existsSync(abs)) continue;
    const fm = parseFrontmatter(fs.readFileSync(abs, "utf8"));
    const start = fm.start;
    if (!start) continue;
    const localDate = isoToLocalDate(start, timezone);
    if (localDate !== date) continue;
    const externalId = fm.external_id ?? id;
    out.push({
      id: externalId,
      summary: fm.title ?? fm.summary,
      start,
      end: fm.end,
      status: fm.status,
      blocksAvailability: fm.blocksAvailability ?? true,
      mirrorPath: relPath,
    });
  }
  const byId = new Map();
  for (const ev of out) byId.set(ev.id, ev);
  return { events: [...byId.values()], source: "mirrors" };
}

function eventBlocksTime(ev) {
  if (ev.status === "cancelled") return false;
  if (ev.blocksAvailability === false) return false;
  return true;
}

function toMeetingBlock(ev, timezone) {
  const start = isoToLocalHHMM(ev.start, timezone);
  const end = isoToLocalHHMM(ev.end, timezone);
  if (!start || !end) return null;
  if (parseTimeToMinutes(end) <= parseTimeToMinutes(start)) return null;
  return {
    start,
    end,
    label: ev.summary?.trim() || "Meeting",
    kind: "meeting",
    link: ev.mirrorPath ? { path: ev.mirrorPath } : null,
  };
}

function parseIntField(v) {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : 99;
}

function scanActiveProjects(filesRoot) {
  const projectsDir = path.join(filesRoot, "Projects");
  if (!fs.existsSync(projectsDir)) return [];
  const out = [];
  for (const ent of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!ent.isDirectory() || PROJECT_SKIP.has(ent.name) || ent.name.startsWith(".")) continue;
    const aboutPath = path.join(projectsDir, ent.name, "about.md");
    if (!fs.existsSync(aboutPath)) continue;
    const fm = parseFrontmatter(fs.readFileSync(aboutPath, "utf8"));
    const status = String(fm.status ?? "").toLowerCase();
    if (status && status !== "active") continue;
    const urgency = parseIntField(fm.urgency);
    if (urgency > 3) continue;
    out.push({
      slug: ent.name,
      title: fm.title ?? ent.name,
      urgency,
      importance: parseIntField(fm.importance),
      aboutPath: relFromFilesRoot(filesRoot, aboutPath),
      todoPath: fs.existsSync(path.join(projectsDir, ent.name, "todo.md"))
        ? relFromFilesRoot(filesRoot, path.join(projectsDir, ent.name, "todo.md"))
        : null,
    });
  }
  out.sort((a, b) => a.urgency - b.urgency || a.importance - b.importance);
  return out;
}

function scanRecentJournals(filesRoot, dates) {
  const dateSet = new Set(dates);
  const out = [];
  const projectsDir = path.join(filesRoot, "Projects");
  if (!fs.existsSync(projectsDir)) return out;

  function consider(abs, slug) {
    const base = path.basename(abs, ".md");
    const m = /^journal_(\d{4}-\d{2}-\d{2})$/.exec(base);
    if (!m || !dateSet.has(m[1])) return;
    out.push({
      path: relFromFilesRoot(filesRoot, abs),
      slug,
      date: m[1],
    });
  }

  for (const ent of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(projectsDir, ent.name);
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith("journal_") && f.endsWith(".md")) {
        consider(path.join(dir, f), ent.name);
      }
    }
  }
  out.sort((a, b) => b.date.localeCompare(a.date) || a.path.localeCompare(b.path));
  return out;
}

function planningPath(filesRoot, name) {
  const rel = `Planning/${name}`;
  const abs = path.join(filesRoot, rel);
  return fs.existsSync(abs) ? rel : null;
}

function expandWorkHours(blocks, fallback = DEFAULT_WORK_HOURS) {
  if (blocks.length === 0) return { ...fallback };
  let min = parseTimeToMinutes(fallback.start);
  let max = parseTimeToMinutes(fallback.end);
  for (const b of blocks) {
    min = Math.min(min, parseTimeToMinutes(b.start));
    max = Math.max(max, parseTimeToMinutes(b.end));
  }
  return { start: minutesToHHMM(min), end: minutesToHHMM(max) };
}

function parseTimeToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

function minutesToHHMM(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

async function loadOwnerAnchor() {
  try {
    const mod = await import(pathToFileURL(path.join(ROOT_DIR, "dist/ownerLocalTime.js")).href);
    return mod.getOwnerTimeAnchor(ROOT_DIR);
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const filesRoot = resolveFilesRoot(args.filesRoot);
  const apiBase = resolveApiBase(args.apiBase);
  const ownerAnchor = await loadOwnerAnchor();
  const timezone = args.timezone || ownerAnchor?.timezone || DEFAULT_TIMEZONE;

  let date = args.date;
  if (!date && ownerAnchor?.localDate) {
    date = ownerAnchor.localDate;
  }
  if (!date) {
    date = isoToLocalDate(new Date().toISOString(), timezone);
  }

  const mirrorIndex = indexCalendarMirrors(filesRoot);
  let calendarSource = "none";
  let calendarNote = null;
  let rawEvents = [];

  const live = await fetchLiveCalendarEvents(apiBase, date, timezone);
  if (live.events.length > 0) {
    calendarSource = live.source;
    rawEvents = live.events.map((ev) => ({
      ...ev,
      mirrorPath: mirrorPathForEvent(mirrorIndex, ev.id),
    }));
  } else {
    const mirrors = scanMirrorEvents(filesRoot, date, timezone);
    calendarSource = mirrors.source;
    calendarNote = live.error ?? (live.source === "api_error" ? `api ${live.error}` : null);
    rawEvents = mirrors.events;
  }

  const meetingBlocks = rawEvents
    .filter(eventBlocksTime)
    .map((ev) => toMeetingBlock(ev, timezone))
    .filter(Boolean)
    .sort((a, b) => parseTimeToMinutes(a.start) - parseTimeToMinutes(b.start));

  const yesterday = addDays(date, -1);
  const twoDaysAgo = addDays(date, -2);

  const skeleton = {
    date,
    title: formatTitle(date, timezone),
    yesterdayPlan: planningPath(filesRoot, `time-block-${yesterday}.excalidraw`)
      ? {
          date: yesterday,
          path: `Planning/time-block-${yesterday}.excalidraw`,
          label: new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric" }).format(
            new Date(`${yesterday}T12:00:00`),
          ),
        }
      : null,
    carryover: [],
    workHours: expandWorkHours(meetingBlocks),
    taskGroups: [],
    blocks: meetingBlocks,
    notes: [],
    noteLinks: [],
    _gather: {
      generatedAt: new Date().toISOString(),
      filesRoot,
      timezone,
      calendarSource,
      calendarNote,
      planningFiles: {
        dailyReview: planningPath(filesRoot, `daily-review-${date}.md`),
        capture: planningPath(filesRoot, `capture-${date}.md`),
        yesterdayPlanJson: planningPath(filesRoot, `.time-block-plan-${yesterday}.json`),
        yesterdayDiagram: planningPath(filesRoot, `time-block-${yesterday}.excalidraw`),
      },
      activeProjects: scanActiveProjects(filesRoot),
      recentJournals: scanRecentJournals(filesRoot, [date, yesterday, twoDaysAgo]),
      calendarEvents: rawEvents.map((ev) => ({
        id: ev.id,
        summary: ev.summary,
        start: ev.start,
        end: ev.end,
        status: ev.status,
        blocksAvailability: ev.blocksAvailability,
        mirrorPath: ev.mirrorPath ?? mirrorPathForEvent(mirrorIndex, ev.id),
        localStart: isoToLocalHHMM(ev.start, timezone),
        localEnd: isoToLocalHHMM(ev.end, timezone),
      })),
    },
  };

  const out = `${JSON.stringify(skeleton, null, 2)}\n`;
  if (args.stdout) {
    process.stdout.write(out);
    return;
  }
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, out, "utf8");
  console.log(
    `[gather-time-block-input] wrote ${args.output} (${meetingBlocks.length} meeting blocks, calendar=${calendarSource})`,
  );
}

main().catch((err) => {
  console.error("[gather-time-block-input]", err instanceof Error ? err.message : err);
  process.exit(1);
});
