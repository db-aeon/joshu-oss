"""Tool schema for app_gui_action."""

APP_GUI_ACTION_SCHEMA = {
    "name": "app_gui_action",
    "description": (
        "Run an in-app GUI action inside a Joshu desktop app (embedded mode). "
        "Use for compose drafts, opening threads, inbox search, and other manifest guiActions — "
        "not for sending mail or destructive operations. "
        "Prefer this over pasting drafts in chat when assisting inside jMail or other apps. "
        "Example: appId=jmail, action=openCompose, args={subject, body, to}."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "appId": {
                "type": "string",
                "description": "Joshu app id from joshu.app.json (e.g. jmail, schedules)",
            },
            "action": {
                "type": "string",
                "description": "GUI action name declared in manifest agent.guiActions (e.g. openCompose)",
            },
            "args": {
                "type": "object",
                "description": "Optional action arguments (subject, body, messageId, query, …)",
            },
        },
        "required": ["appId", "action"],
    },
}
