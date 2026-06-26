#!/usr/bin/env python3
"""
Joshu Hermes Chat TTS bridge.

Reads UTF-8 text from stdin, generates speech via Hermes text_to_speech_tool()
(same providers as ~/.hermes/config.yaml tts:).

 Prints one JSON line: {"success": true, "file_path": "..."} or {"success": false, "error": "..."}.

 Requires HERMES_AGENT_ROOT.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile


def main() -> None:
    text = sys.stdin.read()
    if not text.strip():
        print(json.dumps({"success": False, "error": "empty text"}))
        sys.exit(1)

    root = os.environ.get("HERMES_AGENT_ROOT", "").strip()
    if not root or not os.path.isdir(root):
        print(json.dumps({"success": False, "error": "HERMES_AGENT_ROOT is unset or not a directory"}))
        sys.exit(1)

    sys.path.insert(0, root)

    fd, out_path = tempfile.mkstemp(suffix=".mp3", prefix="joshu-tts-")
    os.close(fd)

    try:
        from tools.tts_tool import text_to_speech_tool

        raw = text_to_speech_tool(text.strip(), output_path=out_path)
        data = json.loads(raw)
        if not data.get("success"):
            err = data.get("error") or data.get("message") or raw
            print(json.dumps({"success": False, "error": str(err)}), flush=True)
            sys.exit(2)
        fp = data.get("file_path") or out_path
        print(json.dumps({"success": True, "file_path": fp}), flush=True)
        sys.exit(0)
    except Exception as exc:
        print(json.dumps({"success": False, "error": str(exc)}), flush=True)
        sys.exit(3)


if __name__ == "__main__":
    main()
