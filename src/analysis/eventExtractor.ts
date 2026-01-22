/**
 * Event extraction from contact state transitions.
 * Converts binary contact state array (0|1) into discrete landing/takeoff events,
 * computes GCT and flight time, applies plausibility bounds.
 *
 * Pipeline:
 * 1. Find state transitions (0→1 landings, 1→0 takeoffs)
 * 2. Refine timing using edge detection (max derivative or level crossing)
 * 3. Apply plausibility bounds (GCT, flight time, intervals)
 * 4. Compute metrics (GCT, flight time, medians)
 */

import { refineLandingEdge, refineTakeoffEdge } from './edgeRefinement';

export interface JumpEvent {
  tMs: number;
  frameIndex: number;
  refinedTMs?: number; // Sub-frame refined timestamp (if available)
  subFrameOffsetMs?: number; // Offset from frame quantum
}

export interface Hop {
  landingMs: number;
  takeoffMs: number;
  gctMs: number; // Ground contact time
  flightMs: number | null; // Time from takeoff to next landing (null if incomplete)
}

export interface JumpEvents {
  landings: JumpEvent[];
  takeoffs: JumpEvent[];
  hops: Hop[];
  summary: {
    medianGctMs: number | null;
    medianFlightMs: number | null;
    p95GctMs: number | null;
    p95FlightMs: number | null;
    hopCount: number;
  };
  confidence: number; // 0..1
  diagnostics: {
    rejectedTransitions: number;
    reasons: Record<string, number>;
    rejection?: {
      code: string;
      stage: 'event_extraction';
      reason: string;
    };
  };
}

export interface EventExtractorOptions {
  minGctMs?: number; // default 50 ms
  maxGctMs?: number; // default 450 ms
  minFlightMs?: number; // default 100 ms
  maxFlightMs?: number; // default 900 ms
  minIntervalMs?: number; // minimum time between consecutive events (default 50 ms)
  refinementMethod?: 'max_derivative' | 'level_crossing'; // default 'max_derivative'
  refinementWindowFrames?: number; // frames before/after transition (default 3)
}

/**
 * Find all transitions in contact state.
 */
function findTransitions(
  state: (0 | 1)[],
  timestamps: number[]
): { frameIndex: number; tMs: number; from: 0 | 1; to: 0 | 1 }[] {
  const transitions: { frameIndex: number; tMs: number; from: 0 | 1; to: 0 | 1 }[] = [];

  for (let i = 1; i < state.length; i++) {
    if (state[i] !== state[i - 1]) {
      transitions.push({
        frameIndex: i,
        tMs: timestamps[i],
        from: state[i - 1],
        to: state[i],
      });
    }
  }

  return transitions;
}

/**
 * Extract landing events (0→1 transitions) with optional edge refinement.
 */
function extractLandings(
  transitions: { frameIndex: number; tMs: number; from: 0 | 1; to: 0 | 1 }[],
  state: (0 | 1)[],
  smoothedScores: number[],
  timestamps: number[],
  options: Required<EventExtractorOptions>
): JumpEvent[] {
  const landings: JumpEvent[] = [];

  for (const t of transitions) {
    if (t.from !== 0 || t.to !== 1) continue; // Only 0→1

    let refinedTMs = t.tMs;
    let subFrameOffsetMs: number | undefined;

    // Try edge refinement if smoothed scores available
    if (smoothedScores.length === state.length && smoothedScores.length > 0) {
      try {
        const refined = refineLandingEdge(smoothedScores, t.frameIndex, timestamps, {
          method: options.refinementMethod,
          windowFrames: options.refinementWindowFrames,
        });
        refinedTMs = refined.refinedTMs;
        subFrameOffsetMs = refined.subFrameOffsetMs || undefined;
      } catch {
        // If refinement fails, use original timestamp
      }
    }

    landings.push({
      tMs: refinedTMs,
      frameIndex: t.frameIndex,
      refinedTMs: subFrameOffsetMs !== undefined ? refinedTMs : undefined,
      subFrameOffsetMs,
    });
  }

  return landings;
}

/**
 * Extract takeoff events (1→0 transitions) with optional edge refinement.
 */
function extractTakeoffs(
  transitions: { frameIndex: number; tMs: number; from: 0 | 1; to: 0 | 1 }[],
  state: (0 | 1)[],
  smoothedScores: number[],
  timestamps: number[],
  options: Required<EventExtractorOptions>
): JumpEvent[] {
  const takeoffs: JumpEvent[] = [];

  for (const t of transitions) {
    if (t.from !== 1 || t.to !== 0) continue; // Only 1→0

    let refinedTMs = t.tMs;
    let subFrameOffsetMs: number | undefined;

    // Try edge refinement if smoothed scores available
    if (smoothedScores.length === state.length && smoothedScores.length > 0) {
      try {
        const refined = refineTakeoffEdge(smoothedScores, t.frameIndex, timestamps, {
          method: options.refinementMethod,
          windowFrames: options.refinementWindowFrames,
        });
        refinedTMs = refined.refinedTMs;
        subFrameOffsetMs = refined.subFrameOffsetMs || undefined;
      } catch {
        // If refinement fails, use original timestamp
      }
    }

    takeoffs.push({
      tMs: refinedTMs,
      frameIndex: t.frameIndex,
      refinedTMs: subFrameOffsetMs !== undefined ? refinedTMs : undefined,
      subFrameOffsetMs,
    });
  }

  return takeoffs;
}

