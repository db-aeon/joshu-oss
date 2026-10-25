#!/usr/bin/env node
/**
 * Merge factory SKILL.md into the box-evolved copy (OpenRouter chat).
 * Used by bootstrap-hermes-learning-skills.sh when a factory skill changed since the last seed — not Cursor.
 * After the merge, keepBoxPitfalls adds back each box pitfall that the merge left out without a reason.
 *
 * Usage: node merge-hermes-factory-skill.mjs --factory <path> --box <path> [--out <path>]
 * Env: OPENROUTER_API_KEY, optional JOSHU_HERMES_SKILLS_MERGE_MODEL (default google/gemini-3.1-flash-lite)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { DROPPED_MARKER, keepBoxPitfalls, parseMergeAnswer } from "./lib/skill-merge-pitfalls.mjs";

function parseArgs(argv) {
  const out = { factory: "", box: "", outPath: "" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--factory") out.factory = argv[++i] ?? "";
    else if (a === "--box") out.box = argv[++i] ?? "";
    else if (a === "--out") out.outPath = argv[++i] ?? "";
  }
  return out;
}

const MERGE_SYSTEM = `You merge Joshu Hermes factory skill updates into a box-evolved SKILL.md.

Rules:
- Preserve box-specific procedures, owner preferences, and validated pitfalls from the BOX version.
- A box pitfall is a paragraph of the BOX version that starts with "**Pitfall". Keep each box pitfall word for word, unless the FACTORY version makes it wrong (for example, the factory fixed the tool that the pitfall is about).
- Integrate new factory procedures, tool names, and safety gates from the FACTORY version.
- Keep YAML frontmatter valid; bump metadata.hermes.version to the higher semantic version when factory is newer.
- When FACTORY defines Browser Use Cloud vs local Chromium rules, DROP box sections that contradict them (Camofox :9377 curl workarounds, "staging the tab in Camofox", browser_task on cloud fleet, hitl-camofox fallbacks after no_active_browser_tab).
- Do not preserve skill_manage patches that were written during a failed browser/handoff run — treat those as noise unless they document owner-specific preferences unrelated to browser infrastructure.
- Output the complete merged SKILL.md markdown. No preamble or commentary.
- After the merged SKILL.md, write the line ${DROPPED_MARKER} and then one line for each box pitfall that you left out: "- <bold title of the box pitfall> :: <why the FACTORY version makes it wrong>". Write "- none" when you kept every box pitfall.`;

async function main() {
  const { factory, box, outPath } = parseArgs(process.argv);
  if (!factory || !box) {
    console.error("usage: merge-hermes-factory-skill.mjs --factory <path> --box <path> [--out <path>]");
    process.exit(2);
  }

  const factoryText = readFileSync(resolve(factory), "utf8");
  const boxText = readFileSync(resolve(box), "utf8");
  if (factoryText === boxText) {
    const dest = outPath ? resolve(outPath) : resolve(box);
    writeFileSync(dest, factoryText, "utf8");
    process.stdout.write("unchanged\n");
    return;
  }

  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    console.error("merge-hermes-factory-skill: OPENROUTER_API_KEY missing — keeping box file");
    process.exit(1);
  }

  const model =
    process.env.JOSHU_HERMES_SKILLS_MERGE_MODEL?.trim() || "google/gemini-3.1-flash-lite";

  const userContent = `FACTORY (product release):\n\n${factoryText}\n\n---\n\nBOX (current on this sandbox):\n\n${boxText}`;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://joshu.me",
      "X-Title": "joshu-skill-merge",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      // No-training routing (withOpenRouterDataPolicy in src/joshuOpenRouterDefaults.ts).
      // The box copy of a skill can hold owner details.
      provider: { data_collection: "deny" },
      messages: [
        { role: "system", content: MERGE_SYSTEM },
        { role: "user", content: userContent },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`merge-hermes-factory-skill: OpenRouter ${res.status}: ${errText.slice(0, 500)}`);
    process.exit(1);
  }

  const data = await res.json();
  const merged = data?.choices?.[0]?.message?.content;
  if (typeof merged !== "string" || !merged.trim()) {
    console.error("merge-hermes-factory-skill: empty model response");
    process.exit(1);
  }

  const { skill, dropped } = parseMergeAnswer(merged.trim());
  if (!skill.trim()) {
    console.error("merge-hermes-factory-skill: model response has no SKILL.md before the dropped pitfalls");
    process.exit(1);
  }
  const kept = keepBoxPitfalls({ box: boxText, merged: skill, dropped });
  for (const d of kept.droppedWithReason) {
    console.error(`merge-hermes-factory-skill: ${box}: merge dropped box pitfall "${d.title}": ${d.reason}`);
  }
  for (const p of kept.restored) {
    const title = p.text.match(/\*\*(.+?)\*\*/)?.[1] ?? p.key;
    console.error(`merge-hermes-factory-skill: ${box}: kept box pitfall "${title}" (the merge left it out without a reason)`);
  }

  const dest = outPath ? resolve(outPath) : resolve(box);
  writeFileSync(dest, `${kept.text.replace(/\s+$/, "")}\n`, "utf8");
  process.stdout.write("merged\n");
}

main().catch((err) => {
  console.error(`merge-hermes-factory-skill: ${err?.message || err}`);
  process.exit(1);
});
