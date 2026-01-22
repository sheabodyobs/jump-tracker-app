/**
 * footPatchDetector.ts
 *
 * Deterministic, ML-free contact patch detector for foot–ground interaction.
 *
 * Algorithm overview (no ML):
 *  - Compute motion energy in a narrow band above the ground line
 *  - Score candidate ROIs by sharpness of contact spikes, cadence stability,
 *    spatial concentration, ground proximity, and anti-body correlation
 *  - Track ROI over time with bounded drift; prefer rejecting over hallucinating
 */

import type { GroundModel2D } from './jumpAnalysisContract';

export type FootPatchOptions = {
  bandAboveGroundPx?: number;
  roiSize?: { w: number; h: number };
  stride?: number;
  windowFrames?: number;
  trackMaxShiftPx?: number;
  minFootness?: number;
};

export type FootPatchResult = {
  roi: { x: number; y: number; w: number; h: number };
  footness: number; // 0..1
  stability: number; // 0..1
  confidence: number; // combined footness+stability
  diagnostics: {
    featureScores: {
      sharpness: number;
      cadenceStability: number;
      concentration: number;
      groundProximity: number;
      bodyCorr: number;
    };
    selectedFrom: 'globalScan' | 'track';
    reinitCount: number;
    avgShiftPx: number;
    band: { yMin: number; yMax: number; clipped: boolean };
  };
  reasons: string[];
};

type GrayFrame = { data: Uint8ClampedArray; width: number; height: number };

const EPS = 1e-6;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function signedDistanceToGround(x: number, y: number, ground: GroundModel2D): number {
  if (ground.type === 'unknown') return Number.POSITIVE_INFINITY;
  if (ground.type === 'y_scalar') {
    if (ground.y === null) return Number.POSITIVE_INFINITY;
    return ground.y - y; // negative above ground
  }
  if (ground.type === 'line2d') {
    if (ground.a === null || ground.b === null) return Number.POSITIVE_INFINITY;
    const lineY = ground.a * x + ground.b;
    return lineY - y;
  }
  if (ground.type === 'hough_polar') {
    if (ground.theta === null || ground.rho === null) return Number.POSITIVE_INFINITY;
    const rhoPixel = x * Math.cos(ground.theta) + y * Math.sin(ground.theta);
    return ground.rho - rhoPixel;
  }
  return Number.POSITIVE_INFINITY;
}

function groundYAtCenter(width: number, ground: GroundModel2D): number | null {
  if (ground.type === 'unknown') return null;
  const x = width / 2;
  if (ground.type === 'y_scalar') return ground.y;
  if (ground.type === 'line2d') {
    if (ground.a === null || ground.b === null) return null;
    return ground.a * x + ground.b;
  }
  if (ground.type === 'hough_polar') {
    if (ground.theta === null || ground.rho === null) return null;
    const denom = Math.sin(ground.theta);
    if (Math.abs(denom) < 1e-6) return null;
    return (ground.rho - x * Math.cos(ground.theta)) / denom;
  }
  return null;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : 0.5 * (s[mid - 1] + s[mid]);
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * s.length) - 1;
  const idx = Math.max(0, Math.min(s.length - 1, rank));
  return s[idx];
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const v = mean(values.map((v) => (v - m) * (v - m)));
  return Math.sqrt(v);
}

function correlation(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length < 2) return 0;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    const va = a[i] - ma;
    const vb = b[i] - mb;
    num += va * vb;
    da += va * va;
    db += vb * vb;
  }
  if (da < EPS || db < EPS) return 0;
  return num / Math.sqrt(da * db);
}

function buildEnergyFrames(frames: GrayFrame[], windowFrames: number): Float32Array[] {
  const windowed = frames.slice(-windowFrames);
  const energy: Float32Array[] = [];
  for (let i = 1; i < windowed.length; i++) {
    const prev = windowed[i - 1].data;
    const curr = windowed[i].data;
    const len = Math.min(prev.length, curr.length);
    const diff = new Float32Array(len);
    for (let j = 0; j < len; j++) {
      diff[j] = Math.abs(curr[j] - prev[j]);
    }
    energy.push(diff);
  }
  return energy;
}

