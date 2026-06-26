# Skill evolution reviews

Manual review log: Hermes **background_review** skill patches from per-box learning repos (`db-aeon/joshu-learning-{slug}`), correlated with Langfuse traces, and actionable joshu product changes.

**Workflow:** Cursor skill `.cursor/skills/skill-evolution-review/SKILL.md` — prompt e.g. *"review skill evolution for patrick"*.

**Correlation:** `skills/.evolution.jsonl` → `session_id` → Langfuse `sessionId` on `"Hermes turn"` traces (`userId` = box slug).

**Fix layers:** factory skill · MCP/connector · deterministic code · docs/SOP · box-only (defer)

---

## Template (copy for new sessions)

```markdown
## YYYY-MM-DD — {slug}

Learning repo: `db-aeon/joshu-learning-{slug}` @ `{commit_sha}`

| Symptom | Root cause | Fix layer | Proposed joshu change |
|---------|------------|-----------|------------------------|
| … | … | factory skill | `integrations/hermes/skills/...` |

### Evolution entries

| ts | skill | action | origin | session_id | trace_id |
|----|-------|--------|--------|------------|----------|
| … | … | patch | background_review | … | … |
```

---

## Reviews

<!-- Append dated sections below after each review session. -->

## 2026-06-16 — patrick (ea-scheduling)

Learning repo: `db-aeon/joshu-learning-patrick` @ `69ca1f562a04412ba9346fee9fa46baa9964e938`

| Symptom | Root cause | Fix layer | Proposed joshu change |
|---------|------------|-----------|------------------------|
| Agent inferred busy from Asteme/all-day titles via `list_events` | Factory v4.7 used `google_calendar_list_events` as availability source; MCP described it as busy/free source | Code + skill | **Shipped 2026-06-17:** `google_calendar_find_free_slots` MCP + REST; ea-scheduling v4.11.0; `list_events` for titles only |
| Investor intro batch emails handled ad hoc | Patrick `background_review` added intro-reply workflow | Factory skill | Promote **Owner self-introduction handoff** section |
| "Today's wrap block" wrong when UTC date ≠ PT date | No owner-local now in prompt; model used first query date as "today" | Deterministic code + factory skill | `ownerLocalTime.ts` turn injection; calendar `timeAnchor`/`relativeDay`; skill **Temporal grounding** (v4.9.0) |

### Evolution entries (ea-scheduling)

| ts | skill | action | origin | session_id |
|----|-------|--------|--------|------------|
| 2026-06-15T00:25:35Z | ea-scheduling | patch | background_review | 20260615_002459_32c2c0 |
| 2026-06-15T00:36:26Z | ea-scheduling | patch | assistant_tool | hermes-chat-da60ea4e-178e-48ef-b7b2-ec4d0c550397 |

Factory merge: `integrations/hermes/skills/executive-assistant/ea-scheduling/SKILL.md` **v4.9.0** (Patrick GitHub + temporal grounding + workflow/table fixes).

