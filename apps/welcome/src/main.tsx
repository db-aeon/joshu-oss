import "@joshu/design-system/typography.css";
import "@joshu/design-system/tokens.css";
import "@joshu/design-system/base.css";
import "./styles.css";

import { BIG_PICTURE_PRIORITIES } from "@joshu/onboarding/options";
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

const API = "/joshu/api/onboarding";
const BOX_SECRETS_API = "/joshu/api/box-secrets";
const NYLAS = "/joshu/api/nylas";
const TELEPHONE_API = "/joshu/api/telephone";

/** Essentials-only flow. Soft prefs (tools, VIPs, channel dials) stay in draft JSON if already saved. */
type StepId = "welcome" | "connect-ai" | "big-picture" | "communication" | "review";

const BASE_STEPS: StepId[] = ["welcome", "big-picture", "communication", "review"];

function buildSteps(needsConnectAi: boolean): StepId[] {
  if (!needsConnectAi) return BASE_STEPS;
  return ["welcome", "connect-ai", ...BASE_STEPS.slice(1)];
}

/** Open Connectors on the ArozOS desktop when embedded; otherwise fall back to a new tab. */
function openConnectorsApp(): void {
  const parent = window.parent as Window & { openModule?: (name: string) => void };
  if (typeof parent.openModule === "function") {
    parent.openModule("Connectors");
    return;
  }
  window.open("/connectors/index.html", "_blank", "noopener,noreferrer");
}

/** Open jChat on the desktop (same pattern as Connectors). */
function openJChatApp(): void {
  const parent = window.parent as Window & { openModule?: (name: string) => void };
  if (typeof parent.openModule === "function") {
    parent.openModule("jChat");
    return;
  }
  window.open("/hermes-chat/index.html", "_blank", "noopener,noreferrer");
}

