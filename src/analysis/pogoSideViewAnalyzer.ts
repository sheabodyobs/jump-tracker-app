// src/analysis/pogoSideViewAnalyzer.ts
import { Platform } from "react-native";

import type { ExtractedFrame, ExtractedFrameBatch, MeasurementStatus } from "../video/FrameProvider";
import { iosAvFoundationFrameProvider } from "../video/iosAvFoundationFrameProvider";
import { computeContactSignal } from "./contactSignal";
import { extractJumpEvents } from "./eventExtractor";
import { detectFootPatch, type FootPatchResult } from "./footPatchDetector";
import type { FootExtractorDebug, FootSample } from "./footRegionExtractor";
import { extractFootRegion } from "./footRegionExtractor";
import { detectGround, inferRoiFromGround, type GroundDetectorOutput } from "./groundDetector";
import { computeGroundAndRoi, detectContactEventsFromSignal, type GroundRoiConfig } from "./groundRoi";
import {
  EMPTY_ANALYSIS,
  type AnalysisFrame,
  type GroundModel2D,
  type JumpAnalysis,
  type RawContactSample,
} from "./jumpAnalysisContract";
import type { BlobSample, LowerBodyTrackerDebug } from "./lowerBodyTracker";
import { trackLowerBody } from "./lowerBodyTracker";

const TARGET_FPS = 30;
const MAX_FRAMES = 36;
const DEFAULT_SAMPLE_WINDOW_MS = 2000;
const CONTACT_FRAME_THRESHOLD = 0.55;
const SLOW_MO_FPS_THRESHOLD = 120;

type PixelFrame = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  tMs: number;
};

type ContactSignal = {
  inContact: boolean;
  confidence: number;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stdDev(values: number[]): number {
  if (!values.length) return 0;
  const avg = mean(values);
  const variance =
    values.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / values.length;
  return Math.sqrt(variance);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function extractFramesWeb(uri: string): Promise<PixelFrame[]> {
  if (typeof document === "undefined") return Promise.resolve([]);

  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.src = uri;
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.preload = "auto";

    const cleanup = () => {
      video.pause();
      video.remove();
    };

    video.addEventListener(
      "loadedmetadata",
      async () => {
        const durationSec = Number.isFinite(video.duration) ? video.duration : 0;
        const totalFrames = Math.min(
          MAX_FRAMES,
          Math.max(1, Math.floor(durationSec * TARGET_FPS))
        );
        const intervalSec = durationSec > 0 ? durationSec / totalFrames : 1 / TARGET_FPS;

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          cleanup();
          resolve([]);
          return;
        }

        const targetWidth = Math.max(1, Math.floor(video.videoWidth || 320));
        const targetHeight = Math.max(1, Math.floor(video.videoHeight || 180));
        canvas.width = targetWidth;
        canvas.height = targetHeight;

        const frames: PixelFrame[] = [];

        for (let i = 0; i < totalFrames; i += 1) {
          const timeSec = i * intervalSec;
          await new Promise<void>((frameResolve) => {
            const onSeeked = () => {
              video.removeEventListener("seeked", onSeeked);
              frameResolve();
            };
            video.addEventListener("seeked", onSeeked);
            video.currentTime = timeSec;
          });

          ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
          const image = ctx.getImageData(0, 0, targetWidth, targetHeight);
          frames.push({
            width: targetWidth,
            height: targetHeight,
            data: image.data,
            tMs: Math.round(timeSec * 1000),
          });
        }

        cleanup();
        resolve(frames);
      },
      { once: true }
    );

    video.addEventListener(
      "error",
      () => {
        cleanup();
        resolve([]);
      },
      { once: true }
    );
  });
}

function seededRandom(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function generateSyntheticFrames(uri: string): PixelFrame[] {
  const seed = hashString(uri || "pogo");
  const rand = seededRandom(seed);
  const width = 160;
  const height = 90;
  const groundY = Math.floor(height * 0.78);
  const frames: PixelFrame[] = [];

  const contactPattern = [
    ...Array(8).fill(true),
    ...Array(10).fill(false),
    ...Array(10).fill(true),
  ];

  const totalFrames = Math.min(MAX_FRAMES, contactPattern.length);

  for (let i = 0; i < totalFrames; i += 1) {
    const data = new Uint8ClampedArray(width * height * 4);
    const inContact = contactPattern[i];
    const footX = Math.floor(width * (0.45 + rand() * 0.1));
    const footRadius = 6;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const idx = (y * width + x) * 4;
        const base = y > groundY ? 40 : 180;
        let value = base;
        if (inContact && Math.abs(x - footX) < footRadius && y >= groundY - 4 && y <= groundY + 2) {
          value = 30;
        }
        data[idx] = value;
        data[idx + 1] = value;
        data[idx + 2] = value;
        data[idx + 3] = 255;
      }
    }

    frames.push({
      width,
      height,
      data,
      tMs: Math.round((i / TARGET_FPS) * 1000),
    });
  }

  return frames;
}

function decodeBase64(base64: string): Uint8ClampedArray {
  const atobFn = globalThis?.atob;
  if (typeof atobFn === "function") {
    const binary = atobFn(base64);
    const bytes = new Uint8ClampedArray(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (let i = 0; i < base64.length; i += 1) {
    const char = base64[i];
    if (char === "=") break;
    const idx = chars.indexOf(char);
    if (idx === -1) continue;
    buffer = (buffer << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >> bits) & 0xff);
    }
  }

  return new Uint8ClampedArray(output);
}

function buildEvenTimestamps(durationMs: number, count: number) {
  const span = Math.max(1, durationMs);
  const step = span / Math.max(1, count - 1);
  return Array.from({ length: count }, (_, i) => Math.round(i * step));
}

