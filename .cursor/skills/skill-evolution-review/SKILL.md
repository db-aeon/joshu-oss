---
name: skill-evolution-review
description: >-
  Manual review of Hermes skill evolution from per-box learning GitHub repos,
  correlated with Langfuse traces, to identify joshu factory skill, MCP,
  code, and doc improvements. Use when the user asks to review skill evolution,
  learning repo changes, background_review skill patches, or correlate
  .evolution.jsonl with Langfuse traces for a box slug (e.g. patrick).
---

# Skill Evolution Review

Manual workflow in Cursor: detect new skill changes from `db-aeon/joshu-learning-{slug}`, correlate each change to Langfuse traces via `session_id`, classify root causes, and propose joshu repo fixes.

Also read the installed **langfuse** skill for CLI discovery and **error-analysis** reference for trace reading methodology.

## Trigger phrases

- "review skill evolution for patrick"
- "check learning repo for new skill patches"
- "correlate evolution.jsonl with Langfuse"

## Prerequisites

- `gh` authenticated (`gh auth status`)
- Langfuse keys in repo `.env`: `HERMES_LANGFUSE_PUBLIC_KEY`, `HERMES_LANGFUSE_SECRET_KEY`, `HERMES_LANGFUSE_BASE_URL` (or `LANGFUSE_*` fallbacks)
- Optional: `LANGFUSE_PROJECT_ID` for direct trace UI links

## Step 0 — Parse arguments

| Arg | Default | Meaning |
|-----|---------|---------|
| `--slug` | `patrick` | Box slug → repo `db-aeon/joshu-learning-{slug}` |
| `--since <sha>` | from state file | Override last-reviewed commit |
| `--force` | off | Re-review even if no new commits |

State file (local, gitignored): [`.joshu/skill-review-state.json`](../../.joshu/skill-review-state.json)

```json
{
  "patrick": {
    "lastReviewedSha": "abc123…",
    "lastReviewedAt": "2026-06-13T12:00:00Z"
  }
}
```

## Step 1 — Prefetch (recommended)

Run the helper script first:

```bash
bash scripts/skill-evolution-review-prefetch.sh --slug patrick
```

Optional override:

```bash
bash scripts/skill-evolution-review-prefetch.sh --slug patrick --since abc123
```

If the script is unavailable, fetch manually:

```bash
ORG=db-aeon
SLUG=patrick
REPO="${ORG}/joshu-learning-${SLUG}"

gh api "repos/${REPO}/commits?sha=main&per_page=10" --jq '.[].sha'

# Compare since last reviewed SHA (replace BASE):
gh api "repos/${REPO}/compare/${BASE}...${HEAD}" \
  --jq '.files[] | select(.filename | test("evolution.jsonl|SKILL.md")) | {filename, patch}'
```

## Step 2 — Build review table

For each **new line** in `skills/.evolution.jsonl` (not the whole file — review at line level):

| ts | skill | action | origin | session_id | message (truncated) |
|----|-------|--------|--------|------------|---------------------|

For each changed `skills/joshu/**/SKILL.md`, summarize the diff (what procedure changed).

**Origins:**

- `background_review` — Hermes post-turn reviewer patched a skill (most common for failure-driven learning)
- `foreground` / `assistant_tool` — user-visible turn edited a skill

## Step 3 — Correlate Langfuse traces

Export credentials from `.env` (do not paste keys into chat):

```bash
set -a && source .env && set +a
export LANGFUSE_HOST="${HERMES_LANGFUSE_BASE_URL:-${LANGFUSE_BASE_URL:-https://us.cloud.langfuse.com}}"
export LANGFUSE_PUBLIC_KEY="${HERMES_LANGFUSE_PUBLIC_KEY:-${LANGFUSE_PUBLIC_KEY}}"
export LANGFUSE_SECRET_KEY="${HERMES_LANGFUSE_SECRET_KEY:-${LANGFUSE_SECRET_KEY}}"
```

For each `session_id`:

```bash
npx langfuse-cli api traces list --sessionId "<session_id>" --limit 10 --json
```

Pick the relevant `"Hermes turn"` trace (filter mentally by `userId` = box slug). Then:

