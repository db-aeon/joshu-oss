#!/usr/bin/env node
/** CLI: stage Desktop git tree before gbrain boot sync. */
import { stageDesktopForGbrainSync } from "./gbrain-desktop-git.mjs";

const desktopRoot = process.argv[2]?.trim();
if (!desktopRoot) {
  console.error("usage: run-stage-desktop-git.mjs <JOSHU_DESKTOP_ROOT>");
  process.exit(1);
}

const result = await stageDesktopForGbrainSync(desktopRoot);
if (!result.ok) {
  console.error(`[gbrain-desktop-git] ${result.error ?? "failed"}`);
  process.exit(1);
}
if (result.committed) {
  console.log(`[gbrain-desktop-git] committed changes under ${desktopRoot}`);
} else {
  console.log(`[gbrain-desktop-git] no staged changes under ${desktopRoot}`);
}
