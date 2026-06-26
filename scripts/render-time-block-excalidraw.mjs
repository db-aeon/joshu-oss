#!/usr/bin/env node
/**
 * Render Cal Newport-style time-block plan JSON to a .excalidraw file.
 *
 * Usage:
 *   node scripts/render-time-block-excalidraw.mjs plan.json -o Planning/time-block-2026-06-17.excalidraw
 *   node scripts/render-time-block-excalidraw.mjs plan.json --stdout
 *
 * Plan shape: see integrations/hermes/skills/executive-assistant/ea-time-block/SKILL.md
 */
import fs from "node:fs";
import path from "node:path";

const KIND_COLORS = {
  meeting: { fill: "#d0bfff", stroke: "#7048e8" },
  deep_work: { fill: "#a5d8ff", stroke: "#1971c2" },
  shallow: { fill: "#ffd8a8", stroke: "#e67700" },
  personal: { fill: "#b2f2bb", stroke: "#2f9e44" },
  break: { fill: "#fff3bf", stroke: "#f08c00" },
  buffer: { fill: "#e9ecef", stroke: "#868e96" },
  default: { fill: "#e7f5ff", stroke: "#1c7ed6" },
};

function parseArgs(argv) {
  const args = { input: null, output: null, stdout: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stdout") args.stdout = true;
    else if (a === "-o" && argv[i + 1]) args.output = argv[++i];
    else if (!a.startsWith("-") && !args.input) args.input = a;
    else throw new Error(`Unknown arg: ${a}`);
  }
  if (!args.input) throw new Error("Missing plan.json path");
  if (!args.stdout && !args.output) throw new Error("Provide -o <path> or --stdout");
  return args;
}

function parseTimeToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!m) throw new Error(`Invalid time: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

function minutesToLabel(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function linkToUrl(link) {
  if (!link) return null;
  if (typeof link === "string") {
    if (link.startsWith("joshu://")) return link;
    return `joshu://${link.replace(/^\/+/, "")}`;
  }
  if (link.url) return String(link.url);
  if (link.path) {
    const p = String(link.path).replace(/^\/+/, "");
    return `joshu://${p}`;
  }
  return null;
}

let seedCounter = 1;
function nextSeed() {
  return seedCounter++;
}

function baseElement(type, id, x, y, width, height, extra = {}) {
  const now = Date.now();
  return {
    type,
    id,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: extra.strokeColor ?? "#1e1e1e",
    backgroundColor: extra.backgroundColor ?? "transparent",
    fillStyle: extra.fillStyle ?? "solid",
    strokeWidth: extra.strokeWidth ?? 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    roundness: extra.roundness ?? { type: 3 },
    seed: nextSeed(),
    version: 1,
    versionNonce: Math.floor(Math.random() * 1_000_000_000),
    updated: now,
    isDeleted: false,
    locked: false,
    groupIds: [],
    frameId: null,
    boundElements: extra.boundElements ?? null,
    link: extra.link ?? null,
    ...extra,
  };
}

function textElement(id, x, y, width, height, text, opts = {}) {
  const { fontSize, textAlign, verticalAlign, strokeColor, containerId, link, ...rest } = opts;
  return baseElement("text", id, x, y, width, height, {
    text,
    originalText: text,
    fontSize: fontSize ?? 16,
    fontFamily: 1,
    textAlign: textAlign ?? "left",
    verticalAlign: verticalAlign ?? "top",
    strokeColor: strokeColor ?? "#1e1e1e",
    autoResize: true,
    containerId: containerId ?? null,
    lineHeight: 1.25,
    link: link ?? null,
    ...rest,
  });
}

function labeledRect(id, x, y, width, height, label, style, link) {
  const textId = `t_${id}`;
  const rect = baseElement("rectangle", id, x, y, width, height, {
    backgroundColor: style.fill,
    strokeColor: style.stroke,
    fillStyle: "solid",
    boundElements: [{ id: textId, type: "text" }],
    link,
  });
  const labelText = textElement(textId, x + 8, y + 8, width - 16, height - 16, label, {
    fontSize: 14,
    containerId: id,
    textAlign: "center",
    verticalAlign: "middle",
  });
  return [rect, labelText];
}

