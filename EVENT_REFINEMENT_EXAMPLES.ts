/**
 * EVENT EDGE REFINEMENT - CODE EXAMPLES
 *
 * Examples showing how to use the new event refinement, plausibility bounds,
 * and label-based evaluation system.
 *
 * NOTE: This is a documentation file with pseudo-code examples.
 * Some examples use simplified types for readability.
 */

// ============================================================================
// EXAMPLE 1: Event Extraction with Edge Refinement (Main Integration)
// ============================================================================

import { computeContactSignal } from './src/analysis/contactSignal';
import { extractJumpEvents } from './src/analysis/eventExtractor';

// Type definition for examples
interface PixelFrame {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  tMs: number;
}

function example1_ExtractWithRefinement(
  contactState: (0 | 1)[],
  pixelFrames: PixelFrame[],
  roi: { x: number; y: number; w: number; h: number }
) {
  // Compute smoothed contact signal for edge refinement
  const contactSignal = computeContactSignal(pixelFrames, roi);

  // Extract events with edge refinement
  const jumpEvents = extractJumpEvents(
    contactState,
    pixelFrames,
    {
      minGctMs: 50,               // Min ground contact
      maxGctMs: 450,              // Max ground contact
      minFlightMs: 100,           // Min flight time
      maxFlightMs: 900,           // Max flight time
      minIntervalMs: 50,          // Min time between events
      refinementMethod: 'max_derivative',  // or 'level_crossing'
      refinementWindowFrames: 3,  // ±3 frames around transition
    },
    contactSignal.scoreSmoothed   // Pass smoothed scores for refinement
  );

  // Result contains refined timings and diagnostics
  console.log(`Found ${jumpEvents.hops.length} valid hops`);
  console.log(`GCT: median=${jumpEvents.summary.medianGctMs}ms, p95=${jumpEvents.summary.p95GctMs}ms`);
  console.log(`Flight: median=${jumpEvents.summary.medianFlightMs}ms, p95=${jumpEvents.summary.p95FlightMs}ms`);

  // Diagnostics show what was rejected
  console.log('Rejection reasons:', jumpEvents.diagnostics.reasons);

  return jumpEvents;
}

// ============================================================================
// EXAMPLE 2: Edge Refinement Standalone
// ============================================================================

import { refineLandingEdge, refineTakeoffEdge } from './src/analysis/edgeRefinement';

function example2_RefinementStandalone(
  smoothedScores: number[],
  timestamps: number[]
) {
  // Simulate finding a landing transition at frame 45
  const landingFrameIndex = 45;

  const landingRefinement = refineLandingEdge(
    smoothedScores,
    landingFrameIndex,
    timestamps,
    {
      method: 'max_derivative',
      windowFrames: 3,
    }
  );

  console.log(`Landing transition at frame ${landingRefinement.transitionFrameIndex}`);
  console.log(`Refined to frame ${landingRefinement.refinedFrameIndex}`);
  console.log(`Refined time: ${landingRefinement.refinedTMs}ms`);
  console.log(`Sub-frame offset: ${landingRefinement.subFrameOffsetMs?.toFixed(2)}ms`);
  console.log(`Refinement confidence: ${(landingRefinement.confidence * 100).toFixed(1)}%`);

  // Same for takeoff
  const takeoffFrameIndex = 90;
  const takeoffRefinement = refineTakeoffEdge(
    smoothedScores,
    takeoffFrameIndex,
    timestamps,
    { method: 'max_derivative', windowFrames: 3 }
  );

  console.log(`\nTakeoff refined time: ${takeoffRefinement.refinedTMs}ms`);
  console.log(`Sub-frame offset: ${takeoffRefinement.subFrameOffsetMs?.toFixed(2)}ms`);

  // Use refined times
  const gctMs = takeoffRefinement.refinedTMs - landingRefinement.refinedTMs;
  console.log(`\nGCT (refined): ${gctMs.toFixed(2)}ms`);
}

