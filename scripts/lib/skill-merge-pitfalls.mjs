/**
 * Box pitfalls in the LLM merge of the skills seed (merge-hermes-factory-skill.mjs).
 *
 * A box pitfall is a paragraph of a box skill that starts with "**Pitfall". The LLM merge
 * must keep each box pitfall, or name it in the list of dropped box pitfalls with a reason.
 * keepBoxPitfalls adds each box pitfall back that the merge left out without a reason.
 * Spec: openspec/changes/skills-seed-keep-pitfalls/specs/hermes-skills-seed/spec.md
 */

/** The line between the merged SKILL.md and the list of dropped box pitfalls. */
export const DROPPED_MARKER = "=== DROPPED BOX PITFALLS ===";

/** The heading under which keepBoxPitfalls adds the box pitfalls back. */
export const KEPT_HEADING = "## Pitfalls kept from this box";

const PITFALL_START = /^(?:>\s*)?(?:[-*]\s+|\d+\.\s+)?\*\*Pitfall\b/i;

/** Lowercase words only, so a key survives changes of quotes, backticks, and spaces. */
export function normalizeForMatch(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The bold title of a box pitfall ("**Pitfall — x**: ..." gives "pitfall x"). A title that is
 * only "Pitfall" names nothing, so the key is then the first 80 characters of the paragraph.
 */
function pitfallKey(paragraph) {
  const bold = paragraph.match(/\*\*(.+?)\*\*/);
  const title = normalizeForMatch(bold ? bold[1] : "");
  if (title.split(" ").length >= 2) return title;
  return normalizeForMatch(paragraph.replace(/\*\*/g, "")).slice(0, 80).trim();
}

/**
 * The box pitfalls of a SKILL.md, in file order. A box pitfall runs from its first line to the
 * next blank line, heading, table row, or start of another box pitfall.
 * @returns {{ key: string, text: string }[]}
 */
export function findBoxPitfalls(skillText) {
  const lines = skillText.split("\n");
  const pitfalls = [];
  let current = null;
  const close = () => {
    if (current) pitfalls.push({ key: pitfallKey(current.join("\n")), text: current.join("\n") });
    current = null;
  };
  for (const line of lines) {
    if (PITFALL_START.test(line)) {
      close();
      current = [line];
    } else if (current && line.trim() && !/^(#|\|)/.test(line)) {
      current.push(line);
    } else {
      close();
    }
  }
  close();
  return pitfalls.filter((p) => p.key);
}

/**
 * Split the answer of the LLM merge into the merged SKILL.md and the dropped box pitfalls.
 * Without the marker line, the list is empty, so keepBoxPitfalls adds back each left-out box pitfall.
 * @returns {{ skill: string, dropped: { key: string, title: string, reason: string }[] }}
 */
export function parseMergeAnswer(answer) {
  const at = answer.indexOf(DROPPED_MARKER);
  const skill = at === -1 ? answer : answer.slice(0, at);
  const list = at === -1 ? "" : answer.slice(at + DROPPED_MARKER.length);
  const dropped = [];
  for (const raw of list.split("\n")) {
    const line = raw.replace(/^\s*[-*]\s*/, "").trim();
    if (!line || /^none\.?$/i.test(line)) continue;
    const sep = line.indexOf("::");
    const title = (sep === -1 ? line : line.slice(0, sep)).trim();
    const reason = sep === -1 ? "" : line.slice(sep + 2).trim();
    const key = normalizeForMatch(title.replace(/\*\*/g, ""));
    if (key) dropped.push({ key, title, reason });
  }
  return { skill: stripFence(skill.trim()), dropped };
}

function stripFence(text) {
  if (!text.startsWith("```")) return text;
  return text.replace(/^```(?:markdown|md)?\s*/i, "").replace(/\s*```$/, "");
}

function keysMatch(a, b) {
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Add back each box pitfall that the merged SKILL.md does not have and that the LLM merge
 * did not drop with a reason. A box pitfall counts as kept when its bold title is in the merged text.
 * @returns {{ text: string, restored: { key: string, text: string }[], droppedWithReason: { key: string, title: string, reason: string }[] }}
 */
export function keepBoxPitfalls({ box, merged, dropped }) {
  const mergedNorm = normalizeForMatch(merged);
  const droppedWithReason = [];
  const restored = [];
  for (const pitfall of findBoxPitfalls(box)) {
    if (mergedNorm.includes(pitfall.key)) continue;
    const drop = dropped.find((d) => d.reason && keysMatch(d.key, pitfall.key));
    if (drop) droppedWithReason.push(drop);
    else restored.push(pitfall);
  }
  if (restored.length === 0) return { text: merged, restored, droppedWithReason };
  return { text: appendUnderKeptHeading(merged, restored.map((p) => p.text)), restored, droppedWithReason };
}

const MERGE_INTRO =
  "The skills seed kept these pitfalls of this box, because the merge with a factory update left them out without a reason.";
const SPLIT_INTRO =
  "The skills seed moved these pitfalls of this box here from the box copy of the skill that this skill was split from.";

/** The text of each heading line ("## Mail ingress" gives "mail ingress"), for matching. */
function headingKeys(skillText) {
  return new Set(
    skillText
      .split("\n")
      .filter((line) => /^#{1,6}\s/.test(line))
      .map((line) => normalizeForMatch(line.replace(/^#+\s*/, "")))
      .filter(Boolean),
  );
}

/**
 * Move the box pitfalls of a split skill (change mail-worker-skills). A new factory skill can
 * name the skill it was split from (metadata.joshu.split_from). When the skills seed first adds
 * the new skill to a box, each box pitfall of the old box skill whose heading is also a heading
 * of the new skill goes to the new skill, unless the new skill already has it.
 * @returns {{ text: string, moved: { key: string, text: string }[] }}
 */
export function moveSplitPitfalls({ source, target }) {
  const targetHeadings = headingKeys(target);
  const targetNorm = normalizeForMatch(target);
  const moved = [];
  let heading = "";
  let section = [];
  const flush = () => {
    if (targetHeadings.has(heading)) {
      for (const pitfall of findBoxPitfalls(section.join("\n"))) {
        if (!targetNorm.includes(pitfall.key) && !moved.some((p) => p.key === pitfall.key)) moved.push(pitfall);
      }
    }
    section = [];
  };
  for (const line of source.split("\n")) {
    if (/^#{1,6}\s/.test(line)) {
      flush();
      heading = normalizeForMatch(line.replace(/^#+\s*/, ""));
    } else {
      section.push(line);
    }
  }
  flush();
  if (moved.length === 0) return { text: target, moved };
  return { text: appendUnderKeptHeading(target, moved.map((p) => p.text), SPLIT_INTRO), moved };
}

function appendUnderKeptHeading(merged, paragraphs, intro = MERGE_INTRO) {
  const body = paragraphs.join("\n\n");
  const lines = merged.replace(/\s+$/, "").split("\n");
  const head = lines.indexOf(KEPT_HEADING);
  if (head === -1) {
    return `${lines.join("\n")}\n\n${KEPT_HEADING}\n\n${intro}\n\n${body}\n`;
  }
  let end = lines.length;
  for (let i = head + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const before = lines.slice(0, end).join("\n").replace(/\s+$/, "");
  const after = lines.slice(end).join("\n");
  return `${before}\n\n${body}\n${after ? `\n${after}\n` : ""}`;
}
