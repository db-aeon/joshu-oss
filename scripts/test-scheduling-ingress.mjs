#!/usr/bin/env npx tsx
/**
 * Smoke test for Kanban-first scheduling ingress (no live Hermes).
 *
 * Usage: npm run test:scheduling-ingress
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildIngressEventId,
  ingressTaskIdempotencyKey,
  meetingTaskIdempotencyKey,
} from "../src/ea/schedulingTypes.js";

async function main() {
  const filesRoot = await mkdtemp(path.join(os.tmpdir(), "joshu-sched-ingress-"));
  try {
    const messageId = "msg-001";
    const provider = "gmail";
    const threadId = "thread-abc";

    const eventId = buildIngressEventId(provider, threadId, messageId);
    if (!eventId.startsWith("ingress-gmail-")) throw new Error("bad ingress event id");

    const ingressKey = ingressTaskIdempotencyKey(messageId);
    if (!ingressKey.startsWith("ea-ingress-")) throw new Error("bad ingress idempotency key");

    const dupKey = ingressTaskIdempotencyKey(messageId);
    if (dupKey !== ingressKey) throw new Error("ingress idempotency key not stable");

    const meetKey = meetingTaskIdempotencyKey("t_meet123");
    if (!meetKey.startsWith("ea-meet-")) throw new Error("bad meeting idempotency key");

    // forwardSchedulingMail requires live kanban bridge — tested via types/helpers here.
    console.log("scheduling-ingress smoke ok", { eventId, ingressKey, meetKey });
  } finally {
    await rm(filesRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
