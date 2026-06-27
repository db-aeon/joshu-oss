# ArozOS video playback and mute behavior

This document records how video playback works in the Joshu ArozOS stack, why
“unmute does nothing” often appears, and what we changed in this repo to fix it.

Related: [`docs/local-installation.md`](local-installation.md) (`npm run dev:arozos`),
[`scripts/dev-arozos.sh`](../scripts/dev-arozos.sh), upstream sources under
[`vendor/arozos`](../vendor/arozos).

## Two different players

Opening a video file in ArozOS may launch one of two UIs. Both can play
`.mp4` / `.webm`, but they are separate modules:

| Module | Window title / UI | Launch path | Typical use |
|--------|-------------------|-------------|-------------|
| **Video Player** (utility) | “ArOZ Media Player”, native HTML5 `<video controls>` | `SystemAO/utilities/mediaPlayer.html` | Registered in `vendor/arozos/src/module.util.go` for `.mp4`, `.webm`, `.ogv` |
| **Video** (media app) | “Video - …”, DPlayer chrome | `Video/embedded.html` (embedded) or `Video/index.html` (full window) | Registered via `Video/init.agi` for `.mp4`, `.webm`, `.ogg`, `.mkv`, `.avi`, `.rmvb` |

Users can also set a **default opener** per extension in ArozOS (stored per user as
`module/default/<username>/<ext>`). If `.mp4` defaults to **Video** instead of
**Video Player**, you get DPlayer even when you expect the minimal utility player.

When a file is opened with input files attached, the **Video** full app redirects
to embedded mode:

```159:163:vendor/arozos/src/web/Video/index.html
            var infile = ao_module_loadInputFiles();
            if (infile != null){
                window.location.href = "embedded.html" + window.location.hash;
            }
```

So “I opened a video and it autoplays muted” is often the **Video / DPlayer**
path, not `mediaPlayer.html`.

## Why unmute seemed broken (no app-level mute lock)

ArozOS does **not** set `video.muted = true` or disable the mute control in code.
The symptoms usually come from the combination below.

### 1. Browser autoplay policy (main cause)

Modern browsers block **audible** autoplay unless the user has recently interacted
with the page (or site). Embedded apps run inside a floating **iframe** on the
desktop (`desktop.html` creates `<iframe src="…" allowfullscreen="true">` without
`allow="autoplay"`).

Historically the utility player used:

```html
<video id="player" autoplay controls></video>
```

and called `playFile()` on load, which set `src` immediately. That behaves like
autoplay inside the iframe: playback may start **muted**, and the native unmute
control may not restore sound until there is a proper user gesture on the video.

This is [browser policy](https://developer.chrome.com/blog/autoplay), not an ArozOS
“mute ban.”

### 2. System global volume at zero

The desktop stores **`global_volume`** in `localStorage`. On first boot it used to
default to **`0`** and persist that value (`desktop.html`). The media player reads
the same key and sets `video.volume`, so the track can look “unmuted” in the UI
while volume is still **0**.

Quick access → **System Global Volume** controls this bar. For a one-off fix in
the browser console on the desktop:

```js
localStorage.setItem('global_volume', '0.7')
```

### 3. Transcoded streams without audio

Non-native extensions are served via `../../media/transcode?file=…` instead of
`../../media?file=…`. If the transcode pipeline drops the audio track, unmuting
cannot help. Native `.mp4` / `.webm` / `.ogg` use the direct media URL.

## Where files live in this repo

| Role | Path |
|------|------|
| Source of truth (edit here) | `vendor/arozos/src/web/…` |
| Built template (Go binary + synced `web/`) | `.local/arozos-template-source/web/…` |
| Runtime copy used by `dev:arozos` | `.local/arozos-data/web/…` |

`scripts/dev-arozos.sh`:

1. Builds ArozOS from `vendor/arozos` (or `AROZOS_SOURCE_DIR`) into
   `.local/arozos-template-source/`.
2. `rsync`s `web/` into `.local/arozos-data/web/` on each start (keeps frontend
   assets fresh while preserving DB/state under `system/`).

If you change `vendor/arozos/src/web/…` but still see old behavior, restart
`npm run dev:arozos` or manually rsync the changed files into
`.local/arozos-data/web/`. Hard-refresh or close and reopen the player window so
the iframe does not cache old HTML.

VPS deployments rebuild from the same `vendor/arozos` tree during image build;
see [`docs/hitl-camofox-notes.md`](hitl-camofox-notes.md) for volume
refresh behavior on container boot.

## Fixes applied in Joshu (vendor/arozos)

### ArOZ Media Player (`mediaPlayer.html`)

- Removed **`autoplay`** from the `<video>` element.
- **`preload="none"`** and **`playsinline`** on the video tag.
- **No load on window open**: show a **Play** overlay; set `src` and call
  `play()` only after a click (user gesture).
- **`resolveVolume()`**: treat missing or `≤ 0` `global_volume` as **0.7**.
- **`vid.muted = false`** when starting playback; do not re-add `autoplay`.

### Video embedded player (`Video/embedded.html`)

- DPlayer **`autoplay: false`** (was `true`).
- Same **`resolveVolume()`** floor so a stored `global_volume` of `0` does not
  silence DPlayer.

### Desktop (`desktop.html`)

- Default **`global_volume`** for new sessions changed from **`0`** to **`0.7`**
  (volume bar and startup chime path).

Existing browsers may still have `local_volume` / `global_volume` already set to
`0` in `localStorage`; the player fixes above ignore zero for playback, but
raising the system volume bar once is still worth doing.

## Troubleshooting checklist

1. **Identify the player** — native controls + “ArOZ Media Player” menu vs DPlayer UI.
2. **Hard-refresh** the desktop or restart `npm run dev:arozos`.
3. **Close all video windows** and open the file again.
4. For **Video Player**: click the **Play** overlay (or a file in the side menu).
5. Check **System Global Volume** in quick access (not muted at 0%).
6. Try a known-good **`.mp4`** with direct `media?file=` URL before blaming transcode.
7. If the wrong app opens, change the **default opener** for that extension to
   **Video Player** or **Video** as desired.

## Future changes

Prefer editing under `vendor/arozos/src/web/` (or your upstream ArozOS (`vendor/arozos`) plus `patches/arozos/`) rather
than only `.local/arozos-data`, so the next `dev-arozos` build stays consistent.

If iframe autoplay with sound is ever required again, consider adding
`allow="autoplay; fullscreen"` on desktop iframes **and** keeping explicit
click-to-play — policy still requires a user gesture for reliable audio.

Joshu-specific desktop chrome (taskbar, theme) remains in
[`arozos/web-overlays/`](../arozos/web-overlays/) via
[`scripts/apply_arozos_joshu_theme.py`](../scripts/apply_arozos_joshu_theme.py);
video player behavior is upstream ArozOS web assets, not that overlay.
