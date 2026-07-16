/** Slack section `text` hard limit is 3000; keep headroom after escaping. */
export const SLACK_SECTION_TEXT_MAX = 2800;

/** Split long mrkdwn into section-sized chunks without truncating content. */
export function chunkSlackMrkdwn(text: string, maxLen = SLACK_SECTION_TEXT_MAX): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    if (text.length - offset <= maxLen) {
      chunks.push(text.slice(offset));
      break;
    }
    let end = offset + maxLen;
    // Prefer breaking just after a newline so emails stay readable.
    const nl = text.lastIndexOf("\n", end - 1);
    if (nl > offset + Math.floor(maxLen * 0.5)) {
      end = nl + 1;
    }
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks.filter((c) => c.length > 0);
}
