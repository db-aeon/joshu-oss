/**
 * Inline jobs: a voice `think` turn run by Joshu with a time budget.
 *
 * A cheap classifier used to guess sync vs. background up front: a 59 s sync
 * turn held a caller on the line, and "email me the link" became a background
 * goal (canary box 2026-09-26). Now every phone think starts inline; if it is
 * not done within the budget (~10 s) the call hears "still working" and the
 * job keeps going. Its answer is spoken when it lands if the owner is still on
 * the line, and otherwise delivered by the owner outbox — never dropped.
 *
 * Running here (not in voice-realtime) also means the turn is counted as in
 * flight (no gateway restart under it), survives a hang-up, and a Joshu restart
 * becomes an honest "I restarted before finishing" instead of silence.
 *
 * Links in a spoken answer are texted when the answer is claimed, and every
 * send is reported back as a `delivered` fact — the voice model may only claim
 * a send that is listed there.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import express, { type Request, type Response, type Router } from "express";

import { handoffUrlForRecord, listHandoffRecords } from "../browserHandoff/store.js";
import type { HermesApiRunner, HermesChatMessage } from "../hermesApi.js";
import { isDirectLocalhostRequest } from "../httpLocalhost.js";
import type { RealtimeGoalBroker } from "./broker.js";
import type { RealtimeGoalChannel, RealtimeGoalOrigin } from "./types.js";
import {
  extractLinks,
  linkDeliveryNote,
  speakableWithoutLinks,
  textLinksToOwner,
  type OwnerTextResult,
} from "./voiceLinks.js";

/** Longest a jobs request waits before answering "working". */
const MAX_BUDGET_MS = 25_000;
/** How long `ensureGatewayReady` may take before the job says so (it keeps waiting). */
const GATEWAY_READY_WAIT_MS = 20_000;
/** A finished answer nobody claimed (voice service gone) goes to the outbox after this. */
export const UNCLAIMED_DELIVERY_MS = 45_000;
/** Hard stop for one Hermes turn. */
const JOB_MAX_MS = 10 * 60_000;
/** Finished jobs are kept this long (idempotency, late claims). */
const RETENTION_MS = 6 * 60 * 60_000;

/** Something Joshu actually sent on the owner's behalf. */
export type DeliveredFact = {
  what: "link" | "answer";
  via: "sms";
  ok: boolean;
  at: string;
  count?: number;
  error?: string;
};

export type InlineJobStatus = "running" | "done" | "failed" | "lost";

export type InlineJob = {
  id: string;
  origin: RealtimeGoalOrigin;
  title: string;
  hermesSessionKey: string;
  startedAt: string;
  status: InlineJobStatus;
  source?: "broker" | "hermes";
  finishedAt?: string;
  /** Hermes' answer as written (links included). */
  answer?: string;
  error?: string;
  /** The live call took the answer (it will speak it). */
  claimedAt?: string;
  /** The owner can no longer hear it on this surface (hung up). */
  detachedAt?: string;
  /** Handed to the owner outbox (or texted) instead of spoken. */
  deliveredAt?: string;
  delivered?: DeliveredFact[];
};

export type StartInlineJobInput = {
  origin: RealtimeGoalOrigin;
  /** Owner request as the broker and Hermes see it (Intent / summary / User said). */
  text: string;
  title?: string;
  /** Think system prompt for this surface (voice-realtime owns the identity prompts). */
  systemPrompt?: string;
  hermesSessionId: string;
  hermesSessionKey: string;
};

export type ClaimResult = {
  claimed: boolean;
  job: InlineJob;
  /** Answer rewritten for speech (links texted and replaced by an honest note). */
  spoken?: string;
};

type JobRunner = Pick<HermesApiRunner, "streamHermesChat" | "ensureGatewayReady">;

function isoNow(): string {
  return new Date().toISOString();
}

