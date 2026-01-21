import type { ExtractedFrame } from "../video/FrameProvider";
import type { RoiRect } from "./groundRoi";

export type BlobSample = {
  tMs: number;
  area: number;
  centroidX: number | null;
  centroidY: number | null;
  bbox: { x: number; y: number; w: number; h: number } | null;
  motionEnergy: number;
  bottomBandEnergy: number;
  valid: boolean;
};

export type LowerBodyTrackerDebug = {
  notes: string[];
  thresholds: {
    motionThresh: number;
    minArea: number;
  };
  stats: {
    validFrames: number;
    areaMin: number;
    areaMax: number;
    centroidYMin: number;
    centroidYMax: number;
    bottomBandEnergyMin: number;
    bottomBandEnergyMax: number;
  };
};

type TrackerConfig = {
  minArea?: number;
  smoothWindow?: number;
  motionThreshMode?: "auto" | "fixed";
  motionThresh?: number;
  bottomBandPx?: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
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

function lumaFromRgba(bytes: Uint8ClampedArray, idx: number) {
  const r = bytes[idx];
  const g = bytes[idx + 1];
  const b = bytes[idx + 2];
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function extractRoiLuma(frame: ExtractedFrame, roi: RoiRect): Float32Array {
  const luma = new Float32Array(roi.w * roi.h);
  if (!frame.dataBase64) return luma;
  const bytes = decodeBase64(frame.dataBase64);
  let ptr = 0;

  for (let y = 0; y < roi.h; y += 1) {
    const row = roi.y + y;
    for (let x = 0; x < roi.w; x += 1) {
      const col = roi.x + x;
      if (frame.format === "luma") {
        const idx = row * frame.width + col;
        luma[ptr] = bytes[idx] ?? 0;
      } else {
        const idx = (row * frame.width + col) * 4;
        luma[ptr] = lumaFromRgba(bytes, idx);
      }
      ptr += 1;
    }
  }

  return luma;
}

function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

export function trackLowerBody(
  frames: ExtractedFrame[],
  roi: RoiRect,
  groundY: number,
  cfg: TrackerConfig = {}
): { samples: BlobSample[]; debug: LowerBodyTrackerDebug } {
  const minArea = cfg.minArea ?? Math.round(roi.w * roi.h * 0.01);
  const smoothWindow = cfg.smoothWindow ?? 3;
  const motionThreshMode = cfg.motionThreshMode ?? "auto";
  const bottomBandPx = cfg.bottomBandPx ?? 12;

  const samples: BlobSample[] = [];
  const centroidYs: number[] = [];
  const areas: number[] = [];
  const bottomEnergies: number[] = [];
  const motionThresholds: number[] = [];

  let prevLuma: Float32Array | null = null;

  frames.forEach((frame) => {
    const luma = extractRoiLuma(frame, roi);
    const absDiff = new Float32Array(luma.length);

    let diffSum = 0;
    for (let i = 0; i < luma.length; i += 1) {
      const diff = prevLuma ? Math.abs(luma[i] - prevLuma[i]) : 0;
      absDiff[i] = diff;
      diffSum += diff;
    }

    const motionEnergy = luma.length ? diffSum / luma.length : 0;
    const diffValues = Array.from(absDiff);
    const autoThresh = Math.max(8, Math.round(percentile(diffValues, 0.9) * 0.6));
    const motionThresh = motionThreshMode === "fixed" ? cfg.motionThresh ?? autoThresh : autoThresh;
    motionThresholds.push(motionThresh);

    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = roi.w;
    let minY = roi.h;
    let maxX = 0;
    let maxY = 0;

    for (let y = 0; y < roi.h; y += 1) {
      for (let x = 0; x < roi.w; x += 1) {
        const idx = y * roi.w + x;
        if (absDiff[idx] > motionThresh) {
          area += 1;
          sumX += x;
          sumY += y;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }

    const valid = area >= minArea;
    const centroidX = valid ? sumX / area : null;
    const centroidY = valid ? sumY / area : null;
    const bbox = valid
      ? { x: roi.x + minX, y: roi.y + minY, w: maxX - minX + 1, h: maxY - minY + 1 }
      : null;

    const bandTop = clamp(groundY - bottomBandPx, roi.y, roi.y + roi.h);
    const bandBottom = clamp(groundY, roi.y, roi.y + roi.h);
    let bottomSum = 0;
    let bottomCount = 0;
    for (let y = Math.floor(bandTop); y < Math.floor(bandBottom); y += 1) {
      const rowIdx = (y - roi.y) * roi.w;
      for (let x = 0; x < roi.w; x += 1) {
        bottomSum += absDiff[rowIdx + x];
        bottomCount += 1;
      }
    }
    const bottomBandEnergy = bottomCount ? bottomSum / bottomCount : 0;

    samples.push({
      tMs: frame.tMs,
      area,
      centroidX,
      centroidY,
      bbox,
      motionEnergy,
      bottomBandEnergy,
      valid,
    });

    if (valid && typeof centroidY === "number") centroidYs.push(centroidY);
    if (valid) areas.push(area);
    bottomEnergies.push(bottomBandEnergy);
    prevLuma = luma;
  });

  if (smoothWindow > 1) {
    const half = Math.floor(smoothWindow / 2);
    samples.forEach((sample, idx) => {
      if (!sample.valid || sample.centroidY === null) return;
      let sum = 0;
      let count = 0;
      for (let offset = -half; offset <= half; offset += 1) {
        const neighbor = samples[idx + offset];
        if (neighbor?.valid && typeof neighbor.centroidY === "number") {
          sum += neighbor.centroidY;
          count += 1;
        }
      }
      if (count) {
        sample.centroidY = sum / count;
      }
    });
  }

  const validFrames = samples.filter((s) => s.valid).length;
  const areaMin = areas.length ? Math.min(...areas) : 0;
  const areaMax = areas.length ? Math.max(...areas) : 0;
  const centroidYMin = centroidYs.length ? Math.min(...centroidYs) : 0;
  const centroidYMax = centroidYs.length ? Math.max(...centroidYs) : 0;
  const bottomBandEnergyMin = bottomEnergies.length ? Math.min(...bottomEnergies) : 0;
  const bottomBandEnergyMax = bottomEnergies.length ? Math.max(...bottomEnergies) : 0;

  const motionThreshSummary = motionThresholds.length
    ? motionThresholds.reduce((sum, value) => sum + value, 0) / motionThresholds.length
    : 0;

  const debug: LowerBodyTrackerDebug = {
    notes: [],
    thresholds: {
      motionThresh: motionThreshMode === "fixed" ? cfg.motionThresh ?? motionThreshSummary : motionThreshSummary,
      minArea,
    },
    stats: {
      validFrames,
      areaMin,
      areaMax,
      centroidYMin,
      centroidYMax,
      bottomBandEnergyMin,
      bottomBandEnergyMax,
    },
  };

  return { samples, debug };
}
