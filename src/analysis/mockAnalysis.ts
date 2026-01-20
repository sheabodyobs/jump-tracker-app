import { type JumpAnalysis } from "./jumpAnalysisContract";

export const MOCK_ANALYSIS: JumpAnalysis = {
  version: "0.1.0",
  status: "complete",
  metrics: {
    gctSeconds: 0.18,
    gctMs: 180,
    flightSeconds: 0.42,
    footAngleDeg: { takeoff: 12, landing: 14, confidence: 0.6 },
  },
  events: {
    takeoff: { t: 1200, frame: 36, confidence: 0.8 },
    landing: { t: 1380, frame: 41, confidence: 0.8 },
  },
  quality: { overallConfidence: 0.75, notes: ["Mock data"] },
  aiSummary: { text: "Quick contact (~180ms).", tags: ["gct"] },
};
