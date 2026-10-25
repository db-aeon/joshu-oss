"""Tool schemas for owner mobile browser handoff."""

BROWSER_HANDOFF_REQUEST_SCHEMA = {
    "name": "browser_handoff_request",
    "description": (
        "Hand the shared browser tab to the owner on mobile for live HITL — payment, login, 2FA, "
        "irreversible confirms, or any sensitive owner-only browser step. Snapshots current page URL/title, "
        "returns a signed handoff URL for email/chat. Agent navigate/click/type is blocked until the owner "
        "taps I'm done or the handoff expires. Call after staging the page the owner should see."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "instructions": {
                "type": "string",
                "description": (
                    "Concise owner brief: site, what to verify, what action to take, policy caps "
                    "(price, dates, cancellation, refund amount, etc.)."
                ),
            },
            "kanban_task_id": {
                "type": "string",
                "description": "Optional Kanban task id. A Kanban worker can leave it out, because the plugin then sends HERMES_KANBAN_TASK.",
            },
        },
        "required": ["instructions"],
    },
}

BROWSER_HANDOFF_STATUS_SCHEMA = {
    "name": "browser_handoff_status",
    "description": (
        "Poll owner mobile browser handoff status (pending, completed, expired, cancelled). "
        "After completed, browser_snapshot to verify outcome before kanban_complete."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "handoff_id": {
                "type": "string",
                "description": "Handoff id returned by browser_handoff_request.",
            },
        },
        "required": ["handoff_id"],
    },
}

BROWSER_HANDOFF_COMPLETE_SCHEMA = {
    "name": "browser_handoff_complete",
    "description": (
        "Mark an owner mobile browser handoff complete when the owner confirms done in SMS, jChat, "
        "or voice — they do not need to tap I'm done on the handoff link. Unlocks agent browser "
        "navigate/click. Call as soon as the owner clearly says they finished the handoff step."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "handoff_id": {
                "type": "string",
                "description": (
                    "Handoff id from browser_handoff_request. Omit when only one handoff is pending "
                    "and the owner just confirmed completion."
                ),
            },
            "owner_message": {
                "type": "string",
                "description": (
                    "Optional verbatim owner text (e.g. I'm done with RapidAPI). Used to complete "
                    "the pending handoff when handoff_id is omitted."
                ),
            },
        },
        "required": [],
    },
}
