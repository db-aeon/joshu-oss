import React, { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import { TimelineRuler } from './timeline-ruler';
import { TimelineTrack } from './timeline-track';
import { Playhead } from './playhead';
import { useVideoEditor } from '../editor-context';
import { Button } from '@/components/ui/button';
import { Play, Pause, ZoomIn, ZoomOut, Plus, Trash2 } from 'lucide-react';
import type { VideoElement } from '../types';
import { cn } from '@/lib/utils';

function TimeReadout() {
  const { timelineCurrentTime, timelineDuration } = useVideoEditor();
  const timeRef = useRef<HTMLSpanElement>(null);

  const formattedTime = (t: number) => {
    const mins = Math.floor(t / 60);
    const secs = Math.floor(t % 60);
    const ms = Math.floor((t % 1) * 100);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  };

  const formattedDuration = useMemo(() => {
    const d = timelineDuration || 0;
    const mins = Math.floor(d / 60);
    const secs = Math.floor(d % 60);
    const ms = Math.floor((d % 1) * 100);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  }, [timelineDuration]);

  // Handle high-speed updates via window event to avoid re-rendering the whole Timeline
  useEffect(() => {
    const handleScrub = (e: any) => {
      if (timeRef.current) {
        timeRef.current.textContent = formattedTime(e.detail.time);
      }
    };
    window.addEventListener('timeline-scrub', handleScrub);
    return () => window.removeEventListener('timeline-scrub', handleScrub);
  }, []);

  return (
    <div className="flex items-baseline gap-1.5 px-2 py-1 rounded bg-background/50 border border-border/40 shadow-sm">
      <span ref={timeRef} className="text-[11px] font-mono font-bold text-foreground tabular-nums">
        {formattedTime(timelineCurrentTime)}
      </span>
      <span className="text-[9px] font-mono text-muted-foreground/60">
        / {formattedDuration}
      </span>
    </div>
  );
}

export function Timeline({ isReadonly = false }: { isReadonly?: boolean }) {
  const { 
      currentElements,
      isPlaying, 
      setIsPlaying, 
      preview,
      timelineScale,
      setTimelineScale,
      dragOverTrack,
      draggedElementId,
      setTimelineTime,
      replaceCurrentElements,
      selectedElementId,
      selectElement,
  } = useVideoEditor();

  /** Track indices shown even with no clips (user added via "+"); dropped once elements use that track. */
  const [ghostTracks, setGhostTracks] = useState<number[]>([]);

  const tracks = useMemo(() => {
    const trackMap = new Map<number, VideoElement[]>();
    (currentElements ?? []).forEach((el) => {
      const t = el.track || 1;
      if (!trackMap.has(t)) trackMap.set(t, []);
      trackMap.get(t)?.push(el);
    });
    for (const t of ghostTracks) {
      if (!trackMap.has(t)) trackMap.set(t, []);
    }
    return Array.from(trackMap.entries()).sort((a, b) => b[0] - a[0]);
  }, [currentElements, ghostTracks]);

  // Ghost rows are only scaffolding; remove once that track has real elements.
  useEffect(() => {
    setGhostTracks((prev) =>
      prev.filter((t) => {
        const hasClip = (currentElements ?? []).some((el) => (el.track || 1) === t);
        return !hasClip;
      }),
    );
  }, [currentElements]);

  const handleAddTrack = useCallback(() => {
    const nums = [
      ...(currentElements ?? []).map((el) => el.track || 1),
      ...ghostTracks,
    ];
    const maxT = nums.length > 0 ? Math.max(...nums) : 0;
    setGhostTracks((prev) => (prev.includes(maxT + 1) ? prev : [...prev, maxT + 1]));
  }, [currentElements, ghostTracks]);

  const handleDeleteTrack = useCallback(
    async (trackNum: number, clipsOnTrack: VideoElement[]) => {
      if (clipsOnTrack.length === 0) {
        setGhostTracks((prev) => prev.filter((t) => t !== trackNum));
        return;
      }

      const ok = window.confirm(
        `Delete Track ${trackNum} and remove ${clipsOnTrack.length} clip${clipsOnTrack.length === 1 ? '' : 's'}? This cannot be undone.`,
      );
      if (!ok) return;

      const next = (currentElements ?? []).filter((el) => (el.track || 1) !== trackNum);
      await replaceCurrentElements(next);

      if (
        selectedElementId &&
        !next.some((el) => el.id === selectedElementId)
      ) {
        void selectElement(null);
      }
    },
    [currentElements, replaceCurrentElements, selectedElementId, selectElement],
  );

  const handleJumpToStart = useCallback(async () => {
    setIsPlaying(false);
    if (preview) {
      await preview.pause();
    }
    setTimelineTime(0);
    window.dispatchEvent(new CustomEvent('timeline-scrub', { detail: { time: 0 } }));
  }, [preview, setIsPlaying, setTimelineTime]);

  const handlePlayPause = async () => {
    if (!preview) return;
    if (isPlaying) {
      await preview.pause();
      setIsPlaying(false);
    } else {
      await preview.play();
      setIsPlaying(true);
    }
  };

  return (
    <div className="flex h-full flex-col border-t border-border bg-background">
      {/* Controls Bar */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-muted/40 px-2">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={handlePlayPause}>
            {isPlaying ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
            title="Jump to start"
            aria-label="Jump to start"
            onClick={() => void handleJumpToStart()}
          >
            <span className="font-mono text-[13px] font-semibold leading-none tabular-nums">|&lt;</span>
          </Button>
          <TimeReadout />
        </div>
        <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setTimelineScale(Math.max(10, timelineScale / 1.5))}>
                <ZoomOut className="h-3 w-3" />
            </Button>
            <span className="text-[10px] text-muted-foreground w-12 text-center">{Math.round(timelineScale)} px/s</span>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setTimelineScale(Math.min(500, timelineScale * 1.5))}>
                <ZoomIn className="h-3 w-3" />
            </Button>
        </div>
      </div>

      {/* Timeline Area */}
      <div className="relative flex-1 overflow-hidden">
        <div className="h-full w-full overflow-auto">
            <div className="flex min-w-max flex-col relative">
                {/* One Playhead to rule them all - spans from top of ruler to bottom of tracks */}
                <div className="absolute top-0 bottom-0 left-24 right-0 z-40 pointer-events-none">
                    <Playhead />
                </div>

                {/* Ruler Row */}
                <div className="flex sticky top-0 z-30 h-7 bg-background border-b border-border/50">
                    <div className="sticky left-0 z-40 flex h-full w-24 shrink-0 items-center justify-center border-r border-border/50 bg-background/95 px-1 backdrop-blur">
                        {!isReadonly ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                            title="Add track"
                            aria-label="Add track"
                            onClick={handleAddTrack}
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </Button>
                        ) : null}
                    </div>
                    <div className="flex-1">
                        <TimelineRuler />
                    </div>
                </div>

                {/* Tracks Area */}
                <div className="relative flex-1" data-tracks-container>
                    {/* Top Drop Zone (Insert New Track) */}
                    {draggedElementId && (
                        <div 
                            className={cn(
                                "absolute top-0 left-24 right-0 h-1 z-50 transition-all bg-primary shadow-[0_0_8px_rgba(59,130,246,0.5)]",
                                dragOverTrack === 9999 ? "opacity-100" : "opacity-0 pointer-events-none"
                            )}
                        />
                    )}

                    {tracks.map(([trackNum, elements]) => (
                        <div key={trackNum} className="flex min-h-[40px] relative">
                            {/* Drag Insertion Indicator (Between Tracks) */}
                            {/* We could add indicators between tracks here if we wanted to support inserting between specific tracks */}
                            
                            {/* Track Header (Left): hover shows delete for empty scaffolding or clears all clips on that track */}
                            <div className="group/track-header sticky left-0 z-30 flex w-24 shrink-0 min-h-[40px] flex-col justify-center border-b border-r border-border/50 bg-background/95 px-2 text-[10px] font-medium text-muted-foreground backdrop-blur">
                                <div className="flex items-center gap-1 pr-6">
                                  <span className="truncate" title={`Track ${trackNum}`}>
                                    Track {trackNum}
                                  </span>
                                </div>
                                {!isReadonly ? (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className={cn(
                                      'absolute right-0.5 top-1/2 h-7 w-7 -translate-y-1/2 text-muted-foreground hover:bg-destructive/15 hover:text-destructive',
                                      'opacity-0 transition-opacity duration-150 group-hover/track-header:opacity-100',
                                      'focus-visible:opacity-100',
                                    )}
                                    title={
                                      elements.length === 0
                                        ? 'Remove empty track'
                                        : `Delete track ${trackNum}`
                                    }
                                    aria-label={`Delete track ${trackNum}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void handleDeleteTrack(trackNum, elements);
                                    }}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                ) : null}
                            </div>
                            {/* Track Content */}
                            <div 
                                className={cn(
                                    "flex-1 relative bg-muted/5 border-b border-border/30 transition-colors",
                                    dragOverTrack === trackNum && "bg-primary/10 ring-1 ring-inset ring-primary/30"
                                )}
                                data-track-index={trackNum}
                            >
                                <TimelineTrack trackIndex={trackNum} elements={elements} isReadonly={isReadonly} />
                            </div>
                        </div>
                    ))}
                    
                    {/* Bottom Drop Zone (Insert New Track) */}
                    {draggedElementId && (
                        <div 
                            className={cn(
                                "absolute bottom-0 left-24 right-0 h-1 z-50 transition-all bg-primary shadow-[0_0_8px_rgba(59,130,246,0.5)]",
                                dragOverTrack === -1 ? "opacity-100" : "opacity-0 pointer-events-none"
                            )}
                        />
                    )}
                    
                    {tracks.length === 0 && (
                        <div className="flex">
                            <div className="sticky left-0 z-30 h-20 w-24 shrink-0 border-b border-r border-border/50 bg-background/95" />
                            <div className="flex-1 border-b border-border/30 bg-muted/5 p-8 text-center text-xs text-muted-foreground">
                                No tracks yet. Use + above to add a track, or add media from the toolbar.
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
      </div>
    </div>
  );
}
