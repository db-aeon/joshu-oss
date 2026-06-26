import type { VideoElement } from '../types';
import { resolveTrackLayout } from '../editor-context';

/** Visual snap radius in screen pixels (converted to seconds via timeline scale). */
const SNAP_PX = 10;

/**
 * Collect timeline "magnets" (seconds) from clip start/end on the same track and ±1 adjacent track.
 * Excludes `excludeId` so the dragged/resized clip does not snap to its own previous layout.
 */
export function buildTimelineSnapMagnets(
  elements: VideoElement[],
  excludeId: string,
  anchorTrack: number,
  mediaDurations: Record<string, number>,
  containerDuration: number,
): number[] {
  const filtered = elements.filter((e) => e.id !== excludeId);
  const { resolved } = resolveTrackLayout(filtered, mediaDurations, containerDuration);
  const allowedTracks = new Set([anchorTrack - 1, anchorTrack, anchorTrack + 1]);
  const magnets = new Set<number>([0]);

  for (const el of filtered) {
    const tr = el.track || 1;
    if (!allowedTracks.has(tr)) continue;
    const b = resolved.get(el.id!);
    if (!b) continue;
    magnets.add(b.resolvedTime);
    magnets.add(b.resolvedTime + b.resolvedDuration);
  }
  return Array.from(magnets);
}

function snapThresholdSec(timelineScale: number, snapPx = SNAP_PX): number {
  return snapPx / Math.max(timelineScale, 0.001);
}

/**
 * When moving a clip, snap its start or end (whichever edge is closer to a magnet within range).
 */
export function snapClipMove(
  startSec: number,
  durationSec: number,
  magnets: number[],
  timelineScale: number,
  snapPx = SNAP_PX,
): number {
  if (!magnets.length || durationSec <= 0) return Math.max(0, startSec);
  const th = snapThresholdSec(timelineScale, snapPx);
  const endSec = startSec + durationSec;
  let bestStart = startSec;
  let bestDist = th + 1;

  for (const m of magnets) {
    const dStart = Math.abs(startSec - m);
    if (dStart <= th && dStart < bestDist) {
      bestDist = dStart;
      bestStart = m;
    }
    const dEnd = Math.abs(endSec - m);
    if (dEnd <= th && dEnd < bestDist) {
      bestDist = dEnd;
      bestStart = m - durationSec;
    }
  }
  return Math.max(0, bestStart);
}

/**
 * Snap a single time value (e.g. trim start, or trim end as absolute time).
 */
export function snapScalar(
  valueSec: number,
  magnets: number[],
  timelineScale: number,
  snapPx = SNAP_PX,
): number {
  if (!magnets.length) return valueSec;
  const th = snapThresholdSec(timelineScale, snapPx);
  let best = valueSec;
  let bestDist = th + 1;
  for (const m of magnets) {
    const d = Math.abs(valueSec - m);
    if (d <= th && d < bestDist) {
      bestDist = d;
      best = m;
    }
  }
  return best;
}