/**
 * Pair landings with takeoffs to form hops.
 * Enforces minimum interval between consecutive events.
 */
function pairLandingsAndTakeoffs(
  landings: JumpEvent[],
  takeoffs: JumpEvent[],
  minIntervalMs: number = 50
): { hops: Hop[]; reasons: Record<string, number> } {
  const hops: Hop[] = [];
  const reasons: Record<string, number> = {};

  if (landings.length === 0 || takeoffs.length === 0) {
    reasons['no_events'] = 1;
    return { hops, reasons };
  }

  let landingIdx = 0;
  let takeoffIdx = 0;
  let lastEventTMs = -Infinity; // Track last event time to enforce minInterval

  while (landingIdx < landings.length && takeoffIdx < takeoffs.length) {
    const landing = landings[landingIdx];
    const takeoff = takeoffs[takeoffIdx];

    // Check if enough time since last event
    if (landing.tMs < lastEventTMs + minIntervalMs) {
      reasons['landing_too_close'] = (reasons['landing_too_close'] ?? 0) + 1;
      landingIdx++;
      continue;
    }

    // Takeoff must come after landing
    if (takeoff.tMs > landing.tMs && takeoff.tMs >= lastEventTMs + minIntervalMs) {
      const gctMs = takeoff.tMs - landing.tMs;
      hops.push({
        landingMs: landing.tMs,
        takeoffMs: takeoff.tMs,
        gctMs,
        flightMs: null, // Will fill in next pass
      });

      lastEventTMs = takeoff.tMs;
      landingIdx++;
      takeoffIdx++;
    } else if (takeoff.tMs <= landing.tMs) {
      // Takeoff before landing; skip this takeoff
      takeoffIdx++;
      reasons['takeoff_before_landing'] = (reasons['takeoff_before_landing'] ?? 0) + 1;
    } else {
      // Takeoff too close to last event
      takeoffIdx++;
      reasons['takeoff_too_close'] = (reasons['takeoff_too_close'] ?? 0) + 1;
    }
  }

  return { hops, reasons };
}

/**
 * Compute flight times by pairing each takeoff with the next landing.
 */
function computeFlightTimes(hops: Hop[], landings: JumpEvent[]): Hop[] {
  return hops.map((hop, idx) => {
    const nextLanding = landings.find((l) => l.tMs > hop.takeoffMs);
    if (nextLanding) {
      const flightMs = nextLanding.tMs - hop.takeoffMs;
      return { ...hop, flightMs };
    }
    return hop;
  });
}

/**
 * Apply plausibility bounds and reject invalid hops.
 */
function applyPlausibilityBounds(
  hops: Hop[],
  options: Required<EventExtractorOptions>
): { validHops: Hop[]; rejectedCount: number; reasons: Record<string, number> } {
  const reasons: Record<string, number> = {};
  let rejectedCount = 0;

  const validHops = hops.filter((hop) => {
    // Check GCT bounds
    if (hop.gctMs < options.minGctMs) {
      reasons['gct_too_short'] = (reasons['gct_too_short'] ?? 0) + 1;
      rejectedCount++;
      return false;
    }

    if (hop.gctMs > options.maxGctMs) {
      reasons['gct_too_long'] = (reasons['gct_too_long'] ?? 0) + 1;
      rejectedCount++;
      return false;
    }

    // Check flight bounds (if available)
    if (hop.flightMs !== null) {
      if (hop.flightMs < options.minFlightMs) {
        reasons['flight_too_short'] = (reasons['flight_too_short'] ?? 0) + 1;
        rejectedCount++;
        return false;
      }

      if (hop.flightMs > options.maxFlightMs) {
        reasons['flight_too_long'] = (reasons['flight_too_long'] ?? 0) + 1;
        rejectedCount++;
        return false;
      }
    }

    return true;
  });

  return { validHops, rejectedCount, reasons };
}

/**
 * Compute median of numeric array.
 */
function median(values: number[]): number | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }

  return sorted[mid];
}

/**
 * Compute 95th percentile of numeric array.
 * Returns null if fewer than 2 values.
 */
function percentile95(values: number[]): number | null {
  if (values.length < 2) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const p95Index = Math.ceil((sorted.length - 1) * 0.95);
  return sorted[Math.min(p95Index, sorted.length - 1)];
}

/**
 * Compute confidence based on hop count, plausibility, and stability.
 */
function computeConfidence(
  hopCount: number,
  rejectedCount: number,
  totalTransitions: number
): number {
  if (hopCount === 0) return 0;

  // Hop count confidence (more hops = higher confidence, but plateaus)
  const hopConfidence = Math.min(1, hopCount / 3);

  // Plausibility pass rate
  const validRate =
    hopCount + rejectedCount > 0 ? hopCount / (hopCount + rejectedCount) : 0;

  // Transitions confidence (many valid transitions = stable)
  const transitionConfidence = totalTransitions > 0 ? Math.min(1, hopCount / totalTransitions) : 0;

  // Combined: weight equally
  return (hopConfidence + validRate + transitionConfidence) / 3;
}

