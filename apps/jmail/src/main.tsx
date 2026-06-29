import "@joshu/design-system/typography.css";
import "@joshu/design-system/tokens.css";
import "@joshu/design-system/base.css";
import "./styles.css";

import React, { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { fetchVoiceGatewayStatus, startJoshuVoiceSession } from "./joshuVoice";
import { platform } from "./joshuData";
import { prepareEmailBodyDocument } from "./messageBody";
import { MailAgentBridge, type MailGuiAgentApi } from "./mailAgentBridge";
import {
  buildJmailChatThreadId,
  readJmailChatThreadRev,
  rotateJmailChatThread,
} from "./chatThreadId.js";
import { executeDesktopAction } from "@joshu/app-agent";
import type { ConnectorsStatus } from "@joshu/platform-data";
import { JMAIL_MANIFEST } from "./mailAppManifest";

const VOICE_API_BASE = "/joshu/api/voice";

type MailInbox =
  | { kind: "nylas" }
  | { kind: "gmail"; connectedAccountId: string; accountKey: string; email?: string };

function inboxTabId(inbox: MailInbox): string {
  return inbox.kind === "nylas" ? "nylas" : inbox.connectedAccountId;
}

function inboxIsActive(inbox: MailInbox, active: MailInbox): boolean {
  return inboxTabId(inbox) === inboxTabId(active);
}

function openConnectorsApp(): void {
  const parent = window.parent as Window & { openModule?: (name: string) => void };
  if (typeof parent.openModule === "function") {
    parent.openModule("Connectors");
    return;
  }
  window.open("/connectors/index.html", "_blank", "noopener,noreferrer");
}

type ThreadMessage = {
  id: string;
  from?: string;
  subject?: string;
  date?: number;
  body: string;
};

type MessageSummary = {
  id: string;
  subject?: string;
  from?: string;
  fromName?: string;
  to?: string[];
  date?: number;
  snippet?: string;
  unread?: boolean;
  threadId?: string;
  messageCount?: number;
};

type MessageDetail = MessageSummary & {
  body?: string;
  cc?: string[];
  threadMessages?: ThreadMessage[];
};

/** Compact rows for agent GUI snapshot (what the user sees in the inbox list). */
function buildInboxPreview(items: MessageSummary[], limit = 25) {
  return items.slice(0, limit).map((m) => ({
    id: m.id,
    subject: m.subject?.trim() || "(no subject)",
    from: m.fromName?.trim() || m.from || "",
    date: m.date,
  }));
}

function formatInboxPreviewForAgent(items: MessageSummary[], limit = 10): string {
  const rows = buildInboxPreview(items, limit);
  if (rows.length === 0) return "Inbox list is empty.";
  return rows
    .map((m, i) => `${i + 1}. ${m.subject} — ${m.from}${m.date ? ` (${new Date(m.date).toISOString()})` : ""}`)
    .join("\n");
}

type Status = {
  configured: boolean;
  agent: {
    provisioned: boolean;
    grantId?: string;
    email?: string;
    createdAt?: string;
  };
};

type Pane = "inbox" | "compose" | "setup";

function formatAddress(name?: string, email?: string): string {
  if (name && email) return `${name} <${email}>`;
  return email || name || "(unknown)";
}

function parseIsoDateEpoch(iso?: string): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  return Math.floor(ms / 1000);
}

