#!/usr/bin/env node
// Unit test: the git repositories that gbrain uses under files/users survive a sync when the
// data folder is reached through a link, as in single-container mode (/var/lib/arozos is a
// link to the data root). A text compare of the linked path with the path that git prints
// called each repository invalid, and each sync deleted .git and made a new one.
//
// Usage: npm run test:gbrain-desktop-git
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureGbrainGitRepo, stageDesktopForGbrainSync } from "./lib/gbrain-desktop-git.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

const base = realpathSync(mkdtempSync(join(tmpdir(), "gbrain-desktop-git-")));
const dataRoot = join(base, "data", "arozos");
const desktopReal = join(dataRoot, "files", "users", "owner@example.com", "Desktop");
mkdirSync(desktopReal, { recursive: true });
writeFileSync(join(desktopReal, "note.md"), "first\n");

// The image path is a link to the data root, as scripts/lib/data-root.sh makes it.
mkdirSync(join(base, "var", "lib"), { recursive: true });
symlinkSync(dataRoot, join(base, "var", "lib", "arozos"));
const usersLinked = join(base, "var", "lib", "arozos", "files", "users");
const desktopLinked = join(usersLinked, "owner@example.com", "Desktop");

await ensureGbrainGitRepo(desktopLinked);
const usersHead = git(usersLinked, "rev-parse", "HEAD");
const desktopHead = git(desktopLinked, "rev-parse", "HEAD");
assert.equal(git(usersLinked, "rev-list", "--count", "HEAD"), "1");

// A second run keeps both repositories: the same commits, no new baseline.
await ensureGbrainGitRepo(desktopLinked);
assert.equal(git(usersLinked, "rev-parse", "HEAD"), usersHead, "files/users keeps its repository");
assert.equal(git(desktopLinked, "rev-parse", "HEAD"), desktopHead, "Desktop keeps its repository");

// A sync after a change adds commits on top of the history.
writeFileSync(join(desktopReal, "note.md"), "second\n");
await stageDesktopForGbrainSync(desktopLinked);
assert.ok(Number(git(desktopLinked, "rev-list", "--count", "HEAD")) >= 2, "Desktop history grows");
assert.equal(git(desktopLinked, "merge-base", "--is-ancestor", desktopHead, "HEAD") === "", true, "the first commit is still in the history");
assert.equal(git(usersLinked, "merge-base", "--is-ancestor", usersHead, "HEAD") === "", true);

console.log("test-gbrain-desktop-git: ok");
