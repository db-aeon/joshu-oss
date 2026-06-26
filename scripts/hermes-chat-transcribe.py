#!/usr/bin/env python3
"""
Joshu Hermes Chat STT bridge.

Reads WAV path from argv[1], runs Hermes transcribe_audio() using ~/.hermes config.
Requires HERMES_AGENT_ROOT (Hermes checkout on PYTHONPATH).

 Prints one JSON object to stdout (Hermes result shape).
 Exit code 0 on success, non-zero on failure.
"""

from __future__ import annotations

import json
import os
import sys


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "transcript": "", "error": "missing audio file path"}))
        sys.exit(1)

    wav_path = sys.argv[1]
    root = os.environ.get("HERMES_AGENT_ROOT", "").strip()
    if not root or not os.path.isdir(root):
        print(json.dumps({"success": False, "transcript": "", "error": "HERMES_AGENT_ROOT is unset or not a directory"}))
        sys.exit(1)

    sys.path.insert(0, root)

    try:
        from tools.transcription_tools import transcribe_audio

        result = transcribe_audio(wav_path)
        print(json.dumps(result), flush=True)
        sys.exit(0 if result.get("success") else 2)
    except Exception as exc:
        print(json.dumps({"success": False, "transcript": "", "error": str(exc)}), flush=True)
        sys.exit(3)


if __name__ == "__main__":
    main()
