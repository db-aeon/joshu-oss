#!/usr/bin/env node
/**
 * Idempotently patch Hermes tools/terminal_tool.py to block reading fleet secret
 * files via the agent terminal tool (jterm is an owner shell — this is Hermes-only).
 *
 * Deny list:
 *   /etc/joshu/instance.env
 *   /etc/joshu/secrets/ (and children)
 *   /opt/joshu/ any .env files
 *   HERMES_HOME .env (typically /root/.hermes/.env)
 *   Hermes config writes: `hermes config set|edit|…` and write ops on
 *   ~/.hermes/config.yaml (reads allowed) — the file is Joshu-managed.
 *
 * IMPORTANT: helper regexes must not embed unescaped " inside Python "..." strings —
 * that yields `unterminated string literal` and breaks ALL Hermes tools (jChat dies).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const target = process.argv[2];
if (!target) {
  console.error("usage: patch-hermes-terminal-secrets-guard.mjs <path/to/terminal_tool.py>");
  process.exit(1);
}

const MARKER = "hitl_terminal_secrets_guard";
const HELPER_START = "def _joshu_terminal_secrets_guard_enabled() -> bool:";
const HELPER_END_MARKER = "def _joshu_terminal_secrets_blocked";

// Keep regexes quote-safe for Python double-quoted raw strings (no " inside r"...").
// In this JS template literal: \\ → one \ in the .py file (needed for r"\." / r"\b").
const helperBlock = `
def _joshu_terminal_secrets_guard_enabled() -> bool:
    raw = os.getenv("JOSHU_TERMINAL_SECRETS_GUARD", "1").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def _joshu_terminal_secrets_blocked(command: str) -> Optional[str]:
    """Hard block reads of instance.env / secrets dirs via agent terminal (${MARKER})."""
    if not _joshu_terminal_secrets_guard_enabled():
        return None
    normalized = command.lower()
    # Hermes config is Joshu-managed (hermesApi syncs it): agents must not rewrite it.
    # A kanban worker once repointed browser.cdp_url itself instead of reporting a
    # broken browser. Reads (grep/cat) stay allowed.
    hermes_config_path = r"(?:\\.hermes/|\\$hermes_home/)config\\.ya?ml"
    config_write = re.search(
        r"\\bhermes\\b[^|;&\\n]*\\bconfig\\s+(?:set|unset|edit|reset|migrate|import)\\b",
        normalized,
    ) or (
        re.search(hermes_config_path, normalized)
        and re.search(
            r"\\bsed\\b[^|;&\\n]*\\s-i|\\btee\\b|>>?\\s*\\S*config\\.ya?ml|\\b(?:cp|mv|install|dd|truncate|rm|ln)\\b|open\\([^)]*[\\x22\\x27][wa+]",
            normalized,
        )
    )
    if config_write:
        return (
            "Blocked: Hermes config is managed by Joshu — agents must not change it. "
            "If a tool is broken, report it and kanban_block the task with a 'system:' reason."
        )
    # Match common read/print tools against secret paths (not an exhaustive shell parser).
    # Patterns avoid embedding " inside r"..." so this file stays valid Python.
    blocked_patterns = [
        (r"/etc/joshu/instance\\.env", "/etc/joshu/instance.env"),
        (r"/etc/joshu/secrets(?:/|\\b)", "/etc/joshu/secrets/"),
        (r"/opt/joshu/\\S*\\.env", "/opt/joshu/**/.env*"),
        (r"/(?:root|home/[^/]+)/\\.hermes/\\.env", "Hermes .env"),
        (r"\\$hermes_home/\\.env", "Hermes .env"),
        (r"~/.hermes/\\.env", "Hermes .env"),
    ]
    readish = bool(
        re.search(
            r"\\b(cat|head|tail|less|more|bat|sed|awk|nl|tac|grep|rg|ripgrep|strings|hexdump|xxd|cp|mv|install|tee)\\b",
            normalized,
        )
        or re.search(r"\\bpython3?\\b.*open\\(", normalized)
        or "base64" in normalized
    )
    if not readish and "/etc/joshu/" not in normalized and ".hermes/.env" not in normalized:
        return None
    for pattern, label in blocked_patterns:
        if re.search(pattern, normalized):
            return (
                f"Blocked terminal access to {label} — credential isolation. "
                "Per-box secrets stay for the stack; agents must not read them."
            )
    return None
