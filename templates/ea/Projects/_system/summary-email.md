# Summary email templates

Use with `POST /joshu/api/nylas/messages/send`. **From:** agent Nylas. **To:** owner `primaryWorkEmail` from `.joshu/nylas/profile.json`. **Signature:** appended server-side (companion name, `{owner}'s Joshu`, https://joshu.me) — write plain text in `body` only.

## Morning

**Subject:** `Morning brief — YYYY-MM-DD`

```text
Good morning, {{OWNER_NAME}}.

Top priorities today:
1. …
2. …
3. …

Decisions needed:
- …

Waiting / blocked (from todo tables):
- …

Open triage stubs remaining: N
```

## Evening

**Subject:** `End of day — YYYY-MM-DD`

```text
Good evening, {{OWNER_NAME}}.

Completed today:
- …

Still open:
- …

Waiting on others:
- …

Blockers:
- …

Tomorrow first commit:
- …
```
