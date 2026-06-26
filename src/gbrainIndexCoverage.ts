/**
 * Compare on-disk markdown vs gbrain indexed page totals.
 * Keep formula in sync with scripts/lib/gbrain-index-health.mjs (assessIndexCoverage).
 */

export function defaultMinCoverageRatio(): number {
  const raw = process.env.GBRAIN_INDEX_MIN_COVERAGE_RATIO?.trim();
  const parsed = raw ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : 0.5;
}

export type GbrainIndexCoverage = {
  hasDiskContent: boolean;
  hasIndexedContent: boolean;
  coverageOk: boolean;
  needsRecovery: boolean;
  healthy: boolean;
  minCoverageRatio: number;
};

export function assessGbrainIndexCoverage(
  diskMarkdown: number,
  indexedPages: number,
  opts: { minDiskFiles?: number; minCoverageRatio?: number } = {},
): GbrainIndexCoverage {
  const minDiskFiles = opts.minDiskFiles ?? 1;
  const minCoverageRatio = opts.minCoverageRatio ?? defaultMinCoverageRatio();

  const hasDiskContent = diskMarkdown >= minDiskFiles;
  const hasIndexedContent = indexedPages > 0;
  const coverageOk =
    diskMarkdown === 0 ||
    (hasIndexedContent && indexedPages >= diskMarkdown * minCoverageRatio);
  const needsRecovery = hasDiskContent && !coverageOk;

  return {
    hasDiskContent,
    hasIndexedContent,
    coverageOk,
    needsRecovery,
    healthy: !needsRecovery,
    minCoverageRatio,
  };
}

/** Instance health: indexed_ok when coverage is acceptable (not just non-zero). */
export function gbrainIndexedOk(diskMarkdown: number, indexedPages: number): boolean {
  return assessGbrainIndexCoverage(diskMarkdown, indexedPages).coverageOk;
}
