import "@joshu/design-system/typography.css";
import "@joshu/design-system/tokens.css";
import "@joshu/design-system/base.css";
import "./styles.css";

import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

const CONNECTORS_API = "/joshu/api/connectors";
const COMPOSIO_API = "/joshu/api/connectors/composio";
const DAY0_API = "/joshu/api/day0";
const ONBOARDING_API = "/joshu/api/onboarding";

type ComposioConnectedAccountSummary = {
  connectedAccountId: string;
  label?: string;
};

type ComposioToolkitRow = {
  slug: string;
  name: string;
  logo?: string;
  isConnected: boolean;
  connectedAccountId?: string;
  connectedAccounts?: ComposioConnectedAccountSummary[];
};

type GmailAccountStatus = {
  connectedAccountId: string;
  accountKey: string;
  email?: string;
  label?: string;
  enabled?: boolean;
  isDefault?: boolean;
  sync?: { lastSyncAt?: string; lastError?: string; threadsWritten?: number };
  mirror?: { threadCount: number; empty: boolean };
};

type OwnerChannelStatus = {
  linked?: boolean;
  provider?: "telegram" | "slack";
  telegramChatId?: string;
  slackDmChannelId?: string;
  gateEnabled?: boolean;
  gateMode?: string;
  legacyTelegramFallback?: boolean;
};

type ConnectorsStatus = {
  registry?: { updatedAt?: string };
  ownerChannel?: OwnerChannelStatus;
  nylas: {
    configured: boolean;
    provisioned: boolean;
    email?: string;
    mirror?: { threadCount: number };
  };
  gmail: {
    enabled: boolean;
    connected: boolean;
    accounts: GmailAccountStatus[];
  };
};

type Tab = "overview" | "connect";

type Day0Phase =
  | "idle"
  | "syncing"
  | "extracting"
  | "inferring"
  | "merging"
  | "completed"
  | "failed";

type Day0StatusPayload = {
  day0?: {
    status?: Day0Phase;
    startedAt?: string;
    completedAt?: string;
    threadsAnalyzed?: number;
    eventsAnalyzed?: number;
    fieldsFilled?: string[];
    warnings?: string[];
    error?: string;
    model?: string;
  };
  gmailConnected?: boolean;
  llmConfigured?: boolean;
  model?: string;
};

type OnboardingDraftNames = {
  ownerName?: string;
  assistantName?: string;
};