function renderPlan(plan) {
  const workStart = parseTimeToMinutes(plan.workHours?.start ?? "09:00");
  const workEnd = parseTimeToMinutes(plan.workHours?.end ?? "17:00");
  const pxPerMin = 1.2;
  const gridLeft = 120;
  const gridWidth = 360;
  const notesLeft = gridLeft + gridWidth + 60;
  const notesWidth = 280;

  const elements = [];
  const title = plan.title ?? `Time block — ${plan.date ?? "today"}`;
  elements.push(
    textElement("title", gridLeft, 20, 600, 40, title, { fontSize: 24, textAlign: "left" }),
  );

  const yesterdayLink = linkToUrl(plan.yesterdayPlan?.path ?? plan.yesterdayPlan);
  if (yesterdayLink) {
    elements.push(
      textElement(
        "yesterday_link",
        gridLeft,
        68,
        700,
        18,
        `← Yesterday: ${plan.yesterdayPlan?.label ?? plan.yesterdayPlan?.date ?? "prior plan"}`,
        { fontSize: 13, strokeColor: "#495057", link: yesterdayLink },
      ),
    );
  }

  const gridTop = yesterdayLink ? 96 : 68;
  const gridHeight = Math.max(60, (workEnd - workStart) * pxPerMin);

  // Hour grid lines + labels
  for (let min = workStart; min <= workEnd; min += 60) {
    const y = gridTop + (min - workStart) * pxPerMin;
    elements.push(
      baseElement("rectangle", `grid_${min}`, gridLeft, y, gridWidth, 1, {
        height: 2,
        backgroundColor: "#dee2e6",
        fillStyle: "solid",
        strokeColor: "#dee2e6",
        roundness: null,
      }),
    );
    elements.push(
      textElement(`hour_${min}`, gridLeft - 110, y - 8, 100, 20, minutesToLabel(min), {
        fontSize: 14,
        textAlign: "right",
      }),
    );
  }

  // Background column zones
  elements.unshift(
    baseElement("rectangle", "grid_bg", gridLeft, gridTop, gridWidth, gridHeight, {
      backgroundColor: "#f8f9fa",
      fillStyle: "solid",
      strokeColor: "#ced4da",
      link: null,
    }),
  );
  elements.push(
    baseElement("rectangle", "notes_bg", notesLeft, gridTop, notesWidth, gridHeight, {
      backgroundColor: "#fff9db",
      fillStyle: "solid",
      strokeColor: "#ffe066",
      link: null,
    }),
  );
  elements.push(
    textElement("notes_title", notesLeft + 12, gridTop + 8, notesWidth - 24, 24, "Notes / capture", {
      fontSize: 18,
    }),
  );

  let noteY = gridTop + 40;

  const carryover = Array.isArray(plan.carryover) ? plan.carryover : [];
  if (carryover.length > 0) {
    elements.push(
      textElement("carryover_heading", notesLeft + 12, noteY, notesWidth - 24, 20, "From yesterday ☐", {
        fontSize: 16,
        strokeColor: "#495057",
      }),
    );
    noteY += 26;
    for (let ci = 0; ci < carryover.length; ci++) {
      const item = carryover[ci];
      const text = typeof item === "string" ? item : item?.text ?? "";
      const done = typeof item === "object" && item?.done === true;
      const prefix = done ? "☑" : "☐";
      const itemLink = linkToUrl(typeof item === "object" ? item?.link : null);
      const line = `${prefix} ${text}`;
      const h = 22;
      if (itemLink) {
        const [rect, txt] = labeledRect(
          `co_${ci}`,
          notesLeft + 8,
          noteY,
          notesWidth - 16,
          h,
          line,
          { fill: "#ffe3e3", stroke: "#fa5252" },
          itemLink,
        );
        elements.push(rect, txt);
      } else {
        elements.push(
          textElement(`co_${ci}`, notesLeft + 16, noteY, notesWidth - 32, h, line, { fontSize: 14 }),
        );
      }
      noteY += h + 4;
    }
    noteY += 8;
  }

  const taskGroups = Array.isArray(plan.taskGroups) ? plan.taskGroups : [];
  if (taskGroups.length > 0) {
    elements.push(
      textElement("task_groups_heading", notesLeft + 12, noteY, notesWidth - 24, 20, "Task groups", {
        fontSize: 16,
        strokeColor: "#495057",
      }),
    );
    noteY += 26;
    for (let gi = 0; gi < taskGroups.length; gi++) {
      const group = taskGroups[gi];
      const refLabel = group.label ?? group.ref ?? String(gi + 1);
      elements.push(
        textElement(`tg_title_${gi}`, notesLeft + 12, noteY, notesWidth - 24, 20, String(refLabel), {
          fontSize: 15,
        }),
      );
      noteY += 22;
      const items = Array.isArray(group.items) ? group.items : [];
      for (let ii = 0; ii < items.length; ii++) {
        const item = items[ii];
        const text = typeof item === "string" ? item : item?.text ?? "";
        const itemLink = linkToUrl(typeof item === "object" ? item?.link : null);
        const line = `- ${text}`;
        const h = 22;
        if (itemLink) {
          const [rect, txt] = labeledRect(
            `tg_${gi}_${ii}`,
            notesLeft + 8,
            noteY,
            notesWidth - 16,
            h,
            line,
            { fill: "#fff3bf", stroke: "#fab005" },
            itemLink,
          );
          elements.push(rect, txt);
        } else {
          elements.push(
            textElement(`tg_${gi}_${ii}`, notesLeft + 16, noteY, notesWidth - 32, h, line, { fontSize: 14 }),
          );
        }
        noteY += h + 4;
      }
      noteY += 8;
    }
    noteY += 4;
    elements.push(
      textElement("notes_subheading", notesLeft + 12, noteY, notesWidth - 24, 20, "Capture", {
        fontSize: 14,
        strokeColor: "#868e96",
      }),
    );
    noteY += 22;
  }

  const blocks = Array.isArray(plan.blocks) ? plan.blocks : [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const start = parseTimeToMinutes(block.start);
    const end = parseTimeToMinutes(block.end);
    const y = gridTop + (start - workStart) * pxPerMin;
    const h = Math.max(24, (end - start) * pxPerMin);
    const kind = block.kind ?? "default";
    const style = KIND_COLORS[kind] ?? KIND_COLORS.default;
    const link = linkToUrl(block.link);
    let label = block.label ?? "Block";
    if (block.blockRef && !label.includes(String(block.blockRef))) {
      const group = taskGroups.find((g) => String(g.ref) === String(block.blockRef));
      const suffix = group?.label ?? block.blockRef;
      label = `${label} ${suffix}`.trim();
    }
    const [rect, txt] = labeledRect(`block_${i}`, gridLeft + 4, y + 2, gridWidth - 8, h - 4, label, style, link);
    elements.push(rect, txt);
  }

  const notes = Array.isArray(plan.notes) ? plan.notes : [];
  for (let i = 0; i < notes.length; i++) {
    const line = String(notes[i]);
    const noteLink = linkToUrl(plan.noteLinks?.[i]);
    const h = 22;
    if (noteLink) {
      const [rect, txt] = labeledRect(
        `note_${i}`,
        notesLeft + 8,
        noteY,
        notesWidth - 16,
        h,
        `• ${line}`,
        { fill: "#fff3bf", stroke: "#fab005" },
        noteLink,
      );
      elements.push(rect, txt);
    } else {
      elements.push(
        textElement(`note_${i}`, notesLeft + 12, noteY, notesWidth - 24, h, `• ${line}`, { fontSize: 14 }),
      );
    }
    noteY += h + 6;
  }

  return {
    type: "excalidraw",
    version: 2,
    source: "joshu-ea-time-block",
    elements,
    appState: {
      viewBackgroundColor: "#ffffff",
      gridSize: 20,
    },
    files: {},
  };
}

function main() {
  const args = parseArgs(process.argv);
  const raw = fs.readFileSync(path.resolve(args.input), "utf8");
  const plan = JSON.parse(raw);
  const doc = renderPlan(plan);
  const out = `${JSON.stringify(doc, null, 2)}\n`;

  if (args.stdout) {
    process.stdout.write(out);
    return;
  }

  const outPath = path.resolve(args.output);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, out, "utf8");
  console.log(`[render-time-block-excalidraw] wrote ${outPath} (${doc.elements.length} elements)`);
}

main();