async function sampleFramesForAnalysis(uri: string): Promise<{
  pixelFrames: PixelFrame[];
  batch?: ExtractedFrameBatch;
  measurementStatus: MeasurementStatus;
  nominalFps?: number;
}> {
  if (Platform.OS === "ios") {
    const initialTimestamps = buildEvenTimestamps(DEFAULT_SAMPLE_WINDOW_MS, MAX_FRAMES);
    const initialBatch = await iosAvFoundationFrameProvider.sampleFrames(uri, initialTimestamps, {
      maxWidth: 256,
      format: "rgba",
    });

    const durationMs = initialBatch.durationMs;
    const batch =
      durationMs && durationMs > DEFAULT_SAMPLE_WINDOW_MS
        ? await iosAvFoundationFrameProvider.sampleFrames(
            uri,
            buildEvenTimestamps(durationMs, MAX_FRAMES),
            { maxWidth: 256, format: "rgba" }
          )
        : initialBatch;

    if (batch.measurementStatus === "real" && batch.frames.length) {
      const pixelFrames = batch.frames.map((frame) => ({
        width: frame.width,
        height: frame.height,
        tMs: frame.tMs,
        data: decodeBase64(frame.dataBase64),
      }));
      return { pixelFrames, batch, measurementStatus: "real", nominalFps: batch.nominalFps };
    }

    return {
      pixelFrames: generateSyntheticFrames(uri),
      batch,
      measurementStatus: "synthetic_placeholder",
      nominalFps: batch.nominalFps,
    };
  }

  if (Platform.OS === "web") {
    const frames = await extractFramesWeb(uri);
    if (frames.length) {
      return { pixelFrames: frames, measurementStatus: "real" };
    }
  }

  return {
    pixelFrames: generateSyntheticFrames(uri),
    measurementStatus: "synthetic_placeholder",
  };
}

function toExtractedFrames(frames: PixelFrame[]): ExtractedFrame[] {
  return frames.map((frame) => ({
    tMs: frame.tMs,
    width: frame.width,
    height: frame.height,
    format: "rgba",
    dataBase64: "",
  }));
}

/**
 * Convert RGBA pixel frames to grayscale for ground detection.
 */
function toGrayscaleFrames(
  frames: PixelFrame[]
): Array<{ data: Uint8ClampedArray; width: number; height: number; tMs: number }> {
  return frames.map((frame) => {
    const gray = new Uint8ClampedArray(frame.width * frame.height);
    for (let i = 0; i < frame.data.length; i += 4) {
      const r = frame.data[i];
      const g = frame.data[i + 1];
      const b = frame.data[i + 2];
      const idx = i / 4;
      gray[idx] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    }
    return {
      data: gray,
      width: frame.width,
      height: frame.height,
      tMs: frame.tMs,
    };
  });
}

/**
 * Convert GroundDetectorOutput to GroundModel2D for contract compatibility.
 */
function groundDetectorToModel(detector: GroundDetectorOutput): GroundModel2D {
  if (!detector.detected) {
    return { type: "unknown", confidence: 0 };
  }

  if (detector.theta === null || detector.rho === null) {
    return { type: "unknown", confidence: detector.confidence };
  }

  return {
    type: "hough_polar",
    theta: detector.theta,
    rho: detector.rho,
    line: detector.line,
    confidence: detector.confidence,
    method: detector.method,
    diagnostics: detector.diagnostics,
  };
}

function lumaAt(data: Uint8ClampedArray, idx: number) {
  const r = data[idx];
  const g = data[idx + 1];
  const b = data[idx + 2];
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function extractRoiLuma(frame: PixelFrame, roi: { x: number; y: number; w: number; h: number }) {
  const luma = new Float32Array(roi.w * roi.h);
  let ptr = 0;
  for (let y = 0; y < roi.h; y += 1) {
    const row = roi.y + y;
    for (let x = 0; x < roi.w; x += 1) {
      const col = roi.x + x;
      const idx = (row * frame.width + col) * 4;
      luma[ptr] = lumaAt(frame.data, idx);
      ptr += 1;
    }
  }
  return luma;
}

function computeEdgeEnergy(luma: Float32Array, roiW: number, roiH: number) {
  let sum = 0;
  let count = 0;
  for (let y = 1; y < roiH; y += 1) {
    const rowIdx = y * roiW;
    const prevRowIdx = (y - 1) * roiW;
    for (let x = 0; x < roiW; x += 1) {
      sum += Math.abs(luma[rowIdx + x] - luma[prevRowIdx + x]);
      count += 1;
    }
  }
  return count ? sum / count : 0;
}

function computeBottomBandEnergy(luma: Float32Array, roiW: number, roiH: number) {
  const bandH = Math.max(1, Math.round(roiH * 0.15));
  const startRow = roiH - bandH;
  let sum = 0;
  let count = 0;
  for (let y = startRow; y < roiH; y += 1) {
    const rowIdx = y * roiW;
    const prevRowIdx = Math.max(0, y - 1) * roiW;
    for (let x = 0; x < roiW; x += 1) {
      sum += Math.abs(luma[rowIdx + x] - luma[prevRowIdx + x]);
      count += 1;
    }
  }
  return count ? sum / count : 0;
}

/**
 * Orchestrate the full pipeline: groundModel -> roiInference -> contactSignal -> eventExtractor
 * Returns confidence scores for each stage and overall pass/fail
 */
type PipelineResult = {
  groundConfidence: number;
  footPatchConfidence: number;
  contactConfidence: number;
  eventConfidence: number;
  rejectionReasons: string[];
  passed: boolean;
};

function orchestratePipeline(
  grayscaleFrames: { width: number; height: number; data: Uint8ClampedArray }[],
  groundModel: GroundModel2D,
  roi: { x: number; y: number; w: number; h: number },
  pixelFrames: PixelFrame[],
  rawSamples: RawContactSample[],
  footPatchResult: FootPatchResult | null
): PipelineResult {
  const reasons: string[] = [];
  
  // Stage 1: Ground confidence (already computed, use existing)
  const GROUND_CONFIDENCE_MIN = 0.3;
  const groundConfidence = groundModel.type !== "unknown" ? groundModel.confidence : 0;
  if (groundConfidence < GROUND_CONFIDENCE_MIN) {
    reasons.push(`Ground confidence too low: ${groundConfidence.toFixed(2)} < ${GROUND_CONFIDENCE_MIN}`);
  }

  // Stage 2: Foot patch confidence
  const footPatchConfidence = footPatchResult?.confidence ?? 0;
  if (footPatchConfidence < 0.3) {
    reasons.push(`Foot patch confidence too low: ${footPatchConfidence.toFixed(2)}`);
  }

  // Stage 3: Contact Signal confidence via computeContactSignal
  let contactConfidence = 0.5;
  try {
    if (pixelFrames.length > 0) {
      const contactSignal = computeContactSignal(pixelFrames, roi);
      contactConfidence = contactSignal.confidence;
      if (contactConfidence < 0.25) {
        reasons.push(`Contact signal confidence too low: ${contactConfidence.toFixed(2)}`);
      }
    }
  } catch (e) {
    reasons.push(`Contact signal failed: ${e instanceof Error ? e.message : "unknown"}`);
    contactConfidence = 0;
  }

  // Stage 4: Event Confidence via extractJumpEvents
  let eventConfidence = 0.5;
  try {
    if (rawSamples.length > 0) {
      const contactState = rawSamples.map((s) => (s.contactScore >= CONTACT_FRAME_THRESHOLD ? 1 : 0) as 0 | 1);
      
      // Compute contact signal for edge refinement
      const contactSignal = computeContactSignal(pixelFrames, roi);
      
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
        contactSignal.scoreSmoothed // Pass smoothed scores for edge refinement
      );
      eventConfidence = jumpEvents.confidence;
      if (eventConfidence < 0.25) {
        reasons.push(`Event confidence too low: ${eventConfidence.toFixed(2)}`);
      }
    }
  } catch (e) {
    reasons.push(`Event extraction failed: ${e instanceof Error ? e.message : "unknown"}`);
    eventConfidence = 0;
  }

  // Overall pass: all stages above minimum
  const CONFIDENCE_THRESHOLD = 0.25;
  const passed = 
    groundConfidence >= GROUND_CONFIDENCE_MIN &&
    footPatchConfidence >= CONFIDENCE_THRESHOLD &&
    contactConfidence >= CONFIDENCE_THRESHOLD &&
    eventConfidence >= CONFIDENCE_THRESHOLD;

  if (!passed && reasons.length === 0) {
    reasons.push("Pipeline failed confidence checks");
  }

  return {
    groundConfidence,
    footPatchConfidence,
    contactConfidence,
    eventConfidence,
    rejectionReasons: reasons,
    passed,
  };
}

