/**
 * The Research app (change recurring-research-reports, design decision D12): the list of recurring
 * reports and Research reports, the detail view of a recurring report with its report updates and
 * stories, and one form for a new report. Every change goes through the routes under
 * /joshu/api/research/, which the plugin tools of the companion also call.
 */
import "@joshu/design-system/typography.css";
import "@joshu/design-system/tokens.css";
import "@joshu/design-system/base.css";
import "./styles.css";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

type Channel = "email" | "sms" | "slack" | "telegram";
type SourceId = "web" | "papers" | "company" | "reddit" | "x" | "youtube" | "tiktok" | "instagram";

type RunSummary = { at: string; result: "delivered" | "nothing new" | "failed" | "skipped"; stories?: number; step?: string };

type Recurring = {
  id: string;
  name: string;
  state: "active" | "paused" | "deleted";
  quiet: boolean;
  schedule: string;
  scheduleText: string;
  channel: Channel;
  channelText: string;
  sources: "auto" | SourceId[];
  notes: string;
  lanes: { id: string; topic: string; sources: string[]; reason?: string }[];
  lastRun?: RunSummary;
  nextRunAt?: string;
};

type Report = { id: string; topic: string; requestedAt: string; summary: string; reportLink: string };

type ThemeLink = { url: string; site: string; title: string; counter?: string };
type UpdateTheme = { title: string; paragraphs: string[]; links: ThemeLink[] };
type Update = {
  run: string;
  at: string;
  result: string;
  stories: number;
  channel?: Channel;
  digest: string;
  /** A report update with themes has its summary and themes; an older one has only its digest. */
  summary?: string;
  themes?: UpdateTheme[];
  sources: { name: string; state: string }[];
};

function UpdateThemes({ update }: { update: Update }) {
  return (
    <div className="update-themes">
      {update.summary && <p className="update-summary">{update.summary}</p>}
      {(update.themes ?? []).map((t) => (
        <article key={t.title} className="update-theme">
          <h3>{t.title}</h3>
          {t.paragraphs.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
          {t.links[0] && (
            <p className="theme-links">
              <a href={t.links[0].url} target="_blank" rel="noreferrer">
                {t.links[0].title}
              </a>{" "}
              <span className="muted">({t.links[0].site})</span>
              {t.links.length > 1 && (
                <>
                  {" "}
                  <span className="muted">More:</span>{" "}
                  {t.links.slice(1).map((l, i) => (
                    <span key={l.url}>
                      {i > 0 && ", "}
                      <a href={l.url} target="_blank" rel="noreferrer">
                        {l.site}
                      </a>
                    </span>
                  ))}
                </>
              )}
            </p>
          )}
        </article>
      ))}
    </div>
  );
}

type Story = { id: string; title: string; summary: string; lane: string; status: "new" | "developing" | "quiet"; items: number; sources: string[]; lastRun: string; link?: string };

const API = (import.meta.env.VITE_RESEARCH_API_BASE || "/joshu/api/research").replace(/\/+$/, "");

const SOURCES: { id: SourceId; label: string }[] = [
  { id: "web", label: "Web and news" },
  { id: "papers", label: "Research papers" },
  { id: "company", label: "Company data" },
  { id: "reddit", label: "Reddit" },
  { id: "x", label: "X" },
  { id: "youtube", label: "YouTube" },
  { id: "tiktok", label: "TikTok" },
  { id: "instagram", label: "Instagram" },
];

const CHANNEL_LABELS: Record<Channel, string> = { email: "Email", sms: "Text message", slack: "Slack", telegram: "Telegram" };
const DAYS = [
  { id: "mon", label: "Mon" },
  { id: "tue", label: "Tue" },
  { id: "wed", label: "Wed" },
  { id: "thu", label: "Thu" },
  { id: "fri", label: "Fri" },
  { id: "sat", label: "Sat" },
  { id: "sun", label: "Sun" },
];
const CRON_DAY_IDS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const body = (await response.json().catch(() => ({}))) as T & { ok?: boolean; error?: string };
  if (!response.ok || body.ok === false) throw new Error(typeof body.error === "string" ? body.error : `Request failed (${response.status})`);
  return body;
}

