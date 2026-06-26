#!/usr/bin/env node
/**
 * Entrypoint: prefer host-built agent from /opt/joshu (git pull) over image-baked /app.
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

const hostEntry = "/opt/joshu/packages/instance-agent/dist/index.js";
const hostNodeModules = "/opt/joshu/packages/instance-agent/node_modules";
const imageEntry = "/app/dist/index.js";
const entry =
  existsSync(hostEntry) && existsSync(hostNodeModules) ? hostEntry : imageEntry;

const child = spawn(process.execPath, [entry], { stdio: "inherit", env: process.env });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
