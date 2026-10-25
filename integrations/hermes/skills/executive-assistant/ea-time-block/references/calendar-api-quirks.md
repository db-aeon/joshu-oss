# Calendar API quirks (Joshu / owner's setup)

## Event source of truth: `google_calendar_list_events` (Joshu connectors MCP)

Primary source for **what** events exist on a given day. Returns `summary`, `start`, `end`, `blocksAvailability`, `status`, `calendarId`, and `accountKey`. Without `connectedAccountId`, the list merges the events of all calendar accounts, and one shared event appears once.

Joshu HTTP equivalent (when Joshu server is up on the box):

```text
GET /joshu/api/connectors/calendar/google/events?date=YYYY-MM-DD&timezone=America/Los_Angeles
```

**Mirror files** (`connectors/calendar/**/events/*.md`) are named by event ID (UUID), not by calendar date. Globbing for today's events by filename is unreliable. Use mirrors for **links** (`link.path` on meeting blocks) after resolving path via event id — or run `scripts/gather-time-block-input.mjs`, which resolves mirror paths automatically.

`blocksAvailability` is only present in **live API** responses — not in mirror YAML frontmatter.

## FreeBusy: which calendars to query

**Default:** omit `items` and `connectedAccountId` on `google_calendar_find_free_slots` / `GET …/free-slots`. Joshu asks each calendar account (personal Gmail, work, …) for `primary` + owner `personalEmail` (`.joshu/nylas/profile.json`) + the selected/reader Gmail calendars of that account. Response includes **`accounts[]`** and **`calendars.combined`** — union of busy across all calendars of all calendar accounts. **Schedule from `combined.free`**, not one calendar alone. `incomplete: true` means a calendar account failed; its busy time is missing.

## Several calendar accounts

An owner can connect more than one Google account for calendars. Each calendar account sees only its own calendars and the calendars shared with it. Before 2026-10, Joshu read only the default calendar account, so a work calendar on a second account was invisible. Now reads cover all calendar accounts by default, and `google_calendar_create_event` / `google_calendar_update_event` write with the calendar account that can write the target calendar. The Composio Tool Router (`COMPOSIO_MULTI_EXECUTE_TOOL`) cannot choose the calendar account — do not use it for calendar writes or for `GOOGLECALENDAR_EVENTS_GET`; read one event with `google_calendar_get_event`. Never write calendar events in the browser.

Explicit override when needed:

```text
items: ['primary', 'owner personal Gmail calendar']
```

**Legacy pitfall:** `items: ['primary']` alone checks only the work calendar (`owner work email`). owner's Asteme and most external meetings live on **`owner personal Gmail calendar`** — FreeBusy returns `busy: []` on primary while the personal calendar is blocked.

FreeBusy may return empty `busy[]` on a calendar even when events exist if the calendar ID is wrong. Do not trust empty `busy[]` as proof of an open schedule — cross-check with `google_calendar_list_events` or query both calendars.

## Events that end in another time zone (flights)

A flight starts in the time zone of the departure airport and ends in the time zone of the arrival airport, and airline times are local times. `google_calendar_create_event` and `google_calendar_update_event` take `endTimezone` for the time zone of `end`, and `timezone` stays the time zone of `start`. Google labels both ends with `timezone`, so the event details can show the arrival converted to the departure time zone, but the instants and the calendar grid are correct. A time block planner that reads a flight from `google_calendar_list_events` gets RFC3339 times with offsets, so convert them to the owner timezone before you place the flight in the day. The rule for writing flights is in skill `ea-scheduling`, section "Flights and other events that end in another time zone".

## Events list vs FreeBusy: what each is for

| Tool | Best for | Limitations |
|------|----------|-------------|
| `google_calendar_list_events` | What events exist, titles, times, transparency | Not authoritative for busy/free (transparent events show as non-blocking) |
| `google_calendar_find_free_slots` | Free/busy availability for scheduling | Per-calendar + **`combined`** (union busy); omit `items` for default multi-calendar scope |

For time-blocking: use **list_events** (or gather script) to discover what exists; use **find_free_slots** only when scheduling new meetings.

## Calendar IDs on this setup

- `primary` / `owner work email` — owner's primary workspace calendar
- `owner personal Gmail calendar` — owner's personal Gmail calendar (Asteme, most external meetings)
