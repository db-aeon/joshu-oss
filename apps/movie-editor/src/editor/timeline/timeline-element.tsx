import React, { useRef, useState, useEffect, memo } from 'react';
import { useVideoEditor } from '../editor-context';
import type { VideoElement } from '../types';
import { cn } from '@/lib/utils';
import { TimelineAnimationElement } from './timeline-animation-element';
import { buildTimelineSnapMagnets, snapClipMove, snapScalar } from './timeline-snap';

interface TimelineElementProps {
  element: VideoElement;
  resolvedTime: number;
  resolvedDuration: number;
  isReadonly?: boolean;
}

/** Hover target track during drag; mirrors drop logic so snap magnets match where the clip will land. */
function getHoverTrackFromPoint(
  ev: MouseEvent,
  element: VideoElement,
  currentElements: VideoElement[],
): number {
  const elementsAtPoint = document.elementsFromPoint(ev.clientX, ev.clientY);
  const trackElement = elementsAtPoint.find((el) => el.hasAttribute('data-track-index'));
  if (trackElement) {
    return parseInt(trackElement.getAttribute('data-track-index') || '1', 10);
  }
  const tracksContainer = document.querySelector('[data-tracks-container]');
  if (tracksContainer && currentElements.length > 0) {
    const rect = tracksContainer.getBoundingClientRect();
    if (ev.clientY < rect.top) {
      return Math.max(...currentElements.map((el) => el.track || 1), 0) + 1;
    }
    if (ev.clientY > rect.bottom) {
      const tracks = currentElements.map((el) => el.track || 1);
      return Math.min(...tracks) - 1;
    }
  }
  return element.track || 1;
}

