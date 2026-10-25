import "@joshu/design-system/typography.css";
import "@joshu/design-system/tokens.css";
import "@joshu/design-system/base.css";
import "./styles.css";

import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PairingCodeField, SlackChatCard, type SlackManualFields } from "./SlackChatCard";

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
    mcpToolPolicyEnabled: boolean;
    mcpToolPolicySource: SettingSource;
    terminalMailGuardEnabled: boolean;
    terminalMailGuardSource: SettingSource;
  };
  ownerChannel: {
    linked: boolean;
    provider?: "sms";
    ownerPhone?: string;
    gateActive: boolean;
    smsConfigured: boolean;
  };
  secrets: {
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
      ownerLinked: boolean;
      allowedUsers: string;
      homeChannel: string;
      allowedChannels: string;
    };
  };
  status: {
    ownerChannelLinked: boolean;
    smsConfigured: boolean;
    gateEnabled: boolean;
  };
  browser: {
    backend: "local" | "cloud";
    backendSource: SettingSource;
    cloudConfigured: boolean;
    requiresStackRestart: boolean;
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
  const [mcpPolicy, setMcpPolicy] = useState(true);
  const [terminalGuard, setTerminalGuard] = useState(true);
  const [hermesBotToken, setHermesBotToken] = useState("");
  const [slackBotToken, setSlackBotToken] = useState("");
  const [slackAppToken, setSlackAppToken] = useState("");
  const [slackAllowedUsers, setSlackAllowedUsers] = useState("");
  const [slackHomeChannel, setSlackHomeChannel] = useState("");
  const [slackAllowedChannels, setSlackAllowedChannels] = useState("");
  const [gatewayRunning, setGatewayRunning] = useState<boolean | null>(null);
  const [browserBackend, setBrowserBackend] = useState<"local" | "cloud">("local");

  const applyToForm = useCallback((s: SafetySettings) => {
    setEnabled(s.actionGuard.enabled);
    setGateMode(s.actionGuard.gateMode);
    setBrowserGate(s.actionGuard.browserGateWrites);
    setLlmClassifier(s.actionGuard.llmClassifier);
    setLlmThreshold(s.actionGuard.llmClassifierThreshold);
    setBypassOwnerOnly(s.actionGuard.bypassOwnerOnlyRecipients);
    setTimeoutMin(Math.round(s.actionGuard.approvalTimeoutMs / 60_000));
    setMcpPolicy(s.actionGuard.mcpToolPolicyEnabled);
    setTerminalGuard(s.actionGuard.terminalMailGuardEnabled);
    setHermesBotToken("");
    setSlackBotToken("");
    setSlackAppToken("");
    setSlackAllowedUsers(s.hermesMessaging.slack.allowedUsers);
    setSlackHomeChannel(s.hermesMessaging.slack.homeChannel);
    setSlackAllowedChannels(s.hermesMessaging.slack.allowedChannels);
    setBrowserBackend(s.browser.backend);
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

  const save = async () => {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const body: Record<string, unknown> = {
        actionGuard: {
          enabled,
          gateMode,
          browserGateWrites: browserGate,
          llmClassifier,
          llmClassifierThreshold: llmThreshold,
          bypassOwnerOnlyRecipients: bypassOwnerOnly,
          approvalTimeoutMs: timeoutMin * 60_000,
          mcpToolPolicyEnabled: mcpPolicy,
          terminalMailGuardEnabled: terminalGuard,
        },
        ownerChannel: {
          gateMode,
        },
        hermesMessaging: {
          slackAllowedUsers: slackAllowedUsers.trim(),
          slackHomeChannel: slackHomeChannel.trim(),
          slackAllowedChannels: slackAllowedChannels.trim(),
        },
        browser: {
          backend: browserBackend,
        },
      };
      if (hermesBotToken.trim()) {
        body.secrets = { ...(body.secrets as object), hermesTelegramBotToken: hermesBotToken.trim() };
      }
      if (slackBotToken.trim()) {
        body.secrets = { ...(body.secrets as object), slackBotToken: slackBotToken.trim() };
      }
      if (slackAppToken.trim()) {
        body.secrets = { ...(body.secrets as object), slackAppToken: slackAppToken.trim() };
      }
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
  const slackFields: SlackManualFields = {
    botToken: slackBotToken,
    appToken: slackAppToken,
    allowedUsers: slackAllowedUsers,
    homeChannel: slackHomeChannel,
    allowedChannels: slackAllowedChannels,
  };
  const setSlackField = (key: keyof SlackManualFields, value: string) => {
    const setters: Record<keyof SlackManualFields, (v: string) => void> = {
      botToken: setSlackBotToken,
      appToken: setSlackAppToken,
      allowedUsers: setSlackAllowedUsers,
      homeChannel: setSlackHomeChannel,
      allowedChannels: setSlackAllowedChannels,
    };
    setters[key](value);
  };

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
            <strong>Owner SMS</strong>
            {settings.ownerChannel.smsConfigured
              ? settings.ownerChannel.ownerPhone
                ? `Linked (${settings.ownerChannel.ownerPhone})`
                : "Configured"
              : "Not configured"}
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
        <h2>Browser backend (jWeb / handoff)</h2>
        <div className="field">
          <label htmlFor="browserBackend">
            Shared browser
            {settings && <SourceBadge source={settings.browser.backendSource} />}
          </label>
          <select
            id="browserBackend"
            value={browserBackend}
            onChange={(e) => setBrowserBackend(e.target.value as "local" | "cloud")}
          >
            <option value="local">Local Chromium (self-host default — no browser-use.com)</option>
            <option value="cloud" disabled={settings ? !settings.browser.cloudConfigured : false}>
              Browser Use Cloud (Joshu-managed hosting)
            </option>
          </select>
          <p className="hint">
            Local Chromium runs in the box with optional residential proxy (<code>PROXY_*</code> / Decodo).
            Browser Use Cloud needs <code>CONTROL_PLANE_URL</code> and an instance agent token — not available on
            standalone OSS boxes.
          </p>
          <p className="hint">
            After changing this, restart <strong>joshu-stack</strong> so the browser process and jWeb live view
            match.
          </p>
        </div>
      </section>

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
        <p className="hint">Requires owner SMS — set your mobile in Telephone (or TWILIO_OWNER_CALLER) plus Twilio account/number/webhook.</p>

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

      </section>

      <section className="card">
        <h2>Owner approval (SMS)</h2>
        <p className="hint">
          Action-guard approvals are sent by SMS to the owner mobile (Telephone app, or{" "}
          <code>TWILIO_OWNER_CALLER</code>). Reply <strong>Y</strong> or <strong>N</strong> to
          approve or deny. Twilio account wiring is in{" "}
          <code>docs/vps-sandbox/twilio-a2p-sms.md</code>.
        </p>
        <p className="hint">
          Status:{" "}
          {settings?.ownerChannel.smsConfigured
            ? settings.ownerChannel.ownerPhone
              ? `Owner phone ***${settings.ownerChannel.ownerPhone.replace(/^\*+/, "")}`
              : "SMS gateway configured"
            : "SMS not configured — gate will be unavailable until Twilio owner SMS is set up"}
        </p>
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
        <h2>Hermes Telegram chat</h2>
        <p className="hint">
          Full agent chat in Telegram (<code>TELEGRAM_BOT_TOKEN</code>). Separate from action-guard SMS approvals.
        </p>
        <div className="field">
          <label htmlFor="hermesToken">
            Hermes chat Telegram bot token
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
        <PairingCodeField
          platform="telegram"
          disabled={saving || loading}
          onApproved={(msg) => {
            setError("");
            setMessage(msg);
          }}
          onError={setError}
        />
      </section>

      <SlackChatCard
        disabled={saving || loading}
        botTokenBadge={settings ? <SourceBadge source={settings.secrets.slackBotTokenSource} /> : null}
        appTokenBadge={settings ? <SourceBadge source={settings.secrets.slackAppTokenSource} /> : null}
        botTokenConfigured={Boolean(settings?.secrets.slackBotTokenConfigured)}
        appTokenConfigured={Boolean(settings?.secrets.slackAppTokenConfigured)}
        botTokenFromEnv={settings?.secrets.slackBotTokenSource === "env"}
        appTokenFromEnv={settings?.secrets.slackAppTokenSource === "env"}
        fields={slackFields}
        setField={setSlackField}
        onMessage={(msg) => {
          setError("");
          setMessage(msg);
        }}
        onError={setError}
        onChanged={() => void refresh()}
      />

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
