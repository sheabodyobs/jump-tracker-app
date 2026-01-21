/// src/analysis/pogoSideViewAnalyzer.ts
import { Platform } from "react-native";

import {
  EMPTY_ANALYSIS,
  type AnalysisFrame,
  type GroundModel2D,
  type JumpAnalysis,
} from "./jumpAnalysisContract";

import type {
  ExtractedFrame,
  ExtractedFrameBatch,
  MeasurementStatus,
} from "../video/FrameProvider";

import { iosAvFoundationFrameProvider } from "../video/iosAvFoundationFrameProvider";
import {
  computeGroundAndRoi,
  type GroundRoiConfig,
} from "./groundRoi";

const TARGET_FPS = 30;
const MAX_FRAMES = 36;
const DEFAULT_SAMPLE_WINDOW_MS = 2000;

// For jump/pogo GCT, <=60fps is usually too coarse.
// 120fps is the minimum where this becomes meaningfully useful.
const MIN_EFFECTIVE_FPS_FOR_REAL = 120;

// Contact scoring and debouncing.
const CONTACT_FRAME_THRESHOLD_ON = 0.58;
const CONTACT_FRAME_THRESHOLD_OFF = 0.50;
const SMOOTHING_WINDOW = 3;

type PixelFrame = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  tMs: number;
};

type ContactSignal = {
  inContact: boolean;
  confidence: number; // 0..1
};

type ContactSample = {
  tMs: number;
  contactScore: number;      // 0..1
  edgeEnergy: number;        // >=0
  motionEnergy: number;      // >=0
  bottomBandEnergy: number;  // >=0
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

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function normalize(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return 0;
  if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 1e-6) return 0.5;
  return clamp01((value - min) / (max - min));
}

function clampRoiToFrame(
  frameW: number,
  frameH: number,
  roi: { x: number; y: number; w: number; h: number }
) {
  const x = Math.max(0, Math.min(frameW - 1, Math.round(roi.x)));
  const y = Math.max(0, Math.min(frameH - 1, Math.round(roi.y)));
  const w = Math.max(1, Math.min(frameW - x, Math.round(roi.w)));
  const h = Math.max(1, Math.min(frameH - y, Math.round(roi.h)));
  return { x, y, w, h };
}