function shortTitle(text: string): string {
  const userSaid = text.match(/^User said:\s*(.+)$/m)?.[1];
  const intent = text.match(/^Intent:\s*(.+)$/m)?.[1];
  const line = (userSaid ?? intent ?? text).replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 77)}…` : line || "your question";
}

/**
 * Browser handoff links minted in this Hermes session since `sinceMs` — a
 * worker that says "use the checkout link" without pasting it still delivers
 * the URL.
 */
export function collectHandoffUrlsForSession(projectRoot: string, sessionKey: string, sinceMs: number): string[] {
  let records: ReturnType<typeof listHandoffRecords> = [];
  try {
    records = listHandoffRecords(projectRoot);
  } catch {
    return [];
  }
  return records
    .filter(
      (record) =>
        record.status === "pending" &&
        record.hermesSessionKey === sessionKey &&
        Date.parse(record.createdAt) >= sinceMs,
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((record) => handoffUrlForRecord(record));
}

export class InlineJobs {
  private jobs = new Map<string, InlineJob>();
  private waiters = new Map<string, Set<() => void>>();
  private unclaimedTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly file: string;

  constructor(
    private readonly runner: JobRunner,
    private readonly broker: RealtimeGoalBroker,
    private readonly projectRoot: string,
    stateDir: string,
    private readonly options: { unclaimedDeliveryMs?: number } = {},
  ) {
    this.file = path.join(stateDir, "inline-jobs.json");
  }

  /** Load persisted jobs; ones that were running when Joshu stopped are reported to the owner. */
  async recover(): Promise<void> {
    let saved: InlineJob[] = [];
    try {
      saved = JSON.parse(readFileSync(this.file, "utf8")) as InlineJob[];
    } catch {
      saved = [];
    }
    const cutoff = Date.now() - RETENTION_MS;
    for (const job of Array.isArray(saved) ? saved : []) {
      if (!job?.id || Date.parse(job.finishedAt ?? job.startedAt) < cutoff) continue;
      this.jobs.set(job.id, job);
    }
    const lost = [...this.jobs.values()].filter((job) => job.status === "running");
    for (const job of lost) {
      job.status = "lost";
      job.finishedAt = isoNow();
      job.error = "Joshu restarted before the answer was ready";
      console.warn(`[inline-jobs] job=${job.id} lost in restart — telling the owner`);
      await this.deliverElsewhere(job);
    }
    this.persist();
  }

  get(id: string): InlineJob | undefined {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : undefined;
  }

  /**
   * Route the request (status / cancel / queue go to the goal broker), otherwise
   * start a Hermes turn. Returns the job as soon as it finishes or `budgetMs`
   * passes, whichever is first.
   */
  async start(input: StartInlineJobInput, budgetMs: number): Promise<InlineJob> {
    const admission = await this.broker.route({ origin: input.origin, text: input.text }).catch((error) => {
      console.warn(`[inline-jobs] broker admission failed open: ${(error as Error).message}`);
      return undefined;
    });
    const job: InlineJob = {
      id: randomUUID(),
      origin: input.origin,
      title: input.title?.trim().slice(0, 100) || shortTitle(input.text),
      hermesSessionKey: input.hermesSessionKey,
      startedAt: isoNow(),
      status: "running",
    };
    this.jobs.set(job.id, job);
    if (admission?.action === "reply") {
      this.finish(job, { status: "done", source: "broker", answer: admission.text });
      return structuredClone(job);
    }
    this.persist();
    void this.run(job, input);
    return this.wait(job.id, budgetMs);
  }

  /** The job once it is no longer running, or as it is after `waitMs`. */
  async wait(id: string, waitMs: number): Promise<InlineJob> {
    const job = this.jobs.get(id);
    if (!job) throw new Error("unknown job");
    if (job.status === "running" && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(waitMs, MAX_BUDGET_MS));
        timer.unref?.();
        const set = this.waiters.get(id) ?? new Set();
        this.waiters.set(id, set);
        function done(): void {
          clearTimeout(timer);
          set.delete(done);
          resolve();
        }
        set.add(done);
      });
    }
    return structuredClone(this.jobs.get(id)!);
  }

  /**
   * The live call will speak this answer. Texts its links (once) and returns
   * the speakable text. Not claimable once delivered elsewhere.
   */
  async claim(id: string, presentation: "phone" | "screen" = "phone"): Promise<ClaimResult> {
    const job = this.jobs.get(id);
    if (!job) throw new Error("unknown job");
    if (job.status === "running" || job.deliveredAt || job.detachedAt) {
      return { claimed: false, job: structuredClone(job) };
    }
    job.claimedAt ??= isoNow();
    this.clearUnclaimedTimer(id);
    const spoken = await this.speakable(job, presentation);
    this.persist();
    return { claimed: true, job: structuredClone(job), spoken };
  }

  /** The owner can no longer hear this job on its surface; deliver it elsewhere when done. */
  async detach(id: string): Promise<InlineJob | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    job.detachedAt ??= isoNow();
    if (job.status !== "running") await this.deliverElsewhere(job);
    this.persist();
    return structuredClone(job);
  }

  private async run(job: InlineJob, input: StartInlineJobInput): Promise<void> {
    const abort = new AbortController();
    const hardStop = setTimeout(() => abort.abort(), JOB_MAX_MS);
    hardStop.unref?.();
    try {
      let ready = false;
      await Promise.race([
        this.runner.ensureGatewayReady().then(() => {
          ready = true;
        }),
        new Promise((resolve) => setTimeout(resolve, GATEWAY_READY_WAIT_MS).unref?.()),
      ]);
      if (!ready) console.warn(`[inline-jobs] job=${job.id} Hermes gateway still starting after 20s — waiting`);
      const context = await this.broker.buildHermesContextSnapshot(input.origin).catch(() => undefined);
      const messages: HermesChatMessage[] = [
        ...(input.systemPrompt ? [{ role: "system" as const, content: input.systemPrompt }] : []),
        ...(context ? [{ role: "system" as const, content: context }] : []),
        { role: "user", content: input.text },
      ];
      const { finalText } = await this.runner.streamHermesChat(
        {
          sessionId: input.hermesSessionId,
          sessionKey: input.hermesSessionKey,
          messages,
          signal: abort.signal,
        },
        {},
      );
      const answer = finalText.trim();
      this.finish(job, answer ? { status: "done", source: "hermes", answer } : { status: "failed", error: "empty answer" });
      if (answer) await this.broker.recordBoxTurn(input.origin, answer, "hermes").catch(() => undefined);
    } catch (error) {
      this.finish(job, { status: "failed", error: (error as Error).message.slice(0, 300) });
    } finally {
      clearTimeout(hardStop);
    }
    const elapsed = Date.now() - Date.parse(job.startedAt);
    console.info(`[inline-jobs] job=${job.id} ${job.status} ms=${elapsed} claimed=${Boolean(job.claimedAt)} detached=${Boolean(job.detachedAt)}`);
    if (job.detachedAt) {
      await this.deliverElsewhere(job);
    } else if (!job.claimedAt) {
      const timer = setTimeout(() => {
        this.unclaimedTimers.delete(job.id);
        if (!job.claimedAt) void this.deliverElsewhere(job).then(() => this.persist());
      }, this.options.unclaimedDeliveryMs ?? UNCLAIMED_DELIVERY_MS);
      timer.unref?.();
      this.unclaimedTimers.set(job.id, timer);
    }
    this.persist();
  }

  private finish(
    job: InlineJob,
    outcome: { status: "done" | "failed"; source?: "broker" | "hermes"; answer?: string; error?: string },
  ): void {
    job.status = outcome.status;
    job.finishedAt = isoNow();
    if (outcome.source) job.source = outcome.source;
    if (outcome.answer) job.answer = outcome.answer;
    if (outcome.error) job.error = outcome.error;
    for (const wake of this.waiters.get(job.id) ?? []) wake();
    this.waiters.delete(job.id);
    this.persist();
  }

  private clearUnclaimedTimer(id: string): void {
    const timer = this.unclaimedTimers.get(id);
    if (timer) clearTimeout(timer);
    this.unclaimedTimers.delete(id);
  }

  /** Handoff links minted during this job that the answer does not already carry. */
  private missingHandoffLinks(job: InlineJob): string[] {
    const inAnswer = new Set(extractLinks(job.answer ?? ""));
    return collectHandoffUrlsForSession(this.projectRoot, job.hermesSessionKey, Date.parse(job.startedAt)).filter(
      (url) => !inAnswer.has(url),
    );
  }

  private async speakable(job: InlineJob, presentation: "phone" | "screen"): Promise<string> {
    if (job.status !== "done" || !job.answer) {
      return job.status === "failed" || job.status === "lost"
        ? `I couldn't finish “${job.title}” just now.`
        : "";
    }
    if (presentation === "screen" || job.source !== "hermes") return job.answer;
    const links = [...extractLinks(job.answer), ...this.missingHandoffLinks(job)];
    if (links.length === 0) return job.answer;
    const already = job.delivered?.find((fact) => fact.what === "link" && fact.ok);
    let sent: OwnerTextResult = { texted: true };
    if (!already) {
      const fact: DeliveredFact = { what: "link", via: "sms", ok: false, at: isoNow(), count: links.length };
      let undelivered: string | undefined;
      // A carrier rejected the SMS after the answer was spoken: the fact says so from then on.
      sent = await textLinksToOwner(this.projectRoot, links, job.title, (detail) => {
        undelivered = detail;
        fact.ok = false;
        fact.error = detail;
        this.persist();
      });
      fact.ok = sent.texted && !undelivered;
      const error = undelivered ?? sent.error;
      if (error) fact.error = error;
      job.delivered = [...(job.delivered ?? []), fact];
    }
    const note = linkDeliveryNote(sent, links.length);
    return extractLinks(job.answer).length > 0
      ? speakableWithoutLinks(job.answer, note)
      : `${job.answer.trim()}\n\n${note}`;
  }

  /** The answer (or an honest failure) goes to the owner outbox. */
  private async deliverElsewhere(job: InlineJob): Promise<void> {
    if (job.deliveredAt || job.status === "running" || job.source === "broker") return;
    if (job.claimedAt && !job.detachedAt) return;
    job.deliveredAt = isoNow();
    this.clearUnclaimedTimer(job.id);
    const handoff = this.missingHandoffLinks(job);
    const text =
      job.status === "done" && job.answer
        ? [job.answer.trim(), ...handoff].join("\n")
        : job.status === "lost"
          ? `I restarted before I could finish “${job.title}.” Ask me again when you're ready.`
          : `I couldn't finish “${job.title}.” Ask me again when you're ready.`;
    await this.broker.ownerOutbox.addAnswer({
      jobId: job.id,
      origin: job.origin,
      title: job.title,
      text,
      // The call ended mid-answer: the promise on the line was "I'll text you".
      ...(isVoice(job.origin.channel) ? { routeOverride: "sms" as const } : {}),
    });
    this.broker.kickOutbox();
    console.info(`[inline-jobs] job=${job.id} answer handed to the owner outbox`);
  }

  private persist(): void {
    const cutoff = Date.now() - RETENTION_MS;
    for (const [id, job] of this.jobs) {
      if (job.status !== "running" && Date.parse(job.finishedAt ?? job.startedAt) < cutoff) this.jobs.delete(id);
    }
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.jobs.values()], null, 2));
      renameSync(tmp, this.file);
    } catch (error) {
      console.warn(`[inline-jobs] persist failed: ${(error as Error).message}`);
    }
  }
}

