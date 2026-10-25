import "@joshu/design-system/typography.css";
import "@joshu/design-system/tokens.css";
import "@joshu/design-system/base.css";
import "./styles.css";

import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

const API = "/joshu/api/telephone";

type TelephoneStatus = {
  phoneNumber: string;
  phoneNumberDisplay: string;
  thinkPasswordConfigured: boolean;
  ownerCaller: string;
  ownerCallerDisplay: string;
  ownerCallerConfigured: boolean;
  pstnEnabled: boolean;
  pinConfigured: boolean;
  pinLength: number;
  trustVerifiedCallerId: boolean;
  sources: {
    phoneNumber: "settings-file" | "env" | "unset";
    thinkPassword: "settings-file" | "env" | "unset";
    ownerCaller: "settings-file" | "env" | "unset";
  };
};

function App() {
  const [status, setStatus] = useState<TelephoneStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<"passphrase" | "owner" | "pin" | "trust" | null>(null);
  const [draftPin, setDraftPin] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  /** The passphrase while Show is on; the status never holds it. */
  const [shownPassphrase, setShownPassphrase] = useState<string | null>(null);
  const [draftPassphrase, setDraftPassphrase] = useState("");
  const [draftOwnerCaller, setDraftOwnerCaller] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(API, { cache: "no-store" });
      if (!res.ok) throw new Error(await res.text());
      const json = (await res.json()) as { telephone: TelephoneStatus };
      setStatus(json.telephone);
      // Never prefill the edit box with the live passphrase — Show/Hide covers that.
      setDraftPassphrase("");
      setShownPassphrase(null);
      setDraftOwnerCaller(json.telephone.ownerCaller || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const putTelephone = async (body: Record<string, string | boolean>) => {
    const res = await fetch(API, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { error?: string; telephone?: TelephoneStatus; note?: string };
    if (!res.ok) throw new Error(json.error || res.statusText);
    if (json.telephone) {
      setStatus(json.telephone);
      setDraftOwnerCaller(json.telephone.ownerCaller || "");
    }
    setMessage(json.note || "Saved.");
  };

  const togglePassphrase = async () => {
    if (shownPassphrase !== null) {
      setShownPassphrase(null);
      return;
    }
    setError("");
    try {
      const res = await fetch(`${API}/passphrase`, { method: "POST", cache: "no-store" });
      const json = (await res.json()) as { error?: string; thinkPassword?: string };
      if (!res.ok) throw new Error(json.error || res.statusText);
      setShownPassphrase(json.thinkPassword ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const savePassphrase = async () => {
    setSaving("passphrase");
    setError("");
    setMessage("");
    try {
      await putTelephone({ thinkPassword: draftPassphrase });
      setDraftPassphrase("");
      setShownPassphrase(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  };

  const saveOwnerCaller = async () => {
    setSaving("owner");
    setError("");
    setMessage("");
    try {
      await putTelephone({ ownerCaller: draftOwnerCaller.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  };

  const savePin = async (pin: string) => {
    setSaving("pin");
    setError("");
    setMessage("");
    try {
      await putTelephone({ pin });
      setDraftPin("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  };

  const saveTrust = async (trustVerifiedCallerId: boolean) => {
    setSaving("trust");
    setError("");
    setMessage("");
    try {
      await putTelephone({ trustVerifiedCallerId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  };

  const copyNumber = async () => {
    if (!status?.phoneNumber) return;
    try {
      await navigator.clipboard.writeText(status.phoneNumber);
      setMessage("Phone number copied.");
    } catch {
      setError("Could not copy to clipboard.");
    }
  };

  return (
    <div className="app">
      <header>
        <p className="eyebrow">Joshu</p>
        <h1>Telephone</h1>
        <p className="sub">
          Box number, your mobile (SMS approvals), and the spoken unlock passphrase for inbound calls.
        </p>
      </header>

      {error ? <div className="banner error">{error}</div> : null}
      {message ? <div className="banner ok">{message}</div> : null}

      <section className="card">
        <h2>
          Phone number
          {status ? (
            <span className={`status-pill ${status.pstnEnabled ? "on" : "off"}`}>
              {status.pstnEnabled ? "PSTN on" : "PSTN off"}
            </span>
          ) : null}
        </h2>
        {loading && !status ? (
          <p className="muted">Loading…</p>
        ) : status?.phoneNumber ? (
          <>
            <p className="phone-display">{status.phoneNumberDisplay || status.phoneNumber}</p>
            <p className="muted">E.164: {status.phoneNumber}</p>
            <div className="actions">
              <button type="button" onClick={() => void copyNumber()}>
                Copy number
              </button>
              <button type="button" onClick={() => void refresh()} disabled={loading}>
                Refresh
              </button>
            </div>
          </>
        ) : (
          <p className="muted">
            No phone number is assigned yet. Fleet boxes get a number when Twilio provisioning
            finishes; self-host can set <code>TWILIO_PHONE_NUMBER</code> in the environment.
          </p>
        )}
      </section>

      <section className="card">
        <h2>Your mobile</h2>
        <p className="hint muted" style={{ marginTop: 0 }}>
          Joshu texts this number for write approvals (reply Y/N) and uses it to recognize you on
          inbound calls. This is <em>your</em> cell, not the box number above.
        </p>
        {status?.ownerCallerConfigured ? (
          <p className="muted" style={{ marginBottom: "0.85rem" }}>
            Current: {status.ownerCallerDisplay || status.ownerCaller}
            {status.sources.ownerCaller === "env" ? " (from box env)" : ""}
          </p>
        ) : (
          <p className="muted">No owner mobile yet — SMS approvals stay off until one is saved.</p>
        )}
        <div className="field">
          <label htmlFor="owner-caller">Mobile number</label>
          <input
            id="owner-caller"
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            value={draftOwnerCaller}
            onChange={(e) => setDraftOwnerCaller(e.target.value)}
            placeholder="+1 555 123 4567"
          />
          <p className="hint">Saved on this box. Takes effect immediately — no restart.</p>
        </div>
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={saving !== null}
            onClick={() => void saveOwnerCaller()}
          >
            {saving === "owner" ? "Saving…" : "Save mobile"}
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Think passphrase</h2>
        <p className="hint muted" style={{ marginTop: 0 }}>
          Callers must say this phrase at the start of every call (three wrong tries hang up). Use two
          distinct words of two or more syllables that are easy to hear on a noisy line (for example{" "}
          <em>harbor lantern</em>) — short or rhyming words get misheard.
        </p>
        {status?.thinkPasswordConfigured ? (
          <div className="passphrase-row" style={{ marginBottom: "0.85rem" }}>
            <code>{shownPassphrase ?? "•••• ••••"}</code>
            <button type="button" onClick={() => void togglePassphrase()}>
              {shownPassphrase !== null ? "Hide" : "Show"}
            </button>
          </div>
        ) : (
          <p className="muted">No passphrase set — inbound phone stays disabled until one is saved.</p>
        )}
        <div className="field">
          <label htmlFor="passphrase">New passphrase</label>
          <input
            id="passphrase"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={draftPassphrase}
            onChange={(e) => setDraftPassphrase(e.target.value)}
            placeholder="two short words"
          />
          <p className="hint">Saved on this box. Takes effect on the next inbound call.</p>
        </div>
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={saving !== null || !draftPassphrase.trim()}
            onClick={() => void savePassphrase()}
          >
            {saving === "passphrase" ? "Saving…" : "Save passphrase"}
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Keypad PIN</h2>
        <p className="hint muted" style={{ marginTop: 0 }}>
          Instead of saying the passphrase, you can key in a PIN — handy on a noisy line. Use 6 digits
          that are not a pattern. Only a scrambled copy is stored on this box.
        </p>
        <p className="muted" style={{ marginBottom: "0.85rem" }}>
          {status?.pinConfigured ? `PIN set (${status.pinLength} digits).` : "No PIN — callers say the passphrase."}
        </p>
        <div className="field">
          <label htmlFor="pin">New PIN</label>
          <input
            id="pin"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={8}
            value={draftPin}
            onChange={(e) => setDraftPin(e.target.value.replace(/\D/g, ""))}
            placeholder="4–8 digits"
          />
        </div>
        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={saving !== null || draftPin.length < 4}
            onClick={() => void savePin(draftPin)}
          >
            {saving === "pin" ? "Saving…" : "Save PIN"}
          </button>
          {status?.pinConfigured ? (
            <button type="button" disabled={saving !== null} onClick={() => void savePin("")}>
              Remove PIN
            </button>
          ) : null}
        </div>
      </section>

      <section className="card">
        <h2>Skip the passphrase from my phone</h2>
        <p className="hint muted" style={{ marginTop: 0 }}>
          When you call from your mobile above and your carrier fully verifies the caller ID, Joshu
          answers without asking for the passphrase. Anyone who can use your unlocked phone gets in
          too, so leave this off if that worries you. Callbacks from Joshu always ask.
        </p>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={Boolean(status?.trustVerifiedCallerId)}
            disabled={saving !== null || !status?.ownerCallerConfigured}
            onChange={(e) => void saveTrust(e.target.checked)}
          />
          <span>
            {status?.ownerCallerConfigured
              ? "Skip the passphrase for verified calls from my mobile"
              : "Save your mobile number first"}
          </span>
        </label>
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
