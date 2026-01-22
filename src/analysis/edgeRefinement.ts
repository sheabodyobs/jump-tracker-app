/**
 * Edge refinement for contact transitions.
 *
 * When a binary state transition is detected (e.g., 0→1 contact loss→contact),
 * the exact timing is biased by smoothing and thresholds. This module refines
 * the transition timing by scanning a small window around the transition and
 * identifying the true "edge" using one of two methods:
 *
 * 1. Max derivative: Find frame with steepest slope in the smoothed signal
 * 2. Level crossing: Find first crossing of a normalized level (e.g. 0.5)
 *
 * Returns both transition frame index and refined frame index, with optional
 * sub-frame interpolation to beat the frame quantum (e.g. 8.33ms at 120fps).
 */

export interface EdgeRefinementResult {
  transitionFrameIndex: number; // Original state transition frame
  refinedFrameIndex: number; // Best edge frame
  refinedTMs: number; // Refined timestamp (ms)
  subFrameOffsetMs: number | null; // Sub-frame estimate (null if not available)
  method: 'max_derivative' | 'level_crossing';
  confidence: number; // 0..1
}

/**
 * Refine a landing transition (0→1, contact loss → contact).
 * Uses max positive derivative or crossing of 0.5 on rising edge.
 */
export function refineLandingEdge(
  smoothedScores: number[],
  transitionFrameIndex: number,
  timestamps: number[],
  options?: { method?: 'max_derivative' | 'level_crossing'; windowFrames?: number }
): EdgeRefinementResult {
  const method = options?.method ?? 'max_derivative';
  const windowFrames = options?.windowFrames ?? 3; // ±3 frames around transition

  const windowStart = Math.max(0, transitionFrameIndex - windowFrames);
  const windowEnd = Math.min(smoothedScores.length - 1, transitionFrameIndex + windowFrames);

  if (method === 'max_derivative') {
    return refineByMaxPositiveDerivative(
      smoothedScores,
      transitionFrameIndex,
      timestamps,
      windowStart,
      windowEnd
    );
  } else {
    return refineByCrossing(
      smoothedScores,
      transitionFrameIndex,
      timestamps,
      windowStart,
      windowEnd,
      'rising'
    );
  }
}

/**
 * Refine a takeoff transition (1→0, contact → contact loss).
 * Uses max negative derivative or crossing of 0.5 on falling edge.
 */
export function refineTakeoffEdge(
  smoothedScores: number[],
  transitionFrameIndex: number,
  timestamps: number[],
  options?: { method?: 'max_derivative' | 'level_crossing'; windowFrames?: number }
): EdgeRefinementResult {
  const method = options?.method ?? 'max_derivative';
  const windowFrames = options?.windowFrames ?? 3; // ±3 frames around transition

  const windowStart = Math.max(0, transitionFrameIndex - windowFrames);
  const windowEnd = Math.min(smoothedScores.length - 1, transitionFrameIndex + windowFrames);

  if (method === 'max_derivative') {
    return refineByMaxNegativeDerivative(
      smoothedScores,
      transitionFrameIndex,
      timestamps,
      windowStart,
      windowEnd
    );
  } else {
    return refineByCrossing(
      smoothedScores,
      transitionFrameIndex,
      timestamps,
      windowStart,
      windowEnd,
      'falling'
    );
  }
}

/**
 * Find frame with max positive derivative (rising edge).
 * Confidence = magnitude of derivative (0..1 normalized).
 */