function isVoice(channel: RealtimeGoalChannel): boolean {
  return channel === "pstn_voice" || channel === "browser_voice";
}

function serviceAuthorized(req: Request): boolean {
  const expected = process.env.HERMES_API_KEY?.trim();
  return Boolean(isDirectLocalhostRequest(req) && expected && req.headers.authorization === `Bearer ${expected}`);
}

/** Wire shape for the voice service. */
export function jobView(job: InlineJob, spoken?: string): Record<string, unknown> {
  return {
    jobId: job.id,
    status: job.status === "lost" ? "failed" : job.status,
    ...(job.source ? { source: job.source } : {}),
    ...(job.status === "done" ? { answer: spoken ?? job.answer ?? "" } : {}),
    ...(job.error ? { error: job.error } : {}),
    delivered: job.delivered ?? [],
    ...(job.deliveredAt ? { deliveredElsewhere: true } : {}),
  };
}

const CHANNELS = new Set<RealtimeGoalChannel>(["pstn_voice", "browser_voice"]);

export function registerInlineJobRoutes(router: Router, jobs: InlineJobs): void {
  const json = express.json({ limit: "64kb" });

  router.post("/api/realtime-goals/jobs", json, async (req: Request, res: Response) => {
    if (!serviceAuthorized(req)) {
      res.status(403).json({ error: "internal service authentication required" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const origin = body.origin as RealtimeGoalOrigin | undefined;
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const sessionId = typeof body.hermesSessionId === "string" ? body.hermesSessionId.trim() : "";
    const sessionKey = typeof body.hermesSessionKey === "string" ? body.hermesSessionKey.trim() : "";
    if (!origin || !CHANNELS.has(origin.channel) || !origin.sessionKey || !text || !sessionId || !sessionKey) {
      res.status(400).json({ error: "origin (voice), text, hermesSessionId and hermesSessionKey are required" });
      return;
    }
    const budgetMs = Math.max(0, Math.min(Number(body.budgetMs) || 10_000, MAX_BUDGET_MS));
    const presentation = body.presentation === "screen" ? "screen" : "phone";
    try {
      const job = await jobs.start(
        {
          origin,
          text,
          title: typeof body.title === "string" ? body.title : undefined,
          systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt : undefined,
          hermesSessionId: sessionId,
          hermesSessionKey: sessionKey,
        },
        budgetMs,
      );
      if (job.status === "running") {
        res.json(jobView(job));
        return;
      }
      // Finished within the budget: the caller is speaking it now.
      const claim = await jobs.claim(job.id, presentation);
      res.json(jobView(claim.job, claim.spoken));
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  router.get("/api/realtime-goals/jobs/:id", async (req: Request, res: Response) => {
    if (!serviceAuthorized(req)) {
      res.status(403).json({ error: "internal service authentication required" });
      return;
    }
    try {
      const waitMs = Math.max(0, Math.min(Number(req.query.waitMs) || 0, MAX_BUDGET_MS));
      res.json(jobView(await jobs.wait(String(req.params.id ?? ""), waitMs)));
    } catch {
      res.status(404).json({ error: "unknown job" });
    }
  });

  router.post("/api/realtime-goals/jobs/:id/claim", json, async (req: Request, res: Response) => {
    if (!serviceAuthorized(req)) {
      res.status(403).json({ error: "internal service authentication required" });
      return;
    }
    try {
      const claim = await jobs.claim(String(req.params.id ?? ""), req.body?.presentation === "screen" ? "screen" : "phone");
      res.json({ claimed: claim.claimed, ...jobView(claim.job, claim.spoken) });
    } catch {
      res.status(404).json({ error: "unknown job" });
    }
  });

  router.post("/api/realtime-goals/jobs/:id/detach", async (req: Request, res: Response) => {
    if (!serviceAuthorized(req)) {
      res.status(403).json({ error: "internal service authentication required" });
      return;
    }
    const job = await jobs.detach(String(req.params.id ?? ""));
    if (!job) {
      res.status(404).json({ error: "unknown job" });
      return;
    }
    res.json(jobView(job));
  });
}