function analyzeContactFromRoi(pixelFrames: PixelFrame[], groundLineY: number, roi: { x: number; y: number; w: number; h: number }) {
  const analyzedFrames: AnalysisFrame[] = [];
  const contactSignals: ContactSignal[] = [];
  let prevLuma: Float32Array | null = null;
  const rawSamples: RawContactSample[] = [];

  pixelFrames.forEach((frame) => {
    const luma = extractRoiLuma(frame, roi);
    const edgeEnergy = computeEdgeEnergy(luma, roi.w, roi.h);
    const bottomBandEnergy = computeBottomBandEnergy(luma, roi.w, roi.h);
    const motionEnergy = prevLuma
      ? luma.reduce((sum, value, idx) => sum + Math.abs(value - prevLuma![idx]), 0) /
        Math.max(1, luma.length)
      : 0;

    rawSamples.push({
      tMs: frame.tMs,
      contactScore: 0,
      edgeEnergy,
      motionEnergy,
      bottomBandEnergy,
    });
    prevLuma = luma;
  });
  
  const edgeValues = rawSamples.map((s) => s.edgeEnergy);
  const motionValues = rawSamples.map((s) => s.motionEnergy);
  const bottomValues = rawSamples.map((s) => s.bottomBandEnergy);
  const edgeMin = edgeValues.length ? Math.min(...edgeValues) : 0;
  const edgeMax = edgeValues.length ? Math.max(...edgeValues) : 0;
  const motionMin = motionValues.length ? Math.min(...motionValues) : 0;
  const motionMax = motionValues.length ? Math.max(...motionValues) : 0;

  rawSamples.forEach((sample) => {
    const edgeNorm = normalize(sample.edgeEnergy, edgeMin, edgeMax);
    const motionNorm = normalize(sample.motionEnergy, motionMin, motionMax);
    sample.contactScore = clamp01(edgeNorm * (1 - motionNorm));
  });

  rawSamples.forEach((sample, idx) => {
    const contact = {
      inContact: sample.contactScore >= CONTACT_FRAME_THRESHOLD,
      confidence: clamp01(sample.contactScore),
    };
    contactSignals.push(contact);
    analyzedFrames.push(makeFrame(pixelFrames[idx], groundLineY, contact));
  });

  const contactScores = rawSamples.map((s) => s.contactScore);
  const contactScoreMin = contactScores.length ? Math.min(...contactScores) : 0;
  const contactScoreMax = contactScores.length ? Math.max(...contactScores) : 0;
  const contactScoreMean = mean(contactScores);
  const contactScoreStd = stdDev(contactScores);
  const edgeMean = mean(edgeValues);
  const motionMean = mean(motionValues);
  const bottomMean = mean(bottomValues);

  return {
    analyzedFrames,
    contactSignals,
    rawSamples,
    stats: {
      contactScoreMin,
      contactScoreMax,
      contactScoreMean,
      contactScoreStd,
      edgeMean,
      motionMean,
      bottomMean,
    },
  };
}

function normalize(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return 0;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 1e-6) return 0.5;
  return clamp01((value - min) / (max - min));
}

function makeFrame(
  frame: PixelFrame,
  groundY: number,
  contact: ContactSignal
): AnalysisFrame {
  const emptyPoint = { x: null, y: null, confidence: 0 };
  const emptyLeg = {
    hip: emptyPoint,
    knee: emptyPoint,
    ankle: emptyPoint,
    heel: emptyPoint,
    toe: emptyPoint,
  };

  const joints = {
    left: {
      ...emptyLeg,
    },
    right: {
      ...emptyLeg,
    },
  };

  const groundModel: GroundModel2D =
    Number.isFinite(groundY)
      ? { type: "y_scalar", y: groundY, confidence: 0.4 }
      : { type: "unknown", confidence: 0 };

  return {
    frameIndex: Math.round(frame.tMs / (1000 / TARGET_FPS)),
    tMs: frame.tMs,
    joints2d: joints,
    ground: groundModel,
    contact: {
      left: {
        inContact: contact.inContact,
        heel: contact.confidence,
        toe: contact.confidence,
      },
      right: {
        inContact: contact.inContact,
        heel: contact.confidence,
        toe: contact.confidence,
      },
    },
    confidence: contact.confidence,
  };
}

