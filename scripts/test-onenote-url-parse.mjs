#!/usr/bin/env npx tsx
import { parseOneNoteUrl, requirePageId } from "../src/onenote/parseUrl.ts";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const sample =
  "https://onedrive.live.com/personal/517252f565229ec7/_layouts/15/Doc.aspx?sourcedoc={65229ec7-52f5-2072-8051-ce0900000000}&action=view&wd=target%28WC%20Transition%20Notes.one%7C900e2e95-add5-4e41-af31-b74834f03eea%2F%3CTemplate%20%28Copy%5C%2FPaste%20for%20next%20day%5C%29%7Cc42dc6e3-efaf-480a-b71e-83f51c513785%2F%29";

const parsed = parseOneNoteUrl(sample);
assert(parsed.sectionId === "900e2e95-add5-4e41-af31-b74834f03eea", "section id");
assert(parsed.pageId === "c42dc6e3-efaf-480a-b71e-83f51c513785", "page id");
assert(parsed.notebookName === "WC Transition Notes.one", "notebook name");
assert(parsed.pageTitle === "<Template (Copy/Paste for next day)", "page title normalized");
assert(parsed.sourcedoc === "65229ec7-52f5-2072-8051-ce0900000000", "sourcedoc");

assert(
  requirePageId(sample) === "c42dc6e3-efaf-480a-b71e-83f51c513785",
  "requirePageId from url",
);
assert(
  requirePageId("c42dc6e3-efaf-480a-b71e-83f51c513785") ===
    "c42dc6e3-efaf-480a-b71e-83f51c513785",
  "requirePageId bare uuid",
);

console.log("test-onenote-url-parse: ok");
