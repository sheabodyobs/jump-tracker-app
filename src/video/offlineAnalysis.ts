/**
 * src/video/offlineAnalysis.ts
 * 
 * Offline video analysis using extracted ROI grayscale frames.
 * Integrates extractRoiGray with biomechanical analysis (ground detection, contact scoring).
 */

import type { LiveCaptureEvent, LiveCaptureSample } from '../analysis/liveCaptureToAnalysis';
import { buildDurationMs } from '../analysis/time';
import { computeContactScoreFromPixels } from './contactScoreProcessor';
import {
    extractRoiGray,
    RoiGrayError,
} from './extractRoiGray';
import { GroundLineDetector } from './groundLineDetector';

/**
 * Configuration for offline analysis.
 */
export interface OfflineAnalysisConfig {
  /** Video file URI */
  videoUri: string;
  /** Total video duration in milliseconds */
  durationMs: number;
  /** Frame rate (usually 120 for slo-mo) */
  fps: number;
  /** ROI bounds (video coordinates) */
  roi: { x: number; y: number; w: number; h: number };
  /** Output resolution for extraction (default 96x64) */
  outputSize?: { w: number; h: number };
  /** Contact score threshold for hysteresis (default 0.6) */
  contactThreshold?: number;
  /** Optional ground Y coordinate (if known); otherwise auto-detect */
  groundY?: number;
  /** Number of frames to sample (default 100) */
  samplesPerSecond?: number;
}

/**
 * Offline analysis result.
 */
export interface OfflineAnalysisResult {
  success: boolean;
  videoUri: string;
  durationMs: number;
  samplesCollected: number;
  eventsDetected: number;
  estimatedGct?: number;
  estimatedFlight?: number;
  samples: LiveCaptureSample[];
  events: LiveCaptureEvent[];
  errors: string[];
  notes: string[];
}

/**
 * Analyze a video file offline by extracting frames, detecting ground line, and computing metrics.
 * 
 * @param config Analysis configuration
 * @returns Offline analysis result with samples and events
 * 
 * @example
 * const result = await analyzeVideoOffline({
 *   videoUri: 'file:///path/to/video.mov',
 *   durationMs: 3000,
 *   fps: 120,
 *   roi: { x: 200, y: 400, w: 400, h: 300 },
 * });
 * console.log(`Detected ${result.eventsDetected} transitions`);
 * console.log(`GCT: ${result.estimatedGct}ms, Flight: ${result.estimatedFlight}ms`);
 */
