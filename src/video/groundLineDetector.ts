// src/video/groundLineDetector.ts
// Automatic ground line detection from side-view pogo hop video.
// Analyzes edge strength in a horizontal band at the bottom of the frame
// to identify the most stable floor boundary.

export interface GroundLineResult {
  y: number; // Pixel row of detected ground line
  confidence: number; // 0..1 based on stability and contrast
  method: "edge_band"; // Detection method identifier
  debug?: {
    edgeStrengths?: number[]; // Edge strength per y-row (for visualization)
    candidates?: number[]; // Top candidate y values
    medianY?: number; // Median before final selection
  };
}

export interface GroundLineDetectorConfig {
  bandStartPercent: number; // Start of analysis band as % of frame height (e.g., 60)
  bandEndPercent: number; // End of analysis band as % of frame height (e.g., 90)
  downsampleFactor: number; // Skip pixels to speed up computation
  edgeThreshold: number; // Minimum edge strength to consider a candidate
  stabilityWindow: number; // Number of frames to track for stability
  minStabilityFrames: number; // Minimum frames in window for confidence boost
}

const DEFAULT_CONFIG: GroundLineDetectorConfig = {
  bandStartPercent: 60,
  bandEndPercent: 90,
  downsampleFactor: 2,
  edgeThreshold: 0.15, // Normalized 0..1
  stabilityWindow: 5,
  minStabilityFrames: 3,
};

/**
 * Stateful ground line detector that tracks candidates over multiple frames.
 * Prefer y values that are:
 * - Horizontally continuous (high edge strength)
 * - Vertically stable over time (consistent across frames)
 */
export class GroundLineDetector {
  private candidateHistory: number[] = []; // Rolling window of detected y positions
  private config: GroundLineDetectorConfig;

