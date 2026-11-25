#!/usr/bin/env python3
"""Test of the light theme patch in scripts/apply_arozos_joshu_theme.py (change arozos-upstream-update).

The test gives _patch_ao_module_default_theme() the function of upstream ArozOS e3819d1, then runs
the patched function in Node with each saved theme. It needs no browser and no ArozOS build.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

UPSTREAM = """// ao_module_getSystemThemeColor(callback) => Get the theme color
function ao_module_getSystemThemeColor(callback){
    $.get("../../system/file_system/preference?key=file_explorer/theme",function(data){
            callback(data);
    });
}
"""

spec = importlib.util.spec_from_file_location("theme", REPO / "scripts" / "apply_arozos_joshu_theme.py")
theme = importlib.util.module_from_spec(spec)
spec.loader.exec_module(theme)


def answers(source: str) -> dict:
    """Run the function with each saved value, and return what the callback got."""
    runner = (
        "const out = {};"
        "for (const saved of ['', 'whiteTheme', 'darkTheme', 'somethingElse']) {"
        "  const $ = { get: (_url, done) => done(saved) };"
        "  new Function('$', 'out', 'saved', source + "
        "    '; ao_module_getSystemThemeColor(function (c) { out[saved] = c; });')($, out, saved);"
        "}"
        "console.log(JSON.stringify(out));"
    )
    script = "const source = " + json.dumps(source) + ";" + runner
    done = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True)
    return json.loads(done.stdout)


with tempfile.TemporaryDirectory() as tmp:
    web = Path(tmp)
    (web / "script").mkdir()
    target = web / "script" / "ao_module.js"
    target.write_text(UPSTREAM, encoding="utf-8")

    # Upstream gives the saved value as it is, so an empty value is not "whiteTheme".
    assert answers(UPSTREAM)[""] == "", "the stand-in of upstream behaves like upstream"

    theme._patch_ao_module_default_theme(web)
    patched = target.read_text(encoding="utf-8")
    assert theme.AO_MODULE_THEME_MARKER in patched, "the patch applied"
    assert answers(patched) == {
        "": "whiteTheme",
        "whiteTheme": "whiteTheme",
        "darkTheme": "darkTheme",
        "somethingElse": "whiteTheme",
    }, answers(patched)

    # A second run changes nothing.
    theme._patch_ao_module_default_theme(web)
    assert target.read_text(encoding="utf-8") == patched, "the patch applies once"

    # A web folder with no ao_module.js is not an error.
    theme._patch_ao_module_default_theme(web / "missing")

print("arozos theme patch: all checks passed")
