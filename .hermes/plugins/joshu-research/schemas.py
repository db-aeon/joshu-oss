# Hints of the companion (change content-router, design decision D8).
_HINTS_PROPERTY = {
    "type": "array",
    "items": {"type": "string"},
    "description": (
        "Hints from skill joshu-content-router and skill joshu-content-cache that fit this "
        "request, one short line each, for example 'Polymarket for prediction market odds'. A "
        "hint adds a kind of source to the report or names the provider to prefer for one. "
        "Leave out when no hint fits."
    ),
}


RESEARCH_REPORT_MAKE_SCHEMA = {
    "name": "research_report_make",
    "description": (
        "Make a Research report about a topic from web sources (news, research, official and "
        "company pages), with a citation for each fact and a small box of social posts. Waits "
        "until the report is done (a few minutes, at most "
        "10). Returns the summary, the report link, the PDF path for mail attachments, and the "
        "state of each source. On failure returns ok=false with the step that failed. Follow "
        "skill research-report to answer the owner."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "topic": {
                "type": "string",
                "description": "The topic in a few plain words, for example 'electric bike subscriptions'.",
            },
            "notes": {
                "type": "string",
                "description": (
                    "What the owner said about the topic, in the words of the owner: what it means, "
                    "what it is not, and what to look at, for example 'CLARA Analytics, the claims AI "
                    "company, not the Clara agent of Hippo'. No research and no style words of your "
                    "own. Leave out when the owner said nothing."
                ),
            },
            "sections": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Only when the owner asks for a fixed structure in so many words: the sections, "
                    "in order, in the owner's words, for example ['funding', 'product launches', "
                    "'competitors']. At most 6. Guidance such as 'cover this space' or 'start with "
                    "those points' goes in notes instead. Leave out to let the report pick its own themes."
                ),
            },
            "hints": _HINTS_PROPERTY,
            "web_provider": {
                "type": "string",
                "enum": ["exa", "you.com"],
                "description": (
                    "The web search of the report: 'exa' (the default) or 'you.com'. Only when the "
                    "owner asks for You.com web search in so many words. Leave out otherwise."
                ),
            },
        },
        "required": ["topic"],
    },
}

RESEARCH_REPORT_FIND_SCHEMA = {
    "name": "research_report_find",
    "description": (
        "Find earlier Research reports by topic words or a date (YYYY-MM-DD), without new "
        "research. An empty query lists the latest reports. Returns the same fields as "
        "research_report_make for each match."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Topic words or a date, for example 'electric bike' or '2026-11-02'.",
            }
        },
        "required": [],
    },
}

# Recurring reports and report updates (change recurring-research-reports, design decision D13).

_SOURCES_DESCRIPTION = (
    "'auto' to let the box pick the sources of each topic once, or the full list of sources "
    "from: web (Web and news), papers (Research papers), company (Company data), reddit, x, "
    "youtube, tiktok, instagram, or 'goal:' and a kind of source, for example "
    "'goal:prediction market odds' (at most 5). Web and news is always in. To add or remove one source, "
    "send the full new list."
)

RESEARCH_RECURRING_SAVE_SCHEMA = {
    "name": "research_recurring_save",
    "description": (
        "Make a recurring report that follows one or more topics on a schedule and sends a "
        "report update with only the stories that are new or developing since the last one. "
        "With 'id', change that recurring report: only the fields you send change. Returns the "
        "report with its parts (one for each topic) and the sources of each part with the "
        "reason of the Auto picks, the schedule in words, the channel, and the time of the next "
        "report update (nextRunAt). Follow skill research-report to confirm the setup."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "id": {"type": "string", "description": "The id of the recurring report to change (from research_recurring_list). Leave out to make a new one."},
            "topics": {
                "type": "array",
                "items": {"type": "string"},
                "description": "The full list of topics, one part each, in the order the owner wants them. A company with its competitors and its market is one topic; the box finds and searches the competitors itself. A changed topic is a new part.",
            },
            "days": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Days of the week, for example ['mon','tue','wed','thu','fri'] or ['monday']. Leave out or [] for every day.",
            },
            "times": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Times of day in the owner timezone, for example ['07:00'] or ['07:00','17:00']. All times need the same minutes.",
            },
            "sources": {"description": _SOURCES_DESCRIPTION},
            "channel": {
                "type": "string",
                "enum": ["email", "sms", "slack", "telegram"],
                "description": "Where report updates go: leave out for email (the default), or the channel that the owner names, for example 'text it to me' is sms.",
            },
            "notes": {
                "type": "string",
                "description": "What the owner said about content and format, and about what a topic means or is not, in the words of the owner, for example 'at most 8 items, one line on why each one matters for my startup' or 'CLARA Analytics is the claims AI company, not the Clara agent of Hippo'. No recipients, tools, or budgets, and no research, competitor names, or style words of your own. Send the full new notes to change them.",
            },
            "nothing_new_line": {
                "type": "boolean",
                "description": "True when the owner wants a short message when nothing is new. Default: no message.",
            },
            "name": {"type": "string", "description": "A short name. Default: made from the topics."},
            "hints": {**_HINTS_PROPERTY, "description": _HINTS_PROPERTY["description"] + " Send the full new list to change them."},
        },
        "required": [],
    },
}

RESEARCH_RECURRING_LIST_SCHEMA = {
    "name": "research_recurring_list",
    "description": (
        "List the recurring reports of the owner with their ids, parts, sources, schedule, "
        "channel, notes, state (active or paused, and quiet), the last run, and lastUpdateId "
        "(the last report update, for research_update_pdf)."
    ),
    "parameters": {"type": "object", "properties": {}, "required": []},
}

RESEARCH_RECURRING_STATE_SCHEMA = {
    "name": "research_recurring_state",
    "description": (
        "Pause, resume, or delete a recurring report. A paused report makes no run until it is "
        "resumed. A delete stops the runs and keeps the saved report updates in the files of "
        "the owner."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "id": {"type": "string", "description": "The id from research_recurring_list."},
            "action": {"type": "string", "enum": ["pause", "resume", "delete"]},
        },
        "required": ["id", "action"],
    },
}

RESEARCH_UPDATE_MAKE_SCHEMA = {
    "name": "research_update_make",
    "description": (
        "Make a report update against an earlier Research report: the stories that are new or "
        "developing since that report, from the same sources. Use it when the owner asks for "
        "research on the topic of an earlier Research report (find it first with "
        "research_report_find). Waits for the result (at most 10 minutes). Returns the digest "
        "with links, the counts of new and developing stories, the update id for "
        "research_update_pdf, and the state of each source. On failure returns ok=false with "
        "the step that failed."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "report_id": {"type": "string", "description": "The id of the earlier Research report."},
            "channel": {
                "type": "string",
                "enum": ["email", "sms", "slack", "telegram"],
                "description": "The channel of the request, for the format of the digest.",
            },
        },
        "required": ["report_id"],
    },
}

RESEARCH_UPDATE_PDF_SCHEMA = {
    "name": "research_update_pdf",
    "description": (
        "Make the PDF of one report update (the full update): every new and developing story "
        "with its pages and posts, and a chart for each part over the earlier report updates. "
        "Returns the PDF path for mail attachments (pdfDesktopPath) and a report link that "
        "opens the PDF without a sign-in."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "update": {
                "type": "string",
                "description": "The update id: lastUpdateId from research_recurring_list, or updateId from research_update_make.",
            }
        },
        "required": ["update"],
    },
}
