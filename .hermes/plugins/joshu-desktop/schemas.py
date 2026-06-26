"""Tool schema for desktop_open."""

DESKTOP_OPEN_SCHEMA = {
    "name": "desktop_open",
    "description": (
        "Open a Joshu desktop app or file on the user's ArozOS screen. "
        "Use for module opens (jMail, jWeb, jWhiteboard, Files, Connectors, …) "
        "and for presenting a specific file under joshu's files (e.g. Planning/foo.excalidraw). "
        "Prefer this over telling the user to double-click. "
        "For vague file requests, search gbrain first, then call with the resolved path."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "kind": {
                "type": "string",
                "enum": ["module", "file"],
                "description": "module = launch a desktop app; file = open a path in joshu's files",
            },
            "target": {
                "type": "string",
                "description": (
                    "Module display name (jMail, jWeb, jWhiteboard, File Manager, Connectors, …) "
                    "or relative file path (Planning/time-block-2026-06-21.excalidraw)"
                ),
            },
        },
        "required": ["kind", "target"],
    },
}
