# Public docs

## Purpose

The user's manual (`docs/user-manual/`) and the technical reference (`docs/technical-reference/`) have two public copies: the public repository joshu-oss, and the pages `/manual` and `/docs` of www.joshu.me. This document tells how one text of each chapter serves the owners whose box Joshu runs and the owners who run their own box, and how the two exports keep private text out of both copies.

## Motivation

The manual has two readers. Most of the text is the same for both, but some passages differ, for example the address of the desktop, the first sign-in, and the reset of a password. Earlier, each chapter that differed had a second file, a twin `NN-<topic>.oss.md` with the self-host text, and the OSS export put the twin in place of the chapter. The two files of a chapter drifted apart, because a change to one file often missed the other.

The website shows both texts in one page, with the hosted text as the main text and the self-host text in a callout or a second tab. The website also reads `main` every 6 hours, so a fix to the manual reaches the website without a release. Both needs require one file per chapter, with the differences marked inline.

The private repository holds names of real owners and boxes, and links to private documents. Neither public copy may show them.

## Architecture

| Component | File | Owns |
|---|---|---|
| Block markers | `docs/user-manual/*.md` | The text for both readers. A self-host block holds the text for an owner who runs their own box, and a hosted-only block holds the text that is true only on a box that Joshu runs. The rules are in `docs/user-manual/AGENTS.md`. |
| Block module | `scripts/lib/doc-blocks.mjs` | The marker rules (`checkMarkers`), the OSS rendering (`renderOss`), and the source lines that the OSS rendering keeps (`ossLines`). |
| Render command | `scripts/render-oss-manual.mjs` | Writes the OSS rendering of each file of a folder in place, checks the markers only (`--check`), or reports lines of the OSS rendering that match a pattern, with their source line (`--grep`). |
| OSS export | `scripts/prepare-oss-snapshot.sh`, `scripts/oss-doc-sanitize.sh` | The tree for joshu-oss: the files of joshu without the private files, the sanitized docs, and the OSS rendering of the manual. |
| Boundary check | `scripts/check-oss-boundaries.sh` | Scans the source tree for fleet names and private identifiers, also inside hosted-only blocks, and checks the markers and the OSS rendering of the manual. |
| Public docs export | `scripts/export-public-docs.sh` | The folder that the website reads: `manifest.json`, the manual with its markers, and the technical reference. |
| Docs sync | `.github/workflows/docs-sync.yml` and `scripts/sync-docs.mjs` in the website repository `db-aeon/joshu-public` | Runs the public docs export on joshu `main`, checks the markers and links again, and opens a pull request with the new pages. |
| Manual skill | `integrations/hermes/skills/help/joshu-manual/SKILL.md` | Tells the companion which Markdown page of the website to read for a question of the owner about Joshu, and which text of the page fits the box. |

The public docs export has this layout, which the docs sync expects:

```
manifest.json              version 1, sourceCommit, files (lastCommitDate for each file), publicFiles
user-manual/README.md      the table of contents
user-manual/NN-<topic>.md  one file per chapter, with the block markers
technical-reference/*.md   the technical reference
```

## Theory of operation

A chapter is written for an owner whose box Joshu runs. Where an owner who runs their own box needs other text, the chapter has a self-host block. Where the hosted text would be wrong for that owner, the hosted text sits in a hosted-only block. A hosted-only block followed by a self-host block, with only blank lines between them, is a tab pair.

The OSS export makes the joshu-oss copy in these steps:

1. First, rsync copies joshu without the private files into the output folder.
2. Second, `render-oss-manual.mjs` replaces each file of `docs/user-manual/` with its OSS rendering. The rendering keeps the text of each self-host block without its marker lines and drops each hosted-only block. Where a drop leaves two or more blank lines in a row, the rendering keeps one, and it drops blank lines that a drop leaves at the start or the end of a file.
3. Third, `oss-doc-sanitize.sh` rewrites private paths and turns each relative link to a file that is not in the export into plain text.
4. Fourth, the secret scan runs on the output folder.

The public docs export makes the website copy in these steps:

1. First, it checks that `git`, `node`, `python3`, `rsync`, and `rg` exist, that the clone has full history, and that the private identifier list exists.
2. Second, it runs the boundary check.
3. Third, it runs the OSS export into a temporary folder. The list of files in that folder becomes `publicFiles`.
4. Fourth, it copies the manual with its markers over the OSS rendering in the temporary folder, and runs the sanitizing again. The rewrites give the same result when they run twice, and the link step now judges each link of the hosted-only blocks against the files of joshu-oss.
5. Fifth, it copies the manual and the technical reference to the output folder and checks the markers again.
6. Sixth, it writes `manifest.json`. `lastCommitDate` of each file is the committer date of the newest commit that changed the source file.

The docs sync then rewrites each link between synced pages to a site URL, rewrites each link to a file in `publicFiles` to joshu-oss on GitHub, and fails on any other relative link. A hosted-only block shows as ordinary text, a self-host block as a "Self-hosting" callout, and a tab pair as the tabs "Joshu runs my box" and "I run my own box".

The website also serves each page as Markdown at `/md/manual/<slug>` and `/md/docs/<slug>`. In the Markdown page, the text of a hosted-only block is ordinary text, and the text of a self-host block is a block quote that starts with `> **Self-hosting:**`.

The companion of each box reads the Markdown pages. When the owner asks how Joshu works or how to do something with Joshu, factory skill `joshu-manual` tells the companion to read the matching chapter with `curl` before it answers. The skill lists each chapter with its Markdown address, and falls back to the table of contents at `/md/manual` when no chapter fits or a page returns "Not found". On a box where `JOSHU_STANDALONE` is `1` or `true`, the companion uses the text of each self-hosting block quote in place of the main text before it. On every other box, the companion skips the self-hosting block quotes.

