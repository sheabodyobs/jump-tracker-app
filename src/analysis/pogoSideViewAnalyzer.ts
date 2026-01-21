// src/analysis/pogoSideViewAnalyzer.ts
import { Platform } from "react-native";

import { type JumpAnalysis, EMPTY_ANALYSIS, type AnalysisFrame, type GroundModel2D } from "./jumpAnalysisContract";
import type { ExtractedFrame, ExtractedFrameBatch, MeasurementStatus } from "../video/FrameProvider";
import { iosAvFoundationFrameProvider } from "../video/iosAvFoundationFrameProvider";
import { computeGroundAndRoi, detectContactEventsFromSignal, type GroundRoiConfig } from "./groundRoi";

const TARGET_FPS = 30;
const MAX_FRAMES = 36;
const DEFAULT_SAMPLE_WINDOW_MS = 2000;
const CONTACT_FRAME_THRESHOLD = 0.55;

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
      return { pixelFrames, batch, measurementStatus: "real" };
    }

    return {
      pixelFrames: generateSyntheticFrames(uri),
      batch,
      measurementStatus: "synthetic_placeholder",
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

type ContactSample = {
  tMs: number;
  contactScore: number;
  edgeEnergy: number;
  motionEnergy: number;
  bottomBandEnergy: number;
};

function analyzeContactFromRoi(pixelFrames: PixelFrame[], groundLineY: number, roi: { x: number; y: number; w: number; h: number }) {
  const analyzedFrames: AnalysisFrame[] = [];
  const contactSignals: ContactSignal[] = [];
  let prevLuma: Float32Array | null = null;
  const rawSamples: ContactSample[] = [];

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

export async function analyzePogoSideView(
  uri: string,
  config: GroundRoiConfig = {}
): Promise<JumpAnalysis> {
  const { pixelFrames, batch, measurementStatus } = await sampleFramesForAnalysis(uri);

  const extractedFrames =
    measurementStatus === "real" && batch?.frames?.length ? batch.frames : toExtractedFrames(pixelFrames);
  const { groundLine, roi, debug } = computeGroundAndRoi(extractedFrames, config);
  const { analyzedFrames, contactSignals, rawSamples, stats } = analyzeContactFromRoi(
    pixelFrames,
    groundLine.y,
    roi
  );

  const contactEvents = detectContactEventsFromSignal(
    rawSamples.map((s) => ({ tMs: s.tMs, contactScore: s.contactScore }))
  );

  const takeoffIndex = findNearestFrameIndex(analyzedFrames, contactEvents.takeoffMs);
  const landingIndex = findNearestFrameIndex(analyzedFrames, contactEvents.landingMs);
  const metrics = deriveMetrics(analyzedFrames, takeoffIndex ?? -1, landingIndex ?? -1);

  const trackedRatio =
    contactSignals.filter((signal) => signal.confidence > 0.2).length /
    Math.max(1, contactSignals.length);

  const groundSummary: GroundModel2D = Number.isFinite(groundLine.y)
    ? { type: "y_scalar", y: groundLine.y, confidence: 0.4 }
    : { type: "unknown", confidence: 0 };

  const viewOk = groundSummary.type !== "unknown";
  const jointsTracked = trackedRatio >= 0.6;
  const contactDetected =
    typeof contactEvents.takeoffMs === "number" && typeof contactEvents.landingMs === "number";

  const baseConfidence = clamp01(
    0.2 +
      (viewOk ? 0.3 : 0) +
      (jointsTracked ? 0.25 : 0) +
      (contactDetected ? 0.25 : 0) +
      (groundSummary.confidence > 0.4 ? 0.1 : 0)
  );
  const overallConfidence =
    measurementStatus === "real" ? baseConfidence : Math.min(baseConfidence, 0.35);

  const notes = [
    `Analyzer: ${
      measurementStatus === "real" ? batch?.debug?.provider ?? "web-canvas" : "synthetic"
    }.`,
    `Frames: ${analyzedFrames.length}.`,
    `FPS (target): ${TARGET_FPS}.`,
    `Ground Y: ${groundLine.y}px (${groundLine.method}).`,
    `Contact frames: ${contactSignals.filter((signal) => signal.inContact).length}.`,
    contactDetected
      ? `Takeoff @ ${contactEvents.takeoffMs}ms, landing @ ${contactEvents.landingMs}ms.`
      : "No contact transitions detected.",
    metrics.gctSeconds !== null ? `GCT: ${metrics.gctSeconds.toFixed(3)}s.` : "GCT unavailable.",
    metrics.flightSeconds !== null ? `Flight: ${metrics.flightSeconds.toFixed(3)}s.` : "Flight unavailable.",
    ...(measurementStatus === "real"
      ? []
      : ["Synthetic placeholder output (not a real measurement)."]),
    ...(batch?.error?.message ? [`Frame extraction error: ${batch.error.message}`] : []),
    ...debug.notes,
    ...contactEvents.debugNotes,
    `ContactScore min/mean/max: ${stats.contactScoreMin.toFixed(2)} / ${stats.contactScoreMean.toFixed(
      2
    )} / ${stats.contactScoreMax.toFixed(2)}.`,
  ];

  const takeoffTime = contactEvents.takeoffMs;
  const landingTime = contactEvents.landingMs;

  return {
    ...EMPTY_ANALYSIS,
    status: "complete",
    measurementStatus,
    metrics: {
      ...EMPTY_ANALYSIS.metrics,
      gctSeconds: metrics.gctSeconds,
      gctMs: metrics.gctMs,
      flightSeconds: metrics.flightSeconds,
      footAngleDeg: { takeoff: null, landing: null, confidence: 0 },
    },
    events: {
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
    },
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
    },
    aiSummary: {
      text: contactDetected ? "Contact and flight detected." : "Contact detection uncertain.",
      tags: [
        "pogo-side-view",
        measurementStatus === "real" ? batch?.debug?.provider ?? "web-canvas" : "synthetic",
        measurementStatus === "real" ? "measurement-real" : "synthetic-placeholder",
        debug.notes.length ? "GROUND_ASSUMED" : "GROUND_MANUAL",
        "ROI_LOCKED",
        ...(contactEvents.debugNotes.length ? ["CONTACT_TRANSITION_AMBIGUOUS"] : []),
      ],
    },
    analysisDebug: {
      groundRoi: {
        ...debug,
        scores: {
          contactScoreMin: stats.contactScoreMin,
          contactScoreMean: stats.contactScoreMean,
          contactScoreMax: stats.contactScoreMax,
          edgeEnergyMean: stats.edgeMean,
          motionEnergyMean: stats.motionMean,
          bottomBandEnergyMean: stats.bottomMean,
        },
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
      takeoff: { t: null, frame: takeoffIndex >= 0 ? takeoffIndex : null, confidence: 0.4 },
      landing: { t: null, frame: landingIndex >= 0 ? landingIndex : null, confidence: 0.4 },
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
          edgeEnergyMean: stats.edgeMean,
          motionEnergyMean: stats.motionMean,
          bottomBandEnergyMean: stats.bottomMean,
        },
      },
    },
  };
}