function roiEnergySeries(
  energyFrames: Float32Array[],
  width: number,
  x: number,
  y: number,
  w: number,
  h: number
): number[] {
  const series: number[] = [];
  for (const ef of energyFrames) {
    let sum = 0;
    for (let yy = y; yy < y + h; yy++) {
      const row = yy * width;
      for (let xx = x; xx < x + w; xx++) {
        sum += ef[row + xx] || 0;
      }
    }
    series.push(sum);
  }
  return series;
}

function cadenceStability(energy: number[]): number {
  if (energy.length < 6) return 0;
  const m = mean(energy);
  const s = std(energy);
  const thresh = m + 0.5 * s;
  const peaks: number[] = [];
  for (let i = 1; i < energy.length - 1; i++) {
    if (energy[i] > thresh && energy[i] > energy[i - 1] && energy[i] >= energy[i + 1]) {
      peaks.push(i);
    }
  }
  if (peaks.length < 3) return 0;
  const intervals: number[] = [];
  for (let i = 1; i < peaks.length; i++) intervals.push(peaks[i] - peaks[i - 1]);
  if (intervals.length < 2) return 0;
  const mInt = mean(intervals);
  const stdInt = std(intervals);
  const cv = stdInt / (mInt + EPS);
  return clamp01(1 / (1 + cv));
}

function sharpnessScore(series: number[]): number {
  if (series.length < 3) return 0;
  const dE: number[] = [];
  for (let i = 1; i < series.length; i++) {
    dE.push(series[i] - series[i - 1]);
  }
  const positives = dE.filter((v) => v > 0).sort((a, b) => b - a);
  const topK = positives.slice(0, Math.max(1, Math.min(3, positives.length)));
  const medianAbs = median(dE.map((v) => Math.abs(v))) + EPS;
  const strength = mean(topK) / medianAbs;
  // Normalize with soft clamp
  return clamp01(strength / 4);
}

function concentrationScore(
  roiSeries: number[],
  roiArea: number,
  bandEnergy: number,
  bandArea: number
): number {
  const roiDensity = (roiSeries.reduce((a, b) => a + b, 0) / Math.max(1, roiSeries.length)) / (roiArea + EPS);
  const bandDensity = (bandEnergy / Math.max(1, bandArea)) || EPS;
  const ratio = roiDensity / (bandDensity + EPS);
  // Prefer concentrated regions; ratio ~1 is neutral, >2 strong
  return clamp01(ratio / 2);
}

function groundProximityScore(centroidY: number, groundY: number, bandAbove: number): number {
  const dist = groundY - centroidY; // positive if centroid is above ground
  return clamp01(1 - Math.max(0, dist < 0 ? Math.abs(dist) : 0) / (bandAbove + 1));
}

function bodyCorrelationPenalty(roiSeries: number[], bodySeries: number[]): number {
  const corr = correlation(roiSeries, bodySeries);
  return Math.max(0, corr);
}