function deriveMetrics(frames: AnalysisFrame[], takeoffIndex: number, landingIndex: number) {
  if (takeoffIndex <= 0 || landingIndex <= takeoffIndex) {
    return { gctSeconds: null, gctMs: null, flightSeconds: null };
  }

  let contactStart = takeoffIndex - 1;
  while (contactStart > 0 && frames[contactStart - 1].contact.left.inContact) {
    contactStart -= 1;
  }

  const takeoffTime = frames[takeoffIndex].tMs ?? 0;
  const contactStartTime = frames[contactStart].tMs ?? 0;
  const landingTime = frames[landingIndex].tMs ?? 0;

  const gctSeconds = Math.max(0, (takeoffTime - contactStartTime) / 1000);
  const flightSeconds = Math.max(0, (landingTime - takeoffTime) / 1000);

  return {
    gctSeconds,
    gctMs: Math.round(gctSeconds * 1000),
    flightSeconds,
  };
}

function findNearestFrameIndex(frames: AnalysisFrame[], tMs: number | undefined) {
  if (typeof tMs !== "number") return null;
  let bestIdx = 0;
  let bestDelta = Number.POSITIVE_INFINITY;
  frames.forEach((frame, idx) => {
    if (typeof frame.tMs !== "number") return;
    const delta = Math.abs(frame.tMs - tMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIdx = idx;
    }
  });
  return frames.length ? bestIdx : null;
}

function findNearestSampleIndex(samples: { tMs: number }[], tMs: number | undefined) {
  if (typeof tMs !== "number") return null;
  let bestIdx = 0;
  let bestDelta = Number.POSITIVE_INFINITY;
  samples.forEach((sample, idx) => {
    const delta = Math.abs(sample.tMs - tMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIdx = idx;
    }
  });
  return samples.length ? bestIdx : null;
}

function buildSlowMoFailure(note: string, nominalFps?: number): JumpAnalysis {
  return {
    ...EMPTY_ANALYSIS,
    status: "complete",
    measurementStatus: "synthetic_placeholder",
    capture: {
      nominalFps,
    },
    quality: {
      overallConfidence: 0,
      notes: [note],
      reliability: {
        viewOk: false,
        groundDetected: false,
        jointsTracked: false,
        contactDetected: false,
      },
    },
    aiSummary: {
      text: "Slow-motion capture required.",
      tags: ["CAPTURE_NOT_SLOWMO"],
    },
    analysisDebug: {
      lowerBody: {
        notes: [
          `Capture FPS: ${typeof nominalFps === "number" ? nominalFps.toFixed(1) : "unknown"}`,
        ],
        thresholds: { motionThresh: 0, minArea: 0 },
        stats: {
          validFrames: 0,
          areaMin: 0,
          areaMax: 0,
          centroidYMin: 0,
          centroidYMax: 0,
          bottomBandEnergyMin: 0,
          bottomBandEnergyMax: 0,
        },
      },
    },
  };
}

