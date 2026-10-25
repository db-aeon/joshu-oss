#!/usr/bin/env node
/**
 * Tests: the LLM merge of the skills seed keeps the box pitfalls (scripts/lib/skill-merge-pitfalls.mjs,
 * scripts/merge-hermes-factory-skill.mjs). The script run replaces fetch, so no network is used.
 * Spec: openspec/changes/skills-seed-keep-pitfalls/specs/hermes-skills-seed/spec.md
 * Usage: node scripts/test-skill-merge-pitfalls.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DROPPED_MARKER,
  KEPT_HEADING,
  findBoxPitfalls,
  keepBoxPitfalls,
  parseMergeAnswer,
} from "./lib/skill-merge-pitfalls.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));

const front = (version) => `---\nname: ea-playbook\nmetadata:\n  hermes:\n    version: "${version}"\n---\n`;
const P_BOARD =
  "**Pitfall — `kanban_show`/`kanban_comment` IGNORE the `board` argument (observed 2026-10-02):** these tools read the worker's own board.";
const P_THREAD =
  "**Pitfall — `mail_list_track_tasks(threadId=…)` can return `count: 0` for a thread that has an open track** (observed 2026-10-08): list the tracks of the project instead.";
const P_HANDOFF =
  "**Pitfall — `mail_handoff_track_task` returns `{\"error\":\"unknown action: complete\"}`** (observed 2026-10-02): the handoff is often written anyway.\nRead the track before you retry.";
const box = `${front("2.23.0")}
# EA playbook

## Mail ingress

1. File the mail.

${P_BOARD}

${P_THREAD}

| Source | Note |
|---|---|
| Inbox | **Pitfall**: a table row is not a box pitfall paragraph. |

> ${P_HANDOFF.split("\n")[0]}
> ${P_HANDOFF.split("\n")[1]}
`;
const factory = `${front("2.24.0")}
# EA playbook

## Mail ingress

1. File the mail.
2. New factory step.
`;

// --- Box pitfalls: paragraphs that start with **Pitfall, not table rows ---
{
  const pitfalls = findBoxPitfalls(box);
  assert.equal(pitfalls.length, 3, JSON.stringify(pitfalls, null, 2));
  assert.ok(pitfalls[2].text.includes("Read the track before you retry."), "a box pitfall keeps its second line");
  const bare = findBoxPitfalls("**Pitfall**: `unread: true` includes sent messages.\n\n**Pitfall**: old threads pile up.");
  assert.equal(bare.length, 2);
  assert.notEqual(bare[0].key, bare[1].key, "a bare **Pitfall** title is keyed by its text");
}

// --- The merge left out every box pitfall and gave no reason: each comes back word for word ---
{
  const kept = keepBoxPitfalls({ box, merged: factory, dropped: [] });
  assert.equal(kept.restored.length, 3);
  assert.ok(kept.text.startsWith(factory.trimEnd()), "the merged text stays as it was");
  assert.ok(kept.text.includes(`\n${KEPT_HEADING}\n`));
  for (const p of findBoxPitfalls(box)) assert.ok(kept.text.includes(p.text), `kept: ${p.key}`);
  const again = keepBoxPitfalls({ box, merged: kept.text, dropped: [] });
  assert.equal(again.restored.length, 0, "a second merge adds nothing again");
}

// --- A reworded box pitfall with the same bold title counts as kept ---
{
  const merged = `${factory}\n**Pitfall - "kanban_show"/"kanban_comment" ignore the board argument (observed 2026 10 02):** reworded.\n`;
  const kept = keepBoxPitfalls({ box, merged, dropped: [] });
  assert.deepEqual(
    kept.restored.map((p) => p.key.slice(0, 20)),
    ["pitfall mail list tr", "pitfall mail handoff"],
  );
}

// --- A box pitfall dropped with a reason stays out; one dropped without a reason comes back ---
{
  const answer = `${factory}\n${DROPPED_MARKER}\n- **Pitfall — \`kanban_show\`/\`kanban_comment\` IGNORE the \`board\` argument (observed 2026-10-02):** :: the factory kanban tools now take the board\n- Pitfall — mail_handoff_track_task returns unknown action\n`;
  const { skill, dropped } = parseMergeAnswer(answer);
  assert.equal(skill, factory.trim());
  assert.equal(dropped.length, 2);
  const kept = keepBoxPitfalls({ box, merged: skill, dropped });
  assert.deepEqual(kept.droppedWithReason.map((d) => d.reason), ["the factory kanban tools now take the board"]);
  assert.equal(kept.restored.length, 2, "a drop without a reason does not count");
}

// --- Answers without the marker, with "none", and in a code fence ---
{
  assert.deepEqual(parseMergeAnswer(factory), { skill: factory.trim(), dropped: [] });
  assert.deepEqual(parseMergeAnswer(`${factory}\n${DROPPED_MARKER}\n- none\n`).dropped, []);
  const fenced = parseMergeAnswer(`\`\`\`markdown\n${factory}\`\`\`\n${DROPPED_MARKER}\n- none`);
  assert.equal(fenced.skill, factory.trim());
}

// --- Box pitfalls go under an existing kept heading, before the next section ---
{
  const merged = `${factory}\n${KEPT_HEADING}\n\nIntro.\n\n${P_BOARD}\n\n## Channels\n\nText.\n`;
  const kept = keepBoxPitfalls({ box, merged, dropped: [] });
  assert.equal(kept.restored.length, 2);
  assert.equal(kept.text.split(KEPT_HEADING).length, 2, "one kept heading");
  const section = kept.text.slice(kept.text.indexOf(KEPT_HEADING), kept.text.indexOf("## Channels"));
  assert.ok(section.includes("mail_list_track_tasks") && section.includes("mail_handoff_track_task"));
  assert.ok(kept.text.trimEnd().endsWith("Text."));
}

// --- The merge script keeps the box pitfalls that the model left out ---
{
  const dir = mkdtempSync(join(tmpdir(), "joshu-skill-merge-"));
  try {
    const answer = `${factory}\n${DROPPED_MARKER}\n- Pitfall — \`kanban_show\`/\`kanban_comment\` IGNORE the \`board\` argument (observed 2026-10-02): :: the factory kanban tools now take the board\n`;
    writeFileSync(join(dir, "factory.md"), factory);
    writeFileSync(join(dir, "box.md"), box);
    const fakeFetch = join(dir, "fake-fetch.mjs");
    writeFileSync(
      fakeFetch,
      `globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: ${JSON.stringify(answer)} } }] }) });\n`,
    );
    const run = spawnSync(
      process.execPath,
      ["--import", fakeFetch, join(scriptsDir, "merge-hermes-factory-skill.mjs"), "--factory", join(dir, "factory.md"), "--box", join(dir, "box.md"), "--out", join(dir, "out.md")],
      { encoding: "utf8", env: { ...process.env, OPENROUTER_API_KEY: "test" } },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), "merged");
    const out = readFileSync(join(dir, "out.md"), "utf8");
    assert.ok(!out.includes(DROPPED_MARKER), "the marker is not written to the box skill");
    assert.ok(out.includes("2. New factory step."));
    const [board, ...others] = findBoxPitfalls(box);
    assert.ok(!out.includes(board.text), "the box pitfall dropped with a reason stays out");
    for (const p of others) assert.ok(out.includes(p.text));
    assert.equal((run.stderr.match(/kept box pitfall/g) ?? []).length, 2, run.stderr);
    assert.match(run.stderr, /kept box pitfall "Pitfall — `mail_list_track_tasks/, "the log names the bold title");
    assert.match(run.stderr, /merge dropped box pitfall .*: the factory kanban tools now take the board/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("test-skill-merge-pitfalls: ok");
