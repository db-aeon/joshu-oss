#!/usr/bin/env node
/**
 * Idempotently patch Hermes tools/browser_camofox.py to call Joshu action guard
 * before browser writes (click, type, press).
 */
import { readFileSync, writeFileSync } from "node:fs";

const target = process.argv[2];
if (!target) {
  console.error("usage: patch-hermes-camofox-action-guard.mjs <path/to/browser_camofox.py>");
  process.exit(1);
}

const MARKER = "hitl_action_guard";

const helperBlock = `
def _joshu_action_guard_base() -> str:
    return (
        os.getenv("JOSHU_CONNECTORS_API_BASE", "http://127.0.0.1:8788/joshu")
        .strip()
        .rstrip("/")
    )


def _joshu_browser_guard_enabled() -> bool:
    return os.getenv("JOSHU_ACTION_GUARD_BROWSER_GATE", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _joshu_action_guard_browser(kind: str, args: Dict[str, Any]) -> Optional[str]:
    \"\"\"Return a tool_error JSON string when the owner denied or timed out (${MARKER}).\"\"\"
    if not _joshu_browser_guard_enabled():
        return None
    base = _joshu_action_guard_base()
    try:
        resp = requests.post(
            f"{base}/api/action-guard/browser",
            json={"kind": kind, "args": args},
            timeout=60 * 30,
        )
        payload = resp.json() if resp.content else {}
    except Exception as exc:
        logger.warning("Joshu browser action guard failed: %s", exc)
        return None
    if resp.status_code >= 400:
        logger.warning("Joshu browser action guard HTTP %s: %s", resp.status_code, payload)
        return None
    if payload.get("allowed") is True:
        return None
    stub = payload.get("stub")
    if isinstance(stub, dict):
        return json.dumps(stub)
    return json.dumps({"success": True})
`;

function wrapFunction(source, fnName, kind, argBuilder) {
  const needle = `def ${fnName}(`;
  if (!source.includes(needle)) {
    console.error(`[hermes-patch] ${fnName}() not found in ${target}`);
    process.exit(1);
  }
  const guardNeedle = `    guard_err = _joshu_action_guard_browser("${kind}", ${argBuilder})\n    if guard_err:\n        return guard_err\n`;
  if (source.includes(`_joshu_action_guard_browser("${kind}"`)) {
    return source;
  }

  const fnStart = source.indexOf(needle);
  const tryNeedle = '    try:\n        session = _get_session(task_id)';
  const tryPos = source.indexOf(tryNeedle, fnStart);
  if (tryPos === -1) {
    console.error(`[hermes-patch] insertion point not found in ${fnName}()`);
    process.exit(1);
  }
  return source.slice(0, tryPos) + guardNeedle + source.slice(tryPos);
}

let source = readFileSync(target, "utf8");

if (source.includes(MARKER) && source.includes("_joshu_action_guard_browser")) {
  console.log("[hermes-patch] Camofox action-guard patch already applied.");
  process.exit(0);
}

if (!source.includes("def _get_session(")) {
  console.error(`[hermes-patch] _get_session() not found in ${target}`);
  process.exit(1);
}

const insertAfter = "logger = logging.getLogger(__name__)";
if (!source.includes(insertAfter)) {
  console.error(`[hermes-patch] logger anchor not found in ${target}`);
  process.exit(1);
}
source = source.replace(insertAfter, `${insertAfter}\n${helperBlock}`);

source = wrapFunction(
  source,
  "camofox_click",
  "click",
  '{"ref": ref, "url": ""}',
);
source = wrapFunction(
  source,
  "camofox_type",
  "type",
  '{"ref": ref, "text": text}',
);
source = wrapFunction(
  source,
  "camofox_press",
  "press",
  '{"key": key}',
);

writeFileSync(target, source);
console.log("[hermes-patch] applied Camofox action-guard patch — restart Hermes gateway");
