// src/analysis/confidenceGate.ts
import { EMPTY_ANALYSIS, type JumpAnalysis } from "./jumpAnalysisContract";

/**
 * Confidence gate (per-metric upgrade)
 *
 * Policy:
 * - If reliability/evidence is bad -> hard fail (status "error", metrics redacted).
 * - If reliability/evidence is good but some metrics are uncertain/implausible:
 *     - Keep status "complete"
 *     - Redact ONLY the unsafe metrics (per-metric gating)
 * - Enforce biomechanical bounds (GCT <= 0.45s, Flight <= 0.9s)
 */

type GateConfig = {
  // Base overall confidence (0..1)
  minOverallConfidence: number;

  // Stricter when we only have events (no frames)
  minOverallConfidenceEventsOnly: number;

  // Reliability requirements (hard fail if violated)
  requireViewOk: boolean;
  requireJointsTracked: boolean;
  requireContactDetected: boolean;
  requireGroundDetected: boolean;

  // Evidence requirement
  requireFramesOrEvents: boolean;

  // Sanity constraints
  maxGctSeconds: number;
  maxFlightSeconds: number;

  // Per-metric minimum confidence (0..1)
  // These are "metric allow" thresholds (not overall).
  minMetricConfidence: {
    gct: number;
    flight: number;
    events: number;
    footAngle: number;
  };

  // If true, allow partial results (keep status "complete" but redact unsafe metrics)
  allowPartialMetrics: boolean;

  // Debug retention on hard failure
  keepFramesOnFailure: boolean;
  maxFramesOnFailure: number;
};

const DEFAULT_CONFIG: GateConfig = {
  minOverallConfidence: 0.6,
  minOverallConfidenceEventsOnly: 0.75,

  requireViewOk: true,
  requireJointsTracked: true,
  requireContactDetected: true,
  requireGroundDetected: false,

  requireFramesOrEvents: true,

  maxGctSeconds: 0.45,
  maxFlightSeconds: 0.9,

  // Per-metric thresholds (tune later)
  minMetricConfidence: {
    gct: 0.65,
    flight: 0.65,
    events: 0.7,
    footAngle: 0.7,
  },

  allowPartialMetrics: true,

  keepFramesOnFailure: true,
  maxFramesOnFailure: 12,
};

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function isFiniteNonNeg(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0;
}

function truthy(v: unknown): boolean {
  return v === true;
}

function redactMetrics(): JumpAnalysis["metrics"] {
  return {
    gctSeconds: null,
    gctMs: null,
    flightSeconds: null,
    footAngleDeg: { takeoff: null, landing: null, confidence: 0 },
    gctSecondsLeft: null,
    gctSecondsRight: null,
    gctMsLeft: null,
    gctMsRight: null,
  };
}

function redactEvents(): JumpAnalysis["events"] {
  return {
    takeoff: { t: null, frame: null, confidence: 0 },
    landing: { t: null, frame: null, confidence: 0 },
  };
}

function takeFramesForFailure(a: JumpAnalysis, config: GateConfig) {
  if (!config.keepFramesOnFailure) return [];
  if (!Array.isArray(a.frames)) return [];
  const n = Math.max(0, config.maxFramesOnFailure);
  return a.frames.slice(0, n);
}

function groundDetectedBySummary(a: JumpAnalysis): boolean {
  const g = a.groundSummary;
  if (!g) return false;
  if (g.type === "unknown") return false;
  return (g.confidence ?? 0) > 0.1;
}

function mergedReliability(a: JumpAnalysis) {
  const rel = a.quality?.reliability;
  const gd = truthy(rel?.groundDetected) || groundDetectedBySummary(a);

  return {
    viewOk: truthy(rel?.viewOk),
    jointsTracked: truthy(rel?.jointsTracked),
    contactDetected: truthy(rel?.contactDetected),
    groundDetected: gd,
  };
}

function hasValidEvents(a: JumpAnalysis): boolean {
  const t0 = a.events?.takeoff?.t;
  const t1 = a.events?.landing?.t;

  return (
    typeof t0 === "number" &&
    typeof t1 === "number" &&
    Number.isFinite(t0) &&
    Number.isFinite(t1) &&
    t1 > t0
  );
}

function hasFrames(a: JumpAnalysis): boolean {
  return Array.isArray(a.frames) && a.frames.length > 0;
}

function requiredOverallConfidence(
  framesOk: boolean,
  eventsOk: boolean,
  config: GateConfig
): { required: number; reason: string } {
  if (framesOk) return { required: config.minOverallConfidence, reason: "frames-present" };
  if (eventsOk) return { required: config.minOverallConfidenceEventsOnly, reason: "events-only" };
  return { required: config.minOverallConfidenceEventsOnly, reason: "no-evidence" };
}

