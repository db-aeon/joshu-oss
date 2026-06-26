#!/usr/bin/env npx tsx
/**
 * Fetch OneNote page HTML via Joshu Composio connector (or direct Graph fallback).
 *
 * Usage:
 *   npm run onenote:fetch-page -- --url "https://onedrive.live.com/...Doc.aspx?..."
 *   npm run onenote:fetch-page -- --page-id c42dc6e3-efaf-480a-b71e-83f51c513785 -o page.html
 *   npm run onenote:fetch-page -- --section-id 900e2e95-... --list-pages
 *   npm run onenote:fetch-page -- --graph-only --dump-section --url <onedrive-doc-url> --output-dir ./export
 *
 * Primary path: COMPOSIO_API_KEY + connected OneNote account (Connectors app).
 * Fallback: MS_GRAPH_ACCESS_TOKEN or MS_GRAPH_CLIENT_ID (device code).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isComposioEnabled } from "../src/composioApi.ts";
import {
  fetchOnenotePageFromUrl,
  fetchOnenotePageHtml,
  listOnenoteSectionPages,
} from "../src/connectors/composio/onenote.ts";
import { isAnyOnenoteConnected } from "../src/connectors/composio/onenoteAccounts.ts";
import { acquireGraphAccessToken, dumpGraphSectionHtml, fetchGraphPageHtml, listNotebooks, listNotebookSections, listSectionPages, resumeGraphSectionDumpFromManifest } from "../src/onenote/graphClient.ts";
import { parseOneNoteUrl, requirePageId } from "../src/onenote/parseUrl.ts";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function parseArgs(argv) {
  const args = {
    url: null,
    pageId: null,
    sectionId: null,
    output: null,
    stdout: false,
    meta: false,
    listPages: false,
    listNotebooks: false,
    dumpSection: false,
    outputDir: null,
    concurrency: 4,
    resume: false,
    requestDelayMs: 8000,
    includeIds: false,
    graphOnly: false,
    connectedAccountId: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url" && argv[i + 1]) args.url = argv[++i];
    else if (a === "--page-id" && argv[i + 1]) args.pageId = argv[++i];
    else if (a === "--section-id" && argv[i + 1]) args.sectionId = argv[++i];
    else if (a === "--connected-account-id" && argv[i + 1]) args.connectedAccountId = argv[++i];
    else if (a === "-o" && argv[i + 1]) args.output = path.resolve(argv[++i]);
    else if (a === "--stdout") args.stdout = true;
    else if (a === "--meta") args.meta = true;
    else if (a === "--list-pages") args.listPages = true;
    else if (a === "--list-notebooks") args.listNotebooks = true;
    else if (a === "--dump-section") args.dumpSection = true;
    else if (a === "--output-dir" && argv[i + 1]) args.outputDir = path.resolve(argv[++i]);
    else if (a === "--concurrency" && argv[i + 1]) args.concurrency = Number(argv[++i]);
    else if (a === "--resume") args.resume = true;
    else if (a === "--delay-ms" && argv[i + 1]) args.requestDelayMs = Number(argv[++i]);
    else if (a === "--include-ids") args.includeIds = true;
    else if (a === "--graph-only") args.graphOnly = true;
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else throw new Error(`Unknown arg: ${a}`);
  }
  if (!args.stdout && !args.output && !args.meta && !args.listPages && !args.listNotebooks && !args.dumpSection) {
    args.stdout = true;
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  npm run onenote:fetch-page -- --url <onedrive-doc-url> [-o file.html]
  npm run onenote:fetch-page -- --page-id <uuid> [-o file.html]
  npm run onenote:fetch-page -- --graph-only --list-notebooks
  npm run onenote:fetch-page -- --graph-only --dump-section --url <onedrive-doc-url> --output-dir ./export
  npm run onenote:fetch-page -- --graph-only --dump-section --output-dir ./export --resume --concurrency 4 --delay-ms 8000

Primary: Composio (COMPOSIO_API_KEY + OneNote connected in Connectors app)
Fallback: --graph-only with MS_GRAPH_ACCESS_TOKEN or MS_GRAPH_CLIENT_ID`);
}

function useComposio(env, args) {
  return !args.graphOnly && isComposioEnabled();
}

async function main() {
  const env = { ...loadDotEnv(path.join(ROOT_DIR, ".env")), ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] == null) process.env[key] = value;
  }
  const args = parseArgs(process.argv);
  const composio = useComposio(env, args);

  if (args.dumpSection) {
    if (composio) {
      throw new Error("--dump-section requires --graph-only (Composio bulk export not implemented yet)");
    }
    const token = await acquireGraphAccessToken({
      accessToken: env.MS_GRAPH_ACCESS_TOKEN,
      clientId: env.MS_GRAPH_CLIENT_ID,
      tenantId: env.MS_GRAPH_TENANT_ID,
    });
    const parsed = args.url
      ? parseOneNoteUrl(args.url)
      : { sectionId: args.sectionId || undefined };
    const outputDir =
      args.outputDir ||
      path.join(
        ROOT_DIR,
        ".local",
        "onenote-export",
        (parsed.notebookName || "section").replace(/\.one$/i, "").replace(/[^\w.-]+/g, "-").slice(0, 80),
      );
    const manifestPath = path.join(outputDir, "manifest.json");
    const result =
      args.resume && fs.existsSync(manifestPath)
        ? await resumeGraphSectionDumpFromManifest(token, {
            outputDir,
            includeIds: args.includeIds,
            requestDelayMs: args.requestDelayMs,
            concurrency: args.concurrency,
          })
        : await dumpGraphSectionHtml(token, {
            hints: parsed,
            sectionId: args.sectionId || undefined,
            outputDir,
            includeIds: args.includeIds,
            concurrency: args.concurrency,
            resume: args.resume,
          });
    if (args.meta || args.output) {
      const payload = JSON.stringify(result, null, 2);
      if (args.output) fs.writeFileSync(args.output, payload, "utf8");
      else console.log(payload);
    }
    return;
  }

  if (args.listNotebooks) {
    const token = await acquireGraphAccessToken({
      accessToken: env.MS_GRAPH_ACCESS_TOKEN,
      clientId: env.MS_GRAPH_CLIENT_ID,
      tenantId: env.MS_GRAPH_TENANT_ID,
    });
    const notebooks = await listNotebooks(token);
    const payload = JSON.stringify(notebooks, null, 2);
    if (args.output) fs.writeFileSync(args.output, payload, "utf8");
    else console.log(payload);
    return;
  }

  if (args.listPages) {
    const sectionId =
      args.sectionId || (args.url ? parseOneNoteUrl(args.url).sectionId : null);
    if (!sectionId) {
      throw new Error("--list-pages requires --section-id or a --url with a section id");
    }

    if (composio) {
      if (!(await isAnyOnenoteConnected(ROOT_DIR))) {
        throw new Error("OneNote is not connected — connect ONENOTE in Connectors app");
      }
      const pages = await listOnenoteSectionPages(ROOT_DIR, {
        sectionId,
        connectedAccountId: args.connectedAccountId || undefined,
        limit: 100,
      });
      const payload = JSON.stringify(pages, null, 2);
      if (args.output) fs.writeFileSync(args.output, payload, "utf8");
      else console.log(payload);
      return;
    }

    const token = await acquireGraphAccessToken({
      accessToken: env.MS_GRAPH_ACCESS_TOKEN,
      clientId: env.MS_GRAPH_CLIENT_ID,
      tenantId: env.MS_GRAPH_TENANT_ID,
    });
    let pages;
    if (sectionId.includes("!")) {
      pages = await listSectionPages(sectionId, token);
    } else {
      const parsed = args.url ? parseOneNoteUrl(args.url) : {};
      const notebooks = await listNotebooks(token);
      const notebook = notebooks.find((n) =>
        parsed.notebookName &&
        (n.displayName ?? "").toLowerCase().includes(
          parsed.notebookName.replace(/\.one$/i, "").toLowerCase(),
        ),
      ) ?? notebooks[0];
      if (!notebook) throw new Error("No notebooks found");
      const sections = await listNotebookSections(notebook.id, token);
      pages = [];
      for (const section of sections) {
        const sectionPages = await listSectionPages(section.id, token);
        pages.push(...sectionPages.map((p) => ({ ...p, sectionId: section.id, sectionName: section.displayName })));
      }
    }
    const payload = JSON.stringify(pages, null, 2);
    if (args.output) fs.writeFileSync(args.output, payload, "utf8");
    else console.log(payload);
    return;
  }

  const pageId =
    args.pageId || (args.url ? requirePageId(args.url) : null);
  if (!pageId && !args.url) {
    throw new Error("Provide --page-id or --url");
  }

  if (composio) {
    if (!(await isAnyOnenoteConnected(ROOT_DIR))) {
      throw new Error("OneNote is not connected — connect ONENOTE in Connectors app");
    }
    if (args.url) {
      const result = await fetchOnenotePageFromUrl(ROOT_DIR, {
        url: args.url,
        connectedAccountId: args.connectedAccountId || undefined,
        includeIds: args.includeIds,
      });
      if (args.meta) {
        const payload = JSON.stringify(
          { parsed: result.parsed, pageId: result.pageId, source: "composio" },
          null,
          2,
        );
        if (args.output) fs.writeFileSync(args.output, payload, "utf8");
        else console.log(payload);
        return;
      }
      const html = result.html;
      if (args.output) {
        fs.writeFileSync(args.output, html, "utf8");
        console.error(`Wrote ${args.output} (${html.length} bytes) via Composio`);
      } else {
        process.stdout.write(html);
      }
      return;
    }

    if (!pageId) {
      throw new Error("Provide --page-id or a URL with a OneNote page id (Doc.aspx?wd=target(...))");
    }
    const html = await fetchOnenotePageHtml(ROOT_DIR, {
      pageId,
      connectedAccountId: args.connectedAccountId || undefined,
      includeIds: args.includeIds,
    });
    if (args.output) {
      fs.writeFileSync(args.output, html, "utf8");
      console.error(`Wrote ${args.output} (${html.length} bytes) via Composio`);
    } else {
      process.stdout.write(html);
    }
    return;
  }

  const token = await acquireGraphAccessToken({
    accessToken: env.MS_GRAPH_ACCESS_TOKEN,
    clientId: env.MS_GRAPH_CLIENT_ID,
    tenantId: env.MS_GRAPH_TENANT_ID,
  });

  const parsed = args.url ? parseOneNoteUrl(args.url) : {
    pageId: args.pageId || undefined,
    sectionId: args.sectionId || undefined,
  };

  if (!parsed.pageId && args.pageId) parsed.pageId = args.pageId;
  if (!parsed.pageId && args.url) parsed.pageId = requirePageId(args.url);

  const result = await fetchGraphPageHtml(token, parsed, { includeIds: args.includeIds });
  const html = result.html;
  if (args.meta) {
    const payload = JSON.stringify({ parsed, ...result, source: "graph" }, null, 2);
    if (args.output) fs.writeFileSync(args.output, payload, "utf8");
    else console.log(payload);
    return;
  }
  if (args.output) {
    fs.writeFileSync(args.output, html, "utf8");
    console.error(`Wrote ${args.output} (${html.length} bytes) via Graph`);
  } else {
    process.stdout.write(html);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
