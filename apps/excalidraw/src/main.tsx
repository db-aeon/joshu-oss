import "@joshu/design-system/typography.css";
import "@joshu/design-system/tokens.css";
import "@joshu/design-system/base.css";
import "./styles.css";

import { Excalidraw, serializeAsJSON } from "@excalidraw/excalidraw";
import type { BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  isMarkdownFile,
  isMarkdownPath,
  openMarkdownFile,
  readMarkdownFile,
} from "./markdown/file";
import { loadMarkdownDocument } from "./markdown/loadMarkdownDocument";

const STORAGE_KEY = "joshu:excalidraw:scene";

type FilesContext = {
  filesRoot: string;
  desktopRoot: string;
  linkScheme: string;
  joshuFilesDirName?: string;
  arozPathPrefix?: string;
};

type ArozDesktopWindow = Window & {
  newFloatWindow?: (config: {
    url: string;
    width?: number;
    height?: number;
    appicon?: string;
    title?: string;
    parent?: string;
  }) => void;
};

type ExcalidrawFile = {
  type?: string;
  elements?: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
};

/** ArozOS desktop open hash entry — same shape as ao_module_loadInputFiles(). */
type ArozOpenFile = {
  filepath: string;
  filename: string;
};

/** Joshu files API — local ArozOS :8787 crosses to :8788; VPS/Caddy serves /joshu on same origin. */
function resolveFilesApiBase(): string {
  const fromEnv = import.meta.env.VITE_JOSHU_FILES_API_BASE?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");

  const { hostname, protocol, port } = window.location;
  const filesPath = "/joshu/api/files";

  if (port === "8788") {
    return filesPath;
  }

  // Local dev: excalidraw subservice on ArozOS :8787, Joshu API on :8788.
  if (port === "8787") {
    return `${protocol}//${hostname}:8788${filesPath}`;
  }

  // HTTPS / reverse proxy (e.g. patrick.box.joshu.me) — Joshu at /joshu/*, not :8788.
  return filesPath;
}

const FILES_API = resolveFilesApiBase();

function loadInitialData(): unknown | null {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (error) {
    console.warn("[joshu-excalidraw] failed to parse saved scene", error);
    return null;
  }
}

function todayPlanRelativePath(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `Planning/time-block-${y}-${m}-${day}.excalidraw`;
}

function filesDirName(ctx: FilesContext | null): string {
  return ctx?.joshuFilesDirName ?? "joshu's files";
}

function relativeFromArozFilepath(filepath: string, dirName: string): string | null {
  const decoded = decodeURIComponent(filepath);
  const prefix = `user:/Desktop/${dirName}/`;
  if (decoded.startsWith(prefix)) return decoded.slice(prefix.length);
  // Avoid matching `joshu's files/` inside ArozOS JSON open hashes ([{filepath,...}]).
  if (decoded.startsWith("[") || decoded.startsWith("{")) return null;
  const marker = `/${dirName}/`;
  const idx = decoded.indexOf(marker);
  if (idx >= 0) return decoded.slice(idx + marker.length);
  // Generic ArozOS user desktop path when dir name is unknown or mismatched.
  const desktopMatch = decoded.match(/^user:\/Desktop\/[^/]+\/(.+)$/);
  if (desktopMatch) return desktopMatch[1];
  return null;
}

function tryDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** ArozOS /media returns HTTP 200 with {"error":"…"} when unauthenticated or denied. */
function mediaResponseError(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown };
    return typeof parsed.error === "string" && parsed.error.length > 0 ? parsed.error : null;
  } catch {
    return null;
  }
}