export const TimelineElement = memo(function TimelineElement({ element, resolvedTime, resolvedDuration, isReadonly = false }: TimelineElementProps) {
  const {
    timelineScale,
    selectedElementId,
    selectElement,
    replaceCurrentElements,
    currentElements,
    preview,
    setDraggedElementId,
    setDragOverTrack,
    enterComposition,
    mediaDurations,
    timelineDuration,
  } = useVideoEditor();

  const isSelected = selectedElementId === element.id;
  const elementRef = useRef<HTMLDivElement>(null);
  
  // Local state for smooth dragging
  const [localState, setLocalState] = useState({
    time: element.time ?? resolvedTime,
    duration: element.duration ?? resolvedDuration,
    yOffset: 0,
  });

  // Sync local state when external props change
  useEffect(() => {
    setLocalState({
      time: element.time ?? resolvedTime,
      duration: element.duration ?? resolvedDuration,
      yOffset: 0,
    });
  }, [element.time, element.duration, resolvedTime, resolvedDuration]);

  // Improved Drag Logic with Refs
  const dragStartRef = useRef<{
    startX: number;
    startY: number;
    startTime: number;
    /** Effective numeric duration for snapping while moving (clip length does not change during move). */
    startDuration: number;
  } | null>(null);

  const onDragMove = (e: React.MouseEvent) => {
    if (isReadonly) return;
    e.stopPropagation();
    e.preventDefault();
    void selectElement(element.id);
    setDraggedElementId(element.id!);

    dragStartRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startTime: localState.time,
      startDuration:
        typeof localState.duration === 'number' ? localState.duration : resolvedDuration,
    };

    const handleWindowMove = (ev: MouseEvent) => {
      if (!dragStartRef.current || !currentElements) return;
      const deltaX = ev.clientX - dragStartRef.current.startX;
      const deltaY = ev.clientY - dragStartRef.current.startY;
      const deltaTime = deltaX / timelineScale;
      const rawTime = Math.max(0, dragStartRef.current.startTime + deltaTime);
      const hoverTrack = getHoverTrackFromPoint(ev, element, currentElements);
      const magnets = buildTimelineSnapMagnets(
        currentElements,
        element.id!,
        hoverTrack,
        mediaDurations,
        timelineDuration,
      );
      const newTime = snapClipMove(
        rawTime,
        dragStartRef.current.startDuration,
        magnets,
        timelineScale,
      );

      setLocalState((prev) => ({ ...prev, time: newTime, yOffset: deltaY }));

      // Find track under cursor (highlights drop target)
      const elementsAtPoint = document.elementsFromPoint(ev.clientX, ev.clientY);
      const trackElement = elementsAtPoint.find(el => el.hasAttribute('data-track-index'));
      if (trackElement) {
        const trackIndex = parseInt(trackElement.getAttribute('data-track-index') || '0');
        setDragOverTrack(trackIndex);
      } else {
        const tracksContainer = document.querySelector('[data-tracks-container]');
        if (tracksContainer) {
            const rect = tracksContainer.getBoundingClientRect();
            if (ev.clientY < rect.top) {
                setDragOverTrack(9999); // Magic number for "Above All"
            } else if (ev.clientY > rect.bottom) {
                setDragOverTrack(-1); // Magic number for "Below All"
            } else {
                setDragOverTrack(null);
            }
        } else {
            setDragOverTrack(null);
        }
      }
    };

    const handleWindowUp = async (ev: MouseEvent) => {
        window.removeEventListener('mousemove', handleWindowMove);
        window.removeEventListener('mouseup', handleWindowUp);
        
        if (!dragStartRef.current) return;
        
        const deltaX = ev.clientX - dragStartRef.current.startX;
        const deltaY = ev.clientY - dragStartRef.current.startY;
        const deltaTime = deltaX / timelineScale;
        
        // Final Commit
        if (currentElements && preview) {
            const rawTime = Math.max(0, dragStartRef.current.startTime + deltaTime);
            const hoverTrack = getHoverTrackFromPoint(ev, element, currentElements);
            const magnets = buildTimelineSnapMagnets(
              currentElements,
              element.id!,
              hoverTrack,
              mediaDurations,
              timelineDuration,
            );
            const finalTime = snapClipMove(
              rawTime,
              dragStartRef.current.startDuration,
              magnets,
              timelineScale,
            );

            // Determine final track
            let finalTrack = element.track || 1;
            const elementsAtPoint = document.elementsFromPoint(ev.clientX, ev.clientY);
            const trackElement = elementsAtPoint.find(el => el.hasAttribute('data-track-index'));
            
            if (trackElement) {
                finalTrack = parseInt(trackElement.getAttribute('data-track-index') || '1');
            } else {
                const tracksContainer = document.querySelector('[data-tracks-container]');
                if (tracksContainer) {
                    const rect = tracksContainer.getBoundingClientRect();
                    if (ev.clientY < rect.top) {
                        const maxTrack = Math.max(...currentElements.map(el => el.track || 1), 0);
                        finalTrack = maxTrack + 1;
                    } else if (ev.clientY > rect.bottom) {
                        const tracks = currentElements.map(el => el.track || 1);
                        const minTrack = Math.min(...tracks);
                        finalTrack = minTrack - 1;
                    }
                }
            }

            const hasMoved = Math.abs(deltaX) > 1 || Math.abs(deltaY) > 5;
            
            if (hasMoved) {
                const newElements = currentElements.map(el => 
                    el.id === element.id ? { ...el, time: finalTime, track: finalTrack } : el
                );
                await replaceCurrentElements(newElements);
            }
        }
        
        setLocalState(prev => ({ ...prev, yOffset: 0 }));
        setDraggedElementId(null);
        setDragOverTrack(null);
        dragStartRef.current = null;
    };

    window.addEventListener('mousemove', handleWindowMove);
    window.addEventListener('mouseup', handleWindowUp);
  };

  // Resize Handle Logic
  const onResizeStart = (e: React.MouseEvent, side: 'start' | 'end') => {
      if (isReadonly) return;
      e.stopPropagation();
      e.preventDefault();
      void selectElement(element.id);

      const startX = e.clientX;
      const initialTime = localState.time;
      const initialDurationNum =
        typeof localState.duration === 'number' ? localState.duration : resolvedDuration;

      const anchorTrack = element.track || 1;
      const buildMagnets = () =>
        currentElements
          ? buildTimelineSnapMagnets(
              currentElements,
              element.id!,
              anchorTrack,
              mediaDurations,
              timelineDuration,
            )
          : [0];

      const handleMove = (ev: MouseEvent) => {
          if (!currentElements) return;
          const deltaX = ev.clientX - startX;
          const deltaTime = deltaX / timelineScale;
          const magnets = buildMagnets();

          if (side === 'end') {
              const rawEnd = initialTime + Math.max(0.1, initialDurationNum + deltaTime);
              const snappedEnd = snapScalar(rawEnd, magnets, timelineScale);
              const newDuration = Math.max(0.1, snappedEnd - initialTime);
              setLocalState((prev) => ({ ...prev, duration: newDuration }));
          } else {
              const rawStart = Math.max(0, initialTime + deltaTime);
              const snappedStart = snapScalar(rawStart, magnets, timelineScale);
              const newDuration = Math.max(0.1, initialDurationNum - (snappedStart - initialTime));
              setLocalState((prev) => ({
                ...prev,
                time: snappedStart,
                duration: newDuration,
              }));
          }
      };

      const handleUp = async (upEv: MouseEvent) => {
          window.removeEventListener('mousemove', handleMove);
          window.removeEventListener('mouseup', handleUp);

          const deltaX = upEv.clientX - startX;
          const deltaTime = deltaX / timelineScale;
          const magnets = buildMagnets();

          let finalTime = initialTime;
          let finalDuration = initialDurationNum;

          if (side === 'end') {
              const rawEnd = initialTime + Math.max(0.1, initialDurationNum + deltaTime);
              const snappedEnd = snapScalar(rawEnd, magnets, timelineScale);
              finalDuration = Math.max(0.1, snappedEnd - initialTime);
          } else {
              const rawStart = Math.max(0, initialTime + deltaTime);
              finalTime = snapScalar(rawStart, magnets, timelineScale);
              finalDuration = Math.max(0.1, initialDurationNum - (finalTime - initialTime));
          }

          if (currentElements && preview) {
               const newElements = currentElements.map(el => {
                 if (el.id !== element.id) return el;
                 
                 const updated = { ...el, duration: finalDuration };
                 
                 // If we moved the start, or it was already non-auto, keep/update the time
                 if (side === 'start' || el.time !== undefined) {
                     updated.time = finalTime;
                 }
                 
                 return updated;
               });
               await replaceCurrentElements(newElements);
          }
      };

      window.addEventListener('mousemove', handleMove);
      window.addEventListener('mouseup', handleUp);
  };

  const left = localState.time * timelineScale;
  const width = localState.duration * timelineScale;
  
  // Animations handling
  const animations = element.animations || [];
  const hasTransition = animations.some((a: any) => a.transition === true);
  const animationHeight = 20; // Height per animation row
  const totalHeight = 24 + (animations.length * animationHeight); // Base height + animations

  return (
    <div className="absolute top-1" style={{ height: `${totalHeight}px` }}>
        {/* Main Bar */}
        <div
          ref={elementRef}
          className={cn(
            "relative h-6 rounded border border-transparent bg-primary/80 text-primary-foreground shadow-sm transition-colors hover:bg-primary/90",
            isSelected && "border-white ring-1 ring-ring",
            hasTransition && "rounded-l-none border-l-0"
          )}
          style={{
            left: `${left}px`,
            width: `${width}px`,
            zIndex: localState.yOffset ? 100 : 10,
            transform: localState.yOffset ? `translateY(${localState.yOffset}px)` : undefined,
            transition: localState.yOffset ? 'none' : 'transform 0.2s ease-out, left 0.2s ease-out, width 0.2s ease-out',
          }}
          onMouseDown={onDragMove}
          onDoubleClick={() => {
            if (element.type === 'composition') {
              enterComposition(element.id);
            }
          }}
        >
          {/* Transition Curve Overlay */}
          {hasTransition && (
            <div 
              className="absolute -left-[1px] top-0 h-full w-4 overflow-hidden pointer-events-none"
              style={{ zIndex: 20 }}
            >
              <div className="h-full w-full bg-primary/80" style={{ clipPath: 'ellipse(100% 100% at 100% 50%)' }} />
              <div className="absolute left-[15px] top-0 bottom-0 w-[2px] bg-white/40 shadow-[0_0_8px_rgba(255,255,255,0.5)]" />
            </div>
          )}

          <div 
            className={cn(
              "absolute left-0 top-0 h-full w-2 hover:bg-white/20",
              !isReadonly ? "cursor-w-resize" : "pointer-events-none"
            )}
            onMouseDown={(e) => onResizeStart(e, 'start')}
          />

          <div className="flex h-full items-center overflow-hidden px-3 text-xs font-medium">
            <span className="truncate">
                {(element.time === undefined || element.duration === undefined) && (
                    <span className="opacity-60 mr-1.5 font-bold uppercase text-[10px]">Auto</span>
                )}
                {element.name || element.type}
            </span>
          </div>

          <div 
            className={cn(
              "absolute right-0 top-0 h-full w-2 hover:bg-white/20",
              !isReadonly ? "cursor-e-resize" : "pointer-events-none"
            )}
            onMouseDown={(e) => onResizeStart(e, 'end')}
          />
        </div>
        
        {/* Animation Bars (Indented/Below) */}
        {animations.map((anim: any, idx: number) => (
             <TimelineAnimationElement 
                key={idx} 
                element={element} 
                resolvedTime={localState.time}
                resolvedDuration={localState.duration}
                animation={anim} 
                animationIndex={idx}
                // We pass style prop to override position relative to this container
             />
        ))}
    </div>
  );
});