**Follow-up shipped 2026-06-17 (patrick hotpatch):** `google_calendar_find_free_slots` connectors MCP + `GET /api/connectors/calendar/google/free-slots`; ea-scheduling **v4.11.0**; validated Jun 23 Asteme day returns `busy: []` on FreeBusy. Hotpatch: [hotpatch-running-box.md](../vps-sandbox/hotpatch-running-box.md#calendar-freebusy--transparent-events-2026-06-17).

## 2026-06-24 — patrick (ea-scheduling, multi-calendar FreeBusy)

Trace: Ebony / Te'riel Thu Jun 25 — offered 3pm while Asteme wrap busy on `dbenyamin@gmail.com`.

| Symptom | Root cause | Fix layer | Shipped |
|---------|------------|-----------|---------|
| `busy: []` on primary but afternoon blocked on personal Gmail | `find_free_slots` with `items: ["primary"]` only; ea-scheduling skill said primary-only | Code + skill + docs | **2026-06-24:** `calendarAvailability.ts` (default items + `combined`); ea-scheduling **v4.19.0**; REST/MCP docs |
| Duplicate bad send from project board + meeting worker | Playbook triage also called `nylas_send_message` | Process | Deny both; only **`ea-scheduling`** sends; ops retry via unblock |

**Validated locally:** `combined.busy` includes 2:30–7:30pm PT on Jun 25; retry after action-guard deny produced 9am–2pm slots (no 3pm/4pm).

## 2026-06-24 — patrick → factory (daily handoff + mail + kanban)

Learning repo: `db-aeon/joshu-learning-patrick` @ `bb87be51a18b`

| Skill | Action | Factory version |
|-------|--------|-----------------|
| `ea-shutdown` | Full promote — calendar fallback, journal dedup pitfall | **v1.1.0** |
| `ea-morning-review` | Cherry-pick — weekend `plan_date`, pre-rendered plan, Nylas bootstrap; kept scheduling HITL | **v1.2.0** |
| `joshu-mail` | Add reply-all CC pitfall section | **v1.2.0** |
| `ea-project-kanban` | MCP-first kickoff order (A→D) | **v1.4.0** |
| `factory/manifest.yaml` | `release` **0.2.0 → 0.2.1** (bootstrap re-seed on box update) | — |

**Not promoted:** `joshu-profile-rollout.md` (box-only), Patrick `ea-time-block` (factory gather script ahead), Patrick playbook/scheduling (factory ahead).

## 2026-06-16 — patrick (ea-playbook, joshu-brain, joshu-mail, ea-project-kanban)

Learning repo: `db-aeon/joshu-learning-patrick` @ `69ca1f562a04412ba9346fee9fa46baa9964e938`

| Skill | vs Patrick | Factory action |
|-------|------------|----------------|
| `joshu-mail` | Identical | No change |
| `ea-project-kanban` | Identical | No change |
| `joshu-brain` | Patrick v1.6.0 adds self-sent notes retrieval | Promote section + `references/find-user-notes.md` → **v1.6.0** |
| `ea-playbook` | Patrick adds Nylas pitfalls; also reverts factory deterministic ingest | **Selective merge only** → **v2.8.2**; then factory **v2.9.0** unified mail ingress (2026-06-17) |

### ea-playbook (selective)

| Symptom | Root cause | Fix layer | Proposed joshu change |
|---------|------------|-----------|------------------------|
| Dan confirms a time Patrick already booked; stub re-routed to ea-scheduling | Nylas mirror stub of Dan's "confirm that time" reply treated as new scheduling request | Factory skill | Pitfall — verify calendar before routing; close stub if event exists |
| Dan's Nylas outbound replies classified as new work | Factory Dan-as-sender section was Gmail-only | Factory skill | Extend table for Nylas mirror stubs (Patrick+external thread) |

**Not promoted from Patrick:** triage-drain cron wording, removal of mail-ingress Kanban section — factory is ahead per `ea-for-joshu.md`.

### Unified mail ingress (2026-06-17, factory)

Collapsed dual ingest (`ea-sched-ingress` vs `ea-mail-ingress`) → single **`ea-mail-ingress`** queue. Classifier emits hints; Patrick files then spawns **`scheduling_*`** child. Shipped **ea-playbook v2.9.0**, **ea-scheduling v4.10.0**, `classifier.ts` / `triageStub.ts` / `mailCron.ts`. Hotpatched **patrick** same day. See [mail-classifier-taxonomy.md](mail-classifier-taxonomy.md), [ea-skill-future-fixes.md](ea-skill-future-fixes.md).

## 2026-06-16 — patrick (UP.Labs mail ingress trace)

Langfuse: Hermes turn `f670cfae…` · ingress task `t_e5c36d48` · Dan SENT “Copying Patrick to suggest some times” on UP.Labs thread.

| Layer | What happened | Fix |
|-------|---------------|-----|
| **Classifier (deterministic)** | `track`, `category: scheduling`, `project_slug: uplabs-email-assistant` — correct for unified ingress | No ingest fork to `ea-sched-ingress` |
| **Ingress worker (Patrick)** | Never `skill_view('ea-playbook')`; loaded `ea-project-kanban`; full project scaffold; Composio search instead of `mail_*`; 6× `list_events` | **ea-playbook v2.9.0** MAIL INGRESS; trace table in [ea-for-joshu — lessons from traces](ea-for-joshu.md#ea-scheduling--lessons-from-traces-2026-06) |

**Fault split:** ~20% classifier nuance (owner SENT on scheduling thread); ~80% worker/skill execution. Open backlog: [ea-skill-future-fixes.md §3](ea-skill-future-fixes.md#3-content-based-scheduling-routing-in-skills-medium--partially-addressed-2026-06-17), §1 (stale confirmation stubs), §2 (owner outbound).