  constructor(config?: Partial<GroundLineDetectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...(config ?? {}) };
  }

  /**
   * Detect ground line from a single frame.
   * Frame data assumed to be in RGBA format.
   */
  public detectGroundLine(
    frameData: string, // Base64 encoded frame data (placeholder for now)
    frameWidth: number,
    frameHeight: number,
    frameFormat: string
  ): GroundLineResult {
    // For now, return a placeholder since frame data extraction is stubbed
    // In production, this would:
    // 1. Decode frameData
    // 2. Analyze horizontal edge strength in the band
    // 3. Track stability over frames

    // Placeholder implementation - return middle of band with low confidence
    const bandStart = Math.round((frameHeight * this.config.bandStartPercent) / 100);
    const bandEnd = Math.round((frameHeight * this.config.bandEndPercent) / 100);
    const placeholderY = Math.round((bandStart + bandEnd) / 2);

    // Track in history for stability
    this.candidateHistory.push(placeholderY);
    if (this.candidateHistory.length > this.config.stabilityWindow) {
      this.candidateHistory.shift();
    }

    const confidence = this.computeConfidence();

    return {
      y: placeholderY,
      confidence,
      method: "edge_band",
      debug: {
        medianY: this.getMedianCandidate(),
      },
    };
  }

  /**
   * Compute confidence based on candidate stability over time.
   */
  private computeConfidence(): number {
    if (this.candidateHistory.length === 0) return 0;

    const variance = this.computeVariance(this.candidateHistory);
    const maxVariance = 50; // Pixels; beyond this = low confidence
    const stabilityScore = Math.max(0, 1 - variance / maxVariance);

    // Boost confidence if we have enough frames in history
    const frameCountScore =
      this.candidateHistory.length >= this.config.minStabilityFrames ? 0.2 : 0;

    return Math.min(1, stabilityScore * 0.8 + frameCountScore);
  }

  /**
   * Get median y position from candidate history.
   */
  private getMedianCandidate(): number {
    if (this.candidateHistory.length === 0) return 0;

    const sorted = [...this.candidateHistory].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /**
   * Compute variance of candidate positions.
   */
  private computeVariance(values: number[]): number {
    if (values.length === 0) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const squaredDiffs = values.map((v) => (v - mean) ** 2);
    return squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  }

  /**
   * Reset detector state (e.g., when starting new recording).
   */
  public reset(): void {
    this.candidateHistory = [];
  }

  /**
   * Get current ground line estimate without processing a new frame.
   */
  public getCurrentEstimate(): GroundLineResult | null {
    if (this.candidateHistory.length === 0) return null;

    const medianY = this.getMedianCandidate();
    const confidence = this.computeConfidence();

    return {
      y: Math.round(medianY),
      confidence,
      method: "edge_band",
    };
  }

  /**
   * Detect ground line from normalized PixelSample (when pixel data is available).
   * Analyzes horizontal edge strength to find stable ground boundary.
   */
  public detectGroundLineFromPixels(pixelSample: {
    width: number;
    height: number;
    gray?: Uint8Array | Float32Array;
  }): GroundLineResult {
    if (!pixelSample.gray || pixelSample.gray.length === 0) {
      // Fall back to placeholder
      return this.getCurrentEstimate() ?? {
        y: Math.round((pixelSample.height * this.config.bandEndPercent) / 100),
        confidence: 0,
        method: "edge_band",
      };
    }

    const { width, height, gray } = pixelSample;

    // Analyze horizontal band (60-90% of frame height)
    const bandStart = Math.round((height * this.config.bandStartPercent) / 100);
    const bandEnd = Math.round((height * this.config.bandEndPercent) / 100);

    let bestY = Math.round((bandStart + bandEnd) / 2);
    let bestEnergy = 0;

    // Scan each y-row in the band and compute horizontal edge strength
    const step = Math.max(1, this.config.downsampleFactor);

    for (let y = bandStart; y < bandEnd; y += step) {
      let rowEnergy = 0;
      let pixelCount = 0;

      // Compute horizontal edge strength (variance of luminance across row)
      for (let x = 0; x < width - 1; x += step) {
        const idx = y * width + x;
        const idx1 = y * width + (x + 1);

        const lum = gray[idx] ?? 0;
        const lumNext = gray[idx1] ?? 0;

        rowEnergy += Math.abs(lum - lumNext);
        pixelCount += 1;
      }

      if (pixelCount > 0) {
        const normalizedEnergy = rowEnergy / (pixelCount * 255);

        // Track candidates with significant edge energy
        if (normalizedEnergy > this.config.edgeThreshold && normalizedEnergy > bestEnergy) {
          bestY = y;
          bestEnergy = normalizedEnergy;
        }
      }
    }

    // Update history for stability tracking
    this.candidateHistory.push(bestY);
    if (this.candidateHistory.length > this.config.stabilityWindow) {
      this.candidateHistory.shift();
    }

    const confidence = this.computeConfidence();

    return {
      y: bestY,
      confidence,
      method: "edge_band",
      debug: {
        medianY: this.getMedianCandidate(),
      },
    };
  }
}

/**
 * Compute horizontal edge strength for a row of pixel data.
 * Returns normalized value 0..1 based on intensity variance across the row.
 *
 * Note: This is a placeholder. In production, use proper edge detection
 * (e.g., Sobel, Canny) on actual frame pixel data.
 */
export function computeRowEdgeStrength(
  pixelRow: Uint8ClampedArray,
  downsampleFactor: number = 2
): number {
  if (pixelRow.length < 4) return 0;

  // Skip every N pixels to reduce computation
  const sampled: number[] = [];
  for (let i = 0; i < pixelRow.length; i += 4 * downsampleFactor) {
    // Assume RGBA format; extract luminance (weighted RGB)
    const r = pixelRow[i] ?? 0;
    const g = pixelRow[i + 1] ?? 0;
    const b = pixelRow[i + 2] ?? 0;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    sampled.push(lum);
  }

  if (sampled.length < 2) return 0;

  // Edge strength = variance of luminance (high variance = edge)
  const mean = sampled.reduce((a, b) => a + b, 0) / sampled.length;
  const variance = sampled.reduce((sum, val) => sum + (val - mean) ** 2, 0) / sampled.length;

  // Normalize to 0..1 (assuming max variance ~10000 for 0-255 range)
  return Math.min(1, variance / 10000);
}
