# EA skill evolution — future fixes backlog

Structural improvements surfaced by the **2026-06-16 patrick** skill review ([`skill-evolution-reviews.md`](skill-evolution-reviews.md)). These are **not blockers** for the factory merges already shipped (ea-scheduling v4.9.0, ea-playbook v2.8.2, joshu-brain v1.6.0). They replace long-term skill “pitfall” patches with deterministic behavior where possible.

**Product spec:** [`ea-for-joshu.md`](ea-for-joshu.md) · **Classifier taxonomy:** [`mail-classifier-taxonomy.md`](mail-classifier-taxonomy.md)

**Fix layers (prefer top → bottom):** deterministic code · MCP/connector · factory skill · docs/SOP · box-only (defer)

---

## Guardrails (skill evolution hygiene)

Use these when promoting patches from `db-aeon/joshu-learning-{slug}`:

1. **Promote invariants, not operating style** — tool choice, temporal contracts, dedupe rules yes; reverting to cron triage-drain or removing mail-ingress no.
2. **Cap “Pitfall —” growth** — if a third Nylas/Gmail edge-case callout lands in `ea-playbook`, open a code/classifier ticket instead of another paragraph.
3. **Diff before merge** — `.cursor/rules/factory-skills-learning-diff.mdc`, `scripts/diff-factory-skill-with-learning.sh`.
4. **On-box deploy merge** — routine factory rollouts use `bootstrap-hermes-learning-skills.sh` + `merge-hermes-factory-skill.mjs` per box; Cursor authors factory only.
5. **One symptom → one owner layer** — don’t duplicate the same rule in skill + reference + SOP unless each layer has a distinct job (ingest vs retrieval vs on-demand recovery).

---

## Shipped (2026-06-23 — UP.Labs scheduling trace)

| Item | Layer | Notes |
|------|-------|-------|
| Meeting **thread dedup** on create | Code | [`schedulingCron.ts`](../../src/ea/schedulingCron.ts) — `existing_thread`; `GET …/meetings?threadId=` |
| **Project boards must not send** scheduling mail | Skill | [`ea-playbook` v2.16+](../../integrations/hermes/skills/executive-assistant/ea-playbook/SKILL.md) |
| Action-guard send timeout ≠ MCP down | Skill | [`ea-scheduling` v4.18+](../../integrations/hermes/skills/executive-assistant/ea-scheduling/SKILL.md) |
| Action guard **503** when Telegram unlinked (no crash) | Code | [`gate.ts`](../../src/actionGuard/gate.ts), [`nylasSendGate.ts`](../../src/actionGuard/nylasSendGate.ts) |
| Connectors `/health` probes Joshu upstream | Code | [`joshu-connectors-mcp-http-server.mjs`](../../scripts/joshu-connectors-mcp-http-server.mjs) |
| Local MCP supervisor | Code | [`mcpSupervisor.ts`](../../src/mcpSupervisor.ts) |
| **`JOSHU_CONNECTORS_API_BASE` :8787 guard** | Script | [`start-joshu-connectors-mcp.sh`](../../scripts/start-joshu-connectors-mcp.sh) |

