import React, { createContext, useContext, useState, useEffect, useRef, useMemo } from 'react';
import type { VideoSource, VideoElement, VideoMediaElementType } from './types';
import { Preview } from '@creatomate/preview';
import { getMediaDurationKey } from '@/lib/media-duration';
import { sanitizeSourceForCreatomate } from '@/lib/creatomate-source';

interface VideoEditorContextType {
  source: VideoSource | null;
  currentElements: VideoElement[];
  type: 'video' | 'slide';
  setType: (type: 'video' | 'slide') => void;
  /**
   * Update the current source.
   * By default this records history (undo) and attempts to sync the Preview.
   */
  setSource: (source: VideoSource, opts?: { recordHistory?: boolean; syncPreview?: boolean }) => Promise<void>;
  preview: Preview | null;
  setPreview: (preview: Preview | null) => void;
  currentTime: number;
  setCurrentTime: (time: number) => void;
  duration: number;
  timelineCurrentTime: number;
  timelineDuration: number;
  timelineOffset: number;
  setTimelineTime: (time: number) => void;
  activeElementIds: string[];
  selectedElementId: string | null;
  selectedElement: VideoElement | null;
  setSelectedElementId: (id: string | null) => void;
  selectElement: (id: string | null) => Promise<void>;
  activeCompositionPath: VideoElement[];
  enterComposition: (id: string) => void;
  exitComposition: (compositionId?: string | null) => void;
  replaceCurrentElements: (elements: VideoElement[], opts?: { recordHistory?: boolean; syncPreview?: boolean }) => Promise<void>;
  /** Undo/redo */
  canUndo: boolean;
  canRedo: boolean;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  /** Zoom (canvas UI scaling, not a render setting) */
  zoom: number; // 0.25 - 3
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  /** Layer ordering (uses `track`) */
  bringForward: () => Promise<void>;
  sendBackward: () => Promise<void>;
  bringToFront: () => Promise<void>;
  sendToBack: () => Promise<void>;
  /** Quick add helpers */
  addTextElement: () => Promise<void>;
  addShapeElement: (shape?: 'rectangle' | 'circle') => Promise<void>;
  addMediaElement: (type: VideoMediaElementType, url: string) => Promise<void>;
  timelineScale: number;
  setTimelineScale: (scale: number) => void;
  isPlaying: boolean;
  setIsPlaying: (playing: boolean) => void;
  isScrubbing: boolean;
  setIsScrubbing: (scrubbing: boolean) => void;
  mediaDurations: Record<string, number>;
  draggedElementId: string | null;
  setDraggedElementId: (id: string | null) => void;
  dragOverTrack: number | null;
  setDragOverTrack: (track: number | null) => void;
  copy: () => void;
  paste: () => Promise<void>;
}

const VideoEditorContext = createContext<VideoEditorContextType | undefined>(undefined);

function cloneElements(elements: VideoElement[] | undefined): VideoElement[] {
  return Array.isArray(elements) ? JSON.parse(JSON.stringify(elements)) : [];
}

function getResolvedDuration(
  element: VideoElement,
  mediaDurations: Record<string, number>,
  fallbackDuration = 5,
) {
  const explicitDuration = element.duration as number | 'media' | undefined;
  if (typeof explicitDuration === 'number') {
    return explicitDuration;
  }

  const mediaKey = getMediaDurationKey(element.source);
  if (mediaKey && mediaDurations[mediaKey] !== undefined) {
    return mediaDurations[mediaKey];
  }

  return fallbackDuration;
}

/**
 * Shared layout resolution for timeline UI: per-track ordering, auto time, transitions.
 * Exported for timeline snapping so magnets match on-screen clip positions.
 */
