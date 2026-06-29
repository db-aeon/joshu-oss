import React from "react";

/** Kare-style 16×16 pixel icons; `shapeRendering` keeps edges crisp when scaled. */
const px = { shapeRendering: "crispEdges" as const };

function rects(coords: string, fill = "currentColor"): React.ReactNode {
  return coords.split(/\s+/).map((pair, i) => {
    const [xs, ys] = pair.split(",").map(Number);
    return <rect key={i} x={xs} y={ys} width={1} height={1} fill={fill} />;
  });
}

function IconFrame({ children }: { children: React.ReactNode }) {
  return (
    <svg width={20} height={20} viewBox="0 0 16 16" aria-hidden {...px}>
      {children}
    </svg>
  );
}

function GearIcon() {
  const c =
    "7,2 8,2 9,2 6,3 10,3 5,4 11,4 4,5 12,5 4,6 12,6 4,7 12,7 4,8 12,8 4,9 12,9 4,10 12,10 5,11 11,11 6,12 10,12 7,13 8,13 9,13";
  return <IconFrame>{rects(c)}</IconFrame>;
}

function GlobeIcon() {
  const c =
    "7,1 8,1 5,2 10,2 4,3 11,3 3,4 12,4 2,5 13,5 2,6 13,6 1,7 14,7 1,8 14,8 1,9 14,9 2,10 13,10 2,11 13,11 3,12 12,12 4,13 11,13 5,14 10,14 7,15 8,15";
  return <IconFrame>{rects(c)}</IconFrame>;
}

function FolderIcon() {
  const tab = "2,3 3,3 4,3 5,3 6,3";
  const body =
    "1,4 2,4 3,4 4,4 5,4 6,4 7,4 8,4 9,4 10,4 11,4 12,4 13,4 14,4 1,5 14,5 1,6 14,6 1,7 14,7 1,8 14,8 1,9 14,9 1,10 14,10 1,11 14,11 1,12 14,12 1,13 14,13";
  return (
    <IconFrame>
      {rects(tab)}
      {rects(body)}
    </IconFrame>
  );
}

function TerminalIcon() {
  const frame =
    "2,2 3,2 4,2 5,2 6,2 7,2 8,2 9,2 10,2 11,2 12,2 13,2 2,3 13,3 2,4 13,4 2,5 13,5 2,6 13,6 2,7 13,7 2,8 13,8 2,9 13,9 2,10 13,10 2,11 13,11 2,12 13,12 2,13 3,13 4,13 5,13 6,13 7,13 8,13 9,13 10,13 11,13 12,13 13,13";
  const prompt = "4,5 5,5 6,5 4,7 5,7 6,7 7,7 4,9 5,9";
  return (
    <IconFrame>
      {rects(frame)}
      {rects(prompt, "var(--color-action, #0057ff)")}
    </IconFrame>
  );
}

function WrenchIcon() {
  const c =
    "11,1 12,1 13,2 13,3 12,4 11,5 10,6 9,7 8,8 7,9 6,10 5,11 4,12 3,13 2,13 1,12 1,11 2,10 3,9 4,8 5,7 6,6 7,5 8,4 9,3 10,2";
  return <IconFrame>{rects(c)}</IconFrame>;
}

function PencilIcon() {
  const c =
    "11,1 12,2 13,3 12,4 11,5 10,6 9,7 8,8 7,9 6,10 5,11 4,12 3,13 2,12 1,11 2,10 3,9 4,8 5,7 6,6 7,5 8,4 9,3 10,2";
  return <IconFrame>{rects(c)}</IconFrame>;
}

export type ToolGlyphKind = "gear" | "globe" | "folder" | "terminal" | "wrench" | "pencil";

export function glyphKindForTool(tool: string, emoji?: string): ToolGlyphKind {
  const hay = `${tool}\n${emoji ?? ""}`.toLowerCase();
  if (/http|url|web|browse|fetch|navigate|playwright|puppet|camofox|vnc|click/i.test(hay)) return "globe";
  if (/read_file|write|edit|patch|apply_patch|search_replace|notebook/i.test(hay)) return "pencil";
  if (/run_terminal|bash|shell|exec|command|subprocess/i.test(hay)) return "terminal";
  if (/folder|list_dir|glob_file|workspace|path/i.test(hay)) return "folder";
  if (/install|build|npm|pip|make|compile/i.test(hay)) return "wrench";
  return "gear";
}

export function ToolPixelIcon({ tool, emoji }: { tool: string; emoji?: string }) {
  const kind = glyphKindForTool(tool, emoji);
  switch (kind) {
    case "globe":
      return <GlobeIcon />;
    case "folder":
      return <FolderIcon />;
    case "terminal":
      return <TerminalIcon />;
    case "wrench":
      return <WrenchIcon />;
    case "pencil":
      return <PencilIcon />;
    default:
      return <GearIcon />;
  }
}
