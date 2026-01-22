/**
 * src/analysis/labelStorage.ts
 * 
 * Label storage and evaluation system for accuracy validation.
 * - Store ground-truth labels per video
 * - Compute error metrics against auto-detected events
 * - Nearest-neighbor matching with tolerance
 */

// Storage: use simple in-memory cache for now
// In production, would use expo-file-system for persistence
const labelCache: Map<string, VideoLabels> = new Map();

/**
 * Ground-truth label for a single event
 */
export interface Label {
  type: 'landing' | 'takeoff';
  tMs: number; // timestamp in milliseconds
  confidence?: number; // optional user confidence (0..1)
}

/**
 * All labels for a single video
 */
export interface VideoLabels {
  videoId: string; // hash of video URI or asset ID
  videoUri: string; // full video URI for reference
  labels: Label[]; // ground-truth events
  createdAt: number; // timestamp when labels created (ms)
  updatedAt: number; // last modification timestamp (ms)
}

/**
 * Auto-detected event from pipeline
 */
export interface AutoEvent {
  type: 'landing' | 'takeoff';
  tMs: number; // frame-based timestamp
  refinedTMs?: number; // edge-refined sub-frame timestamp (if available)
  confidence: number; // from pipeline
}

/**
 * Matched pair of label and auto event with detailed error info
 */
export interface MatchedPair {
  label: Label;
  auto: AutoEvent;
  errorMs: number; // auto.tMs - label.tMs (can be negative, positive, or zero)
  usedRefined: boolean; // whether refinedTMs was used in matching
}

/**
 * Result of evaluating auto against labels
 */
export interface EvaluationResult {
  videoId: string;
  labelCount: number;
  autoEventCount: number;
  matchedPairs: MatchedPair[];
  unmatchedLabels: Label[];
  unmatchedAuto: AutoEvent[];
  metrics: {
    landing: ErrorMetrics;
    takeoff: ErrorMetrics;
    gct: ErrorMetrics | null; // only if landing/takeoff pairs exist
    rejectRate: number; // fraction of videos where pipeline returned null metrics
  };
}

/**
 * Error metrics for a category (landing, takeoff, GCT)
 */
export interface ErrorMetrics {
  count: number; // number of matched pairs
  medianMs: number | null;
  p95Ms: number | null;
  minMs: number | null;
  maxMs: number | null;
  meanMs: number | null;
}

/**
 * Generate stable video ID from URI
 */
export function generateVideoId(videoUri: string): string {
  // Simple hash: sum of char codes % large prime
  let hash = 0;
  for (let i = 0; i < videoUri.length; i++) {
    hash += videoUri.charCodeAt(i) * (i + 1);
  }
  return `video_${Math.abs(hash).toString(36)}`;
}

/**
 * Load labels for a video
 */
export async function loadVideoLabels(videoUri: string): Promise<VideoLabels | null> {
  try {
    const videoId = generateVideoId(videoUri);
    return labelCache.get(videoId) ?? null;
  } catch (e) {
    console.error('[Labels] Error loading:', e);
    return null;
  }
}

/**
 * Save labels for a video
 */
