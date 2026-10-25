import "@joshu/design-system/typography.css";
import "@joshu/design-system/tokens.css";
import "@joshu/design-system/base.css";
import "./styles.css";

import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { readLocalToolkitsCache, writeLocalToolkitsCache } from "./toolkitsCache.js";

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

type ConnectorsStatus = {
  registry?: { updatedAt?: string };
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

/** Top-level page after Composio OAuth (new tab). Served by Joshu static public/. */
function oauthDoneCallbackUrl(): string {
  return `${window.location.origin}/joshu/oauth-done.html`;
}

const SHARE_CHAT_API = "/joshu/api/share-chat";

type TeamsBotSetupStatus = {
  ok?: boolean;
  /** Server feature flag JOSHU_TEAMS_BOT_UI_ENABLED — when false, hide the Teams card. */
  uiEnabled?: boolean;
  configured?: boolean;
  appIdPreview?: string;
  messagesUrl?: string;
  messagesUrlIsPublic?: boolean;
  setupRequired?: boolean;
  steps?: string[];
};

type MeteredProviderRow = {
  id: string;
  displayName: string;
  description: string;
  mode: "relay" | "direct" | "off";
  configured: boolean;
  userEnabled: boolean;
  enabled: boolean;
  mcpActive: boolean;
  balanceUsd: number | null;
  balanceUsdDisplay: string | null;
  dashboardUrl: string | null;
  ossEnvKey: string;
};

type SlackbotSetupStatus = {
  clientId?: string;
  composioEnabled?: boolean;
  authConfigConfigured?: boolean;
  authConfigIdPreview?: string;
  webhookConfigured?: boolean;
  webhookUrl?: string;
  eventsRequestUrl?: string;
  eventsUrlIsPublic?: boolean;
  setupRequired?: boolean;
  steps?: string[];
};

function App() {
  const cachedToolkitsOnMount = readLocalToolkitsCache();
  const [status, setStatus] = useState<ConnectorsStatus | null>(null);
  const [toolkits, setToolkits] = useState<ComposioToolkitRow[]>(
    () => cachedToolkitsOnMount?.featured ?? [],
  );
  const [search, setSearch] = useState("");
  const [toolkitsLoading, setToolkitsLoading] = useState(false);
  const [loading, setLoading] = useState(() => !(cachedToolkitsOnMount?.featured.length));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  /** Row waiting on OAuth popup close + toolkit list refresh. */
  const [pendingConnect, setPendingConnect] = useState<{
    slug: string;
    phase: "oauth" | "refresh";
  } | null>(null);
  const [composioEnabled, setComposioEnabled] = useState<boolean | null>(null);
  const [day0Status, setDay0Status] = useState<Day0StatusPayload | null>(null);
  const [day0Running, setDay0Running] = useState(false);
  const [day0Message, setDay0Message] = useState("");
  const [showDay0Names, setShowDay0Names] = useState(false);
  const [day0OwnerName, setDay0OwnerName] = useState("");
  const [day0AssistantName, setDay0AssistantName] = useState("");
  const [day0Done, setDay0Done] = useState(false);
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
  const [teamsBotSetup, setTeamsBotSetup] = useState<TeamsBotSetupStatus | null>(null);
  const [teamsBotWizardOpen, setTeamsBotWizardOpen] = useState(false);
  const [teamsBotAppId, setTeamsBotAppId] = useState("");
  const [teamsBotAppPassword, setTeamsBotAppPassword] = useState("");
  const [teamsBotTenantId, setTeamsBotTenantId] = useState("");
  const [teamsBotDisplayName, setTeamsBotDisplayName] = useState("");
  const [teamsBotMsg, setTeamsBotMsg] = useState("");
  const [meteredProviders, setMeteredProviders] = useState<MeteredProviderRow[]>([]);
  const [falApiKey, setFalApiKey] = useState("");
  const [falPanelOpen, setFalPanelOpen] = useState(false);
  const [meteredMsg, setMeteredMsg] = useState("");
  const backgroundStarted = useRef(false);

  const refreshStatus = useCallback(async () => {
    const res = await fetch(`${CONNECTORS_API}/status`, { cache: "no-store" });
    if (!res.ok) throw new Error(await res.text());
    const json = (await res.json()) as ConnectorsStatus;
    setStatus(json);
    return json;
  }, []);

  /** List Composio toolkits — server + localStorage cache; no Hermes sync here. */
  const loadToolkits = useCallback(
    async (query = "", opts?: { checkEnabled?: boolean }) => {
      if (opts?.checkEnabled !== false) {
        const statusRes = await fetch(`${COMPOSIO_API}/status`, { cache: "no-store" });
        const statusJson = (await statusRes.json()) as { enabled?: boolean };
        setComposioEnabled(Boolean(statusJson.enabled));
        if (!statusJson.enabled) {
          setToolkits([]);
          return;
        }
      } else if (composioEnabled === false) {
        setToolkits([]);
        return;
      }

      const params = new URLSearchParams();
      const q = query.trim();
      // Composio requires 3+ characters; shorter queries stay on the featured list.
      if (q.length >= 3) params.set("search", q);
      const listRes = await fetch(`${COMPOSIO_API}/toolkits?${params}`, { cache: "no-store" });
      if (!listRes.ok) throw new Error(await listRes.text());
      const listJson = (await listRes.json()) as { toolkits?: ComposioToolkitRow[] };
      const rows = Array.isArray(listJson.toolkits) ? listJson.toolkits : [];
      setToolkits(rows);
      if (!q) writeLocalToolkitsCache(rows);
    },
    [composioEnabled],
  );

  const syncComposioInBackground = useCallback(async () => {
    if (composioEnabled === false) return;
    await fetch(`${COMPOSIO_API}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ restartGateway: false }),
    }).catch(() => undefined);
  }, [composioEnabled]);

  const refreshToolkits = useCallback(async () => {
    setToolkitsLoading(true);
    try {
      await loadToolkits(search, { checkEnabled: false });
    } finally {
      setToolkitsLoading(false);
    }
  }, [loadToolkits, search]);

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
    if (json.eventsRequestUrl) setSlackbotWebhookUrl(json.eventsRequestUrl);
    else if (json.webhookUrl) setSlackbotWebhookUrl(json.webhookUrl);
    if (json.clientId) {
      setSlackbotClientId((prev) => prev.trim() || json.clientId || "");
    }
    if (json.setupRequired) setSlackbotWizardOpen(true);
    return json;
  }, []);

  const refreshTeamsBotSetup = useCallback(async () => {
    const res = await fetch(`${SHARE_CHAT_API}/teams/setup`, { cache: "no-store" });
    if (!res.ok) return null;
    const json = (await res.json()) as TeamsBotSetupStatus;
    setTeamsBotSetup(json);
    // Only auto-expand when the UI flag is on and setup is still needed.
    if (json.uiEnabled && json.setupRequired) setTeamsBotWizardOpen(true);
    else if (!json.uiEnabled) setTeamsBotWizardOpen(false);
    return json;
  }, []);

  const refreshMeteredProviders = useCallback(async () => {
    const res = await fetch(`${CONNECTORS_API}/providers`, { cache: "no-store" });
    if (!res.ok) return null;
    const json = (await res.json()) as { providers?: MeteredProviderRow[] };
    const rows = Array.isArray(json.providers) ? json.providers : [];
    setMeteredProviders(rows);
    return rows;
  }, []);

  const refreshInBackground = useCallback(async () => {
    setError("");
    try {
      await Promise.all([
        refreshStatus(),
        loadToolkits("", { checkEnabled: true }),
        refreshMeteredProviders().catch(() => undefined),
        refreshDay0Status().catch(() => undefined),
        refreshSlackbotSetup().catch(() => undefined),
        refreshTeamsBotSetup().catch(() => undefined),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
    void syncComposioInBackground();
  }, [
    refreshStatus,
    loadToolkits,
    refreshMeteredProviders,
    refreshDay0Status,
    refreshSlackbotSetup,
    refreshTeamsBotSetup,
    syncComposioInBackground,
  ]);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    await refreshInBackground();
  }, [refreshInBackground]);

  useEffect(() => {
    if (backgroundStarted.current) return;
    backgroundStarted.current = true;
    void refreshInBackground();
  }, [refreshInBackground]);

  // Typing in search must not re-run full refresh (was syncing Hermes MCP every keystroke).
  useEffect(() => {
    if (composioEnabled === false || composioEnabled === null) return;
    const q = search.trim();
    if (q.length > 0 && q.length < 3) return;

    const timer = window.setTimeout(() => {
      setToolkitsLoading(true);
      void loadToolkits(q, { checkEnabled: false })
        .catch((err) => {
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          setToolkitsLoading(false);
        });
    }, 300);

    return () => window.clearTimeout(timer);
  }, [search, composioEnabled, loadToolkits]);

  // Deep-link from Chat sharing: #slackbot | #teams-bot (Teams only when UI flag is on)
  useEffect(() => {
    const openFromHash = () => {
      const hash = window.location.hash.replace(/^#/, "");
      if (hash === "slackbot") setSlackbotWizardOpen(true);
      if (hash === "teams-bot" && teamsBotSetup?.uiEnabled) setTeamsBotWizardOpen(true);
    };
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, [teamsBotSetup?.uiEnabled]);

  useEffect(() => {
    const onFocus = () => void refreshInBackground();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshInBackground]);

  const openOAuthPopup = (redirectUrl: string, slug: string) => {
    const popup = window.open(redirectUrl, "_blank", "noopener,noreferrer");
    if (!popup) throw new Error("Pop-up blocked — allow pop-ups and try again.");
    setPendingConnect({ slug, phase: "oauth" });
    const poll = window.setInterval(() => {
      if (!popup.closed) return;
      window.clearInterval(poll);
      setPendingConnect({ slug, phase: "refresh" });
      void (async () => {
        try {
          await fetch(`${COMPOSIO_API}/post-connect`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ toolkit: slug, restartGateway: true }),
          });
          await refreshAll();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setPendingConnect(null);
        }
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
      // Also block OAuth when webhook ingress is incomplete (Signing Secret + xapp-).
      if (slugLower === "slackbot") {
        const setup = slackbotSetup ?? (await refreshSlackbotSetup().catch(() => null));
        if (!setup?.authConfigConfigured || setup?.setupRequired) {
          setSlackbotWizardOpen(true);
          if (setup?.clientId) {
            setSlackbotClientId((prev) => prev.trim() || setup.clientId || "");
          }
          setSlackbotMsg(
            setup?.setupRequired && setup?.authConfigConfigured
              ? "Workspace is connected — add Signing Secret + App-Level Token (xapp-) below, then Save. You do not need to disconnect."
              : setup?.steps?.[0]
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
        body: JSON.stringify({ toolkit: slug, callbackUrl: oauthDoneCallbackUrl() }),
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

  const saveAndConnectSlackbot = async (opts?: { connect?: boolean }) => {
    setBusy("slackbot-save");
    setSlackbotMsg("");
    setError("");
    const alreadyConnected = toolkits.some(
      (t) =>
        t.slug.toLowerCase() === "slackbot" &&
        (t.isConnected ||
          (t.connectedAccounts && t.connectedAccounts.length > 0) ||
          Boolean(t.connectedAccountId)),
    );
    const shouldConnect = opts?.connect ?? !alreadyConnected;
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
          connect: shouldConnect,
          callbackUrl: oauthDoneCallbackUrl(),
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
      if (json.status?.eventsRequestUrl) setSlackbotWebhookUrl(json.status.eventsRequestUrl);
      else if (json.webhookUrl) setSlackbotWebhookUrl(json.webhookUrl);
      setSlackbotClientSecret("");
      setSlackbotSigningSecret("");
      setSlackbotAppToken("");
      setSlackbotVerificationToken("");
      await refreshAll().catch(() => undefined);
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
        setSlackbotMsg(
          alreadyConnected
            ? `Credentials + webhook updated.${rebindNote} Paste the Event Subscriptions URL into your Slack app if you have not already.`
            : `Auth + webhook saved.${rebindNote} Click Connect if OAuth is still needed.`,
        );
      }
    } catch (err) {
      setSlackbotMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const saveTeamsBotCredentials = async () => {
    setBusy("teams-bot-save");
    setTeamsBotMsg("");
    try {
      const res = await fetch(`${SHARE_CHAT_API}/teams/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appId: teamsBotAppId,
          appPassword: teamsBotAppPassword,
          tenantId: teamsBotTenantId || undefined,
          displayName: teamsBotDisplayName || undefined,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as TeamsBotSetupStatus & { error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setTeamsBotSetup(json);
      setTeamsBotAppPassword("");
      setTeamsBotMsg(
        "Saved. Set the Azure Bot messaging endpoint to the URL below, then download the app package and sideload it in Teams.",
      );
      await refreshTeamsBotSetup().catch(() => undefined);
    } catch (err) {
      setTeamsBotMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const downloadTeamsBotPackage = () => {
    window.open(`${SHARE_CHAT_API}/teams/manifest.zip`, "_blank", "noopener,noreferrer");
  };

  const falProvider = useMemo(
    () => meteredProviders.find((row) => row.id === "fal") ?? null,
    [meteredProviders],
  );

  const saveFalApiKey = async () => {
    setBusy("fal-save");
    setMeteredMsg("");
    try {
      const res = await fetch(`${CONNECTORS_API}/providers/fal/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: falApiKey }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setFalApiKey("");
      setMeteredMsg("fal.ai key saved.");
      setFalPanelOpen(false);
      await refreshMeteredProviders().catch(() => undefined);
    } catch (err) {
      setMeteredMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const toggleFal = async (enabled: boolean) => {
    setBusy("fal-toggle");
    setMeteredMsg("");
    try {
      const res = await fetch(`${CONNECTORS_API}/providers/fal/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const json = (await res.json().catch(() => ({}))) as MeteredProviderRow & { error?: string };
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setMeteredProviders((prev) => {
        const rest = prev.filter((row) => row.id !== "fal");
        return [...rest, json];
      });
      if (!enabled) setFalPanelOpen(false);
    } catch (err) {
      setMeteredMsg(err instanceof Error ? err.message : String(err));
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

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <p className="eyebrow">Joshu</p>
          <h1>Connectors</h1>
          <p className="sub">Connect Gmail, calendar, and other apps Joshu uses across the desktop.</p>
        </div>
        <button type="button" className="btn" onClick={() => void refreshAll()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {error && <p className="error">{error}</p>}

      {teamsBotSetup?.uiEnabled ? (
      <section className="card" id="teams-bot">
        <h2>Teams bot (Share Chat)</h2>
        <p className="hint">
          Sideloaded Azure Bot for free/personal Teams — answers file questions in a DM or group chat.
          Not the same as Composio Microsoft Teams (M365 Graph). No Store approval required.
        </p>
        <p className="hint">
          Status:{" "}
          {teamsBotSetup?.configured ? (
            <>
              configured{teamsBotSetup.appIdPreview ? ` (${teamsBotSetup.appIdPreview})` : ""}
            </>
          ) : (
            "not configured"
          )}
        </p>
        <button
          type="button"
          className="btn"
          onClick={() => setTeamsBotWizardOpen((v) => !v)}
        >
          {teamsBotWizardOpen ? "Hide setup" : "Configure Teams bot"}
        </button>
        {teamsBotWizardOpen && (
          <div className="slackbot-wizard">
            {teamsBotSetup?.steps && teamsBotSetup.steps.length > 0 && (
              <ol className="setup-steps">
                {teamsBotSetup.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            )}
            <div className="field">
              <label htmlFor="teamsBotAppId">Application (client) ID</label>
              <input
                id="teamsBotAppId"
                value={teamsBotAppId}
                onChange={(e) => setTeamsBotAppId(e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                autoComplete="off"
              />
            </div>
            <div className="field">
              <label htmlFor="teamsBotAppPassword">Client secret</label>
              <input
                id="teamsBotAppPassword"
                type="password"
                value={teamsBotAppPassword}
                onChange={(e) => setTeamsBotAppPassword(e.target.value)}
                placeholder="Client secret value"
                autoComplete="off"
              />
            </div>
            <div className="field">
              <label htmlFor="teamsBotTenantId">Tenant ID (optional, single-tenant)</label>
              <input
                id="teamsBotTenantId"
                value={teamsBotTenantId}
                onChange={(e) => setTeamsBotTenantId(e.target.value)}
                placeholder="Leave blank for multi-tenant / free Teams"
                autoComplete="off"
              />
            </div>
            <div className="field">
              <label htmlFor="teamsBotDisplayName">Display name (optional)</label>
              <input
                id="teamsBotDisplayName"
                value={teamsBotDisplayName}
                onChange={(e) => setTeamsBotDisplayName(e.target.value)}
                placeholder="Joshu Files"
                autoComplete="off"
              />
            </div>
            {(teamsBotSetup?.messagesUrl || "").length > 0 && (
              <div className="field">
                <label htmlFor="teamsBotMessagesUrl">Messaging endpoint (paste into Azure Bot)</label>
                <input
                  id="teamsBotMessagesUrl"
                  readOnly
                  value={teamsBotSetup?.messagesUrl || ""}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <p className="hint">
                  {teamsBotSetup?.messagesUrlIsPublic
                    ? "Public HTTPS URL detected."
                    : "URL looks local — use a tunnel or set JOSHU_PUBLIC_URL so Azure can reach the box."}
                </p>
              </div>
            )}
            <div className="search-row">
              <button
                type="button"
                className="btn primary"
                disabled={
                  busy === "teams-bot-save" || !teamsBotAppId.trim() || !teamsBotAppPassword.trim()
                }
                onClick={() => void saveTeamsBotCredentials()}
              >
                {busy === "teams-bot-save" ? "Saving…" : "Save credentials"}
              </button>
              <button
                type="button"
                className="btn"
                disabled={!teamsBotSetup?.configured}
                onClick={downloadTeamsBotPackage}
              >
                Download Teams app package
              </button>
            </div>
            {teamsBotMsg && <p className="hint">{teamsBotMsg}</p>}
          </div>
        )}
      </section>
      ) : null}

      <section className="card">
          <h2>Apps</h2>
          <p className="hint">
            Connect each app once per account. Google apps (Gmail, Calendar, Drive) support multiple accounts —
            use &quot;Connect another account&quot; after the first OAuth.
          </p>
          {meteredMsg ? <p className="hint">{meteredMsg}</p> : null}
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
                  placeholder="Search providers (3+ characters)"
                  aria-label="Search providers"
                  disabled={loading && toolkits.length === 0}
                />
                <button
                  type="button"
                  className="btn"
                  onClick={() => void refreshToolkits()}
                  disabled={toolkitsLoading}
                >
                  Search
                </button>
              </div>
              {toolkitsLoading && toolkits.length === 0 && !falProvider ? (
                <div className="loading-panel" role="status" aria-live="polite">
                  <span className="loading-spinner" aria-hidden />
                  <p>Loading apps…</p>
                </div>
              ) : toolkits.length === 0 && !falProvider ? (
                <p className="hint">No apps found. Try a different search, or check COMPOSIO_API_KEY.</p>
              ) : (
              <ul className={`composio-list${toolkitsLoading ? " is-loading" : ""}`}>
                {falProvider && falProvider.mode !== "off" ? (
                  <li className="composio-toolkit composio-fal" id="fal">
                    <div className="composio-row">
                      <div className="composio-row-main">
                        <span className="composio-logo composio-logo-fallback" aria-hidden>
                          F
                        </span>
                        <div>
                          <strong>{falProvider.displayName}</strong>
                          <small>
                            {falProvider.mode === "relay" ? (
                              <>
                                Fleet · relay
                                {falProvider.balanceUsdDisplay != null
                                  ? ` · $${falProvider.balanceUsdDisplay} balance`
                                  : ""}
                                {falProvider.mcpActive
                                  ? " · Active"
                                  : falProvider.userEnabled
                                    ? " · Needs funds"
                                    : " · Disabled"}
                              </>
                            ) : falProvider.configured ? (
                              "Self-host · key saved"
                            ) : (
                              "Self-host · paste API key"
                            )}
                          </small>
                        </div>
                      </div>
                      <div className="composio-account-actions">
                        {falProvider.mode === "relay" ? (
                          <button
                            type="button"
                            className="btn"
                            onClick={() => setFalPanelOpen((v) => !v)}
                          >
                            {falPanelOpen ? "Hide" : "Manage"}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn"
                            onClick={() => setFalPanelOpen((v) => !v)}
                          >
                            {falPanelOpen ? "Hide" : falProvider.configured ? "Replace key" : "Add key"}
                          </button>
                        )}
                        {falProvider.configured ? (
                          <button
                            type="button"
                            className="btn btn-primary"
                            disabled={busy === "fal-toggle"}
                            onClick={() => void toggleFal(!falProvider.userEnabled)}
                          >
                            {busy === "fal-toggle"
                              ? "Saving…"
                              : falProvider.userEnabled
                                ? "Disable"
                                : "Enable"}
                          </button>
                        ) : null}
                      </div>
                    </div>
                    {falPanelOpen ? (
                      <div className="provider-panel">
                        <p className="hint">{falProvider.description}</p>
                        {falProvider.mode === "relay" ? (
                          <>
                            <p className="hint">
                              Usage is billed from your shared control-plane balance. Hermes activates fal
                              tools when enabled and balance is above zero.
                            </p>
                            <div className="search-row">
                              {falProvider.dashboardUrl ? (
                                <a
                                  className="btn btn-primary"
                                  href={falProvider.dashboardUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Add funds
                                </a>
                              ) : null}
                              <button
                                type="button"
                                className="btn"
                                onClick={() => void refreshMeteredProviders()}
                              >
                                Refresh balance
                              </button>
                            </div>
                          </>
                        ) : (
                          <div className="provider-direct">
                            <label htmlFor="falApiKey">{falProvider.ossEnvKey}</label>
                            <input
                              id="falApiKey"
                              type="password"
                              value={falApiKey}
                              onChange={(e) => setFalApiKey(e.target.value)}
                              placeholder={
                                falProvider.configured ? "Saved — paste to replace" : "Paste fal API key"
                              }
                              autoComplete="off"
                            />
                            <button
                              type="button"
                              className="btn btn-primary"
                              disabled={busy === "fal-save" || !falApiKey.trim()}
                              onClick={() => void saveFalApiKey()}
                            >
                              {busy === "fal-save" ? "Saving…" : "Save key"}
                            </button>
                          </div>
                        )}
                      </div>
                    ) : null}
                  </li>
                ) : null}
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
                  const pendingThis = pendingConnect?.slug.toLowerCase() === slugLower;
                  const pendingPhase = pendingThis ? pendingConnect.phase : null;

                  return (
                    <li
                      key={row.slug}
                      className={`composio-toolkit${pendingThis ? " is-connecting" : ""}`}
                      id={slugLower === "slackbot" ? "slackbot" : undefined}
                      aria-busy={pendingThis || undefined}
                    >
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
                            {pendingThis ? (
                              <small className="composio-status-pending">
                                <span className="loading-spinner loading-spinner-inline" aria-hidden />
                                {pendingPhase === "refresh"
                                  ? "Refreshing connection…"
                                  : "Waiting for sign-in…"}
                              </small>
                            ) : (
                            <small>
                              {slugLower === "slackbot"
                                ? accounts.length === 0
                                  ? "Shared-file KB channels (not approvals / Hermes chat)"
                                  : `${accounts.length} workspace connected · KB channels`
                                : accounts.length === 0
                                  ? "Not connected"
                                  : `${accounts.length} account${accounts.length === 1 ? "" : "s"} connected`}
                            </small>
                            )}
                          </div>
                        </div>
                        <div className="composio-account-actions">
                          {slugLower === "slackbot" && (
                            <button
                              type="button"
                              className="btn"
                              onClick={() => {
                                setSlackbotWizardOpen(true);
                                if (slackbotSetup?.clientId) {
                                  setSlackbotClientId((prev) => prev.trim() || slackbotSetup.clientId || "");
                                }
                                setSlackbotMsg(
                                  accounts.length > 0
                                    ? "Update Signing Secret + App-Level Token for this existing connection (ca_… stays). Save does not require disconnecting."
                                    : "Paste Slack app credentials, then Save & Connect.",
                                );
                              }}
                            >
                              Configure Slack app
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-primary"
                            disabled={busy === connectBusyKey || pendingThis}
                            onClick={() => {
                              if (slugLower === "slackbot") {
                                setSlackbotWizardOpen(true);
                                // Wizard-first: connectToolkit will no-op OAuth until auth config + webhook exist.
                              }
                              void connectToolkit(row.slug);
                            }}
                          >
                            {pendingThis
                              ? pendingPhase === "refresh"
                                ? "Refreshing…"
                                : "Connecting…"
                              : busy === connectBusyKey
                              ? "Opening…"
                              : slugLower === "slackbot" && slackbotSetup?.setupRequired
                                ? accounts.length > 0
                                  ? "Finish setup"
                                  : "Set up"
                                : accounts.length > 0
                                  ? "Connect another account"
                                  : "Connect"}
                          </button>
                        </div>
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
                              {accounts.length > 0
                                ? ` · workspace connected (${accounts[0]?.connectedAccountId || "ca_…"})`
                                : ""}
                              . Paste credentials from the same Slack app to refresh webhook / triggers — no disconnect needed.
                            </p>
                          )}
                          {!slackbotSetup?.webhookConfigured && (
                            <p className="hint">
                              Message triggers need Signing Secret + App-Level Token (xapp- with authorizations:read).
                              OAuth alone is not enough for channel Q&amp;A.
                            </p>
                          )}
                          <p className="hint">
                            If channel Q&amp;A stays silent, confirm the Slack app has bot scope{" "}
                            <code>team:read</code>, <strong>Socket Mode is OFF</strong>, Event
                            Subscriptions URL is verified, then Disconnect + Connect Slackbot
                            (token must be re-issued with that scope).
                          </p>
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
                          {(slackbotWebhookUrl ||
                            slackbotSetup?.eventsRequestUrl ||
                            slackbotSetup?.webhookUrl) && (
                            <div className="field">
                              <label htmlFor="slackbotEventUrl">
                                Event Subscriptions Request URL (paste into Slack)
                              </label>
                              <textarea
                                id="slackbotEventUrl"
                                className="manifest-preview"
                                readOnly
                                rows={3}
                                value={
                                  slackbotWebhookUrl ||
                                  slackbotSetup?.eventsRequestUrl ||
                                  slackbotSetup?.webhookUrl ||
                                  ""
                                }
                                onFocus={(e) => e.currentTarget.select()}
                              />
                              <p className="hint">
                                {slackbotSetup?.eventsUrlIsPublic
                                  ? "Use this Joshu URL (via your tunnel) — more reliable than Composio’s ingress for local. Slack → Event Subscriptions → paste → Save. Bot events must include message.groups for private channels."
                                  : "Need a public HTTPS tunnel (ngrok http 8788). Set JOSHU_PUBLIC_URL or TWILIO_VOICE_WEBHOOK_URL, refresh, then paste the URL Slack shows here."}
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
                              {busy === "slackbot-save"
                                ? "Saving…"
                                : toolkits.some(
                                      (t) =>
                                        t.slug.toLowerCase() === "slackbot" &&
                                        (t.isConnected ||
                                          Boolean(t.connectedAccountId) ||
                                          (t.connectedAccounts && t.connectedAccounts.length > 0)),
                                    )
                                  ? "Save credentials"
                                  : "Save & Connect"}
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
                      {(accounts.length > 0 || pendingThis) && (
                        <ul className="composio-accounts">
                          {pendingThis && (
                            <li className="composio-account-row composio-account-skeleton" aria-hidden>
                              <div>
                                <span className="skeleton-bar skeleton-bar-wide" />
                                <span className="skeleton-bar skeleton-bar-narrow" />
                              </div>
                              <div className="composio-account-actions">
                                <span className="skeleton-bar skeleton-bar-btn" />
                              </div>
                            </li>
                          )}
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
              )}

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
                    placeholder="e.g. Ava"
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
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
