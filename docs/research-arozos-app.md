# Research ArozOS app

The **Research** desktop app shows the Research reports of the owner and the recurring reports that the companion runs, and it has one form for a new report. The companion makes and changes the same reports in chat, so the app is a place to look and to fine-tune. It replaces the last30days app. How Research reports and recurring reports work: [`technical-reference/research-reports.md`](technical-reference/research-reports.md).

## Shape

| Piece | Location |
|---|---|
| React UI | `apps/research/` |
| Built assets | `dist/research-app/` → `arozos/subservice/research/app/` (not `dist/research/`, which holds the fonts of Research reports) |
| ArozOS registration | `arozos/subservice/research/moduleInfo.json`, `joshu.app.json`, and `.startscript`, the marker that makes ArozOS run `start.sh`. Without it, ArozOS does not register the app and the desktop icon does nothing (`npm run test:arozos-subservices` checks each app). |
| Static subservice server | `scripts/aroz-static-subservice.mjs` (through `start.sh`) |
| Joshu REST API | `src/research/recurring/routes.ts` and `src/research/routes.ts` → `/joshu/api/research/*` |
| Data | `<files>/Research/` (Research reports) and `<files>/Research/Recurring/` (recurring reports) |
| Icon | `arozos/icons/research.png` (Tango `apps/internet-news-reader.png`) |

Build it with `npm run build:research`, or `npm run dev:research` for the Vite server on port 3017 with `/joshu` proxied to the Joshu API on port 8788.

## What the owner sees

- **The list.** Recurring reports first, each with its parts, its schedule, its state (Active, Paused, or Quiet after 5 runs in a row with nothing new), and the result of its last run. Then the Research reports with their topic, summary, and date. A click on a Research report opens its PDF through the report link.
- **A recurring report.** Its schedule, channel, notes, and the sources of each part (with the reason of each Auto pick). The report updates that the box sent, newest first, with the summary and the themes of each one (the digest of a report update from before November 2026). The stories that the recurring report follows, with the story status of each story in the last run, including the quiet ones. Buttons **Change**, **Pause** or **Resume**, and **Delete**.
- **New report.** One form: the topics (one on each line), **Once** or **Recurring**, the days and the time, **Auto** or a list of sources (Web and news is always in), the channel, and the notes. For **Once**, the form also has **Sections** (one on each line, at most 6, in the order of the report) and notes on what the topic means and what it is not, which go to `POST /joshu/api/research/reports` as `sections` and `notes`. **Create** makes a recurring report and shows its parts and sources, or starts a one-time Research report in the background that Joshu sends on the chosen channel when it is done.

The form offers Slack and Telegram only when the owner has talked to the companion there, because the box sends to the latest Slack or Telegram conversation of the owner (`GET /joshu/api/research/channels`).

## API

Each route checks the ArozOS session of the owner with `verifyArozosDesktopSession`, or allows direct localhost (the plugin tools of the companion call the same routes). See [`vps-sandbox/box-api-edge-security.md`](vps-sandbox/box-api-edge-security.md).

| Route | Use |
|---|---|
| `GET /joshu/api/research/reports?all=1` | Every Research report |
| `POST /joshu/api/research/reports` with `topic`, `channel`, and `sources` | A one-time Research report in the background (answers `202`) |
| `GET /joshu/api/research/recurring` | Every recurring report that is not deleted |
| `POST /joshu/api/research/recurring`, `PATCH /joshu/api/research/recurring/:id` | Make or change a recurring report |
| `POST /joshu/api/research/recurring/:id/pause`, `/resume`, `DELETE /joshu/api/research/recurring/:id` | Pause, resume, or delete |
| `GET /joshu/api/research/recurring/:id/updates`, `/stories` | The report updates and the stories of one recurring report |
| `GET /joshu/api/research/channels` | The channels that the form offers |

## ArozOS desktop registration

- **Module name:** `Research` (`moduleInfo.json` → `"Name"`)
- **Shortcut:** `Research.shortcut` (see [`arozos-desktop-shortcuts.md`](arozos-desktop-shortcuts.md))
