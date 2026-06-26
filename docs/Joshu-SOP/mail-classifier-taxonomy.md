# Mail classifier taxonomy (ingest-time)

Deterministic ingest calls `classifyInboundMail()` ([`src/ea/classifier.ts`](../../src/ea/classifier.ts)) on each new message. Output drives routing before stubs/Kanban.

**2026-06 unified ingress:** All actionable mail → **`ea-mail-ingress`** + Triage stub. Classifier emits **hints** (`category`, `project_slug`, `scheduling`); Patrick files and may spawn **`ea-scheduling`** child tasks. Ingest no longer queues **`ea-sched-ingress`**.

## Dispositions

| disposition | Stub | Kanban | Meaning |
|-------------|------|--------|---------|
| `noise` | no | no | Spam, marketing, no action — skip entirely |
| `info` | yes → `_done/` | no | Transactional alert, FYI — archive immediately |
| `track` | yes enriched | **`ea-mail-ingress`** | All actionable mail — filing + optional scheduling child |

Legacy `scheduling` disposition from the model is normalized to `track` at ingest.

## Categories (classifier `category` field — hints only)

| category | Typical use | project_slug hint |
|----------|-------------|-------------------|
| `scheduling` | Meeting times, availability, owner delegates Patrick | `other` if standalone; else project slug |
| `transactional` | info disposition | `other` |
| `security_alert` | info disposition | `other` |
| `marketing` | noise | null |
| `newsletter_broadcast` | info or track | project if reply expected |
| `investor_reply` | track | `joshu-product-development` |
| `networking` | track | `other` |
| `project_work` | track | inferred slug |
| `owner_note` | track | inferred slug |
| `owner_sent_update` | info | existing project journal only |
| `family_logistics` | track | `family-school-logistics` |
| `waitlist_signup` | track | `joshu-waitlist-drip` |
| `product_development` | track | `joshu-product-development` |
| `unknown` | track | `other` |

## Routing rules (code)

- `confidence >= 0.7` required for non-`unknown` routing (low confidence → `track` + `other`)
- `category: scheduling` sets `scheduling_hint` on stub + ingress task body; does **not** route to `ea-sched-ingress`
- Gmail junk labels skip before classifier ([`gmailJunk.ts`](../../src/ea/gmailJunk.ts))
- Duplicate Gmail+Nylas pair → process once ([`mailDedup.ts`](../../src/ea/mailDedup.ts)) — **RFC 5322 `Message-ID`** when present; fallback `subject|minute|bodyHash`

## Langfuse

Trace name: **`ea-mail-classifier`** (tag `joshu-app`).