`;

const guardCall = `
        # Joshu: never allow agent terminal to read fleet/box secret files (${MARKER})
        secrets_block = _joshu_terminal_secrets_blocked(command)
        if secrets_block:
            logger.warning("Blocked terminal secrets read: %s", _safe_command_preview(command))
            return json.dumps({
                "output": "",
                "exit_code": -1,
                "error": secrets_block,
                "status": "blocked",
            }, ensure_ascii=False)
`;

function pythonSyntaxOk(path) {
  const r = spawnSync("python3", ["-m", "py_compile", path], {
    encoding: "utf8",
  });
  return r.status === 0;
}

/** Replace an existing helper block (broken or stale) with the current helperBlock. */
function replaceHelperBlock(source) {
  const start = source.indexOf(HELPER_START);
  if (start < 0) return null;
  // Find end of _joshu_terminal_secrets_blocked: next top-level def/class after its body,
  // or the blank-line+comment section that follows mail/secrets helpers.
  const afterStart = source.indexOf("\n\n\n", start);
  const nextDef = source.slice(start + HELPER_START.length).search(/\n(?:def |class |# -{5,})/);
  let end;
  if (nextDef >= 0) {
    end = start + HELPER_START.length + nextDef;
  } else if (afterStart >= 0) {
    end = afterStart;
  } else {
    return null;
  }
  // Expand end to include the full secrets_blocked function (ends at blank line before next section).
  // Prefer cutting at the triple-newline after `return None` of secrets_blocked.
  const sliceFrom = start;
  const rest = source.slice(start);
  const m = rest.match(
    /def _joshu_terminal_secrets_guard_enabled\(\)[\s\S]*?\n    return None\n/,
  );
  if (!m) return null;
  return source.slice(0, sliceFrom) + helperBlock.trimStart() + source.slice(sliceFrom + m[0].length);
}

let source = readFileSync(target, "utf8");
let changed = false;

const hasHelper = source.includes(HELPER_START) && source.includes("_joshu_terminal_secrets_blocked");
const hasCall = source.includes("_joshu_terminal_secrets_blocked(command)");
const hasMarker = source.includes(MARKER);

if (hasHelper) {
  const repaired = replaceHelperBlock(source);
  if (repaired && repaired !== source) {
    source = repaired;
    changed = true;
    console.log("[hermes-patch] replaced terminal secrets-guard helper block");
  }
}

if (!hasHelper) {
  const loggerAnchor = "logger = logging.getLogger(__name__)";
  if (!source.includes(loggerAnchor)) {
    console.error(`[hermes-patch] logger anchor not found in ${target}`);
    process.exit(1);
  }
  if (!source.includes("import re")) {
    source = source.replace(/^import json/m, "import re\nimport json");
  }
  source = source.replace(loggerAnchor, `${loggerAnchor}\n${helperBlock}`);
  changed = true;
}

if (!hasCall) {
  const insertBefore = "        # Pre-exec security checks (tirith + dangerous command detection)";
  const mailAnchor = "        # Joshu: never allow terminal mail sends";
  if (source.includes(insertBefore)) {
    source = source.replace(insertBefore, `${guardCall}\n${insertBefore}`);
    changed = true;
  } else if (source.includes(mailAnchor)) {
    source = source.replace(mailAnchor, `${guardCall}\n${mailAnchor}`);
    changed = true;
  } else {
    console.error("[hermes-patch] pre-exec guard anchor not found in terminal_tool.py");
    process.exit(1);
  }
}

if (!changed && hasMarker && hasHelper && hasCall) {
  if (pythonSyntaxOk(target)) {
    console.log("[hermes-patch] terminal secrets-guard patch already applied.");
    process.exit(0);
  }
  console.error("[hermes-patch] secrets-guard present but Python syntax invalid — forcing helper replace");
  const repaired = replaceHelperBlock(readFileSync(target, "utf8"));
  if (!repaired) {
    console.error("[hermes-patch] could not locate helper block to repair");
    process.exit(1);
  }
  source = repaired;
  changed = true;
}

if (changed) {
  writeFileSync(target, source);
  if (!pythonSyntaxOk(target)) {
    console.error("[hermes-patch] wrote secrets-guard but py_compile failed — check escaping");
    process.exit(1);
  }
  console.log("[hermes-patch] applied terminal secrets-guard patch — restart Hermes gateway");
} else {
  console.log("[hermes-patch] terminal secrets-guard patch already applied.");
}
