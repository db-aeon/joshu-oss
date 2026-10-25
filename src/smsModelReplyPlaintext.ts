/**
 * Owner-facing SMS text: markdown to plain text with the line breaks and list
 * items kept. DSML scrub happens in Hermes; GSM folding and the split into SMS
 * parts happen in sendSms (smsGsmParts).
 */
export function smsModelReplyPlaintext(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    // Keep the code of a code block: in an SMS it is often a confirmation number.
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_match, label: string, url: string) =>
      label.trim() === url ? url : `${label}: ${url}`,
    )
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/gm, "")
    .replace(/^([ \t]*)[*+][ \t]+/gm, "$1- ")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/\*(\S(?:[^*\n]*\S)?)\*/g, "$1")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 32000);
}
