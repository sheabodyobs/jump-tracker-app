// src/analysis/liveCaptureToAnalysis.ts
// Convert live capture-derived contact/events into a JumpAnalysis draft.
// Pass the draft through applyConfidenceGate() before using metrics.

import {
    type AnalysisFrame,
    type ContactProbability,
    type FrameContact,
    type FrameJoints2D,
    type JumpAnalysis,
    type Keypoint2D,
    type LegJoints2D,
} from "./jumpAnalysisContract";
import {
    buildDurationMs,
    buildDurationSeconds,
    buildEventTime,
} from "./time";

/**
 * Per-frame sample from live capture.
 * groundY, roi, and frameIndex come from the capture overlay state.
 */
export type LiveCaptureSample = {
  frameIndex: number;
  tMs: number; // Millisecond timestamp
  contactScore: number; // 0..1 (already smoothed by EMA)
  inContact: boolean; // Hysteresis-derived state
  groundY: number; // Pixel y-coordinate of ground line
  roi?: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
};

/**
 * Events detected during capture (takeoff/landing transitions).
 */
export type LiveCaptureEvent = {
  type: "takeoff" | "landing";
  frameIndex: number;
  tMs: number;
};

export interface LiveCaptureConfig {
  // Nominal FPS for time calculations (used if sample times are missing)
  nominalFps?: number;

  // Minimum number of valid frames to warrant confidence
  minFramesForConfidence?: number;

  // Contact score separation threshold for signal quality
  minContactScoreSeparation?: number;
}

const DEFAULT_CONFIG: LiveCaptureConfig = {
  nominalFps: 120,
  minFramesForConfidence: 20,
  minContactScoreSeparation: 0.3, // e.g., (max - min) >= 0.3
};

/**
 * Build a JumpAnalysis draft from live capture samples and events.
 * The draft will have:
 * - status: "complete"
 * - frames: populated with contact/ground data (joints2d are nulls with confidence 0)
 * - events: takeoff/landing times (in seconds, not ms)
 * - metrics: computed GCT/flight from events
 * - quality.overallConfidence: based on signal stability and frame count
 * - quality.reliability: viewOk, contactDetected, groundDetected, jointsTracked (false)
 *
 * The draft should be passed through applyConfidenceGate() before displaying metrics.
 */
