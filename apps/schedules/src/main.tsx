import "@joshu/design-system/typography.css";
import "@joshu/design-system/tokens.css";
import "@joshu/design-system/base.css";
import "./styles.css";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

type CronStatus = {
  gateway_running: boolean;
  gateway_pids?: number[];
  job_count?: number;
  active_job_count?: number;
  next_run_at?: string | null;
};

type CronJobSummary = {
  job_id: string;
  name: string;
  schedule: string;
  repeat?: string;
  deliver?: string | string[];
  next_run_at?: string | null;
  last_run_at?: string | null;
  last_status?: string | null;
  last_delivery_error?: string | null;
  enabled?: boolean;
  state?: string;
  prompt_preview?: string;
  skills?: string[];
  script?: string;
  no_agent?: boolean;
};

type CronJobDetail = CronJobSummary & {
  prompt?: string;
  last_error?: string | null;
};

type JobFormState = {
  name: string;
  schedule: string;
  prompt: string;
  deliver: string;
  skills: string;
  noAgent: boolean;
  script: string;
};

const API_BASE = (import.meta.env.VITE_SCHEDULES_API_BASE || "/joshu/api/cron").replace(/\/+$/, "");

const EMPTY_FORM: JobFormState = {
  name: "",
  schedule: "0 9 * * 1-5",
  prompt: "",
  deliver: "local",
  skills: "",
  noAgent: false,
  script: "",
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `Request failed (${response.status})`);
  }
  return body;
}

