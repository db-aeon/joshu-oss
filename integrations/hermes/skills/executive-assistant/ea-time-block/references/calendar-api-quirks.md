# Calendar API quirks (Joshu / Dan's setup)

## Event source of truth: `google_calendar_list_events` (Composio MCP)

Primary source for **what** events exist on a given day. Returns `summary`, `start`, `end`, `blocksAvailability`, `status`.

Joshu HTTP equivalent (when Joshu server is up on the box):

```text
GET /joshu/api/connectors/calendar/google/events?date=YYYY-MM-DD&timezone=America/Los_Angeles
```

**Mirror files** (`connectors/calendar/**/events/*.md`) are named by event ID (UUID), not by calendar date. Globbing for today's events by filename is unreliable. Use mirrors for **links** (`link.path` on meeting blocks) after resolving path via event id — or run `scripts/gather-time-block-input.mjs`, which resolves mirror paths automatically.

`blocksAvailability` is only present in **live API** responses — not in mirror YAML frontmatter.

## FreeBusy: which calendars to query

**Default (2026-06-24+):** omit `items` on `google_calendar_find_free_slots` / `GET …/free-slots`. Joshu queries `primary` + owner `personalEmail` (`.joshu/nylas/profile.json`) + selected/reader Gmail calendars discovered on the connected Google account. Response includes **`calendars.combined`** — union of busy across all queried calendars. **Schedule from `combined.free`**, not `primary.free` alone.

Explicit override when needed:

```text
items: ['primary', 'dbenyamin@gmail.com']
```

**Legacy pitfall:** `items: ['primary']` alone checks only the work calendar (`db@project-aeon.com`). Dan's Asteme and most external meetings live on **`dbenyamin@gmail.com`** — FreeBusy returns `busy: []` on primary while the personal calendar is blocked.

FreeBusy may return empty `busy[]` on a calendar even when events exist if the calendar ID is wrong. Do not trust empty `busy[]` as proof of an open schedule — cross-check with `google_calendar_list_events` or query both calendars.

## Events list vs FreeBusy: what each is for

| Tool | Best for | Limitations |
|------|----------|-------------|
| `google_calendar_list_events` | What events exist, titles, times, transparency | Not authoritative for busy/free (transparent events show as non-blocking) |
| `google_calendar_find_free_slots` | Free/busy availability for scheduling | Per-calendar + **`combined`** (union busy); omit `items` for default multi-calendar scope |

For time-blocking: use **list_events** (or gather script) to discover what exists; use **find_free_slots** only when scheduling new meetings.

## Calendar IDs on this setup

- `primary` / `db@project-aeon.com` — Dan's primary workspace calendar
- `dbenyamin@gmail.com` — Dan's personal Gmail calendar (Asteme, most external meetings)