function lumaAt(data: Uint8ClampedArray, idx: number) {
  const r = data[idx] ?? 0;
  const g = data[idx + 1] ?? 0;
  const b = data[idx + 2] ?? 0;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function extractRoiLuma(
  frame: PixelFrame,
  roiIn: { x: number; y: number; w: number; h: number }
) {
  const roi = clampRoiToFrame(frame.width, frame.height, roiIn);
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

  return { luma, roi };
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
  const bandH = Math.max(1, Math.round(roiH * 0.18));
  const startRow = Math.max(0, roiH - bandH);
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

function movingAverage(values: number[], window: number) {
  const w = Math.max(1, Math.floor(window));
  if (w === 1) return [...values];

  const out: number[] = new Array(values.length).fill(0);
  let sum = 0;
  let count = 0;
  const queue: number[] = [];

  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    queue.push(v);
    sum += v;
    count += 1;

    if (queue.length > w) {
      sum -= queue.shift() ?? 0;
      count -= 1;
    }

    out[i] = count ? sum / count : v;
  }

  return out;
}

function hysteresisBinarize(scores: number[]) {
  const flags: boolean[] = [];
  let inContact = false;

  for (let i = 0; i < scores.length; i += 1) {
    const s = scores[i];
    if (!inContact && s >= CONTACT_FRAME_THRESHOLD_ON) inContact = true;
    if (inContact && s <= CONTACT_FRAME_THRESHOLD_OFF) inContact = false;
    flags.push(inContact);
  }

  return flags;
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

        if (
          inContact &&
          Math.abs(x - footX) < footRadius &&
          y >= groundY - 4 &&
          y <= groundY + 2
        ) {
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
  const atobFn = (globalThis as any)?.atob;
  if (typeof atobFn === "function") {
    const binary = atobFn(base64);
    const bytes = new Uint8ClampedArray(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const output: number[] = [];
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

function computeEffectiveFpsFromTimestamps(tMs: number[]) {
  if (tMs.length < 3) return { fps: 0, medianDeltaMs: 0, ok: false };

  const deltas: number[] = [];
  for (let i = 1; i < tMs.length; i += 1) {
    const d = tMs[i] - tMs[i - 1];
    if (Number.isFinite(d) && d > 0) deltas.push(d);
  }

  const med = median(deltas);
  const fps = med > 0 ? 1000 / med : 0;
  const ok = Number.isFinite(fps) && fps > 0;

  return { fps, medianDeltaMs: med, ok };
}

function sortAndDedupeFrames(pixelFrames: PixelFrame[]) {
  const sorted = [...pixelFrames].sort((a, b) => a.tMs - b.tMs);
  const out: PixelFrame[] = [];

  let lastT = -Infinity;
  for (const f of sorted) {
    if (!Number.isFinite(f.tMs)) continue;
    if (f.tMs <= lastT) continue;
    out.push(f);
    lastT = f.tMs;
  }

  return out;
}

async function extractFramesWeb(uri: string): Promise<PixelFrame[]> {
  if (typeof document === "undefined") return [];

  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.src = uri;
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.preload = "auto";

    const cleanup = () => {
      try {
        video.pause();
        video.remove();
      } catch {
        // ignore
      }
    };

    video.addEventListener(
      "loadedmetadata",
      async () => {
        const durationSec = Number.isFinite(video.duration) ? video.duration : 0;
        const totalFrames = Math.min(
          MAX_FRAMES,
          Math.max(1, Math.floor(durationSec * TARGET_FPS))
        );
        const intervalSec =
          durationSec > 0 ? durationSec / totalFrames : 1 / TARGET_FPS;

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

async function sampleFramesForAnalysis(uri: string): Promise<{
  pixelFrames: PixelFrame[];
  batch?: ExtractedFrameBatch;
  measurementStatus: MeasurementStatus;
  effectiveFps: number;
  fpsOk: boolean;
  fpsMedianDeltaMs: number;
  frameCountOk: boolean;
  timestampOk: boolean;
}> {
  // Defaults.
  const resultBase = {
    effectiveFps: 0,
    fpsOk: false,
    fpsMedianDeltaMs: 0,
    frameCountOk: false,
    timestampOk: false,
  };

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

    const decodedFrames: PixelFrame[] =
      batch.frames?.length
        ? batch.frames.map((frame) => {
            const bytes = decodeBase64(frame.dataBase64);
            // Defensive: ensure the array is the expected size.
            const expected = frame.width * frame.height * 4;
            const data =
              bytes.length === expected
                ? bytes
                : bytes.length > expected
                ? bytes.slice(0, expected)
                : (() => {
                    const padded = new Uint8ClampedArray(expected);
                    padded.set(bytes, 0);
                    return padded;
                  })();

            return {
              width: frame.width,
              height: frame.height,
              tMs: frame.tMs,
              data,
            };
          })
        : [];

    const pixelFrames = sortAndDedupeFrames(decodedFrames);
    const tMs = pixelFrames.map((f) => f.tMs);
    const tsInfo = computeEffectiveFpsFromTimestamps(tMs);

    const frameCountOk = pixelFrames.length >= Math.min(18, MAX_FRAMES);
    const timestampOk = tsInfo.ok && tsInfo.medianDeltaMs > 0;

    const effectiveFps = tsInfo.fps;
    const fpsOk = Number.isFinite(effectiveFps) && effectiveFps >= MIN_EFFECTIVE_FPS_FOR_REAL;

    // If provider claims real but fps is too low, we degrade.
    const measurementStatus: MeasurementStatus =
      batch.measurementStatus === "real" && frameCountOk && timestampOk && fpsOk
        ? "real"
        : "synthetic_placeholder";

    return {
      pixelFrames:
        measurementStatus === "real" ? pixelFrames : generateSyntheticFrames(uri),
      batch,
      measurementStatus,
      effectiveFps,
      fpsOk,
      fpsMedianDeltaMs: tsInfo.medianDeltaMs,
      frameCountOk,
      timestampOk,
    };
  }

  if (Platform.OS === "web") {
    const framesRaw = await extractFramesWeb(uri);
    const pixelFrames = sortAndDedupeFrames(framesRaw);
    const tMs = pixelFrames.map((f) => f.tMs);
    const tsInfo = computeEffectiveFpsFromTimestamps(tMs);

    const frameCountOk = pixelFrames.length >= Math.min(18, MAX_FRAMES);
    const timestampOk = tsInfo.ok && tsInfo.medianDeltaMs > 0;
    const effectiveFps = tsInfo.fps;
    const fpsOk = Number.isFinite(effectiveFps) && effectiveFps >= MIN_EFFECTIVE_FPS_FOR_REAL;

    const measurementStatus: MeasurementStatus =
      frameCountOk && timestampOk && fpsOk ? "real" : "synthetic_placeholder";

    return {
      ...resultBase,
      pixelFrames:
        measurementStatus === "real" ? pixelFrames : generateSyntheticFrames(uri),
      measurementStatus,
      effectiveFps,
      fpsOk,
      fpsMedianDeltaMs: tsInfo.medianDeltaMs,
      frameCountOk,
      timestampOk,
    };
  }

  // Other platforms. No real provider.
  return {
    ...resultBase,
    pixelFrames: generateSyntheticFrames(uri),
    measurementStatus: "synthetic_placeholder",
  };
}

function toExtractedFrames(frames: PixelFrame[]): ExtractedFrame[] {
  // This is only used for computeGroundAndRoi’s geometry/timing path.
  // If computeGroundAndRoi ever needs pixels, you should pass them through.
  return frames.map((frame) => ({
    tMs: frame.tMs,
    width: frame.width,
    height: frame.height,
    format: "rgba",
    dataBase64: "",
  }));
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
    left: { ...emptyLeg },
    right: { ...emptyLeg },
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

function analyzeContactFromRoi(
  pixelFrames: PixelFrame[],
  groundLineY: number,
  roiIn: { x: number; y: number; w: number; h: number }
) {
  const analyzedFrames: AnalysisFrame[] = [];
  const contactSignals: ContactSignal[] = [];
  let prevLuma: Float32Array | null = null;

  const rawSamples: ContactSample[] = [];

  // Extract raw feature signals.
  for (const frame of pixelFrames) {
    const { luma, roi } = extractRoiLuma(frame, roiIn);

    const edgeEnergy = computeEdgeEnergy(luma, roi.w, roi.h);
    const bottomBandEnergy = computeBottomBandEnergy(luma, roi.w, roi.h);

    let motionEnergy = 0;
    if (prevLuma && prevLuma.length === luma.length) {
      let sum = 0;
      for (let i = 0; i < luma.length; i += 1) {
        sum += Math.abs(luma[i] - prevLuma[i]);
      }
      motionEnergy = sum / Math.max(1, luma.length);
    }

    rawSamples.push({
      tMs: frame.tMs,
      contactScore: 0,
      edgeEnergy,
      motionEnergy,
      bottomBandEnergy,
    });

    prevLuma = luma;
  }

  // Normalize.
  const edgeValues = rawSamples.map((s) => s.edgeEnergy);
  const motionValues = rawSamples.map((s) => s.motionEnergy);
  const bottomValues = rawSamples.map((s) => s.bottomBandEnergy);

  const edgeMin = edgeValues.length ? Math.min(...edgeValues) : 0;
  const edgeMax = edgeValues.length ? Math.max(...edgeValues) : 0;
  const motionMin = motionValues.length ? Math.min(...motionValues) : 0;
  const motionMax = motionValues.length ? Math.max(...motionValues) : 0;
  const bottomMin = bottomValues.length ? Math.min(...bottomValues) : 0;
  const bottomMax = bottomValues.length ? Math.max(...bottomValues) : 0;

  const rawScores: number[] = [];

  for (const s of rawSamples) {
    const edgeNorm = normalize(s.edgeEnergy, edgeMin, edgeMax);
    const motionNorm = normalize(s.motionEnergy, motionMin, motionMax);
    const bottomNorm = normalize(s.bottomBandEnergy, bottomMin, bottomMax);

    // Contact looks like: strong bottom activity + strong edges + low motion blur.
    // Weighted to favor bottom band (foot/ground interaction).
    const score = clamp01(
      0.55 * bottomNorm +
      0.35 * edgeNorm +
      0.10 * (1 - motionNorm)
    );

    rawScores.push(score);
  }

  // Smooth, then hysteresis.
  const smoothed = movingAverage(rawScores, SMOOTHING_WINDOW);
  const inContactFlags = hysteresisBinarize(smoothed);

  // Finalize samples and frames.
  for (let i = 0; i < rawSamples.length; i += 1) {
    rawSamples[i].contactScore = smoothed[i];

    const contact: ContactSignal = {
      inContact: inContactFlags[i],
      confidence: clamp01(smoothed[i]),
    };

    contactSignals.push(contact);
    analyzedFrames.push(makeFrame(pixelFrames[i], groundLineY, contact));
  }

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

function findBestFlightSegment(contactSignals: ContactSignal[]) {
  // Find the longest contiguous out-of-contact run.
  // Returns indices: flightStart (first out), flightEnd (last out), plus boundaries.
  let best = { start: -1, end: -1, length: 0 };

  let curStart = -1;
  for (let i = 0; i < contactSignals.length; i += 1) {
    const outOfContact = !contactSignals[i].inContact;

    if (outOfContact && curStart === -1) curStart = i;
    if (!outOfContact && curStart !== -1) {
      const end = i - 1;
      const len = end - curStart + 1;
      if (len > best.length) best = { start: curStart, end, length: len };
      curStart = -1;
    }
  }

  if (curStart !== -1) {
    const end = contactSignals.length - 1;
    const len = end - curStart + 1;
    if (len > best.length) best = { start: curStart, end, length: len };
  }

  if (best.length <= 0) return null;
  return best;
}

function deriveMetricsFromIndices(frames: AnalysisFrame[], takeoffIdx: number, landingIdx: number) {
  if (takeoffIdx < 0 || landingIdx < 0 || landingIdx <= takeoffIdx) {
    return { gctSeconds: null, gctMs: null, flightSeconds: null };
  }

  // Contact block preceding takeoff.
  let contactStart = takeoffIdx;
  while (contactStart > 0 && frames[contactStart - 1].contact.left.inContact) {
    contactStart -= 1;
  }

  const contactStartTime = frames[contactStart].tMs ?? 0;
  const takeoffTime = frames[takeoffIdx].tMs ?? 0;
  const landingTime = frames[landingIdx].tMs ?? 0;

  const gctSeconds = Math.max(0, (takeoffTime - contactStartTime) / 1000);
  const flightSeconds = Math.max(0, (landingTime - takeoffTime) / 1000);

  return {
    gctSeconds,
    gctMs: Math.round(gctSeconds * 1000),
    flightSeconds,
  };
}

export async function analyzePogoSideView(
  uri: string,
  config: GroundRoiConfig = {}
): Promise<JumpAnalysis> {
  const {
    pixelFrames,
    batch,
    measurementStatus,
    effectiveFps,
    fpsOk,
    fpsMedianDeltaMs,
    frameCountOk,
    timestampOk,
  } = await sampleFramesForAnalysis(uri);

  const extractedFrames =
    measurementStatus === "real" && batch?.frames?.length
      ? batch.frames
      : toExtractedFrames(pixelFrames);

  const { groundLine, roi, debug } = computeGroundAndRoi(extractedFrames, config);

  const { analyzedFrames, contactSignals, rawSamples, stats } = analyzeContactFromRoi(
    pixelFrames,
    groundLine.y,
    roi
  );

  // Event selection based on the best flight segment.
  const flight = findBestFlightSegment(contactSignals);

  // Define:
  // - takeoff frame = last in-contact frame before flight starts
  // - landing frame = first in-contact frame after flight ends
  let takeoffIndex: number | null = null;
  let landingIndex: number | null = null;

  if (flight) {
    const before = flight.start - 1;
    const after = flight.end + 1;

    if (before >= 0 && contactSignals[before]?.inContact) takeoffIndex = before;
    if (after < contactSignals.length && contactSignals[after]?.inContact) landingIndex = after;
  }

  const metrics = deriveMetricsFromIndices(
    analyzedFrames,
    typeof takeoffIndex === "number" ? takeoffIndex : -1,
    typeof landingIndex === "number" ? landingIndex : -1
  );

  const groundSummary: GroundModel2D = Number.isFinite(groundLine.y)
    ? { type: "y_scalar", y: groundLine.y, confidence: 0.4 }
    : { type: "unknown", confidence: 0 };

  const viewOk = groundSummary.type !== "unknown";
  const signalStable =
    contactSignals.filter((s) => s.confidence > 0.2).length / Math.max(1, contactSignals.length) >= 0.6;

  const contactDetected = typeof takeoffIndex === "number" && typeof landingIndex === "number";

  const baseConfidence = clamp01(
    0.15 +
      (viewOk ? 0.30 : 0) +
      (signalStable ? 0.25 : 0) +
      (contactDetected ? 0.25 : 0) +
      (fpsOk ? 0.20 : 0)
  );

  const overallConfidence =
    measurementStatus === "real" ? baseConfidence : Math.min(baseConfidence, 0.35);

  const takeoffTimeMs =
    typeof takeoffIndex === "number" ? analyzedFrames[takeoffIndex]?.tMs ?? null : null;
  const landingTimeMs =
    typeof landingIndex === "number" ? analyzedFrames[landingIndex]?.tMs ?? null : null;

  const providerLabel =
    measurementStatus === "real"
      ? batch?.debug?.provider ?? (Platform.OS === "web" ? "web-canvas" : "unknown")
      : "synthetic";

  const notes: string[] = [
    `Analyzer: ${providerLabel}.`,
    `Frames: ${analyzedFrames.length}.`,
    `Effective FPS: ${Number.isFinite(effectiveFps) ? effectiveFps.toFixed(1) : "—"} (median Δ=${Number.isFinite(fpsMedianDeltaMs) ? fpsMedianDeltaMs.toFixed(1) : "—"}ms).`,
    `FPS ok (>=${MIN_EFFECTIVE_FPS_FOR_REAL}): ${fpsOk ? "yes" : "no"}.`,
    `Frame count ok: ${frameCountOk ? "yes" : "no"}.`,
    `Timestamps ok: ${timestampOk ? "yes" : "no"}.`,
    `Ground Y: ${groundLine.y}px (${groundLine.method}).`,
    `ROI: x${roi.x}, y${roi.y}, w${roi.w}, h${roi.h}.`,
    `Contact frames: ${contactSignals.filter((s) => s.inContact).length}.`,
    contactDetected
      ? `Takeoff @ ${takeoffTimeMs}ms (idx ${takeoffIndex}), landing @ ${landingTimeMs}ms (idx ${landingIndex}).`
      : "No reliable takeoff/landing detected.",
    metrics.gctSeconds !== null ? `GCT: ${metrics.gctSeconds.toFixed(3)}s.` : "GCT unavailable.",
    metrics.flightSeconds !== null ? `Flight: ${metrics.flightSeconds.toFixed(3)}s.` : "Flight unavailable.",
    ...(measurementStatus === "real" ? [] : ["Synthetic placeholder output (not a real measurement)."]),
    ...(batch?.error?.message ? [`Frame extraction error: ${batch.error.message}`] : []),
    ...debug.notes,
    `ContactScore min/mean/max: ${stats.contactScoreMin.toFixed(2)} / ${stats.contactScoreMean.toFixed(2)} / ${stats.contactScoreMax.toFixed(2)}.`,
  ];

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
        t: typeof takeoffTimeMs === "number" ? takeoffTimeMs / 1000 : null,
        frame: typeof takeoffIndex === "number" ? takeoffIndex : null,
        confidence: clamp01(stats.contactScoreMean),
      },
      landing: {
        t: typeof landingTimeMs === "number" ? landingTimeMs / 1000 : null,
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
        jointsTracked: signalStable,
        contactDetected,
      },
    },
    aiSummary: {
      text: contactDetected ? "Contact and flight detected." : "Contact detection uncertain.",
      tags: [
        "pogo-side-view",
        providerLabel,
        measurementStatus === "real" ? "measurement-real" : "synthetic-placeholder",
        fpsOk ? "fps-ok" : "fps-low",
        debug.notes.length ? "GROUND_ASSUMED" : "GROUND_MANUAL",
        "ROI_LOCKED",
        ...(contactDetected ? [] : ["CONTACT_TRANSITION_AMBIGUOUS"]),
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
          effectiveFps,
        } as any,
      },
    },
  };
}

export function runPogoAnalyzerSelfTest(): JumpAnalysis {
  const synthetic = generateSyntheticFrames("self-test");
  const extractedFrames = toExtractedFrames(synthetic);
  const { groundLine, roi, debug } = computeGroundAndRoi(extractedFrames, {});

  const { analyzedFrames, contactSignals, rawSamples, stats } = analyzeContactFromRoi(
    synthetic,
    groundLine.y,
    roi
  );

  const flight = findBestFlightSegment(contactSignals);

  let takeoffIndex: number | null = null;
  let landingIndex: number | null = null;

  if (flight) {
    const before = flight.start - 1;
    const after = flight.end + 1;

    if (before >= 0 && contactSignals[before]?.inContact) takeoffIndex = before;
    if (after < contactSignals.length && contactSignals[after]?.inContact) landingIndex = after;
  }

  const metrics = deriveMetricsFromIndices(
    analyzedFrames,
    typeof takeoffIndex === "number" ? takeoffIndex : -1,
    typeof landingIndex === "number" ? landingIndex : -1
  );

  const groundSummary: GroundModel2D =
    Number.isFinite(groundLine.y)
      ? { type: "y_scalar", y: groundLine.y, confidence: 0.4 }
      : { type: "unknown", confidence: 0 };

  console.info("Pogo analyzer self-test", {
    fps: TARGET_FPS,
    frames: analyzedFrames.length,
    contactFrames: analyzedFrames.filter((f) => f.contact.left.inContact).length,
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
        `ContactScore min/mean/max: ${stats.contactScoreMin.toFixed(2)} / ${stats.contactScoreMean.toFixed(2)} / ${stats.contactScoreMax.toFixed(2)}.`,
      ],
      reliability: {
        viewOk: true,
        groundDetected: true,
        jointsTracked: true,
        contactDetected: typeof takeoffIndex === "number" && typeof landingIndex === "number",
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
          effectiveFps: TARGET_FPS,
        },
      },
    },
  };
}