function formatDate(epoch?: number): string {
  if (!epoch) return "";
  const sec = epoch > 1e11 ? Math.floor(epoch / 1000) : epoch;
  const d = new Date(sec * 1000);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function extractEmail(from?: string): string {
  const raw = from?.trim() ?? "";
  const angle = /<([^>]+)>/.exec(raw);
  return (angle?.[1] ?? raw).trim();
}

function replySubject(subject?: string): string {
  const s = subject?.trim() || "";
  return /^re:/i.test(s) ? s : `Re: ${s || "(no subject)"}`;
}

function hitsToMessages(
  hits: Array<{
    externalId?: string;
    threadId?: string;
    subject?: string;
    from?: string;
    snippet?: string;
    unread?: boolean;
    date?: string;
    messageCount?: number;
  }>,
): MessageSummary[] {
  return hits.map((h) => {
    const count = h.messageCount && h.messageCount > 1 ? h.messageCount : undefined;
    const snippet =
      count != null ? `${count} messages · ${(h.snippet ?? "").trim()}` : h.snippet;
    return {
      id: h.externalId ?? h.threadId ?? Math.random().toString(36).slice(2),
      subject: h.subject,
      from: h.from,
      snippet,
      unread: h.unread,
      date: parseIsoDateEpoch(h.date),
      threadId: h.threadId,
      messageCount: count,
    };
  });
}

function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [connectorsStatus, setConnectorsStatus] = useState<ConnectorsStatus | null>(null);
  const [inbox, setInbox] = useState<MailInbox>({ kind: "nylas" });
  const [pane, setPane] = useState<Pane>("inbox");
  const [messages, setMessages] = useState<MessageSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MessageDetail | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [mirrorSyncing, setMirrorSyncing] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(false);

  const [agentEmail, setAgentEmail] = useState("");
  const [notifyEmail, setNotifyEmail] = useState("");
  const [compose, setCompose] = useState({
    to: "",
    subject: "",
    body: "",
    replyToMessageId: "",
    replyThreadId: "",
  });
  const [profile, setProfile] = useState({
    ownerName: "Dan",
    assistantName: "Patrick",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    primaryWorkEmail: "",
  });

  const [voiceOn, setVoiceOn] = useState(false);
  const [gatewayVoiceAvailable, setGatewayVoiceAvailable] = useState(false);
  const [voiceState, setVoiceState] = useState("idle");
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const [voiceAssistant, setVoiceAssistant] = useState("");
  const voiceSessionRef = useRef<{ stop: () => Promise<void> } | null>(null);
  const guiRef = useRef<MailGuiAgentApi | null>(null);

  const mailbox = status?.agent.email ?? agentEmail;
  const nylasProvisioned = Boolean(status?.agent.provisioned);
  const gmailAccounts = connectorsStatus?.gmail?.accounts ?? [];
  const gmailConnected = gmailAccounts.length > 0 || Boolean(connectorsStatus?.gmail?.connected);
  const accountReady = inbox.kind === "nylas" ? nylasProvisioned : gmailAccounts.length > 0;
  const accountLabel =
    inbox.kind === "nylas"
      ? mailbox || "Agent mailbox"
      : inbox.email || inbox.accountKey || "Gmail";
  const voiceSessionId = useMemo(() => `jmail:${mailbox || "default"}`, [mailbox]);
  const [chatRev, setChatRev] = useState(() => readJmailChatThreadRev());
  const chatThreadId = useMemo(
    () => buildJmailChatThreadId(mailbox, chatRev),
    [mailbox, chatRev],
  );

  const startNewAgentChat = useCallback(async () => {
    try {
      await fetch(`/joshu/api/ag-ui/session?threadId=${encodeURIComponent(chatThreadId)}`, {
        method: "DELETE",
      });
    } catch {
      /* best-effort */
    }
    const rev = rotateJmailChatThread();
    setChatRev(rev);
  }, [chatThreadId]);

  const loadConnectorsStatus = useCallback(async () => {
    try {
      const data = await platform.connections.status();
      setConnectorsStatus(data);
      return data;
    } catch {
      return null;
    }
  }, []);

  const loadStatus = useCallback(async () => {
    const [nylasData, connectors] = await Promise.all([
      platform.nylas.status(),
      loadConnectorsStatus(),
    ]);
    const data = nylasData as Status;
    setStatus(data);
    if (data.agent.email) setAgentEmail(data.agent.email);
    const accounts = connectors?.gmail?.accounts ?? [];
    const gmailOk = accounts.length > 0 || Boolean(connectors?.gmail?.connected);
    if (!data.agent.provisioned && !gmailOk) {
      setPane("setup");
    } else if (!data.agent.provisioned && accounts[0]) {
      const g = accounts[0]!;
      setInbox({
        kind: "gmail",
        connectedAccountId: g.connectedAccountId,
        accountKey: g.accountKey,
        email: g.email,
      });
    } else if (data.agent.provisioned) {
      setInbox({ kind: "nylas" });
    }
  }, [loadConnectorsStatus]);

  const loadIdentityAndProfile = useCallback(async () => {
    try {
      const [identity, profileData] = await Promise.all([
        platform.identity.get().catch(() => null),
        platform.nylas.getProfile().catch(() => null),
      ]);
      if (identity) {
        setProfile((prev) => ({
          ...prev,
          assistantName: identity.name ?? prev.assistantName,
          ownerName: identity.owner?.displayName ?? prev.ownerName,
        }));
      }
      if (profileData?.profile) {
        const data = profileData.profile as typeof profile;
        setProfile((prev) => ({
          ...prev,
          ...data,
          assistantName: data.assistantName ?? prev.assistantName,
          ownerName: data.ownerName ?? prev.ownerName,
        }));
      }
    } catch {
      /* identity optional during setup */
    }
  }, []);

  const syncMirror = useCallback(
    async (opts?: { ifEmpty?: boolean; days?: number }) => {
      if (!accountReady) return;
      setMirrorSyncing(true);
      setError("");
      try {
        const mailProvider = inbox.kind === "nylas" ? "nylas" : "gmail";
        const data = await platform.mail.sync({
          provider: mailProvider,
          limit: 100,
          days: opts?.days ?? 7,
          ifEmpty: opts?.ifEmpty === true,
          connectedAccountId: inbox.kind === "gmail" ? inbox.connectedAccountId : undefined,
        });
        if (data.skipped) {
          setNotice("Local mail store already has messages");
        } else {
          setNotice(`Synced ${data.threadsWritten ?? 0} threads (last 7 days)`);
        }
        await loadConnectorsStatus();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setMirrorSyncing(false);
      }
    },
    [inbox, accountReady, loadConnectorsStatus],
  );

  const ensureMirrorIfEmpty = useCallback(async () => {
    if (!accountReady) return;
    try {
      const mailProvider = inbox.kind === "nylas" ? "nylas" : "gmail";
      const data = await platform.mail.mirror({ provider: mailProvider }).catch(() => null);
      if (data && data.empty === false) return;
    } catch {
      /* proceed to sync attempt */
    }
    setBootstrapping(true);
    try {
      await syncMirror({ ifEmpty: true, days: 7 });
    } finally {
      setBootstrapping(false);
    }
  }, [inbox, accountReady, syncMirror]);

  const loadMessages = useCallback(async () => {
    if (!accountReady) return;
    setLoadingList(true);
    setError("");
    try {
      const q = search.trim();
      if (inbox.kind === "gmail" || q) {
        const mailProvider = inbox.kind === "nylas" ? "nylas" : "gmail";
        const data = await platform.mail.search({
          provider: mailProvider,
          q: q || undefined,
          limit: 50,
          connectedAccountId: inbox.kind === "gmail" ? inbox.connectedAccountId : undefined,
        });
        const rows = hitsToMessages(data.hits ?? []);
        rows.sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
        setMessages(rows);
        return;
      }
      const data = await platform.nylas.listMessages(40);
      setMessages((data.messages ?? []) as MessageSummary[]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingList(false);
    }
  }, [inbox, accountReady, search]);

  const loadDetail = useCallback(
    async (messageId: string) => {
      setLoadingDetail(true);
      setError("");
      try {
        if (inbox.kind === "gmail") {
          const data = (await platform.mail.getGmailMessage(messageId, inbox.connectedAccountId)) as {
            message?: MessageDetail;
            threadMessages?: Array<{
              id: string;
              from?: string;
              subject?: string;
              date?: string;
              dateEpoch?: number;
              body: string;
            }>;
            error?: string;
          };
          const msg = data.message;
          const threadMessages: ThreadMessage[] = (data.threadMessages ?? []).map((tm) => ({
            id: tm.id,
            from: tm.from,
            subject: tm.subject,
            date: tm.dateEpoch ?? parseIsoDateEpoch(tm.date),
            body: tm.body,
          }));
          setDetail(
            msg
              ? {
                  ...msg,
                  threadId: msg.threadId,
                  threadMessages: threadMessages.length > 0 ? threadMessages : undefined,
                }
              : null,
          );
          return;
        }
        const data = (await platform.nylas.getMessage(messageId)) as {
          message?: MessageDetail;
          error?: string;
        };
        const message = data.message ?? null;
        setDetail(message);
        if (message?.unread) {
          await platform.nylas.patchMessage(messageId, { unread: false });
          setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, unread: false } : m)));
        }
      } catch (err) {
        setError((err as Error).message);
        setDetail(null);
      } finally {
        setLoadingDetail(false);
      }
    },
    [inbox],
  );

  const loadMessagesWithQuery = useCallback(
    async (query: string) => {
      if (!accountReady) return;
      setSearch(query);
      setLoadingList(true);
      setError("");
      try {
        const q = query.trim();
        if (inbox.kind === "gmail" || q) {
          const mailProvider = inbox.kind === "nylas" ? "nylas" : "gmail";
          const data = await platform.mail.search({
            provider: mailProvider,
            q: q || undefined,
            limit: 50,
            connectedAccountId: inbox.kind === "gmail" ? inbox.connectedAccountId : undefined,
          });
          const rows = hitsToMessages(data.hits ?? []);
          rows.sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
          setMessages(rows);
          return;
        }
        const data = await platform.nylas.listMessages(40);
        setMessages((data.messages ?? []) as MessageSummary[]);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoadingList(false);
      }
    },
    [inbox, accountReady],
  );

  const switchInboxFromAgent = useCallback(
    (raw: Record<string, unknown>) => {
      if (raw.kind === "gmail" && typeof raw.connectedAccountId === "string") {
        const match = gmailAccounts.find((g) => g.connectedAccountId === raw.connectedAccountId);
        if (match) {
          setInbox({
            kind: "gmail",
            connectedAccountId: match.connectedAccountId,
            accountKey: match.accountKey,
            email: match.email,
          });
          return;
        }
      }
      if (raw.kind === "nylas" || nylasProvisioned) {
        setInbox({ kind: "nylas" });
      }
    },
    [gmailAccounts, nylasProvisioned],
  );

  const handleVoiceAppAction = useCallback((action: string, args?: Record<string, unknown>) => {
    const api = guiRef.current;
    if (!api) return;
    if (action === "openCompose") {
      api.openCompose({
        to: typeof args?.to === "string" ? args.to : undefined,
        subject: typeof args?.subject === "string" ? args.subject : undefined,
        body: typeof args?.body === "string" ? args.body : undefined,
      });
      return;
    }
    if (action === "searchMail") {
      void api.searchMail(String(args?.query ?? ""));
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    void loadIdentityAndProfile();
  }, [loadStatus, loadIdentityAndProfile]);

  useEffect(() => {
    let cancelled = false;
    void fetchVoiceGatewayStatus(VOICE_API_BASE).then((s) => {
      if (!cancelled) setGatewayVoiceAvailable(Boolean(s.available));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!voiceOn || !gatewayVoiceAvailable || !nylasProvisioned || inbox.kind !== "nylas") {
      void voiceSessionRef.current?.stop();
      voiceSessionRef.current = null;
      if (!voiceOn) setVoiceState("idle");
      return;
    }

    let cancelled = false;
    setVoiceTranscript("");
    setVoiceAssistant("");

    void (async () => {
      try {
        const session = await startJoshuVoiceSession({
          voiceApiBase: VOICE_API_BASE,
          sessionId: voiceSessionId,
          surface: {
            appId: JMAIL_MANIFEST.id,
            voiceCommands: JMAIL_MANIFEST.agent?.voiceCommands,
          },
          onDesktopAction: (action) => {
            void executeDesktopAction(action);
          },
          onAppAction: ({ action, args }) => handleVoiceAppAction(action, args),
          onState: setVoiceState,
          onUserTranscript: (text, partial) => {
            if (!partial) setVoiceTranscript(text);
          },
          onAssistantDelta: (delta) => setVoiceAssistant((prev) => prev + delta),
          onAssistantDone: (text) => setVoiceAssistant(text),
          onThinkJobStart: () => setVoiceAssistant(""),
          onBargeIn: () => setVoiceAssistant(""),
          onError: (msg) => setError(msg),
        });
        if (cancelled) {
          await session.stop();
          return;
        }
        voiceSessionRef.current = session;
      } catch (err) {
        if (!cancelled) {
          setError(`Voice connection failed: ${(err as Error).message}`);
        }
      }
    })();

    return () => {
      cancelled = true;
      void voiceSessionRef.current?.stop();
      voiceSessionRef.current = null;
    };
  }, [voiceOn, gatewayVoiceAvailable, nylasProvisioned, inbox, voiceSessionId, handleVoiceAppAction]);

  useEffect(() => {
    setSelectedId(null);
    setDetail(null);
    if (!accountReady || pane !== "inbox") return;
    void (async () => {
      await ensureMirrorIfEmpty();
      await loadMessages();
    })();
  }, [inbox, accountReady, pane, ensureMirrorIfEmpty, loadMessages]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  const selectedSummary = useMemo(
    () => messages.find((m) => m.id === selectedId) ?? null,
    [messages, selectedId],
  );

  const openCompose = (opts?: {
    to?: string;
    subject?: string;
    body?: string;
    replyToMessageId?: string;
    replyThreadId?: string;
  }) => {
    setCompose({
      to: opts?.to ?? "",
      subject: opts?.subject ?? "",
      body: opts?.body ?? "",
      replyToMessageId: opts?.replyToMessageId ?? "",
      replyThreadId: opts?.replyThreadId ?? "",
    });
    setPane("compose");
    setNotice("");
  };

  const startReply = () => {
    if (!detail) return;
    const to = inbox.kind === "gmail" ? extractEmail(detail.from) : detail.from ?? "";
    openCompose({
      to,
      subject: inbox.kind === "gmail" ? "" : replySubject(detail.subject),
      body: `\n\n---\nOn ${formatDate(detail.date)}, ${formatAddress(detail.fromName, detail.from)} wrote:\n${detail.snippet ?? detail.body?.slice(0, 500) ?? ""}`,
      replyToMessageId: detail.id,
      replyThreadId: detail.threadId ?? "",
    });
  };

  const provisionAgent = async () => {
    setNotice("");
    setError("");
    const data = (await platform.nylas.provisionAgent(agentEmail)) as {
      ok?: boolean;
      error?: string;
      agent?: { email: string };
    };
    if (data.ok) {
      setNotice(`Mailbox ready: ${data.agent?.email}`);
      await loadStatus();
      setPane("inbox");
    } else {
      setError(data.error ?? "Provision failed");
    }
  };

  const sendMail = async () => {
    setNotice("");
    setError("");
    if (inbox.kind === "gmail") {
      const isReply = Boolean(compose.replyThreadId);
      const payload = isReply
        ? {
            threadId: compose.replyThreadId,
            recipientEmail: compose.to,
            body: compose.body,
            connectedAccountId: inbox.connectedAccountId,
          }
        : {
            to: compose.to,
            subject: compose.subject,
            body: compose.body,
            connectedAccountId: inbox.connectedAccountId,
          };
      const data = (await (isReply
        ? platform.mail.replyGmail(payload)
        : platform.mail.sendGmail(payload))) as { ok?: boolean; error?: string };
      if (data.ok) {
        setNotice("Message sent via Gmail");
        setPane("inbox");
        setCompose({ to: "", subject: "", body: "", replyToMessageId: "", replyThreadId: "" });
        void loadMessages();
      } else {
        setError(data.error ?? "Send failed");
      }
      return;
    }
    const data = (await platform.nylas.sendMessage(
      {
        to: compose.to,
        subject: compose.subject,
        body: compose.body,
        replyToMessageId: compose.replyToMessageId || undefined,
      },
      { "X-Joshu-Mail-Client": "jmail" },
    )) as { ok?: boolean; error?: string };
    if (data.ok) {
      setNotice("Message sent");
      setPane("inbox");
      setCompose({ to: "", subject: "", body: "", replyToMessageId: "", replyThreadId: "" });
      void loadMessages();
    } else {
      setError(data.error ?? "Send failed");
    }
  };

  const testSend = async () => {
    setNotice("");
    setError("");
    const data = (await platform.nylas.testSend(notifyEmail)) as {
      ok?: boolean;
      error?: string;
      from?: string;
    };
    if (data.ok) setNotice(`Test sent from ${data.from}`);
    else setError(data.error ?? "Send failed");
  };

  const saveProfile = async () => {
    setNotice("");
    setError("");
    const data = (await platform.nylas.saveProfile({
      ...profile,
      assistantEmail: mailbox,
    })) as { ok?: boolean; error?: string };
    if (data.ok) setNotice("Profile saved");
    else setError(data.error ?? "Save failed");
  };

  guiRef.current = {
    getGuiSnapshot: () => {
      const inboxKind = inbox.kind;
      const inboxLabel =
        inboxKind === "nylas"
          ? { kind: "nylas" as const, mailbox }
          : { kind: "gmail" as const, email: inbox.email, connectedAccountId: inbox.connectedAccountId };

      if (pane === "setup") {
        return { pane, inbox: inboxLabel, activeView: "setup" as const };
      }

      if (pane === "compose") {
        return {
          pane,
          inbox: inboxLabel,
          activeView: "compose" as const,
          compose: {
            to: compose.to,
            subject: compose.subject,
            bodyPreview: compose.body.slice(0, 600),
            bodyLength: compose.body.length,
            replyThreadId: compose.replyThreadId || undefined,
          },
        };
      }

      // Inbox — only expose the thread/list the user actually sees (not background compose state).
      if (selectedId && detail) {
        return {
          pane,
          inbox: inboxLabel,
          search: search || undefined,
          activeView: "thread" as const,
          inboxPreview: buildInboxPreview(messages),
          openThread: {
            id: detail.id,
            subject: detail.subject,
            from: detail.from,
            fromName: detail.fromName,
            date: detail.date,
            threadId: detail.threadId,
            bodyPreview: (detail.body ?? detail.snippet ?? "").slice(0, 600),
          },
        };
      }

      if (selectedId) {
        return {
          pane,
          inbox: inboxLabel,
          search: search || undefined,
          activeView: "thread_loading" as const,
          selectedId,
        };
      }

      return {
        pane,
        inbox: inboxLabel,
        search: search || undefined,
        activeView: "inbox_list" as const,
        messageCount: messages.length,
        inboxPreview: buildInboxPreview(messages),
      };
    },
    getInboxListSummary: (limit = 10) => formatInboxPreviewForAgent(messages, limit),
    openCompose,
    openThread: (messageId: string) => {
      setPane("inbox");
      setSelectedId(messageId);
    },
    searchMail: loadMessagesWithQuery,
    switchInbox: switchInboxFromAgent,
    startReply,
    syncMirror: (opts) => syncMirror({ days: opts?.days ?? 7 }),
    loadMessages,
    setPane,
  };

  return (
    <div className="mail-app">
        <header className="mail-header">
          <div>
            <h1>jMail</h1>
            <p className="mail-subtitle">
              {accountReady ? (
                <>
                  <strong>{accountLabel}</strong>
                  {bootstrapping || mirrorSyncing ? " — syncing…" : ""}
                </>
              ) : (
                "Set up agent mail or connect Gmail in Connectors"
              )}
            </p>
          </div>
          <div className="mail-header-actions">
            {(nylasProvisioned || gmailAccounts.length > 0) && (
              <div className="account-switcher" role="tablist" aria-label="Mail account">
                {nylasProvisioned && (
                  <button
                    type="button"
                    role="tab"
                    className={inbox.kind === "nylas" ? "active" : ""}
                    aria-selected={inbox.kind === "nylas"}
                    onClick={() => setInbox({ kind: "nylas" })}
                    title={mailbox || "Agent mailbox"}
                  >
                    Agent
                  </button>
                )}
                {gmailAccounts.map((g) => {
                  const tabInbox: MailInbox = {
                    kind: "gmail",
                    connectedAccountId: g.connectedAccountId,
                    accountKey: g.accountKey,
                    email: g.email,
                  };
                  return (
                    <button
                      key={g.connectedAccountId}
                      type="button"
                      role="tab"
                      className={inboxIsActive(tabInbox, inbox) ? "active" : ""}
                      aria-selected={inboxIsActive(tabInbox, inbox)}
                      onClick={() => setInbox(tabInbox)}
                      title={g.email ?? g.accountKey}
                    >
                      {g.email?.split("@")[0] ?? g.accountKey}
                    </button>
                  );
                })}
              </div>
            )}
            {nylasProvisioned && inbox.kind === "nylas" && gatewayVoiceAvailable && (
              <button
                type="button"
                className={voiceOn ? "" : "secondary"}
                aria-pressed={voiceOn}
                onClick={() => setVoiceOn((v) => !v)}
                title="Voice assistant — OpenAI Realtime S2S + selective Hermes"
              >
                Voice {voiceOn ? voiceState : "off"}
              </button>
            )}
            {accountReady && (
              <>
                {(inbox.kind === "nylas" || inbox.kind === "gmail") && (
                  <button type="button" onClick={() => openCompose()}>
                    Compose
                  </button>
                )}
                <button type="button" className="secondary" onClick={() => void loadMessages()} disabled={loadingList}>
                  Refresh
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void syncMirror({ days: 7 })}
                  disabled={mirrorSyncing || bootstrapping}
                  title="Sync last 7 days to joshu's files for File Brain (gbrain)"
                >
                  {mirrorSyncing || bootstrapping ? "Syncing…" : "Sync mirror"}
                </button>
              </>
            )}
            <button
              type="button"
              className="secondary"
              onClick={() => setPane(pane === "setup" ? (accountReady ? "inbox" : "setup") : "setup")}
            >
              {pane === "setup" ? "Back to mail" : "Setup"}
            </button>
          </div>
        </header>

        {!status?.configured && (
          <div className="banner banner-warn">
            Server not configured. Set <code>NYLAS_API_KEY</code> on the Joshu server and register a domain in the
            Nylas Dashboard.
          </div>
        )}

        {error && <div className="banner banner-err">{error}</div>}
        {notice && <div className="banner banner-ok">{notice}</div>}

        {voiceOn && nylasProvisioned && inbox.kind === "nylas" && (
          <section className="panel voice-panel" aria-label="Voice assistant">
            <h2>Voice</h2>
            <p className="mail-subtitle">
              Ask about mail, drafts, or scheduling. Replies stream in the chat below and are spoken aloud.
            </p>
            {voiceTranscript && (
              <p>
                <strong>You:</strong> {voiceTranscript}
              </p>
            )}
            {voiceAssistant && (
              <p>
                <strong>Assistant:</strong> {voiceAssistant}
              </p>
            )}
            {!voiceTranscript && !voiceAssistant && <p className="message-empty">Listening…</p>}
          </section>
        )}

        {pane === "setup" && (
          <div className="setup-panels">
            <section className="panel">
              <h2>Agent mailbox</h2>
              <p>
                Status:{" "}
                {nylasProvisioned ? (
                  <span className="status-ok">{mailbox}</span>
                ) : (
                  "not provisioned"
                )}
              </p>
              <label htmlFor="agentEmail">Agent email address</label>
              <input
                id="agentEmail"
                placeholder="agent@yourdomain.com"
                value={agentEmail}
                onChange={(e) => setAgentEmail(e.target.value)}
              />
              <div className="row-actions">
                <button type="button" onClick={() => void provisionAgent()} disabled={!status?.configured || !agentEmail}>
                  Create Agent Account
                </button>
                <button type="button" className="secondary" onClick={() => void loadStatus()}>
                  Refresh status
                </button>
              </div>
            </section>

            <section className="panel">
              <h2>Test email</h2>
              <label htmlFor="notifyEmail">Your email (test recipient)</label>
              <input
                id="notifyEmail"
                type="email"
                placeholder="you@example.com"
                value={notifyEmail}
                onChange={(e) => setNotifyEmail(e.target.value)}
              />
              <button type="button" onClick={() => void testSend()} disabled={!nylasProvisioned || !notifyEmail}>
                Send test from agent
              </button>
            </section>

            <section className="panel">
              <h2>Agent profile</h2>
              <label htmlFor="ownerName">Your name</label>
              <input
                id="ownerName"
                value={profile.ownerName}
                onChange={(e) => setProfile({ ...profile, ownerName: e.target.value })}
              />
              <label htmlFor="primaryWorkEmail">Notify / primary email</label>
              <input
                id="primaryWorkEmail"
                type="email"
                value={profile.primaryWorkEmail}
                onChange={(e) => setProfile({ ...profile, primaryWorkEmail: e.target.value })}
              />
              <label htmlFor="timezone">Time zone</label>
              <input
                id="timezone"
                value={profile.timezone}
                onChange={(e) => setProfile({ ...profile, timezone: e.target.value })}
              />
              <button type="button" onClick={() => void saveProfile()}>
                Save profile
              </button>
            </section>
          </div>
        )}

        {pane === "compose" && accountReady && (inbox.kind === "nylas" || inbox.kind === "gmail") && (
          <section className="panel compose-panel">
            <h2>{compose.replyThreadId ? "Reply" : "New message"}</h2>
            {inbox.kind === "gmail" && (
              <p className="mail-subtitle">
                {compose.replyThreadId
                  ? "Replies stay in the Gmail thread (Composio GMAIL_REPLY_TO_THREAD)."
                  : "Send via principal Gmail (Composio GMAIL_SEND_EMAIL)."}
              </p>
            )}
            <label htmlFor="composeTo">To</label>
            <input id="composeTo" value={compose.to} onChange={(e) => setCompose({ ...compose, to: e.target.value })} />
            {inbox.kind === "nylas" && (
              <>
                <label htmlFor="composeSubject">Subject</label>
                <input
                  id="composeSubject"
                  value={compose.subject}
                  onChange={(e) => setCompose({ ...compose, subject: e.target.value })}
                />
              </>
            )}
            {inbox.kind === "gmail" && !compose.replyThreadId && (
              <>
                <label htmlFor="composeSubject">Subject</label>
                <input
                  id="composeSubject"
                  value={compose.subject}
                  onChange={(e) => setCompose({ ...compose, subject: e.target.value })}
                />
              </>
            )}
            <label htmlFor="composeBody">Message</label>
            <textarea
              id="composeBody"
              rows={12}
              value={compose.body}
              onChange={(e) => setCompose({ ...compose, body: e.target.value })}
            />
            <div className="row-actions">
              <button
                type="button"
                onClick={() => void sendMail()}
                disabled={
                  !compose.to ||
                  !compose.body ||
                  (inbox.kind === "nylas" && !compose.subject) ||
                  (inbox.kind === "gmail" && !compose.replyThreadId && !compose.subject)
                }
              >
                Send
              </button>
              <button type="button" className="secondary" onClick={() => setPane("inbox")}>
                Cancel
              </button>
            </div>
          </section>
        )}

        {pane === "inbox" && inbox.kind === "gmail" && gmailAccounts.length === 0 && (
          <div className="banner banner-warn">
            Connect Gmail in the <strong>Connectors</strong> app, then return here.{" "}
            <button type="button" className="secondary" onClick={openConnectorsApp}>
              Open Connectors
            </button>
          </div>
        )}

        {pane === "inbox" && accountReady && (
          <div className="mail-layout">
            <aside className="mail-sidebar">
              <div className="sidebar-toolbar">
                <input
                  type="search"
                  placeholder={inbox.kind === "gmail" ? "Search Gmail mirror…" : "Search mail…"}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void loadMessages();
                  }}
                />
                <button type="button" className="secondary" onClick={() => void loadMessages()}>
                  Search
                </button>
              </div>
              <ul className="message-list">
                {loadingList && <li className="message-empty">Loading…</li>}
                {!loadingList && messages.length === 0 && <li className="message-empty">No messages</li>}
                {messages.map((msg) => (
                  <li key={msg.id}>
                    <button
                      type="button"
                      className={`message-row${selectedId === msg.id ? " selected" : ""}${msg.unread ? " unread" : ""}`}
                      onClick={() => setSelectedId(msg.id)}
                    >
                      <span className="message-row-top">
                        <span className="message-from">{formatAddress(msg.fromName, msg.from)}</span>
                        <span className="message-date">{formatDate(msg.date)}</span>
                      </span>
                      <span className="message-subject">{msg.subject || "(no subject)"}</span>
                      <span className="message-snippet">{msg.snippet}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </aside>

            <main className="mail-main">
              {!selectedId && (
                <div className="message-empty-state">
                  <p>Select a message or compose new mail.</p>
                </div>
              )}
              {selectedId && (
                <>
                  {loadingDetail && <p className="message-empty-state">Loading message…</p>}
                  {!loadingDetail && detail && (
                    <article className="message-detail">
                      <header className="message-detail-header">
                        <h2>{detail.subject || "(no subject)"}</h2>
                        {(detail.threadMessages?.length ?? 0) <= 1 && (
                          <p>
                            <strong>From:</strong> {formatAddress(detail.fromName, detail.from)}
                          </p>
                        )}
                        {detail.to && detail.to.length > 0 && (
                          <p>
                            <strong>To:</strong> {detail.to.join(", ")}
                          </p>
                        )}
                        {detail.cc && detail.cc.length > 0 && (
                          <p>
                            <strong>Cc:</strong> {detail.cc.join(", ")}
                          </p>
                        )}
                        <p className="message-meta">
                          {detail.threadMessages && detail.threadMessages.length > 1
                            ? `${detail.threadMessages.length} messages`
                            : formatDate(detail.date)}
                        </p>
                        {(inbox.kind === "nylas" || inbox.kind === "gmail") && (
                          <div className="row-actions">
                            <button type="button" onClick={startReply}>
                              Reply
                            </button>
                          </div>
                        )}
                      </header>
                      {detail.threadMessages && detail.threadMessages.length > 1 ? (
                        <div className="thread-conversation" role="list">
                          {detail.threadMessages.map((tm) => (
                            <section key={tm.id} className="thread-message" role="listitem">
                              <header className="thread-message-header">
                                <span className="thread-message-from">{tm.from ?? "(unknown)"}</span>
                                <span className="thread-message-date">{formatDate(tm.date)}</span>
                              </header>
                              {tm.subject && tm.subject !== detail.subject && (
                                <p className="thread-message-subject">{tm.subject}</p>
                              )}
                              <pre className="message-plain thread-message-body">{tm.body}</pre>
                            </section>
                          ))}
                        </div>
                      ) : detail.body && inbox.kind === "nylas" && detail.body.includes("<") ? (
                        <iframe
                          key={detail.id}
                          className="message-body-frame"
                          title="Message body"
                          sandbox="allow-popups allow-popups-to-escape-sandbox"
                          srcDoc={prepareEmailBodyDocument(detail.body)}
                          onLoad={(event) => {
                            const frame = event.currentTarget;
                            const doc = frame.contentDocument;
                            if (!doc?.body) return;
                            const height = Math.min(Math.max(doc.body.scrollHeight + 24, 320), 2400);
                            frame.style.height = `${height}px`;
                          }}
                        />
                      ) : (
                        <pre className="message-plain">
                          {detail.threadMessages?.[0]?.body ||
                            detail.body ||
                            detail.snippet ||
                            selectedSummary?.snippet}
                        </pre>
                      )}
                    </article>
                  )}
                </>
              )}
            </main>
          </div>
        )}
      <MailAgentBridge
        key={chatThreadId}
        guiRef={guiRef}
        threadId={chatThreadId}
        onNewChat={startNewAgentChat}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
