/**
 * Size limits of Hermes memory (see openspec/glossary.md), in characters. Hermes refuses a write
 * to MEMORY.md or USER.md that goes over the limit, and its defaults (2,200 and 1,375) fill up on
 * a busy box. Spec: hermes-memory. Reasons: docs/hermes-integration.md, section "Hermes memory".
 */
export const JOSHU_HERMES_MEMORY_CHAR_LIMIT = 6000;
export const JOSHU_HERMES_USER_CHAR_LIMIT = 4000;

const LIMITS: ReadonlyArray<readonly [key: string, limit: number]> = [
  ["memory_char_limit", JOSHU_HERMES_MEMORY_CHAR_LIMIT],
  ["user_char_limit", JOSHU_HERMES_USER_CHAR_LIMIT],
];

/**
 * Set `memory.memory_char_limit` and `memory.user_char_limit` of a Hermes config record to the
 * Joshu limits. A higher limit stays, so an owner who set more room keeps it. The other keys of
 * `memory` do not change. Returns true when the config changed.
 */
export function syncJoshuHermesMemoryLimits(config: Record<string, unknown>): boolean {
  const current = config.memory;
  const memory: Record<string, unknown> =
    current && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  let changed = false;
  for (const [key, limit] of LIMITS) {
    const value = Number(memory[key]);
    if (Number.isFinite(value) && value >= limit) continue;
    memory[key] = limit;
    changed = true;
  }
  if (changed) config.memory = memory;
  return changed;
}
