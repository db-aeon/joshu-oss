import React, { memo } from 'react';
import { TimelineElement } from './timeline-element';
import type { VideoElement } from '../types';
import { useVideoEditor } from '../editor-context';
import { getMediaDurationKey } from '@/lib/media-duration';

interface TimelineTrackProps {
  trackIndex: number;
  elements: VideoElement[];
  isReadonly?: boolean;
}

export const TimelineTrack = memo(function TimelineTrack({ trackIndex, elements, isReadonly = false }: TimelineTrackProps) {
  const { mediaDurations, timelineDuration: containerDuration } = useVideoEditor();

  // Calculate max height based on elements and their animations
  // Standard height is 40px (h-10)
  // Each animation adds 20px
  
  const maxAnimations = Math.max(0, ...elements.map(e => e.animations?.length || 0));
  const height = 40 + (maxAnimations * 20); // 24px base bar + 16px padding/space? 
  
  // Calculate resolved times for each element
  let currentTime = 0;
  
  // Sort elements by time if available, otherwise preserve order
  const sortedElements = [...elements].sort((a, b) => {
    const timeA = a.time ?? -1;
    const timeB = b.time ?? -1;
    if (timeA !== -1 && timeB !== -1) return timeA - timeB;
    return 0; // Keep relative order for "auto" elements
  });

  const elementsWithResolvedTimes = sortedElements.map((element, index) => {
    // Check for transition in animations
    const transitionAnim = element.animations?.find((a: any) => a.transition === true);
    const transitionDuration = transitionAnim?.duration || 0;
    
    let resolvedTime = element.time ?? currentTime;
    
    // Apply overlap if it's an "auto" element with a transition
    if (transitionAnim && element.time === undefined && index > 0) {
      resolvedTime = Math.max(0, currentTime - transitionDuration);
    }
    
    // Resolve duration: use explicit, then cached, then filler/default
    let resolvedDuration = element.duration;
    if (resolvedDuration === undefined && element.source) {
      const mediaKey = getMediaDurationKey(element.source);
      if (mediaKey) {
        resolvedDuration = mediaDurations[mediaKey];
      }
    }

    if (resolvedDuration === undefined && elements.length === 1) {
      // Auto elements on a solo track inherit the current scope duration.
      // When drilled into a composition, that means the composition duration.
      resolvedDuration = containerDuration;
    } else {
      resolvedDuration = resolvedDuration ?? 5;
    }

    currentTime = resolvedTime + resolvedDuration;
    
    return { element, resolvedTime, resolvedDuration };
  });

  return (
    <div 
        className="relative w-full border-b border-border/50 bg-card/50 transition-colors hover:bg-card"
        style={{ height: `${height}px` }}
    >
      {elementsWithResolvedTimes.map(({ element, resolvedTime, resolvedDuration }, idx) => (
        <TimelineElement 
          key={element.id ? `${element.id}-${idx}` : `el-${idx}`} 
          element={element} 
          resolvedTime={resolvedTime}
          resolvedDuration={resolvedDuration}
          isReadonly={isReadonly}
        />
      ))}
    </div>
  );
});

