// Self-host blocks and hosted-only blocks of the user's manual (docs/user-manual/).
// checkMarkers() checks the marker lines, and renderOss() returns the OSS rendering: the text
// of each self-host block without its marker lines, and no hosted-only block.
// Used by scripts/render-oss-manual.mjs. The docs sync of db-aeon/joshu-public checks the
// markers with the same rules (scripts/lib/docs-sync.mjs there), so change both together.
// See docs/technical-reference/public-docs.md.

const MARKER_RE = /<!--\s*(\/?)(self-host|hosted-only)\s*-->/;
const MARKER_LINE_RE = /^<!--\s*(\/?)(self-host|hosted-only)\s*-->$/;
const FENCE_RE = /^\s{0,3}(```|~~~)/;

/**
 * Walk the lines of a text. Returns the marker problems, and for each line its marker
 * ({ closing, kind }) or null and the block it is in ("self-host", "hosted-only", or null).
 */
function scan(text, file) {
  const problems = [];
  const lines = text.split("\n");
  const info = [];
  let open = null;
  let inFence = false;
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      info.push({ marker: null, block: open?.kind ?? null });
      return;
    }
    if (inFence || !MARKER_RE.test(line)) {
      info.push({ marker: null, block: open?.kind ?? null });
      return;
    }
    const match = line.trim().match(MARKER_LINE_RE);
    if (!match) {
      problems.push(`${file}:${lineNo}: a block marker must be on its own line`);
      info.push({ marker: null, block: open?.kind ?? null });
      return;
    }
    const [, closing, kind] = match;
    if (!closing) {
      if (open) {
        problems.push(
          `${file}:${lineNo}: "${kind}" block starts inside the "${open.kind}" block from line ${open.lineNo}, and blocks cannot be nested`,
        );
      } else {
        open = { kind, lineNo };
      }
    } else if (!open) {
      problems.push(`${file}:${lineNo}: "/${kind}" closes a block that was never opened`);
    } else if (open.kind !== kind) {
      problems.push(`${file}:${lineNo}: "/${kind}" does not match the "${open.kind}" block from line ${open.lineNo}`);
    } else {
      open = null;
    }
    info.push({ marker: { closing: Boolean(closing), kind }, block: open?.kind ?? kind });
  });
  if (open) problems.push(`${file}:${open.lineNo}: "${open.kind}" block is never closed`);
  return { lines, info, problems };
}

/** Marker problems of a text, each as "<file>:<line>: <problem>". */
export function checkMarkers(text, file = "<text>") {
  return scan(text, file).problems;
}

/**
 * The lines of a text that the OSS rendering keeps, each as { lineNo, line } with its line
 * number in the source. Returns [] when a marker breaks a rule (see checkMarkers()).
 */
export function ossLines(text, file = "<text>") {
  const { lines, info, problems } = scan(text, file);
  if (problems.length) return [];
  return lines
    .map((line, index) => ({ lineNo: index + 1, line, ...info[index] }))
    .filter(({ marker, block }) => !marker && block !== "hosted-only")
    .map(({ lineNo, line }) => ({ lineNo, line }));
}

/**
 * The OSS rendering of a text: { text, problems }. Where a dropped line leaves two or more
 * blank lines in a row, one blank line stays, and blank lines that a drop leaves at the start
 * or the end of the text go. Blank lines away from a drop stay as they are.
 */
export function renderOss(text, file = "<text>") {
  const { lines, info, problems } = scan(text, file);
  if (problems.length) return { text, problems };

  const trailingNewline = lines.at(-1) === "";
  const count = trailingNewline ? lines.length - 1 : lines.length;
  const out = [];
  // cuts holds each index of out where a dropped line was, before out[index].
  const cuts = new Set();
  for (let i = 0; i < count; i += 1) {
    const { marker, block } = info[i];
    if (marker || block === "hosted-only") {
      cuts.add(out.length);
      continue;
    }
    out.push(lines[i]);
  }
  if (!cuts.size) return { text, problems };

  const blank = (line) => line.trim() === "";
  const kept = [];
  let i = 0;
  while (i <= out.length) {
    if (i < out.length && !blank(out[i])) {
      kept.push(out[i]);
      i += 1;
      continue;
    }
    // A run of blank lines from start to end (end exclusive); a cut can sit at start..end.
    const start = i;
    while (i < out.length && blank(out[i])) i += 1;
    const end = i;
    const run = out.slice(start, end);
    let touched = false;
    for (let at = start; at <= end; at += 1) if (cuts.has(at)) touched = true;
    if (touched && (start === 0 || end === out.length)) {
      // Drop the blank lines that a drop left at the start or the end of the text.
    } else if (touched && run.length > 1) {
      kept.push(run[0]);
    } else {
      kept.push(...run);
    }
    if (end === out.length) break;
  }
  return { text: kept.join("\n") + (trailingNewline ? "\n" : ""), problems };
}
