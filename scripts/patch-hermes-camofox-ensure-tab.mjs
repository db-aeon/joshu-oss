#!/usr/bin/env node
/**
 * Idempotently guard Hermes _ensure_tab() so HITL never POST /tabs when Camofox
 * already has a page for the shared user — that closes the visible tab and loads
 * CAMOFOX_START_URL (classic "Hermes reset my browser" desync).
 */
import { readFileSync, writeFileSync } from "node:fs";

const target = process.argv[2];
if (!target) {
  console.error("usage: patch-hermes-camofox-ensure-tab.mjs <path/to/browser_camofox.py>");
  process.exit(1);
}

const MARKER = "hitl_ensure_tab_guard";

const guardBlock = `    # HITL: never POST /tabs if Camofox already has a visible tab (${MARKER}).
    # Tab creation closes existing pages and resets to CAMOFOX_START_URL.
    if session.get("adopt_existing_tab") and get_camofox_url():
        session = _adopt_existing_tab(session)
        if session["tab_id"]:
            return session
`;

let source = readFileSync(target, "utf8");

if (source.includes(MARKER)) {
  console.log("[hermes-patch] Camofox ensure-tab guard already applied.");
  process.exit(0);
}

const needle = `def _ensure_tab(task_id: Optional[str], url: str = "about:blank") -> Dict[str, Any]:
    """Ensure a tab exists for the session, creating one if needed."""
    session = _get_session(task_id)
    if session["tab_id"]:
        return session
    base = get_camofox_url()`;

const replacement = `def _ensure_tab(task_id: Optional[str], url: str = "about:blank") -> Dict[str, Any]:
    """Ensure a tab exists for the session, creating one if needed."""
    session = _get_session(task_id)
    if session["tab_id"]:
        return session
${guardBlock}    base = get_camofox_url()`;

if (!source.includes(needle)) {
  console.error(`[hermes-patch] _ensure_tab() guard insertion point not found in ${target}`);
  process.exit(1);
}

source = source.replace(needle, replacement);
writeFileSync(target, source);
console.log("[hermes-patch] applied Camofox ensure-tab guard — restart Hermes gateway");
