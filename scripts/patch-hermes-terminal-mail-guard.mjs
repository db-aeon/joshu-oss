#!/usr/bin/env node
/**
 * Idempotently patch Hermes tools/terminal_tool.py to block outbound mail sends
 * that bypass Joshu action guard (nylas CLI, curl to REST send, sendmail, etc.).
 */
import { readFileSync, writeFileSync } from "node:fs";

const target = process.argv[2];
if (!target) {
  console.error("usage: patch-hermes-terminal-mail-guard.mjs <path/to/terminal_tool.py>");
  process.exit(1);
}

const MARKER = "hitl_terminal_mail_guard";

const helperBlock = `
def _joshu_terminal_mail_guard_enabled() -> bool:
    raw = os.getenv("JOSHU_TERMINAL_MAIL_GUARD", "1").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def _joshu_terminal_mail_send_blocked(command: str) -> Optional[str]:
    \"\"\"Hard block mail sends outside Joshu MCP/REST gate (${MARKER}).\"\"\"
    if not _joshu_terminal_mail_guard_enabled():
        return None
    normalized = command.lower()
    blocked_patterns = [
        (r"\\bnylas\\s+email\\s+send\\b", "nylas CLI email send"),
        (r"\\bnylas\\s+send\\b", "nylas CLI send"),
        (r"/api/nylas/messages/send", "Joshu Nylas REST send via shell"),
        (r"nylas/messages/send", "Nylas message send via shell"),
        (r"\\b(sendmail|mailx)\\b", "sendmail/mailx"),
        (r"\\bmail\\s+(-s|-a|-r|<)", "mail(1) send"),
        (r"\\bcurl\\b[^\\n]*/api/nylas/messages/send", "curl to Joshu Nylas send"),
        (r"\\bwget\\b[^\\n]*/api/nylas/messages/send", "wget to Joshu Nylas send"),
    ]
    for pattern, label in blocked_patterns:
        if re.search(pattern, normalized):
            return (
                f"Blocked {label} — bypasses Joshu action guard. "
                "Use mcp_joshu_connectors_nylas_send_message (with sourcePath on thread replies)."
            )
    return None
`;

const guardCall = `
        # Joshu: never allow terminal mail sends that skip action guard (${MARKER})
        mail_block = _joshu_terminal_mail_send_blocked(command)
        if mail_block:
            logger.warning("Blocked terminal mail bypass: %s", _safe_command_preview(command))
            return json.dumps({
                "output": "",
                "exit_code": -1,
                "error": mail_block,
                "status": "blocked",
            }, ensure_ascii=False)
`;

let source = readFileSync(target, "utf8");

if (source.includes(MARKER) && source.includes("_joshu_terminal_mail_send_blocked")) {
  console.log("[hermes-patch] terminal mail-guard patch already applied.");
  process.exit(0);
}

const loggerAnchor = "logger = logging.getLogger(__name__)";
if (!source.includes(loggerAnchor)) {
  console.error(`[hermes-patch] logger anchor not found in ${target}`);
  process.exit(1);
}

if (!source.includes("import re")) {
  source = source.replace(/^import json/m, "import re\nimport json");
}

source = source.replace(loggerAnchor, `${loggerAnchor}\n${helperBlock}`);

const insertBefore = "        # Pre-exec security checks (tirith + dangerous command detection)";
if (!source.includes(insertBefore)) {
  console.error("[hermes-patch] pre-exec guard anchor not found in terminal_tool.py");
  process.exit(1);
}

if (source.includes("_joshu_terminal_mail_send_blocked(command)")) {
  console.error("[hermes-patch] guard call already present");
  process.exit(1);
}

source = source.replace(insertBefore, `${guardCall}\n${insertBefore}`);

writeFileSync(target, source);
console.log("[hermes-patch] applied terminal mail-guard patch — restart Hermes gateway");