function hardFail(a: JumpAnalysis, notes: string[], config: GateConfig): JumpAnalysis {
  const safeNotes = Array.from(new Set(notes)).filter(Boolean);
  const rel = mergedReliability(a);

  return {
    ...EMPTY_ANALYSIS,
    version: a.version ?? EMPTY_ANALYSIS.version,
    status: "error",
    frames: takeFramesForFailure(a, config),
    groundSummary: a.groundSummary ?? EMPTY_ANALYSIS.groundSummary,
    metrics: redactMetrics(),
    events: redactEvents(),
    quality: {
      overallConfidence: 0,
      notes: safeNotes,
      reliability: {
        viewOk: rel.viewOk,
        jointsTracked: rel.jointsTracked,
        contactDetected: rel.contactDetected,
        groundDetected: rel.groundDetected,
      },
    },
    aiSummary: {
      text: "Insufficient confidence to report metrics.",
      tags: ["confidence-gate", "metrics-redacted"],
    },
    error: {
      message: safeNotes[0] ?? "Confidence gate failed",
      code: "CONFIDENCE_GATE",
    },
  };
}

export function applyConfidenceGate(
  draft: JumpAnalysis,
  override?: Partial<GateConfig>
): JumpAnalysis {
  const config: GateConfig = { ...DEFAULT_CONFIG, ...(override ?? {}) };

  const rel = mergedReliability(draft);

  const notes: string[] = [];
  const userNotes = Array.isArray(draft?.quality?.notes) ? draft.quality.notes : [];
  if (userNotes.length) notes.push(...userNotes);

  // Must claim "complete" to ever show metrics
  if (draft.status !== "complete") {
    notes.push("Analysis not complete.");
    return hardFail(draft, notes, config);
  }

  const framesOk = hasFrames(draft);
  const eventsOk = hasValidEvents(draft);

  if (config.requireFramesOrEvents && !framesOk && !eventsOk) {
    notes.push("No evidence (no frames and no valid takeoff/landing events).");
    return hardFail(draft, notes, config);
  }

  // Dynamic overall threshold based on evidence density
  const overall = clamp01(draft?.quality?.overallConfidence ?? 0);
  const { required, reason } = requiredOverallConfidence(framesOk, eventsOk, config);

  if (overall < required) {
    notes.push(`Low confidence (${overall.toFixed(2)} < ${required.toFixed(2)}; ${reason}).`);
    return hardFail(draft, notes, config);
  }

  // Reliability checks = hard fail
  if (config.requireViewOk && !rel.viewOk) notes.push("Bad camera view.");
  if (config.requireJointsTracked && !rel.jointsTracked) notes.push("Joints not reliably tracked.");
  if (config.requireContactDetected && !rel.contactDetected) notes.push("Ground contact not reliably detected.");
  if (config.requireGroundDetected && !rel.groundDetected) notes.push("Ground not detected.");

  if (
    notes.includes("Bad camera view.") ||
    notes.includes("Joints not reliably tracked.") ||
    notes.includes("Ground contact not reliably detected.") ||
    notes.includes("Ground not detected.")
  ) {
    return hardFail(draft, notes, config);
  }

  // Sanity checks (hard fail)
  const gctSeconds = draft.metrics?.gctSeconds ?? null;
  const gctMs = draft.metrics?.gctMs ?? null;
  const flightSeconds = draft.metrics?.flightSeconds ?? null;
  const takeoffT = draft.events?.takeoff?.t ?? null;
  const landingT = draft.events?.landing?.t ?? null;

  if (gctSeconds !== null) {
    if (!isFiniteNonNeg(gctSeconds) || gctSeconds > config.maxGctSeconds) {
      notes.push("GCT seconds failed sanity checks.");
      return hardFail(draft, notes, config);
    }
  }

  if (flightSeconds !== null) {
    if (!isFiniteNonNeg(flightSeconds) || flightSeconds > config.maxFlightSeconds) {
      notes.push("Flight time failed sanity checks.");
      return hardFail(draft, notes, config);
    }
  }

  if (gctSeconds !== null && gctMs !== null) {
    const msFromS = Math.round(gctSeconds * 1000);
    if (!isFiniteNonNeg(gctMs) || Math.abs(msFromS - gctMs) > 35) {
      notes.push("GCT ms/s mismatch.");
      return hardFail(draft, notes, config);
    }
  }

  if (typeof takeoffT === "number" && typeof landingT === "number") {
    if (Number.isFinite(takeoffT) && Number.isFinite(landingT) && landingT <= takeoffT) {
      notes.push("Landing time must be after takeoff.");
      return hardFail(draft, notes, config);
    }
  }

  // ---- Per-metric gating starts here ----
  const mIn = draft.metrics ?? redactMetrics();
  const eIn = draft.events ?? redactEvents();

  // Use whatever metric-specific confidence signals exist.
  // For now:
  // - GCT + flight confidence come from overallConfidence (until you add per-metric fields)
  // - events confidence from event.confidence
  // - footAngle confidence from footAngleDeg.confidence
  //
  // Later: add metricsConfidence.gct/flight fields to the contract and wire them here.
  const gctConf = overall;
  const flightConf = overall;
  const eventsConf = Math.min(
    clamp01(eIn.takeoff?.confidence ?? 0),
    clamp01(eIn.landing?.confidence ?? 0)
  );
  const footAngleConf = clamp01(mIn.footAngleDeg?.confidence ?? 0);

  // Gate each metric
  const gated = {
    gctSeconds: mIn.gctSeconds,
    gctMs: mIn.gctMs,
    flightSeconds: mIn.flightSeconds,
    footAngleDeg: mIn.footAngleDeg,
    events: eIn,
  };

  // GCT: confidence + bounds + ms/s consistency
  const gctAllow = gctConf >= config.minMetricConfidence.gct;

  if (!gctAllow) {
    gated.gctSeconds = null;
    gated.gctMs = null;
    notes.push(`GCT redacted (low metric confidence ${gctConf.toFixed(2)}).`);
  } else {
    if (gated.gctSeconds !== null) {
      if (!isFiniteNonNeg(gated.gctSeconds) || gated.gctSeconds > config.maxGctSeconds) {
        gated.gctSeconds = null;
        gated.gctMs = null;
        notes.push(`GCT redacted (out of bounds > ${config.maxGctSeconds}s).`);
      }
    }
    if (gated.gctSeconds !== null && gated.gctMs !== null) {
      const msFromS = Math.round(gated.gctSeconds * 1000);
      if (!isFiniteNonNeg(gated.gctMs) || Math.abs(msFromS - gated.gctMs) > 35) {
        gated.gctSeconds = null;
        gated.gctMs = null;
        notes.push("GCT redacted (ms/s mismatch).");
      }
    }
  }

  // Flight: confidence + bounds
  const flightAllow = flightConf >= config.minMetricConfidence.flight;
  if (!flightAllow) {
    gated.flightSeconds = null;
    notes.push(`Flight redacted (low metric confidence ${flightConf.toFixed(2)}).`);
  } else if (gated.flightSeconds !== null) {
    if (!isFiniteNonNeg(gated.flightSeconds) || gated.flightSeconds > config.maxFlightSeconds) {
      gated.flightSeconds = null;
      notes.push(`Flight redacted (out of bounds > ${config.maxFlightSeconds}s).`);
    }
  }

  // Events: confidence
  if (eventsConf < config.minMetricConfidence.events) {
    gated.events = redactEvents();
    notes.push(`Events redacted (low event confidence ${eventsConf.toFixed(2)}).`);
  }

  // Foot angle: confidence (and null-safety)
  if (footAngleConf < config.minMetricConfidence.footAngle) {
    gated.footAngleDeg = { takeoff: null, landing: null, confidence: footAngleConf };
    notes.push(`Foot angle redacted (low foot-angle confidence ${footAngleConf.toFixed(2)}).`);
  }

  // If partial metrics are NOT allowed, any redaction => hard fail
  if (!config.allowPartialMetrics) {
    const anyRedacted =
      gated.gctSeconds === null ||
      gated.gctMs === null ||
      gated.flightSeconds === null ||
      gated.events.takeoff.t === null ||
      gated.events.landing.t === null ||
      gated.footAngleDeg.takeoff === null ||
      gated.footAngleDeg.landing === null;

    if (anyRedacted) {
      notes.push("Partial metrics not allowed; failing gate.");
      return hardFail(draft, notes, config);
    }
  }

  // Return "complete" with gated metrics
  return {
    ...draft,
    status: "complete",
    metrics: {
      ...mIn,
      gctSeconds: gated.gctSeconds,
      gctMs: gated.gctMs,
      flightSeconds: gated.flightSeconds,
      footAngleDeg: gated.footAngleDeg,
    },
    events: gated.events,
    quality: {
      ...draft.quality,
      overallConfidence: overall,
      // preserve original notes + add gate notes (dedup)
      notes: Array.from(new Set([...(userNotes ?? []), ...notes])),
      reliability: {
        viewOk: rel.viewOk,
        jointsTracked: rel.jointsTracked,
        contactDetected: rel.contactDetected,
        groundDetected: rel.groundDetected,
      },
    },
    aiSummary: {
      text: typeof draft.aiSummary?.text === "string" ? draft.aiSummary.text : "",
      tags: Array.isArray(draft.aiSummary?.tags) ? draft.aiSummary.tags : [],
    },
  };
}
