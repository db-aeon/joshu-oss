
import { useEffect, useMemo, useState, useRef, type ChangeEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/lib/toast';
import { ElementList } from './element-list';
import { PropertyInspector, VideoProperties } from './property-inspector';
import { Timeline } from './timeline/timeline';
import { VideoEditorProvider, useVideoEditor } from './editor-context';
import type { VideoElement, VideoMediaElementType, VideoSource } from './types';
import { CREATOMATE_PUBLIC_TOKEN, MOVIE_EDITOR_API_BASE } from '@/lib/config';
import { prepareSourceForPreview, sanitizeSourceForCreatomate } from '@/lib/creatomate-source';
import { cn } from '@/lib/utils';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_LABEL } from '@/lib/upload-limits';
import {
  ArrowDownToLine,
  ArrowUpToLine,
  ChevronRight,
  ChevronDown,
  Circle,
  Code,
  Image as ImageIcon,
  Redo2,
  Square,
  Type,
  Undo2,
  Video,
  X,
  ZoomIn,
  ZoomOut,
  Monitor as MonitorIcon,
  Layers as LayersIcon,
  Settings2,
  ChevronDown as ChevronDownIcon,
  Music
} from 'lucide-react';

async function uploadMediaFile(file: File): Promise<string> {
  const response = await fetch(`${MOVIE_EDITOR_API_BASE}/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-Filename': file.name,
    },
    body: file,
  });
  const data = (await response.json()) as { url?: string; error?: string };
  if (!response.ok) throw new Error(data.error || 'Upload failed');
  if (!data.url) throw new Error('Upload succeeded but no URL was returned');
  return data.url;
}

type ApiGetResponse = {
  directive: { id: string; title?: string; url?: string; filename?: string; type?: 'video' | 'slide' };
  source: any;
  assets?: Array<{
    id?: string;
    type?: string;
    url?: string;
    filename?: string;
    description?: string;
    tags?: string[];
  }>;
};

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

function SidebarSection({ 
    title, 
    icon: Icon, 
    children, 
    defaultOpen = true,
    className,
    flexClassName = "flex-1"
}: { 
    title: string; 
    icon: any; 
    children: React.ReactNode; 
    defaultOpen?: boolean;
    className?: string;
    flexClassName?: string;
}) {
    const [isOpen, setIsOpen] = useState(defaultOpen);
    
    return (
        <Collapsible 
            open={isOpen} 
            onOpenChange={setIsOpen}
            className={cn("flex flex-col min-h-0", isOpen ? flexClassName : "flex-none", className)}
        >
            <CollapsibleTrigger className="flex items-center justify-between px-3 py-2 text-[10px] font-bold text-muted-foreground/60 uppercase tracking-widest hover:text-foreground transition-colors bg-muted/10 border-b border-border/30">
                <div className="flex items-center gap-2">
                    <Icon className="h-3 w-3 opacity-70" />
                    {title}
                </div>
                <ChevronDownIcon className={cn("h-3 w-3 transition-transform duration-200", !isOpen && "-rotate-90")} />
            </CollapsibleTrigger>
            <CollapsibleContent className="flex-1 min-h-0 overflow-hidden">
                {children}
            </CollapsibleContent>
        </Collapsible>
    );
}

// The inner UI component that uses the context
function VideoEditorUI({ 
    directive, 
    assets, 
    initialSource,
    onSave,
    projectId,
    showExitButton = true,
    isSplitView = false,
    isReadonly = false,
}: { 
    directive: ApiGetResponse['directive'] | null, 
    assets: ApiGetResponse['assets'],
    initialSource: VideoSource | null,
    onSave: (source: VideoSource) => Promise<void>,
    projectId: string,
    showExitButton?: boolean,
    isSplitView?: boolean,
    isReadonly?: boolean,
}) {
    const { 
        source, 
        duration,
        setSource, 
        type,
        setType,
        preview, 
        setPreview, 
        selectedElementId, 
        setSelectedElementId,
        activeCompositionPath,
        exitComposition,
    } = useVideoEditor();

    // Sync directive type to context
    useEffect(() => {
        if (directive?.type) {
            setType(directive.type);
        }
    }, [directive?.type, setType]);

    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);
    const lastSavedSourceRef = useRef<string | null>(null);
    const isApplyingExternalSourceRef = useRef(false);

    // Auto-save logic
    useEffect(() => {
        if (!source || !dirty || saving || isReadonly) return;

        const timer = setTimeout(async () => {
            const sourceJson = JSON.stringify(source);
            if (sourceJson === lastSavedSourceRef.current) {
                setDirty(false);
                return;
            }

            setSaving(true);
            try {
                await onSave(source);
                lastSavedSourceRef.current = sourceJson;
                setDirty(false);
            } catch (e: any) {
                console.error('[VideoEditor] Auto-save failed:', e);
            } finally {
                setSaving(false);
            }
        }, 2000); // 2 second debounce

        return () => clearTimeout(timer);
    }, [source, dirty, saving, onSave, isReadonly]);

    // Load initial source into context
    useEffect(() => {
        if (initialSource) {
            const initialJson = JSON.stringify(initialSource);
            
            // Only overwrite if we haven't loaded anything yet,
            // OR if the current state is not dirty (meaning no unsaved user changes).
            if (!source || (!dirty && initialJson !== lastSavedSourceRef.current)) {
                isApplyingExternalSourceRef.current = true;
                lastSavedSourceRef.current = initialJson;
                setDirty(false);
                void setSource(initialSource, { recordHistory: false }).finally(() => {
                  // Creatomate may echo a normalized source through onStateChange after
                  // setSource(). Treat that initial echo as the loaded baseline, not a user edit.
                  window.setTimeout(() => {
                    isApplyingExternalSourceRef.current = false;
                  }, 500);
                });
            }
        }
    }, [initialSource, source, dirty, setSource]);

    // Mark as dirty when source changes
    useEffect(() => {
        if (source) {
            const currentJson = JSON.stringify(source);
            if (isApplyingExternalSourceRef.current) {
                lastSavedSourceRef.current = currentJson;
                setDirty(false);
                return;
            }

            if (currentJson !== lastSavedSourceRef.current) {
                setDirty(true);
            }
        }
    }, [source]);

    return (
      <div
        className="flex w-full flex-col bg-background h-full overflow-hidden"
      >
        {/* Toolbar */}
        <VideoEditorTopToolbar
          projectId={projectId}
          title={directive?.title || (directive?.type === 'slide' ? 'Slide project' : 'Video project')}
          meta={source ? `${source.width}x${source.height}${directive?.type === 'slide' ? '' : ` • ${duration}s`}` : ''}
          saving={saving}
          assets={assets ?? []}
          showExitButton={showExitButton}
          isReadonly={isReadonly}
        />

        {/* Main Editor Area */}
        <div className="flex min-h-0 flex-1">
            {/* Center: Canvas & Timeline */}
            <div className="flex flex-1 flex-col min-w-0">
                {/* Canvas Area */}
                <div className="flex-1 overflow-hidden bg-muted/20 relative flex flex-col">
                    <div className="absolute left-4 top-3 z-10 flex max-w-[calc(100%-2rem)] flex-wrap items-center gap-1 rounded-md bg-background/80 px-3 py-1.5 text-xs text-muted-foreground shadow-sm backdrop-blur">
                        <button
                          type="button"
                          className={cn(
                            "font-medium transition-colors hover:text-foreground",
                            activeCompositionPath.length === 0 && "text-foreground",
                          )}
                          onClick={() => exitComposition(null)}
                        >
                          Main Composition
                        </button>
                        {activeCompositionPath.map((composition, index) => (
                          <div key={composition.id} className="flex items-center gap-1">
                            <ChevronRight className="h-3 w-3 opacity-60" />
                            <button
                              type="button"
                              className={cn(
                                "truncate font-medium transition-colors hover:text-foreground",
                                index === activeCompositionPath.length - 1 && "text-foreground",
                              )}
                              onClick={() => exitComposition(composition.id)}
                            >
                              {composition.name || composition.id}
                            </button>
                          </div>
                        ))}
                    </div>
                    <div className="flex-1 flex items-center justify-center relative">
                        {/* We need to attach the ref inside the context-aware component? 
                            No, we can pass the ref to the provider or handle it here.
                            Actually, the provider exposes setPreview. 
                            We need to initialize the Preview instance here and set it in context.
                        */}
                        <PreviewContainer />
                    </div>
                </div>
                
                {/* Timeline Area */}
                {directive?.type !== 'slide' && (
                  <div className="h-72 border-t border-border bg-background shrink-0 flex flex-col">
                      <Timeline isReadonly={isReadonly} />
                  </div>
                )}
            </div>

            {/* Right Sidebar: Video, Layers & Inspector (Adobe-style) */}
            <div className={cn("border-l border-border bg-card shrink-0 flex flex-col overflow-hidden transition-all duration-300 divide-y divide-border/30", isSplitView ? "w-64" : "w-80")}>
                <SidebarSection title={type === 'slide' ? 'Slide' : 'Video'} icon={MonitorIcon} defaultOpen={false}>
                    <VideoProperties isReadonly={isReadonly} />
                </SidebarSection>
                <SidebarSection title="Layers" icon={LayersIcon} defaultOpen={isSplitView ? false : true} flexClassName="flex-[0.5]">
                    <ElementList />
                </SidebarSection>
                <SidebarSection title="Properties" icon={Settings2} defaultOpen={true}>
                    <PropertyInspector isReadonly={isReadonly} />
                </SidebarSection>
            </div>
        </div>
      </div>
    );
}

import { Preview } from '@creatomate/preview';

function PreviewContainer() {
    const { setPreview, source, zoom } = useVideoEditor();
    const containerRef = useRef<HTMLDivElement>(null);
    const previewRef = useRef<Preview | null>(null);
    const didApplyInitialSourceRef = useRef(false);
    const [isReady, setIsReady] = useState(false);
    const token = CREATOMATE_PUBLIC_TOKEN;

    useEffect(() => {
        if (!containerRef.current || !token) return;
        
        console.log('[VideoEditor] Initializing Preview...');
        const preview = new Preview(containerRef.current, 'interactive', token);
        previewRef.current = preview;
        setPreview(preview);
        
        preview.onReady = async () => {
             setIsReady(true);
        };

        return () => {
            preview.dispose();
            previewRef.current = null;
            setPreview(null);
            setIsReady(false);
            didApplyInitialSourceRef.current = false;
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token, setPreview]); // Don't re-run on source change, only init

    // Apply the initial source as soon as BOTH are ready.
    // This fixes the "blank preview until you click timeline" issue caused by a stale `source`
    // captured in `onReady` when the JSON arrives after the preview initializes.
    useEffect(() => {
      if (!isReady) return;
      if (!source) return;
      if (didApplyInitialSourceRef.current) return;
      const preview = previewRef.current;
      if (!preview) return;

      didApplyInitialSourceRef.current = true;
      void preview.setSource(sanitizeSourceForCreatomate(source), true);
    }, [isReady, source]);

    // Handle zoom and initial fit
    useEffect(() => {
      if (!isReady || !previewRef.current) return;
      
      if (zoom === 1) {
        void previewRef.current.setZoom('auto');
      } else {
        void previewRef.current.setZoom('fixed', zoom);
      }
    }, [isReady, zoom]);

    // Handle container resizing
    useEffect(() => {
      if (!isReady || !previewRef.current || !containerRef.current) return;

      const preview = previewRef.current;
      const observer = new ResizeObserver(() => {
        // Creatomate's Preview automatically handles basic resizing if the container changes,
        // but we might want to ensure it fits properly after a layout shift.
        // We use 'auto' to ensure the video stays visible and at the right resolution.
        if (zoom === 1) {
          void preview.setZoom('auto');
        }
      });

      observer.observe(containerRef.current);
      return () => observer.disconnect();
    }, [isReady, zoom]);

    if (!token) {
      return (
        <div className="flex h-full min-h-[240px] w-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Creatomate preview not configured</p>
          <p>
            Set <code className="rounded bg-muted px-1">VITE_CREATOMATE_PUBLIC_TOKEN</code> in the repo{" "}
            <code className="rounded bg-muted px-1">.env</code>, then run{" "}
            <code className="rounded bg-muted px-1">npm run build:movie-editor</code> and reload jMovie.
          </p>
        </div>
      );
    }

    return (
      <div className="relative flex h-full min-h-[240px] w-full items-center justify-center overflow-hidden">
        <div ref={containerRef} className="absolute inset-0 h-full w-full" />
        {!isReady && (
          <div className="pointer-events-none text-xs text-muted-foreground">Loading preview…</div>
        )}
      </div>
    );
}

type Asset = {
  id?: string;
  type?: string;
  url?: string;
  filename?: string;
  description?: string;
  tags?: string[];
};

function ToolbarIconButton({
  title,
  onClick,
  disabled,
  children,
  active,
}: {
  title: string;
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={cn(
        "h-8 w-8 transition-all duration-200",
        active ? "bg-primary/10 text-primary hover:bg-primary/15" : "text-muted-foreground/60 hover:text-foreground hover:bg-muted/50"
      )}
    >
      {children}
    </Button>
  );
}

function VideoEditorTopToolbar({
  projectId,
  title,
  meta,
  saving,
  assets,
  showExitButton = true,
  isReadonly = false,
}: {
  projectId: string;
  
  title: string;
  meta: string;
  saving: boolean;
  assets: Asset[];
  showExitButton?: boolean;
  isReadonly?: boolean;
}) {
  const {
    source,
    setSource,
    selectedElementId,
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
  } = useVideoEditor();

  // --- JSON Editor state ---
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonValue, setJsonValue] = useState('');
  const audioInputRef = useRef<HTMLInputElement>(null);
  const [isUploadingAudio, setIsUploadingAudio] = useState(false);

  const handleOpenJson = () => {
    setJsonValue(JSON.stringify(source, null, 2));
    setJsonOpen(true);
  };

  const handleSaveJson = () => {
    try {
      const parsed = JSON.parse(jsonValue);
      void setSource(parsed);
      setJsonOpen(false);
      toast.success('JSON updated');
    } catch (e) {
      toast.error('Invalid JSON');
    }
  };

  const handleAudioUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('audio/')) {
      toast.error('Please choose an audio file.');
      event.target.value = '';
      return;
    }

    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast.error(`Audio files must be smaller than ${MAX_ATTACHMENT_LABEL}.`);
      event.target.value = '';
      return;
    }

    setIsUploadingAudio(true);
    try {
      const url = await uploadMediaFile(file);
      await addMediaElement('audio', url);
      toast.success('Audio added to project');
    } catch (error) {
      console.error('[VideoEditor] Audio upload failed:', error);
      toast.error(error instanceof Error ? error.message : 'Audio upload failed');
    } finally {
      setIsUploadingAudio(false);
      event.target.value = '';
    }
  };

  // --- Add Media dialog state (simple, matches scratch "add media" affordance) ---
  const [addOpen, setAddOpen] = useState(false);
  const [addType, setAddType] = useState<VideoMediaElementType>('image');
  const [addUrl, setAddUrl] = useState('');

  const assetOptions = useMemo(() => {
    const filtered = assets.filter((a) => a.type === addType);
    return filtered.filter((a) => a.url);
  }, [assets, addType]);

  const zoomPct = Math.round(zoom * 100);

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/40 px-2 bg-background/80 backdrop-blur-md z-20">
      <div className="flex min-w-0 shrink-0 items-center gap-3">
        <div className="flex max-w-[240px] items-center gap-2 overflow-hidden">
          <span className="truncate text-[11px] font-semibold text-foreground/80 tracking-tight">{title}</span>
          {meta ? (
            <span className="rounded-full bg-muted/50 px-2 py-0.5 text-[9px] font-medium text-muted-foreground/60 border border-border/20 tabular-nums">{meta}</span>
          ) : null}
          {saving && (
            <span className="text-[9px] text-muted-foreground/40 animate-pulse ml-1 font-medium italic">Saving…</span>
          )}
        </div>
      </div>

      {/* Center tools (like scratch) */}
      <div className="flex min-w-0 flex-1 items-center justify-between gap-1 overflow-hidden rounded-md border border-border/20 bg-muted/30 p-0.5 px-2">
        {!isReadonly && (
          <>
            <ToolbarIconButton title="Add text" onClick={() => void addTextElement()}>
              <Type className="h-3.5 w-3.5" />
            </ToolbarIconButton>

            <Dialog open={addOpen} onOpenChange={setAddOpen}>
              <DialogTrigger asChild>
                <ToolbarIconButton
                  title="Add media (image/video)"
                  onClick={() => {
                    setAddType('image');
                    setAddUrl('');
                    setAddOpen(true);
                  }}
                >
                  <ImageIcon className="h-3.5 w-3.5" />
                </ToolbarIconButton>
              </DialogTrigger>
              <DialogContent className="max-w-lg">
                <DialogHeader>
                  <DialogTitle>Add media</DialogTitle>
                </DialogHeader>
                <div className="grid gap-3">
                  <div className="grid gap-2">
                    <div className="text-xs font-medium text-muted-foreground">Type</div>
                    <Select value={addType} onValueChange={(v) => setAddType(v as VideoMediaElementType)}>
                      <SelectTrigger className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="image">Image</SelectItem>
                        <SelectItem value="video">Video</SelectItem>
                        <SelectItem value="audio">Audio</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid gap-2">
                    <div className="text-xs font-medium text-muted-foreground">From assets</div>
                    <Select
                      value=""
                      onValueChange={(v) => {
                        setAddUrl(v);
                      }}
                    >
                      <SelectTrigger className="h-9">
                        <SelectValue placeholder={assetOptions.length ? 'Choose an asset…' : 'No assets found'} />
                      </SelectTrigger>
                      <SelectContent>
                        {assetOptions.map((a) => (
                          <SelectItem key={a.url} value={String(a.url)}>
                            {a.filename || a.url}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid gap-2">
                    <div className="text-xs font-medium text-muted-foreground">Or paste URL</div>
                    <Input value={addUrl} onChange={(e) => setAddUrl(e.target.value)} placeholder="https://..." />
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setAddOpen(false);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={() => {
                      if (!addUrl) return;
                      void addMediaElement(addType, addUrl);
                      setAddOpen(false);
                    }}
                  >
                    Add
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <ToolbarIconButton title="Add video" onClick={() => { setAddType('video'); setAddUrl(''); setAddOpen(true); }}>
              <Video className="h-3.5 w-3.5" />
            </ToolbarIconButton>

            <ToolbarIconButton
              title={isUploadingAudio ? 'Uploading audio...' : 'Upload audio'}
              disabled={isUploadingAudio}
              onClick={() => audioInputRef.current?.click()}
            >
              <Music className="h-3.5 w-3.5" />
            </ToolbarIconButton>
            <input
              ref={audioInputRef}
              type="file"
              accept="audio/mpeg,audio/wav,audio/mp4,audio/x-m4a,audio/aac,audio/ogg,.mp3,.wav,.m4a,.aac,.ogg"
              className="hidden"
              onChange={handleAudioUpload}
            />

            <ToolbarIconButton title="Add rectangle" onClick={() => void addShapeElement('rectangle')}>
              <Square className="h-3.5 w-3.5" />
            </ToolbarIconButton>
            <ToolbarIconButton title="Add circle" onClick={() => void addShapeElement('circle')}>
              <Circle className="h-3.5 w-3.5" />
            </ToolbarIconButton>

            <div className="mx-1 h-4 w-px bg-border/40" />

            <ToolbarIconButton title="Undo" disabled={!canUndo} onClick={() => void undo()}>
              <Undo2 className="h-3.5 w-3.5" />
            </ToolbarIconButton>
            <ToolbarIconButton title="Redo" disabled={!canRedo} onClick={() => void redo()}>
              <Redo2 className="h-3.5 w-3.5" />
            </ToolbarIconButton>

            <Dialog open={jsonOpen} onOpenChange={setJsonOpen}>
              <DialogTrigger asChild>
                <ToolbarIconButton title="Edit JSON" onClick={handleOpenJson}>
                  <Code className="h-3.5 w-3.5" />
                </ToolbarIconButton>
              </DialogTrigger>
              <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
                <DialogHeader>
                  <DialogTitle>Edit underlying JSON</DialogTitle>
                </DialogHeader>
                <div className="flex-1 min-h-0 py-4">
                  <Textarea
                    value={jsonValue}
                    onChange={(e) => setJsonValue(e.target.value)}
                    className="h-[50vh] font-mono text-[11px] leading-relaxed"
                    placeholder="Paste your JSON here..."
                  />
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setJsonOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={handleSaveJson}>
                    Save Changes
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <div className="mx-1 h-4 w-px bg-border/40" />
          </>
        )}

        <ToolbarIconButton title="Zoom out" onClick={zoomOut}>
          <ZoomOut className="h-3.5 w-3.5" />
        </ToolbarIconButton>
        <Button variant="ghost" className="h-7 px-1.5 text-[10px] tabular-nums font-bold text-muted-foreground/80 hover:text-foreground transition-colors" onClick={resetZoom} title="Reset zoom">
          {zoomPct}%
        </Button>
        <ToolbarIconButton title="Zoom in" onClick={zoomIn}>
          <ZoomIn className="h-3.5 w-3.5" />
        </ToolbarIconButton>

        {!isReadonly && (
          <>
            <div className="mx-1 h-4 w-px bg-border/40" />

            <ToolbarIconButton title="Send to back" disabled={!selectedElementId} onClick={() => void sendToBack()}>
              <ArrowDownToLine className="h-3.5 w-3.5" />
            </ToolbarIconButton>
            <ToolbarIconButton title="Send backward" disabled={!selectedElementId} onClick={() => void sendBackward()}>
              <ChevronDown className="h-3.5 w-3.5" />
            </ToolbarIconButton>
            <ToolbarIconButton title="Bring forward" disabled={!selectedElementId} onClick={() => void bringForward()}>
              <ChevronDown className="h-3.5 w-3.5 rotate-180" />
            </ToolbarIconButton>
            <ToolbarIconButton title="Bring to front" disabled={!selectedElementId} onClick={() => void bringToFront()}>
              <ArrowUpToLine className="h-3.5 w-3.5" />
            </ToolbarIconButton>
          </>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-3 text-[10px] font-medium"
          disabled={!source}
          onClick={() => {
            if (!source) return;
            const blob = new Blob([JSON.stringify(source, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `${projectId}.json`;
            link.click();
            URL.revokeObjectURL(url);
          }}
        >
          Download JSON
        </Button>
      </div>
    </div>
  );
}

/**
 * Main Entry Point
 */
export function VideoEditorClient({
  projectId,
  showExitButton = true,
  isSplitView = false,
  isReadonly = false,
  shortcutsEnabled = true,
}: {
  projectId: string;
  
  showExitButton?: boolean;
  isSplitView?: boolean;
  isReadonly?: boolean;
  shortcutsEnabled?: boolean;
}) {
  return (
    <VideoEditorProvider shortcutsEnabled={shortcutsEnabled}>
       <VideoEditorLoader 
          projectId={projectId}
          showExitButton={showExitButton}
          isSplitView={isSplitView}
          isReadonly={isReadonly}
       />
    </VideoEditorProvider>
  );
}

// Inner component to handle data loading while already inside the Provider
function VideoEditorLoader({
  projectId,
  showExitButton = true,
  isSplitView = false,
  isReadonly = false,
}: {
  projectId: string;
  
  showExitButton?: boolean;
  isSplitView?: boolean;
  isReadonly?: boolean;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [directive, setDirective] = useState<ApiGetResponse['directive'] | null>(null);
  const [source, setSource] = useState<VideoSource | null>(null);
  const [assets, setAssets] = useState<ApiGetResponse['assets']>([]);

  const apiUrl = useMemo(
    () => `${MOVIE_EDITOR_API_BASE}/projects/${projectId}`,
    [projectId],
  );

  useEffect(() => {
    let cancelled = false;
    async function run() {
      // Only show full loading state on first load
      if (!source) setLoading(true);
      setError(null);
      try {
        const res = await fetch(apiUrl, { method: 'GET' });
        const data = (await res.json()) as ApiGetResponse | { error?: string };
        if (!res.ok) throw new Error((data as any)?.error || `Failed to load (${res.status})`);
        if (cancelled) return;
        
        let loadedSource = prepareSourceForPreview((data as ApiGetResponse).source as VideoSource);

        setDirective((data as ApiGetResponse).directive);
        setSource(loadedSource);
        setAssets((data as ApiGetResponse).assets ?? []);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Failed to load video project');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [apiUrl]);

  const handleSave = async (updatedSource: VideoSource) => {
      const res = await fetch(apiUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: updatedSource }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) throw new Error(data?.error || `Save failed (${res.status})`);

      if (data?.directive) setDirective(data.directive);

      // Update the baseline source immediately to prevent auto-save from re-triggering
      setSource(updatedSource);

      // Brief guard so overlapping requests (e.g. rapid edits) don't interleave oddly
      await new Promise((resolve) => setTimeout(resolve, 300));
  };

  if (loading) {
      return <div className="flex h-full items-center justify-center text-muted-foreground">Loading editor...</div>;
  }

  if (error) {
      return (
          <div className="flex h-full items-center justify-center text-destructive">
              Error: {error}
          </div>
      );
  }

  return (
        <VideoEditorUI 
            directive={directive} 
            assets={assets} 
            initialSource={source} 
            onSave={handleSave}
            projectId={projectId}
            showExitButton={showExitButton}
            isSplitView={isSplitView}
            isReadonly={isReadonly}
        />
  );
}