export function buildDraftAnalysisFromCapture(
  samples: LiveCaptureSample[],
  events: LiveCaptureEvent[],
  config?: Partial<LiveCaptureConfig>
): JumpAnalysis {
  const cfg = { ...DEFAULT_CONFIG, ...(config ?? {}) };

  // ---- Compute quality metrics from samples ----
  const contactScores = samples.map((s) => s.contactScore);
  const minScore = Math.min(...contactScores);
  const maxScore = Math.max(...contactScores);
  const scoreRange = maxScore - minScore;

  // Signal stability: higher if scores have clear separation
  const scoreStability = Math.min(1, scoreRange / (cfg.minContactScoreSeparation ?? 0.3));

  // Frame count confidence: higher for more frames
  const frameCountConfidence = Math.min(1, samples.length / (cfg.minFramesForConfidence ?? 20));

  // Check if we have transitions (evidence of motion)
  const hasTransitions = events.length >= 2;

  // Overall confidence: blend of signal quality, frame count, and transitions
  let overallConfidence = (scoreStability * 0.4 + frameCountConfidence * 0.4 + (hasTransitions ? 0.2 : 0)) * 0.8;

  // Bonus if we have well-separated contact events
  if (hasTransitions) {
    overallConfidence = Math.min(1, overallConfidence + 0.1);
  }

  // ---- Build frames array ----
  const frames: AnalysisFrame[] = samples.map((sample) => {
    // Create null keypoints for all joints (will be filled by pose model later)
    const nullKeypoint: Keypoint2D = { x: null, y: null, confidence: 0 };
    const nullLegJoints: LegJoints2D = {
      hip: nullKeypoint,
      knee: nullKeypoint,
      ankle: nullKeypoint,
      heel: nullKeypoint,
      toe: nullKeypoint,
    };

    const joints2d: FrameJoints2D = {
      left: nullLegJoints,
      right: nullLegJoints,
    };

    // Ground model (simple y_scalar)
    const groundModel = {
      type: "y_scalar" as const,
      y: sample.groundY,
      confidence: 0.8, // ground is manually set, so fairly confident
    };

    // Contact: infer from live hysteresis state
    // Left and right are symmetric for now (mirror each other)
    const contactProb: ContactProbability = {
      heel: sample.inContact ? 0.9 : 0.1,
      toe: sample.inContact ? 0.8 : 0.15,
      inContact: sample.inContact,
    };

    const contact: FrameContact = {
      left: contactProb,
      right: contactProb,
    };

    const frame: AnalysisFrame = {
      frameIndex: sample.frameIndex,
      tMs: sample.tMs,
      joints2d,
      ground: groundModel,
      contact,
      confidence: sample.contactScore, // Use contact score as frame confidence
    };

    return frame;
  });

  // ---- Extract takeoff/landing times ----
  const takeoffEvents = events.filter((e) => e.type === "takeoff").sort((a, b) => a.tMs - b.tMs);
  const landingEvents = events.filter((e) => e.type === "landing").sort((a, b) => a.tMs - b.tMs);

  // Determine which came first: typically landing then takeoff (contact -> airborne)
  // For a single jump: first contact phase -> landing, then airborne -> takeoff
  const firstLanding = landingEvents[0] ?? null;
  const firstTakeoff = takeoffEvents[0] ?? null;

  // Use the most recent events for metrics
  const lastLanding = landingEvents[landingEvents.length - 1] ?? null;
  const lastTakeoff = takeoffEvents[takeoffEvents.length - 1] ?? null;

  let gctMs: number | null = null;
  let gctSeconds: number | null = null;
  let flightSeconds: number | null = null;

  // GCT: time from takeoff to landing (contact phase)
  // Always compute from integer ms, then derive seconds via helper
  if (lastTakeoff && lastLanding && lastLanding.tMs > lastTakeoff.tMs) {
    gctMs = buildDurationMs(lastTakeoff.tMs, lastLanding.tMs);
    gctSeconds = buildDurationSeconds(lastTakeoff.tMs, lastLanding.tMs);
  }

  // Flight: time from landing to takeoff (airborne phase)
  // If we have a landing and subsequent takeoff, compute flight
  if (lastLanding && lastTakeoff && lastTakeoff.tMs > lastLanding.tMs) {
    flightSeconds = buildDurationSeconds(lastLanding.tMs, lastTakeoff.tMs);
  }

  // Build event times using canonical helper
  // All event times stored internally as ms; exposed as seconds via buildEventTime
  const takeoffEventTime = firstTakeoff
    ? buildEventTime({
        tMs: firstTakeoff.tMs,
        fps: cfg.nominalFps ?? 120,
      })
    : { tMs: 0, tSeconds: 0 };

  const landingEventTime = firstLanding
    ? buildEventTime({
        tMs: firstLanding.tMs,
        fps: cfg.nominalFps ?? 120,
      })
    : { tMs: 0, tSeconds: 0 };

  // Compute event confidence
  const eventConfidence = hasTransitions ? 0.75 : 0.3;

  // ---- Build the JumpAnalysis draft ----
  const roi = samples.length > 0 ? samples[0].roi : undefined;

  const draft: JumpAnalysis = {
    version: "0.2.0",
    status: "complete",
    measurementStatus: "real",

    metrics: {
      gctSeconds,
      gctMs,
      flightSeconds,
      footAngleDeg: { takeoff: null, landing: null, confidence: 0 },
      gctSecondsLeft: null,
      gctSecondsRight: null,
      gctMsLeft: null,
      gctMsRight: null,
    },

    events: {
      takeoff: {
        t: firstTakeoff ? takeoffEventTime.tSeconds : null,
        frame: firstTakeoff?.frameIndex ?? null,
        confidence: eventConfidence,
      },
      landing: {
        t: firstLanding ? landingEventTime.tSeconds : null,
        frame: firstLanding?.frameIndex ?? null,
        confidence: eventConfidence,
      },
    },

    frames,

    groundSummary: {
      type: "y_scalar",
      y: samples.length > 0 ? samples[0].groundY : null,
      confidence: 0.8,
    },

    quality: {
      overallConfidence: Math.min(1, overallConfidence),
      notes: [
        `Signal stability: ${(scoreStability * 100).toFixed(0)}%`,
        `Frame count: ${samples.length}`,
        `Transitions: ${events.length}`,
      ],
      reliability: {
        viewOk: roi !== undefined, // ROI set means camera framing is good
        groundDetected: samples.length > 0 && samples[0].groundY !== null,
        contactDetected: hasTransitions, // Transitions only exist if contact changed
        jointsTracked: false, // Until pose model is integrated
      },
    },

    aiSummary: {
      text: hasTransitions
        ? `Detected ${events.length} contact transitions from live capture.`
        : "Capture data collected but no contact transitions detected.",
      tags: ["live-capture", "hysteresis-derived", "pre-gated"],
    },

    capture: {
      nominalFps: cfg.nominalFps,
      durationMs: samples.length > 0 ? samples[samples.length - 1].tMs - samples[0].tMs : 0,
    },
  };

  return draft;
}