## Design decisions

**2026-10-30: One file per chapter with block markers, in place of twins.** The alternative was to keep the twins and let the website read both files. The website could then not show the two texts in one page, and the twins would still drift. Markers in HTML comments do not show on GitHub, and the website and joshu-oss each read them.

**2026-10-30: Whole Markdown blocks inside a block.** A marker line inside a list or a table ends the list or the table on GitHub and on the website. When one row of a table differs, each block holds the whole table. When the self-host text only adds sentences to a shared paragraph, the paragraph stays shared and the added sentences go in a self-host block after it, so the website does not show the same paragraph twice.

**2026-10-30: The block module is a Node module.** The unit test `test:doc-blocks` imports it, so `npm test` checks the rules and the real manual on each pull request, and Node is on both runners. An inline Python block, as in `oss-doc-sanitize.sh`, cannot be imported by a test, and awk cannot skip fenced code blocks cleanly. The docs sync of the website checks the markers with the same rules in its own code, because the two repositories cannot share code.

**2026-10-30: The boundary checks stay in `check-oss-boundaries.sh`.** The release workflow, the checklist in `AGENTS.md`, and the public docs export already run this script, so one entry point covers all three. The `joshu.me` rule covers only the user's manual, because other files of joshu-oss mention `joshu.me` on purpose, for example the README and the trademark notice. A check on the finished OSS export would run only when joshu-oss is published, which is too late for the website.

**2026-10-30: The boundary check also scans hosted-only blocks.** The website shows the hosted text, so private names must stay out of it too. The twins hid the hosted chapters from the scan, and an example address in the hosted text named a real box.

**2026-10-30: Example addresses use a placeholder.** The manual writes `https://<name>.box.joshu.me` and `<name>@joshu.me`. Any example name can be the slug of a real box now or later, and the private identifier list matches only the slugs it knows.

**2026-10-30: The public docs export builds an OSS export first.** The OSS export holds every rule about which file is private, and `publicFiles` must be the files of joshu-oss. Copying `docs/` straight to the public docs export would need the OSS file list anyway to judge links. A mode of `prepare-oss-snapshot.sh` that keeps the markers would mix two outputs in the script that publishes joshu-oss.

**2026-10-30: The exports fail closed.** Each scan of the boundary check and of the secret scan finds nothing when `rg` is missing, so both the boundary check and the public docs export stop when `rg` is missing. The public docs export also stops on a shallow clone, which would give wrong dates, and on a missing private identifier list. `manifest.json` is written last, so the docs sync cannot read a half-written export.

**2026-10-31: The companion reads the website, not a copy on the box.** The alternative was to put the manual in the box image or in the folder of the manual skill. The image would carry the manual of its release, but each fix of the manual would wait for a release. A copy in the folder of the skill would change the seed key at each change of the manual, and start an LLM merge of the skill on each box with box evolution. The website has the newest text without a release. The cost is that the manual can describe a feature that a box on an older release does not have yet, so the skill tells the companion what to say in that case.

**2026-10-31: The companion reads the Markdown page with `curl`.** The Markdown page has no navigation and no HTML, so it costs fewer tokens than the HTML page. `curl` reads the page directly from the website. `web_extract` goes through Exa, costs a call, and can return an older copy of the page, so it is only the fallback when the terminal tool is not available. The companion does not open the manual in the shared browser, because the owner may be using it.

**2026-10-31: The companion tells the kind of box from `JOSHU_STANDALONE`.** The Joshu API treats a box as a box that the owner runs when `JOSHU_STANDALONE` is `1` or `true` (`isStandaloneSelfHost` in `src/boxSecrets/resolve.ts`), and the Hermes gateway inherits the environment of the Joshu API. The other signal of that function, a missing `INSTANCE_AGENT_TOKEN`, is a secret name, so the skill does not read it. A box without either value gets the hosted text, which is the text that most owners need.

## Limits and failure modes

- The website reads `main`. A bad marker or a private name on `main` stops the docs sync, and the website keeps its old text until a fix merges. `npm test` and the boundary check catch both before a merge.
- On GitHub, the private repository shows the hosted text and the self-host text one after the other, because GitHub hides HTML comments.
- Edits that contributors make in joshu-oss change the OSS rendering, not the marked source. `scripts/sync-from-oss.sh` does not copy `docs/`, so a maintainer ports such an edit by hand.
- Each new page needs an entry in `content/docs-meta.json` of the website repository. Without it, the sync pull request fails `validate:seo` and stays open.
- The manual skill lists the chapters by their address. A renamed chapter costs the companion one extra read of the table of contents until the skill is updated.
- The other `.oss.md` twins of `docs/`, for example `docs/README.oss.md`, still work as before. Only the user's manual uses markers.

## Code map

- `scripts/lib/doc-blocks.mjs` and `scripts/render-oss-manual.mjs`: the marker rules and the OSS rendering.
- `scripts/test-doc-blocks.mjs` (`npm run test:doc-blocks`): the rules, and the checks of the real manual.
- `scripts/prepare-oss-snapshot.sh`: calls the render command after the rsync and before the sanitizing.
- `scripts/check-oss-boundaries.sh`: the scans, the twin check, and `render-oss-manual.mjs --grep 'joshu\.me'`.
- `scripts/export-public-docs.sh <out-dir>`: the public docs export. It is not part of joshu-oss.
- `docs/user-manual/AGENTS.md`: the writing rules for the markers and the tab pairs.
- `integrations/hermes/skills/help/joshu-manual/SKILL.md`: the manual skill of the companion.
