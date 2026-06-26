#!/usr/bin/env node
/**
 * Idempotently patch Hermes tools/browser_camofox.py so _adopt_existing_tab always
 * re-binds to Camofox's authoritative tab list (not only when tab_id is empty).
 *
 * HITL requires the noVNC view and Hermes browser tools to share one tab. Hermes
 * previously cached tab_id after first adoption, so Joshu tab cleanup or manual
 * navigation could leave Hermes operating on a stale or closed tab.
 */
import { readFileSync, writeFileSync } from "node:fs";

const target = process.argv[2];
if (!target) {
  console.error("usage: patch-hermes-camofox-tab-resync.mjs <path/to/browser_camofox.py>");
  process.exit(1);
}

const RESYNC_MARKER = "hitl_resync_authoritative_tab";

const resyncFunction = `def _adopt_existing_tab(session: Dict[str, Any]) -> Dict[str, Any]:
    """Attach process-local state to the authoritative Camofox tab (${RESYNC_MARKER}).

    HITL integrations own the visible browser. Re-bind tab_id from Camofox on every
    lookup so Hermes stays aligned with the noVNC tab after manual navigation,
    Joshu tab cleanup, or gateway restarts.
    """
    if not session.get("adopt_existing_tab"):
        return session

    if not get_camofox_url():
        return session

    previous_tab_id = session.get("tab_id")

    try:
        tabs = _get("/tabs", params={"userId": session["user_id"]}, timeout=5).get("tabs", [])
    except Exception as exc:
        logger.debug("Camofox tab adoption failed for %s: %s", session.get("user_id"), exc)
        return session

    if not isinstance(tabs, list) or not tabs:
        session["tab_id"] = None
        return session

    session_key = session.get("session_key")
    matching_tabs = [
        tab
        for tab in tabs
        if isinstance(tab, dict) and tab.get("listItemId") == session_key
    ]
    candidates = matching_tabs or [tab for tab in tabs if isinstance(tab, dict)]
    latest = candidates[-1] if candidates else None
    tab_id = latest.get("tabId") if isinstance(latest, dict) else None
    if isinstance(tab_id, str) and tab_id:
        session["tab_id"] = tab_id
        if tab_id != previous_tab_id:
            logger.debug(
                "Re-adopted Camofox tab %s (was %s) for %s",
                tab_id,
                previous_tab_id,
                session.get("user_id"),
            )
    else:
        session["tab_id"] = None

    return session
`;

let source = readFileSync(target, "utf8");

if (source.includes(RESYNC_MARKER)) {
  console.log("[hermes-patch] Camofox tab resync already applied.");
  process.exit(0);
}

if (!source.includes("def _adopt_existing_tab(")) {
  console.error(`[hermes-patch] _adopt_existing_tab() not found in ${target}`);
  process.exit(1);
}

const fnRe = /def _adopt_existing_tab\(session: Dict\[str, Any\]\) -> Dict\[str, Any\]:[\s\S]*?\n\n(?=def _get_session\()/;
if (!fnRe.test(source)) {
  console.error(`[hermes-patch] could not locate _adopt_existing_tab() block in ${target}`);
  process.exit(1);
}

source = source.replace(fnRe, `${resyncFunction}\n\n`);
writeFileSync(target, source);
console.log("[hermes-patch] applied Camofox tab resync patch — restart Hermes gateway");