/** Parse ArozOS #[{filepath, filename}] — mirrors ao_module_loadInputFiles(). */
function loadArozInputFiles(): ArozOpenFile[] | null {
  try {
    if (window.location.hash.length === 0) return null;
    const inputFileInfo = window.location.hash.substring(1);
    const parsed = JSON.parse(decodeURIComponent(inputFileInfo)) as Array<Partial<ArozOpenFile>>;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const files = parsed.filter(
      (entry): entry is ArozOpenFile =>
        typeof entry.filepath === "string" && typeof entry.filename === "string",
    );
    return files.length > 0 ? files : null;
  } catch {
    return null;
  }
}

/** True when the URL hash indicates ArozOS opened a specific file in this window. */
function hasFileOpenHash(): boolean {
  if (loadArozInputFiles()) return true;

  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return false;
  if (hash.startsWith("file=")) return true;

  const candidates = [hash, tryDecodeURIComponent(hash), tryDecodeURIComponent(tryDecodeURIComponent(hash) ?? "")].filter(
    (value): value is string => Boolean(value),
  );
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Array<{ filepath?: string }>;
      if (Array.isArray(parsed) && parsed[0]?.filepath) return true;
    } catch {
      /* try next candidate */
    }
  }

  return hash.includes("filepath") && hash.includes("user:/");
}

/** Walk up iframes to the ArozOS desktop (newFloatWindow). */
function getArozDesktop(): ArozDesktopWindow | null {
  let w: Window | null = window;
  for (let depth = 0; depth < 8 && w; depth += 1) {
    const candidate = w as ArozDesktopWindow;
    if (typeof candidate.newFloatWindow === "function") return candidate;
    if (!w.parent || w.parent === w) break;
    w = w.parent;
  }
  return null;
}

/** ?file=, #file=, or ArozOS desktop open hash [{filepath, filename}]. */
function parseRequestedFilePath(ctx: FilesContext | null): string | null {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("file") ?? params.get("path");
  if (fromQuery) return decodeURIComponent(fromQuery);

  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return null;
  if (hash.startsWith("file=")) return decodeURIComponent(hash.slice("file=".length));

  const hashParams = new URLSearchParams(hash);
  const fromHashParams = hashParams.get("file") ?? hashParams.get("path");
  if (fromHashParams) return decodeURIComponent(fromHashParams);

  // ArozOS Files double-click: #[{filepath, filename}] — parse before marker scan on raw hash.
  const hashCandidates = [hash, tryDecodeURIComponent(hash), tryDecodeURIComponent(tryDecodeURIComponent(hash) ?? "")].filter(
    (value): value is string => Boolean(value),
  );
  for (const candidate of hashCandidates) {
    try {
      const parsed = JSON.parse(candidate) as Array<{ filepath?: string }>;
      if (Array.isArray(parsed) && parsed[0]?.filepath) {
        return relativeFromArozFilepath(parsed[0].filepath, filesDirName(ctx));
      }
    } catch {
      /* try next candidate */
    }
  }

  const fromAroz = relativeFromArozFilepath(hash, filesDirName(ctx));
  if (fromAroz) return fromAroz;

  return null;
}

function joshuLinkToRelative(link: string): string | null {
  if (link.startsWith("joshu://")) return decodeURIComponent(link.slice("joshu://".length));
  return null;
}

function openFileInArozDesktop(relativePath: string, ctx: FilesContext | null): boolean {
  const desktop = getArozDesktop();
  if (!desktop?.newFloatWindow) return false;

  const clean = relativePath.replace(/^\/+/, "");
  const filename = clean.split("/").pop() ?? clean;
  const ext = filename.includes(".") ? filename.split(".").pop()?.toLowerCase() : "";
  const dirName = filesDirName(ctx);
  const filepath = `${ctx?.arozPathPrefix ?? `user:/Desktop/${dirName}`}/${clean}`;
  const openParam = encodeURIComponent(JSON.stringify([{ filepath, filename }]));

  if (ext === "excalidraw" || ext === "md") {
    desktop.newFloatWindow({
      url: `excalidraw/index.html#${openParam}`,
      width: 1280,
      height: 860,
      appicon: "img/joshu/whiteboard.png",
      title: ext === "md" ? `jWhiteboard — ${filename}` : "jWhiteboard",
    });
    return true;
  }

  desktop.newFloatWindow({
    url: `MDEditor/mde.html#${openParam}`,
    width: 1080,
    height: 580,
    appicon: "MDEditor/img/notebook.png",
    title: `MDEditor — ${filename}`,
  });
  return true;
}

