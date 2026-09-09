# Runtime assets (API-served files that tsc does not emit)

Laptop `tsx` can read anything in the git tree. A VPS box cannot. Compose bind-mounts **`dist/`** over the image; `tsc` only writes `.js`. HTML, PNG, and similar files the Joshu API `readFile`s are **invisible on the box** until they are copied into `dist/`.

That is how public **Chat with files** 500ed (`Share chat UI missing`) while `apps/share-chat/index.html` existed in git.

## Rule

If the Node API reads a file that is not compiled TypeScript, add a row to [`scripts/runtime-assets.json`](../scripts/runtime-assets.json):

```json
{
  "src": "apps/my-feature/page.html",
  "dest": "dist/myFeature/ui/page.html",
  "reason": "Guest page for my-feature",
  "contains": ["{{PLACEHOLDER}}"]
}
```

`dest` must be under `dist/` (no `..`). Optional `contains` strings are asserted after copy.

Then:

1. Read the file at runtime via `__dirname` next to the compiled module (`dist/myFeature/ui/…`), with laptop `src/` / `apps/` as a fallback only.
2. `npm run build` copies the list (`node scripts/copy-runtime-assets.mjs`).
3. Image build and CI fail closed: `npm run test:runtime-assets` and `deploy/Dockerfile` run `--check`.

Do **not** rely on a compose bind-mount of `apps/` as the product path. Bind-mounts are a git-pull hotfix lane, and they do nothing until that compose snippet is on the **box** and `joshu-stack` is recreated. `git pull` never copies `dest` files — overlay host `dist/` (or wait for an image that already contains them, then `syncDistFromImage`).

## Commands

```bash
node scripts/copy-runtime-assets.mjs                  # copy (also run by npm run build)
npm run test:runtime-assets                           # src + dest exist
```

## Other ship lanes (not this list)

| What | How it reaches the box |
|------|------------------------|
| Vite desktop apps (jMail, last30days, jTerm) | `npm run build:<app>` → `dist/<app>/` → Dockerfile `rsync` into the ArozOS template. Add **both** the package.json script and the Dockerfile rsync line. |
| Skills, MCP `.mjs`, vanilla overlays | Compose bind-mount from `/opt/joshu`. `git pull` + recreate. |
| Factory YAML (`manifest.yaml`, `onboarding-prompts.yaml`) | Compose bind-mount from `/opt/joshu/factory/`. `git pull` + recreate. |
| This list (API-served static) | Copy into `dist/` beside compiled JS. |

See [share-chat.md — Packaging](share-chat.md#packaging-vps), [hotpatch-running-box.md](vps-sandbox/hotpatch-running-box.md), [app-sdk.md](app-sdk.md) (Vite apps).
