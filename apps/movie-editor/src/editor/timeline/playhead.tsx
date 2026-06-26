import React, { useRef, useEffect } from 'react';
import { useVideoEditor } from '../editor-context';

export function Playhead() {
  const {
    timelineCurrentTime,
    timelineDuration,
    timelineOffset,
    timelineScale,
    setTimelineTime,
    preview,
    setIsScrubbing,
  } = useVideoEditor();
  const playheadRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const lastIframeUpdateTimeRef = useRef<number>(0);
  const isDraggingRef = useRef(false);

  useEffect(() => {
    if (playheadRef.current && !isDraggingRef.current) {
      const x = timelineCurrentTime * timelineScale;
      playheadRef.current.style.transform = `translateX(${x}px)`;
    }
  }, [timelineCurrentTime, timelineScale]);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    
    // Parent container (the one with left-24)
    const parent = playheadRef.current?.parentElement;
    if (!parent) return;

    isDraggingRef.current = true;
    setIsScrubbing(true);

    const updateTime = (clientX: number) => {
      if (animationFrameRef.current) return;

      animationFrameRef.current = requestAnimationFrame(() => {
        const rect = parent.getBoundingClientRect();
        
        // Local x position relative to the tracks area
        const x = clientX - rect.left;
        const newTime = Math.max(0, Math.min(x / timelineScale, timelineDuration));
        
        // 1. Move line
        if (playheadRef.current) {
          playheadRef.current.style.transform = `translateX(${newTime * timelineScale}px)`;
        }

        // 2. Update readout
        window.dispatchEvent(new CustomEvent('timeline-scrub', { detail: { time: newTime } }));

        // 3. Update preview (throttled)
        const now = Date.now();
        if (preview && (now - lastIframeUpdateTimeRef.current > 32)) {
          lastIframeUpdateTimeRef.current = now;
          void preview.setTime(timelineOffset + newTime);
        }

        animationFrameRef.current = null;
      });
    };

    const handleMouseMove = (ev: MouseEvent) => updateTime(ev.clientX);
    
    const handleMouseUp = (ev: MouseEvent) => {
      isDraggingRef.current = false;
      setIsScrubbing(false);
      
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      
      const rect = parent.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const finalTime = Math.max(0, Math.min(x / timelineScale, timelineDuration));
      setTimelineTime(finalTime);

      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  return (
    <div
      ref={playheadRef}
      className="absolute top-0 z-50 h-full w-px bg-red-600 pointer-events-none will-change-transform"
    >
      <div 
        className="absolute -left-[6px] -top-0.5 pointer-events-auto cursor-ew-resize group"
        onMouseDown={handleMouseDown}
      >
        <svg width="13" height="15" viewBox="0 0 13 15" fill="none" xmlns="http://www.w3.org/2000/svg" className="drop-shadow-sm">
          <path d="M0 2C0 0.895431 0.895431 0 2 0H11C12.1046 0 13 0.895431 13 2V9.58579C13 10.1162 12.7893 10.6249 12.4142 11L7.12132 14.2929C6.7308 14.6834 6.09763 14.6834 5.70711 14.2929L0.585786 11C0.210714 10.6249 0 10.1162 0 9.58579V2Z" fill="#DC2626"/>
        </svg>
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-0.5 h-1.5 bg-white/30 rounded-full mt-1" />
      </div>
    </div>
  );
}
