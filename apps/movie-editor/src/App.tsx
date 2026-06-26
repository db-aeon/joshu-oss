import { useCallback, useEffect, useState } from "react";

import { MOVIE_EDITOR_API_BASE } from "@/lib/config";
import { VideoEditorClient } from "@/editor/video-editor.client";

type ProjectMeta = {
  id: string;
  title: string;
  type: string;
  updatedAt: string;
};

export function App() {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [selectedId, setSelectedId] = useState("default");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${MOVIE_EDITOR_API_BASE}/projects`);
      const data = (await res.json()) as { projects?: ProjectMeta[]; error?: string };
      if (!res.ok) throw new Error(data.error || `Failed to load projects (${res.status})`);
      const list = data.projects ?? [];
      setProjects(list);
      if (list.length > 0 && !list.some((p) => p.id === selectedId)) {
        setSelectedId(list[0].id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const createProject = async () => {
    const res = await fetch(`${MOVIE_EDITOR_API_BASE}/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New project" }),
    });
    const data = (await res.json()) as { project?: ProjectMeta; error?: string };
    if (!res.ok) throw new Error(data.error || "Failed to create project");
    if (data.project) {
      setSelectedId(data.project.id);
      await loadProjects();
    }
  };

  if (loading && projects.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading jMovie…
      </div>
    );
  }

  if (error && projects.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <p className="text-xs text-muted-foreground">
          Ensure Joshu is running on port 8788 and{" "}
          <code className="rounded bg-muted px-1">VITE_CREATOMATE_PUBLIC_TOKEN</code> is set for builds.
        </p>
        <button
          type="button"
          className="rounded-md border px-3 py-1 text-xs"
          onClick={() => void loadProjects()}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border/40 bg-muted/20 px-2">
        <span className="text-[11px] font-bold tracking-tight text-foreground/80">jMovie</span>
        <select
          className="h-7 max-w-[200px] flex-1 rounded border border-border/40 bg-background px-2 text-[11px]"
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="rounded border border-border/40 px-2 py-0.5 text-[10px] font-medium hover:bg-muted/50"
          onClick={() => void createProject().catch((e) => setError(String(e)))}
        >
          New
        </button>
      </header>
      <div className="min-h-0 flex-1">
        <VideoEditorClient
          key={selectedId}
          projectId={selectedId}
          showExitButton={false}
          shortcutsEnabled
        />
      </div>
    </div>
  );
}
