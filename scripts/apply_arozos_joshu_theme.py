#!/usr/bin/env python3
"""
Copy jōshu ArozOS web overlay into an ArozOS web/ tree and ensure desktop.html links it.

Usage:
  python3 scripts/apply_arozos_joshu_theme.py /path/to/arozos-template/web

Do not use a filename starting with `joshu-` under paths served via the Joshu
subservice: `/joshu/joshu-*.css` is rewritten to `/joshu/-*.css` and 404s.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
from pathlib import Path

BRANDED_THEME_FILE = "aroz-paper-shell.css"
VANILLA_THEME_FILE = "aroz-vanilla-shell.css"
def _resolve_theme_paths(root: Path) -> tuple[Path, str, Path, bool]:
    """Return (overlay_dir, theme_file, asset_root, branded)."""
    design_pack = os.environ.get("JOSHU_DESIGN_PACK", "").strip()
    if design_pack:
        asset_root = Path(design_pack).resolve()
        overlay = asset_root / "arozos" / "web-overlays"
        return overlay, BRANDED_THEME_FILE, asset_root, True
    overlay = root / "arozos" / "web-overlays-vanilla"
    return overlay, VANILLA_THEME_FILE, root, False


OVERLAY_VERSION = "20260621e"
FOLDER_ICON_VERSION = "2"
FWCSS_NEEDLE = '<link id="fwcss" rel="stylesheet" href="./script/ao.css">'
SHELL_SCRIPTS = (
    "aroz-taskbar-focus.js",
    "aroz-desktop-icon-tooltips.js",
    "aroz-desktop-overlay-guard.js",
    "aroz-onboarding-launch.js",
    "aroz-jchat-tray.js",
)
OLD_LINK_PATTERNS = (
    r'<link rel="stylesheet" href="\./joshu-desktop-theme\.css">\s*',
    r'<link rel="stylesheet" href="\./joshu-desktop-theme\.css">',
)
FILE_EXPLORER_TANGO_MARKER = "<!-- joshu-file-explorer-tango-icons -->"
DESKTOP_FOLDER_MARKER = "<!-- joshu-desktop-tango-folder-icons -->"
FOLDER_EMPTY_PATH = f"img/joshu/folder.png?v={FOLDER_ICON_VERSION}"
FOLDER_OPEN_PATH = f"img/joshu/folder-open.png?v={FOLDER_ICON_VERSION}"


def _has_theme_link(html: str, theme_file: str) -> bool:
    return f'href="./{theme_file}' in html


def _patch_desktop_tango_folder_icons(text: str) -> str:
    """Route desktop wallpaper folders to versioned Joshu Tango PNGs; sync src on noflash refresh."""
    text = re.sub(
        r'imagePath = "img/desktop/system_icon/folder\.png(?:\?[^"]*)?";',
        f'imagePath = "{FOLDER_EMPTY_PATH}";',
        text,
    )
    text = re.sub(
        r'imagePath = "img/desktop/system_icon/folder-with-content\.png(?:\?[^"]*)?";',
        f'imagePath = "{FOLDER_OPEN_PATH}";',
        text,
    )
    text = re.sub(
        r'imagePath = "img/joshu/folder\.png(?:\?[^"]*)?";',
        f'imagePath = "{FOLDER_EMPTY_PATH}";',
        text,
    )
    text = re.sub(
        r'imagePath = "img/joshu/folder-open\.png(?:\?[^"]*)?";',
        f'imagePath = "{FOLDER_OPEN_PATH}";',
        text,
    )

    skip_old = (
        '                    if (updateObject.attr("filedata") == compressedFiledata){\n'
        "                        //Identical. Skipping\n"
        "                    }else{"
    )
    skip_new = (
        '                    if (updateObject.attr("filedata") == compressedFiledata){\n'
        "                        //Identical. Skipping layout rewrite but sync glyph path.\n"
        '                        updateObject.find(".launchIconImage").attr("src", imagePath);\n'
        "                    }else{"
    )
    if skip_old in text:
        text = text.replace(skip_old, skip_new)

    top_line = 'updateObject.css("top", screenY + "px");'
    src_sync = 'updateObject.find(".launchIconImage").attr("src", imagePath);'
    if top_line in text:
        block_start = text.index(top_line)
        block_end = text.index("}else{", block_start)
        block = text[block_start:block_end]
        if src_sync not in block:
            text = text.replace(
                top_line + "\n",
                top_line + "\n                        " + src_sync + "\n",
                1,
            )

    if DESKTOP_FOLDER_MARKER not in text:
        text = text.replace("<head>", f"<head>\n    {DESKTOP_FOLDER_MARKER}", 1)

    ws_needle = (
        '                $(".launchIcon").each(function(){\n'
        "                    if (thumbData[1].length > 0){\n"
        '                        if ($(this).attr("filename") == thumbData[0]){'
    )
    ws_patch = (
        '                $(".launchIcon").each(function(){\n'
        '                    if ($(this).attr("type") === "folder") {\n'
        "                        return;\n"
        "                    }\n"
        "                    if (thumbData[1].length > 0){\n"
        '                        if ($(this).attr("filename") == thumbData[0]){'
    )
    if ws_needle in text and 'type") === "folder"' not in text.split("thumbRenderWebSocket.onmessage")[1].split("thumbRenderWebSocket.onclose")[0]:
        text = text.replace(ws_needle, ws_patch, 1)

    fb_needle = (
        "        function startFallbackThumbnailLoader(){\n"
        '                $(".launchIcon").each(function(){\n'
        '                    let fd = JSON.parse(decodeURIComponent($(this).attr("filedata")))'
    )
    fb_patch = (
        "        function startFallbackThumbnailLoader(){\n"
        '                $(".launchIcon").each(function(){\n'
        '                    if ($(this).attr("type") === "folder") {\n'
        "                        return;\n"
        "                    }\n"
        '                    let fd = JSON.parse(decodeURIComponent($(this).attr("filedata")))'
    )
    if fb_needle in text and 'startFallbackThumbnailLoader' in text:
        fb_body = text.split("function startFallbackThumbnailLoader()")[1].split("function openfm()")[0]
        if 'type") === "folder"' not in fb_body:
            text = text.replace(fb_needle, fb_patch, 1)

    return text


def _refresh_desktop_overlay_links(text: str, theme_file: str, theme_link: str) -> str:
    text = re.sub(
        rf'<link rel="stylesheet" href="\./(?:{re.escape(BRANDED_THEME_FILE)}|{re.escape(VANILLA_THEME_FILE)})(?:\?[^"]*)?">',
        theme_link,
        text,
    )
    for script_name in SHELL_SCRIPTS:
        versioned = f'./{script_name}?v={OVERLAY_VERSION}'
        text = re.sub(
            rf'<script defer src="\./{re.escape(script_name)}(?:\?[^"]*)?"></script>',
            f'<script defer src="{versioned}"></script>',
            text,
        )
    return text


def _copy_joshu_system_setting(web: Path, asset_root: Path) -> None:
    """Joshu System Setting pages (Box State) under SystemAO/joshu/."""
    src = asset_root / "arozos" / "system-setting"
    if not src.is_dir():
        return
    dest = web / "SystemAO" / "joshu"
    dest.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        if item.is_file():
            shutil.copyfile(item, dest / item.name)


def _merge_joshu_system_settings_locale(web: Path, asset_root: Path) -> None:
    """Merge Joshu menu/tab strings into System Setting locale (runtime web tree)."""
    overlay_path = asset_root / "arozos" / "locale" / "system_settings_joshu_overlay.json"
    locale_path = web / "SystemAO" / "locale" / "system_settings.json"
    if not overlay_path.is_file() or not locale_path.is_file():
        return

    data = json.loads(locale_path.read_text(encoding="utf-8"))
    overlay = json.loads(overlay_path.read_text(encoding="utf-8"))
    keys = data.setdefault("keys", {})

    for lang, patch in overlay.items():
        if lang not in keys or not isinstance(patch, dict):
            continue
        for section in ("strings", "titles", "placeholder"):
            section_patch = patch.get(section)
            if not isinstance(section_patch, dict):
                continue
            keys[lang].setdefault(section, {})
            keys[lang][section].update(section_patch)

    locale_path.write_text(json.dumps(data, indent=4, ensure_ascii=False) + "\n", encoding="utf-8")


def _patch_file_explorer_tango_icons(web: Path) -> None:
    """Use Tango PNGs in File Manager list/details (default view), not Semantic UI glyphs."""
    path = web / "SystemAO" / "file_system" / "file_explorer.html"
    if not path.is_file():
        return
    text = path.read_text(encoding="utf-8")

    folder_src = f'../../{FOLDER_EMPTY_PATH}'
    # Upgrade earlier patches that pointed at stock files_icon paths.
    text = text.replace(
        'src="../../img/desktop/files_icon/${filesIconTheme}/folder.png"',
        f'src="{folder_src}"',
    )
    text = re.sub(
        r'src="\.\./\.\./img/joshu/folder\.png(?:\?[^"]*)?"',
        f'src="{folder_src}"',
        text,
    )

    if FILE_EXPLORER_TANGO_MARKER in text:
        path.write_text(text, encoding="utf-8")
        return

    folder_img = (
        f'<img src="{folder_src}" alt="" '
        'style="width:20px;height:20px;margin-right:12px;object-fit:contain;vertical-align:middle;">'
    )
    file_img = (
        '${ext == "shortcut" ? `<i class="${icon} icon" style="margin-right:12px;"></i>` : '
        '`<img src="../../img/desktop/files_icon/${filesIconTheme}/${icon}.png" alt="" '
        'style="width:20px;height:20px;margin-right:12px;object-fit:contain;vertical-align:middle;">`}'
    )

    replacements = (
        (
            '<i class="${icon} icon" style="margin-right:12px; color:#eab54e;"></i>  '
            '<span class="filename">${displayName}</span> ${shareicon}',
            f"{folder_img}  <span class=\"filename\">${{displayName}}</span> ${{shareicon}}",
        ),
        (
            '<i class="${icon} icon" style="margin-right:12px; color:#eab54e;"></i> '
            '<span class="filename">${filename}</span></td>',
            f"{folder_img} <span class=\"filename\">${{filename}}</span></td>",
        ),
        (
            '<i class="${icon} icon" style="margin-right:12px;"></i>  \n'
            '                                <span class="filename">${displayName}</span>  ${shareicon}',
            f"{file_img}  \n"
            '                                <span class="filename">${displayName}</span>  ${shareicon}',
        ),
        (
            '<i class="${icon} icon" style="margin-right:12px;"></i>  '
            '<span class="filename">${filename}</span></td>',
            f"{file_img}  <span class=\"filename\">${{filename}}</span></td>",
        ),
    )

    for old, new in replacements:
        if old not in text:
            print(f"[joshu] file_explorer patch: pattern not found ({old[:48]}…)", file=sys.stderr)
            continue
        text = text.replace(old, new, 1)

    text = text.replace("<head>", f"<head>\n    {FILE_EXPLORER_TANGO_MARKER}", 1)
    path.write_text(text, encoding="utf-8")


def _copy_joshu_desktop_file_icons(web: Path, asset_root: Path, branded: bool) -> None:
    if not branded:
        return
    icons_src = asset_root / "arozos" / "desktop-icons"
    if not icons_src.is_dir():
        return
    for icon in icons_src.rglob("*"):
        if not icon.is_file() or icon.suffix.lower() != ".png":
            continue
        rel = icon.relative_to(icons_src)
        dest = web / "img" / "desktop" / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(icon, dest)


def _copy_joshu_chat_portrait(web: Path, root: Path, branded: bool) -> None:
    if not branded:
        return
    """Tray bubble + jChat fallback portrait at a stable ArozOS web path."""
    src = root / "apps" / "hermes-chat" / "public" / "portrait-fallback.jpg"
    if not src.is_file():
        return
    dest_dir = web / "img" / "joshu"
    dest_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dest_dir / "chat-portrait.jpg")


def _copy_joshu_icons(web: Path, asset_root: Path, branded: bool) -> None:
    if not branded:
        return
    icons_src = asset_root / "arozos" / "icons"
    if not icons_src.is_dir():
        return
    dest = web / "img" / "joshu"
    dest.mkdir(parents=True, exist_ok=True)
    for icon in icons_src.iterdir():
        if icon.is_file() and icon.suffix.lower() in {".svg", ".png", ".webp"}:
            shutil.copyfile(icon, dest / icon.name)


def _copy_tango_icon_library(web: Path, root: Path) -> None:
    lib_src = root / "arozos" / "tango-icons"
    if not lib_src.is_dir():
        return
    dest = web / "img" / "tango"
    for item in lib_src.rglob("*"):
        if not item.is_file():
            continue
        rel = item.relative_to(lib_src)
        out = dest / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(item, out)


def _replace_init_splash(web: Path, overlay: Path) -> None:
    """Swap stock init.jpg for plain black tile when bundled."""
    src = overlay / "init-black.jpg"
    dest = web / "img" / "desktop" / "bg" / "init.jpg"
    if src.is_file() and dest.parent.is_dir():
        shutil.copyfile(src, dest)


def _inject_before_body_close(html: str, snippet: str, marker: str) -> str:
    if marker in html or "</body>" not in html:
        return html
    return html.replace("</body>", snippet + "\n</body>", 1)


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: apply_arozos_joshu_theme.py <web-root>", file=sys.stderr)
        sys.exit(2)
    web = Path(sys.argv[1]).resolve()
    if not web.is_dir():
        print(f"[joshu] web root not a directory: {web}", file=sys.stderr)
        sys.exit(1)

    root = Path(__file__).resolve().parent.parent
    overlay, theme_file, asset_root, branded = _resolve_theme_paths(root)
    theme_link = f'<link rel="stylesheet" href="./{theme_file}?v={OVERLAY_VERSION}">'
    src_css = overlay / theme_file
    if not src_css.is_file():
        print(f"[joshu] missing theme file: {src_css}", file=sys.stderr)
        sys.exit(1)

    shutil.copyfile(src_css, web / theme_file)
    _copy_joshu_system_setting(web, root)
    _merge_joshu_system_settings_locale(web, root)
    _copy_joshu_desktop_file_icons(web, asset_root if branded else root, branded)
    _patch_file_explorer_tango_icons(web) if branded else None
    _copy_joshu_icons(web, asset_root if branded else root, branded)
    _copy_joshu_chat_portrait(web, root, branded)
    _copy_tango_icon_library(web, root)
    _replace_init_splash(web, overlay)
    for script_name in SHELL_SCRIPTS:
        src_js = overlay / script_name
        if src_js.is_file():
            shutil.copyfile(src_js, web / script_name)

    # Drop obsolete filename if present from a previous apply.
    old_path = web / "joshu-desktop-theme.css"
    if old_path.is_file():
        old_path.unlink()

    desktop = web / "desktop.html"
    text = desktop.read_text(encoding="utf-8")
    for pat in OLD_LINK_PATTERNS:
        text = re.sub(pat, "", text)
    text = re.sub(
        r'\s*<script defer src="\./aroz-desktop-folder-icons\.js"></script>',
        "",
        text,
    )

    obsolete_js = web / "aroz-desktop-folder-icons.js"
    if obsolete_js.is_file():
        obsolete_js.unlink()

    text = _patch_desktop_tango_folder_icons(text) if branded else text
    text = _refresh_desktop_overlay_links(text, theme_file, theme_link)

    for script_name in SHELL_SCRIPTS:
        if (overlay / script_name).is_file():
            versioned = f"./{script_name}?v={OVERLAY_VERSION}"
            script_tag = f'    <script defer src="{versioned}"></script>'
            text = _inject_before_body_close(text, script_tag, script_name)

    if not _has_theme_link(text, theme_file):
        if FWCSS_NEEDLE not in text:
            print("[joshu] desktop.html: expected fwcss link not found; theme not injected", file=sys.stderr)
            sys.exit(1)
        text = text.replace(FWCSS_NEEDLE, FWCSS_NEEDLE + f"\n    {theme_link}", 1)

    desktop.write_text(text, encoding="utf-8")
    mode = "branded" if branded else "vanilla"
    print(f"[joshu] applied {mode} shell theme ({theme_file}) -> {web}")


if __name__ == "__main__":
    main()