function refineByMaxPositiveDerivative(
  smoothedScores: number[],
  transitionFrameIndex: number,
  timestamps: number[],
  windowStart: number,
  windowEnd: number
): EdgeRefinementResult {
  const lastIndex = Math.min(smoothedScores.length, timestamps.length) - 1;
  if (lastIndex <= 0) {
    const safeIndex = Math.max(0, Math.min(transitionFrameIndex, lastIndex));
    return {
      transitionFrameIndex: safeIndex,
      refinedFrameIndex: safeIndex,
      refinedTMs: timestamps[safeIndex] ?? 0,
      subFrameOffsetMs: null,
      method: 'max_derivative',
      confidence: 0,
    };
  }

  let maxDerivative = 0;
  let maxIdx = Math.max(0, Math.min(transitionFrameIndex, lastIndex - 1));

  const safeWindowEnd = Math.min(windowEnd, lastIndex - 1);
  const safeWindowStart = Math.max(0, Math.min(windowStart, safeWindowEnd));

  for (let i = safeWindowStart; i <= safeWindowEnd; i++) {
    const derivative = smoothedScores[i + 1] - smoothedScores[i];
    if (derivative > maxDerivative) {
      maxDerivative = derivative;
      maxIdx = i;
    }
  }

  // Sub-frame interpolation: if maxIdx < windowEnd, interpolate to find exact crossing
  const nextIdx = Math.min(maxIdx + 1, lastIndex);
  const subFrameOffsetMs = interpolateSubFrameOffset(
    smoothedScores[maxIdx],
    smoothedScores[nextIdx],
    timestamps[maxIdx],
    timestamps[nextIdx],
    0.5,
    'rising'
  );

  const refinedTMs = subFrameOffsetMs !== null 
    ? timestamps[maxIdx] + subFrameOffsetMs 
    : timestamps[maxIdx];

  return {
    transitionFrameIndex,
    refinedFrameIndex: maxIdx,
    refinedTMs,
    subFrameOffsetMs,
    method: 'max_derivative',
    confidence: Math.min(1, maxDerivative * 2), // Normalize to 0..1
  };
}

/**
 * Find frame with max negative derivative (falling edge).
 * Confidence = magnitude of derivative (0..1 normalized).
 */
function refineByMaxNegativeDerivative(
  smoothedScores: number[],
  transitionFrameIndex: number,
  timestamps: number[],
  windowStart: number,
  windowEnd: number
): EdgeRefinementResult {
  const lastIndex = Math.min(smoothedScores.length, timestamps.length) - 1;
  if (lastIndex <= 0) {
    const safeIndex = Math.max(0, Math.min(transitionFrameIndex, lastIndex));
    return {
      transitionFrameIndex: safeIndex,
      refinedFrameIndex: safeIndex,
      refinedTMs: timestamps[safeIndex] ?? 0,
      subFrameOffsetMs: null,
      method: 'max_derivative',
      confidence: 0,
    };
  }

  let minDerivative = 0;
  let minIdx = Math.max(0, Math.min(transitionFrameIndex, lastIndex - 1));

  const safeWindowEnd = Math.min(windowEnd, lastIndex - 1);
  const safeWindowStart = Math.max(0, Math.min(windowStart, safeWindowEnd));

  for (let i = safeWindowStart; i <= safeWindowEnd; i++) {
    const derivative = smoothedScores[i + 1] - smoothedScores[i];
    if (derivative < minDerivative) {
      minDerivative = derivative;
      minIdx = i;
    }
  }

  // Sub-frame interpolation: if minIdx < windowEnd, interpolate to find exact crossing
  const nextIdx = Math.min(minIdx + 1, lastIndex);
  const subFrameOffsetMs = interpolateSubFrameOffset(
    smoothedScores[minIdx],
    smoothedScores[nextIdx],
    timestamps[minIdx],
    timestamps[nextIdx],
    0.5,
    'falling'
  );

  const refinedTMs = subFrameOffsetMs !== null 
    ? timestamps[minIdx] + subFrameOffsetMs 
    : timestamps[minIdx];

  return {
    transitionFrameIndex,
    refinedFrameIndex: minIdx,
    refinedTMs,
    subFrameOffsetMs,
    method: 'max_derivative',
    confidence: Math.min(1, Math.abs(minDerivative) * 2), // Normalize to 0..1
  };
}

/**
 * Find first crossing of a normalized level (default 0.5) on rising or falling edge.
 * Confidence = distance from exact threshold crossing (1.0 if exact, lower if interpolated).
 */
