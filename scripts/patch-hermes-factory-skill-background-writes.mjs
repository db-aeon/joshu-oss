#!/usr/bin/env node
/**
 * Idempotently patch Hermes tools/skill_manager_tool.py so background skill
 * review may patch factory skills under $HERMES_HOME/skills/joshu/ without
 * `hermes curator adopt`.
 *
 * Those skills stay off the curator archive/consolidation walk (no created_by
 * marker). Whole-skill delete stays refused. Older Hermes checkouts that lack
 * the created_by guard are skipped (exit 0) so boot does not fail.
 */
import { readFileSync, writeFileSync } from "node:fs";

const target = process.argv[2];
if (!target) {
  console.error(
    "usage: patch-hermes-factory-skill-background-writes.mjs <path/to/skill_manager_tool.py>",
  );
  process.exit(1);
}

const MARKER = "_joshu_factory_skill_background_write";
const NEEDLE = "        if not skill_usage._is_curator_managed_record(usage_rec):";

const insertion = `        # Joshu: factory skills under $HERMES_HOME/skills/joshu/ are seeded
        # product skills. Background review may patch them in place without
        # hermes curator adopt, so they stay off the archive/consolidation
        # walk. Whole-skill delete stays refused. (${MARKER})
        if action != "delete":
            try:
                _home = os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
                _joshu_skills = (Path(_home) / "skills" / "joshu").resolve()
                _resolved = Path(skill_dir).resolve()
                if _resolved == _joshu_skills or _joshu_skills in _resolved.parents:
                    return None
            except Exception:
                logger.debug("joshu factory skill path check failed for %s", name, exc_info=True)

`;

let text;
try {
  text = readFileSync(target, "utf8");
} catch (err) {
  console.error(`[factory-skill-background-writes] cannot read ${target}: ${err.message}`);
  process.exit(1);
}

if (text.includes(MARKER)) {
  console.log("[factory-skill-background-writes] already applied");
  process.exit(0);
}

if (!text.includes(NEEDLE)) {
  console.log(
    "[factory-skill-background-writes] skip: created_by guard not present (older Hermes)",
  );
  process.exit(0);
}

const count = text.split(NEEDLE).length - 1;
if (count !== 1) {
  console.error(
    `[factory-skill-background-writes] error: expected 1 created_by guard, found ${count}`,
  );
  process.exit(1);
}

writeFileSync(target, text.replace(NEEDLE, insertion + NEEDLE));
console.log("[factory-skill-background-writes] applied");
