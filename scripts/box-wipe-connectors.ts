#!/usr/bin/env node
/** CLI entry for box-state hard reset — disconnect Composio cloud connections. */
import path from "node:path";
import { pathToFileURL } from "node:url";

const distHook = path.join(process.cwd(), "dist/boxHardResetHooks.js");
const { wipeConnectorCloudState } = await import(pathToFileURL(distHook).href);

const result = await wipeConnectorCloudState(process.cwd());
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(result.ok || result.skipped ? 0 : 1);
