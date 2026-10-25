/** Parse Ref: pj/t_abc123 from SMS body. */
export function parseProactiveTaskRef(body: string): { taskId: string } | null {
  const match = /\bRef:\s*pj\/(t_[a-f0-9]+)\b/i.exec(body);
  const taskId = match?.[1]?.trim();
  if (!taskId) return null;
  return { taskId };
}
