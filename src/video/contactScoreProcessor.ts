/**
 * Contact Score Processor
 *
 * Computes a scalar contact score ∈ [0,1] from a thin band of pixels
 * just above the ground line inside the ROI.
 *
 * Metric: Dark-pixel density + edge magnitude in ground band
 * - Samples a horizontal band (groundY - bandHeightPx to groundY)
 * - Computes luma histogram and edge energy
 * - Normalizes to [0, 1] and applies EMA smoothing
 */

export type ContactScoreState = {
  smoothedScore: number;
  rawScore: number;
  timestamp: number;
};

export type ContactScoreConfig = {
  bandHeightPx: number; // Height of ground band to analyze (e.g., 12px)
  downsampleFactor: number; // Downsample factor for speed (e.g., 2)
  emaAlpha: number; // EMA smoothing: 0.2–0.4
  darkThreshold: number; // Luma threshold for "dark" pixels (e.g., 80)
};

const DEFAULT_CONFIG: ContactScoreConfig = {
  bandHeightPx: 12,
  downsampleFactor: 2,
  emaAlpha: 0.3,
  darkThreshold: 80,
};

/**
 * Decode base64-encoded RGBA or LUMA frame data
 */
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

  // Fallback polyfill for non-browser environments
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

/**
 * Extract luma (grayscale) from RGBA pixel
 */
