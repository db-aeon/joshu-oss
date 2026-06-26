import "@joshu/design-system/typography.css";
import "@joshu/design-system/tokens.css";
import "@joshu/design-system/base.css";
import "./styles.css";

import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

const API = "/joshu/api/safety-settings";

type SettingSource = "env" | "local-env" | "policy-file" | "default";

type SafetySettings = {
  actionGuard: {
    enabled: boolean;
    enabledSource: SettingSource;
    gateMode: "allowlist" | "external_writes";
    gateModeSource: SettingSource;
    browserGateWrites: boolean;
    browserGateSource: SettingSource;
    llmClassifier: boolean;
    llmClassifierSource: SettingSource;
    llmClassifierThreshold: number;
    bypassOwnerOnlyRecipients: boolean;
    approvalTimeoutMs: number;
    telegramAllowedUserIds: number[];
    mcpToolPolicyEnabled: boolean;
    mcpToolPolicySource: SettingSource;
    terminalMailGuardEnabled: boolean;
    terminalMailGuardSource: SettingSource;
  };
  ownerChannel: {
    linked: boolean;
    provider?: "telegram" | "slack";
    telegramChatId?: string;
    slackDmChannelId?: string;
    gateActive: boolean;
  };
  secrets: {
    actionGuardTelegramBotTokenConfigured: boolean;
    actionGuardTelegramBotTokenSource: SettingSource | "unset";
    hermesTelegramBotTokenConfigured: boolean;
    hermesTelegramBotTokenSource: SettingSource | "unset";
    slackBotTokenConfigured: boolean;
    slackBotTokenSource: SettingSource | "unset";
    slackAppTokenConfigured: boolean;
    slackAppTokenSource: SettingSource | "unset";
  };
  hermesMessaging: {
    slack: {
      configured: boolean;
      allowedUsers: string;
      homeChannel: string;
      allowedChannels: string;
    };
  };
  status: {
    ownerChannelLinked: boolean;
    gateEnabled: boolean;
  };
};

function SourceBadge({ source }: { source: SettingSource | "unset" }) {
  if (source === "unset") return null;
  const label =
    source === "env"
      ? ".env"
      : source === "local-env"
        ? "saved here"
        : source === "policy-file"
          ? "policy file"
          : "default";
  return (
    <span className={`source-badge${source === "env" ? " env" : ""}`} title={`Source: ${source}`}>
      {label}
    </span>
  );
}

