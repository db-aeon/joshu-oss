import "@joshu/design-system/typography.css";
import "@joshu/design-system/tokens.css";
import "@joshu/design-system/base.css";
import "./styles.css";

import {
  BIG_PICTURE_PRIORITIES,
  COMMUNICATION_CHANNEL_DEFS,
  communicationChannelLabel,
  type CommunicationChannelDef,
  ONLINE_TOOL_SECTIONS,
} from "@joshu/onboarding/options";
import { StrictMode, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

const API = "/joshu/api/onboarding";
const BOX_SECRETS_API = "/joshu/api/box-secrets";
const NYLAS = "/joshu/api/nylas";

type StepId =
  | "welcome"
  | "connect-ai"
  | "you"
  | "big-picture"
  | "communication"
  | "tools"
  | "people"
  | "review";

const BASE_STEPS: StepId[] = [
  "welcome",
  "you",
  "big-picture",
  "communication",
  "tools",
  "people",
  "review",
];

function buildSteps(needsConnectAi: boolean): StepId[] {
  if (!needsConnectAi) return BASE_STEPS;
  return ["welcome", "connect-ai", ...BASE_STEPS.slice(1)];
}

type VipRow = { who: string; priority: string; gatekeepNotes: string };

type Draft = {
  ownerName: string;
  assistantName: string;
  bigPicturePriorities: string[];
  bigPictureNotes: string;
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
  ownerName: "Dan",
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
  vips: [{ who: "", priority: "", gatekeepNotes: "" }],
});