function lumaFromRgba(bytes: Uint8ClampedArray, idx: number): number {
  const r = bytes[idx];
  const g = bytes[idx + 1];
  const b = bytes[idx + 2];
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Compute contact score from a ground band inside ROI
 *
 * @param frameData Base64-encoded RGBA or LUMA frame
 * @param frameWidth Frame width in pixels
 * @param frameHeight Frame height in pixels
 * @param frameFormat Frame format ("rgba" or "luma")
 * @param roiX ROI left edge (pixels)
 * @param roiY ROI top edge (pixels)
 * @param roiW ROI width
 * @param roiH ROI height
 * @param groundY Ground line Y position (pixels)
 * @param config ContactScoreConfig overrides
 * @returns { score: 0..1, debug: { rawScore, bandEnergy, darkDensity } }
 */
export function computeContactScore(
  frameData: string,
  frameWidth: number,
  frameHeight: number,
  frameFormat: "rgba" | "luma",
  roiX: number,
  roiY: number,
  roiW: number,
  roiH: number,
  groundY: number,
  config: Partial<ContactScoreConfig> = {}
): { score: number; debug: { rawScore: number; bandEnergy: number; darkDensity: number } } {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  try {
    const bytes = decodeBase64(frameData);

    // Define ground band: horizontal slice from (groundY - bandHeightPx) to groundY
    const bandTop = Math.max(0, Math.floor(groundY - cfg.bandHeightPx));
    const bandBottom = Math.min(frameHeight - 1, Math.floor(groundY));
    const bandHeight = bandBottom - bandTop;

    if (bandHeight <= 0) {
      return { score: 0, debug: { rawScore: 0, bandEnergy: 0, darkDensity: 0 } };
    }

    // Clip ROI to frame and band
    const roiLeft = Math.max(0, Math.floor(roiX));
    const roiRight = Math.min(frameWidth - 1, Math.floor(roiX + roiW));
    const roiTop = Math.max(bandTop, Math.floor(roiY));
    const roiBottom = Math.min(bandBottom, Math.floor(roiY + roiH));

    if (roiLeft >= roiRight || roiTop >= roiBottom) {
      return { score: 0, debug: { rawScore: 0, bandEnergy: 0, darkDensity: 0 } };
    }

    let darkCount = 0;
    let edgeEnergy = 0;
    let pixelCount = 0;

    // Downsample: iterate with step
    const dsStep = Math.max(1, cfg.downsampleFactor);

    for (let y = roiTop; y < roiBottom; y += dsStep) {
      const prevY = Math.max(roiTop, y - 1);

      for (let x = roiLeft; x < roiRight; x += dsStep) {
        let luma: number;

        if (frameFormat === "rgba") {
          const idx = (y * frameWidth + x) * 4;
          luma = lumaFromRgba(bytes, idx);
        } else {
          // luma format: 1 byte per pixel
          const idx = y * frameWidth + x;
          luma = bytes[idx] ?? 0;
        }

        // Dark pixel density
        if (luma < cfg.darkThreshold) {
          darkCount += 1;
        }

        // Edge energy: vertical gradient (simple Sobel-like)
        if (prevY < y) {
          let lumaPrev: number;
          if (frameFormat === "rgba") {
            const idxPrev = (prevY * frameWidth + x) * 4;
            lumaPrev = lumaFromRgba(bytes, idxPrev);
          } else {
            const idxPrev = prevY * frameWidth + x;
            lumaPrev = bytes[idxPrev] ?? 0;
          }
          edgeEnergy += Math.abs(luma - lumaPrev);
        }

        pixelCount += 1;
      }
    }

    // Normalize metrics
    const darkDensity = pixelCount > 0 ? darkCount / pixelCount : 0;
    const avgEdge = pixelCount > 0 ? edgeEnergy / pixelCount : 0;

    // Combine: contact = (darkDensity + normalized_edge) / 2, clamp to [0,1]
    const normalizedEdge = Math.min(1, avgEdge / 50); // Empirical: 50 is typical max edge
    const rawScore = Math.min(1, (darkDensity * 0.6 + normalizedEdge * 0.4));

    return {
      score: rawScore,
      debug: {
        rawScore,
        bandEnergy: avgEdge,
        darkDensity,
      },
    };
  } catch (error) {
    console.error("contactScoreProcessor: computation error", error);
    return { score: 0, debug: { rawScore: 0, bandEnergy: 0, darkDensity: 0 } };
  }
}

/**
 * Apply EMA smoothing to contact score
 */
export function smoothContactScore(
  rawScore: number,
  prevSmoothed: number,
  alpha: number = 0.3
): number {
  return alpha * rawScore + (1 - alpha) * prevSmoothed;
}
/**
 * Compute contact score from normalized PixelSample (when frame data is available).
 * Alternative to base64 input; works directly with extracted luminance data.
 *
 * @param pixelSample PixelSample from framePixelExtractor
 * @param roiX ROI left edge
 * @param roiY ROI top edge
 * @param roiW ROI width
 * @param roiH ROI height
 * @param groundY Ground line Y position
 * @param config ContactScoreConfig overrides
 * @returns Contact score 0..1
 */
export function computeContactScoreFromPixels(
  pixelSample: { width: number; height: number; gray?: Uint8Array | Float32Array },
  roiX: number,
  roiY: number,
  roiW: number,
  roiH: number,
  groundY: number,
  config: Partial<ContactScoreConfig> = {}
): { score: number; debug: { rawScore: number; bandEnergy: number; darkDensity: number } } {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  try {
    if (!pixelSample.gray || pixelSample.gray.length === 0) {
      return { score: 0, debug: { rawScore: 0, bandEnergy: 0, darkDensity: 0 } };
    }

    const { width, height, gray } = pixelSample;

    // Define ground band
    const bandTop = Math.max(0, Math.floor(groundY - cfg.bandHeightPx));
    const bandBottom = Math.min(height - 1, Math.floor(groundY));
    const bandHeight = bandBottom - bandTop;

    if (bandHeight <= 0) {
      return { score: 0, debug: { rawScore: 0, bandEnergy: 0, darkDensity: 0 } };
    }

    // Clip ROI to frame and band
    const roiLeft = Math.max(0, Math.floor(roiX));
    const roiRight = Math.min(width - 1, Math.floor(roiX + roiW));
    const roiTop = Math.max(bandTop, Math.floor(roiY));
    const roiBottom = Math.min(bandBottom, Math.floor(roiY + roiH));

    if (roiLeft >= roiRight || roiTop >= roiBottom) {
      return { score: 0, debug: { rawScore: 0, bandEnergy: 0, darkDensity: 0 } };
    }

    let darkCount = 0;
    let edgeEnergy = 0;
    let pixelCount = 0;

    const dsStep = Math.max(1, cfg.downsampleFactor);

    for (let y = roiTop; y < roiBottom; y += dsStep) {
      const prevY = Math.max(roiTop, y - 1);

      for (let x = roiLeft; x < roiRight; x += dsStep) {
        const idx = y * width + x;
        const luma = gray[idx] ?? 0;

        pixelCount += 1;

        if (luma < cfg.darkThreshold) {
          darkCount += 1;
        }

        // Simple edge proxy: absolute difference with pixel above
        if (prevY < y && y > 0) {
          const prevIdx = prevY * width + x;
          const prevLuma = gray[prevIdx] ?? 0;
          const edge = Math.abs(luma - prevLuma);
          edgeEnergy += edge;
        }
      }
    }

    if (pixelCount === 0) {
      return { score: 0, debug: { rawScore: 0, bandEnergy: 0, darkDensity: 0 } };
    }

    const darkDensity = darkCount / pixelCount;
    const bandEnergy = edgeEnergy / (pixelCount * 255); // Normalized
    const rawScore = Math.min(1, darkDensity * 0.6 + bandEnergy * 0.4);

    return { score: rawScore, debug: { rawScore, bandEnergy, darkDensity } };
  } catch (error) {
    console.error("computeContactScoreFromPixels: error", error);
    return { score: 0, debug: { rawScore: 0, bandEnergy: 0, darkDensity: 0 } };
  }
}