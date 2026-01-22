/**
 * Raw frame with pixel data for contact signal computation.
 */
export interface RawFrame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Contact signal: motion energy inside ROI per frame with hysteresis-based state detection.
 * Robust normalization + EMA smoothing + hysteresis thresholds prevent chatter.
 */
export interface ContactSignal {
  score: number[];
  scoreSmoothed: number[];
  state: (0 | 1)[];
  thresholds: { enter: number; exit: number };
  confidence: number; // 0..1 based on threshold separation + stability
  diagnostics: {
    norm:
      | { type: 'medianMAD'; median: number; mad: number }
      | { type: 'percentile'; min: number; max: number };
    chatterCount: number;
    smoothingMode: 'causal' | 'zero_phase';
    safeguards: {
      dynamicRange: number;
      minDynamicRange: number;
      framesAboveEnter: number;
      framesBelowExit: number;
      minFramesAboveEnter: number;
      minFramesBelowExit: number;
      passed: boolean;
    };
  };
}

export interface ContactSignalOptions {
  emaAlpha?: number; // 0.1 to 0.5; default 0.2
  smoothingMode?: 'causal' | 'zero_phase'; // default 'causal'
  normMethod?: 'medianMAD' | 'percentile'; // default 'medianMAD'
  enterThreshold?: number; // 0..1; default 0.3
  exitThreshold?: number; // 0..1; default 0.15
  minStateFrames?: number; // dwell frames; default 2
  minDynamicRange?: number; // default 0.1
  minFramesAboveEnter?: number; // default 2
  minFramesBelowExit?: number; // default 2
}

/**
 * Compute motion energy inside ROI for each frame (frame-to-frame absolute difference).
 */
function computeMotionEnergyInRoi(
  frames: RawFrame[],
  roi: { x: number; y: number; w: number; h: number }
): number[] {
  if (frames.length === 0) return [];

  const { x, y, w, h } = roi;
  const energies: number[] = [];

  for (let t = 0; t < frames.length; t++) {
    const frameData = frames[t].data;
    const width = frames[t].width;
    const height = frames[t].height;

    // For t=0, energy is 0 (no previous frame)
    if (t === 0) {
      energies.push(0);
      continue;
    }

    const prevData = frames[t - 1].data;
    let energy = 0;
    let pixelCount = 0;

    // Sum absolute differences inside ROI
    for (let py = y; py < y + h && py < height; py++) {
      for (let px = x; px < x + w && px < width; px++) {
        const idx = py * width + px;
        if (idx < frameData.length && idx < prevData.length) {
          const diff = Math.abs(frameData[idx] - prevData[idx]);
          energy += diff;
          pixelCount++;
        }
      }
    }

    // Normalize by pixel count to avoid dependence on ROI size
    energies.push(pixelCount > 0 ? energy / pixelCount : 0);
  }

  return energies;
}

/**
 * Normalize score using specified method (medianMAD or percentile).
 * Returns [0..1] normalized scores and diagnostic info.
 */
function normalizeScore(
  scores: number[],
  method: 'medianMAD' | 'percentile'
): {
  normalized: number[];
  diagnostics:
    | { type: 'medianMAD'; median: number; mad: number }
    | { type: 'percentile'; min: number; max: number };
} {
  if (scores.length === 0) {
    return {
      normalized: [],
      diagnostics:
        method === 'medianMAD'
          ? { type: 'medianMAD', median: 0, mad: 0 }
          : { type: 'percentile', min: 0, max: 0 },
    };
  }

  if (method === 'medianMAD') {
    // Compute median
    const sorted = [...scores].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    // Compute median absolute deviation (MAD)
    const deviations = scores.map((x) => Math.abs(x - median)).sort((a, b) => a - b);
    const mad = deviations[Math.floor(deviations.length / 2)];

    // Normalize: (score - median) / (1.48 * MAD) scaled to [0..1]
    const scale = Math.max(1.48 * mad, 0.001); // avoid division by zero
    const normalized = scores.map((x) => {
      const normalized_val = (x - median) / scale;
      return Math.max(0, Math.min(1, 0.5 + normalized_val * 0.5)); // shift to [0..1]
    });

    return {
      normalized,
      diagnostics: { type: 'medianMAD', median, mad },
    };
  } else {
    // Percentile method: map [p5..p95] to [0..1]
    const sorted = [...scores].sort((a, b) => a - b);
    const p5 = sorted[Math.max(0, Math.floor(sorted.length * 0.05))];
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];

    const range = Math.max(p95 - p5, 0.001);
    const normalized = scores.map((x) => Math.max(0, Math.min(1, (x - p5) / range)));

    return {
      normalized,
      diagnostics: { type: 'percentile', min: p5, max: p95 },
    };
  }
}

/**
 * Apply exponential moving average (EMA) smoothing.
 */
function applyEmaSmoothing(scores: number[], alpha: number): number[] {
  if (scores.length === 0) return [];

  const smoothed: number[] = [];
  let ema = scores[0];
  smoothed.push(ema);

  for (let i = 1; i < scores.length; i++) {
    ema = alpha * scores[i] + (1 - alpha) * ema;
    smoothed.push(ema);
  }

  return smoothed;
}

/**
 * Apply hysteresis thresholds with minimum dwell time to prevent chatter.
 * Returns state array and chatter count.
 */
