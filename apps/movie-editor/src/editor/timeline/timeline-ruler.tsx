import React, { useRef, useEffect } from 'react';
import { useVideoEditor } from '../editor-context';

export function TimelineRuler() {
  const {
    timelineDuration,
    timelineOffset,
    timelineScale,
    setTimelineTime,
    preview,
    setIsScrubbing,
  } = useVideoEditor();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const lastIframeUpdateTimeRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = (timelineDuration + 1) * timelineScale; 
    const height = 28;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    ctx.font = '500 9px sans-serif';
    ctx.fillStyle = '#94a3b8'; // text-slate-400
    ctx.textAlign = 'left';

    const step = timelineScale >= 200 ? 0.1 : timelineScale >= 100 ? 0.25 : timelineScale >= 50 ? 0.5 : 1;

    for (let t = 0; t <= timelineDuration + step; t += step) {
      const x = t * timelineScale;
      const isSecond = Math.abs(t % 1) < 0.001;
      const isHalfSecond = Math.abs(t % 0.5) < 0.001;
      
      ctx.beginPath();
      ctx.moveTo(x, height);
      if (isSecond) {
        ctx.lineTo(x, height - 12);
        ctx.strokeStyle = '#94a3b8';
      } else if (isHalfSecond) {
        ctx.lineTo(x, height - 8);
        ctx.strokeStyle = '#cbd5e1';
      } else {
        ctx.lineTo(x, height - 4);
        ctx.strokeStyle = '#e2e8f0';
      }
      ctx.lineWidth = 1;
      ctx.stroke();

      if (isSecond) {
        ctx.fillText(`${Math.round(t)}s`, x + 4, height - 14);
      }
    }
  }, [timelineDuration, timelineScale]);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!canvasRef.current) return;

    setIsScrubbing(true);

    const updateTime = (clientX: number) => {
        if (animationFrameRef.current) return;

        animationFrameRef.current = requestAnimationFrame(() => {
            const rect = canvasRef.current!.getBoundingClientRect();
            
            // X position relative to the ruler content
            const x = clientX - rect.left;
            const newTime = Math.max(0, Math.min(x / timelineScale, timelineDuration));
            
            // 1. Update readout
            window.dispatchEvent(new CustomEvent('timeline-scrub', { detail: { time: newTime } }));

            // 2. Update preview (throttled)
            const now = Date.now();
            if (preview && (now - lastIframeUpdateTimeRef.current > 32)) {
                 lastIframeUpdateTimeRef.current = now;
                 void preview.setTime(timelineOffset + newTime);
            }
            animationFrameRef.current = null;
        });
    };

    updateTime(e.clientX);

    const handleMouseMove = (ev: MouseEvent) => updateTime(ev.clientX);
    
    const handleMouseUp = (ev: MouseEvent) => {
        setIsScrubbing(false);
        if (animationFrameRef.current) {
          cancelAnimationFrame(animationFrameRef.current);
          animationFrameRef.current = null;
        }
        
        const rect = canvasRef.current!.getBoundingClientRect();
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
    <div className="h-full w-full cursor-pointer bg-muted/5" onMouseDown={handleMouseDown}>
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}