Docs: [`ea-for-joshu.md`](ea-for-joshu.md#ea-scheduling--dedupe-layers-2026-06-23), [`connectors.md`](../connectors.md#action-guard-mcp-tool-timeout-vs-approval-wait).

---

## Backlog

### 0. Async action-guard approval (high — 2026-06-23)

| | |
|--|--|
| **Symptom** | Hermes MCP `nylas_send_message` times out at ~120s while Joshu gate waits up to 30 min; workers misread as MCP down; competing workers if owner approves one send while duplicate times out. |
| **Current workaround** | Skill: block with `awaiting owner approval`; do not retry from project board. |
| **Proposed fix** | REST returns **202** `{ status: "pending_approval", pendingId }`; worker `kanban_block`; Joshu completes send on Telegram approve and optionally wakes worker. |
| **Files** | `src/actionGuard/gate.ts`, `nylasSendGate.ts`, `joshu-connectors-mcp-http-server.mjs`, Hermes tool timeout config |

### 1. Stale scheduling confirmation stubs (high)

| | |
|--|--|
| **Symptom** | Dan confirms a time Patrick already booked; Nylas mirror stub lingers `state: new` and gets re-routed to `ea-scheduling` or spawns duplicate project work. |
| **Current workaround** | `ea-playbook` v2.8.2 pitfall — verify Google Calendar before routing; close stub if event exists. |
| **Root cause** | Async gap between **Kanban booking complete** and **stub lifecycle**; owner outbound on scheduling threads not consistently closed at ingest. Scheduling v2 uses Kanban (`ea-sched-*`), not legacy MD cases — `archive_scheduling_stubs` targets legacy paths ([`triageSchedulingBridge.ts`](../../src/ea/triageSchedulingBridge.ts)). |
| **Proposed fix** | **Deterministic code:** On `ea-scheduling` meeting task `kanban_complete` (or calendar book success), archive or link-done any triage stubs / ingress thread ids for that `message_id` / `thread_id`. **Classifier:** Extend [`classifier.ts`](../../src/ea/classifier.ts) — owner reply on existing scheduling thread with confirmation language → `owner_sent_update` or new `owner_scheduling_confirmation` → `disposition: info`, auto-archive (see taxonomy `owner_sent_update`). **Connector:** Ensure Nylas owner-outbound path hits the same ingest filters as Gmail SENT. |
| **Files** | `src/ea/schedulingCron.ts`, `src/ea/triageStub.ts`, `src/ea/classifier.ts`, `src/ea/ingestFilters.ts` |

---

### 2. Owner outbound on Nylas classified as new work (medium)

| | |
|--|--|
| **Symptom** | Dan-as-sender Nylas stubs (Patrick+external thread) treated like inbound requests. |
| **Current workaround** | `ea-playbook` Dan-as-sender table extended for Nylas mirror semantics (v2.8.2). |
| **Root cause** | Classifier prompt has `owner_sent_update` but Nylas mirror shape / thread depth may not match Gmail SENT signals reliably. |
| **Proposed fix** | **Classifier:** Golden tests + Langfuse **`ea-mail-classifier`** evals for Nylas owner-reply fixtures. **Ingest:** If `from` = owner principal and thread has prior agent+external messages, default `info` without Kanban. |
| **Files** | `src/ea/classifier.ts`, `docs/Joshu-SOP/mail-classifier-taxonomy.md`, tests under `src/ea/` |

---

### 3. Content-based scheduling routing in skills (medium — partially addressed 2026-06-17)

| | |
|--|--|
| **Symptom** | Playbook routes “find a time / confirm” by reading thread body when frontmatter lacks scheduling flags. |
| **Shipped** | **Unified ingress:** all actionable mail → `ea-mail-ingress`; `category: scheduling` + `scheduling_hint` on stub/task; Patrick files then `scheduling_*` child. No ingest `ea-sched-ingress`. |
| **Remaining** | Ingress worker must **`skill_view("ea-playbook")`** and follow MAIL INGRESS (Patrick trace 2026-06-16 loaded `ea-project-kanban` instead). Consider deterministic skill pin on `ea-mail-ingress` task body. |
| **Files** | `src/ea/classifier.ts`, `ea-playbook` v2.9.0, `ea-scheduling` v4.10.0 |

---

### 4. Owner-specific strings in factory skills (medium)

| | |
|--|--|
| **Symptom** | Factory skills hardcode `Dan`, `Patrick`, `db@project-aeon.com`, subject prefixes (“Another note to file”). |
| **Current workaround** | Acceptable for single-tenant patrick factory today. |
| **Proposed fix** | **Welcome / profile:** Seed `principalEmail`, note subject patterns, companion name into `.joshu/nylas/profile.json` or box template. **Skills:** Replace literals with “owner principal from profile” / `{companion}` placeholders; generate box-specific reference snippets at provision if needed. |
| **Files** | `templates/`, `src/onboarding/`, skill reference docs |

---

### 5. Duplicate note-to-self guidance (low)

| | |
|--|--|
| **Symptom** | Same retrieval + classification patterns in `ea-playbook`, `joshu-brain`, and `references/find-user-notes.md`. |
| **Current workaround** | Intentional overlap after v1.6.0 merge — brain for recall, playbook for triage filing. |
| **Proposed fix** | **Docs/SOP:** Single canonical reference (`find-user-notes.md` or playbook classification section). **joshu-brain:** Short pointer + gbrain-first steps only. **ea-playbook:** Own filing/triage; link to brain reference for recall queries. |
| **Files** | `integrations/hermes/skills/brain/joshu-brain/`, `integrations/hermes/skills/executive-assistant/ea-playbook/` |

---

### 10. Daily handoff — morning review + shutdown (shipped 2026-06-18)

| | |
|--|--|
| **Scope** | `Planning/daily-review-*.md`; interactive jChat; cron pointer emails; carryover in time-block JSON + renderer |
| **Docs** | [`time-block-planning.md`](time-block-planning.md), [`gtd-workspace-linking.md`](gtd-workspace-linking.md) |
| **Skills** | `ea-morning-review` v1.0.0, `ea-shutdown` v1.0.0, `ea-playbook` v2.12.0, `ea-time-block` **v1.3.0** (gather + render scripts, VPS absolute paths) |
| **Code** | `src/onboarding/eaCronJobs.ts`, `scripts/render-time-block-excalidraw.mjs`, `scripts/gather-time-block-input.mjs` |

---


| | |
|--|--|
| **Scope** | GTD mapping without Reference/Someday/Current folders; `Planning/capture-*`; link discipline; time-block `taskGroups`; weekly someday scan. |
| **Docs** | [`gtd-workspace-linking.md`](gtd-workspace-linking.md), [`ea-for-joshu.md`](ea-for-joshu.md), [`time-block-planning.md`](time-block-planning.md) |
| **Skills** | `ea-playbook` v2.11.0, `ea-time-block` v1.1.0, `joshu-brain` v1.7.0, `ea-scheduling` v4.14.0 (patrick merge) |
| **Templates** | `templates/ea/FILING.md`, `Planning/capture-template.md` |

---

### 6. Temporal grounding not on all Hermes turn paths (medium)

| | |
|--|--|
| **Symptom** | “Today / tomorrow” wrong on turns that bypass Joshu chat API (e.g. Telegram gateway, direct Hermes cron without server injection). |
| **Current workaround** | `ownerLocalTime.ts` + calendar API `timeAnchor` / `relativeDay` on Joshu-hosted paths ([`ownerLocalTime.ts`](../../src/ownerLocalTime.ts), [`hermesApi.ts`](../../src/hermesApi.ts), [`connectors/routes.ts`](../../src/connectors/routes.ts)). Skill temporal grounding in ea-scheduling v4.9.0. |
| **Proposed fix** | **Deterministic code:** Inject `buildOwnerTimeSystemMessage()` on every Hermes turn entrypoint (Telegram, phone already partial — audit all gateways). **Cron:** Prepend time anchor to skill-backed cron system prompts in [`eaCronJobs.ts`](../../src/onboarding/eaCronJobs.ts) if not already via server. |
| **Files** | `src/hermesApi.ts`, `src/twilioPhoneGateway.ts`, Hermes gateway integrations, `src/onboarding/eaCronJobs.ts` |

---

### 7. Gmail + Nylas dedupe at ingest — **done (2026-06-17)**

| | |
|--|--|
| **Symptom** | Same Dan send classified twice (Gmail SENT + Nylas CC) ~5s apart; different body hashes |
| **Fix** | RFC `Message-ID` dedup key + classification cache + shared Kanban idempotency (`mailDedup.ts`, mirror `rfc_message_id`) |
| **Test** | `npm run test:mail-dedup` |

---

### 8. `list_events` missing `transparency` from Composio (low)

| | |
|--|--|
| **Symptom** | `google_calendar_list_events` returns `transparency: null`, `blocksAvailability: true` for Asteme even when Google marks **Show as free**; FreeBusy is correct (`busy: []`). |
| **Root cause** | Composio `GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS` `summary_view` may omit `transparency` for reader/subscribed calendars. |
| **Workaround** | Use **`google_calendar_find_free_slots`** for availability; do not infer from titles. |
| **Proposed fix** | Fetch full event detail when transparency missing, or document `blocksAvailability` as best-effort on list path only. |

---

## Already shipped (reference)

| Fix | Layer | Where |
|-----|-------|--------|
| Owner-local now in chat turns | Code | `src/ownerLocalTime.ts`, `buildTurnSystemMessages()` |
| Calendar `timeAnchor` / `relativeDay` | Code + skill | `src/connectors/routes.ts`, ea-scheduling v4.9.0 |
| `GOOGLECALENDAR_FIND_FREE_SLOTS` primary | Skill | ea-scheduling v4.9.0 |
| `google_calendar_find_free_slots` MCP + transparency on list_events | Code + skill | ea-scheduling v4.11.0, connectors API — Patrick validated 2026-06-17 |
| Owner self-intro handoff | Skill | ea-scheduling v4.9.0 |
| gbrain-first self-sent notes | Skill | joshu-brain v1.6.0 |
| Selective playbook pitfalls (no ingest regression) | Skill + process | ea-playbook v2.8.2, learning diff rule |
| RFC Message-ID dedup | Code | `mailDedup.ts` |
| Unified mail ingress (no sched-ingress at ingest) | Code + skills | `classifier.ts`, `triageStub.ts`, `mailCron.ts`, ea-playbook v2.9.0, ea-scheduling v4.10.0 |
| GTD linking + Planning capture | Docs + skills | `gtd-workspace-linking.md`, ea-playbook v2.11.0, ea-time-block v1.1.0 |
| Daily handoff (morning review + shutdown) | Skills + cron + renderer | ea-morning-review, ea-shutdown, ea-playbook v2.12.0, ea-time-block v1.2.0 |
| Time-block gather script + calendar API quirks (Patrick reflection backport) | Skill + code + docs | ea-time-block v1.3.0, `gather-time-block-input.mjs`, `calendar-api-quirks.md`, `deploy/docker-compose.yml` |
| Re-created stub dedup + summary email structure + project scope hygiene | Skill | ea-playbook v2.11.0 (from joshu-learning-patrick 2026-06-18) |
| Calendly counterparty fallback + verify task from threads | Skill | ea-scheduling v4.14.0 (from joshu-learning-patrick 2026-06-17/18) |
| Multi-calendar FreeBusy default + `calendars.combined` | Code + skill + docs | `calendarAvailability.ts`, ea-scheduling v4.19.0 — validated Ebony trace 2026-06-24 |

---

## When to revisit

- After the next **patrick** skill evolution review (monthly or after a bad Langfuse trace).
- When provisioning a **second box** — items **4** and **5** become blocking.
- When **`ea-mail-classifier`** disposition accuracy is measured &lt; ~90% on a category — prioritize **2** and **3** over new skill text.