export function resolveTrackLayout(
  elements: VideoElement[] | undefined,
  mediaDurations: Record<string, number>,
  containerDuration?: number,
) {
  const safeElements = Array.isArray(elements) ? elements : [];
  const trackMap = new Map<number, VideoElement[]>();

  safeElements.forEach((el) => {
    const track = el.track || 1;
    if (!trackMap.has(track)) trackMap.set(track, []);
    trackMap.get(track)?.push(el);
  });

  const resolved = new Map<string, { resolvedTime: number; resolvedDuration: number }>();
  let maxEndTime = 0;
  let hasNonFillerElements = false;

  for (const trackElements of trackMap.values()) {
    const sortedElements = [...trackElements].sort((a, b) => {
      const timeA = a.time ?? -1;
      const timeB = b.time ?? -1;
      if (timeA !== -1 && timeB !== -1) return timeA - timeB;
      return 0;
    });

    const isFillerTrack =
      trackElements.length === 1 &&
      trackElements[0].duration === undefined &&
      (!trackElements[0].source ||
        mediaDurations[getMediaDurationKey(trackElements[0].source) ?? ''] === undefined);

    if (isFillerTrack) {
      const filler = trackElements[0];
      resolved.set(filler.id, {
        resolvedTime: filler.time ?? 0,
        resolvedDuration: containerDuration ?? 10,
      });
      continue;
    }

    hasNonFillerElements = true;
    let trackTime = 0;

    for (const element of sortedElements) {
      const transitionAnim = element.animations?.find((a: any) => a.transition === true);
      const transitionDuration = transitionAnim?.duration || 0;

      let resolvedTime = element.time ?? trackTime;
      if (transitionAnim && element.time === undefined && trackTime > 0) {
        resolvedTime = Math.max(0, trackTime - transitionDuration);
      }

      const resolvedDuration = getResolvedDuration(element, mediaDurations);
      resolved.set(element.id, { resolvedTime, resolvedDuration });
      trackTime = resolvedTime + resolvedDuration;
    }

    if (trackTime > maxEndTime) {
      maxEndTime = trackTime;
    }
  }

  const duration = hasNonFillerElements ? Math.max(1, maxEndTime) : Math.max(1, containerDuration ?? 10);
  return { resolved, duration };
}