// ============================================================================
// EXAMPLE 3: Plausibility Bounds Effect
// ============================================================================

import type { EventExtractorOptions } from './src/analysis/eventExtractor';

function example3_PlausibilityBounds() {
  // Scenario: Raw contact state has noise creating short GCT
  const rawState: (0 | 1)[] = [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 0];
  const timestamps = Array.from({ length: rawState.length }, (_, i) => i * 8.33); // 120fps

  const pixelFrames = timestamps.map((tMs) => ({ tMs }));

  // Without bounds (hypothetical)
  // Would extract: Landing@0, Takeoff@8.33, Landing@16.67, Takeoff@33.3, ...
  // GCT[0] = 8.33ms → INVALID (< 50ms minimum)

  // With bounds applied
  const options: EventExtractorOptions = {
    minGctMs: 50,
    maxGctMs: 450,
    minFlightMs: 100,
    maxFlightMs: 900,
    minIntervalMs: 50,
  };

  const jumpEvents = extractJumpEvents(rawState, pixelFrames, options);

  // Check diagnostics
  const gctTooShort = jumpEvents.diagnostics.reasons['gct_too_short'] ?? 0;
  console.log(`Rejected ${gctTooShort} hops due to GCT < 50ms`);

  const validCount = jumpEvents.hops.length;
  console.log(`Valid hops after bounds: ${validCount}`);

  // Display valid hop details
  jumpEvents.hops.forEach((hop, idx) => {
    console.log(
      `Hop ${idx + 1}: GCT=${hop.gctMs.toFixed(1)}ms, ` +
      `Flight=${hop.flightMs?.toFixed(1)}ms`
    );
  });
}

// ============================================================================
// EXAMPLE 4: Label-Based Accuracy Evaluation
// ============================================================================

import { evaluateEvents, type AutoEvent, type Label } from './src/analysis/labelStorage';

