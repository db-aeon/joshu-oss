import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

const API = "/joshu/api/safety-settings";

type SlackSetup = {
  configured: boolean;
  ownerLinked: boolean;
  companionName: string;
  appId: string;
  appSettingsUrl: string;
  portraitUrl: string;
  steps: string[];
};

type SlackConnectPhase =
  | "idle"
  | "sign_in"
  | "configuration_token"
  | "create_app"
  | "app_token"
  | "install"
  | "finishing"
  | "done"
  | "failed"
  | "cancelled";

type SlackConnectRun = {
  phase: SlackConnectPhase;
  hint: string;
  error: string;
  appId: string;
  team: string;
  warnings: string[];
};

const RUN_STEPS: Array<{ phase: SlackConnectPhase; label: string }> = [
  { phase: "sign_in", label: "Sign in to Slack in jWeb" },
  { phase: "configuration_token", label: "Configuration token" },
  { phase: "create_app", label: "Make the Slack app" },
  { phase: "app_token", label: "App token" },
  { phase: "install", label: "Click Allow in jWeb" },
  { phase: "finishing", label: "Save and start Slack chat" },
];

const ACTIVE_PHASES = new Set<SlackConnectPhase>(RUN_STEPS.map((s) => s.phase));

/** Open jWeb (the live view of the shared browser) in the ArozOS desktop. False outside the desktop. */
function openJWeb(): boolean {
  try {
    const desktop = window.parent as unknown as { openModule?: (name: string) => void };
    if (typeof desktop.openModule === "function") {
      desktop.openModule("jWeb");
      return true;
    }
  } catch {
    /* not in the ArozOS desktop */
  }
  return false;
}

const OPEN_JWEB_YOURSELF = "Open jWeb from your Joshu desktop to see the shared browser.";

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json().catch(() => ({}))) as T;
}

/** Enter a Hermes pairing code from Slack or Telegram. */
export function PairingCodeField(props: {
  platform: "slack" | "telegram";
  disabled?: boolean;
  onApproved: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const approve = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${API}/pairing/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: props.platform, code }),
      });
      const json = await readJson<{ ok?: boolean; error?: string; userName?: string; userId?: string }>(res);
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Approval failed");
      setCode("");
      props.onApproved(`Approved ${json.userName || json.userId}.`);
    } catch (err) {
      props.onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const id = `pairing-${props.platform}`;
  return (
    <div className="field">
      <label htmlFor={id}>Pairing code</label>
      <div className="pairing-row">
        <input
          id={id}
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="ABCD2345"
          autoComplete="off"
          maxLength={16}
        />
        <button type="button" className="btn" disabled={busy || props.disabled || !code.trim()} onClick={() => void approve()}>
          {busy ? "Approving…" : "Approve"}
        </button>
      </div>
    </div>
  );
}

export type SlackManualFields = {
  botToken: string;
  appToken: string;
  allowedUsers: string;
  homeChannel: string;
  allowedChannels: string;
};