/**
 * Extract jump events from contact state, with edge refinement and plausibility bounds.
 *
 * @param state Binary contact state (0=not touching, 1=touching)
 * @param state Binary contact state (0=not touching, 1=touching)
 * @param timestampsMs Frame timestamps in milliseconds (must match state length)
 * @param options Event extractor configuration
 * @param smoothedScores Optional smoothed contact confidence scores [0..1] for edge refinement
 * @returns JumpEvents with landings, takeoffs, hops, and diagnostics
 */
export function extractJumpEvents(
  state: (0 | 1)[],
  timestampsMs: number[],
  options?: EventExtractorOptions,
  smoothedScores?: number[]
): JumpEvents {
  // Default options
  const opts: Required<EventExtractorOptions> = {
    minGctMs: options?.minGctMs ?? 50,
    maxGctMs: options?.maxGctMs ?? 450,
    minFlightMs: options?.minFlightMs ?? 100,
    maxFlightMs: options?.maxFlightMs ?? 900,
    minIntervalMs: options?.minIntervalMs ?? 50,
    refinementMethod: options?.refinementMethod ?? 'max_derivative',
    refinementWindowFrames: options?.refinementWindowFrames ?? 3,
  };

  if (state.length !== timestampsMs.length) {
    return {
      landings: [],
      takeoffs: [],
      hops: [],
      summary: {
        medianGctMs: null,
        medianFlightMs: null,
        p95GctMs: null,
        p95FlightMs: null,
        hopCount: 0,
      },
      confidence: 0,
      diagnostics: {
        rejectedTransitions: 0,
        reasons: { state_timestamp_mismatch: 1 },
        rejection: {
          code: 'INTERNAL',
          stage: 'event_extraction',
          reason: 'state/timestamp length mismatch',
        },
      },
    };
  }

  if (state.length === 0 || timestampsMs.length === 0) {
    return {
      landings: [],
      takeoffs: [],
      hops: [],
      summary: {
        medianGctMs: null,
        medianFlightMs: null,
        p95GctMs: null,
        p95FlightMs: null,
        hopCount: 0,
      },
      confidence: 0,
      diagnostics: {
        rejectedTransitions: 0,
        reasons: {},
      },
    };
  }

  const timestamps = timestampsMs;

  // 1. Find all transitions
  const transitions = findTransitions(state, timestamps);

  // 2. Extract landing (0→1) and takeoff (1→0) events with edge refinement
  const landings = extractLandings(
    transitions,
    state,
    smoothedScores || [],
    timestamps,
    opts
  );
  const takeoffs = extractTakeoffs(
    transitions,
    state,
    smoothedScores || [],
    timestamps,
    opts
  );

  // 3. Pair landings with takeoffs to form hops
  const { hops: pairedHops, reasons: pairingReasons } = pairLandingsAndTakeoffs(
    landings,
    takeoffs,
    opts.minIntervalMs
  );

  // 4. Compute flight times
  const hopsWithFlight = computeFlightTimes(pairedHops, landings);

  // 5. Apply plausibility bounds
  const { validHops, rejectedCount, reasons: boundReasons } = applyPlausibilityBounds(
    hopsWithFlight,
    opts
  );

  // 6. Validate hop ordering invariant
  const invalidHopOrder = pairedHops.some((hop) => !(hop.landingMs < hop.takeoffMs));
  if (invalidHopOrder) {
    return {
      landings,
      takeoffs,
      hops: [],
      summary: {
        medianGctMs: null,
        medianFlightMs: null,
        p95GctMs: null,
        p95FlightMs: null,
        hopCount: 0,
      },
      confidence: 0,
      diagnostics: {
        rejectedTransitions: rejectedCount,
        reasons: {
          ...pairingReasons,
          ...boundReasons,
          invalid_hop_order: 1,
        },
        rejection: {
          code: 'INTERNAL',
          stage: 'event_extraction',
          reason: 'invalid hop ordering',
        },
      },
    };
  }

  // 7. Compute summary statistics
  const gctValues = validHops.map((h) => h.gctMs);
  const flightValues = validHops
    .map((h) => h.flightMs)
    .filter((f) => f !== null) as number[];

  const summary = {
    medianGctMs: median(gctValues),
    medianFlightMs: median(flightValues),
    p95GctMs: percentile95(gctValues),
    p95FlightMs: percentile95(flightValues),
    hopCount: validHops.length,
  };

  // 8. Compute confidence
  const confidence = computeConfidence(validHops.length, rejectedCount, transitions.length);

  // 9. Combine diagnostics
  const diagnostics = {
    rejectedTransitions: rejectedCount,
    reasons: {
      ...pairingReasons,
      ...boundReasons,
    },
  };

  return {
    landings,
    takeoffs,
    hops: validHops,
    summary,
    confidence,
    diagnostics,
  };
}