export async function saveVideoLabels(videoUri: string, labels: Label[]): Promise<void> {
  try {
    const videoId = generateVideoId(videoUri);
    const now = Date.now();
    const existing = labelCache.get(videoId);
    
    const videoLabels: VideoLabels = {
      videoId,
      videoUri,
      labels,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    labelCache.set(videoId, videoLabels);
  } catch (e) {
    console.error('[Labels] Error saving:', e);
  }
}

/**
 * Add a single label
 */
export async function addLabel(videoUri: string, label: Label): Promise<void> {
  const existing = await loadVideoLabels(videoUri);
  const labels = existing?.labels ?? [];
  
  // Insert in sorted order by time
  const newLabels = [...labels, label].sort((a, b) => a.tMs - b.tMs);
  await saveVideoLabels(videoUri, newLabels);
}

/**
 * Clear all labels for a video
 */
export async function clearVideoLabels(videoUri: string): Promise<void> {
  try {
    const videoId = generateVideoId(videoUri);
    labelCache.delete(videoId);
  } catch (e) {
    console.error('[Labels] Error clearing:', e);
  }
}

/**
 * Match auto events to labels using nearest-neighbor within tolerance.
 * Prefers refined timestamps if available.
 */
function matchEvents(
  labels: Label[],
  autoEvents: AutoEvent[],
  toleranceMs: number = 30
): {
  matched: MatchedPair[];
  unmatchedLabels: Label[];
  unmatchedAuto: AutoEvent[];
} {
  const sortedLabels = [...labels].sort((a, b) => a.tMs - b.tMs);
  const sortedAuto = [...autoEvents].sort((a, b) => (a.refinedTMs ?? a.tMs) - (b.refinedTMs ?? b.tMs));
  const matched: MatchedPair[] = [];
  const usedLabels = new Set<number>();
  const usedAuto = new Set<number>();

  // For each label, find nearest auto within tolerance
  for (let i = 0; i < sortedLabels.length; i++) {
    const label = sortedLabels[i];
    let bestAuto = -1;
    let bestError = toleranceMs;
    let usedRefinedForBest = false;

    for (let j = 0; j < sortedAuto.length; j++) {
      if (usedAuto.has(j)) continue;

      const auto = sortedAuto[j];
      if (auto.type !== label.type) continue;

      // Prefer refined timestamp if available, otherwise use frame-based
      const autoTMs = auto.refinedTMs ?? auto.tMs;
      const error = Math.abs(autoTMs - label.tMs);
      
      if (error < bestError) {
        bestError = error;
        bestAuto = j;
        usedRefinedForBest = auto.refinedTMs !== undefined;
      }
    }

    if (bestAuto >= 0) {
      const autoEvent = sortedAuto[bestAuto];
      const errorMs = (autoEvent.refinedTMs ?? autoEvent.tMs) - label.tMs;
      
      matched.push({
        label,
        auto: autoEvent,
        errorMs,
        usedRefined: usedRefinedForBest,
      });
      usedLabels.add(i);
      usedAuto.add(bestAuto);
    }
  }

  const unmatchedLabels = sortedLabels.filter((_, i) => !usedLabels.has(i));
  const unmatchedAuto = sortedAuto.filter((_, i) => !usedAuto.has(i));

  return { matched, unmatchedLabels, unmatchedAuto };
}

/**
 * Compute error metrics from a list of signed errors (in ms)
 */
function computeErrorMetrics(errors: number[]): ErrorMetrics {
  if (errors.length === 0) {
    return {
      count: 0,
      medianMs: null,
      p95Ms: null,
      minMs: null,
      maxMs: null,
      meanMs: null,
    };
  }

  const sorted = [...errors].sort((a, b) => a - b);
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];

  const p95Index = Math.ceil(sorted.length * 0.95) - 1;
  const p95 = sorted[Math.max(0, p95Index)];

  const mean = errors.reduce((a, b) => a + b, 0) / errors.length;

  return {
    count: errors.length,
    medianMs: median,
    p95Ms: p95,
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    meanMs: mean,
  };
}

/**
 * Evaluate auto-detected events against ground-truth labels
 */
export function evaluateEvents(
  labels: Label[],
  autoEvents: AutoEvent[],
  toleranceMs: number = 30
): EvaluationResult {
  const { matched, unmatchedLabels, unmatchedAuto } = matchEvents(labels, autoEvents, toleranceMs);

  // Separate by type
  const landingMatches = matched.filter(m => m.label.type === 'landing');
  const takeoffMatches = matched.filter(m => m.label.type === 'takeoff');

  // Compute error metrics
  const landingErrors = landingMatches.map(m => m.auto.tMs - m.label.tMs);
  const takeoffErrors = takeoffMatches.map(m => m.auto.tMs - m.label.tMs);

  // Compute GCT error (pair adjacent landing/takeoff labels)
  let gctMetrics: ErrorMetrics | null = null;
  const gctErrors: number[] = [];

  const sortedLabels = [...labels].sort((a, b) => a.tMs - b.tMs);
  for (let i = 0; i < sortedLabels.length - 1; i++) {
    const curr = sortedLabels[i];
    const next = sortedLabels[i + 1];

    if (curr.type === 'landing' && next.type === 'takeoff') {
      // Find corresponding auto events
      const currAuto = matched.find(m => m.label === curr)?.auto;
      const nextAuto = matched.find(m => m.label === next)?.auto;

      if (currAuto && nextAuto) {
        const labelGct = next.tMs - curr.tMs;
        const autoGct = nextAuto.tMs - currAuto.tMs;
        gctErrors.push(autoGct - labelGct);
      }
    }
  }

  if (gctErrors.length > 0) {
    gctMetrics = computeErrorMetrics(gctErrors);
  }

  return {
    videoId: '', // will be set by caller
    labelCount: labels.length,
    autoEventCount: autoEvents.length,
    matchedPairs: matched,
    unmatchedLabels,
    unmatchedAuto,
    metrics: {
      landing: computeErrorMetrics(landingErrors),
      takeoff: computeErrorMetrics(takeoffErrors),
      gct: gctMetrics,
      rejectRate: 0, // set by caller if needed
    },
  };
}

/**
 * Format error metrics for display
 */
export function formatErrorMetrics(name: string, metrics: ErrorMetrics): string {
  if (metrics.count === 0) {
    return `${name}: 0 matches`;
  }

  const med = metrics.medianMs !== null ? `${Math.abs(metrics.medianMs).toFixed(1)}ms` : 'N/A';
  const p95 = metrics.p95Ms !== null ? `${Math.abs(metrics.p95Ms).toFixed(1)}ms` : 'N/A';
  
  return `${name} (n=${metrics.count}): median=${med}, p95=${p95}`;
}
