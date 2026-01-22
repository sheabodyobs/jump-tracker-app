/**
 * roiInference.ts
 *
 * ROI inference via motion energy band search above detected ground.
 *
 * Algorithm:
 * 1. Compute signed distance to ground line for each pixel
 * 2. Extract motion energy band above ground
 * 3. Search for maximal-energy rectangle in band
 * 4. Compute confidence from energy + stability
 */

import type { GroundModel2D } from "./jumpAnalysisContract";

export type RoiInference = {
  roi: { x: number; y: number; w: number; h: number };
  confidence: number; // 0..1
  method: "motionEnergyBandSearch";
  diagnostics: {
    bestEnergy: number;
    medianEnergy: number;
    bandClipped: boolean;
    stageSummary?: string;
  };
};

export type RoiInferenceOptions = {
  searchBandPx?: number; // how far above ground to search (default 120)
  roiSize?: { w: number; h: number }; // default {w: 80, h: 60}
  stride?: number; // scan stride (default 4)
  minMotion?: number; // minimum evidence threshold (default 10.0)
};

/**
 * Signed distance from pixel (x, y) to ground line.
 * Returns negative if above ground, positive if below.
 * Works for hough_polar, line2d, and y_scalar ground models.
 */
function signedDistanceToGround(
  x: number,
  y: number,
  groundModel: GroundModel2D
): number {
  if (groundModel.type === "unknown") {
    // No ground info; assume bottom of frame is ground
    return y; // all pixels are "below" (positive distance)
  }

  if (groundModel.type === "hough_polar") {
    // Hough line: rho = x*cos(theta) + y*sin(theta)
    // Points below line: their rho is > line's rho
    // So distance = (x*cos(theta) + y*sin(theta)) - rho
    // Negative = above, positive = below
    if (groundModel.theta === null || groundModel.rho === null) {
      return y;
    }
    const theta = groundModel.theta;
    const rho = groundModel.rho;
    const pixelRho = x * Math.cos(theta) + y * Math.sin(theta);
    return pixelRho - rho; // negative = above ground
  }

  if (groundModel.type === "line2d") {
    // Line: y = a*x + b
    // Point below: y > a*x + b
    // Distance = (a*x + b) - y (negative = above)
    if (groundModel.a === null || groundModel.b === null) {
      return y;
    }
    const lineY = groundModel.a * x + groundModel.b;
    return lineY - y; // negative = above ground
  }

  if (groundModel.type === "y_scalar") {
    // Horizontal line: y = groundModel.y
    // Distance = groundModel.y - y (negative = above)
    if (groundModel.y === null) {
      return y;
    }
    return groundModel.y - y; // negative = above ground
  }

  return y; // fallback
}

/**
 * Compute temporal motion energy for each pixel.
 * Returns 2D array: energyMap[y][x] = accumulated |gray[t] - gray[t-1]|
 */
function computeMotionEnergyMap(
  frames: { data: Uint8ClampedArray; width: number; height: number }[]
): number[][] {
  if (frames.length < 2) {
    return [];
  }

  const { width, height } = frames[0];
  const energyMap: number[][] = Array.from({ length: height }, () =>
    Array(width).fill(0)
  );

  let prevGray = new Float32Array(width * height);
  // Initialize prev from first frame
  const first = frames[0].data;
  for (let i = 0; i < width * height; i++) {
    prevGray[i] = first[i]; // assume single-channel or R-only
  }

  // Accumulate frame-to-frame differences
  for (let frameIdx = 1; frameIdx < frames.length; frameIdx++) {
    const currGray = frames[frameIdx].data;
    for (let i = 0; i < width * height; i++) {
      const diff = Math.abs(currGray[i] - prevGray[i]);
      const y = Math.floor(i / width);
      const x = i % width;
      energyMap[y][x] += diff;
    }
    // Update prev
    for (let i = 0; i < width * height; i++) {
      prevGray[i] = currGray[i];
    }
  }

  return energyMap;
}

/**
 * Search band above ground for rectangle of size (roiW, roiH) with max energy.
 * Uses sliding window with stride.
 */
