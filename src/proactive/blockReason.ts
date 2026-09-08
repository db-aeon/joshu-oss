/** Whether a blocked task's reason indicates owner input is needed. */

const OWNER_INPUT_PATTERNS: RegExp[] = [
  /awaiting owner approval/i,
  /awaiting owner or external party/i,
  /awaiting owner(?!\s*or)/i,
  /^awaiting owner$/i,
  /owner review/i,
  /owner denied send/i,
  /approval timed out/i,
];

const EXCLUDE_PATTERNS: RegExp[] = [
  /awaiting reply:/i,
  /connectors-mcp-down/i,
  /action-guard-unavailable/i,
];

export function blockReasonNeedsOwnerInput(reason: string | null | undefined): boolean {
  const r = (reason ?? "").trim();
  if (!r) return false;
  if (EXCLUDE_PATTERNS.some((p) => p.test(r))) return false;
  return OWNER_INPUT_PATTERNS.some((p) => p.test(r));
}

/** Parse Ref: pj/t_abc123 from SMS body. */
export function parseProactiveTaskRef(body: string): { taskId: string } | null {
  const match = /\bRef:\s*pj\/(t_[a-f0-9]+)\b/i.exec(body);
  const taskId = match?.[1]?.trim();
  if (!taskId) return null;
  return { taskId };
}