```bash
npx langfuse-cli api observations-v2s list --traceId "<trace_id>" --limit 50 --json
```

**UI link** (when `LANGFUSE_PROJECT_ID` is set):

`{LANGFUSE_HOST}/project/{LANGFUSE_PROJECT_ID}/traces?filter=sessionId%3D{session_id}`

**On-disk fallback** (if you have box SSH): `$HERMES_HOME/logs/session_{session_id}.json`

### Trace reading checklist

For each evolution entry, inspect:

1. User intent vs final agent outcome
2. Tool failures or retries (`skill_view`, `skill_manage`, MCP, kanban, connectors)
3. Whether the skill patch is a **symptom fix** (agent workaround) vs **root fix** (product gap)
4. Which turn triggered background review — patch may land several turns after the failure

## Step 4 — Classify joshu improvements

Use this rubric (same pattern as [ea-for-joshu.md § lessons from traces](../../docs/Joshu-SOP/ea-for-joshu.md#ea-scheduling--lessons-from-traces-2026-06)):

| Layer | When | Example target |
|-------|------|----------------|
| **Factory skill** | Procedure wrong/missing in shipped `SKILL.md` | `integrations/hermes/skills/...` |
| **MCP / connector** | Tool API gap, wrong board, missing endpoint | `scripts/joshu-connectors-mcp-*`, `src/ea/` |
| **Deterministic code** | Should not require agent judgment | `src/ea/schedulingCron.ts`, `src/ea/classifier.ts` |
| **Docs / SOP** | Operational knowledge | `docs/Joshu-SOP/` |
| **Box-only (defer)** | Owner-specific preference, not product | Leave in learning repo only |

Discuss each entry with the user before proposing code changes.

## Step 5 — Record findings (user confirms)

Append a dated section to [docs/Joshu-SOP/skill-evolution-reviews.md](../../docs/Joshu-SOP/skill-evolution-reviews.md):

```markdown
## YYYY-MM-DD — {slug}

| Symptom | Root cause | Fix layer | Proposed joshu change |
|---------|------------|-----------|------------------------|
| … | … | factory skill | `integrations/hermes/skills/...` |
```

Include: evolution `ts`, `skill`, `session_id`, Langfuse trace id, learning-repo commit SHA.

**Only write after explicit user confirmation.**

## Step 6 — Update bookmark

After the review session completes, update `.joshu/skill-review-state.json`:

```json
{
  "patrick": {
    "lastReviewedSha": "<latest main SHA reviewed>",
    "lastReviewedAt": "<ISO8601 UTC>"
  }
}
```

## Step 7 — Merge into factory (mandatory before editing)

**Always** diff the target skill against `db-aeon/joshu-learning-{slug}` on GitHub **before** editing `integrations/hermes/skills/`:

```bash
bash scripts/diff-factory-skill-with-learning.sh executive-assistant/ea-scheduling patrick
```

Promote validated box patches first; then layer new factory improvements. See `.cursor/rules/factory-skills-learning-diff.mdc`.

When classification is **factory skill** or **deterministic code**, offer to:

1. Apply the merged factory skill diff
2. Open a focused PR or local commit (only when user asks)

Promote validated box patches to factory quickly — bootstrap `rsync --delete` can wipe box evolution ([hotpatch-running-box.md](../../docs/vps-sandbox/hotpatch-running-box.md)).

## Known limitations

- **No `trace_id` in evolution ledger** — correlation is via `session_id` only
- **Background review ≠ immediate** — skill may update turns after the failure; session may contain multiple turns
- **Hourly git granularity** — multiple evolution entries may land in one commit; review at evolution-line level
- **Factory vs box** — evaluate every box patch for promotion to `integrations/hermes/skills/`

## Related docs

- [hermes-customizations.md § GitHub backup](../../docs/hermes-customizations.md) — learning loop architecture
- [session-2026-06-11-learning-browser-sync.md](../../docs/vps-sandbox/session-2026-06-11-learning-browser-sync.md)
- [skill-evolution-reviews.md](../../docs/Joshu-SOP/skill-evolution-reviews.md) — accumulated review log
