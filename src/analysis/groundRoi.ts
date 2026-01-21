import type { ExtractedFrame } from "../video/FrameProvider";

export type GroundLine = { y: number; method: "manual" | "auto_edge" | "auto_motion" };
export type RoiRect = { x: number; y: number; w: number; h: number };
export type GroundRoiConfig = {
  groundY?: number;
  roi?: RoiRect;
  autoDetect?: boolean;
  roiPaddingPx?: number;
  roiWidthPx?: number;
  roiHeightPx?: number;
};
export type GroundRoiDebug = {
  notes: string[];
  groundLine?: GroundLine;
  roi?: RoiRect;
  scores?: Record<string, number>;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function clampRect(rect: RoiRect, width: number, height: number): RoiRect {
  const w = clamp(rect.w, 1, width);
  const h = clamp(rect.h, 1, height);
  const x = clamp(rect.x, 0, width - w);
  const y = clamp(rect.y, 0, height - h);
  return { x, y, w, h };
}

export function computeGroundAndRoi(
  frames: ExtractedFrame[],
  cfg: GroundRoiConfig
): { groundLine: GroundLine; roi: RoiRect; debug: GroundRoiDebug } {
  const first = frames[0];
  const frameW = first?.width ?? 0;
  const frameH = first?.height ?? 0;
  const notes: string[] = [];

  let groundLine: GroundLine;
  if (typeof cfg.groundY === "number" && Number.isFinite(cfg.groundY)) {
    groundLine = { y: clamp(Math.round(cfg.groundY), 0, Math.max(0, frameH - 1)), method: "manual" };
  } else {
    const assumed = Math.round(frameH * 0.9);
    groundLine = { y: clamp(assumed, 0, Math.max(0, frameH - 1)), method: "manual" };
    notes.push("Ground assumed (bottom 10% of frame).");
  }

  let roi: RoiRect;
  if (cfg.roi) {
    roi = clampRect(cfg.roi, frameW, frameH);
  } else {
    const roiW = cfg.roiWidthPx ?? Math.round(frameW * 0.35);
    const roiH = cfg.roiHeightPx ?? Math.round(frameH * 0.25);
    const roiX = clamp(Math.round(frameW * 0.325), 0, Math.max(0, frameW - roiW));
    const roiPadding = cfg.roiPaddingPx ?? 6;
    const roiY = clamp(
      groundLine.y - roiH - roiPadding,
      0,
      Math.max(0, frameH - roiH)
    );
    roi = clampRect({ x: roiX, y: roiY, w: roiW, h: roiH }, frameW, frameH);
  }

  return {
    groundLine,
    roi,
    debug: { notes, groundLine, roi },
  };
}

export function detectContactEventsFromSignal(samples: { tMs: number; contactScore: number }[]): {
  takeoffMs?: number;
  landingMs?: number;
  contacts: { startMs: number; endMs: number }[];
  debugNotes: string[];
} {
  const onThreshold = 0.65;
  const offThreshold = 0.45;
  const minContactMs = 40;
  const minFlightMs = 40;
  const contacts: { startMs: number; endMs: number }[] = [];
  const debugNotes: string[] = [];

  let inContact = false;
  let contactStart: number | null = null;

  for (const sample of samples) {
    if (!inContact && sample.contactScore >= onThreshold) {
      inContact = true;
      contactStart = sample.tMs;
    } else if (inContact && sample.contactScore <= offThreshold && contactStart !== null) {
      const duration = sample.tMs - contactStart;
      if (duration >= minContactMs) {
        contacts.push({ startMs: contactStart, endMs: sample.tMs });
      }
      inContact = false;
      contactStart = null;
    }
  }

  if (inContact && contactStart !== null && samples.length) {
    const endMs = samples[samples.length - 1].tMs;
    if (endMs - contactStart >= minContactMs) {
      contacts.push({ startMs: contactStart, endMs });
    }
  }

  let takeoffMs: number | undefined;
  let landingMs: number | undefined;
  if (contacts.length >= 2) {
    const first = contacts[0];
    const second = contacts[1];
    const flightDuration = second.startMs - first.endMs;
    if (flightDuration >= minFlightMs) {
      takeoffMs = first.endMs;
      landingMs = second.startMs;
    } else {
      debugNotes.push("Flight window too short for takeoff/landing.");
    }
  } else {
    debugNotes.push("Insufficient contact transitions for takeoff/landing.");
  }

  return { takeoffMs, landingMs, contacts, debugNotes };
}
