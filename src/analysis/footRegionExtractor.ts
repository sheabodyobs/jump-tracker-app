import type { ExtractedFrame } from "../video/FrameProvider";
import type { RoiRect } from "./groundRoi";

export type FootSample = {
  tMs: number;
  valid: boolean;
  footArea: number;
  footCentroidX: number | null;
  footCentroidY: number | null;
  footAngleDeg: number | null;
  strikeBias: number | null;
  groundBandDensity: number;
  notes?: string[];
};

export type FootExtractorDebug = {
  notes: string[];
  thresholds: {
    motionThresh: number;
    darkThresh?: number;
    minFootArea: number;
    groundBandPx: number;
  };
  stats: {
    validFrames: number;
    areaMin: number;
    areaMax: number;
    angleMin: number;
    angleMax: number;
    strikeBiasMin: number;
    strikeBiasMax: number;
    groundBandDensityMin: number;
    groundBandDensityMax: number;
  };
};

type FootConfig = {
  minFootArea?: number;
  groundBandPx?: number;
  motionThreshMode?: "auto" | "fixed";
  motionThresh?: number;
  useDarkSupport?: boolean;
  smoothWindow?: number;
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

function movingAverage(values: (number | null)[], window: number) {
  if (window <= 1) return values;
  const half = Math.floor(window / 2);
  return values.map((value, idx) => {
    if (value === null) return null;
    let sum = 0;
    let count = 0;
    for (let offset = -half; offset <= half; offset += 1) {
      const neighbor = values[idx + offset];
      if (typeof neighbor === "number") {
        sum += neighbor;
        count += 1;
      }
    }
    return count ? sum / count : value;
  });
}

export function extractFootRegion(
  frames: ExtractedFrame[],
  roi: RoiRect,
  groundY: number,
  cfg: FootConfig = {}
): { samples: FootSample[]; debug: FootExtractorDebug } {
  const minFootArea = cfg.minFootArea ?? Math.round(roi.w * roi.h * 0.008);
  const groundBandPx = cfg.groundBandPx ?? 12;
  const motionThreshMode = cfg.motionThreshMode ?? "auto";
  const smoothWindow = cfg.smoothWindow ?? 3;
  const useDarkSupport = cfg.useDarkSupport ?? false;

  const samples: FootSample[] = [];
  const areas: number[] = [];
  const angles: number[] = [];
  const strikeBiases: number[] = [];
  const densities: number[] = [];
  const motionThresholds: number[] = [];
  const darkThresholds: number[] = [];

  let prevLuma: Float32Array | null = null;

  frames.forEach((frame) => {
    const luma = extractRoiLuma(frame, roi);
    const absDiff = new Float32Array(luma.length);
    for (let i = 0; i < luma.length; i += 1) {
      const diff = prevLuma ? Math.abs(luma[i] - prevLuma[i]) : 0;
      absDiff[i] = diff;
    }
    const diffValues = Array.from(absDiff);
    const autoThresh = Math.max(8, Math.round(percentile(diffValues, 0.9) * 0.6));
    const motionThresh = motionThreshMode === "fixed" ? cfg.motionThresh ?? autoThresh : autoThresh;
    motionThresholds.push(motionThresh);

    const medianLuma = percentile(Array.from(luma), 0.5);
    const darkThresh = medianLuma - 12;
    if (useDarkSupport) darkThresholds.push(darkThresh);

    const bandTop = clamp(groundY - groundBandPx, roi.y, roi.y + roi.h);
    const bandBottom = clamp(groundY, roi.y, roi.y + roi.h);
    const extendedTop = clamp(groundY - groundBandPx - 8, roi.y, roi.y + roi.h);

    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = roi.w;
    let minY = roi.h;
    let maxX = 0;
    let maxY = 0;
    let bandCount = 0;
    let bandFoot = 0;
    let backCount = 0;
    let frontCount = 0;

    for (let y = 0; y < roi.h; y += 1) {
      const absY = roi.y + y;
      const inBand = absY >= bandTop && absY <= bandBottom;
      const inFootBand = absY >= extendedTop && absY <= bandBottom;
      for (let x = 0; x < roi.w; x += 1) {
        const idx = y * roi.w + x;
        if (inBand) bandCount += 1;
        const motionOn = absDiff[idx] > motionThresh;
        const darkOk = !useDarkSupport || luma[idx] < darkThresh;
        const footMask = motionOn && inFootBand && darkOk;
        if (footMask) {
          area += 1;
          sumX += x;
          sumY += y;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
          if (inBand) {
            bandFoot += 1;
            if (x < roi.w / 2) {
              backCount += 1;
            } else {
              frontCount += 1;
            }
          }
        }
      }
    }

    const valid = area >= minFootArea;
    const centroidX = valid ? sumX / area : null;
    const centroidY = valid ? sumY / area : null;

    let footAngleDeg: number | null = null;
    if (valid && centroidX !== null && centroidY !== null) {
      let covXX = 0;
      let covYY = 0;
      let covXY = 0;
      for (let y = 0; y < roi.h; y += 1) {
        for (let x = 0; x < roi.w; x += 1) {
          const idx = y * roi.w + x;
          const inBand = roi.y + y >= extendedTop && roi.y + y <= bandBottom;
          const motionOn = absDiff[idx] > motionThresh;
          const darkOk = !useDarkSupport || luma[idx] < darkThresh;
          if (motionOn && inBand && darkOk) {
            const dx = x - centroidX;
            const dy = y - centroidY;
            covXX += dx * dx;
            covYY += dy * dy;
            covXY += dx * dy;
          }
        }
      }
      if (area > 0) {
        const angle = 0.5 * Math.atan2(2 * covXY, covXX - covYY);
        footAngleDeg = (angle * 180) / Math.PI;
      }
    }

    const strikeBias =
      bandFoot > 0 ? clamp((frontCount - backCount) / bandFoot, -1, 1) : null;
    const groundBandDensity = bandCount > 0 ? bandFoot / bandCount : 0;

    samples.push({
      tMs: frame.tMs,
      valid,
      footArea: area,
      footCentroidX: valid ? centroidX : null,
      footCentroidY: valid ? centroidY : null,
      footAngleDeg: valid ? footAngleDeg : null,
      strikeBias,
      groundBandDensity,
    });

    if (valid) {
      areas.push(area);
      if (typeof footAngleDeg === "number") angles.push(footAngleDeg);
      if (typeof strikeBias === "number") strikeBiases.push(strikeBias);
      densities.push(groundBandDensity);
    }

    prevLuma = luma;
  });

  const centroidXSeries = samples.map((sample) => sample.footCentroidX);
  const centroidYSeries = samples.map((sample) => sample.footCentroidY);
  const strikeSeries = samples.map((sample) => sample.strikeBias);
  const smoothedX = movingAverage(centroidXSeries, smoothWindow);
  const smoothedY = movingAverage(centroidYSeries, smoothWindow);
  const smoothedStrike = movingAverage(strikeSeries, smoothWindow);

  samples.forEach((sample, idx) => {
    sample.footCentroidX = smoothedX[idx];
    sample.footCentroidY = smoothedY[idx];
    sample.strikeBias = smoothedStrike[idx];
  });

  const validFrames = samples.filter((sample) => sample.valid).length;
  const areaMin = areas.length ? Math.min(...areas) : 0;
  const areaMax = areas.length ? Math.max(...areas) : 0;
  const angleMin = angles.length ? Math.min(...angles) : 0;
  const angleMax = angles.length ? Math.max(...angles) : 0;
  const strikeBiasMin = strikeBiases.length ? Math.min(...strikeBiases) : 0;
  const strikeBiasMax = strikeBiases.length ? Math.max(...strikeBiases) : 0;
  const groundBandDensityMin = densities.length ? Math.min(...densities) : 0;
  const groundBandDensityMax = densities.length ? Math.max(...densities) : 0;

  const motionThreshSummary = motionThresholds.length
    ? motionThresholds.reduce((sum, value) => sum + value, 0) / motionThresholds.length
    : 0;
  const darkThreshSummary = darkThresholds.length
    ? darkThresholds.reduce((sum, value) => sum + value, 0) / darkThresholds.length
    : undefined;

  const debug: FootExtractorDebug = {
    notes: [],
    thresholds: {
      motionThresh: motionThreshSummary,
      darkThresh: useDarkSupport ? darkThreshSummary : undefined,
      minFootArea,
      groundBandPx,
    },
    stats: {
      validFrames,
      areaMin,
      areaMax,
      angleMin,
      angleMax,
      strikeBiasMin,
      strikeBiasMax,
      groundBandDensityMin,
      groundBandDensityMax,
    },
  };

  return { samples, debug };
}