function findMaxEnergyRoi(
  energyMap: number[][],
  groundModel: GroundModel2D,
  width: number,
  height: number,
  roiW: number,
  roiH: number,
  stride: number,
  searchBandPx: number
): {
  roi: { x: number; y: number; w: number; h: number };
  bestEnergy: number;
  bandClipped: boolean;
} {
  let maxEnergy = 0;
  let bestRoi = { x: 0, y: Math.max(0, height - roiH), w: roiW, h: roiH };

  // Scan positions with stride
  for (let x = 0; x + roiW <= width; x += stride) {
    for (let y = 0; y + roiH <= height; y += stride) {
      // Check if this ROI is mostly above ground
      let aboveCount = 0;
      let totalCount = 0;

      for (let py = y; py < y + roiH; py++) {
        for (let px = x; px < x + roiW; px++) {
          const dist = signedDistanceToGround(px, py, groundModel);
          if (dist < 0) aboveCount++; // above ground (negative distance)
          totalCount++;
        }
      }

      // Only consider ROIs that are mostly above ground
      const ratioAboveGround = aboveCount / totalCount;
      if (ratioAboveGround < 0.6) continue;

      // Also check distance constraint: ROI should be within searchBandPx of ground
      let avgDist = 0;
      for (let py = y; py < y + roiH; py++) {
        for (let px = x; px < x + roiW; px++) {
          avgDist += Math.abs(signedDistanceToGround(px, py, groundModel));
        }
      }
      avgDist /= roiW * roiH;

      if (avgDist > searchBandPx) continue;

      // Compute energy in this ROI
      let roiEnergy = 0;
      for (let py = y; py < y + roiH; py++) {
        for (let px = x; px < x + roiW; px++) {
          if (py < energyMap.length && px < energyMap[0].length) {
            roiEnergy += energyMap[py][px];
          }
        }
      }

      if (roiEnergy > maxEnergy) {
        maxEnergy = roiEnergy;
        bestRoi = { x, y, w: roiW, h: roiH };
      }
    }
  }

  // Check if ROI touches ground line (clipped)
  let clipped = false;
  for (let px = bestRoi.x; px < bestRoi.x + bestRoi.w; px++) {
    const dist = signedDistanceToGround(px, bestRoi.y + bestRoi.h, groundModel);
    if (dist > -10) {
      // within 10 pixels of ground
      clipped = true;
      break;
    }
  }

  return { roi: bestRoi, bestEnergy: maxEnergy, bandClipped: clipped };
}

/**
 * Confidence from energy ratio and stability.
 */
function computeConfidence(
  bestEnergy: number,
  medianEnergy: number,
  roiArea: number,
  bandClipped: boolean
): number {
  if (bestEnergy < 1.0) return 0; // no motion

  // Energy ratio: how much better than median?
  const energyRatio = medianEnergy > 0 ? bestEnergy / medianEnergy : 1.0;
  const energyConfidence = Math.min(1.0, Math.log1p(energyRatio) / Math.log1p(10));

  // Clipping penalty: if ROI near ground, less confident
  const clippingPenalty = bandClipped ? 0.15 : 0;

  return Math.max(0, Math.min(1.0, energyConfidence - clippingPenalty));
}

/**
 * Main inference function.
 */
export function inferRoiFromMotion(
  frames: Array<{ data: Uint8ClampedArray; width: number; height: number }>,
  groundModel: GroundModel2D,
  options: RoiInferenceOptions = {}
): RoiInference {
  const searchBandPx = options.searchBandPx ?? 120;
  const roiSize = options.roiSize ?? { w: 80, h: 60 };
  const stride = options.stride ?? 4;
  const minMotion = options.minMotion ?? 10.0;

  if (frames.length < 2) {
    return {
      roi: { x: 0, y: 0, w: roiSize.w, h: roiSize.h },
      confidence: 0,
      method: "motionEnergyBandSearch",
      diagnostics: {
        bestEnergy: 0,
        medianEnergy: 0,
        bandClipped: false,
        stageSummary: "Insufficient frames (need ≥2)",
      },
    };
  }

  const { width, height } = frames[0];

  // Validate ground model
  if (groundModel.type === "unknown") {
    return {
      roi: { x: 0, y: Math.max(0, height - roiSize.h), w: roiSize.w, h: roiSize.h },
      confidence: 0,
      method: "motionEnergyBandSearch",
      diagnostics: {
        bestEnergy: 0,
        medianEnergy: 0,
        bandClipped: false,
        stageSummary: "Ground model unknown",
      },
    };
  }

  // Compute motion energy
  const energyMap = computeMotionEnergyMap(frames);
  if (energyMap.length === 0) {
    return {
      roi: { x: 0, y: Math.max(0, height - roiSize.h), w: roiSize.w, h: roiSize.h },
      confidence: 0,
      method: "motionEnergyBandSearch",
      diagnostics: {
        bestEnergy: 0,
        medianEnergy: 0,
        bandClipped: false,
        stageSummary: "Energy map empty",
      },
    };
  }

  // Compute median energy across all pixels
  const allEnergies: number[] = [];
  for (let y = 0; y < energyMap.length; y++) {
    for (let x = 0; x < energyMap[0].length; x++) {
      allEnergies.push(energyMap[y][x]);
    }
  }
  const medianEnergy = allEnergies.length > 0 ? percentile(allEnergies, 50) : 0;

  // Search for best ROI
  const searchResult = findMaxEnergyRoi(
    energyMap,
    groundModel,
    width,
    height,
    roiSize.w,
    roiSize.h,
    stride,
    searchBandPx
  );

  // Compute confidence
  const roiArea = roiSize.w * roiSize.h;
  const confidence = computeConfidence(
    searchResult.bestEnergy,
    medianEnergy,
    roiArea,
    searchResult.bandClipped
  );

  const stageSummary =
    searchResult.bestEnergy < minMotion
      ? `Low motion (${searchResult.bestEnergy.toFixed(1)} < ${minMotion})`
      : `Detected at (${searchResult.roi.x}, ${searchResult.roi.y}), energy=${searchResult.bestEnergy.toFixed(1)}`;

  return {
    roi: searchResult.roi,
    confidence,
    method: "motionEnergyBandSearch",
    diagnostics: {
      bestEnergy: searchResult.bestEnergy,
      medianEnergy,
      bandClipped: searchResult.bandClipped,
      stageSummary,
    },
  };
}

/**
 * Helper: percentile of array
 */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)];
}
