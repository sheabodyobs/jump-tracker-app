export type JumpEvent = {
  t: number | null;
  frame: number | null;
  confidence: number; // 0..1
};

export type FootAngleDeg = {
  takeoff: number | null;
  landing: number | null;
  confidence: number; // 0..1
};

export type JumpMetrics = {
  gctSeconds: number | null;
  gctMs: number | null;
  flightSeconds: number | null;
  footAngleDeg: FootAngleDeg;
};

export type JumpAnalysis = {
  version: "0.1.0";
  status: "pending" | "complete" | "error";
  metrics: JumpMetrics;
  events: { takeoff: JumpEvent; landing: JumpEvent };
  quality: { overallConfidence: number; notes: string[] };
  aiSummary: { text: string; tags: string[] };
};

export const EMPTY_ANALYSIS: JumpAnalysis = {
  version: "0.1.0",
  status: "pending",
  metrics: {
    gctSeconds: null,
    gctMs: null,
    flightSeconds: null,
    footAngleDeg: { takeoff: null, landing: null, confidence: 0 },
  },
  events: {
    takeoff: { t: null, frame: null, confidence: 0 },
    landing: { t: null, frame: null, confidence: 0 },
  },
  quality: { overallConfidence: 0, notes: [] },
  aiSummary: { text: "", tags: [] },
};