function findElementById(elements: VideoElement[] | undefined, id: string): VideoElement | null {
  for (const element of elements ?? []) {
    if (element.id === id) {
      return element;
    }
    const nested = findElementById(element.elements, id);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function findCompositionPathById(
  elements: VideoElement[] | undefined,
  targetId: string,
  path: string[] = [],
): string[] | null {
  for (const element of elements ?? []) {
    if (element.id === targetId && element.type === 'composition') {
      return [...path, element.id];
    }
    if (element.type === 'composition' && element.elements?.length) {
      const nested = findCompositionPathById(element.elements, targetId, [...path, element.id]);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

function findParentCompositionPathForElement(
  elements: VideoElement[] | undefined,
  targetId: string,
  path: string[] = [],
): string[] | null {
  for (const element of elements ?? []) {
    if (element.id === targetId) {
      return path;
    }
    if (element.type === 'composition' && element.elements?.length) {
      const nested = findParentCompositionPathForElement(element.elements, targetId, [...path, element.id]);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

function mergeAudioElementsFromPreviousState(
  previousElements: VideoElement[] | undefined,
  nextElements: VideoElement[] | undefined,
): VideoElement[] {
  const next = cloneElements(nextElements);
  const nextById = new Map(next.map((element) => [element.id, element]));

  for (const previousElement of previousElements ?? []) {
    const nextElement = nextById.get(previousElement.id);

    if (!nextElement) {
      // The interactive preview can omit non-visual audio elements from its
      // state echo. Preserve them so adding audio is not immediately undone.
      if (previousElement.type === 'audio') {
        next.push(cloneElements([previousElement])[0]);
      }
      continue;
    }

    if (previousElement.type === 'composition') {
      nextElement.elements = mergeAudioElementsFromPreviousState(
        previousElement.elements,
        nextElement.elements,
      );
    }
  }

  return next;
}

function getCompositionTrail(source: VideoSource | null, path: string[]) {
  const trail: VideoElement[] = [];
  let currentElements = source?.elements ?? [];

  for (const compositionId of path) {
    const next = currentElements.find(
      (element) => element.id === compositionId && element.type === 'composition',
    );
    if (!next) {
      break;
    }
    trail.push(next);
    currentElements = next.elements ?? [];
  }

  return trail;
}

function replaceElementsAtCompositionPath(
  elements: VideoElement[] | undefined,
  path: string[],
  replacement: VideoElement[],
): VideoElement[] {
  if (path.length === 0) {
    return cloneElements(replacement);
  }

  const [currentId, ...rest] = path;
  return (elements ?? []).map((element) => {
    if (element.id !== currentId || element.type !== 'composition') {
      return element;
    }

    return {
      ...element,
      elements: replaceElementsAtCompositionPath(element.elements, rest, replacement),
    };
  });
}

function removeElementFromTree(
  elements: VideoElement[] | undefined,
  targetId: string,
): { elements: VideoElement[]; removed: boolean } {
  let removed = false;

  const next = (elements ?? []).flatMap((element) => {
    if (element.id === targetId) {
      removed = true;
      return [];
    }

    if (element.elements?.length) {
      const nested = removeElementFromTree(element.elements, targetId);
      if (nested.removed) {
        removed = true;
        return [{ ...element, elements: nested.elements }];
      }
    }

    return [element];
  });

  return { elements: next, removed };
}

function updateElementInTree(
  elements: VideoElement[] | undefined,
  targetId: string,
  updater: (element: VideoElement) => VideoElement,
): { elements: VideoElement[]; updated: boolean } {
  let updated = false;

  const next = (elements ?? []).map((element) => {
    if (element.id === targetId) {
      updated = true;
      return updater(element);
    }

    if (element.elements?.length) {
      const nested = updateElementInTree(element.elements, targetId, updater);
      if (nested.updated) {
        updated = true;
        return { ...element, elements: nested.elements };
      }
    }

    return element;
  });

  return { elements: next, updated };
}

export function VideoEditorProvider({
  children,
  shortcutsEnabled = true,
}: {
  children: React.ReactNode;
  /**
   * When false, the provider will not register global keyboard shortcuts.
   * This is important in split views where the video editor can be mounted but hidden.
   */
  shortcutsEnabled?: boolean;
}) {
  const [source, setSourceState] = useState<VideoSource | null>(null);
  const [type, setType] = useState<'video' | 'slide'>('video');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [activeElementIds, setActiveElementIds] = useState<string[]>([]);
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null);
  const [activeCompositionIds, setActiveCompositionIds] = useState<string[]>([]);
  const [timelineScale, setTimelineScale] = useState(100); // pixels per second
  const [isPlaying, setIsPlaying] = useState(false);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [undoStack, setUndoStack] = useState<VideoSource[]>([]);
  const [redoStack, setRedoStack] = useState<VideoSource[]>([]);
  const [mediaDurations, setMediaDurations] = useState<Record<string, number>>({});
  const [draggedElementId, setDraggedElementId] = useState<string | null>(null);
  const [dragOverTrack, setDragOverTrack] = useState<number | null>(null);
  const [clipboard, setClipboard] = useState<VideoElement | null>(null);

  const activeCompositionPath = useMemo(
    () => getCompositionTrail(source, activeCompositionIds),
    [source, activeCompositionIds],
  );

  const currentElements = useMemo(() => {
    const activeComposition = activeCompositionPath[activeCompositionPath.length - 1];
    return activeComposition?.elements ?? source?.elements ?? [];
  }, [source, activeCompositionPath]);

  const selectedElement = useMemo(() => {
    if (!source || !selectedElementId) return null;
    return findElementById(source.elements, selectedElementId);
  }, [source, selectedElementId]);

  useEffect(() => {
    if (activeCompositionPath.length === activeCompositionIds.length) return;
    setActiveCompositionIds(activeCompositionPath.map((element) => element.id));
  }, [activeCompositionIds, activeCompositionPath]);

  const duration = useMemo(() => {
    if (source?.duration !== undefined && source.duration !== 0) {
      return source.duration;
    }

    return resolveTrackLayout(source?.elements, mediaDurations, source?.duration).duration;
  }, [source, mediaDurations]);

  const timelineScope = useMemo(() => {
    let offset = 0;
    let containerElements = source?.elements ?? [];
    let containerDuration = duration;

    for (const composition of activeCompositionPath) {
      const { resolved, duration: resolvedContainerDuration } = resolveTrackLayout(
        containerElements,
        mediaDurations,
        containerDuration,
      );
      const entry = resolved.get(composition.id);
      if (!entry) {
        break;
      }

      offset += entry.resolvedTime;
      containerDuration = composition.duration ?? entry.resolvedDuration;
      containerElements = composition.elements ?? [];
    }

    return {
      offset,
      duration: Math.max(
        0.1,
        activeCompositionPath[activeCompositionPath.length - 1]?.duration ??
          resolveTrackLayout(containerElements, mediaDurations, containerDuration).duration,
      ),
    };
  }, [source, duration, activeCompositionPath, mediaDurations]);

  const timelineOffset = timelineScope.offset;
  const timelineDuration = timelineScope.duration;
  const timelineCurrentTime = clamp(currentTime - timelineOffset, 0, timelineDuration);

  function clamp(n: number, min: number, max: number) {
    return Math.max(min, Math.min(max, n));
  }

  function cloneSource(s: VideoSource): VideoSource {
    // Source is plain JSON; clone to keep history immutable.
    try {
      // Prefer the native structuredClone when available (browser/modern runtimes).
      const sc = (globalThis as unknown as { structuredClone?: <T>(value: T) => T }).structuredClone;
      return typeof sc === 'function' ? sc(s) : JSON.parse(JSON.stringify(s));
    } catch {
      return JSON.parse(JSON.stringify(s));
    }
  }

  useEffect(() => {
      if (!preview) return;

      const handleTimeChange = (time: number) => {
          // IMPORTANT: Ignore time updates from the preview while we are scrubbing manually.
          // This prevents infinite loops and jittery UI during drags.
          if (!isScrubbing) {
            setCurrentTime(time);
          }
      };

      preview.onTimeChange = handleTimeChange;

      // Keep selection in sync with clicks in the Preview canvas (matches scratch behavior)
      preview.onActiveElementsChange = (elementIds: string[]) => {
        setActiveElementIds(elementIds ?? []);
        setSelectedElementId((elementIds && elementIds.length > 0 ? elementIds[0] : null) ?? null);
      };

      // Handle updates from the interactive preview (dragging, resizing, etc.)
      preview.onStateChange = (state) => {
        // Convert PreviewState back to our VideoSource format
        const newSource = transformPreviewStateToVideoSource(state);
        
        // Harvest intrinsic durations from the resolved state.
        // Creatomate resolves intrinsic durations for videos/images automatically.
        const discoveredDurations: Record<string, number> = {};
        const collectDurations = (items: any[]) => {
          items.forEach(item => {
            // item.duration is the resolved duration.
            // if item.source.duration is undefined, this is the intrinsic media duration.
            if (item.source?.source && typeof item.duration === 'number' && item.source.duration === undefined) {
              const mediaKey = getMediaDurationKey(item.source.source);
              if (mediaKey) {
                discoveredDurations[mediaKey] = item.duration;
              }
            }
            if (item.elements) collectDurations(item.elements);
          });
        };
        collectDurations(state.elements || []);

        if (Object.keys(discoveredDurations).length > 0) {
          setMediaDurations(prev => {
            const next = { ...prev };
            let changed = false;
            for (const [id, dur] of Object.entries(discoveredDurations)) {
              if (next[id] !== dur) {
                next[id] = dur;
                changed = true;
              }
            }
            return changed ? next : prev;
          });
        }

        // Update the local state so the property inspector reflects the changes.
        // We use a functional update and check for equality to avoid unnecessary re-renders
        // and potential infinite loops.
        setSourceState((prev) => {
          if (!prev) return newSource;
          const mergedSource: VideoSource = {
            ...newSource,
            elements: mergeAudioElementsFromPreviousState(prev.elements, newSource.elements),
          };
          
          // Simple equality check to avoid redundant updates
          const prevJson = JSON.stringify(prev);
          const nextJson = JSON.stringify(mergedSource);
          if (prevJson === nextJson) return prev;
          
          return mergedSource;
        });
      };
      
      return () => {
          preview.onTimeChange = undefined;
          preview.onActiveElementsChange = undefined;
          preview.onStateChange = undefined;
      };
  }, [preview, isScrubbing]);

  /**
   * Helper to convert Creatomate's nested PreviewState back to our flattened VideoSource.
   */
  function transformPreviewStateToVideoSource(state: any): VideoSource {
    const { elements, source: rootSource } = state;
    
    function cleanElements(items: any[]): any[] {
      return (items || []).map(item => {
        const cleaned: any = { ...item.source };
        if (item.animations) cleaned.animations = item.animations;
        if (item.elements) cleaned.elements = cleanElements(item.elements);
        return cleaned;
      });
    }

    return {
      ...rootSource,
      elements: cleanElements(elements),
    } as VideoSource;
  }

  // Single source of truth for selecting an element from anywhere in the UI.
  // This updates the Preview selection *and* our local state (the Preview will echo it back via onActiveElementsChange).
  async function selectElement(id: string | null) {
    setSelectedElementId(id);
    setActiveElementIds(id ? [id] : []);
    if (!preview) return;
    try {
      await preview.setActiveElements(id ? [id] : []);
    } catch (e) {
      // Non-fatal: still allow UI selection even if preview can't set active elements.
      console.warn('[VideoEditor] Failed to set active elements in preview', e);
    }
  }

  async function setSource(next: VideoSource, opts?: { recordHistory?: boolean; syncPreview?: boolean }) {
    const recordHistory = opts?.recordHistory !== false;
    const syncPreview = opts?.syncPreview !== false;

    if (recordHistory && source) {
      setUndoStack((prev) => {
        const nextPrev = [...prev, cloneSource(source)];
        // keep it bounded
        return nextPrev.length > 50 ? nextPrev.slice(nextPrev.length - 50) : nextPrev;
      });
      setRedoStack([]); // clear redo on new changes
    }

    setSourceState(next);

    if (syncPreview && preview) {
      try {
        await preview.setSource(sanitizeSourceForCreatomate(next), true);
      } catch (e) {
        console.warn('[VideoEditor] Failed to sync source to preview', e);
      }
    }
  }

  async function replaceCurrentElements(
    elements: VideoElement[],
    opts?: { recordHistory?: boolean; syncPreview?: boolean },
  ) {
    if (!source) return;

    const nextSource =
      activeCompositionIds.length === 0
        ? ({ ...source, elements } as VideoSource)
        : ({
            ...source,
            elements: replaceElementsAtCompositionPath(source.elements, activeCompositionIds, elements),
          } as VideoSource);

    await setSource(nextSource, opts);
  }

  function enterComposition(id: string) {
    if (!source) return;
    const nextPath = findCompositionPathById(source.elements, id);
    if (!nextPath) return;
    setActiveCompositionIds(nextPath);
    void selectElement(id);
  }

  function exitComposition(compositionId?: string | null) {
    if (!compositionId) {
      setActiveCompositionIds([]);
      return;
    }

    const idx = activeCompositionIds.indexOf(compositionId);
    if (idx === -1) {
      setActiveCompositionIds([]);
      return;
    }

    setActiveCompositionIds(activeCompositionIds.slice(0, idx + 1));
  }

  function setTimelineTime(time: number) {
    const absoluteTime = clamp(timelineOffset + time, 0, duration);
    setCurrentTime(absoluteTime);
    if (preview) {
      void preview.setTime(absoluteTime);
    }
  }

  const canUndo = undoStack.length > 0;
  const canRedo = redoStack.length > 0;

  async function undo() {
    if (!source) return;
    setUndoStack((prev) => {
      if (prev.length === 0) return prev;
      const previous = prev[prev.length - 1];
      setRedoStack((r) => [...r, cloneSource(source)]);
      // Apply previous without recording history.
      void setSource(previous, { recordHistory: false });
      return prev.slice(0, -1);
    });
  }

  async function redo() {
    if (!source) return;
    setRedoStack((prev) => {
      if (prev.length === 0) return prev;
      const next = prev[prev.length - 1];
      setUndoStack((u) => [...u, cloneSource(source)]);
      void setSource(next, { recordHistory: false });
      return prev.slice(0, -1);
    });
  }

  function zoomIn() {
    setZoom((z) => clamp(Math.round((z + 0.1) * 100) / 100, 0.25, 3));
  }

  function zoomOut() {
    setZoom((z) => clamp(Math.round((z - 0.1) * 100) / 100, 0.25, 3));
  }

  function resetZoom() {
    setZoom(1);
  }

  async function updateSelectedTrack(mutator: (elements: any[], idx: number) => any[]) {
    if (!source || !selectedElementId) return;
    const containerPath = findParentCompositionPathForElement(source.elements, selectedElementId) ?? [];
    const containerElements =
      containerPath.length === 0
        ? [...(source.elements ?? [])]
        : cloneElements(getCompositionTrail(source, containerPath).at(-1)?.elements);
    const idx = containerElements.findIndex((e: any) => e.id === selectedElementId);
    if (idx < 0) return;
    const nextElements = mutator(containerElements, idx);
    const nextSource =
      containerPath.length === 0
        ? ({ ...source, elements: nextElements } as VideoSource)
        : ({
            ...source,
            elements: replaceElementsAtCompositionPath(source.elements, containerPath, nextElements),
          } as VideoSource);
    await setSource(nextSource);
  }

  async function bringToFront() {
    await updateSelectedTrack((elements, idx) => {
      const maxTrack = Math.max(...elements.map((e: any) => Number(e.track ?? 0)), 0);
      elements[idx] = { ...elements[idx], track: maxTrack + 1 };
      return elements;
    });
  }

  async function sendToBack() {
    await updateSelectedTrack((elements, idx) => {
      const minTrack = Math.min(...elements.map((e: any) => Number(e.track ?? 0)), 0);
      elements[idx] = { ...elements[idx], track: minTrack - 1 };
      return elements;
    });
  }

  async function bringForward() {
    await updateSelectedTrack((elements, idx) => {
      const cur = Number(elements[idx].track ?? 0);
      const higher = elements
        .map((e: any, i: number) => ({ i, t: Number(e.track ?? 0) }))
        .filter((x) => x.t > cur)
        .sort((a, b) => a.t - b.t)[0];
      if (!higher) {
        const maxTrack = Math.max(...elements.map((e: any) => Number(e.track ?? 0)), 0);
        elements[idx] = { ...elements[idx], track: maxTrack + 1 };
        return elements;
      }
      // swap tracks
      const tmp = elements[idx].track;
      elements[idx] = { ...elements[idx], track: elements[higher.i].track };
      elements[higher.i] = { ...elements[higher.i], track: tmp };
      return elements;
    });
  }

  async function sendBackward() {
    await updateSelectedTrack((elements, idx) => {
      const cur = Number(elements[idx].track ?? 0);
      const lower = elements
        .map((e: any, i: number) => ({ i, t: Number(e.track ?? 0) }))
        .filter((x) => x.t < cur)
        .sort((a, b) => b.t - a.t)[0];
      if (!lower) {
        const minTrack = Math.min(...elements.map((e: any) => Number(e.track ?? 0)), 0);
        elements[idx] = { ...elements[idx], track: minTrack - 1 };
        return elements;
      }
      const tmp = elements[idx].track;
      elements[idx] = { ...elements[idx], track: elements[lower.i].track };
      elements[lower.i] = { ...elements[lower.i], track: tmp };
      return elements;
    });
  }

  function newId(prefix: string) {
    try {
      const uuid = globalThis.crypto?.randomUUID?.();
      return uuid ? `${prefix}_${uuid}` : `${prefix}_${Math.random().toString(16).slice(2)}`;
    } catch {
      return `${prefix}_${Math.random().toString(16).slice(2)}`;
    }
  }

  async function addTextElement() {
    if (!source) return;
    const id = newId('text');
    const maxTrack = Math.max(...(currentElements ?? []).map((e: any) => Number(e.track ?? 0)), 0);
    const next: any = {
      id,
      type: 'text',
      name: 'Text',
      track: maxTrack + 1,
      time: currentTime,
      duration: 3,
      x: '50%',
      y: '50%',
      width: '60%',
      height: '20%',
      text: 'New text',
      font_family: source.fonts?.[0]?.family ?? undefined,
      font_size: '6vmin',
      fill_color: '#ffffff',
      x_alignment: '50%',
      y_alignment: '50%',
      blend_mode: 'none',
    };
    await replaceCurrentElements([...(currentElements ?? []), next]);
    await selectElement(id);
  }

  async function addShapeElement(shape: 'rectangle' | 'circle' = 'rectangle') {
    if (!source) return;
    const id = newId('shape');
    const maxTrack = Math.max(...(currentElements ?? []).map((e: any) => Number(e.track ?? 0)), 0);
    const next: any = {
      id,
      type: 'shape',
      name: shape === 'circle' ? 'Circle' : 'Rectangle',
      track: maxTrack + 1,
      time: currentTime,
      duration: 3,
      x: '50%',
      y: '50%',
      width: '30%',
      height: '30%',
      fill_color: '#3a3838',
      border_radius: shape === 'circle' ? '999px' : undefined,
      blend_mode: 'none',
    };
    await replaceCurrentElements([...(currentElements ?? []), next]);
    await selectElement(id);
  }

  async function addMediaElement(type: VideoMediaElementType, url: string) {
    if (!source) return;
    if (!url) return;
    const id = newId(type);
    const maxTrack = Math.max(...(currentElements ?? []).map((e: any) => Number(e.track ?? 0)), 0);
    const next: any = {
      id,
      type,
      name: type === 'image' ? 'Image' : type === 'video' ? 'Video' : 'Audio',
      track: maxTrack + 1,
      time: currentTime,
      duration: type === 'audio' ? 'media' : 3,
      source: url,
    };

    if (type !== 'audio') {
      Object.assign(next, {
        x: '50%',
        y: '50%',
        width: '60%',
        height: '60%',
        fit: 'cover',
        blend_mode: 'none',
      });
    }

    await replaceCurrentElements([...(currentElements ?? []), next]);
    await selectElement(id);
  }

  function copy() {
    if (!selectedElementId || !source) return;
    const element = findElementById(source.elements, selectedElementId);
    if (element) {
      setClipboard(cloneSource(element as any) as unknown as VideoElement);
    }
  }

  async function paste() {
    if (!clipboard || !source) return;
    
    const id = newId(clipboard.type || 'element');
    const newElement = {
      ...cloneSource(clipboard as any),
      id,
      time: currentTime, // Paste at current playhead
    } as unknown as VideoElement;

    await replaceCurrentElements([...(currentElements ?? []), newElement]);
    await selectElement(id);
  }

  // Keyboard shortcuts
  useEffect(() => {
    if (!shortcutsEnabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in an input or textarea
      if (
        document.activeElement?.tagName === 'INPUT' ||
        document.activeElement?.tagName === 'TEXTAREA' ||
        (document.activeElement as HTMLElement)?.isContentEditable
      ) {
        return;
      }

      const isMod = e.metaKey || e.ctrlKey;
      const key = (e.key || '').toLowerCase();

      // If the user has an active text selection anywhere (e.g. selecting chat text),
      // never steal standard browser copy. (Right-click copy would still work, but Cmd/Ctrl+C should too.)
      if (isMod && key === 'c') {
        const selection = window.getSelection?.();
        const selectedText = selection?.toString?.() ?? '';
        if (selectedText.trim().length > 0) {
          return;
        }
      }

      if (isMod && key === 'c') {
        // Only prevent default if we actually have something to copy in the editor.
        if (!selectedElementId || !source) return;
        const element = findElementById(source.elements, selectedElementId);
        if (!element) return;
        e.preventDefault();
        copy();
      } else if (isMod && key === 'v') {
        // Only prevent default if we can paste a video element.
        if (!clipboard || !source) return;
        e.preventDefault();
        void paste();
      } else if (isMod && key === 'z') {
        const wantsRedo = e.shiftKey;
        if (wantsRedo && !canRedo) return;
        if (!wantsRedo && !canUndo) return;
        e.preventDefault();
        if (wantsRedo) {
          void redo();
        } else {
          void undo();
        }
      } else if (key === 'backspace' || key === 'delete') {
        if (selectedElementId && source) {
          e.preventDefault();
          const nextTree = removeElementFromTree(source.elements, selectedElementId);
          if (nextTree.removed) {
            void setSource({ ...source, elements: nextTree.elements });
            void selectElement(null);
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [shortcutsEnabled, selectedElementId, source, clipboard, currentTime, canUndo, canRedo]);

  return (
    <VideoEditorContext.Provider
      value={{
        source,
        currentElements,
        setSource,
        type,
        setType,
        preview,
        setPreview,
        currentTime,
        setCurrentTime,
        duration,
        timelineCurrentTime,
        timelineDuration,
        timelineOffset,
        setTimelineTime,
        activeElementIds,
        selectedElementId,
        selectedElement,
        setSelectedElementId,
        selectElement,
        activeCompositionPath,
        enterComposition,
        exitComposition,
        replaceCurrentElements,
        canUndo,
        canRedo,
        undo,
        redo,
        zoom,
        zoomIn,
        zoomOut,
        resetZoom,
        bringForward,
        sendBackward,
        bringToFront,
        sendToBack,
        addTextElement,
        addShapeElement,
        addMediaElement,
        timelineScale,
        setTimelineScale,
        isPlaying,
        setIsPlaying,
        isScrubbing,
        setIsScrubbing,
        mediaDurations,
        draggedElementId,
        setDraggedElementId,
        dragOverTrack,
        setDragOverTrack,
        copy,
        paste,
      }}
    >
      {children}
    </VideoEditorContext.Provider>
  );
}

export function useVideoEditor() {
  const context = useContext(VideoEditorContext);
  if (!context) {
    throw new Error('useVideoEditor must be used within a VideoEditorProvider');
  }
  return context;
}