function refineByCrossing(
  smoothedScores: number[],
  transitionFrameIndex: number,
  timestamps: number[],
  windowStart: number,
  windowEnd: number,
  edge: 'rising' | 'falling',
  targetLevel: number = 0.5
): EdgeRefinementResult {
  let crossingIdx = transitionFrameIndex;
  let bestDist = Infinity;

  for (let i = windowStart; i <= windowEnd; i++) {
    const score = smoothedScores[i];
    const distance = Math.abs(score - targetLevel);

    if (edge === 'rising' && score >= targetLevel && distance < bestDist) {
      bestDist = distance;
      crossingIdx = i;
    } else if (edge === 'falling' && score <= targetLevel && distance < bestDist) {
      bestDist = distance;
      crossingIdx = i;
    }
  }

  // Sub-frame interpolation: refine crossing time
  const subFrameOffsetMs = interpolateSubFrameOffset(
    smoothedScores[crossingIdx],
    smoothedScores[Math.min(crossingIdx + 1, smoothedScores.length - 1)],
    timestamps[crossingIdx],
    timestamps[Math.min(crossingIdx + 1, timestamps.length - 1)],
    targetLevel,
    edge
  );

  const refinedTMs = subFrameOffsetMs !== null 
    ? timestamps[crossingIdx] + subFrameOffsetMs 
    : timestamps[crossingIdx];

  // Confidence = 1 if exact crossing, lower if need to interpolate
  const crossingConfidence = bestDist < 0.01 ? 1.0 : Math.max(0, 1 - bestDist);

  return {
    transitionFrameIndex,
    refinedFrameIndex: crossingIdx,
    refinedTMs,
    subFrameOffsetMs,
    method: 'level_crossing',
    confidence: crossingConfidence,
  };
}

/**
 * Linear interpolation to find sub-frame offset where signal crosses target level.
 * Returns offset (ms) from the first frame, or null if endpoints don't bracket the level.
 */
function interpolateSubFrameOffset(
  score1: number,
  score2: number,
  tMs1: number,
  tMs2: number,
  targetLevel: number,
  edge: 'rising' | 'falling'
): number | null {
  const dt = tMs2 - tMs1;

  if (edge === 'rising') {
    // Rising: score1 < target < score2, or score1 ≈ target
    if (score1 < targetLevel && score2 >= targetLevel && dt > 0) {
      // Linear interpolation: t = score1 + (targetLevel - score1) / (score2 - score1) * dt
      const fraction = (targetLevel - score1) / (score2 - score1);
      return fraction * dt;
    }
  } else {
    // Falling: score1 > target > score2, or score1 ≈ target
    if (score1 > targetLevel && score2 <= targetLevel && dt > 0) {
      const fraction = (score1 - targetLevel) / (score1 - score2);
      return fraction * dt;
    }
  }

  return null;
}

/**
 * Refine all transitions in contact state using smoothed scores.
 * Returns list of refined landing/takeoff timings.
 */
export function refineAllTransitions(
  state: (0 | 1)[],
  smoothedScores: number[],
  timestamps: number[],
  options?: {
    refinementMethod?: 'max_derivative' | 'level_crossing';
    windowFrames?: number;
  }
): Array<{
  type: 'landing' | 'takeoff';
  transitionFrameIndex: number;
  refinedFrameIndex: number;
  refinedTMs: number;
  subFrameOffsetMs: number | null;
  confidence: number;
}> {
  const results: Array<{
    type: 'landing' | 'takeoff';
    transitionFrameIndex: number;
    refinedFrameIndex: number;
    refinedTMs: number;
    subFrameOffsetMs: number | null;
    confidence: number;
  }> = [];

  for (let i = 1; i < state.length; i++) {
    if (state[i] === state[i - 1]) continue; // No transition

    const isLanding = state[i - 1] === 0 && state[i] === 1;

    const result = isLanding
      ? refineLandingEdge(smoothedScores, i, timestamps, options)
      : refineTakeoffEdge(smoothedScores, i, timestamps, options);

    results.push({
      type: isLanding ? 'landing' : 'takeoff',
      transitionFrameIndex: result.transitionFrameIndex,
      refinedFrameIndex: result.refinedFrameIndex,
      refinedTMs: result.refinedTMs,
      subFrameOffsetMs: result.subFrameOffsetMs,
      confidence: result.confidence,
    });
  }

  return results;
}