function formatHourMinute(hhmm: string): string {
  const match = hhmm.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return hhmm || "—";
  const hour = Number.parseInt(match[1]!, 10);
  const minute = match[2];
  const suffix = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${minute} ${suffix}`;
}

type VipRow = { who: string; priority: string; gatekeepNotes: string };

type Draft = {
  ownerName: string;
  assistantName: string;
  bigPicturePriorities: string[];
  bigPictureNotes: string;
  /** Kept for API / Day-0 / re-edit compat; UI only edits work + personal email. */
  communicationChannels: string[];
  communicationContacts: Record<string, string>;
  communicationNotes: string;
  onlineTools: string[];
  onlineToolsNotes: string;
  doNotAccess: string;
  updateFormat: string;
  urgentChannel: string;
  interruptMeNowMeans: string;
  timezone: string;
  workingHoursStart: string;
  workingHoursEnd: string;
  batchQuestions: string;
  vips: VipRow[];
};

const emptyDraft = (): Draft => ({
  // Names come from box identity / profile (no dedicated wizard step).
  ownerName: "Principal",
  assistantName: "Companion",
  bigPicturePriorities: [],
  bigPictureNotes: "",
  communicationChannels: [],
  communicationContacts: {},
  communicationNotes: "",
  onlineTools: [],
  onlineToolsNotes: "",
  doNotAccess: "",
  updateFormat: "Daily Brief (morning)",
  urgentChannel: "",
  interruptMeNowMeans: "",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  workingHoursStart: "09:00",
  workingHoursEnd: "18:00",
  batchQuestions: "",
  vips: [],
});

const LEGACY_CHANNEL_IDS: Record<string, string> = {
  Email: "work-email",
  "Phone call": "phone",
  "Text message (SMS)": "sms",
  WhatsApp: "whatsapp",
  Telegram: "telegram",
  Slack: "slack",
  "Google Chat": "google-chat",
};

function normalizeChannelIds(channels: string[] | undefined): string[] {
  if (!channels?.length) return [];
  return channels.map((c) => LEGACY_CHANNEL_IDS[c] ?? c);
}

/** Keep work/personal emails in sync with communicationContacts for complete(). */
function withEmailContacts(
  draft: Draft,
  emails: { work?: string; personal?: string },
): Partial<Draft> {
  const contacts = { ...draft.communicationContacts };
  const channels = new Set(draft.communicationChannels);

  const work = emails.work?.trim() ?? contacts["work-email"] ?? "";
  const personal = emails.personal?.trim() ?? contacts["personal-email"] ?? "";

  if (work) {
    contacts["work-email"] = work;
    channels.add("work-email");
  } else {
    delete contacts["work-email"];
    channels.delete("work-email");
  }

  if (personal) {
    contacts["personal-email"] = personal;
    channels.add("personal-email");
  } else {
    delete contacts["personal-email"];
    channels.delete("personal-email");
  }

  return {
    communicationContacts: contacts,
    communicationChannels: [...channels],
  };
}

function normalizeOwnerMobile(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 11) return `+${digits}`;
  return "";
}

/** Keep owner mobile in communicationContacts.sms for complete() → Telephone settings. */
function withSmsContact(draft: Draft, mobile: string): Partial<Draft> {
  const contacts = { ...draft.communicationContacts };
  const channels = new Set(draft.communicationChannels);
  const trimmed = mobile.trim();
  if (trimmed) {
    contacts.sms = trimmed;
    channels.add("sms");
  } else {
    delete contacts.sms;
    channels.delete("sms");
  }
  return {
    communicationContacts: contacts,
    communicationChannels: [...channels],
  };
}

function withNormalizedSms(d: Draft): Draft {
  const raw = d.communicationContacts.sms?.trim() ?? "";
  if (!raw) return d;
  const n = normalizeOwnerMobile(raw);
  if (!n || n === raw) return d;
  return { ...d, ...withSmsContact(d, n) };
}

function toggleInList(list: string[], item: string): string[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

/** Browser IANA zone list; falls back to a short common set if unsupported. */
function listIanaTimeZones(): string[] {
  try {
    const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
    if (typeof intl.supportedValuesOf === "function") {
      return intl.supportedValuesOf("timeZone");
    }
  } catch {
    /* ignore */
  }
  return [
    "America/Los_Angeles",
    "America/Denver",
    "America/Chicago",
    "America/New_York",
    "America/Toronto",
    "America/Sao_Paulo",
    "Europe/London",
    "Europe/Paris",
    "Europe/Berlin",
    "Asia/Tokyo",
    "Asia/Shanghai",
    "Asia/Singapore",
    "Asia/Kolkata",
    "Australia/Sydney",
    "Pacific/Auckland",
    "UTC",
  ];
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="welcome-field">
      <label>{label}</label>
      {hint ? <p className="welcome-hint">{hint}</p> : null}
      {children}
    </div>
  );
}

function CheckboxGroup({
  options,
  selected,
  onChange,
}: {
  options: readonly string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="welcome-checkboxes">
      {options.map((option) => (
        <label key={option} className="welcome-check">
          <input
            type="checkbox"
            checked={selected.includes(option)}
            onChange={() => onChange(toggleInList(selected, option))}
          />
          <span>{option}</span>
        </label>
      ))}
    </div>
  );
}

function formatList(items: string[]): string {
  return items.length ? items.join(", ") : "—";
}

function App() {
  const [step, setStep] = useState(0);
  const [needsConnectAi, setNeedsConnectAi] = useState(false);
  const [needsOpenRouter, setNeedsOpenRouter] = useState(true);
  const [needsGeminiVoice, setNeedsGeminiVoice] = useState(false);
  const [needsEmbeddingsGemini, setNeedsEmbeddingsGemini] = useState(false);
  const [needsGeminiMl, setNeedsGeminiMl] = useState(false);
  const [voiceOffered, setVoiceOffered] = useState(false);
  const [geminiConfigured, setGeminiConfigured] = useState(false);
  const [embeddingsGeminiConfigured, setEmbeddingsGeminiConfigured] = useState(false);
  const [openRouterKey, setOpenRouterKey] = useState("");
  const [geminiKey, setGeminiKey] = useState("");
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [nylasProvisioned, setNylasProvisioned] = useState(false);
  const [assistantEmail, setAssistantEmail] = useState("");
  const [agentEmailInput, setAgentEmailInput] = useState("");
  const [alreadyCompleted, setAlreadyCompleted] = useState(false);
  const [savedFlash, setSavedFlash] = useState("");
  /** Shown once after a successful Finish setup in this session (not on reload). */
  const [showSetupComplete, setShowSetupComplete] = useState(false);
  const completeInFlightRef = useRef(false);

  const steps = useMemo(() => buildSteps(needsConnectAi), [needsConnectAi]);
  const stepId = steps[step] ?? "welcome";
  const lastStep = steps.length - 1;
  const timeZones = useMemo(() => {
    const zones = listIanaTimeZones();
    const current = draft.timezone.trim();
    // Keep a saved/legacy value visible even if missing from the browser list.
    if (current && !zones.includes(current)) return [current, ...zones];
    return zones;
  }, [draft.timezone]);

  const workEmail = draft.communicationContacts["work-email"] ?? "";
  const personalEmail = draft.communicationContacts["personal-email"] ?? "";
  const ownerMobile = draft.communicationContacts.sms ?? "";

  const load = useCallback(async () => {
    const [statusRes, draftRes, secretsRes, telephoneRes] = await Promise.all([
      fetch(`${API}/status`),
      fetch(`${API}/draft`),
      fetch(`${BOX_SECRETS_API}/status`),
      fetch(TELEPHONE_API).catch(() => null),
    ]);
    const status = (await statusRes.json()) as {
      completed?: boolean;
      nylasProvisioned?: boolean;
      assistantEmail?: string | null;
      identity?: { name?: string; ownerDisplayName?: string };
      profile?: {
        ownerName?: string;
        assistantName?: string;
        timezone?: string;
        urgentChannel?: string;
        workingHoursStart?: string;
        workingHoursEnd?: string;
        primaryWorkEmail?: string;
        personalEmail?: string;
      };
    };
    setAlreadyCompleted(Boolean(status.completed));
    setNylasProvisioned(Boolean(status.nylasProvisioned));
    if (status.assistantEmail) setAssistantEmail(status.assistantEmail);
    const secrets = (await secretsRes.json()) as {
      needsConnectAi?: boolean;
      needsOpenRouter?: boolean;
      needsGeminiVoice?: boolean;
      needsEmbeddingsGemini?: boolean;
      needsGeminiMl?: boolean;
      voiceOffered?: boolean;
      geminiConfigured?: boolean;
      embeddingsGeminiConfigured?: boolean;
    };
    setNeedsConnectAi(Boolean(secrets.needsConnectAi));
    setNeedsOpenRouter(secrets.needsOpenRouter !== false);
    setNeedsGeminiVoice(Boolean(secrets.needsGeminiVoice));
    setNeedsEmbeddingsGemini(Boolean(secrets.needsEmbeddingsGemini));
    setNeedsGeminiMl(Boolean(secrets.needsGeminiMl));
    setVoiceOffered(Boolean(secrets.voiceOffered));
    setGeminiConfigured(Boolean(secrets.geminiConfigured));
    setEmbeddingsGeminiConfigured(Boolean(secrets.embeddingsGeminiConfigured));
    const draftBody = (await draftRes.json()) as {
      draft?: (Partial<Draft> & { primaryWorkEmail?: string; personalEmail?: string }) | null;
    };
    const telephoneBody =
      telephoneRes && telephoneRes.ok
        ? ((await telephoneRes.json()) as { telephone?: { ownerCaller?: string } })
        : null;
    const telephoneOwner = telephoneBody?.telephone?.ownerCaller?.trim() ?? "";
    setDraft((prev) => {
      const pickName = (...candidates: (string | undefined)[]) => {
        for (const value of candidates) {
          if (typeof value === "string" && value.trim()) return value.trim();
        }
        return undefined;
      };
      const saved = draftBody.draft ?? {};
      const normalizedChannels = normalizeChannelIds(saved.communicationChannels);
      const contacts: Record<string, string> = { ...(saved.communicationContacts ?? {}) };
      const legacyWork = saved.primaryWorkEmail?.trim() || status.profile?.primaryWorkEmail?.trim();
      const legacyPersonal = saved.personalEmail?.trim() || status.profile?.personalEmail?.trim();
      if (legacyWork && !contacts["work-email"]) contacts["work-email"] = legacyWork;
      if (legacyPersonal && !contacts["personal-email"]) contacts["personal-email"] = legacyPersonal;
      if (telephoneOwner && !contacts.sms) contacts.sms = telephoneOwner;
      if (legacyWork && !normalizedChannels.includes("work-email")) normalizedChannels.push("work-email");
      if (legacyPersonal && !normalizedChannels.includes("personal-email")) {
        normalizedChannels.push("personal-email");
      }
      if (contacts.sms && !normalizedChannels.includes("sms")) normalizedChannels.push("sms");

      return {
        ...prev,
        ...saved,
        bigPicturePriorities: saved.bigPicturePriorities ?? prev.bigPicturePriorities,
        communicationChannels: normalizedChannels.length ? normalizedChannels : prev.communicationChannels,
        communicationContacts: contacts,
        onlineTools: saved.onlineTools ?? prev.onlineTools,
        ownerName:
          pickName(saved.ownerName, status.identity?.ownerDisplayName, status.profile?.ownerName) ??
          prev.ownerName,
        assistantName:
          pickName(saved.assistantName, status.identity?.name, status.profile?.assistantName) ??
          prev.assistantName,
        timezone: status.profile?.timezone?.trim() || saved.timezone?.trim() || prev.timezone,
        urgentChannel: saved.urgentChannel?.trim() || status.profile?.urgentChannel?.trim() || prev.urgentChannel,
        workingHoursStart:
          saved.workingHoursStart?.trim() ||
          status.profile?.workingHoursStart?.trim() ||
          prev.workingHoursStart,
        workingHoursEnd:
          saved.workingHoursEnd?.trim() ||
          status.profile?.workingHoursEnd?.trim() ||
          prev.workingHoursEnd,
        vips: saved.vips?.length ? saved.vips : prev.vips,
      };
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveDraft = async (next: Draft) => {
    const res = await fetch(`${API}/draft`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? "Could not save progress");
    }
  };

  const patch = (partial: Partial<Draft>) => setDraft((d) => ({ ...d, ...partial }));

  const setWorkEmail = (value: string) => {
    setDraft((d) => ({ ...d, ...withEmailContacts(d, { work: value, personal: d.communicationContacts["personal-email"] }) }));
  };

  const setPersonalEmail = (value: string) => {
    setDraft((d) => ({ ...d, ...withEmailContacts(d, { work: d.communicationContacts["work-email"], personal: value }) }));
  };

  const setOwnerMobile = (value: string) => {
    setDraft((d) => ({ ...d, ...withSmsContact(d, value) }));
  };

  const saveConnectAi = async (): Promise<boolean> => {
    const payload: Record<string, string> = {};
    if (openRouterKey.trim()) payload.OPENROUTER_API_KEY = openRouterKey.trim();
    if (geminiKey.trim()) payload.GEMINI_API_KEY = geminiKey.trim();
    const res = await fetch(BOX_SECRETS_API, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? "Could not save API keys");
    }
    const data = (await res.json()) as {
      status?: {
        needsConnectAi?: boolean;
        needsOpenRouter?: boolean;
        needsGeminiVoice?: boolean;
        needsEmbeddingsGemini?: boolean;
        needsGeminiMl?: boolean;
        geminiConfigured?: boolean;
        embeddingsGeminiConfigured?: boolean;
      };
      message?: string;
    };
    const status = data.status;
    const stillNeeds = Boolean(status?.needsConnectAi);
    setNeedsConnectAi(stillNeeds);
    setNeedsOpenRouter(status?.needsOpenRouter !== false);
    setNeedsGeminiVoice(Boolean(status?.needsGeminiVoice));
    setNeedsEmbeddingsGemini(Boolean(status?.needsEmbeddingsGemini));
    setNeedsGeminiMl(Boolean(status?.needsGeminiMl));
    setGeminiConfigured(Boolean(status?.geminiConfigured));
    setEmbeddingsGeminiConfigured(Boolean(status?.embeddingsGeminiConfigured));
    setOpenRouterKey("");
    setGeminiKey("");
    if (data.message) setSavedFlash(data.message);
    return stillNeeds;
  };

  const saveGeminiKey = async () => {
    if (!geminiKey.trim()) return;
    const res = await fetch(BOX_SECRETS_API, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ GEMINI_API_KEY: geminiKey.trim() }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? "Could not save Gemini API key");
    }
    const data = (await res.json()) as {
      status?: {
        needsConnectAi?: boolean;
        needsGeminiVoice?: boolean;
        needsEmbeddingsGemini?: boolean;
        needsGeminiMl?: boolean;
        geminiConfigured?: boolean;
        embeddingsGeminiConfigured?: boolean;
      };
      message?: string;
    };
    setNeedsConnectAi(Boolean(data.status?.needsConnectAi));
    setNeedsGeminiVoice(Boolean(data.status?.needsGeminiVoice));
    setNeedsEmbeddingsGemini(Boolean(data.status?.needsEmbeddingsGemini));
    setNeedsGeminiMl(Boolean(data.status?.needsGeminiMl));
    setGeminiConfigured(Boolean(data.status?.geminiConfigured));
    setEmbeddingsGeminiConfigured(Boolean(data.status?.embeddingsGeminiConfigured));
    setGeminiKey("");
    setSavedFlash(data.message ?? "Gemini key saved — voice and file brain will use it after restart.");
  };

  const next = async () => {
    setError("");
    setSavedFlash("");
    if (stepId === "connect-ai") {
      if (needsOpenRouter && !openRouterKey.trim()) {
        setError("Paste your OpenRouter API key to enable chat.");
        return;
      }
      if (needsGeminiMl && !geminiKey.trim() && !geminiConfigured && !embeddingsGeminiConfigured) {
        setError("Paste your Google Gemini API key — it powers voice and file search on this box.");
        return;
      }
      if (!needsOpenRouter && !needsGeminiMl) {
        setStep((s) => Math.min(s + 1, lastStep));
        return;
      }
      if (!openRouterKey.trim() && !geminiKey.trim()) {
        setError("Enter the required API keys above.");
        return;
      }
      setBusy(true);
      try {
        const stillNeeds = await saveConnectAi();
        if (!stillNeeds) {
          setStep((s) => Math.min(s + 1, lastStep));
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (stepId === "communication" && !draft.timezone.trim()) {
      setError("Select a time zone.");
      return;
    }
    if (stepId === "communication") {
      const mobile = draft.communicationContacts.sms?.trim() ?? "";
      if (mobile && !normalizeOwnerMobile(mobile)) {
        setError("Enter a full mobile number with country code (for example +1 555 123 4567).");
        return;
      }
    }
    setBusy(true);
    try {
      const payload = withNormalizedSms(draft);
      setDraft(payload);
      await saveDraft(payload);
      setStep((s) => Math.min(s + 1, lastStep));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const skipConnectAi = () => {
    setError("");
    setSavedFlash("");
    setStep((s) => Math.min(s + 1, lastStep));
  };

  const back = () => {
    setSavedFlash("");
    setStep((s) => Math.max(s - 1, 0));
  };

  const provisionMailbox = async () => {
    setError("");
    setBusy(true);
    try {
      const res = await fetch(`${NYLAS}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: agentEmailInput.trim() || undefined,
          notifyEmail: draft.communicationContacts["work-email"]?.trim() || undefined,
        }),
      });
      const data = (await res.json()) as { email?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not create agent mailbox");
      setAssistantEmail(data.email ?? "");
      setNylasProvisioned(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const complete = async () => {
    if (completeInFlightRef.current) return;
    setError("");
    setSavedFlash("");
    completeInFlightRef.current = true;
    setBusy(true);
    const wasCompleted = alreadyCompleted;
    try {
      const payload = {
        ...withNormalizedSms(draft),
        vips: draft.vips.filter((v) => v.who.trim()),
      };
      const res = await fetch(`${API}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      setAlreadyCompleted(true);
      sessionStorage.setItem("joshu-onboarding-dismissed", "1");
      if (!wasCompleted) {
        setShowSetupComplete(true);
      } else {
        setSavedFlash("Changes saved.");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      completeInFlightRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="welcome-app">
      <div className="welcome-shell">
        <header className="welcome-header">
          <h1>{alreadyCompleted ? "Your Joshu profile" : "Welcome to Joshu"}</h1>
          <p>
            {alreadyCompleted
              ? "Update how your assistant works with you. Changes are saved to your workspace."
              : "A quick setup so your executive assistant knows how you work."}
          </p>
        </header>

        <div className="welcome-progress" aria-hidden>
          {steps.map((id, i) => (
            <span key={id} className={i <= step ? "active" : ""} />
          ))}
        </div>

        <div className="welcome-card">
          {error ? <div className="welcome-error">{error}</div> : null}
          {savedFlash ? <div className="welcome-success">{savedFlash}</div> : null}

          {stepId === "welcome" && (
            <>
              <h2>{alreadyCompleted ? "Review or update" : "Let's get you set up"}</h2>
              <p className="welcome-hint">
                {alreadyCompleted
                  ? "Walk through any section to update priorities or schedule. Connect apps anytime in Connectors."
                  : `This takes a few minutes. We'll capture what to help with and when to brief you — then write it where ${draft.assistantName || "your assistant"} always reads it first.`}
              </p>
              <div className="welcome-connectors-callout">
                <strong>Connect your apps</strong>
                <p className="welcome-hint">
                  Link Gmail, calendar, and other tools in Connectors so your assistant can work with your real inbox
                  and schedule. You can do this now or later.
                </p>
                <button type="button" className="primary" onClick={openConnectorsApp}>
                  Open Connectors
                </button>
              </div>
            </>
          )}

          {stepId === "connect-ai" && (
            <>
              <h2>Connect AI</h2>
              <p className="welcome-hint">
                Your box needs API keys to run chat, memory, and file search. Keys are stored on your box only — not
                sent to Joshu.
              </p>
              {needsOpenRouter ? (
                <Field label="OpenRouter API key" hint="For jChat — get one at openrouter.ai/keys">
                  <input
                    type="password"
                    autoComplete="off"
                    value={openRouterKey}
                    onChange={(e) => setOpenRouterKey(e.target.value)}
                    placeholder="sk-or-v1-…"
                  />
                </Field>
              ) : (
                <p className="welcome-hint">OpenRouter is already connected.</p>
              )}
              {needsGeminiMl ? (
                <>
                  <p className="welcome-hint" style={{ marginTop: "1rem" }}>
                    <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
                      Google Gemini
                    </a>{" "}
                    API key — powers file search (gbrain)
                    {voiceOffered ? ", jChat microphone (Gemini Live)" : ""}
                    , and Hindsight embeddings on this box.
                  </p>
                  <Field
                    label="Google Gemini API key"
                    hint={
                      needsEmbeddingsGemini && needsGeminiVoice
                        ? "Required for voice + file brain"
                        : needsEmbeddingsGemini
                          ? "Required for file brain"
                          : "Required for voice"
                    }
                  >
                    <input
                      type="password"
                      autoComplete="off"
                      value={geminiKey}
                      onChange={(e) => setGeminiKey(e.target.value)}
                      placeholder="AIza…"
                    />
                  </Field>
                </>
              ) : geminiConfigured || embeddingsGeminiConfigured ? (
                <p className="welcome-hint" style={{ marginTop: "1rem" }}>
                  Gemini is already connected.
                </p>
              ) : null}
            </>
          )}

          {stepId === "big-picture" && (
            <>
              <h2>Big picture</h2>
              <p className="welcome-hint">
                What should your assistant help take off your plate? Each selection becomes a project folder your
                assistant files work into.
              </p>
              <Field label="What to help with">
                <CheckboxGroup
                  options={BIG_PICTURE_PRIORITIES}
                  selected={draft.bigPicturePriorities}
                  onChange={(bigPicturePriorities) => patch({ bigPicturePriorities })}
                />
              </Field>
              <Field label="Anything else? (optional)" hint="Context, goals, or nuance the checkboxes don't cover.">
                <textarea
                  value={draft.bigPictureNotes}
                  onChange={(e) => patch({ bigPictureNotes: e.target.value })}
                />
              </Field>
            </>
          )}

          {stepId === "communication" && (
            <>
              <h2>Schedule & email</h2>
              <p className="welcome-hint">
                Work email is where morning/evening briefs go. Time zone and hours set when automated EA cron jobs
                run (morning pointer, evening shutdown, weekly review). Your mobile is where Joshu texts write
                approvals (reply Y or N).
              </p>
              <Field label="Work email" hint="Daily brief destination">
                <input
                  type="email"
                  value={workEmail}
                  onChange={(e) => setWorkEmail(e.target.value)}
                  placeholder="you@company.com"
                />
              </Field>
              <Field label="Personal email (optional)">
                <input
                  type="email"
                  value={personalEmail}
                  onChange={(e) => setPersonalEmail(e.target.value)}
                  placeholder="you@gmail.com"
                />
              </Field>
              <Field
                label="Your mobile (optional)"
                hint="SMS approvals and recognizing you on inbound calls. If you skip this, Joshu will nudge you to add it in Telephone or Welcome."
              >
                <input
                  type="tel"
                  autoComplete="tel"
                  inputMode="tel"
                  value={ownerMobile}
                  onChange={(e) => setOwnerMobile(e.target.value)}
                  placeholder="+1 555 123 4567"
                />
              </Field>
              <Field label="Time zone">
                <select
                  value={draft.timezone}
                  onChange={(e) => patch({ timezone: e.target.value })}
                >
                  {!draft.timezone ? <option value="">Select a time zone</option> : null}
                  {timeZones.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Working hours start">
                <input
                  value={draft.workingHoursStart}
                  onChange={(e) => patch({ workingHoursStart: e.target.value })}
                  placeholder="09:00"
                />
              </Field>
              <Field label="Working hours end">
                <input
                  value={draft.workingHoursEnd}
                  onChange={(e) => patch({ workingHoursEnd: e.target.value })}
                  placeholder="18:00"
                />
              </Field>
            </>
          )}

          {stepId === "review" && showSetupComplete ? (
            <>
              <h2>You&apos;re set up</h2>
              <p className="welcome-hint">
                Your executive assistant workspace is ready. Here&apos;s what we configured:
              </p>
              <ul className="welcome-setup-list">
                <li>
                  <strong>Project folders</strong> under Desktop for each priority you selected
                  {draft.bigPicturePriorities.length
                    ? `: ${formatList(draft.bigPicturePriorities)}`
                    : " (plus Projects/other)"}
                </li>
                <li>
                  <strong>Scheduled briefs</strong> in your time zone ({draft.timezone || "—"}): morning at{" "}
                  {formatHourMinute(draft.workingHoursStart)} (weekdays), evening at{" "}
                  {formatHourMinute(draft.workingHoursEnd)} (weekdays), weekly review Friday morning
                </li>
                <li>
                  <strong>Work email</strong> for pointer summaries: {workEmail || "—"}
                </li>
                {ownerMobile ? (
                  <li>
                    <strong>Your mobile</strong> for SMS approvals: {ownerMobile}
                  </li>
                ) : null}
                {nylasProvisioned ? (
                  <li>
                    <strong>Agent mailbox</strong>: {assistantEmail}
                  </li>
                ) : null}
              </ul>
              <p className="welcome-hint">
                Link Gmail and calendar in Connectors so mail ingest and scheduling can run. Say{" "}
                <strong>morning review</strong> in jChat when you want to plan the day.
              </p>
              <div className="welcome-setup-actions">
                <button type="button" className="primary" onClick={openJChatApp}>
                  Open jChat
                </button>
                <button type="button" className="secondary" onClick={openConnectorsApp}>
                  Open Connectors
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setShowSetupComplete(false);
                    window.close?.();
                  }}
                >
                  Close
                </button>
              </div>
            </>
          ) : null}

          {stepId === "review" && !showSetupComplete && (
            <>
              <h2>Review</h2>
              <p className="welcome-hint">
                <strong>Finish setup</strong> creates your project folders, installs EA morning/evening/weekly cron
                jobs, and saves your profile. This can take a few seconds — please wait for confirmation.
              </p>
              <dl className="welcome-review">
                <dt>Help with</dt>
                <dd>{formatList(draft.bigPicturePriorities)}</dd>
                <dt>Work email</dt>
                <dd>{workEmail || "—"}</dd>
                <dt>Time zone</dt>
                <dd>{draft.timezone || "—"}</dd>
                <dt>Working hours</dt>
                <dd>
                  {draft.workingHoursStart || "—"} – {draft.workingHoursEnd || "—"}
                </dd>
                <dt>Agent mailbox</dt>
                <dd>{nylasProvisioned ? assistantEmail : "Not yet — create below or in jMail later"}</dd>
                {needsGeminiMl || voiceOffered ? (
                  <>
                    <dt>Gemini (voice + file brain)</dt>
                    <dd>
                      {embeddingsGeminiConfigured && geminiConfigured
                        ? "Connected"
                        : embeddingsGeminiConfigured
                          ? "File brain connected — add key again for voice if needed"
                          : geminiConfigured
                            ? "Voice connected — restart box for file brain"
                            : "Not set — add a key below"}
                    </dd>
                  </>
                ) : null}
              </dl>

              <div className="welcome-mailbox">
                <strong>Agent mailbox</strong>
                {nylasProvisioned ? (
                  <p className="welcome-hint">Ready: {assistantEmail}</p>
                ) : (
                  <>
                    <p className="welcome-hint">
                      Optional: create a dedicated inbox for {draft.assistantName || "your assistant"} to send from.
                    </p>
                    <Field label="Preferred agent email (optional)">
                      <input
                        placeholder="assistant@yourdomain.com"
                        value={agentEmailInput}
                        onChange={(e) => setAgentEmailInput(e.target.value)}
                      />
                    </Field>
                    <button type="button" className="secondary" disabled={busy} onClick={() => void provisionMailbox()}>
                      Create agent mailbox
                    </button>
                  </>
                )}
              </div>

              <div className="welcome-connectors-callout">
                <strong>Apps still to connect?</strong>
                <p className="welcome-hint">Gmail and calendar live in Connectors.</p>
                <button type="button" className="secondary" onClick={openConnectorsApp}>
                  Open Connectors
                </button>
              </div>

              {needsGeminiMl ? (
                <div style={{ marginTop: "1rem" }}>
                  <Field label="Google Gemini API key" hint="From aistudio.google.com/apikey">
                    <input
                      type="password"
                      autoComplete="off"
                      value={geminiKey}
                      onChange={(e) => setGeminiKey(e.target.value)}
                      placeholder="AIza…"
                    />
                  </Field>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || !geminiKey.trim()}
                    onClick={() => {
                      setError("");
                      setBusy(true);
                      void saveGeminiKey()
                        .catch((e) => setError((e as Error).message))
                        .finally(() => setBusy(false));
                    }}
                  >
                    Save Gemini key
                  </button>
                </div>
              ) : null}
            </>
          )}

          <div className="welcome-actions">
            {step > 0 ? (
              <button type="button" className="secondary" disabled={busy} onClick={back}>
                Back
              </button>
            ) : null}
            {stepId === "connect-ai" ? (
              <button type="button" className="secondary" disabled={busy} onClick={skipConnectAi}>
                Skip for now
              </button>
            ) : null}
            {alreadyCompleted && step === lastStep && !showSetupComplete ? (
              <button type="button" className="secondary" disabled={busy} onClick={() => window.close?.()}>
                Close
              </button>
            ) : null}
            {step < lastStep ? (
              <button type="button" className="primary" disabled={busy} onClick={() => void next()}>
                {stepId === "connect-ai" ? "Save & continue" : "Continue"}
              </button>
            ) : showSetupComplete ? null : (
              <button type="button" className="primary" disabled={busy} onClick={() => void complete()}>
                {busy
                  ? alreadyCompleted
                    ? "Saving…"
                    : "Finishing…"
                  : alreadyCompleted
                    ? "Save changes"
                    : "Finish setup"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