export function SlackChatCard(props: {
  disabled: boolean;
  botTokenBadge: ReactNode;
  appTokenBadge: ReactNode;
  botTokenConfigured: boolean;
  appTokenConfigured: boolean;
  botTokenFromEnv: boolean;
  appTokenFromEnv: boolean;
  fields: SlackManualFields;
  setField: (key: keyof SlackManualFields, value: string) => void;
  onMessage: (message: string) => void;
  onError: (message: string) => void;
  /** Reload the safety settings after Slack connect or a pairing approval. */
  onChanged: () => void;
}) {
  const { fields, setField, onMessage, onError } = props;
  const [setup, setSetup] = useState<SlackSetup | null>(null);
  const [run, setRun] = useState<SlackConnectRun | null>(null);
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [manifestText, setManifestText] = useState("");

  const loadSetup = useCallback(async () => {
    const res = await fetch(`${API}/slack-setup`, { cache: "no-store" });
    if (res.ok) setSetup((await readJson<{ setup?: SlackSetup }>(res)).setup ?? null);
  }, []);

  const loadRun = useCallback(async () => {
    const res = await fetch(`${API}/slack-connect`, { cache: "no-store" });
    if (res.ok) setRun((await readJson<{ run?: SlackConnectRun }>(res)).run ?? null);
  }, []);

  useEffect(() => {
    void loadSetup();
    void loadRun();
  }, [loadSetup, loadRun]);

  const running = Boolean(run && ACTIVE_PHASES.has(run.phase));
  const onChangedRef = useRef(props.onChanged);
  onChangedRef.current = props.onChanged;

  // Poll the run while it is active. When it ends, reload the settings.
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      void (async () => {
        const res = await fetch(`${API}/slack-connect`, { cache: "no-store" });
        if (!res.ok) return;
        const next = (await readJson<{ run?: SlackConnectRun }>(res)).run ?? null;
        setRun(next);
        if (next && !ACTIVE_PHASES.has(next.phase)) {
          void loadSetup();
          onChangedRef.current();
        }
      })();
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [running, loadSetup]);

  const companion = setup?.companionName || "your companion";

  const startConnect = async () => {
    setBusy(true);
    onError("");
    try {
      const res = await fetch(`${API}/slack-connect/start`, { method: "POST" });
      const json = await readJson<{ ok?: boolean; error?: string; run?: SlackConnectRun }>(res);
      if (json.run) setRun(json.run);
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Slack connect could not start");
      if (!openJWeb()) onMessage(OPEN_JWEB_YOURSELF);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmSignedIn = async () => {
    const res = await fetch(`${API}/slack-connect/signed-in`, { method: "POST" });
    if (res.ok) setRun((await readJson<{ run?: SlackConnectRun }>(res)).run ?? null);
  };

  const cancelConnect = async () => {
    const res = await fetch(`${API}/slack-connect/cancel`, { method: "POST" });
    if (res.ok) setRun((await readJson<{ run?: SlackConnectRun }>(res)).run ?? null);
  };

  const fetchManifest = async (): Promise<{ text: string; createAppUrl: string } | null> => {
    const res = await fetch(`${API}/slack-manifest`, { method: "POST" });
    const json = await readJson<{ ok?: boolean; manifest?: unknown; createAppUrl?: string; error?: string }>(res);
    if (!res.ok || !json.ok) throw new Error(json.error ?? "Manifest generation failed");
    const text = JSON.stringify(json.manifest, null, 2);
    setManifestText(text);
    return { text, createAppUrl: json.createAppUrl ?? "" };
  };

  const createSlackApp = async () => {
    setBusy(true);
    onError("");
    try {
      const result = await fetchManifest();
      if (result?.createAppUrl) window.open(result.createAppUrl, "_blank", "noopener");
      onMessage("Slack opened with the manifest filled in. Pick your workspace and click Create.");
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const copyManifest = async () => {
    try {
      const text = manifestText || (await fetchManifest())?.text || "";
      await navigator.clipboard.writeText(text);
      onMessage("Manifest copied to clipboard.");
    } catch {
      onError("Could not copy automatically. Select the manifest text below and copy it (Cmd/Ctrl+C).");
    }
  };

  const downloadManifest = async () => {
    try {
      const text = manifestText || (await fetchManifest())?.text || "";
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "slack-manifest.json";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const verifyTokens = async () => {
    setBusy(true);
    onError("");
    try {
      const res = await fetch(`${API}/slack-verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          botToken: fields.botToken.trim() || undefined,
          appToken: fields.appToken.trim() || undefined,
        }),
      });
      const json = await readJson<{
        ok?: boolean;
        bot?: { ok: boolean; team?: string; error?: string };
        app?: { ok: boolean; error?: string };
        error?: string;
      }>(res);
      if (!json.ok) {
        const parts = [
          json.bot && !json.bot.ok ? `bot token: ${json.bot.error ?? "invalid"}` : "",
          json.app && !json.app.ok ? `app token: ${json.app.error ?? "invalid"}` : "",
        ].filter(Boolean);
        throw new Error(parts.join("; ") || json.error || "Verification failed");
      }
      onMessage(`Slack tokens OK${json.bot?.team ? `, workspace ${json.bot.team}` : ""}.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const disabled = props.disabled || busy;
  const configured = Boolean(setup?.configured);
  const currentStep = RUN_STEPS.findIndex((s) => s.phase === run?.phase);

  return (
    <section className="card">
      <h2>Slack chat with {companion}</h2>
      <p className="hint">
        Message {companion} in Slack like a coworker. This is not the Slack toolkit in Connectors, which lets{" "}
        {companion} read and send Slack messages for you.
      </p>

      {running && run ? (
        <div className="slack-run">
          <ol className="run-steps">
            {RUN_STEPS.map((step, index) => (
              <li
                key={step.phase}
                className={index < currentStep ? "done" : index === currentStep ? "current" : ""}
              >
                {step.label}
              </li>
            ))}
          </ol>
          {run.hint ? <p className="run-hint">{run.hint}</p> : null}
          <div className="actions inline-actions">
            {run.phase === "sign_in" ? (
              <button type="button" className="btn btn-primary" onClick={() => void confirmSignedIn()}>
                I'm signed in
              </button>
            ) : null}
            <button
              type="button"
              className={run.phase === "sign_in" ? "btn" : "btn btn-primary"}
              onClick={() => {
                if (!openJWeb()) onMessage(OPEN_JWEB_YOURSELF);
              }}
            >
              Open jWeb
            </button>
            <button type="button" className="btn" onClick={() => void cancelConnect()}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          {run?.phase === "done" ? <p className="success">{run.hint}</p> : null}
          {run?.phase === "failed" ? (
            <p className="error">
              {run.error} {run.hint}
            </p>
          ) : null}
          {run?.warnings?.length ? <p className="hint">{run.warnings.join(" ")}</p> : null}

          {configured ? (
            <div className="status-grid">
              <div className="status-pill">
                <strong>Slack chat</strong>
                Connected
              </div>
              <div className="status-pill">
                <strong>Your Slack user</strong>
                {setup?.ownerLinked ? "Linked" : "Not linked yet"}
              </div>
            </div>
          ) : null}

          {configured && !setup?.ownerLinked ? (
            <>
              <p className="hint">
                Send {companion} a DM in Slack. {companion} answers with a pairing code. Enter the code here.
              </p>
              <PairingCodeField
                platform="slack"
                disabled={disabled}
                onApproved={(msg) => {
                  onMessage(`${msg} ${companion} sent you a DM in Slack.`);
                  void loadSetup();
                  props.onChanged();
                }}
                onError={onError}
              />
            </>
          ) : null}

          <div className="actions inline-actions">
            <button
              type="button"
              className={configured ? "btn" : "btn btn-primary"}
              disabled={disabled}
              onClick={() => void startConnect()}
            >
              {configured ? "Connect again" : "Connect Slack"}
            </button>
            {configured ? (
              <button type="button" className="btn" disabled={disabled} onClick={() => void verifyTokens()}>
                Verify tokens
              </button>
            ) : null}
            <button type="button" className="btn" onClick={() => setManual((v) => !v)}>
              {manual ? "Hide setup by hand" : "Set up by hand"}
            </button>
          </div>
          {!configured ? (
            <p className="hint">
              Connect Slack opens jWeb. You sign in to Slack and click Allow. The box does the other steps.
            </p>
          ) : null}
          {configured && (setup?.appSettingsUrl || setup?.portraitUrl) ? (
            <p className="hint">
              {setup?.appSettingsUrl ? (
                <a href={setup.appSettingsUrl} target="_blank" rel="noreferrer">
                  Slack app settings
                </a>
              ) : null}
              {setup?.appSettingsUrl && setup?.portraitUrl ? " · " : null}
              {setup?.portraitUrl ? (
                <a href={setup.portraitUrl} target="_blank" rel="noreferrer">
                  Portrait of {companion} (for the app icon)
                </a>
              ) : null}
            </p>
          ) : null}
        </>
      )}

      {manual && !running ? (
        <div className="slack-manual">
          {setup?.steps?.length ? (
            <ol className="hint setup-steps">
              {setup.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          ) : null}
          <div className="actions inline-actions">
            <button type="button" className="btn" disabled={disabled} onClick={() => void createSlackApp()}>
              Create Slack app
            </button>
            <button type="button" className="btn" disabled={disabled} onClick={() => void copyManifest()}>
              Copy manifest
            </button>
            <button type="button" className="btn" disabled={disabled} onClick={() => void downloadManifest()}>
              Download manifest
            </button>
            <button type="button" className="btn" disabled={disabled} onClick={() => void verifyTokens()}>
              Verify tokens
            </button>
          </div>
          {manifestText ? (
            <div className="field">
              <label htmlFor="slackManifestPreview">Slack app manifest</label>
              <textarea
                id="slackManifestPreview"
                className="manifest-preview"
                readOnly
                value={manifestText}
                rows={10}
                onFocus={(e) => e.currentTarget.select()}
              />
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="slackBotToken">
              Bot token (xoxb-…)
              {props.botTokenBadge}
              {props.botTokenConfigured && !fields.botToken ? " · configured" : ""}
            </label>
            <input
              id="slackBotToken"
              type="password"
              value={fields.botToken}
              disabled={props.botTokenFromEnv}
              onChange={(e) => setField("botToken", e.target.value)}
              placeholder="Leave blank to keep current"
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label htmlFor="slackAppToken">
              App token (xapp-…)
              {props.appTokenBadge}
              {props.appTokenConfigured && !fields.appToken ? " · configured" : ""}
            </label>
            <input
              id="slackAppToken"
              type="password"
              value={fields.appToken}
              disabled={props.appTokenFromEnv}
              onChange={(e) => setField("appToken", e.target.value)}
              placeholder="Leave blank to keep current"
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label htmlFor="slackAllowedUsers">Allowed Slack member IDs (optional, U…, comma-separated)</label>
            <input
              id="slackAllowedUsers"
              type="text"
              value={fields.allowedUsers}
              onChange={(e) => setField("allowedUsers", e.target.value)}
              placeholder="Found for you after Save"
            />
          </div>
          <div className="field">
            <label htmlFor="slackHomeChannel">Home channel ID (optional, C… or D…, for scheduled messages)</label>
            <input
              id="slackHomeChannel"
              type="text"
              value={fields.homeChannel}
              onChange={(e) => setField("homeChannel", e.target.value)}
              placeholder="Your DM with the companion after Save"
            />
          </div>
          <div className="field">
            <label htmlFor="slackAllowedChannels">Allowed chat channel IDs (optional, comma-separated C…/G…)</label>
            <input
              id="slackAllowedChannels"
              type="text"
              value={fields.allowedChannels}
              onChange={(e) => setField("allowedChannels", e.target.value)}
              placeholder="C01234567890"
            />
          </div>
          <p className="hint">Click Save at the bottom of the page. Slack checks the tokens first.</p>
        </div>
      ) : null}
    </section>
  );
}