export async function analyzePogoSideView(
  uri: string,
  config: GroundRoiConfig = {}
): Promise<JumpAnalysis> {
  if (Platform.OS !== "ios") {
    return buildSlowMoFailure("Requires iPhone Slo-Mo (≥120fps).");
  }

  const { pixelFrames, batch, measurementStatus, nominalFps } = await sampleFramesForAnalysis(uri);

  if (measurementStatus !== "real" || !nominalFps) {
    return buildSlowMoFailure("Requires iPhone Slo-Mo (≥120fps).", nominalFps);
  }

  if (nominalFps < SLOW_MO_FPS_THRESHOLD) {
    return buildSlowMoFailure("Requires iPhone Slo-Mo (≥120fps).", nominalFps);
  }

  const extractedFrames =
    measurementStatus === "real" && batch?.frames?.length ? batch.frames : toExtractedFrames(pixelFrames);

  // ========== NEW: Camera-invariant ground detection ==========
  const grayscaleFrames = toGrayscaleFrames(pixelFrames);
  const groundDetectorOutput = detectGround(grayscaleFrames);
  const groundModel = groundDetectorToModel(groundDetectorOutput);

  // Fail-safe: if ground confidence is too low, no metrics
  const GROUND_CONFIDENCE_THRESHOLD = 0.3;
  const groundConfident = groundModel.type !== "unknown" && groundModel.confidence >= GROUND_CONFIDENCE_THRESHOLD;

  // Foot patch detection (preferred over legacy ROI inference)
  let roi: { x: number; y: number; w: number; h: number };
  let footPatchResult: FootPatchResult | null = null;
  let footPatchConfidence = 0;

  if (groundConfident) {
    footPatchResult = detectFootPatch(grayscaleFrames, groundModel, {
      bandAboveGroundPx: 20,
      roiSize: { w: 32, h: 24 },
      stride: 2,
      windowFrames: Math.min(120, grayscaleFrames.length),
      trackMaxShiftPx: 6,
      minFootness: 0.35,
    });
  }

  if (footPatchResult && footPatchResult.confidence >= 0.25) {
    roi = footPatchResult.roi;
    footPatchConfidence = footPatchResult.confidence;
  } else if (groundDetectorOutput.line) {
    // Fallback to motion-based ROI from ground inference (legacy)
    const roiInference = inferRoiFromGround(grayscaleFrames, groundDetectorOutput);
    if (roiInference.roi) {
      roi = roiInference.roi;
      footPatchConfidence = Math.min(0.25, roiInference.confidence); // keep low to encourage rejection
    } else {
      const { roi: legacyRoi } = computeGroundAndRoi(extractedFrames, config);
      roi = legacyRoi;
      footPatchConfidence = 0.1;
    }
  } else {
    const { roi: legacyRoi } = computeGroundAndRoi(extractedFrames, config);
    roi = legacyRoi;
    footPatchConfidence = 0.1;
  }

  // Determine groundLine.y for downstream code (legacy compatibility)
  let groundLineY: number;
  if (groundDetectorOutput.detected && groundDetectorOutput.theta !== null && groundDetectorOutput.rho !== null) {
    // Compute ground y at frame center (x = width/2)
    const midX = grayscaleFrames[0].width / 2;
    if (Math.abs(Math.sin(groundDetectorOutput.theta)) > 1e-6) {
      groundLineY = (groundDetectorOutput.rho - midX * Math.cos(groundDetectorOutput.theta)) /
        Math.sin(groundDetectorOutput.theta);
    } else {
      groundLineY = Math.floor(grayscaleFrames[0].height * 0.9); // Fallback
    }
  } else {
    groundLineY = Math.floor(grayscaleFrames[0].height * 0.9); // Fallback to bottom
  }
  // ========== End of ground detection section ==========

  const { analyzedFrames, contactSignals, rawSamples, stats } = analyzeContactFromRoi(
    pixelFrames,
    groundLineY,
    roi
  );

  // ========== NEW: Full pipeline confidence gating ==========
  const pipelineResult = orchestratePipeline(grayscaleFrames, groundModel, roi, pixelFrames, rawSamples, footPatchResult);
  // ==========================================================

  const lowerBodyResult: { samples: BlobSample[]; debug: LowerBodyTrackerDebug } =
    measurementStatus === "real" && extractedFrames.length
      ? trackLowerBody(extractedFrames, roi, groundLineY)
      : {
          samples: [],
          debug: {
            notes: ["Lower-body tracker skipped (no real frames)."],
            thresholds: { motionThresh: 0, minArea: 0 },
            stats: {
              validFrames: 0,
              areaMin: 0,
              areaMax: 0,
              centroidYMin: 0,
              centroidYMax: 0,
              bottomBandEnergyMin: 0,
              bottomBandEnergyMax: 0,
            },
          },
        };
  const footResult: { samples: FootSample[]; debug: FootExtractorDebug } =
    measurementStatus === "real" && extractedFrames.length
      ? extractFootRegion(extractedFrames, roi, groundLineY)
      : {
          samples: [],
          debug: {
            notes: ["Foot region extractor skipped (no real frames)."],
            thresholds: {
              motionThresh: 0,
              minFootArea: 0,
              groundBandPx: 0,
            },
            stats: {
              validFrames: 0,
              areaMin: 0,
              areaMax: 0,
              angleMin: 0,
              angleMax: 0,
              strikeBiasMin: 0,
              strikeBiasMax: 0,
              groundBandDensityMin: 0,
              groundBandDensityMax: 0,
            },
          },
        };

  // Extract jump events (landing/takeoff transitions) from contact samples
  const contactState = rawSamples.map((s) => (s.contactScore >= CONTACT_FRAME_THRESHOLD ? 1 : 0) as 0 | 1);
  
  // Compute contact signal for edge refinement (smoothed scores)
  const contactSignalForRefinement = computeContactSignal(pixelFrames, roi);
  
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
    contactSignalForRefinement.scoreSmoothed // Pass smoothed scores for edge refinement
  );

  // Legacy event detection (for backward compatibility)
  const contactEvents = detectContactEventsFromSignal(
    rawSamples.map((s) => ({ tMs: s.tMs, contactScore: s.contactScore }))
  );
  const lowerBodySamples = lowerBodyResult.samples;
  const validLowerBody = lowerBodySamples.filter((sample) => sample.valid);
  const areaMedian = median(validLowerBody.map((sample) => sample.area));
  const bottomMedian = median(lowerBodySamples.map((sample) => sample.bottomBandEnergy));
  const confirmationNotes: string[] = [];
  const footNotes: string[] = [];
  const footSamples = footResult.samples;
  const footValidRatio = footSamples.length
    ? footSamples.filter((sample) => sample.valid).length / footSamples.length
    : 0;
  if (footSamples.length && footValidRatio < 0.7) {
    footNotes.push("Foot region unstable (low valid frame ratio).");
  }

  let confirmedTakeoff = jumpEvents.hops.length > 0 ? jumpEvents.hops[0]?.takeoffMs : contactEvents.takeoffMs;
  if (typeof confirmedTakeoff === "number") {
    const idx = findNearestSampleIndex(lowerBodySamples, confirmedTakeoff);
    const curr = typeof idx === "number" ? lowerBodySamples[idx] : undefined;
    const next = typeof idx === "number" ? lowerBodySamples[idx + 1] : undefined;
    const centroidMovingUp =
      curr?.valid &&
      next?.valid &&
      typeof curr.centroidY === "number" &&
      typeof next.centroidY === "number" &&
      next.centroidY < curr.centroidY - 1;
    const bottomDropped = curr?.bottomBandEnergy !== undefined && curr.bottomBandEnergy < bottomMedian;
    if (!centroidMovingUp || !bottomDropped) {
      confirmationNotes.push("Takeoff rejected by lower-body confirmation.");
      confirmedTakeoff = undefined;
    }
  }

  const footAreaMedian = median(footSamples.filter((s) => s.valid).map((s) => s.footArea));
  const footDensityMedian = median(footSamples.map((s) => s.groundBandDensity));

  if (typeof confirmedTakeoff === "number" && footSamples.length) {
    const footIdx = findNearestSampleIndex(footSamples, confirmedTakeoff);
    const footSample = typeof footIdx === "number" ? footSamples[footIdx] : undefined;
    if (footSample?.valid) {
      const areaDrop = footAreaMedian > 0 && footSample.footArea < footAreaMedian * 0.5;
      const densityDrop = footSample.groundBandDensity < footDensityMedian * 0.6;
      if (!areaDrop && !densityDrop) {
        confirmationNotes.push("Takeoff rejected by foot-region confirmation.");
        confirmedTakeoff = undefined;
      }
    }
  }

  let confirmedLanding = jumpEvents.hops.length > 0 ? jumpEvents.hops[0]?.landingMs : contactEvents.landingMs;
  if (typeof confirmedLanding === "number") {
    const idx = findNearestSampleIndex(lowerBodySamples, confirmedLanding);
    const curr = typeof idx === "number" ? lowerBodySamples[idx] : undefined;
    const areaSpike = areaMedian > 0 && (curr?.area ?? 0) > areaMedian * 1.5;
    const bottomSpike = curr?.bottomBandEnergy !== undefined && curr.bottomBandEnergy > bottomMedian;
    if (!bottomSpike && !areaSpike) {
      confirmationNotes.push("Landing rejected by lower-body confirmation.");
      confirmedLanding = undefined;
    }
  }

  if (typeof confirmedLanding === "number" && footSamples.length) {
    const footIdx = findNearestSampleIndex(footSamples, confirmedLanding);
    const footSample = typeof footIdx === "number" ? footSamples[footIdx] : undefined;
    const prevSample = typeof footIdx === "number" ? footSamples[footIdx - 1] : undefined;
    if (footSample?.valid) {
      const areaSpike = footAreaMedian > 0 && footSample.footArea > footAreaMedian * 1.5;
      const densitySpike = footSample.groundBandDensity > footDensityMedian * 1.4;
      const strikeShift =
        typeof footSample.strikeBias === "number" &&
        typeof prevSample?.strikeBias === "number" &&
        Math.abs(footSample.strikeBias - prevSample.strikeBias) > 0.3;
      if (!areaSpike && !densitySpike && !strikeShift) {
        confirmationNotes.push("Landing rejected by foot-region confirmation.");
        confirmedLanding = undefined;
      }
    }
  }

  const takeoffIndex = findNearestFrameIndex(analyzedFrames, confirmedTakeoff);
  const landingIndex = findNearestFrameIndex(analyzedFrames, confirmedLanding);
  const metrics = deriveMetrics(analyzedFrames, takeoffIndex ?? -1, landingIndex ?? -1);

  const trackedRatio =
    contactSignals.filter((signal) => signal.confidence > 0.2).length /
    Math.max(1, contactSignals.length);

  // Use detected ground model from camera-invariant detector
  const groundSummary = groundModel;

  const viewOk = groundSummary.type !== "unknown" && groundSummary.confidence > 0.3;
  const jointsTracked = trackedRatio >= 0.6;
  const contactDetected =
    typeof confirmedTakeoff === "number" && typeof confirmedLanding === "number";

  let baseConfidence = clamp01(
    0.2 +
      (viewOk ? 0.3 : 0) +
      (jointsTracked ? 0.25 : 0) +
      (contactDetected ? 0.25 : 0) +
      (groundSummary.confidence > 0.4 ? 0.1 : 0)
  );
  if (footSamples.length) {
    const footFactor = footValidRatio >= 0.7 ? 1 : footValidRatio >= 0.4 ? 0.85 : 0.7;
    baseConfidence = clamp01(baseConfidence * footFactor);
  }
  const stabilityPenalty =
    stats.contactScoreStd > 0.25 ? Math.min(0.08, (stats.contactScoreStd - 0.25) * 0.2) : 0;
  const confidenceWithStability = clamp01(baseConfidence - stabilityPenalty);
  const overallConfidence =
    measurementStatus === "real" ? confidenceWithStability : Math.min(confidenceWithStability, 0.35);

  const notes = [
    `Analyzer: ${
      measurementStatus === "real" ? batch?.debug?.provider ?? "web-canvas" : "synthetic"
    }.`,
    `Capture FPS: ${typeof nominalFps === "number" ? nominalFps.toFixed(1) : "unknown"}.`,
    `Frames: ${analyzedFrames.length}.`,
    `FPS (target): ${TARGET_FPS}.`,
    `Ground detection: ${groundSummary.type} (confidence=${groundSummary.confidence.toFixed(2)}).`,
    `Foot patch: confidence=${footPatchConfidence.toFixed(2)}.`,
    `Pipeline: ground=${pipelineResult.groundConfidence.toFixed(2)}, foot=${pipelineResult.footPatchConfidence.toFixed(2)}, contact=${pipelineResult.contactConfidence.toFixed(2)}, event=${pipelineResult.eventConfidence.toFixed(2)}.`,
    ...(pipelineResult.rejectionReasons.length > 0 ? [`Pipeline rejections: ${pipelineResult.rejectionReasons.join("; ")}.`] : []),
    `Contact frames: ${contactSignals.filter((signal) => signal.inContact).length}.`,
    contactDetected
      ? `Takeoff @ ${confirmedTakeoff}ms, landing @ ${confirmedLanding}ms.`
      : "No contact transitions detected.",
    metrics.gctSeconds !== null ? `GCT: ${metrics.gctSeconds.toFixed(3)}s.` : "GCT unavailable.",
    metrics.flightSeconds !== null ? `Flight: ${metrics.flightSeconds.toFixed(3)}s.` : "Flight unavailable.",
    `ContactScore std: ${stats.contactScoreStd.toFixed(2)}.`,
    ...(measurementStatus === "real"
      ? []
      : ["Synthetic placeholder output (not a real measurement)."]),
    ...(batch?.error?.message ? [`Frame extraction error: ${batch.error.message}`] : []),
    ...(groundDetectorOutput.diagnostics?.stageSummary
      ? [`Ground detection: ${groundDetectorOutput.diagnostics.stageSummary}`]
      : []),
    ...contactEvents.debugNotes,
    ...confirmationNotes,
    ...footNotes,
    `ContactScore min/mean/max: ${stats.contactScoreMin.toFixed(2)} / ${stats.contactScoreMean.toFixed(
      2
    )} / ${stats.contactScoreMax.toFixed(2)}.`,
  ];

  const takeoffTime = confirmedTakeoff;
  const landingTime = confirmedLanding;
  const footTakeoffSampleIndex = findNearestSampleIndex(footSamples, confirmedTakeoff);
  const footLandingSampleIndex = findNearestSampleIndex(footSamples, confirmedLanding);
  const footTakeoffSample =
    typeof footTakeoffSampleIndex === "number" ? footSamples[footTakeoffSampleIndex] : undefined;
  const footLandingSample =
    typeof footLandingSampleIndex === "number" ? footSamples[footLandingSampleIndex] : undefined;
  const footAngleTakeoff =
    footTakeoffSample?.valid && typeof footTakeoffSample.footAngleDeg === "number"
      ? footTakeoffSample.footAngleDeg
      : null;
  const footAngleLanding =
    footLandingSample?.valid && typeof footLandingSample.footAngleDeg === "number"
      ? footLandingSample.footAngleDeg
      : null;

  // ========== FAIL-SAFE: No metrics if ground OR pipeline confidence below threshold ==========
  const metricsGated = groundConfident && pipelineResult.passed
    ? {
        ...EMPTY_ANALYSIS.metrics,
        gctSeconds: metrics.gctSeconds,
        gctMs: metrics.gctMs,
        flightSeconds: metrics.flightSeconds,
        footAngleDeg: {
          takeoff: footAngleTakeoff,
          landing: footAngleLanding,
          confidence: footSamples.length ? clamp01(footValidRatio) : 0,
        },
      }
    : {
        // Ground or pipeline not confident: no metrics
        ...EMPTY_ANALYSIS.metrics,
        footAngleDeg: { takeoff: null, landing: null, confidence: 0 },
      };

  const eventsGated = groundConfident && pipelineResult.passed
    ? {
        takeoff: {
          t: typeof takeoffTime === "number" ? takeoffTime / 1000 : null,
          frame: typeof takeoffIndex === "number" ? takeoffIndex : null,
          confidence: clamp01(stats.contactScoreMean),
        },
        landing: {
          t: typeof landingTime === "number" ? landingTime / 1000 : null,
          frame: typeof landingIndex === "number" ? landingIndex : null,
          confidence: clamp01(stats.contactScoreMean),
        },
      }
    : {
        // Ground not confident: no events
        takeoff: { t: null, frame: null, confidence: 0 },
        landing: { t: null, frame: null, confidence: 0 },
      };

  return {
    ...EMPTY_ANALYSIS,
    status: "complete",
    measurementStatus,
    capture: {
      nominalFps: nominalFps,
      durationMs: batch?.durationMs,
    },
    metrics: metricsGated,
    events: eventsGated,
    frames: analyzedFrames,
    groundSummary,
    quality: {
      overallConfidence,
      notes,
      reliability: {
        viewOk,
        groundDetected: groundSummary.type !== "unknown",
        jointsTracked,
        contactDetected,
      },
      pipelineDebug: {
        groundConfidence: pipelineResult.groundConfidence,
        footPatchConfidence: pipelineResult.footPatchConfidence,
        contactConfidence: pipelineResult.contactConfidence,
        eventConfidence: pipelineResult.eventConfidence,
        rejectionReasons: pipelineResult.rejectionReasons,
      },
    },
    aiSummary: {
      text: contactDetected ? "Contact and flight detected." : "Contact detection uncertain.",
      tags: [
        "pogo-side-view",
        measurementStatus === "real" ? batch?.debug?.provider ?? "web-canvas" : "synthetic",
        measurementStatus === "real" ? "measurement-real" : "synthetic-placeholder",
        groundModel.type !== "unknown" ? "GROUND_DETECTED" : "GROUND_ASSUMED",
        "ROI_LOCKED",
        ...(contactEvents.debugNotes.length || confirmationNotes.length
          ? ["CONTACT_TRANSITION_AMBIGUOUS"]
          : []),
        ...(footSamples.length && footValidRatio >= 0.7 ? ["FOOT_REGION_OK"] : ["FOOT_REGION_UNSTABLE"]),
        ...(() => {
          const strikeValid =
            footSamples.filter((sample) => typeof sample.strikeBias === "number").length /
            Math.max(1, footSamples.length);
          return footSamples.length && strikeValid < 0.5 ? ["STRIKE_BIAS_LOW_CONF"] : [];
        })(),
      ],
    },
    analysisDebug: {
      groundRoi: {
        notes: groundDetectorOutput.diagnostics?.stageSummary ? [groundDetectorOutput.diagnostics.stageSummary] : [],
        groundLine: groundLineY ? { y: groundLineY, method: groundModel.type === "hough_polar" ? "auto_edge" : "manual" } : undefined,
        roi: { x: roi.x, y: roi.y, w: roi.w, h: roi.h },
        scores: {
          contactScoreMin: stats.contactScoreMin,
          contactScoreMean: stats.contactScoreMean,
          contactScoreMax: stats.contactScoreMax,
          contactScoreStd: stats.contactScoreStd,
          edgeEnergyMean: stats.edgeMean,
          motionEnergyMean: stats.motionMean,
          bottomBandEnergyMean: stats.bottomMean,
        },
        rawSamples: rawSamples.slice(0, 200),
      },
      footPatch: footPatchResult
        ? {
            roi: footPatchResult.roi,
            footness: footPatchResult.footness,
            stability: footPatchResult.stability,
            confidence: footPatchResult.confidence,
            reasons: footPatchResult.reasons,
            diagnostics: footPatchResult.diagnostics,
          }
        : {
            roi,
            footness: 0,
            stability: 0,
            confidence: footPatchConfidence,
            reasons: ["FOOT_PATCH_NOT_CONFIDENT"],
            diagnostics: {
              featureScores: {
                sharpness: 0,
                cadenceStability: 0,
                concentration: 0,
                groundProximity: 0,
                bodyCorr: 0,
              },
              selectedFrom: "globalScan",
              reinitCount: 0,
              avgShiftPx: 0,
              band: { yMin: 0, yMax: 0, clipped: false },
            },
          },
      lowerBody: {
        ...lowerBodyResult.debug,
        notes: [...lowerBodyResult.debug.notes, ...confirmationNotes],
      },
      foot: {
        ...footResult.debug,
        notes: [...footResult.debug.notes, ...footNotes],
        eventSignals: (() => {
          const takeoffIdx = findNearestSampleIndex(rawSamples, confirmedTakeoff);
          const landingIdx = findNearestSampleIndex(rawSamples, confirmedLanding);
          const takeoffRaw = typeof takeoffIdx === "number" ? rawSamples[takeoffIdx] : undefined;
          const landingRaw = typeof landingIdx === "number" ? rawSamples[landingIdx] : undefined;
          const takeoffLowerIdx = findNearestSampleIndex(lowerBodySamples, confirmedTakeoff);
          const landingLowerIdx = findNearestSampleIndex(lowerBodySamples, confirmedLanding);
          const takeoffLower =
            typeof takeoffLowerIdx === "number" ? lowerBodySamples[takeoffLowerIdx] : undefined;
          const landingLower =
            typeof landingLowerIdx === "number" ? lowerBodySamples[landingLowerIdx] : undefined;

          return {
            takeoff:
              typeof confirmedTakeoff === "number"
                ? {
                    tMs: confirmedTakeoff,
                    contactScore: takeoffRaw?.contactScore,
                    bottomBandEnergy: takeoffLower?.bottomBandEnergy,
                    groundBandDensity: footTakeoffSample?.groundBandDensity,
                  }
                : undefined,
            landing:
              typeof confirmedLanding === "number"
                ? {
                    tMs: confirmedLanding,
                    contactScore: landingRaw?.contactScore,
                    bottomBandEnergy: landingLower?.bottomBandEnergy,
                    groundBandDensity: footLandingSample?.groundBandDensity,
                  }
                : undefined,
          };
        })(),
      },
    },
  };
}