export async function analyzeVideoOffline(
  config: OfflineAnalysisConfig
): Promise<OfflineAnalysisResult> {
  const errors: string[] = [];
  const notes: string[] = [];
  const samples: LiveCaptureSample[] = [];
  const events: LiveCaptureEvent[] = [];

  const outputSize = config.outputSize || { w: 96, h: 64 };
  const contactThreshold = config.contactThreshold ?? 0.6;
  const samplesPerSecond = config.samplesPerSecond ?? 100;

  // Calculate sample timestamps (uniform spacing)
  const totalFrames = Math.ceil((config.durationMs / 1000) * config.fps);
  const sampleInterval = Math.max(1, Math.ceil(totalFrames / ((config.durationMs / 1000) * samplesPerSecond)));
  const timestamps: number[] = [];
  for (let i = 0; i < totalFrames; i += sampleInterval) {
    timestamps.push(Math.floor((i / config.fps) * 1000));
  }

  console.log('[analyzeVideoOffline] Starting analysis');
  console.log(`  Video: ${config.videoUri}`);
  console.log(`  Duration: ${config.durationMs}ms, FPS: ${config.fps}`);
  console.log(`  Total frames: ${totalFrames}, sampling ${timestamps.length} frames`);

  // Initialize ground line detector
  const detector = new GroundLineDetector({
    bandStartPercent: 60,
    bandEndPercent: 90,
    downsampleFactor: 2,
    edgeThreshold: 0.15,
    stabilityWindow: 5,
    minStabilityFrames: 3,
  });

  let groundY = config.groundY ?? -1;
  let groundConfidence = 0;
  let prevContactScore = 0;
  let prevInContact = false;

  // Process each sample
  for (const timeMs of timestamps) {
    try {
      const frame = await extractRoiGray(
        config.videoUri,
        timeMs,
        config.roi.x,
        config.roi.y,
        config.roi.w,
        config.roi.h,
        outputSize.w,
        outputSize.h
      );

      const frameIndex = Math.round((frame.tMs / 1000) * config.fps);

      // Auto-detect ground if not provided
      if (groundY < 0) {
        const groundResult = detector.detectGroundLineFromPixels({
          width: frame.width,
          height: frame.height,
          gray: frame.gray,
        });

        if (groundResult.confidence > groundConfidence) {
          groundY = groundResult.y;
          groundConfidence = groundResult.confidence;
        }
      }

      // Compute contact score if ground line available
      let contactScore = prevContactScore;
      if (groundY >= 0 && groundY < frame.height) {
        const scoreResult = computeContactScoreFromPixels(
          {
            width: frame.width,
            height: frame.height,
            gray: frame.gray,
          },
          config.roi.x,
          config.roi.y,
          config.roi.w,
          config.roi.h,
          groundY,
          {}
        );
        contactScore = scoreResult.score;
      }

      // Hysteresis state machine
      const inContact: boolean =
        prevInContact
          ? contactScore > contactThreshold * 0.67 // OFF threshold
          : contactScore > contactThreshold; // ON threshold

      // Detect transitions (events)
      if (!prevInContact && inContact) {
        // Landing (off → on)
        events.push({
          type: 'landing',
          frameIndex,
          tMs: frame.tMs,
        });
        console.log(`  [${frame.tMs}ms] Landing detected`);
      } else if (prevInContact && !inContact) {
        // Takeoff (on → off)
        events.push({
          type: 'takeoff',
          frameIndex,
          tMs: frame.tMs,
        });
        console.log(`  [${frame.tMs}ms] Takeoff detected`);
      }

      // Record sample
      samples.push({
        frameIndex,
        tMs: frame.tMs,
        contactScore,
        inContact,
        groundY: groundY >= 0 ? groundY : Math.round(frame.height * 0.9),
        roi: {
          x: config.roi.x,
          y: config.roi.y,
          w: config.roi.w,
          h: config.roi.h,
        },
      });

      prevContactScore = contactScore;
      prevInContact = inContact;
    } catch (error: any) {
      const errorMsg = (error as RoiGrayError).message || String(error);
      errors.push(`${timeMs}ms: ${errorMsg}`);
      console.error(`  [${timeMs}ms] FAILED: ${errorMsg}`);
    }
  }

  // Compute GCT and flight time
  let estimatedGct: number | undefined;
  let estimatedFlight: number | undefined;

  const landingEvents = events.filter((e) => e.type === 'landing');
  const takeoffEvents = events.filter((e) => e.type === 'takeoff');

  if (landingEvents.length > 0 && takeoffEvents.length > 0) {
    // Naive approach: find last landing before first takeoff
    const lastLanding = landingEvents[landingEvents.length - 1];
    const firstTakeoff = takeoffEvents[0];

    if (lastLanding.tMs < firstTakeoff.tMs) {
      estimatedGct = buildDurationMs(lastLanding.tMs, firstTakeoff.tMs);
    }

    // Find next landing after takeoff
    const nextLanding = landingEvents.find((e) => e.tMs > firstTakeoff.tMs);
    if (nextLanding) {
      estimatedFlight = buildDurationMs(firstTakeoff.tMs, nextLanding.tMs);
    }
  }

  const result: OfflineAnalysisResult = {
    success: errors.length < timestamps.length,
    videoUri: config.videoUri,
    durationMs: config.durationMs,
    samplesCollected: samples.length,
    eventsDetected: events.length,
    estimatedGct,
    estimatedFlight,
    samples,
    events,
    errors,
    notes,
  };

  if (groundY >= 0) {
    notes.push(`Ground line detected at Y=${groundY} (confidence=${groundConfidence.toFixed(2)})`);
  } else {
    notes.push('No ground line detected; contact scoring unavailable.');
  }

  if (events.length < 2) {
    notes.push('Fewer than 2 events detected; metrics may be unreliable.');
  }

  console.log('[analyzeVideoOffline] Complete');
  console.log(`  Samples: ${result.samplesCollected}, Events: ${result.eventsDetected}`);
  console.log(`  GCT: ${result.estimatedGct}ms, Flight: ${result.estimatedFlight}ms`);

  return result;
}
