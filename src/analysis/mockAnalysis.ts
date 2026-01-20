import { type JumpAnalysis } from "./jumpAnalysisContract";

export const MOCK_ANALYSIS: JumpAnalysis = {
  version: "0.2.0",
  status: "complete",
  metrics: {
    gctSeconds: 0.18,
    gctMs: 180,
    flightSeconds: 0.42,
    footAngleDeg: { takeoff: 12, landing: 14, confidence: 0.6 },
    gctSecondsLeft: null,
    gctSecondsRight: null,
    gctMsLeft: null,
    gctMsRight: null,
  },
  events: {
    takeoff: { t: 1.2, frame: 36, confidence: 0.8 },
    landing: { t: 1.38, frame: 41, confidence: 0.8 },
  },
  frames: [],
  groundSummary: { type: "unknown", confidence: 0 },
  quality: {
    overallConfidence: 0.75,
    notes: ["Mock data"],
    reliability: {
      viewOk: true,
      groundDetected: false,
      jointsTracked: true,
      contactDetected: true,
    },
  },
  aiSummary: { text: "Quick contact (~180ms).", tags: ["gct"] },
};
