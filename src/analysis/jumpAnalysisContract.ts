// src/analysis/jumpAnalysisContract.ts
// Contract-first: the UI and analyzers should depend on this shape.
// v0.2.0 adds per-frame keypoints, ground model, and contact states
// while keeping your existing metrics/events stable.

export type AnalysisStatus = "pending" | "complete" | "error";

export type JumpEvent = {
  t: number | null; // seconds
  frame: number | null;
  confidence: number; // 0..1
};

export type FootAngleDeg = {
  takeoff: number | null;
  landing: number | null;
  confidence: number; // 0..1
};

export type JumpMetrics = {
  // Existing fields (keep for UI continuity)
  gctSeconds: number | null;
  gctMs: number | null;
  flightSeconds: number | null;
  footAngleDeg: FootAngleDeg;

  // New (optional) side-specific outputs for future accuracy
  gctSecondsLeft?: number | null;
  gctSecondsRight?: number | null;
  gctMsLeft?: number | null;
  gctMsRight?: number | null;
};

export type Keypoint2D = {
  x: number | null; // pixels (or normalized if you choose later)
  y: number | null; // pixels (or normalized if you choose later)
  confidence: number; // 0..1
};

export type LegSide = "left" | "right";

export type JointName = "hip" | "knee" | "ankle" | "heel" | "toe";

export type LegJoints2D = {
  hip: Keypoint2D;
  knee: Keypoint2D;
  ankle: Keypoint2D;
  heel: Keypoint2D;
  toe: Keypoint2D;
};

export type FrameJoints2D = {
  left: LegJoints2D;
  right: LegJoints2D;
};

export type GroundModel2D =
  | {
      type: "unknown";
      confidence: number; // 0..1
    }
  | {
      // Simple MVP: assume a constant ground y across the frame.
      type: "y_scalar";
      y: number | null; // pixels
      confidence: number; // 0..1
    }
  | {
      // More general: ground line y = a*x + b in image coords.
      type: "line2d";
      a: number | null;
      b: number | null;
      confidence: number; // 0..1
    };

export type ContactProbability = {
  heel: number; // 0..1
  toe: number; // 0..1
  inContact: boolean;
};

export type FrameContact = {
  left: ContactProbability;
  right: ContactProbability;
};

export type FrameDerived = {
  // Angles/relations that can be computed per-frame.
  // Keep nulls when keypoints/ground are missing.
  left: {
    footAngleDeg: number | null;
    kneeAngleDeg: number | null;
    // Positive means knee is more medial/lateral depending on camera;
    // treat as a normalized diagnostic, not a clinical measure.
    kneeOverToeNorm: number | null;
  };
  right: {
    footAngleDeg: number | null;
    kneeAngleDeg: number | null;
    kneeOverToeNorm: number | null;
  };
};

export type AnalysisFrame = {
  // Time information
  frameIndex: number;
  tMs: number | null;

  // Per-frame pose + ground + contact
  joints2d: FrameJoints2D;
  ground: GroundModel2D;
  contact: FrameContact;

  // Optional: derived per-frame values if your analyzer computes them.
  derived?: FrameDerived;

  // Optional: frame-level confidence summary
  confidence?: number; // 0..1
};

export type JumpAnalysis = {
  // Bump version so you can detect mismatches across app/analyzer.
  version: "0.2.0";

  status: AnalysisStatus;
  measurementStatus: "real" | "synthetic_placeholder";

  // Keep your original shape, extend it.
  metrics: JumpMetrics;

  events: {
    takeoff: JumpEvent;
    landing: JumpEvent;
  };

  // New: per-frame data for knee/toe/heel awareness + ground/contact.
  // For MVP you can ship an empty array and fill it later.
  frames: AnalysisFrame[];

  // New: clip-level ground summary (handy for UI + debug).
  // If you prefer, you can omit this and rely only on frames[].ground.
  groundSummary: GroundModel2D;

  quality: {
    overallConfidence: number; // 0..1
    notes: string[];
    // New: reliability hints you can use to warn users.
    reliability?: {
      viewOk: boolean; // camera angle / framing acceptable
      groundDetected: boolean;
      jointsTracked: boolean;
      contactDetected: boolean;
    };
  };

  aiSummary: { text: string; tags: string[] };

  // Optional error info if status === "error"
  error?: { message: string; code?: string };
};

const ground0: GroundModel2D = { type: "unknown", confidence: 0 };

export const EMPTY_ANALYSIS: JumpAnalysis = {
  version: "0.2.0",
  status: "pending",
  measurementStatus: "synthetic_placeholder",
  metrics: {
    gctSeconds: null,
    gctMs: null,
    flightSeconds: null,
    footAngleDeg: { takeoff: null, landing: null, confidence: 0 },

    // Optional side-specific fields start as null when present.
    gctSecondsLeft: null,
    gctSecondsRight: null,
    gctMsLeft: null,
    gctMsRight: null,
  },
  events: {
    takeoff: { t: null, frame: null, confidence: 0 },
    landing: { t: null, frame: null, confidence: 0 },
  },
  frames: [],
  groundSummary: ground0,
  quality: {
    overallConfidence: 0,
    notes: [],
    reliability: {
      viewOk: false,
      groundDetected: false,
      jointsTracked: false,
      contactDetected: false,
    },
  },
  aiSummary: { text: "", tags: [] },
};