export function detectFootPatch(
  frames: GrayFrame[],
  groundModel: GroundModel2D,
  options: FootPatchOptions = {}
): FootPatchResult | null {
  if (!frames.length) return null;
  if (groundModel.type === 'unknown') return null;

  const width = frames[0].width;
  const height = frames[0].height;
  const bandAboveGroundPx = options.bandAboveGroundPx ?? 20;
  const roiSize = options.roiSize ?? { w: 32, h: 24 };
  const stride = options.stride ?? 2;
  const windowFrames = Math.min(options.windowFrames ?? 90, frames.length);
  const trackMaxShiftPx = options.trackMaxShiftPx ?? 6;
  const minFootness = options.minFootness ?? 0.35;

  const gY = groundYAtCenter(width, groundModel);
  if (gY === null) return null;

  const bandYMin = Math.max(0, Math.floor(gY - bandAboveGroundPx));
  const bandYMax = Math.min(height - 1, Math.ceil(gY));
  if (bandYMax - bandYMin < roiSize.h) return null;

  const energyFrames = buildEnergyFrames(frames, windowFrames);
  if (!energyFrames.length) return null;

  // Aggregate band energy
  let bandEnergyTotal = 0;
  const bandArea = (bandYMax - bandYMin + 1) * width;
  for (const ef of energyFrames) {
    for (let y = bandYMin; y <= bandYMax; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        bandEnergyTotal += ef[row + x] || 0;
      }
    }
  }

  let best: FootPatchResult | null = null;

  for (let y = bandYMin; y + roiSize.h <= bandYMax; y += stride) {
    for (let x = 0; x + roiSize.w <= width; x += stride) {
      // Skip if ROI too far above band
      const centroidY = y + roiSize.h / 2;
      if (centroidY < bandYMin - 2) continue;

      const roiSeries = roiEnergySeries(energyFrames, width, x, y, roiSize.w, roiSize.h);
      const sharpness = sharpnessScore(roiSeries);
      const cadence = cadenceStability(roiSeries);

      // Body ROI: same width/height, placed just above the band
      const bodyY = Math.max(0, bandYMin - roiSize.h - 2);
      const bodySeries = roiEnergySeries(energyFrames, width, x, bodyY, roiSize.w, roiSize.h);
      const bodyCorr = bodyCorrelationPenalty(roiSeries, bodySeries);

      const roiEnergySum = roiSeries.reduce((a, b) => a + b, 0);
      const concentration = concentrationScore(roiSeries, roiSize.w * roiSize.h, bandEnergyTotal, bandArea);
      const groundProximity = groundProximityScore(centroidY, gY, bandAboveGroundPx);

      const footnessRaw =
        0.35 * sharpness +
        0.25 * cadence +
        0.2 * concentration +
        0.1 * groundProximity -
        0.25 * bodyCorr;
      const footness = clamp01(footnessRaw);

      if (!best || footness > best.footness) {
        best = {
          roi: { x, y, w: roiSize.w, h: roiSize.h },
          footness,
          stability: 0,
          confidence: 0,
          diagnostics: {
            featureScores: {
              sharpness,
              cadenceStability: cadence,
              concentration,
              groundProximity,
              bodyCorr,
            },
            selectedFrom: 'globalScan',
            reinitCount: 0,
            avgShiftPx: 0,
            band: { yMin: bandYMin, yMax: bandYMax, clipped: bandYMin === 0 || bandYMax === height - 1 },
          },
          reasons: [],
        };
      }
    }
  }

  if (!best) return null;

  // Track stability across frames (local search per frame)
  let reinitCount = 0;
  let shiftAccum = 0;
  let lockedFrames = 0;
  let currentRoi = { ...best.roi };

  for (const ef of energyFrames) {
    let bestShift = { dx: 0, dy: 0, score: -Infinity };
    for (let dy = -trackMaxShiftPx; dy <= trackMaxShiftPx; dy++) {
      for (let dx = -trackMaxShiftPx; dx <= trackMaxShiftPx; dx++) {
        const nx = Math.min(Math.max(0, currentRoi.x + dx), width - currentRoi.w);
        const ny = Math.min(Math.max(bandYMin, currentRoi.y + dy), bandYMax - currentRoi.h);
        const series = roiEnergySeries([ef], width, nx, ny, currentRoi.w, currentRoi.h);
        const score = series[0];
        if (score > bestShift.score) {
          bestShift = { dx: nx - currentRoi.x, dy: ny - currentRoi.y, score };
        }
      }
    }

    shiftAccum += Math.sqrt(bestShift.dx * bestShift.dx + bestShift.dy * bestShift.dy);
    currentRoi.x += bestShift.dx;
    currentRoi.y += bestShift.dy;

    if (Math.abs(bestShift.dx) <= trackMaxShiftPx && Math.abs(bestShift.dy) <= trackMaxShiftPx) {
      lockedFrames++;
    } else {
      reinitCount++;
    }
  }

  const stability = energyFrames.length ? clamp01(lockedFrames / energyFrames.length) : 0;
  const confidence = clamp01(0.5 * best.footness + 0.5 * stability);

  const reasons: string[] = [];
  if (best.diagnostics.featureScores.sharpness < 0.15) reasons.push('LOW_SHARPNESS');
  if (best.diagnostics.featureScores.cadenceStability < 0.2) reasons.push('LOW_CADENCE');
  if (best.diagnostics.featureScores.concentration < 0.2) reasons.push('LOW_CONCENTRATION');
  if (best.diagnostics.featureScores.bodyCorr > 0.6) reasons.push('HIGH_BODY_CORR');

  const result: FootPatchResult = {
    roi: best.roi,
    footness: best.footness,
    stability,
    confidence,
    diagnostics: {
      ...best.diagnostics,
      selectedFrom: 'globalScan',
      reinitCount,
      avgShiftPx: energyFrames.length ? shiftAccum / energyFrames.length : 0,
    },
    reasons,
  };

  if (confidence < minFootness) {
    result.reasons.push('LOW_CONFIDENCE');
    return result; // caller can decide to reject
  }

  return result;
}