function formatWhen(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function deliverLabel(value?: string | string[]): string {
  if (Array.isArray(value)) return value.join(", ");
  return value || "local";
}

function stateClass(state?: string): string {
  if (state === "paused") return "paused";
  if (state === "completed") return "completed";
  return "active";
}

function JobEditorModal({
  title,
  initial,
  onClose,
  onSave,
  saving,
}: {
  title: string;
  initial: JobFormState;
  onClose: () => void;
  onSave: (form: JobFormState) => Promise<void>;
  saving: boolean;
}) {
  const [form, setForm] = useState(initial);

  useEffect(() => {
    setForm(initial);
  }, [initial]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <h2>{title}</h2>
        <p className="subtitle" style={{ marginTop: "0.5rem" }}>
          Uses the same Hermes scheduler as chat and CLI. Changes appear in{" "}
          <code>~/.hermes/cron/jobs.json</code> immediately.
        </p>
        <form
          className="form-grid"
          style={{ marginTop: "1rem" }}
          onSubmit={(event) => {
            event.preventDefault();
            void onSave(form);
          }}
        >
          <label>
            Name
            <input
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="Morning brief"
            />
          </label>
          <label>
            Schedule
            <input
              value={form.schedule}
              onChange={(event) => setForm((prev) => ({ ...prev, schedule: event.target.value }))}
              placeholder="every 2h or 0 9 * * 1-5"
              required
            />
            <span className="hint">
              Examples: <code>every 30m</code>, <code>every 2h</code>, <code>0 9 * * 1-5</code> (weekdays 9am)
            </span>
          </label>
          <label>
            Delivery
            <select
              value={form.deliver}
              onChange={(event) => setForm((prev) => ({ ...prev, deliver: event.target.value }))}
            >
              <option value="local">Local only (save output)</option>
              <option value="origin">Origin (where job was created)</option>
            </select>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={form.noAgent}
              onChange={(event) => setForm((prev) => ({ ...prev, noAgent: event.target.checked }))}
            />
            Script-only (no LLM) — requires script path below
          </label>
          {!form.noAgent ? (
            <>
              <label>
                Prompt / task
                <textarea
                  value={form.prompt}
                  onChange={(event) => setForm((prev) => ({ ...prev, prompt: event.target.value }))}
                  placeholder="Executive assistant morning window. Use ea-playbook…"
                />
              </label>
              <label>
                Skills (comma-separated)
                <input
                  value={form.skills}
                  onChange={(event) => setForm((prev) => ({ ...prev, skills: event.target.value }))}
                  placeholder="ea-playbook"
                />
              </label>
            </>
          ) : (
            <label>
              Script (under ~/.hermes/scripts/)
              <input
                value={form.script}
                onChange={(event) => setForm((prev) => ({ ...prev, script: event.target.value }))}
                placeholder="watchdog.sh"
                required
              />
            </label>
          )}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function App() {
  const [status, setStatus] = useState<CronStatus | null>(null);
  const [jobs, setJobs] = useState<CronJobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<"create" | "edit" | null>(null);
  const [editorJobId, setEditorJobId] = useState<string | null>(null);
  const [editorInitial, setEditorInitial] = useState<JobFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statusBody, jobsBody] = await Promise.all([
        fetchJson<CronStatus & { success?: boolean }>(`${API_BASE}/status`),
        fetchJson<{ jobs?: CronJobSummary[] }>(`${API_BASE}/jobs?includeDisabled=true`),
      ]);
      setStatus(statusBody);
      setJobs(jobsBody.jobs ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sortedJobs = useMemo(
    () =>
      [...jobs].sort((a, b) => {
        const an = (a.name || a.job_id).toLowerCase();
        const bn = (b.name || b.job_id).toLowerCase();
        return an.localeCompare(bn);
      }),
    [jobs],
  );

  async function runJobAction(jobId: string, action: "pause" | "resume" | "run" | "delete") {
    setActionError(null);
    setBusyJobId(jobId);
    try {
      if (action === "delete") {
        if (!window.confirm("Remove this scheduled job? This cannot be undone.")) return;
        await fetchJson(`${API_BASE}/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
      } else {
        await fetchJson(`${API_BASE}/jobs/${encodeURIComponent(jobId)}/${action}`, { method: "POST" });
      }
      await refresh();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusyJobId(null);
    }
  }

  function openCreate() {
    setEditorMode("create");
    setEditorJobId(null);
    setEditorInitial({ ...EMPTY_FORM });
  }

  async function openEdit(jobId: string) {
    setActionError(null);
    setBusyJobId(jobId);
    try {
      const body = await fetchJson<{ job: CronJobDetail }>(`${API_BASE}/jobs/${encodeURIComponent(jobId)}`);
      const job = body.job;
      setEditorMode("edit");
      setEditorJobId(jobId);
      setEditorInitial({
        name: job.name || "",
        schedule: job.schedule || "",
        prompt: job.prompt || job.prompt_preview || "",
        deliver: deliverLabel(job.deliver),
        skills: (job.skills ?? []).join(", "),
        noAgent: Boolean(job.no_agent),
        script: job.script || "",
      });
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusyJobId(null);
    }
  }

  async function saveEditor(form: JobFormState) {
    setSaving(true);
    setActionError(null);
    try {
      const skills = form.skills
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
      const payload = {
        name: form.name.trim() || undefined,
        schedule: form.schedule.trim(),
        deliver: form.deliver,
        prompt: form.noAgent ? undefined : form.prompt,
        skills: form.noAgent ? undefined : skills,
        noAgent: form.noAgent,
        script: form.noAgent ? form.script.trim() : undefined,
      };

      if (editorMode === "create") {
        await fetchJson(`${API_BASE}/jobs`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
      } else if (editorMode === "edit" && editorJobId) {
        await fetchJson(`${API_BASE}/jobs/${encodeURIComponent(editorJobId)}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      }
      setEditorMode(null);
      setEditorJobId(null);
      await refresh();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Hermes scheduler</p>
          <h1>Schedules</h1>
          <p className="subtitle">
            Manage recurring Hermes tasks. Jobs created here share storage with chat, CLI, and the agent cron tool.
          </p>
        </div>
        <div className="status-row">
          <span className={`status-pill ${status?.gateway_running ? "ok" : "warn"}`}>
            {status?.gateway_running ? "Gateway running" : "Gateway stopped"}
          </span>
          {status?.active_job_count !== undefined ? (
            <span className="status-pill muted">{status.active_job_count} active</span>
          ) : null}
          {status?.next_run_at ? (
            <span className="status-pill muted">Next: {formatWhen(status.next_run_at)}</span>
          ) : null}
        </div>
      </header>

      {error ? <div className="error-box">{error}</div> : null}
      {actionError ? <div className="error-box">{actionError}</div> : null}

      <div className="toolbar">
        <button type="button" className="btn primary" onClick={openCreate}>
          New schedule
        </button>
        <button type="button" className="btn" onClick={() => void refresh()} disabled={loading}>
          Refresh
        </button>
      </div>

      {loading && jobs.length === 0 ? (
        <div className="empty-state">Loading schedules…</div>
      ) : sortedJobs.length === 0 ? (
        <div className="empty-state">
          <p>No scheduled jobs yet.</p>
          <p>Create one here, or ask Hermes in chat with <code>/cron add …</code>.</p>
        </div>
      ) : (
        <div className="job-list">
          {sortedJobs.map((job) => {
            const paused = job.state === "paused" || job.enabled === false;
            const busy = busyJobId === job.job_id;
            return (
              <article key={job.job_id} className="job-card">
                <div className="job-card-header">
                  <div>
                    <div className="job-title">{job.name || job.job_id}</div>
                    <div className="job-id">{job.job_id}</div>
                  </div>
                  <span className={`state-badge ${stateClass(job.state)}`}>{job.state || "scheduled"}</span>
                </div>

                <div className="job-meta">
                  <div>
                    <span className="meta-label">Schedule</span>
                    {job.schedule}
                  </div>
                  <div>
                    <span className="meta-label">Next run</span>
                    {formatWhen(job.next_run_at)}
                  </div>
                  <div>
                    <span className="meta-label">Last run</span>
                    {formatWhen(job.last_run_at)}
                    {job.last_status ? ` (${job.last_status})` : ""}
                  </div>
                  <div>
                    <span className="meta-label">Delivery</span>
                    {deliverLabel(job.deliver)}
                  </div>
                </div>

                {(job.skills?.length ?? 0) > 0 ? (
                  <div style={{ marginTop: "0.65rem" }}>
                    {job.skills!.map((skill) => (
                      <span key={skill} className="skills-tag">
                        {skill}
                      </span>
                    ))}
                  </div>
                ) : null}

                {job.script ? (
                  <div className="prompt-preview">
                    Script: <code>{job.script}</code>
                    {job.no_agent ? " (no-agent)" : ""}
                  </div>
                ) : job.prompt_preview ? (
                  <div className="prompt-preview">{job.prompt_preview}</div>
                ) : null}

                {job.last_delivery_error ? (
                  <div className="error-box" style={{ marginTop: "0.65rem", textAlign: "left" }}>
                    Delivery error: {job.last_delivery_error}
                  </div>
                ) : null}

                <div className="job-actions">
                  <button type="button" className="btn small" disabled={busy} onClick={() => void openEdit(job.job_id)}>
                    Edit
                  </button>
                  {paused ? (
                    <button
                      type="button"
                      className="btn small"
                      disabled={busy}
                      onClick={() => void runJobAction(job.job_id, "resume")}
                    >
                      Resume
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn small"
                      disabled={busy}
                      onClick={() => void runJobAction(job.job_id, "pause")}
                    >
                      Pause
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn small"
                    disabled={busy}
                    onClick={() => void runJobAction(job.job_id, "run")}
                  >
                    Run next tick
                  </button>
                  <button
                    type="button"
                    className="btn small danger"
                    disabled={busy}
                    onClick={() => void runJobAction(job.job_id, "delete")}
                  >
                    Delete
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {editorMode ? (
        <JobEditorModal
          title={editorMode === "create" ? "New schedule" : "Edit schedule"}
          initial={editorInitial}
          onClose={() => {
            if (!saving) {
              setEditorMode(null);
              setEditorJobId(null);
            }
          }}
          onSave={saveEditor}
          saving={saving}
        />
      ) : null}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