function App() {
  const [settings, setSettings] = useState<SafetySettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const [enabled, setEnabled] = useState(false);
  const [gateMode, setGateMode] = useState<"external_writes" | "allowlist">("external_writes");
  const [browserGate, setBrowserGate] = useState(false);
  const [llmClassifier, setLlmClassifier] = useState(false);
  const [llmThreshold, setLlmThreshold] = useState(0.7);
  const [bypassOwnerOnly, setBypassOwnerOnly] = useState(true);
  const [timeoutMin, setTimeoutMin] = useState(30);
  const [telegramUsers, setTelegramUsers] = useState("");
  const [mcpPolicy, setMcpPolicy] = useState(true);
  const [terminalGuard, setTerminalGuard] = useState(true);
  const [ownerProvider, setOwnerProvider] = useState<"telegram" | "slack">("telegram");
  const [telegramChatId, setTelegramChatId] = useState("");
  const [slackChannelId, setSlackChannelId] = useState("");
  const [agBotToken, setAgBotToken] = useState("");
  const [hermesBotToken, setHermesBotToken] = useState("");
  const [slackBotToken, setSlackBotToken] = useState("");
  const [slackAppToken, setSlackAppToken] = useState("");
  const [slackAllowedUsers, setSlackAllowedUsers] = useState("");
  const [slackHomeChannel, setSlackHomeChannel] = useState("");
  const [slackAllowedChannels, setSlackAllowedChannels] = useState("");
  const [slackSetupSteps, setSlackSetupSteps] = useState<string[]>([]);
  const [slackManifestText, setSlackManifestText] = useState("");
  const [gatewayRunning, setGatewayRunning] = useState<boolean | null>(null);

  const applyToForm = useCallback((s: SafetySettings) => {
    setEnabled(s.actionGuard.enabled);
    setGateMode(s.actionGuard.gateMode);
    setBrowserGate(s.actionGuard.browserGateWrites);
    setLlmClassifier(s.actionGuard.llmClassifier);
    setLlmThreshold(s.actionGuard.llmClassifierThreshold);
    setBypassOwnerOnly(s.actionGuard.bypassOwnerOnlyRecipients);
    setTimeoutMin(Math.round(s.actionGuard.approvalTimeoutMs / 60_000));
    setTelegramUsers(s.actionGuard.telegramAllowedUserIds.join(", "));
    setMcpPolicy(s.actionGuard.mcpToolPolicyEnabled);
    setTerminalGuard(s.actionGuard.terminalMailGuardEnabled);
    setOwnerProvider(s.ownerChannel.provider ?? "telegram");
    setTelegramChatId(s.ownerChannel.telegramChatId ?? "");
    setSlackChannelId(s.ownerChannel.slackDmChannelId ?? "");
    setAgBotToken("");
    setHermesBotToken("");
    setSlackBotToken("");
    setSlackAppToken("");
    setSlackAllowedUsers(s.hermesMessaging.slack.allowedUsers);
    setSlackHomeChannel(s.hermesMessaging.slack.homeChannel);
    setSlackAllowedChannels(s.hermesMessaging.slack.allowedChannels);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(API, { cache: "no-store" });
      if (!res.ok) throw new Error(await res.text());
      const json = (await res.json()) as { settings: SafetySettings };
      setSettings(json.settings);
      applyToForm(json.settings);
      const setupRes = await fetch(`${API}/slack-setup`, { cache: "no-store" });
      if (setupRes.ok) {
        const setupJson = (await setupRes.json()) as { setup?: { steps?: string[] } };
        setSlackSetupSteps(setupJson.setup?.steps ?? []);
      }
      const gwRes = await fetch("/joshu/api/hermes/gateway", { cache: "no-store" });
      if (gwRes.ok) {
        const gwJson = (await gwRes.json()) as { running?: boolean };
        setGatewayRunning(Boolean(gwJson.running));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [applyToForm]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const messagingSettingsChanged = useCallback((): boolean => {
    if (!settings) return false;
    const slack = settings.hermesMessaging.slack;
    const nextTelegramIds = telegramUsers
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((id) => Number.isFinite(id) && id > 0)
      .sort((a, b) => a - b)
      .join(",");
    const currentTelegramIds = [...settings.actionGuard.telegramAllowedUserIds].sort((a, b) => a - b).join(",");
    return (
      Boolean(agBotToken.trim()) ||
      Boolean(hermesBotToken.trim()) ||
      Boolean(slackBotToken.trim()) ||
      Boolean(slackAppToken.trim()) ||
      nextTelegramIds !== currentTelegramIds ||
      slackAllowedUsers.trim() !== (slack.allowedUsers ?? "") ||
      slackHomeChannel.trim() !== (slack.homeChannel ?? "") ||
      slackAllowedChannels.trim() !== (slack.allowedChannels ?? "")
    );
  }, [
    settings,
    agBotToken,
    hermesBotToken,
    slackBotToken,
    slackAppToken,
    telegramUsers,
    slackAllowedUsers,
    slackHomeChannel,
    slackAllowedChannels,
  ]);

  const save = async () => {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const restartGateway =
        messagingSettingsChanged() &&
        window.confirm(
          "Messaging settings changed.\n\nRestart the Hermes gateway now so Slack/Telegram picks them up?\n\nOK = Save and restart\nCancel = Save only (restart manually later)",
        );
      const body: Record<string, unknown> = {
        actionGuard: {
          enabled,
          gateMode,
          browserGateWrites: browserGate,
          llmClassifier,
          llmClassifierThreshold: llmThreshold,
          bypassOwnerOnlyRecipients: bypassOwnerOnly,
          approvalTimeoutMs: timeoutMin * 60_000,
          telegramAllowedUserIds: telegramUsers
            .split(",")
            .map((s) => Number.parseInt(s.trim(), 10))
            .filter((id) => Number.isFinite(id) && id > 0),
          mcpToolPolicyEnabled: mcpPolicy,
          terminalMailGuardEnabled: terminalGuard,
        },
        ownerChannel: {
          provider: ownerProvider,
          telegramChatId: telegramChatId.trim() || undefined,
          slackDmChannelId: slackChannelId.trim() || undefined,
          gateMode,
        },
        hermesMessaging: {
          slackAllowedUsers: slackAllowedUsers.trim(),
          slackHomeChannel: slackHomeChannel.trim(),
          slackAllowedChannels: slackAllowedChannels.trim(),
        },
      };
      if (agBotToken.trim()) {
        body.secrets = { ...(body.secrets as object), actionGuardTelegramBotToken: agBotToken.trim() };
      }
      if (hermesBotToken.trim()) {
        body.secrets = { ...(body.secrets as object), hermesTelegramBotToken: hermesBotToken.trim() };
      }
      if (slackBotToken.trim()) {
        body.secrets = { ...(body.secrets as object), slackBotToken: slackBotToken.trim() };
      }
      if (slackAppToken.trim()) {
        body.secrets = { ...(body.secrets as object), slackAppToken: slackAppToken.trim() };
      }
      if (restartGateway) body.restartGateway = true;
      const res = await fetch(API, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {
        settings?: SafetySettings;
        error?: string;
        note?: string;
        gateway?: { running?: boolean };
      };
      if (!res.ok) throw new Error(json.error ?? "Save failed");
      if (json.settings) {
        setSettings(json.settings);
        applyToForm(json.settings);
      }
      if (typeof json.gateway?.running === "boolean") {
        setGatewayRunning(json.gateway.running);
      }
      setMessage(json.note ?? "Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const generateSlackManifest = async () => {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const res = await fetch(`${API}/slack-manifest`, { method: "POST" });
      const json = (await res.json()) as {
        ok?: boolean;
        manifest?: unknown;
        urlNote?: string;
        error?: string;
      };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Manifest generation failed");
      const text = JSON.stringify(json.manifest, null, 2);
      setSlackManifestText(text);
      let copied = false;
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {
        /* ArozOS webview often blocks clipboard — manifest is shown below */
      }
      setMessage(
        copied
          ? `Manifest generated for your companion. ${json.urlNote ?? ""} Copied to clipboard.`
          : `Manifest generated below. ${json.urlNote ?? ""} Select all and copy, or use Download.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const copySlackManifest = async () => {
    if (!slackManifestText) return;
    setError("");
    try {
      await navigator.clipboard.writeText(slackManifestText);
      setMessage("Manifest copied to clipboard.");
    } catch {
      setError("Could not copy automatically — select the manifest text below and copy manually (Cmd/Ctrl+C).");
    }
  };

  const downloadSlackManifest = () => {
    if (!slackManifestText) return;
    const blob = new Blob([slackManifestText], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "slack-manifest.json";
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage("Manifest downloaded as slack-manifest.json.");
  };

  const verifySlackTokens = async () => {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const res = await fetch(`${API}/slack-verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          botToken: slackBotToken.trim() || undefined,
          appToken: slackAppToken.trim() || undefined,
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        bot?: { ok: boolean; team?: string; user?: string; error?: string };
        app?: { ok: boolean; error?: string };
        error?: string;
      };
      if (!json.ok) {
        const parts = [
          json.bot && !json.bot.ok ? `bot: ${json.bot.error ?? "invalid"}` : "",
          json.app && !json.app.ok ? `app: ${json.app.error ?? "invalid"}` : "",
        ].filter(Boolean);
        throw new Error(parts.join("; ") || json.error || "Verification failed");
      }
      setMessage(
        `Slack tokens OK${json.bot?.team ? ` — workspace ${json.bot.team}` : ""}${json.bot?.user ? `, bot ${json.bot.user}` : ""}. Save and restart the gateway.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const restartGateway = async () => {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const res = await fetch(`${API}/restart-gateway`, { method: "POST" });
      const json = (await res.json()) as {
        ok?: boolean;
        message?: string;
        error?: string;
        gateway?: { running?: boolean };
      };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Restart failed");
      if (typeof json.gateway?.running === "boolean") {
        setGatewayRunning(json.gateway.running);
      }
      setMessage(json.message ?? "Hermes gateway restarted.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const testApproval = async () => {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const res = await fetch(`${API}/test-approval`, { method: "POST" });
      const json = (await res.json()) as { ok?: boolean; message?: string; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Test failed");
      setMessage(json.message ?? "Test sent.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const ag = settings?.actionGuard;

  return (
    <div className="app">
      <header>
        <p className="eyebrow">Joshu</p>
        <h1>Safety Settings</h1>
        <p className="sub">Action guard, owner channel, and agent write policy.</p>
      </header>

      {error && <p className="error">{error}</p>}
      {message && <p className="success">{message}</p>}

      {settings && (
        <div className="status-grid">
          <div className="status-pill">
            <strong>Gate</strong>
            {settings.status.gateEnabled ? "Active" : "Off / not linked"}
          </div>
          <div className="status-pill">
            <strong>Owner channel</strong>
            {settings.ownerChannel.linked ? settings.ownerChannel.provider : "Not linked"}
          </div>
          <div className="status-pill">
            <strong>Approval bot</strong>
            {settings.secrets.actionGuardTelegramBotTokenConfigured ? "Configured" : "Missing"}
          </div>
          <div className="status-pill">
            <strong>Slack chat</strong>
            {settings.hermesMessaging.slack.configured ? "Configured" : "Not set up"}
          </div>
          <div className="status-pill">
            <strong>Hermes gateway</strong>
            {gatewayRunning === null ? "…" : gatewayRunning ? "Running" : "Stopped"}
          </div>
        </div>
      )}

      <section className="card">
        <h2>Action guard (HITL)</h2>
        <div className="checkbox-row">
          <input
            id="enabled"
            type="checkbox"
            checked={enabled}
            disabled={ag?.enabledSource === "env"}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <label htmlFor="enabled">
            Enable action guard
            {ag && <SourceBadge source={ag.enabledSource} />}
          </label>
        </div>
        <p className="hint">Requires owner channel linked or approval bot token.</p>

        <div className="field">
          <label htmlFor="gateMode">
            Gate mode
            {ag && <SourceBadge source={ag.gateModeSource} />}
          </label>
          <select
            id="gateMode"
            value={gateMode}
            disabled={ag?.gateModeSource === "env"}
            onChange={(e) => setGateMode(e.target.value as "external_writes" | "allowlist")}
          >
            <option value="external_writes">external_writes — all external writes</option>
            <option value="allowlist">allowlist — named actions only</option>
          </select>
          <p className="hint">external_writes gates Composio writes + Nylas send. allowlist is narrower.</p>
        </div>

        <div className="field">
          <label htmlFor="timeout">Approval timeout (minutes)</label>
          <select id="timeout" value={timeoutMin} onChange={(e) => setTimeoutMin(Number(e.target.value))}>
            <option value={5}>5</option>
            <option value={15}>15</option>
            <option value={30}>30</option>
            <option value={60}>60</option>
          </select>
        </div>

        <div className="checkbox-row">
          <input
            id="browserGate"
            type="checkbox"
            checked={browserGate}
            disabled={ag?.browserGateSource === "env"}
            onChange={(e) => setBrowserGate(e.target.checked)}
          />
          <label htmlFor="browserGate">
            Gate browser writes (click / type / press)
            {ag && <SourceBadge source={ag.browserGateSource} />}
          </label>
        </div>

        <div className="checkbox-row">
          <input
            id="bypassOwner"
            type="checkbox"
            checked={bypassOwnerOnly}
            onChange={(e) => setBypassOwnerOnly(e.target.checked)}
          />
          <label htmlFor="bypassOwner">Bypass gate for owner-only mail (summaries to primaryWorkEmail)</label>
        </div>

        <div className="checkbox-row">
          <input
            id="llmClassifier"
            type="checkbox"
            checked={llmClassifier}
            disabled={ag?.llmClassifierSource === "env"}
            onChange={(e) => setLlmClassifier(e.target.checked)}
          />
          <label htmlFor="llmClassifier">
            LLM classifier for ambiguous actions
            {ag && <SourceBadge source={ag.llmClassifierSource} />}
          </label>
        </div>

        {llmClassifier && (
          <div className="field">
            <label htmlFor="llmThreshold">LLM threshold (0–1)</label>
            <input
              id="llmThreshold"
              type="number"
              min={0.5}
              max={1}
              step={0.05}
              value={llmThreshold}
              onChange={(e) => setLlmThreshold(Number(e.target.value))}
            />
          </div>
        )}

        <div className="field">
          <label htmlFor="telegramUsers">Telegram approver user IDs (comma-separated)</label>
          <input
            id="telegramUsers"
            type="text"
            value={telegramUsers}
            onChange={(e) => setTelegramUsers(e.target.value)}
            placeholder="123456789"
          />
          <p className="hint">Empty = anyone who /start the bot can approve (legacy).</p>
        </div>
      </section>

      <section className="card">
        <h2>Hard policy</h2>
        <div className="checkbox-row">
          <input
            id="mcpPolicy"
            type="checkbox"
            checked={mcpPolicy}
            disabled={ag?.mcpToolPolicySource === "env"}
            onChange={(e) => setMcpPolicy(e.target.checked)}
          />
          <label htmlFor="mcpPolicy">
            MCP tool policy (block Gmail send, deletes, Nylas calendar writes)
            {ag && <SourceBadge source={ag.mcpToolPolicySource} />}
          </label>
        </div>
        <div className="checkbox-row">
          <input
            id="terminalGuard"
            type="checkbox"
            checked={terminalGuard}
            disabled={ag?.terminalMailGuardSource === "env"}
            onChange={(e) => setTerminalGuard(e.target.checked)}
          />
          <label htmlFor="terminalGuard">
            Terminal mail guard (block nylas CLI / curl send bypass)
            {ag && <SourceBadge source={ag.terminalMailGuardSource} />}
          </label>
        </div>
      </section>

      <section className="card">
        <h2>Owner 1:1 channel</h2>
        <div className="field">
          <label htmlFor="ownerProvider">Provider</label>
          <select
            id="ownerProvider"
            value={ownerProvider}
            onChange={(e) => setOwnerProvider(e.target.value as "telegram" | "slack")}
          >
            <option value="telegram">Telegram</option>
            <option value="slack">Slack</option>
          </select>
        </div>
        {ownerProvider === "telegram" ? (
          <div className="field">
            <label htmlFor="telegramChatId">Telegram chat ID</label>
            <input
              id="telegramChatId"
              type="text"
              value={telegramChatId}
              onChange={(e) => setTelegramChatId(e.target.value)}
              placeholder="From /start on approval bot"
            />
          </div>
        ) : (
          <div className="field">
            <label htmlFor="slackChannelId">Slack DM channel ID</label>
            <input
              id="slackChannelId"
              type="text"
              value={slackChannelId}
              onChange={(e) => setSlackChannelId(e.target.value)}
              placeholder="D…"
            />
          </div>
        )}
      </section>

      <section className="card">
        <h2>Bot tokens</h2>
        <p className="hint">
          Values from <code>.env</code> show a red badge and cannot be changed here. Enter a new token to save to{" "}
          <code>.joshu/safety-settings/local-env.json</code>.
        </p>
        <div className="field">
          <label htmlFor="agToken">
            Action-guard Telegram bot token
            {settings && (
              <SourceBadge source={settings.secrets.actionGuardTelegramBotTokenSource} />
            )}
            {settings?.secrets.actionGuardTelegramBotTokenConfigured && !agBotToken ? " · configured" : ""}
          </label>
          <input
            id="agToken"
            type="password"
            value={agBotToken}
            disabled={settings?.secrets.actionGuardTelegramBotTokenSource === "env"}
            onChange={(e) => setAgBotToken(e.target.value)}
            placeholder="Leave blank to keep current"
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label htmlFor="hermesToken">
            Hermes chat Telegram bot token (separate)
            {settings && <SourceBadge source={settings.secrets.hermesTelegramBotTokenSource} />}
            {settings?.secrets.hermesTelegramBotTokenConfigured && !hermesBotToken ? " · configured" : ""}
          </label>
          <input
            id="hermesToken"
            type="password"
            value={hermesBotToken}
            disabled={settings?.secrets.hermesTelegramBotTokenSource === "env"}
            onChange={(e) => setHermesBotToken(e.target.value)}
            placeholder="Leave blank to keep current"
            autoComplete="off"
          />
        </div>
      </section>

      <section className="card">
        <h2>Hermes Slack chat</h2>
        <p className="hint">
          Full agent chat in Slack (like Telegram <code>TELEGRAM_BOT_TOKEN</code>). Separate from Composio Slack
          (tools) and the owner approval channel. Uses your own Slack app + Socket Mode.
        </p>
        {slackSetupSteps.length > 0 && (
          <ol className="hint setup-steps">
            {slackSetupSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        )}
        <div className="actions inline-actions">
          <button type="button" className="btn" disabled={saving || loading} onClick={() => void generateSlackManifest()}>
            {saving ? "Generating…" : "Generate manifest"}
          </button>
          <button type="button" className="btn" disabled={saving || loading} onClick={() => void verifySlackTokens()}>
            Verify tokens
          </button>
          {slackManifestText ? (
            <>
              <button type="button" className="btn" onClick={() => void copySlackManifest()}>
                Copy manifest
              </button>
              <button type="button" className="btn" onClick={downloadSlackManifest}>
                Download .json
              </button>
            </>
          ) : null}
        </div>
        {slackManifestText ? (
          <div className="field">
            <label htmlFor="slackManifestPreview">Slack app manifest</label>
            <textarea
              id="slackManifestPreview"
              className="manifest-preview"
              readOnly
              value={slackManifestText}
              rows={14}
              onFocus={(e) => e.currentTarget.select()}
            />
            <p className="hint">
              Paste this JSON at{" "}
              <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer">
                api.slack.com/apps
              </a>{" "}
              → Create New App → From an app manifest.{" "}
              <strong>Slash command URLs</strong> (e.g. <code>hermes-agent.local</code>) are required by
              Slack&apos;s schema but unused — Socket Mode delivers commands over WebSocket, not HTTP.
            </p>
          </div>
        ) : null}
        <div className="field">
          <label htmlFor="slackBotToken">
            Slack bot token (xoxb-…)
            {settings && <SourceBadge source={settings.secrets.slackBotTokenSource} />}
            {settings?.secrets.slackBotTokenConfigured && !slackBotToken ? " · configured" : ""}
          </label>
          <input
            id="slackBotToken"
            type="password"
            value={slackBotToken}
            disabled={settings?.secrets.slackBotTokenSource === "env"}
            onChange={(e) => setSlackBotToken(e.target.value)}
            placeholder="Leave blank to keep current"
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label htmlFor="slackAppToken">
            Slack app token (xapp-…, Socket Mode)
            {settings && <SourceBadge source={settings.secrets.slackAppTokenSource} />}
            {settings?.secrets.slackAppTokenConfigured && !slackAppToken ? " · configured" : ""}
          </label>
          <input
            id="slackAppToken"
            type="password"
            value={slackAppToken}
            disabled={settings?.secrets.slackAppTokenSource === "env"}
            onChange={(e) => setSlackAppToken(e.target.value)}
            placeholder="Leave blank to keep current"
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label htmlFor="slackAllowedUsers">Allowed Slack member IDs (U…, comma-separated)</label>
          <input
            id="slackAllowedUsers"
            type="text"
            value={slackAllowedUsers}
            onChange={(e) => setSlackAllowedUsers(e.target.value)}
            placeholder="U0123456789"
          />
        </div>
        <div className="field">
          <label htmlFor="slackHomeChannel">Home channel ID (optional, C… or D… for cron delivery)</label>
          <input
            id="slackHomeChannel"
            type="text"
            value={slackHomeChannel}
            onChange={(e) => setSlackHomeChannel(e.target.value)}
            placeholder="C01234567890"
          />
        </div>
        <div className="field">
          <label htmlFor="slackAllowedChannels">Allowed chat channel IDs (optional, comma-separated C…/G…)</label>
          <input
            id="slackAllowedChannels"
            type="text"
            value={slackAllowedChannels}
            onChange={(e) => setSlackAllowedChannels(e.target.value)}
            placeholder="C01234567890"
          />
        </div>
      </section>

      <div className="actions">
        <button type="button" className="btn btn-primary" disabled={saving || loading} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn" disabled={saving || loading} onClick={() => void restartGateway()}>
          {saving ? "Restarting…" : "Restart gateway"}
        </button>
        <button type="button" className="btn" disabled={saving || loading} onClick={() => void testApproval()}>
          Test approval
        </button>
        <button type="button" className="btn" disabled={loading} onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
