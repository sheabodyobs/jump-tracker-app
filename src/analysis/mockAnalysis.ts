// src/analysis/mockAnalysis.ts
import { type JumpAnalysis } from "./jumpAnalysisContract";

export const MOCK_ANALYSIS: JumpAnalysis = {
  version: "0.2.0",

  status: "complete",

  // Required by contract
  measurementStatus: "synthetic_placeholder",

  metrics: {
    gctSeconds: 0.18,
    gctMs: 180,
    flightSeconds: 0.42,

    footAngleDeg: {
      takeoff: 12,
      landing: 14,
      confidence: 0.6,
    },

    gctSecondsLeft: null,
    gctSecondsRight: null,
    gctMsLeft: null,
    gctMsRight: null,
  },

  events: {
    takeoff: {
      t: 1.2,        // seconds
      frame: 36,
      confidence: 0.8,
    },
    landing: {
      t: 1.38,       // seconds
      frame: 41,
      confidence: 0.8,
    },
  },

  // MVP can be empty — gate handles evidence
  frames: [],

  groundSummary: {
    type: "unknown",
    confidence: 0,
  },

  quality: {
    overallConfidence: 0.75,
    notes: ["Mock analysis data"],
    reliability: {
      viewOk: true,
      groundDetected: false,
      jointsTracked: false,
      contactDetected: true,
    },
  },

  aiSummary: {
    text: "Synthetic mock analysis. Replace with real analyzer output.",
    tags: ["mock", "synthetic"],
  },
};