function example4_LabelEvaluation() {
  // Ground-truth labels (from label mode)
  const labels: Label[] = [
    { type: 'landing', tMs: 150.0, confidence: 1.0 },
    { type: 'takeoff', tMs: 300.5, confidence: 0.95 },
    { type: 'landing', tMs: 450.2, confidence: 0.99 },
    { type: 'takeoff', tMs: 600.8, confidence: 0.98 },
  ];

  // Auto-detected events (from pipeline)
  const autoEvents: AutoEvent[] = [
    {
      type: 'landing',
      tMs: 148.0,           // Frame-based
      refinedTMs: 148.5,    // Edge-refined (sub-frame)
      confidence: 0.92,
    },
    {
      type: 'takeoff',
      tMs: 306.0,
      refinedTMs: 305.8,
      confidence: 0.88,
    },
    {
      type: 'landing',
      tMs: 452.0,
      refinedTMs: 451.7,
      confidence: 0.91,
    },
    {
      type: 'takeoff',
      tMs: 602.0,
      refinedTMs: 601.5,
      confidence: 0.89,
    },
    // False positive (not in labels)
    {
      type: 'landing',
      tMs: 750.0,
      refinedTMs: 749.2,
      confidence: 0.45,
    },
  ];

  // Evaluate (compares refined times if available)
  const result = evaluateEvents(labels, autoEvents, 50); // 50ms tolerance

  console.log(`\n=== EVALUATION RESULTS ===`);
  console.log(`Labels: ${result.labelCount}, Auto events: ${result.autoEventCount}`);
  console.log(`Matched pairs: ${result.matchedPairs.length}`);
  console.log(`Unmatched labels: ${result.unmatchedLabels.length}`);
  console.log(`Unmatched auto (FP): ${result.unmatchedAuto.length}`);

  // Landing errors
  console.log(`\n--- Landing Errors ---`);
  const landingMetrics = result.metrics.landing;
  console.log(
    `Count: ${landingMetrics.count}, ` +
    `Median: ${landingMetrics.medianMs?.toFixed(2)}ms, ` +
    `P95: ${landingMetrics.p95Ms?.toFixed(2)}ms`
  );

  // Takeoff errors
  console.log(`\n--- Takeoff Errors ---`);
  const takeoffMetrics = result.metrics.takeoff;
  console.log(
    `Count: ${takeoffMetrics.count}, ` +
    `Median: ${takeoffMetrics.medianMs?.toFixed(2)}ms, ` +
    `P95: ${takeoffMetrics.p95Ms?.toFixed(2)}ms`
  );

  // GCT errors (derived)
  console.log(`\n--- GCT Errors ---`);
  const gctMetrics = result.metrics.gct;
  if (gctMetrics) {
    console.log(
      `Count: ${gctMetrics.count}, ` +
      `Median: ${gctMetrics.medianMs?.toFixed(2)}ms, ` +
      `P95: ${gctMetrics.p95Ms?.toFixed(2)}ms`
    );
  } else {
    console.log('No GCT errors (insufficient landing/takeoff pairs)');
  }

  // Check against acceptance targets
  console.log(`\n=== ACCEPTANCE CHECK ===`);
  const landingPass = (landingMetrics.medianMs ?? Infinity) < 10 &&
                      (landingMetrics.p95Ms ?? Infinity) < 25;
  const takeoffPass = (takeoffMetrics.medianMs ?? Infinity) < 10 &&
                      (takeoffMetrics.p95Ms ?? Infinity) < 25;
  const gctPass = gctMetrics === null ||
                  ((gctMetrics.medianMs ?? Infinity) < 20 &&
                   (gctMetrics.p95Ms ?? Infinity) < 50);

  console.log(`Landing: ${landingPass ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Takeoff: ${takeoffPass ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`GCT: ${gctPass ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Overall: ${landingPass && takeoffPass && gctPass ? '✓ PASS' : '✗ FAIL'}`);
}

// ============================================================================
// EXAMPLE 5: Comparing Refinement Methods
// ============================================================================

import { refineAllTransitions } from './src/analysis/edgeRefinement';

function example5_CompareRefinementMethods(
  state: (0 | 1)[],
  smoothedScores: number[],
  timestamps: number[]
) {
  // Method 1: Max derivative
  const derivativeRefinements = refineAllTransitions(state, smoothedScores, timestamps, {
    refinementMethod: 'max_derivative',
    windowFrames: 3,
  });

  console.log('=== MAX DERIVATIVE REFINEMENT ===');
  derivativeRefinements.forEach((result) => {
    console.log(
      `${result.type.toUpperCase()}: ` +
      `Frame ${result.transitionFrameIndex} → ${result.refinedFrameIndex}, ` +
      `Refined ${result.refinedTMs.toFixed(2)}ms, ` +
      `SubFrame ${result.subFrameOffsetMs?.toFixed(2)}ms, ` +
      `Confidence ${(result.confidence * 100).toFixed(1)}%`
    );
  });

  // Method 2: Level crossing
  const levelRefinements = refineAllTransitions(state, smoothedScores, timestamps, {
    refinementMethod: 'level_crossing',
    windowFrames: 3,
  });

  console.log('\n=== LEVEL CROSSING REFINEMENT ===');
  levelRefinements.forEach((result) => {
    console.log(
      `${result.type.toUpperCase()}: ` +
      `Refined ${result.refinedTMs.toFixed(2)}ms, ` +
      `Confidence ${(result.confidence * 100).toFixed(1)}%`
    );
  });

  // Compare
  console.log('\n=== COMPARISON ===');
  console.log('Derivative tends to find steeper slopes (earlier detection)');
  console.log('Level crossing more consistent across different smoothing amounts');
}

// ============================================================================
// EXAMPLE 6: Integration in LabelModePanel
// ============================================================================

// Already done in src/components/LabelModePanel.tsx
// Shows real-time accuracy as user marks events

// Key flow:
// 1. User taps "Mark Landing" at frame 45 (150ms)
// 2. Label stored: { type: 'landing', tMs: 150 }
// 3. LabelModePanel calls evaluateEvents(labels, jumpAnalysis.events)
// 4. Displays: "Landing Error (n=1): median=-2.1ms, p95=-2.1ms"
// 5. User can mark more events and see metrics update in real-time

// ============================================================================
// EXAMPLE 7: Test Fixture - Synthetic Data
// ============================================================================

function example7_SyntheticTestData() {
  // Create synthetic contact state and smoothed scores
  const fps = 120;
  const durationSec = 2;
  const numFrames = fps * durationSec;

  const timestamps = Array.from({ length: numFrames }, (_, i) => (i / fps) * 1000);
  const pixelFrames = timestamps.map((tMs) => ({ tMs }));

  // Synthetic state: landing at 0.5s, takeoff at 0.7s
  const contactState: (0 | 1)[] = Array(numFrames).fill(0);
  const landingFrame = Math.floor(0.5 * fps);  // Frame 60
  const takeoffFrame = Math.floor(0.7 * fps);  // Frame 84

  for (let i = landingFrame; i < takeoffFrame; i++) {
    contactState[i] = 1;
  }

  // Synthetic smoothed scores (EMA of state)
  const smoothedScores: number[] = [];
  let smoothed = 0;
  const alpha = 0.2;

  for (let i = 0; i < numFrames; i++) {
    smoothed = alpha * contactState[i] + (1 - alpha) * smoothed;
    smoothedScores.push(smoothed);
  }

  console.log(`Synthetic data:`);
  console.log(`Landing frame: ${landingFrame} (${timestamps[landingFrame].toFixed(1)}ms)`);
  console.log(`Takeoff frame: ${takeoffFrame} (${timestamps[takeoffFrame].toFixed(1)}ms)`);
  console.log(`State transitions: ${contactState.filter((s, i) => i > 0 && s !== contactState[i - 1]).length}`);

  // Refine
  const refined = refineAllTransitions(contactState, smoothedScores, timestamps, {
    refinementMethod: 'max_derivative',
    windowFrames: 3,
  });

  console.log(`\nRefined events:`);
  refined.forEach((r) => {
    console.log(
      `${r.type}: frame ${r.transitionFrameIndex} → ${r.refinedFrameIndex}, ` +
      `time ${r.refinedTMs.toFixed(2)}ms`
    );
  });

  return { contactState, smoothedScores, timestamps, pixelFrames };
}

// ============================================================================
// EXAMPLE 8: Parameter Tuning Workflow
// ============================================================================

function example8_ParameterTuning() {
  // Scenario: Collected accuracy data on 10 videos
  const accuracyResults = [
    { videoId: 'v1', landingMedianMs: 12, landingP95Ms: 28, takeoffMedianMs: 8 },
    { videoId: 'v2', landingMedianMs: -5, landingP95Ms: 18, takeoffMedianMs: -3 },
    { videoId: 'v3', landingMedianMs: 15, landingP95Ms: 35, takeoffMedianMs: 12 },
    // ... 7 more videos
  ];

  // Analysis
  const landingMedians = accuracyResults.map((r) => r.landingMedianMs);
  const landingMedian = landingMedians.sort((a, b) => a - b)[Math.floor(landingMedians.length / 2)];

  console.log(`=== ACCURACY ANALYSIS ===`);
  console.log(`Landing median error across videos: ${landingMedian}ms`);
  console.log(`Target: < 10ms`);

  if (landingMedian > 10) {
    console.log('\nTuning recommendations:');
    console.log('1. Check if refinement is capturing edge correctly');
    console.log('   → Try level_crossing instead of max_derivative');
    console.log('2. Increase refinement window (±4 or ±5 frames)');
    console.log('3. Check EMA alpha (smoother = more lag)');
    console.log('4. Verify threshold tuning (enterThreshold/exitThreshold)');
  }

  // Hypothesis: Systematic +10ms bias → threshold too aggressive
  if (landingMedian > 5) {
    console.log('\nSuspected cause: Hysteresis threshold too high');
    console.log('Action: Decrease enterThreshold by 0.05');
  }
}

// ============================================================================
// EXAMPLE 9: End-to-End Pipeline
// ============================================================================

// PSEUDO-CODE: Shows the full integration flow
// In practice, use this pattern in pogoSideViewAnalyzer.ts

/*
async function example9_FullPipeline(videoUri: string) {
  // 1. Extract frames from video
  const { pixelFrames } = await sampleFramesForAnalysis(videoUri);

  // 2. Detect ground plane and ROI
  const { groundModel } = detectGround(grayscaleFrames);
  const { roi } = inferRoiFromGround(grayscaleFrames, groundModel);

  // 3. Compute contact signal with smoothing
  const contactSignal = computeContactSignal(pixelFrames, roi);

  // 4. Threshold to binary state
  const contactState = contactSignal.scoreSmoothed.map((s) =>
    s >= 0.5 ? (1 as const) : (0 as const)
  );

  // 5. Extract events with edge refinement
  const jumpEvents = extractJumpEvents(
    contactState,
    pixelFrames,
    {
      minGctMs: 50,
      maxGctMs: 450,
      minFlightMs: 100,
      maxFlightMs: 900,
      minIntervalMs: 50,
      refinementMethod: 'max_derivative',
      refinementWindowFrames: 3,
    },
    contactSignal.scoreSmoothed  // Pass smoothed scores
  );

  // 6. If label mode enabled, evaluate against labels
  const labelModeEnabled = true; // From UI state
  if (labelModeEnabled) {
    const labels = await loadVideoLabels(videoUri);
    if (labels?.labels) {
      const autoEvents = jumpEvents.landings.map((e) => ({
        type: 'landing' as const,
        tMs: e.tMs,
        refinedTMs: e.refinedTMs,
        confidence: 0.9,
      })).concat(
        jumpEvents.takeoffs.map((e) => ({
          type: 'takeoff' as const,
          tMs: e.tMs,
          refinedTMs: e.refinedTMs,
          confidence: 0.9,
        }))
      );

      const evaluation = evaluateEvents(labels.labels, autoEvents);
      console.log('Accuracy metrics:', evaluation.metrics);
    }
  }

  return jumpEvents;
}
*/

// ============================================================================
// QUICK REFERENCE
// ============================================================================

/**
 * IMPORTS:
 *
 * import { extractJumpEvents } from './src/analysis/eventExtractor';
 * import { refineLandingEdge, refineTakeoffEdge, refineAllTransitions } from './src/analysis/edgeRefinement';
 * import { evaluateEvents, loadVideoLabels, addLabel } from './src/analysis/labelStorage';
 * import { computeContactSignal } from './src/analysis/contactSignal';
 *
 * MAIN API:
 *
 * 1. extractJumpEvents(state, frames, options?, smoothedScores?)
 *    → JumpEvents with refined hops and diagnostics
 *
 * 2. refineLandingEdge(smoothedScores, frameIndex, timestamps, options?)
 *    → EdgeRefinementResult with refinedTMs and subFrameOffsetMs
 *
 * 3. refineTakeoffEdge(smoothedScores, frameIndex, timestamps, options?)
 *    → EdgeRefinementResult
 *
 * 4. evaluateEvents(labels, autoEvents, toleranceMs?)
 *    → EvaluationResult with error metrics (median + p95)
 *
 * OPTIONS:
 *
 * EventExtractorOptions:
 *   - minGctMs: 50
 *   - maxGctMs: 450
 *   - minFlightMs: 100
 *   - maxFlightMs: 900
 *   - minIntervalMs: 50
 *   - refinementMethod: 'max_derivative' | 'level_crossing'
 *   - refinementWindowFrames: 3
 *
 * ACCEPTANCE TARGETS:
 *
 * Pogo hops:
 *   - Landing error: median < 10ms, p95 < 25ms
 *   - Takeoff error: median < 10ms, p95 < 25ms
 *   - GCT error: median < 20ms, p95 < 50ms
 */
