#!/usr/bin/env node
/**
 * Merge factory SKILL.md into the box-evolved copy (OpenRouter chat).
 * Used by bootstrap-hermes-learning-skills.sh on release bumps — not Cursor.
 *
 * Usage: node merge-hermes-factory-skill.mjs --factory <path> --box <path> [--out <path>]
 * Env: OPENROUTER_API_KEY, optional JOSHU_HERMES_SKILLS_MERGE_MODEL (default google/gemini-3.1-flash-lite)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

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
- Integrate new factory procedures, tool names, and safety gates from the FACTORY version.
- Keep YAML frontmatter valid; bump metadata.hermes.version to the higher semantic version when factory is newer.
- Output ONLY the complete merged SKILL.md markdown. No preamble or commentary.`;

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
  let merged = data?.choices?.[0]?.message?.content;
  if (typeof merged !== "string" || !merged.trim()) {
    console.error("merge-hermes-factory-skill: empty model response");
    process.exit(1);
  }

  merged = merged.trim();
  if (merged.startsWith("```")) {
    merged = merged.replace(/^```(?:markdown|md)?\s*/i, "").replace(/\s*```$/, "");
  }

  const dest = outPath ? resolve(outPath) : resolve(box);
  writeFileSync(dest, `${merged}\n`, "utf8");
  process.stdout.write("merged\n");
}

main().catch((err) => {
  console.error(`merge-hermes-factory-skill: ${err?.message || err}`);
  process.exit(1);
});