export function runPogoAnalyzerSelfTest(): JumpAnalysis {
  const synthetic = generateSyntheticFrames("self-test");
  const extractedFrames = toExtractedFrames(synthetic);
  const { groundLine, roi, debug } = computeGroundAndRoi(extractedFrames, {});
  const { analyzedFrames, rawSamples, stats } = analyzeContactFromRoi(
    synthetic,
    groundLine.y,
    roi
  );
  const lowerBodyResult = {
    samples: [],
    debug: {
      notes: ["Lower-body tracker skipped (synthetic self-test)."],
      thresholds: { motionThresh: 0, minArea: 0 },
      stats: {
        validFrames: 0,
        areaMin: 0,
        areaMax: 0,
        centroidYMin: 0,
        centroidYMax: 0,
        bottomBandEnergyMin: 0,
        bottomBandEnergyMax: 0,
      },
    },
  };
  const footResult = {
    samples: [],
    debug: {
      notes: ["Foot region extractor skipped (synthetic self-test)."],
      thresholds: { motionThresh: 0, minFootArea: 0, groundBandPx: 0 },
      stats: {
        validFrames: 0,
        areaMin: 0,
        areaMax: 0,
        angleMin: 0,
        angleMax: 0,
        strikeBiasMin: 0,
        strikeBiasMax: 0,
        groundBandDensityMin: 0,
        groundBandDensityMax: 0,
      },
    },
  };

  const groundSummary: GroundModel2D =
    Number.isFinite(groundLine.y)
      ? { type: "y_scalar", y: groundLine.y, confidence: 0.4 }
      : { type: "unknown", confidence: 0 };

  const contactEvents = detectContactEventsFromSignal(
    rawSamples.map((s) => ({ tMs: s.tMs, contactScore: s.contactScore }))
  );
  const takeoffIndex = findNearestFrameIndex(analyzedFrames, contactEvents.takeoffMs);
  const landingIndex = findNearestFrameIndex(analyzedFrames, contactEvents.landingMs);
  const metrics = deriveMetrics(analyzedFrames, takeoffIndex ?? -1, landingIndex ?? -1);

  console.info("Pogo analyzer self-test", {
    fps: TARGET_FPS,
    frames: analyzedFrames.length,
    contactFrames: analyzedFrames.filter((frame) => frame.contact.left.inContact).length,
    takeoffIndex,
    landingIndex,
    gctSeconds: metrics.gctSeconds,
    flightSeconds: metrics.flightSeconds,
  });

  return {
    ...EMPTY_ANALYSIS,
    status: "complete",
    measurementStatus: "synthetic_placeholder",
    metrics: {
      ...EMPTY_ANALYSIS.metrics,
      gctSeconds: metrics.gctSeconds,
      gctMs: metrics.gctMs,
      flightSeconds: metrics.flightSeconds,
      footAngleDeg: { takeoff: null, landing: null, confidence: 0 },
    },
    events: {
      takeoff: {
        t: null,
        frame: typeof takeoffIndex === "number" ? takeoffIndex : null,
        confidence: 0.4,
      },
      landing: {
        t: null,
        frame: typeof landingIndex === "number" ? landingIndex : null,
        confidence: 0.4,
      },
    },
    frames: analyzedFrames,
    groundSummary,
    quality: {
      overallConfidence: 0.4,
      notes: [
        "Self-test synthetic analyzer run.",
        "Synthetic placeholder output (not real).",
        ...debug.notes,
        ...contactEvents.debugNotes,
        `ContactScore min/mean/max: ${stats.contactScoreMin.toFixed(2)} / ${stats.contactScoreMean.toFixed(
          2
        )} / ${stats.contactScoreMax.toFixed(2)}.`,
      ],
      reliability: {
        viewOk: true,
        groundDetected: true,
        jointsTracked: true,
        contactDetected: typeof contactEvents.takeoffMs === "number" && typeof contactEvents.landingMs === "number",
      },
    },
    aiSummary: {
      text: "Synthetic self-test run.",
      tags: ["self-test", "synthetic-placeholder"],
    },
    analysisDebug: {
      groundRoi: {
        ...debug,
        scores: {
          contactScoreMin: stats.contactScoreMin,
          contactScoreMean: stats.contactScoreMean,
          contactScoreMax: stats.contactScoreMax,
          contactScoreStd: stats.contactScoreStd,
          edgeEnergyMean: stats.edgeMean,
          motionEnergyMean: stats.motionMean,
          bottomBandEnergyMean: stats.bottomMean,
        },
        rawSamples: rawSamples.slice(0, 200),
      },
      lowerBody: {
        ...lowerBodyResult.debug,
        notes: [...lowerBodyResult.debug.notes, ...contactEvents.debugNotes],
      },
      foot: {
        ...footResult.debug,
        notes: [...footResult.debug.notes, ...contactEvents.debugNotes],
      },
    },
  };
}