function toggleInList(list: string[], item: string): string[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
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

function ChannelPicker({
  channels,
  selected,
  contacts,
  onChange,
}: {
  channels: CommunicationChannelDef[];
  selected: string[];
  contacts: Record<string, string>;
  onChange: (next: { selected: string[]; contacts: Record<string, string> }) => void;
}) {
  const toggle = (id: string) => {
    if (selected.includes(id)) {
      const nextContacts = { ...contacts };
      delete nextContacts[id];
      onChange({ selected: selected.filter((x) => x !== id), contacts: nextContacts });
      return;
    }
    onChange({ selected: [...selected, id], contacts });
  };

  const setContact = (id: string, value: string) => {
    onChange({ selected, contacts: { ...contacts, [id]: value } });
  };

  return (
    <div className="welcome-checkboxes">
      {channels.map((channel) => (
        <div key={channel.id} className="welcome-channel-row">
          <label className="welcome-check">
            <input
              type="checkbox"
              checked={selected.includes(channel.id)}
              onChange={() => toggle(channel.id)}
            />
            <span>{channel.label}</span>
          </label>
          {selected.includes(channel.id) ? (
            <div className="welcome-channel-contact">
              <label htmlFor={`contact-${channel.id}`}>{channel.contactLabel}</label>
              <input
                id={`contact-${channel.id}`}
                type={channel.inputType ?? "text"}
                placeholder={channel.contactPlaceholder}
                value={contacts[channel.id] ?? ""}
                onChange={(e) => setContact(channel.id, e.target.value)}
              />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function formatCommunicationSummary(channels: string[], contacts: Record<string, string>): string {
  if (!channels.length) return "—";
  return channels
    .map((id) => {
      const label = communicationChannelLabel(id);
      const contact = contacts[id]?.trim();
      return contact ? `${label} (${contact})` : label;
    })
    .join(", ");
}

function formatList(items: string[]): string {
  return items.length ? items.join(", ") : "—";
}

function App() {
  const [step, setStep] = useState(0);
  const [needsConnectAi, setNeedsConnectAi] = useState(false);
  const [needsOpenRouter, setNeedsOpenRouter] = useState(true);
  const [needsGeminiVoice, setNeedsGeminiVoice] = useState(false);
  const [voiceOffered, setVoiceOffered] = useState(false);
  const [geminiConfigured, setGeminiConfigured] = useState(false);
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

  const steps = useMemo(() => buildSteps(needsConnectAi), [needsConnectAi]);
  const stepId = steps[step] ?? "welcome";
  const lastStep = steps.length - 1;

  const load = useCallback(async () => {
    const [statusRes, draftRes, secretsRes] = await Promise.all([
      fetch(`${API}/status`),
      fetch(`${API}/draft`),
      fetch(`${BOX_SECRETS_API}/status`),
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
      voiceOffered?: boolean;
      geminiConfigured?: boolean;
    };
    setNeedsConnectAi(Boolean(secrets.needsConnectAi));
    setNeedsOpenRouter(secrets.needsOpenRouter !== false);
    setNeedsGeminiVoice(Boolean(secrets.needsGeminiVoice));
    setVoiceOffered(Boolean(secrets.voiceOffered));
    setGeminiConfigured(Boolean(secrets.geminiConfigured));
    const draftBody = (await draftRes.json()) as {
      draft?: Partial<Draft> & { primaryWorkEmail?: string; personalEmail?: string } | null;
    };
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
      if (legacyWork && !normalizedChannels.includes("work-email")) normalizedChannels.push("work-email");
      if (legacyPersonal && !normalizedChannels.includes("personal-email")) normalizedChannels.push("personal-email");

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

  const saveConnectAi = async () => {
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
        geminiConfigured?: boolean;
      };
    };
    const status = data.status;
    setNeedsConnectAi(Boolean(status?.needsConnectAi));
    setNeedsOpenRouter(status?.needsOpenRouter !== false);
    setNeedsGeminiVoice(Boolean(status?.needsGeminiVoice));
    setGeminiConfigured(Boolean(status?.geminiConfigured));
    setOpenRouterKey("");
    setGeminiKey("");
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
    const data = (await res.json()) as { status?: { geminiConfigured?: boolean; needsGeminiVoice?: boolean } };
    setGeminiConfigured(Boolean(data.status?.geminiConfigured));
    setNeedsGeminiVoice(Boolean(data.status?.needsGeminiVoice));
    setGeminiKey("");
    setSavedFlash("Gemini key saved — voice mic in jChat is enabled.");
  };

  const next = async () => {
    setError("");
    setSavedFlash("");
    if (stepId === "connect-ai") {
      if (needsOpenRouter && !openRouterKey.trim()) {
        setError("Paste your OpenRouter API key to enable chat.");
        return;
      }
      if (!openRouterKey.trim() && !geminiKey.trim()) {
        setError("Enter at least one API key, or choose Skip for now.");
        return;
      }
      setBusy(true);
      try {
        await saveConnectAi();
        setNeedsConnectAi(false);
        // Step index stays at 1 — after removing connect-ai, that slot is "you".
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (stepId === "you" && (!draft.ownerName.trim() || !draft.assistantName.trim())) {
      setError("Please enter your name and your assistant's name.");
      return;
    }
    setBusy(true);
    try {
      await saveDraft(draft);
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

  const finishLater = () => {
    sessionStorage.setItem("joshu-onboarding-dismissed", "1");
    window.close?.();
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
    setError("");
    setSavedFlash("");
    setBusy(true);
    try {
      const payload = {
        ...draft,
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
      setSavedFlash(alreadyCompleted ? "Changes saved." : "Setup complete — Projects and crons are ready.");
      sessionStorage.setItem("joshu-onboarding-dismissed", "1");
    } catch (e) {
      setError((e as Error).message);
    } finally {
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
                  ? "Walk through any section to update priorities, communication preferences, or tools. Your assistant reads these from your workspace files."
                  : `This takes about 10 minutes. We'll capture what you're juggling, how you like to communicate, and which tools you use — then write it where ${draft.assistantName} always reads it first.`}
              </p>
              <p className="welcome-hint">You can pause anytime. Progress is saved as you go.</p>
            </>
          )}

          {stepId === "connect-ai" && (
            <>
              <h2>Connect AI</h2>
              <p className="welcome-hint">
                jChat needs an{" "}
                <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">
                  OpenRouter
                </a>{" "}
                API key for chat. Keys are stored on your box (not sent to Joshu).
              </p>
              {needsOpenRouter ? (
                <Field label="OpenRouter API key" hint="Starts with sk-or-v1-">
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
              {voiceOffered ? (
                <>
                  <p className="welcome-hint" style={{ marginTop: "1rem" }}>
                    Optional: add a{" "}
                    <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
                      Google Gemini
                    </a>{" "}
                    API key to enable the microphone in jChat (Gemini Live voice).
                  </p>
                  <Field label="Gemini API key (voice)" hint="Optional — enables mic in jChat">
                    <input
                      type="password"
                      autoComplete="off"
                      value={geminiKey}
                      onChange={(e) => setGeminiKey(e.target.value)}
                      placeholder="AIza…"
                    />
                  </Field>
                </>
              ) : null}
            </>
          )}

          {stepId === "you" && (
            <>
              <h2>You & your assistant</h2>
              <Field label="Your name (Principal)">
                <input
                  value={draft.ownerName}
                  onChange={(e) => patch({ ownerName: e.target.value })}
                />
              </Field>
              <Field label="Assistant name">
                <input
                  value={draft.assistantName}
                  onChange={(e) => patch({ assistantName: e.target.value })}
                />
              </Field>
            </>
          )}

          {stepId === "big-picture" && (
            <>
              <h2>Big picture</h2>
              <p className="welcome-hint">
                What should your assistant help take off your plate? Check everything that applies — business,
                family, personal, or all of the above.
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
              <h2>Communication</h2>
              <p className="welcome-hint">
                Select how your assistant should reach you. When you check a channel, add the email,
                phone number, or handle to use.
              </p>
              <Field label="Your channels">
                <ChannelPicker
                  channels={COMMUNICATION_CHANNEL_DEFS}
                  selected={draft.communicationChannels}
                  contacts={draft.communicationContacts}
                  onChange={({ selected, contacts }) =>
                    patch({ communicationChannels: selected, communicationContacts: contacts })
                  }
                />
              </Field>
              <Field label="Other communication notes (optional)">
                <textarea
                  value={draft.communicationNotes}
                  onChange={(e) => patch({ communicationNotes: e.target.value })}
                  placeholder="Channel rules, backup contacts, when not to ping you, etc."
                />
              </Field>
              <Field label="Time zone">
                <input value={draft.timezone} onChange={(e) => patch({ timezone: e.target.value })} />
              </Field>
              <Field label="Working hours start">
                <input
                  value={draft.workingHoursStart}
                  onChange={(e) => patch({ workingHoursStart: e.target.value })}
                />
              </Field>
              <Field label="Working hours end">
                <input
                  value={draft.workingHoursEnd}
                  onChange={(e) => patch({ workingHoursEnd: e.target.value })}
                />
              </Field>
              <Field label="How should you receive updates?">
                <select value={draft.updateFormat} onChange={(e) => patch({ updateFormat: e.target.value })}>
                  <option>Daily Brief (morning)</option>
                  <option>Daily Brief + EOD note</option>
                  <option>EOD note only</option>
                </select>
              </Field>
              <Field label="Urgent channel (interrupt now)" hint="Which channel above means drop everything?">
                {draft.communicationChannels.length > 0 ? (
                  <select
                    value={draft.urgentChannel}
                    onChange={(e) => patch({ urgentChannel: e.target.value })}
                  >
                    <option value="">Select a channel</option>
                    {draft.communicationChannels.map((id) => (
                      <option key={id} value={communicationChannelLabel(id)}>
                        {communicationChannelLabel(id)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={draft.urgentChannel}
                    onChange={(e) => patch({ urgentChannel: e.target.value })}
                    placeholder="Select channels above first"
                  />
                )}
              </Field>
              <Field label={'What counts as "interrupt me now"?'}>
                <textarea
                  value={draft.interruptMeNowMeans}
                  onChange={(e) => patch({ interruptMeNowMeans: e.target.value })}
                />
              </Field>
              <Field label="Batch questions vs ask as they arise?">
                <textarea
                  value={draft.batchQuestions}
                  onChange={(e) => patch({ batchQuestions: e.target.value })}
                />
              </Field>
            </>
          )}

          {stepId === "tools" && (
            <>
              <h2>Online tools</h2>
              <p className="welcome-hint">
                Which apps and services does your assistant need to know about? Include anything you rely on
                day-to-day.
              </p>
              {ONLINE_TOOL_SECTIONS.map((section) => (
                <Field key={section.title} label={section.title}>
                  <CheckboxGroup
                    options={section.options}
                    selected={draft.onlineTools}
                    onChange={(onlineTools) => patch({ onlineTools })}
                  />
                </Field>
              ))}
              <Field label="Other tools or notes (optional)">
                <textarea
                  value={draft.onlineToolsNotes}
                  onChange={(e) => patch({ onlineToolsNotes: e.target.value })}
                  placeholder="e.g. custom CRM, industry-specific apps, login notes"
                />
              </Field>
              <Field label="Anything the assistant should not access?">
                <textarea value={draft.doNotAccess} onChange={(e) => patch({ doNotAccess: e.target.value })} />
              </Field>
              <div className="welcome-mailbox">
                <strong>Agent mailbox</strong>
                {nylasProvisioned ? (
                  <p className="welcome-hint">Ready: {assistantEmail}</p>
                ) : (
                  <>
                    <p className="welcome-hint">
                      Create a dedicated inbox for {draft.assistantName}. Forward your principal mail here.
                    </p>
                    <Field label="Preferred agent email (optional)">
                      <input
                        placeholder="assistant@yourdomain.com"
                        value={agentEmailInput}
                        onChange={(e) => setAgentEmailInput(e.target.value)}
                      />
                    </Field>
                    <button type="button" className="primary" disabled={busy} onClick={() => void provisionMailbox()}>
                      Create agent mailbox
                    </button>
                  </>
                )}
              </div>
            </>
          )}

          {stepId === "people" && (
            <>
              <h2>Key people (optional)</h2>
              <p className="welcome-hint">VIPs and gatekeeping notes — skip if you&apos;ll add these later.</p>
              {draft.vips.map((vip, i) => (
                <div key={i} className="welcome-vip-row">
                  <Field label="Who">
                    <input
                      value={vip.who}
                      onChange={(e) => {
                        const vips = [...draft.vips];
                        vips[i] = { ...vips[i], who: e.target.value };
                        patch({ vips });
                      }}
                    />
                  </Field>
                  <Field label="Priority">
                    <input
                      value={vip.priority}
                      onChange={(e) => {
                        const vips = [...draft.vips];
                        vips[i] = { ...vips[i], priority: e.target.value };
                        patch({ vips });
                      }}
                    />
                  </Field>
                  <Field label="Gatekeep notes">
                    <input
                      value={vip.gatekeepNotes}
                      onChange={(e) => {
                        const vips = [...draft.vips];
                        vips[i] = { ...vips[i], gatekeepNotes: e.target.value };
                        patch({ vips });
                      }}
                    />
                  </Field>
                </div>
              ))}
              <button
                type="button"
                className="secondary"
                onClick={() => patch({ vips: [...draft.vips, { who: "", priority: "", gatekeepNotes: "" }] })}
              >
                Add another
              </button>
            </>
          )}

          {stepId === "review" && (
            <>
              <h2>Review</h2>
              <dl className="welcome-review">
                <dt>Principal</dt>
                <dd>{draft.ownerName}</dd>
                <dt>Assistant</dt>
                <dd>{draft.assistantName}</dd>
                <dt>Help with</dt>
                <dd>{formatList(draft.bigPicturePriorities)}</dd>
                <dt>Communication</dt>
                <dd>{formatCommunicationSummary(draft.communicationChannels, draft.communicationContacts)}</dd>
                <dt>Online tools</dt>
                <dd>{formatList(draft.onlineTools)}</dd>
                <dt>Urgent channel</dt>
                <dd>{draft.urgentChannel || "—"}</dd>
                <dt>Mailbox</dt>
                <dd>{nylasProvisioned ? assistantEmail : "Not yet — you can set up in jMail later"}</dd>
                {voiceOffered ? (
                  <>
                    <dt>Voice (jChat mic)</dt>
                    <dd>{geminiConfigured ? "Gemini Live connected" : "Not set — add a key below"}</dd>
                  </>
                ) : null}
              </dl>
              {voiceOffered && needsGeminiVoice ? (
                <div style={{ marginTop: "1rem" }}>
                  <Field label="Gemini API key (voice)" hint="From aistudio.google.com/apikey">
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
            {step > 0 && step < lastStep ? (
              <button type="button" className="secondary" disabled={busy} onClick={back}>
                Back
              </button>
            ) : null}
            {stepId === "connect-ai" ? (
              <button type="button" className="secondary" disabled={busy} onClick={skipConnectAi}>
                Skip for now
              </button>
            ) : null}
            {alreadyCompleted && step === lastStep ? (
              <button type="button" className="secondary" disabled={busy} onClick={() => window.close?.()}>
                Close
              </button>
            ) : (
              <button type="button" className="secondary" disabled={busy} onClick={finishLater}>
                Finish later
              </button>
            )}
            {step < lastStep ? (
              <button type="button" className="primary" disabled={busy} onClick={() => void next()}>
                {stepId === "connect-ai" ? "Save & continue" : "Continue"}
              </button>
            ) : (
              <button type="button" className="primary" disabled={busy} onClick={() => void complete()}>
                {alreadyCompleted ? "Save changes" : "Finish setup"}
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
