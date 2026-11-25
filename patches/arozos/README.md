# ArozOS Joshu patches

Joshu-specific modifications to upstream [ArozOS](https://github.com/tobychui/arozos).
Applied at build time by [`scripts/apply-arozos-patches.sh`](../../scripts/apply-arozos-patches.sh).

| Patch | Upstream base | Description |
|-------|---------------|-------------|
| `joshu-core.patch` | `e3819d1` | System settings hook, desktop splash/overlay recovery, float-window drag/resize stability, media player, stock-module denylist (`HiddenModules`), admin desktop login page `/system/auth/joshu-login` (`src/auth_joshu.go`) |

**License:** These patches are **GPLv3** (derivative of ArozOS). They must ship
with source when you distribute a combined image containing modified ArozOS.

**Upstream pin:** [`UPSTREAM_REF`](UPSTREAM_REF) names the commit. The submodule
`vendor/arozos` points to the same commit.

## Upstream base

The base is `e3819d18` (upstream `master` of 2026-10-21). That commit is the
release `v3.0.2` plus one dependency update. The earlier base was `8894ffe`
(2026-02-04). The upstream branches `v3.0.3`, `v3.0.4`, and `v3.0.5` hold
later development work that upstream has not merged into `master`, so the pin
does not use them.

## What each part of the patch does

| File | Joshu change |
|------|--------------|
| `src/auth_joshu.go` (new) | Admin desktop login page `/system/auth/joshu-login`. |
| `src/mod/modules/module.go` | `HiddenModules`: stock apps that do not register. The list also holds the 30 stock apps that upstream added between `8894ffe` and `e3819d1`, so the update does not change the apps the owner sees. |
| `src/setting.go`, `src/setting_joshu.go` (new), `src/startup.go` | Settings group Joshu with the pages Hermes Gateway and Box State. |
| `src/system.go` | No Vendor page in the About group. |
| `src/web/SystemAO/locale/system_settings.json` | English labels for the Joshu group. |
| `src/web/SystemAO/utilities/mediaPlayer.html`, `src/web/Video/embedded.html` | Video does not start alone, and a saved volume of zero is ignored. |
| `src/web/desktop.html` | Black start screen, cleanup of stuck full-screen layers, stable move and resize of float windows, Joshu folder icons, default volume 0.7. |

The move from `8894ffe` to `e3819d1` dropped one part: the line `.DS_Store` in
`.gitignore`, because upstream has that line now.

## How to move to a newer upstream commit

1. In `vendor/arozos`, discard the applied patch (`git checkout -- .` and
   `git clean -fd src`), fetch upstream, and check out the new commit.
2. Run `git apply --reject ../../patches/arozos/joshu-core.patch`. For each
   `.rej` file, read the old hunk, find the same place in the new code, and
   make the change by hand.
3. Run `git add -N` for the new files, then write the patch with
   `git diff --output=<repo>/patches/arozos/joshu-core.patch` in `vendor/arozos`.
4. Check the patch on a clean copy of the new commit with `git apply --check`,
   and run `bash scripts/apply-arozos-patches.sh`.
5. Update `UPSTREAM_REF`, the table above, and the submodule pointer.
6. Compare the stock module names of the old and the new commit (`init.agi`
   files and `RegisterModule` calls). Add each new name to `HiddenModules`,
   or decide with the product owner to show it.
7. Run `python3 scripts/apply_arozos_joshu_theme.py <copy of src/web>` on a
   copy that also has `system/` next to `web/`. The script prints a line on
   stderr for each upstream text that it did not find. Then compare each file
   in `arozos/web-overlays-vanilla/` that replaces an upstream file with the
   new upstream file.
8. Build with `go build` in `vendor/arozos/src`, and check the `go get` list in
   `deploy/Dockerfile` against the new `go.mod`.

## Start flags and the theme

The box starts ArozOS with `-enable_docker=false -arozcast_turn=false`
([`deploy/scripts/vps-start.sh`](../../deploy/scripts/vps-start.sh),
[`scripts/dev-arozos.sh`](../../scripts/dev-arozos.sh)). Upstream turns on a
Docker management service and a TURN relay (ports 3478 and 5349) by default,
and a box uses neither. The relay flag is only a default: the System Settings
entry "Screen Share Relay" can turn the relay on, so `joshu-settings.js` hides
that entry. When you move the pin, read the flag list of upstream
(`src/flags.go`) for a new service that is on by default.

[`scripts/apply_arozos_joshu_theme.py`](../../scripts/apply_arozos_joshu_theme.py)
patches `ao_module_getSystemThemeColor()` so that a window is light unless the
owner saved the dark theme. Many upstream pages read an empty theme preference
as the dark theme, and the Joshu shell is light.
