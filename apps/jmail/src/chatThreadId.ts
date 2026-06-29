/** CopilotKit + Hermes thread id for jMail embedded chat (distinct from voice session). */

const REV_KEY = "jmail-agent-chat-rev";

function readRev(): string {
  try {
    return sessionStorage.getItem(REV_KEY) ?? "1";
  } catch {
    return "1";
  }
}

/** Stable per mailbox + revision — Langfuse/Hermes session resets when revision bumps. */
export function buildJmailChatThreadId(mailbox: string, rev = readRev()): string {
  const box = mailbox.trim() || "default";
  return `jmail:${box}:chat:${rev}`;
}

/** Bump chat revision (new CopilotKit thread + Hermes session on next mount). */
export function rotateJmailChatThread(): string {
  const rev = String(Date.now());
  try {
    sessionStorage.setItem(REV_KEY, rev);
  } catch {
    /* ignore */
  }
  return rev;
}

export function readJmailChatThreadRev(): string {
  return readRev();
}