function openJoshuTarget(relativePath: string, ctx: FilesContext | null): void {
  if (openFileInArozDesktop(relativePath, ctx)) return;

  const clean = relativePath.replace(/^\/+/, "");
  console.warn("[joshu-excalidraw] ArozOS desktop not found; cannot open", clean);
}

function downloadFile(contents: string, filename: string): void {
  const blob = new Blob([contents], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

type SceneUpdate = Parameters<ExcalidrawImperativeAPI["updateScene"]>[0];

function sceneFromExcalidrawJson(text: string): SceneUpdate {
  const data = JSON.parse(text) as ExcalidrawFile;
  return {
    elements: (Array.isArray(data.elements) ? data.elements : []) as readonly ExcalidrawElement[],
    appState: {
      viewBackgroundColor: "#ffffff",
      ...(data.appState ?? {}),
    },
    files: (data.files ?? {}) as BinaryFiles,
  } as unknown as SceneUpdate;
}

/** Wait until Excalidraw has measured the viewport before placing markdown. */
async function waitForExcalidrawLayout(api: ExcalidrawImperativeAPI): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const { width, height } = api.getAppState();
    if (typeof width === "number" && width > 0 && typeof height === "number" && height > 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
}

function App() {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const bootReadyRef = useRef(false);
  const filesCtxRef = useRef<FilesContext | null>(null);
  const startupLoadKeyRef = useRef<string | null>(null);
  const attemptStartupLoadRef = useRef<(() => Promise<void>) | undefined>(undefined);

  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [filesCtx, setFilesCtx] = useState<FilesContext | null>(null);
  const [loadedFile, setLoadedFile] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [pendingArozFile, setPendingArozFile] = useState<ArozOpenFile | null>(
    () => loadArozInputFiles()?.[0] ?? null,
  );
  const fileOpenIntent = useMemo(
    () => pendingArozFile !== null || hasFileOpenHash(),
    [pendingArozFile],
  );
  const [pendingFile, setPendingFile] = useState<string | null>(() =>
    pendingArozFile ? null : parseRequestedFilePath(null),
  );
  const [bootReady, setBootReady] = useState(false);

  // Always mount an empty canvas; load files via updateScene once the API is ready.
  const initialData = null;

  useEffect(() => {
    const syncHashOpen = () => {
      const fromHash = loadArozInputFiles()?.[0] ?? null;
      if (!fromHash) return;
      setPendingArozFile(fromHash);
      startupLoadKeyRef.current = null;
      void attemptStartupLoadRef.current?.();
    };

    window.addEventListener("hashchange", syncHashOpen);
    requestAnimationFrame(syncHashOpen);
    return () => window.removeEventListener("hashchange", syncHashOpen);
  }, []);

  useEffect(() => {
    fetch(`${FILES_API}/context`)
      .then((r) => {
        if (!r.ok) {
          throw new Error(`files/context HTTP ${r.status}`);
        }
        return r.json();
      })
      .then((data) => {
        if (data?.filesRoot) {
          const ctx = data as FilesContext;
          filesCtxRef.current = ctx;
          setFilesCtx(ctx);
          const fromHash = parseRequestedFilePath(ctx);
          if (fromHash) setPendingFile(fromHash);
        }
      })
      .catch((error) => {
        console.warn("[joshu-excalidraw] files/context unavailable", error);
        if ((fileOpenIntent || pendingFile) && !pendingArozFile) {
          setLoadError("Could not reach Joshu files API. Is Joshu running on port 8788?");
        }
      })
      .finally(() => {
        bootReadyRef.current = true;
        setBootReady(true);
        void attemptStartupLoadRef.current?.();
      });
  }, [fileOpenIntent, pendingArozFile, pendingFile]);

  const applyScene = useCallback((apiInstance: ExcalidrawImperativeAPI, scene: SceneUpdate) => {
    apiInstance.updateScene(scene);
    apiInstance.scrollToContent(scene.elements ?? [], { fitToContent: true });
  }, []);

  const loadMarkdownFromJoshu = useCallback(
    async (apiInstance: ExcalidrawImperativeAPI, relativePath: string) => {
      setLoadError(null);
      try {
        const res = await fetch(`${FILES_API}/read?path=${encodeURIComponent(relativePath)}`);
        if (!res.ok) {
          setLoadError(`Could not load ${relativePath} (${res.status})`);
          return false;
        }
        const markdown = await res.text();
        const name = relativePath.split("/").pop() ?? "Untitled.md";
        await waitForExcalidrawLayout(apiInstance);
        loadMarkdownDocument(apiInstance, { name, markdown, fileHandle: null }, { replace: true });
        setLoadedFile(relativePath);
        return true;
      } catch (error) {
        console.error("[joshu-excalidraw] failed to load markdown", relativePath, error);
        setLoadError(`Failed to load ${relativePath}`);
        return false;
      }
    },
    [],
  );

  const loadFileFromJoshu = useCallback(
    async (apiInstance: ExcalidrawImperativeAPI, relativePath: string) => {
      if (isMarkdownPath(relativePath)) {
        return loadMarkdownFromJoshu(apiInstance, relativePath);
      }
      setLoadError(null);
      try {
        const res = await fetch(`${FILES_API}/read?path=${encodeURIComponent(relativePath)}`);
        if (!res.ok) {
          setLoadError(`Could not load ${relativePath} (${res.status})`);
          return false;
        }
        const text = await res.text();
        const scene = sceneFromExcalidrawJson(text);
        if (!scene.elements?.length) {
          setLoadError(`File loaded but has no elements: ${relativePath}`);
          return false;
        }
        applyScene(apiInstance, scene);
        setLoadedFile(relativePath);
        return true;
      } catch (error) {
        console.error("[joshu-excalidraw] failed to load file", relativePath, error);
        setLoadError(`Failed to load ${relativePath}`);
        return false;
      }
    },
    [applyScene, loadMarkdownFromJoshu],
  );

  /** Load via ArozOS /media — same path MDEditor uses for double-click opens. */
  const loadFileFromArozMedia = useCallback(
    async (apiInstance: ExcalidrawImperativeAPI, arozFile: ArozOpenFile) => {
      setLoadError(null);
      setLoadingFile(true);
      try {
        const url = `/media?file=${encodeURIComponent(arozFile.filepath)}&_=${Date.now()}`;
        const res = await fetch(url, { credentials: "same-origin" });
        if (!res.ok) {
          setLoadError(`Could not load ${arozFile.filename} (HTTP ${res.status})`);
          return false;
        }
        const text = await res.text();
        const mediaError = mediaResponseError(text);
        if (mediaError) {
          setLoadError(`Could not load ${arozFile.filename}: ${mediaError}`);
          return false;
        }
        await waitForExcalidrawLayout(apiInstance);

        const label = arozFile.filename || arozFile.filepath;
        if (isMarkdownPath(label)) {
          loadMarkdownDocument(
            apiInstance,
            { name: arozFile.filename, markdown: text, fileHandle: null },
            { replace: true },
          );
        } else {
          const scene = sceneFromExcalidrawJson(text);
          if (!scene.elements?.length) {
            setLoadError(`File loaded but has no elements: ${label}`);
            return false;
          }
          applyScene(apiInstance, scene);
        }
        setLoadedFile(label);
        return true;
      } catch (error) {
        console.error("[joshu-excalidraw] failed to load from ArozOS media", arozFile, error);
        setLoadError(`Failed to load ${arozFile.filename}`);
        return false;
      } finally {
        setLoadingFile(false);
      }
    },
    [applyScene],
  );

  const attemptStartupLoad = useCallback(async () => {
    const apiInstance = apiRef.current;
    if (!apiInstance) return;

    const arozFile = pendingArozFile ?? loadArozInputFiles()?.[0] ?? null;
    if (arozFile) {
      const loadKey = `aroz:${arozFile.filepath}`;
      if (startupLoadKeyRef.current === loadKey) return;
      startupLoadKeyRef.current = loadKey;
      await loadFileFromArozMedia(apiInstance, arozFile);
      return;
    }

    if (!bootReadyRef.current) return;

    const ctx = filesCtxRef.current;
    const requestedPath = pendingFile ?? parseRequestedFilePath(ctx);
    if (requestedPath) {
      const loadKey = `joshu:${requestedPath}`;
      if (startupLoadKeyRef.current === loadKey) return;
      startupLoadKeyRef.current = loadKey;
      await loadFileFromJoshu(apiInstance, requestedPath);
      return;
    }

    if (fileOpenIntent || hasFileOpenHash()) {
      setLoadError("Could not open the requested file from ArozOS (missing or invalid URL hash).");
      return;
    }

    const today = todayPlanRelativePath();
    const loadKey = `today:${today}`;
    if (startupLoadKeyRef.current === loadKey) return;
    startupLoadKeyRef.current = loadKey;

    const loaded = await loadFileFromJoshu(apiInstance, today);
    if (!loaded) {
      const saved = loadInitialData() as ExcalidrawFile | null;
      if (saved && Array.isArray(saved.elements) && saved.elements.length > 0) {
        applyScene(apiInstance, sceneFromExcalidrawJson(JSON.stringify(saved)));
        setLoadError(null);
      } else {
        setLoadError(`No diagram yet. Ask jChat to build today's time block, or Import a .excalidraw file.`);
      }
    }
  }, [pendingArozFile, pendingFile, fileOpenIntent, loadFileFromArozMedia, loadFileFromJoshu, applyScene]);

  attemptStartupLoadRef.current = attemptStartupLoad;

  useEffect(() => {
    void attemptStartupLoad();
  }, [attemptStartupLoad, bootReady, pendingArozFile, pendingFile]);

  const handleExcalidrawApi = useCallback(
    (nextApi: ExcalidrawImperativeAPI | null) => {
      if (!nextApi) return;
      apiRef.current = nextApi;
      setApi(nextApi);
      void attemptStartupLoad();
    },
    [attemptStartupLoad],
  );

  const saveScene = useCallback(() => {
    if (!api) return;

    const scene = serializeAsJSON(
      api.getSceneElements(),
      api.getAppState(),
      api.getFiles(),
      "local",
    );
    window.localStorage.setItem(STORAGE_KEY, scene);
  }, [api]);

  const exportScene = useCallback(() => {
    if (!api) return;

    const scene = serializeAsJSON(
      api.getSceneElements(),
      api.getAppState(),
      api.getFiles(),
      "local",
    );
    const name = loadedFile?.split("/").pop() ?? "joshu-drawing.excalidraw";
    downloadFile(scene, name);
  }, [api, loadedFile]);

  const handleOpenMarkdownFile = useCallback(async () => {
    if (!api) return;
    try {
      const file = await openMarkdownFile();
      if (file) {
        loadMarkdownDocument(api, file);
        setLoadedFile(file.name);
        setLoadError(null);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to open markdown file";
      if ((error as { name?: string })?.name !== "AbortError") {
        setLoadError(message);
      }
    }
  }, [api]);

  const handleMarkdownDropCapture = useCallback(
    async (event: React.DragEvent<HTMLElement>) => {
      const file = Array.from(event.dataTransfer.files).find(isMarkdownFile);
      if (!file || !api) return;

      event.preventDefault();
      event.stopPropagation();

      try {
        const markdownFile = await readMarkdownFile(file);
        loadMarkdownDocument(api, markdownFile);
        setLoadedFile(markdownFile.name);
        setLoadError(null);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to import markdown file";
        setLoadError(message);
      }
    },
    [api],
  );

  const handleMarkdownDragOverCapture = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (Array.from(event.dataTransfer.items).some((item) => item.kind === "file")) {
      event.preventDefault();
    }
  }, []);

  const importScene = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file || !api) return;

      try {
        if (isMarkdownFile(file)) {
          const markdownFile = await readMarkdownFile(file);
          loadMarkdownDocument(api, markdownFile);
          setLoadedFile(markdownFile.name);
          setLoadError(null);
          return;
        }

        const text = await file.text();
        const scene = sceneFromExcalidrawJson(text);
        applyScene(api, scene);
        window.localStorage.setItem(STORAGE_KEY, text);
        setLoadedFile(file.name);
        setLoadError(null);
      } catch (error) {
        console.error("[joshu-excalidraw] failed to import scene", error);
        setLoadError("Import failed — invalid .excalidraw file");
      }
    },
    [api, applyScene],
  );

  const openTodayPlan = useCallback(() => {
    const apiInstance = apiRef.current;
    if (!apiInstance) return;
    startupLoadKeyRef.current = null;
    void loadFileFromJoshu(apiInstance, todayPlanRelativePath());
  }, [loadFileFromJoshu]);

  const statusLine = useMemo(() => {
    if (loadedFile) return `Loaded: ${loadedFile}`;
    if (loadingFile) return `Loading ${pendingArozFile?.filename ?? "file"}…`;
    if (loadError) return loadError;
    if (!api) return "Waiting for canvas…";
    if (window.location.hash.length > 1 && !pendingArozFile) {
      return "File open requested — could not parse ArozOS hash.";
    }
    return "Time-block diagrams load from Planning/ automatically.";
  }, [loadedFile, loadingFile, loadError, api, pendingArozFile]);

  const onLinkOpen = useCallback(
    (
      element: { link?: string | null },
      event: { preventDefault?: () => void },
    ) => {
      const link = element.link;
      if (!link) return;

      if (link.startsWith("http://") || link.startsWith("https://")) {
        return;
      }

      event.preventDefault?.();
      const rel = joshuLinkToRelative(link);
      if (rel) {
        openJoshuTarget(rel, filesCtx);
        return;
      }

      console.warn("[joshu-excalidraw] unsupported link", link);
    },
    [filesCtx],
  );

  return (
    <main className="excalidraw-app">
      <header className="excalidraw-toolbar">
        <div>
          <h1>jWhiteboard</h1>
          <p>{statusLine}</p>
        </div>
        <div className="excalidraw-actions">
          <button type="button" onClick={openTodayPlan} disabled={!api}>
            Open today&apos;s plan
          </button>
          <button type="button" onClick={handleOpenMarkdownFile} disabled={!api}>
            Open Markdown
          </button>
          <button type="button" onClick={saveScene} disabled={!api}>
            Save Local
          </button>
          <button type="button" onClick={exportScene} disabled={!api}>
            Export
          </button>
          <label className="import-button">
            Import
            <input
              type="file"
              accept=".excalidraw,.md,.markdown,.mdown,.mkdn,application/json,text/markdown"
              onChange={importScene}
              disabled={!api}
            />
          </label>
        </div>
      </header>

      <section
        className="excalidraw-canvas"
        aria-label="Excalidraw canvas"
        onDropCapture={handleMarkdownDropCapture}
        onDragOverCapture={handleMarkdownDragOverCapture}
      >
        <Excalidraw
          onExcalidrawAPI={handleExcalidrawApi}
          initialData={initialData}
          onLinkOpen={onLinkOpen}
        />
      </section>
    </main>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