function formatDay(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatWhen(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** The last run in words, as the spec names it: stories, nothing new, or failed. */
function lastRunText(run?: RunSummary): string {
  if (!run) return "No run yet";
  const when = formatDay(run.at);
  if (run.result === "failed") return `Failed ${when}`;
  if (run.result === "nothing new") return `Nothing new ${when}`;
  if (run.result === "delivered") return `${run.stories ?? 0} new and developing ${run.stories === 1 ? "story" : "stories"}, ${when}`;
  return `Skipped ${when}`;
}

function StateBadge({ report }: { report: Recurring }) {
  const label = report.state === "paused" ? "Paused" : report.quiet ? "Quiet" : "Active";
  return <span className={`badge badge-${label.toLowerCase()}`}>{label}</span>;
}

function StatusBadge({ status }: { status: Story["status"] }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}

type FormState = {
  topics: string;
  mode: "once" | "recurring";
  days: string[];
  time: string;
  auto: boolean;
  sources: SourceId[];
  channel: Channel;
  notes: string;
  /** The sections of a one-time report, one on each line. */
  sections: string;
};

function formFrom(report?: Recurring): FormState {
  if (!report) return { topics: "", mode: "recurring", days: ["mon", "tue", "wed", "thu", "fri"], time: "07:00", auto: true, sources: ["web"], channel: "email", notes: "", sections: "" };
  const [minute, hours, , , dayField] = report.schedule.split(" ");
  const days = dayField === "*" ? DAYS.map((d) => d.id) : expandDays(dayField ?? "*");
  return {
    topics: report.lanes.map((l) => l.topic).join("\n"),
    mode: "recurring",
    days,
    time: `${(hours ?? "7").split(",")[0]!.padStart(2, "0")}:${(minute ?? "0").padStart(2, "0")}`,
    auto: report.sources === "auto",
    sources: report.sources === "auto" ? ["web"] : report.sources,
    channel: report.channel,
    notes: report.notes,
    sections: "",
  };
}

function expandDays(field: string): string[] {
  const out = new Set<string>();
  for (const part of field.split(",")) {
    const range = part.match(/^(\d)-(\d)$/);
    if (range) for (let d = Number(range[1]); d <= Number(range[2]); d += 1) out.add(CRON_DAY_IDS[d % 7]!);
    else if (/^\d$/.test(part)) out.add(CRON_DAY_IDS[Number(part) % 7]!);
  }
  return DAYS.map((d) => d.id).filter((d) => out.has(d));
}

function ReportForm({
  initial,
  editing,
  channels,
  onCancel,
  onDone,
}: {
  initial: FormState;
  editing?: Recurring;
  channels: Record<Channel, boolean>;
  onCancel: () => void;
  onDone: (result: { recurring?: Recurring; onceTopic?: string; channel: Channel }) => void;
}) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const topics = form.topics.split("\n").map((t) => t.trim()).filter(Boolean);
  const offered = (Object.keys(CHANNEL_LABELS) as Channel[]).filter((c) => channels[c] || c === form.channel);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  const toggleSource = (id: SourceId) => {
    if (id === "web") return;
    set("sources", form.sources.includes(id) ? form.sources.filter((s) => s !== id) : [...form.sources, id]);
  };
  const toggleDay = (id: string) => set("days", form.days.includes(id) ? form.days.filter((d) => d !== id) : [...form.days, id]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    if (!topics.length) return setError("Type at least one topic.");
    if (form.mode === "once" && topics.length > 1) return setError("A one-time report has one topic. Pick Recurring to follow several topics.");
    if (form.mode === "recurring" && !form.days.length) return setError("Pick at least one day.");
    const sources = form.auto ? "auto" : form.sources;
    setSaving(true);
    try {
      if (form.mode === "once") {
        const sections = form.sections.split("\n").map((t) => t.trim()).filter(Boolean);
        await api("/reports", { method: "POST", body: JSON.stringify({ topic: topics[0], channel: form.channel, sources, notes: form.notes, sections }) });
        onDone({ onceTopic: topics[0]!, channel: form.channel });
      } else {
        const body = { topics, days: form.days, times: [form.time], sources, channel: form.channel, notes: form.notes, origin: "app" };
        const result = editing
          ? await api<{ report: Recurring }>(`/recurring/${editing.id}`, { method: "PATCH", body: JSON.stringify(body) })
          : await api<{ report: Recurring }>("/recurring", { method: "POST", body: JSON.stringify(body) });
        onDone({ recurring: result.report, channel: form.channel });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="panel form" onSubmit={submit}>
      <div className="panel-head">
        <h2>{editing ? `Change ${editing.name}` : "New report"}</h2>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>

      <label className="field">
        <span className="field-label">Topics</span>
        <textarea rows={3} value={form.topics} onChange={(e) => set("topics", e.target.value)} placeholder={"humanoid robots\ndefense robotics contracts"} />
        <span className="hint">One topic for each line. Each topic is one part of the report.</span>
      </label>

      {!editing && (
        <div className="field">
          <span className="field-label">How often</span>
          <div className="segmented" role="radiogroup">
            {(["once", "recurring"] as const).map((mode) => (
              <button type="button" key={mode} role="radio" aria-checked={form.mode === mode} className={form.mode === mode ? "on" : ""} onClick={() => set("mode", mode)}>
                {mode === "once" ? "Once" : "Recurring"}
              </button>
            ))}
          </div>
        </div>
      )}

      {form.mode === "recurring" && (
        <div className="field row">
          <div>
            <span className="field-label">Days</span>
            <div className="chips">
              {DAYS.map((d) => (
                <button type="button" key={d.id} aria-pressed={form.days.includes(d.id)} className={`chip ${form.days.includes(d.id) ? "on" : ""}`} onClick={() => toggleDay(d.id)}>
                  {d.label}
                </button>
              ))}
            </div>
          </div>
          <label>
            <span className="field-label">Time</span>
            <input type="time" value={form.time} step={60} onChange={(e) => set("time", e.target.value)} />
          </label>
        </div>
      )}

      <div className="field">
        <span className="field-label">Sources</span>
        <div className="segmented" role="radiogroup">
          <button type="button" role="radio" aria-checked={form.auto} className={form.auto ? "on" : ""} onClick={() => set("auto", true)}>
            Auto
          </button>
          <button type="button" role="radio" aria-checked={!form.auto} className={!form.auto ? "on" : ""} onClick={() => set("auto", false)}>
            Choose
          </button>
        </div>
        {form.auto ? (
          <span className="hint">Your companion picks the sources of each topic once and keeps them.</span>
        ) : (
          <div className="chips">
            {SOURCES.map((s) => (
              <button
                type="button"
                key={s.id}
                aria-pressed={form.sources.includes(s.id)}
                disabled={s.id === "web"}
                title={s.id === "web" ? "Web and news is always in" : undefined}
                className={`chip ${form.sources.includes(s.id) ? "on" : ""}`}
                onClick={() => toggleSource(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <label className="field">
        <span className="field-label">Send it by</span>
        <select value={form.channel} onChange={(e) => set("channel", e.target.value as Channel)}>
          {offered.map((c) => (
            <option key={c} value={c}>
              {CHANNEL_LABELS[c]}
            </option>
          ))}
        </select>
      </label>

      {form.mode === "recurring" ? (
        <label className="field">
          <span className="field-label">Notes</span>
          <textarea rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} placeholder="At most 8 items, one line on why each one matters." />
          <span className="hint">How each update should look, and what a topic means when its name is shared. Your companion follows these notes.</span>
        </label>
      ) : (
        <>
          <label className="field">
            <span className="field-label">Sections</span>
            <textarea rows={3} value={form.sections} onChange={(e) => set("sections", e.target.value)} placeholder={"funding\nproduct launches\ncompetitors"} />
            <span className="hint">Optional, one on each line, at most 6. The report has these sections in this order. Leave empty to let your companion choose.</span>
          </label>
          <label className="field">
            <span className="field-label">Notes</span>
            <textarea rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} placeholder="CLARA Analytics, the claims AI company. Not the Clara agent of Hippo." />
            <span className="hint">Optional. What the topic means, what it is not, and what to look at.</span>
          </label>
        </>
      )}

      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button type="submit" className="primary" disabled={saving}>
          {saving ? (editing ? "Saving" : "Creating") : editing ? "Save" : "Create"}
        </button>
      </div>
    </form>
  );
}

function SetupSummary({ report }: { report: Recurring }) {
  return (
    <div className="setup">
      <p>
        {report.scheduleText}, by {report.channelText}.{report.nextRunAt ? ` The next update comes ${formatWhen(report.nextRunAt)}.` : ""}
      </p>
      <ul className="lanes">
        {report.lanes.map((lane) => (
          <li key={lane.id}>
            <strong>{lane.topic}</strong>
            <span className="muted">{lane.sources.join(", ")}</span>
            {lane.reason && <span className="muted reason">{lane.reason}</span>}
          </li>
        ))}
      </ul>
      {report.notes && <p className="muted">Notes: {report.notes}</p>}
    </div>
  );
}

function Detail({ report, onBack, onChanged, onEdit }: { report: Recurring; onBack: () => void; onChanged: () => void; onEdit: () => void }) {
  const [updates, setUpdates] = useState<Update[] | null>(null);
  const [stories, setStories] = useState<Story[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ updates: Update[] }>(`/recurring/${report.id}/updates`).then((r) => setUpdates(r.updates), (e: Error) => setError(e.message));
    api<{ stories: Story[] }>(`/recurring/${report.id}/stories`).then((r) => setStories(r.stories), (e: Error) => setError(e.message));
  }, [report.id]);

  const act = async (action: "pause" | "resume" | "delete") => {
    if (action === "delete" && !window.confirm(`Delete "${report.name}"? It makes no more updates. The updates you got stay in your files.`)) return;
    setBusy(true);
    try {
      await api(action === "delete" ? `/recurring/${report.id}` : `/recurring/${report.id}/${action}`, { method: action === "delete" ? "DELETE" : "POST", body: action === "delete" ? undefined : "{}" });
      onChanged();
      if (action === "delete") onBack();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sent = (updates ?? []).filter((u) => u.digest);
  return (
    <div className="detail">
      <button type="button" className="ghost back" onClick={onBack}>
        ← All reports
      </button>
      <header className="detail-head">
        <div>
          <p className="eyebrow">Recurring report</p>
          <h1>{report.name}</h1>
          <div className="meta-line">
            <StateBadge report={report} />
            <span className="muted">{lastRunText(report.lastRun)}</span>
          </div>
        </div>
        <div className="actions">
          <button type="button" className="secondary" onClick={onEdit} disabled={busy}>
            Change
          </button>
          <button type="button" className="secondary" onClick={() => act(report.state === "paused" ? "resume" : "pause")} disabled={busy}>
            {report.state === "paused" ? "Resume" : "Pause"}
          </button>
          <button type="button" className="ghost danger" onClick={() => act("delete")} disabled={busy}>
            Delete
          </button>
        </div>
      </header>
      {error && <p className="error">{error}</p>}
      <SetupSummary report={report} />

      <div className="columns">
        <section className="panel">
          <h2>Report updates</h2>
          {updates === null ? (
            <p className="muted">Loading</p>
          ) : !sent.length ? (
            <p className="muted">No report update yet. The first one covers the last 7 days.</p>
          ) : (
            <ul className="updates">
              {sent.map((u) => (
                <li key={u.run}>
                  <button type="button" className="row-button" aria-expanded={open === u.run} onClick={() => setOpen(open === u.run ? null : u.run)}>
                    <span>{formatWhen(u.at)}</span>
                    <span className="muted">
                      {u.result === "failed"
                        ? "Not delivered"
                        : u.themes?.length
                          ? `${u.themes.length} ${u.themes.length === 1 ? "theme" : "themes"}`
                          : `${u.stories} ${u.stories === 1 ? "story" : "stories"}`}
                      {u.channel ? `, ${CHANNEL_LABELS[u.channel]}` : ""}
                    </span>
                  </button>
                  {open === u.run && (u.themes?.length ? <UpdateThemes update={u} /> : <pre className="digest">{u.digest}</pre>)}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="panel">
          <h2>Stories</h2>
          {stories === null ? (
            <p className="muted">Loading</p>
          ) : !stories.length ? (
            <p className="muted">No stories yet.</p>
          ) : (
            <ul className="stories">
              {stories.map((s) => (
                <li key={s.id}>
                  <div className="story-head">
                    <StatusBadge status={s.status} />
                    {s.link ? (
                      <a href={s.link} target="_blank" rel="noreferrer">
                        {s.title}
                      </a>
                    ) : (
                      <span>{s.title}</span>
                    )}
                  </div>
                  <span className="muted">
                    {s.lane} · {s.items} {s.items === 1 ? "page or post" : "pages and posts"} · {s.sources.join(", ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function App() {
  const [recurring, setRecurring] = useState<Recurring[] | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [channels, setChannels] = useState<Record<Channel, boolean>>({ email: true, sms: false, slack: false, telegram: false });
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<{ editing?: Recurring } | null>(null);
  const [notice, setNotice] = useState<{ text: string; report?: Recurring } | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [r, p] = await Promise.all([api<{ reports: Recurring[] }>("/recurring"), api<{ reports: Report[] }>("/reports?all=1")]);
      setRecurring(r.reports);
      setReports(p.reports);
      setError("");
    } catch (err) {
      setError((err as Error).message);
      setRecurring((cur) => cur ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
    api<{ channels: Record<Channel, boolean> }>("/channels").then((r) => setChannels(r.channels), () => undefined);
  }, [load]);

  const current = useMemo(() => recurring?.find((r) => r.id === selected), [recurring, selected]);
  const empty = recurring !== null && !recurring.length && !reports.length;

  const formView = form && (
    <ReportForm
      initial={formFrom(form.editing)}
      editing={form.editing}
      channels={channels}
      onCancel={() => setForm(null)}
      onDone={({ recurring: saved, onceTopic, channel }) => {
        setForm(null);
        setNotice(
          saved
            ? { text: form.editing ? `Saved ${saved.name}.` : `Created ${saved.name}.`, report: saved }
            : { text: `Your report on "${onceTopic}" is on its way. It takes a few minutes, and it comes by ${CHANNEL_LABELS[channel].toLowerCase()}.` },
        );
        void load();
      }}
    />
  );

  if (current && !form) {
    return (
      <main className="shell">
        <Detail report={current} onBack={() => setSelected(null)} onChanged={() => void load()} onEdit={() => setForm({ editing: current })} />
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="top">
        <div>
          <p className="eyebrow">Joshu</p>
          <h1>Research</h1>
          <p className="muted">Reports your companion made, and the topics it follows for you.</p>
        </div>
        {!form && (
          <button type="button" className="primary" onClick={() => (setNotice(null), setForm({}))}>
            New report
          </button>
        )}
      </header>

      {error && <p className="error">{error}</p>}
      {formView}
      {notice && !form && (
        <div className="panel notice">
          <p>{notice.text}</p>
          {notice.report && <SetupSummary report={notice.report} />}
        </div>
      )}

      {recurring === null ? (
        <p className="muted">Loading</p>
      ) : empty && !form ? (
        <div className="panel empty">
          <h2>No reports yet</h2>
          <p className="muted">Ask your companion to research a topic, or to send you what's new in a topic every week. Or start one here.</p>
          <button type="button" className="primary" onClick={() => setForm({})}>
            New report
          </button>
        </div>
      ) : (
        !form && (
          <>
            {recurring.length > 0 && (
              <section className="group">
                <h2>Recurring reports</h2>
                <ul className="list">
                  {recurring.map((r) => (
                    <li key={r.id}>
                      <button type="button" className="row-button card" onClick={() => setSelected(r.id)}>
                        <div className="card-main">
                          <strong>{r.name}</strong>
                          <span className="muted">{r.lanes.map((l) => l.topic).join(" · ")}</span>
                        </div>
                        <div className="card-side">
                          <StateBadge report={r} />
                          <span className="muted">{r.scheduleText}</span>
                          <span className="muted">{lastRunText(r.lastRun)}</span>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {reports.length > 0 && (
              <section className="group">
                <h2>Research reports</h2>
                <ul className="list">
                  {reports.map((p) => (
                    <li key={p.id}>
                      <a className="row-button card" href={p.reportLink} target="_blank" rel="noreferrer">
                        <div className="card-main">
                          <strong>{p.topic}</strong>
                          <span className="muted summary">{p.summary}</span>
                        </div>
                        <div className="card-side">
                          <span className="muted">{formatDay(p.requestedAt)}</span>
                          <span className="open">Open PDF</span>
                        </div>
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
