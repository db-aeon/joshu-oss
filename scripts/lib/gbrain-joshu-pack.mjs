#!/usr/bin/env node
/**
 * Normalize the `joshu` gbrain schema pack so Joshu page types match the real
 * Desktop layout. Idempotent; prints whether the pack changed.
 *
 * gbrain types a page by the FIRST page_type (in array order) that has a
 * path_prefix appearing anywhere in "/<desktop-relative path>" (substring, not
 * a true prefix). The pack is forked from gbrain-base, whose generic types
 * (`project` → "projects/", `calendar-event` → "calendar/") sit ahead of
 * Joshu's and win: journals under Projects/<p>/ came out as project/note,
 * calendar mirrors as calendar-event. Joshu types are therefore moved to the
 * front, with prefixes for where Joshu actually writes:
 *
 *   joshu's files/Projects/<p>/journal_YYYY-MM-DD.md   → journal
 *   joshu's files/Planning/daily-review-YYYY-MM-DD.md  → journal
 *   joshu's files/Triage/(…/_done/)<stub>.md           → inbox
 *   joshu's files/connectors/{mail,calendar}/…         → connector-*
 *
 * Usage: node gbrain-joshu-pack.mjs <pack.json>
 */

import { readFileSync, writeFileSync } from "node:fs";

/** Order matters: earlier entries win. */
const JOSHU_TYPES = [
  {
    name: "journal",
    primitive: "temporal",
    path_prefixes: ["journals/", "journal_", "planning/daily-review-"],
    extractable: true,
  },
  { name: "research", primitive: "annotation", path_prefixes: ["research/"], extractable: true },
  { name: "inbox", primitive: "annotation", path_prefixes: ["inbox/", "triage/"], extractable: false },
  { name: "upload", primitive: "annotation", path_prefixes: ["uploads/"], extractable: false },
  {
    name: "connector-mail",
    primitive: "annotation",
    path_prefixes: ["connectors/mail/"],
    extractable: true,
  },
  {
    name: "connector-calendar",
    primitive: "annotation",
    path_prefixes: ["connectors/calendar/"],
    extractable: true,
  },
];

const packPath = process.argv[2];
if (!packPath) {
  console.error("usage: gbrain-joshu-pack.mjs <pack.json>");
  process.exit(2);
}

const raw = readFileSync(packPath, "utf8");
const pack = JSON.parse(raw);
if (!Array.isArray(pack.page_types)) pack.page_types = [];

const byName = new Map(pack.page_types.map((t) => [t.name, t]));
const joshuNames = new Set(JOSHU_TYPES.map((t) => t.name));
const head = JOSHU_TYPES.map((def) => {
  const prev = byName.get(def.name) ?? {};
  return {
    ...prev,
    name: def.name,
    primitive: def.primitive,
    path_prefixes: def.path_prefixes,
    aliases: Array.isArray(prev.aliases) ? prev.aliases : [],
    extractable: def.extractable,
    expert_routing: prev.expert_routing ?? false,
  };
});
pack.page_types = [...head, ...pack.page_types.filter((t) => !joshuNames.has(t.name))];

const next = `${JSON.stringify(pack, null, 2)}\n`;
if (next === raw) {
  console.log("[gbrain-schema] joshu pack already normalized");
} else {
  writeFileSync(packPath, next, "utf8");
  console.log(`[gbrain-schema] joshu pack normalized (${JOSHU_TYPES.map((t) => t.name).join(", ")} first)`);
}