function applyHysteresis(
  smoothedScores: number[],
  enterThreshold: number,
  exitThreshold: number,
  minStateFrames: number
): { state: (0 | 1)[]; chatterCount: number } {
  const EPS = 1e-6;
  if (smoothedScores.length === 0) {
    return { state: [], chatterCount: 0 };
  }

  const state: (0 | 1)[] = [];
  let currentState: 0 | 1 = 0;
  let stateFrameCount = 0;
  let chatterCount = 0;

  for (let t = 0; t < smoothedScores.length; t++) {
    const score = smoothedScores[t];

    // Transition logic
    if (currentState === 0) {
      // In flight: check if we enter contact
      if (score >= enterThreshold - EPS) {
        // Tentatively transition to contact
        currentState = 1;
        stateFrameCount = 1;
      } else {
        stateFrameCount++;
      }
    } else {
      // In contact: check if we exit
      if (score < exitThreshold + EPS) {
        // Tentatively transition to flight
        currentState = 0;
        stateFrameCount = 1;
      } else {
        stateFrameCount++;
      }
    }

    // Only commit state if dwell time is satisfied
    if (stateFrameCount < minStateFrames) {
      // Revert to previous state (suppress chatter)
      state.push(state.length > 0 ? state[state.length - 1] : 0);
      chatterCount++;
    } else {
      state.push(currentState);
    }
  }

  return { state, chatterCount };
}

/**
 * Compute confidence from threshold separation and score stability.
 */
function computeConfidence(
  enterThreshold: number,
  exitThreshold: number,
  smoothedScores: number[]
): number {
  if (smoothedScores.length === 0) return 0;

  // Threshold separation metric: wider = more robust
  const separation = enterThreshold - exitThreshold;
  const separationScore = Math.min(1, separation / 0.3); // normalized to [0..1]

  // Score stability: variance of smoothed scores
  const mean = smoothedScores.reduce((a, b) => a + b, 0) / smoothedScores.length;
  const variance = smoothedScores.reduce((a, b) => a + (b - mean) ** 2, 0) / smoothedScores.length;
  const stdDev = Math.sqrt(variance);
  const stabilityScore = Math.max(0, 1 - stdDev * 2); // lower variance = higher confidence

  // Combined confidence
  return 0.5 * separationScore + 0.5 * stabilityScore;
}

/**
 * Compute contact signal: motion energy inside ROI with hysteresis state machine.
 */
export function computeContactSignal(
  frames: RawFrame[],
  roi: { x: number; y: number; w: number; h: number },
  options?: ContactSignalOptions
): ContactSignal {
  // Default options
  const emaAlpha = options?.emaAlpha ?? 0.2;
  const smoothingMode = options?.smoothingMode ?? 'causal';
  const normMethod = options?.normMethod ?? 'medianMAD';
  const enterThreshold = options?.enterThreshold ?? 0.3;
  const exitThreshold = options?.exitThreshold ?? 0.15;
  const minStateFrames = options?.minStateFrames ?? 2;
  const minDynamicRange = options?.minDynamicRange ?? 0.1;
  const minFramesAboveEnter = options?.minFramesAboveEnter ?? 2;
  const minFramesBelowExit = options?.minFramesBelowExit ?? 2;

  // 1. Compute raw motion energy inside ROI
  const rawScores = computeMotionEnergyInRoi(frames, roi);

  // 2. Normalize scores
  const { normalized: normalizedScores, diagnostics: normDiagnostics } = normalizeScore(
    rawScores,
    normMethod
  );

  // 3. Apply EMA smoothing
  const smoothedScores =
    smoothingMode === 'zero_phase'
      ? applyEmaSmoothing([...applyEmaSmoothing(normalizedScores, emaAlpha)].reverse(), emaAlpha).reverse()
      : applyEmaSmoothing(normalizedScores, emaAlpha);

  // 4. Apply hysteresis and dwell time
  const { state, chatterCount } = applyHysteresis(
    smoothedScores,
    enterThreshold,
    exitThreshold,
    minStateFrames
  );

  // 5. Safeguards (reject if signal lacks minimum structure)
  const dynamicRange = smoothedScores.length
    ? Math.max(...smoothedScores) - Math.min(...smoothedScores)
    : 0;
  const framesAboveEnter = smoothedScores.filter((v) => v >= enterThreshold - 1e-6).length;
  const framesBelowExit = smoothedScores.filter((v) => v <= exitThreshold + 1e-6).length;
  const safeguardsPassed =
    dynamicRange >= minDynamicRange &&
    framesAboveEnter >= minFramesAboveEnter &&
    framesBelowExit >= minFramesBelowExit;

  // 6. Compute confidence
  const confidence = safeguardsPassed
    ? computeConfidence(enterThreshold, exitThreshold, smoothedScores)
    : 0;

  return {
    score: rawScores,
    scoreSmoothed: smoothedScores,
    state,
    thresholds: { enter: enterThreshold, exit: exitThreshold },
    confidence,
    diagnostics: {
      norm: normDiagnostics,
      chatterCount,
      smoothingMode,
      safeguards: {
        dynamicRange,
        minDynamicRange,
        framesAboveEnter,
        framesBelowExit,
        minFramesAboveEnter,
        minFramesBelowExit,
        passed: safeguardsPassed,
      },
    },
  };
}