function formatWhen(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

type SlackbotSetupStatus = {
  composioEnabled?: boolean;
  authConfigConfigured?: boolean;
  authConfigIdPreview?: string;
  webhookConfigured?: boolean;
  webhookUrl?: string;
  setupRequired?: boolean;
  steps?: string[];
};

function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [status, setStatus] = useState<ConnectorsStatus | null>(null);
  const [toolkits, setToolkits] = useState<ComposioToolkitRow[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [composioEnabled, setComposioEnabled] = useState<boolean | null>(null);
  const [day0Status, setDay0Status] = useState<Day0StatusPayload | null>(null);
  const [day0Running, setDay0Running] = useState(false);
  const [day0Message, setDay0Message] = useState("");
  const [showDay0Names, setShowDay0Names] = useState(false);
  const [day0OwnerName, setDay0OwnerName] = useState("");
  const [day0AssistantName, setDay0AssistantName] = useState("");
  const [day0Done, setDay0Done] = useState(false);
  const [ownerProvider, setOwnerProvider] = useState<"telegram" | "slack">("telegram");
  const [ownerTelegramChatId, setOwnerTelegramChatId] = useState("");
  const [ownerSlackChannelId, setOwnerSlackChannelId] = useState("");
  const [ownerChannelMsg, setOwnerChannelMsg] = useState("");
  const [slackbotSetup, setSlackbotSetup] = useState<SlackbotSetupStatus | null>(null);
  const [slackbotManifestText, setSlackbotManifestText] = useState("");
  const [slackbotClientId, setSlackbotClientId] = useState("");
  const [slackbotClientSecret, setSlackbotClientSecret] = useState("");
  const [slackbotSigningSecret, setSlackbotSigningSecret] = useState("");
  const [slackbotAppToken, setSlackbotAppToken] = useState("");
  const [slackbotVerificationToken, setSlackbotVerificationToken] = useState("");
  const [slackbotWizardOpen, setSlackbotWizardOpen] = useState(false);
  const [slackbotMsg, setSlackbotMsg] = useState("");
  const [slackbotWebhookUrl, setSlackbotWebhookUrl] = useState("");

  const refreshStatus = useCallback(async () => {
    const res = await fetch(`${CONNECTORS_API}/status`, { cache: "no-store" });
    if (!res.ok) throw new Error(await res.text());
    const json = (await res.json()) as ConnectorsStatus;
    setStatus(json);
    const oc = json.ownerChannel;
    if (oc?.provider === "slack" || oc?.provider === "telegram") setOwnerProvider(oc.provider);
    if (oc?.telegramChatId) setOwnerTelegramChatId(oc.telegramChatId);
    if (oc?.slackDmChannelId) setOwnerSlackChannelId(oc.slackDmChannelId);
    return json;
  }, []);

  const refreshToolkits = useCallback(
    async (opts?: { restartGateway?: boolean }) => {
      const statusRes = await fetch(`${COMPOSIO_API}/status`, { cache: "no-store" });
      const statusJson = (await statusRes.json()) as { enabled?: boolean };
      setComposioEnabled(Boolean(statusJson.enabled));
      if (!statusJson.enabled) {
        setToolkits([]);
        return;
      }
      await fetch(`${COMPOSIO_API}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ restartGateway: opts?.restartGateway === true }),
      }).catch(() => undefined);
      const params = new URLSearchParams();
      const q = search.trim();
      if (q) params.set("search", q);
      const listRes = await fetch(`${COMPOSIO_API}/toolkits?${params}`, { cache: "no-store" });
      if (!listRes.ok) throw new Error(await listRes.text());
      const listJson = (await listRes.json()) as { toolkits?: ComposioToolkitRow[] };
      setToolkits(Array.isArray(listJson.toolkits) ? listJson.toolkits : []);
    },
    [search],
  );

  const refreshDay0Status = useCallback(async () => {
    const res = await fetch(`${DAY0_API}/status`, { cache: "no-store" });
    if (!res.ok) throw new Error(await res.text());
    const json = (await res.json()) as Day0StatusPayload;
    setDay0Status(json);
    return json;
  }, []);

  const refreshSlackbotSetup = useCallback(async () => {
    const res = await fetch(`${COMPOSIO_API}/slackbot/setup`, { cache: "no-store" });
    if (!res.ok) return null;
    const json = (await res.json()) as SlackbotSetupStatus & { ok?: boolean };
    setSlackbotSetup(json);
    if (json.webhookUrl) setSlackbotWebhookUrl(json.webhookUrl);
    if (json.setupRequired) setSlackbotWizardOpen(true);
    return json;
  }, []);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      await refreshStatus();
      await refreshToolkits();
      await refreshDay0Status().catch(() => undefined);
      await refreshSlackbotSetup().catch(() => undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [refreshStatus, refreshToolkits, refreshDay0Status, refreshSlackbotSetup]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  // Deep-link from Chat sharing: /joshu/connectors#slackbot
  useEffect(() => {
    const openSlackbot = () => {
      if (window.location.hash.replace(/^#/, "") === "slackbot") {
        setTab("connect");
        setSlackbotWizardOpen(true);
      }
    };
    openSlackbot();
    window.addEventListener("hashchange", openSlackbot);
    return () => window.removeEventListener("hashchange", openSlackbot);
  }, []);

  useEffect(() => {
    const onFocus = () => void refreshAll();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshAll]);

  const openOAuthPopup = (redirectUrl: string, slug: string) => {
    const popup = window.open(redirectUrl, "_blank", "noopener,noreferrer");
    if (!popup) throw new Error("Pop-up blocked — allow pop-ups and try again.");
    const poll = window.setInterval(() => {
      if (!popup.closed) return;
      window.clearInterval(poll);
      void (async () => {
        await fetch(`${COMPOSIO_API}/post-connect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ toolkit: slug, restartGateway: true }),
        });
        await refreshAll();
      })();
    }, 500);
  };

  const connectToolkit = async (slug: string) => {
    const busyKey = `connect-${slug}`;
    setBusy(busyKey);
    setError("");
    try {
      const slugLower = slug.toLowerCase();
      // Slackbot needs the in-UI wizard before OAuth — never surface raw API JSON.
      if (slugLower === "slackbot") {
        const setup = slackbotSetup ?? (await refreshSlackbotSetup().catch(() => null));
        if (!setup?.authConfigConfigured) {
          setTab("connect");
          setSlackbotWizardOpen(true);
          setSlackbotMsg(
            setup?.steps?.[0]
              ? "Finish the steps below, then Save & Connect."
              : "Generate a Slack app manifest, paste Client ID, Client Secret, Signing Secret, and App-Level Token (xapp-), then Save & Connect.",
          );
          setBusy(null);
          return;
        }
      }
      const res = await fetch(`${COMPOSIO_API}/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolkit: slug, callbackUrl: window.location.href }),
      });
      const rawText = await res.text();
      let json: {
        redirectUrl?: string;
        error?: string;
        code?: string;
        hint?: string;
      } = {};
      try {
        json = rawText ? (JSON.parse(rawText) as typeof json) : {};
      } catch {
        /* non-JSON */
      }
      if (!res.ok) {
        if (
          slugLower === "slackbot" &&
          (json.code === "slackbot_setup_required" || json.error === "slackbot_setup_required")
        ) {
          setSlackbotWizardOpen(true);
          setSlackbotMsg(json.hint || "Finish Slackbot setup below, then Save & Connect.");
          setBusy(null);
          return;
        }
        throw new Error(json.hint || json.error || rawText || `HTTP ${res.status}`);
      }
      if (!json.redirectUrl) throw new Error("Missing redirect URL from Composio");
      openOAuthPopup(json.redirectUrl, slug);
      setBusy(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  const loadSlackbotManifest = async () => {
    setBusy("slackbot-manifest");
    setSlackbotMsg("");
    try {
      const res = await fetch(`${COMPOSIO_API}/slackbot/manifest`, { cache: "no-store" });
      if (!res.ok) throw new Error(await res.text());
      const json = (await res.json()) as { manifestText?: string };
      setSlackbotManifestText(json.manifestText || "");
      setSlackbotMsg("Manifest ready — copy or download, then create the app at api.slack.com.");
    } catch (err) {
      setSlackbotMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const saveAndConnectSlackbot = async () => {
    setBusy("slackbot-save");
    setSlackbotMsg("");
    setError("");
    try {
      const res = await fetch(`${COMPOSIO_API}/slackbot/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
          clientId: slackbotClientId,
          clientSecret: slackbotClientSecret,
          signingSecret: slackbotSigningSecret,
          appToken: slackbotAppToken,
          verificationToken: slackbotVerificationToken || slackbotSigningSecret,
          connect: true,
          callbackUrl: window.location.href,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        redirectUrl?: string;
        webhookUrl?: string;
        status?: SlackbotSetupStatus;
        rebind?: { ok?: number; failed?: unknown[] };
      };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      if (json.status) setSlackbotSetup(json.status);
      if (json.webhookUrl) setSlackbotWebhookUrl(json.webhookUrl);
      setSlackbotClientSecret("");
      setSlackbotSigningSecret("");
      setSlackbotAppToken("");
      setSlackbotVerificationToken("");
      const rebindNote =
        json.rebind && typeof json.rebind.ok === "number"
          ? ` Rebound triggers on ${json.rebind.ok} channel(s).`
          : "";
      if (json.redirectUrl) {
        setSlackbotMsg(
          `Auth + webhook saved.${rebindNote} Approve Slack OAuth in the popup, then paste Event URL into Slack Event Subscriptions.`,
        );
        openOAuthPopup(json.redirectUrl, "slackbot");
      } else {
        setSlackbotMsg(`Auth + webhook saved.${rebindNote} Click Connect if OAuth is still needed.`);
      }
    } catch (err) {
      setSlackbotMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const disconnectAccount = async (connectedAccountId: string) => {
    setBusy(connectedAccountId);
    setError("");
    try {
      const res = await fetch(`${COMPOSIO_API}/disconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectedAccountId }),
      });
      if (!res.ok) throw new Error(await res.text());
      await refreshAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const syncGmailAccount = async (connectedAccountId: string) => {
    setBusy(`sync-${connectedAccountId}`);
    setError("");
    try {
      const res = await fetch(`${CONNECTORS_API}/mail/gmail/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectedAccountId, syncMode: "incremental", limit: 40 }),
      });
      if (!res.ok) throw new Error(await res.text());
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const loadDraftNames = async (): Promise<OnboardingDraftNames> => {
    const res = await fetch(`${ONBOARDING_API}/draft`, { cache: "no-store" });
    if (!res.ok) return {};
    const json = (await res.json()) as { draft?: OnboardingDraftNames | null };
    return json.draft ?? {};
  };

  const day0PhaseLabel = (phase?: Day0Phase): string => {
    switch (phase) {
      case "syncing":
        return "Syncing mail & calendar (30 days)…";
      case "extracting":
        return "Extracting thread signals…";
      case "inferring":
        return "Analyzing with LLM…";
      case "merging":
        return "Pre-filling Welcome draft…";
      case "completed":
        return "Done — open Welcome to review.";
      case "failed":
        return "Failed";
      default:
        return "Starting…";
    }
  };

  const runDay0ColdStart = async (opts?: {
    force?: boolean;
    ownerName?: string;
    assistantName?: string;
    connectedAccountId?: string;
  }) => {
    setDay0Running(true);
    setDay0Done(false);
    setDay0Message(day0PhaseLabel("syncing"));
    setError("");
    const poll = window.setInterval(() => {
      void refreshDay0Status().then((s) => {
        if (s.day0?.status && s.day0.status !== "idle" && s.day0.status !== "completed") {
          setDay0Message(day0PhaseLabel(s.day0.status));
        }
      });
    }, 2000);
    try {
      const res = await fetch(`${DAY0_API}/cold-start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          force: opts?.force === true,
          ownerName: opts?.ownerName,
          assistantName: opts?.assistantName,
          connectedAccountId: opts?.connectedAccountId,
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        skipped?: boolean;
        error?: string;
        day0?: Day0StatusPayload["day0"];
      };
      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? `Day 0 failed (${res.status})`);
      }
      await refreshDay0Status();
      setDay0Message(
        json.skipped
          ? "Already completed — use Run again to re-analyze."
          : day0PhaseLabel("completed"),
      );
      setDay0Done(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDay0Message(day0PhaseLabel("failed"));
    } finally {
      window.clearInterval(poll);
      setDay0Running(false);
    }
  };

  const startDay0 = async (force = false) => {
    const draft = await loadDraftNames();
    const owner = draft.ownerName?.trim() || day0OwnerName.trim();
    const assistant = draft.assistantName?.trim() || day0AssistantName.trim();
    if (!owner || !assistant) {
      setDay0OwnerName(owner);
      setDay0AssistantName(assistant);
      setShowDay0Names(true);
      return;
    }
    setShowDay0Names(false);
    await runDay0ColdStart({
      force,
      ownerName: owner,
      assistantName: assistant,
    });
  };

  const gmailAccounts = status?.gmail.accounts ?? [];
  const gmailAccountById = useMemo(
    () => new Map(gmailAccounts.map((a) => [a.connectedAccountId, a])),
    [gmailAccounts],
  );

  const accountLabel = (slug: string, acct: ComposioConnectedAccountSummary): string => {
    if (slug === "gmail") {
      const reg = gmailAccountById.get(acct.connectedAccountId);
      return reg?.email ?? reg?.accountKey ?? acct.label ?? acct.connectedAccountId;
    }
    return acct.label ?? acct.connectedAccountId;
  };


  const saveOwnerChannel = async () => {
    setBusy("owner-channel-save");
    setOwnerChannelMsg("");
    setError("");
    try {
      const res = await fetch("/joshu/api/connectors/owner-channel", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: ownerProvider,
          telegramChatId: ownerTelegramChatId.trim() || undefined,
          slackDmChannelId: ownerSlackChannelId.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      await refreshStatus();
      setOwnerChannelMsg("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const testOwnerChannel = async () => {
    setBusy("owner-channel-test");
    setOwnerChannelMsg("");
    setError("");
    try {
      const res = await fetch("/joshu/api/owner-channel/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: "Connectors test approval" }),
      });
      const json = (await res.json()) as { ok?: boolean; message?: string; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? json.message ?? "Test failed");
      setOwnerChannelMsg(json.message ?? "Test sent — check your owner DM.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const overviewCards = useMemo(
    () => [
      {
        title: "Agent mailbox (Nylas)",
        detail: status?.nylas.provisioned
          ? `${status.nylas.email ?? "provisioned"} · ${status.nylas.mirror?.threadCount ?? 0} mirrored threads`
          : status?.nylas.configured
            ? "Not provisioned — open jMail Setup"
            : "NYLAS_API_KEY not configured",
      },
      {
        title: "Gmail accounts",
        detail:
          gmailAccounts.length > 0
            ? `${gmailAccounts.length} connected`
            : composioEnabled
              ? "None connected — add in Connect tab"
              : "Composio not configured",
      },
    ],
    [status, gmailAccounts.length, composioEnabled],
  );

  return (
    <div className="app">
      <header>
        <p className="eyebrow">Joshu</p>
        <h1>Connectors</h1>
        <p className="sub">Manage OAuth connections, Gmail mirrors, and sync health for all Joshu apps.</p>
      </header>

      <nav className="tabs" aria-label="Sections">
        {(["overview", "connect"] as Tab[]).map((t) => (
          <button key={t} type="button" className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {t === "overview" ? "Overview" : "Connect apps"}
          </button>
        ))}
        <button type="button" className="btn" onClick={() => void refreshAll()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </nav>

      {error && <p className="error">{error}</p>}

{tab === "overview" && (
        <>
          <section className="card">
            <h2>Owner 1:1 channel</h2>
            <p className="hint">
              Approve or deny agent writes from a private Telegram or Slack DM. Link Telegram by sending /start to the
              action-guard bot, or enter a chat ID below.
            </p>
            <p className="hint">
              Status:{" "}
              {status?.ownerChannel?.linked
                ? `Linked (${status.ownerChannel.provider ?? "telegram"})`
                : "Not linked"}
              {status?.ownerChannel?.gateEnabled ? ` · gate on (${status.ownerChannel.gateMode ?? "external_writes"})` : " · gate off"}
            </p>
            <div className="search-row">
              <label>
                Provider{" "}
                <select
                  value={ownerProvider}
                  onChange={(e) => setOwnerProvider(e.target.value as "telegram" | "slack")}
                >
                  <option value="telegram">Telegram</option>
                  <option value="slack">Slack</option>
                </select>
              </label>
            </div>
            {ownerProvider === "telegram" ? (
              <div className="search-row">
                <input
                  type="text"
                  value={ownerTelegramChatId}
                  onChange={(e) => setOwnerTelegramChatId(e.target.value)}
                  placeholder="Telegram chat ID (from /start)"
                  aria-label="Telegram chat ID"
                />
              </div>
            ) : (
              <div className="search-row">
                <input
                  type="text"
                  value={ownerSlackChannelId}
                  onChange={(e) => setOwnerSlackChannelId(e.target.value)}
                  placeholder="Slack DM channel ID (D…)"
                  aria-label="Slack DM channel ID"
                />
              </div>
            )}
            <div className="composio-account-actions">
              <button type="button" className="btn btn-primary" disabled={busy === "owner-channel-save"} onClick={() => void saveOwnerChannel()}>
                {busy === "owner-channel-save" ? "Saving…" : "Save"}
              </button>
              <button type="button" className="btn" disabled={busy === "owner-channel-test"} onClick={() => void testOwnerChannel()}>
                {busy === "owner-channel-test" ? "Sending…" : "Test approval"}
              </button>
            </div>
            {ownerChannelMsg && <p className="hint">{ownerChannelMsg}</p>}
          </section>
          {overviewCards.map((card) => (
            <section key={card.title} className="card">
              <h2>{card.title}</h2>
              <p className="hint">{card.detail}</p>
            </section>
          ))}
          {status?.registry?.updatedAt && (
            <p className="hint">Registry updated {formatWhen(status.registry.updatedAt)}</p>
          )}
        </>
      )}

      {tab === "connect" && (
        <section className="card">
          <h2>Composio apps</h2>
          <p className="hint">
            Connect each app once per account. Google apps (Gmail, Calendar, Drive) support multiple accounts —
            use &quot;Connect another account&quot; after the first OAuth.
          </p>
          {composioEnabled === false && (
            <p className="hint">
              Set <code>COMPOSIO_API_KEY</code> in Joshu env and restart.
            </p>
          )}
          {composioEnabled !== false && (
            <>
              <div className="search-row">
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search providers (gmail, github, …)"
                  aria-label="Search providers"
                />
                <button type="button" className="btn" onClick={() => void refreshToolkits()}>
                  Search
                </button>
              </div>
              <ul className="composio-list">
                {toolkits.map((row) => {
                  const slugLower = row.slug.toLowerCase();
                  const accounts: ComposioConnectedAccountSummary[] = row.connectedAccounts?.length
                    ? [...row.connectedAccounts]
                    : row.connectedAccountId
                      ? [{ connectedAccountId: row.connectedAccountId, label: row.name }]
                      : [];
                  if (slugLower === "gmail") {
                    const seen = new Set(accounts.map((a) => a.connectedAccountId));
                    for (const ga of gmailAccounts) {
                      if (!seen.has(ga.connectedAccountId)) {
                        accounts.push({
                          connectedAccountId: ga.connectedAccountId,
                          label: ga.email ?? ga.accountKey,
                        });
                      }
                    }
                  }
                  const connectBusyKey = `connect-${row.slug}`;

                  return (
                    <li key={row.slug} className="composio-toolkit" id={slugLower === "slackbot" ? "slackbot" : undefined}>
                      <div className="composio-row">
                        <div className="composio-row-main">
                          {row.logo ? (
                            <img src={row.logo} alt="" className="composio-logo" loading="lazy" />
                          ) : (
                            <span className="composio-logo composio-logo-fallback" aria-hidden>
                              {row.name.slice(0, 1).toUpperCase()}
                            </span>
                          )}
                          <div>
                            <strong>{row.name}</strong>
                            <small>
                              {slugLower === "slackbot"
                                ? accounts.length === 0
                                  ? "Shared-file KB channels (not approvals / Hermes chat)"
                                  : `${accounts.length} workspace connected · KB channels`
                                : accounts.length === 0
                                  ? "Not connected"
                                  : `${accounts.length} account${accounts.length === 1 ? "" : "s"} connected`}
                            </small>
                          </div>
                        </div>
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={busy === connectBusyKey}
                          onClick={() => {
                            if (slugLower === "slackbot") {
                              setSlackbotWizardOpen(true);
                              // Wizard-first: connectToolkit will no-op OAuth until auth config exists.
                            }
                            void connectToolkit(row.slug);
                          }}
                        >
                          {busy === connectBusyKey
                            ? "Opening…"
                            : slugLower === "slackbot" && slackbotSetup?.setupRequired
                              ? "Set up"
                              : accounts.length > 0
                                ? "Connect another account"
                                : "Connect"}
                        </button>
                      </div>
                      {slugLower === "slackbot" && slackbotWizardOpen && (
                        <div className="slackbot-wizard">
                          <p className="hint">
                            Slackbot powers <strong>Chat with shared files</strong> channels. It is separate from
                            user Slack (owner approvals) and Hermes Slack chat.
                          </p>
                          {slackbotSetup?.steps && slackbotSetup.steps.length > 0 && (
                            <ol className="hint setup-steps">
                              {slackbotSetup.steps.map((step) => (
                                <li key={step}>{step}</li>
                              ))}
                            </ol>
                          )}
                          {slackbotSetup?.authConfigConfigured && (
                            <p className="hint">
                              Auth config on file{slackbotSetup.authConfigIdPreview
                                ? ` (${slackbotSetup.authConfigIdPreview})`
                                : ""}
                              . You can rotate credentials below, then Connect.
                            </p>
                          )}
                          <div className="actions inline-actions">
                            <button
                              type="button"
                              className="btn"
                              disabled={busy === "slackbot-manifest"}
                              onClick={() => void loadSlackbotManifest()}
                            >
                              {busy === "slackbot-manifest" ? "Generating…" : "Generate manifest"}
                            </button>
                            {slackbotManifestText ? (
                              <>
                                <button
                                  type="button"
                                  className="btn"
                                  onClick={() => {
                                    void navigator.clipboard.writeText(slackbotManifestText);
                                    setSlackbotMsg("Manifest copied.");
                                  }}
                                >
                                  Copy manifest
                                </button>
                                <button
                                  type="button"
                                  className="btn"
                                  onClick={() => {
                                    const blob = new Blob([slackbotManifestText], {
                                      type: "application/json",
                                    });
                                    const url = URL.createObjectURL(blob);
                                    const a = document.createElement("a");
                                    a.href = url;
                                    a.download = "joshu-slackbot-manifest.json";
                                    a.click();
                                    URL.revokeObjectURL(url);
                                  }}
                                >
                                  Download .json
                                </button>
                                <a
                                  className="btn"
                                  href="https://api.slack.com/apps?new_app=1"
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Open Slack apps
                                </a>
                              </>
                            ) : null}
                          </div>
                          {slackbotManifestText ? (
                            <div className="field">
                              <label htmlFor="slackbotManifest">Slack app manifest</label>
                              <textarea
                                id="slackbotManifest"
                                className="manifest-preview"
                                readOnly
                                rows={10}
                                value={slackbotManifestText}
                                onFocus={(e) => e.currentTarget.select()}
                              />
                            </div>
                          ) : null}
                          <div className="field">
                            <label htmlFor="slackbotClientId">Client ID</label>
                            <input
                              id="slackbotClientId"
                              type="text"
                              autoComplete="off"
                              value={slackbotClientId}
                              onChange={(e) => setSlackbotClientId(e.target.value)}
                              placeholder="From Slack app → Basic Information"
                            />
                          </div>
                          <div className="field">
                            <label htmlFor="slackbotClientSecret">Client Secret</label>
                            <input
                              id="slackbotClientSecret"
                              type="password"
                              autoComplete="off"
                              value={slackbotClientSecret}
                              onChange={(e) => setSlackbotClientSecret(e.target.value)}
                              placeholder="From Slack app → Basic Information"
                            />
                          </div>
                          <div className="field">
                            <label htmlFor="slackbotSigningSecret">Signing Secret</label>
                            <input
                              id="slackbotSigningSecret"
                              type="password"
                              autoComplete="off"
                              value={slackbotSigningSecret}
                              onChange={(e) => setSlackbotSigningSecret(e.target.value)}
                              placeholder="Basic Information → Signing Secret (for Events)"
                            />
                          </div>
                          <div className="field">
                            <label htmlFor="slackbotAppToken">App-Level Token (xapp-)</label>
                            <input
                              id="slackbotAppToken"
                              type="password"
                              autoComplete="off"
                              value={slackbotAppToken}
                              onChange={(e) => setSlackbotAppToken(e.target.value)}
                              placeholder="App-Level Tokens → authorizations:read"
                            />
                          </div>
                          <div className="field">
                            <label htmlFor="slackbotVerificationToken">
                              Verification Token (optional)
                            </label>
                            <input
                              id="slackbotVerificationToken"
                              type="password"
                              autoComplete="off"
                              value={slackbotVerificationToken}
                              onChange={(e) => setSlackbotVerificationToken(e.target.value)}
                              placeholder="Defaults to Signing Secret if blank"
                            />
                          </div>
                          {(slackbotWebhookUrl || slackbotSetup?.webhookUrl) && (
                            <div className="field">
                              <label htmlFor="slackbotEventUrl">
                                Event Subscriptions Request URL (paste into Slack)
                              </label>
                              <textarea
                                id="slackbotEventUrl"
                                className="manifest-preview"
                                readOnly
                                rows={3}
                                value={slackbotWebhookUrl || slackbotSetup?.webhookUrl || ""}
                                onFocus={(e) => e.currentTarget.select()}
                              />
                              <p className="hint">
                                Slack app → Event Subscriptions → Enable → paste this URL → Save.
                                Then reinstall the app if Slack prompts.
                              </p>
                            </div>
                          )}
                          <div className="actions inline-actions">
                            <button
                              type="button"
                              className="btn btn-primary"
                              disabled={
                                busy === "slackbot-save" ||
                                !slackbotClientId.trim() ||
                                !slackbotClientSecret.trim() ||
                                !slackbotSigningSecret.trim() ||
                                !slackbotAppToken.trim()
                              }
                              onClick={() => void saveAndConnectSlackbot()}
                            >
                              {busy === "slackbot-save" ? "Saving…" : "Save & Connect"}
                            </button>
                            <button
                              type="button"
                              className="btn"
                              onClick={() => setSlackbotWizardOpen(false)}
                            >
                              Hide setup
                            </button>
                          </div>
                          {slackbotMsg && <p className="hint">{slackbotMsg}</p>}
                        </div>
                      )}
                      {accounts.length > 0 && (
                        <ul className="composio-accounts">
                          {accounts.map((acct) => {
                            const gmailMeta =
                              slugLower === "gmail"
                                ? gmailAccountById.get(acct.connectedAccountId)
                                : undefined;
                            return (
                              <li key={acct.connectedAccountId} className="composio-account-row">
                                <div>
                                  <strong>{accountLabel(row.slug, acct)}</strong>
                                  {gmailMeta?.isDefault && <small> (default)</small>}
                                  {gmailMeta && (
                                    <small>
                                      {gmailMeta.mirror?.threadCount ?? 0} threads · last sync{" "}
                                      {formatWhen(gmailMeta.sync?.lastSyncAt)}
                                      {gmailMeta.sync?.lastError ? ` · error: ${gmailMeta.sync.lastError}` : ""}
                                    </small>
                                  )}
                                </div>
                                <div className="composio-account-actions">
                                  {gmailMeta && (
                                    <button
                                      type="button"
                                      className="btn"
                                      disabled={busy === `sync-${acct.connectedAccountId}`}
                                      onClick={() => void syncGmailAccount(acct.connectedAccountId)}
                                    >
                                      Sync now
                                    </button>
                                  )}
                                  <button
                                    type="button"
                                    className="btn"
                                    disabled={busy === acct.connectedAccountId}
                                    onClick={() => void disconnectAccount(acct.connectedAccountId)}
                                  >
                                    Disconnect
                                  </button>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>

              {gmailAccounts.length > 0 && (
                <section className="day0-box" aria-labelledby="day0-heading">
                  <h2 id="day0-heading">Day 0 setup</h2>
                  <p className="hint">
                    Syncs 30 days of inbox, sent, and important mail from <strong>all connected Gmail
                    accounts</strong>, plus calendar, then uses a cheap LLM to pre-fill your Welcome
                    onboarding draft. Review in Welcome before Finish — nothing is auto-completed.
                    Connect Google Calendar above for better working-hours inference.
                  </p>
                  {!day0Status?.llmConfigured && (
                    <p className="error">Set OPENROUTER_API_KEY in Joshu env to enable Day 0 analysis.</p>
                  )}
                  {day0Status?.day0?.completedAt && (
                    <p className="hint">
                      Last run {formatWhen(day0Status.day0.completedAt)}
                      {day0Status.day0.threadsAnalyzed != null
                        ? ` · ${day0Status.day0.threadsAnalyzed} threads`
                        : ""}
                      {day0Status.day0.fieldsFilled?.length
                        ? ` · filled ${day0Status.day0.fieldsFilled.join(", ")}`
                        : ""}
                      {day0Status.model ? ` · model ${day0Status.model}` : ""}
                    </p>
                  )}
                  {day0Running && <p className="hint day0-progress">{day0Message}</p>}
                  {day0Done && !day0Running && (
                    <p className="hint day0-success">
                      {day0Message} Open <strong>Welcome</strong> from the desktop to review prefilled fields.
                    </p>
                  )}
                  <div className="day0-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={day0Running || !day0Status?.llmConfigured}
                      onClick={() => void startDay0(false)}
                    >
                      {day0Running ? "Analyzing…" : "Analyze mail for setup (Day 0)"}
                    </button>
                    {day0Status?.day0?.status === "completed" && (
                      <button
                        type="button"
                        className="btn"
                        disabled={day0Running || !day0Status?.llmConfigured}
                        onClick={() => void startDay0(true)}
                      >
                        Run again
                      </button>
                    )}
                  </div>
                </section>
              )}
            </>
          )}

          {showDay0Names && (
            <div className="day0-modal-backdrop" role="presentation" onClick={() => setShowDay0Names(false)}>
              <div
                className="day0-modal card"
                role="dialog"
                aria-labelledby="day0-names-title"
                onClick={(e) => e.stopPropagation()}
              >
                <h2 id="day0-names-title">Names for Welcome draft</h2>
                <p className="hint">Day 0 needs your name and assistant persona name to write the onboarding draft.</p>
                <label className="day0-field">
                  Your name
                  <input
                    type="text"
                    value={day0OwnerName}
                    onChange={(e) => setDay0OwnerName(e.target.value)}
                    placeholder="Principal name"
                  />
                </label>
                <label className="day0-field">
                  Assistant name
                  <input
                    type="text"
                    value={day0AssistantName}
                    onChange={(e) => setDay0AssistantName(e.target.value)}
                    placeholder="e.g. Patrick"
                  />
                </label>
                <div className="day0-actions">
                  <button type="button" className="btn" onClick={() => setShowDay0Names(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!day0OwnerName.trim() || !day0AssistantName.trim() || day0Running}
                    onClick={() => void startDay0(false)}
                  >
                    Start Day 0
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
