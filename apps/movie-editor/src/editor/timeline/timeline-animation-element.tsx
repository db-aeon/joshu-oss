import React, { useRef, useState, useEffect, memo } from 'react';
import { useVideoEditor } from '../editor-context';
import type { VideoElement } from '../types';
import { cn } from '@/lib/utils';

interface TimelineAnimationElementProps {
  element: VideoElement;
  resolvedTime: number;
  resolvedDuration: number;
  animation: any;
  animationIndex: number;
}

export const TimelineAnimationElement = memo(function TimelineAnimationElement({ 
  element, 
  resolvedTime,
  resolvedDuration,
  animation, 
  animationIndex 
}: TimelineAnimationElementProps) {
  const {
    timelineScale,
    currentElements,
    preview,
    replaceCurrentElements,
  } = useVideoEditor();
  
  const elementStartTime = resolvedTime;
  
  const [localState, setLocalState] = useState({
    time: typeof animation.time === 'number' ? animation.time : (animation.time === 'start' ? 0 : resolvedDuration - (animation.duration || 1)),
    duration: animation.duration || 1,
  });

  useEffect(() => {
     // Re-sync if props change
     const t = typeof animation.time === 'number' ? animation.time : (animation.time === 'start' ? 0 : resolvedDuration - (animation.duration || 1));
     setLocalState({
         time: t,
         duration: animation.duration || 1,
     });
  }, [animation, resolvedDuration]);

  const dragStartRef = useRef<{ startX: number; startTime: number } | null>(null);

  const onDragStart = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    
    dragStartRef.current = {
      startX: e.clientX,
      startTime: localState.time,
    };

    const handleMouseMove = (ev: MouseEvent) => {
      if (!dragStartRef.current) return;
      const deltaX = ev.clientX - dragStartRef.current.startX;
      const deltaTime = deltaX / timelineScale;
      const newTime = Math.max(0, dragStartRef.current.startTime + deltaTime);
      setLocalState(prev => ({ ...prev, time: newTime }));
    };

    const handleMouseUp = async (ev: MouseEvent) => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      
      if (!dragStartRef.current) return;
      
      const deltaX = ev.clientX - dragStartRef.current.startX;
      const deltaTime = deltaX / timelineScale;
      const finalTime = Math.max(0, dragStartRef.current.startTime + deltaTime);
      
      dragStartRef.current = null;
      
      if (currentElements && preview) {
           const animations = element.animations ? [...element.animations] : [];
           animations[animationIndex] = { ...animations[animationIndex], time: finalTime };
           
           const newElements = currentElements.map(el => 
               el.id === element.id ? { ...el, animations } : el
           );

           await replaceCurrentElements(newElements);
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };
  
  const left = (elementStartTime + localState.time) * timelineScale;
  const width = localState.duration * timelineScale;
  const isTransition = animation.transition === true;

  return (
    <div
      className={cn(
        "absolute flex items-center justify-between text-xs text-foreground cursor-pointer transition-colors hover:text-primary",
        isTransition ? "opacity-100" : "rounded border border-transparent bg-transparent opacity-100 hover:opacity-100"
      )}
      style={{
        left: `${left}px`,
        width: `${width}px`,
        height: '20px',
        top: '24px', 
      }}
      onMouseDown={onDragStart}
    >
      {/* Start Keyframe */}
      <div className={cn(
        "h-3 w-3 rounded-full border-2 border-foreground/50 bg-background z-10",
        isTransition && "bg-[#4a4a4a] border-[#4a4a4a]"
      )} />
      
      {/* Label */}
      <span className={cn(
        "truncate px-2 text-[10px] font-bold z-10 bg-background/50 rounded-sm backdrop-blur-[2px]",
        isTransition ? "text-foreground uppercase tracking-wider" : "opacity-70"
      )}>
          {animation.type}
      </span>

      {/* End Keyframe */}
      <div className={cn(
        "h-3 w-3 rounded-full border-2 border-foreground/50 bg-background z-10",
        isTransition && "bg-white border-[#4a4a4a]"
      )} />
      
      {/* Visual connecting line behind */}
      <div className={cn(
        "absolute left-1.5 right-1.5 top-1/2 -z-0 h-[2px] -translate-y-1/2",
        isTransition ? "bg-foreground/40" : "bg-current opacity-30 h-px"
      )} />
    </div>
  );
});
