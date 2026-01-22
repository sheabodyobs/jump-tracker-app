// src/video/framePixelExtractor.ts
// Safe and efficient frame pixel data extraction for Expo + iOS + VisionCamera.
// Supports both live capture (VisionCamera worklet) and offline analysis (AVFoundation).

/**
 * Normalized pixel sample output format.
 * All paths convert their native formats to this common interface.
 */
export interface PixelSample {
  width: number; // Frame width in pixels
  height: number; // Frame height in pixels
  tMs: number; // Timestamp in milliseconds
  gray?: Uint8Array | Float32Array; // Luminance data (grayscale)
  roiSample?: {
    x: number;
    y: number;
    w: number;
    h: number;
    data: Uint8Array | Float32Array; // Pixel values in ROI
  };
  dataFormat: "uint8" | "float32"; // Indicates data type
  source: "vision-camera" | "avfoundation" | "placeholder"; // Source path
  debug?: {
    extractionTimeMs?: number;
    dwnsampleFactor?: number;
    notes?: string[];
  };
}

export interface PixelExtractorConfig {
  // Downsample factor for grayscale extraction (e.g., 4 = 4x4 blocks)
  downsampleFactor: number;

  // If true, extract only ROI instead of full frame
  roiOnly: boolean;

  // ROI boundaries (if roiOnly = true)
  roiX?: number;
  roiY?: number;
  roiW?: number;
  roiH?: number;

  // Enable debug logging
  debug: boolean;
}

const DEFAULT_CONFIG: PixelExtractorConfig = {
  downsampleFactor: 4, // 4x4 blocks = 25% of pixels
  roiOnly: false,
  debug: false,
};

/**
 * Extract luminance (grayscale) from RGBA pixel data.
 * Uses standard ITU-R BT.601 weights.
 * Returns downsampled Uint8Array for memory efficiency.
 *
 * @param rgbaData - RGBA pixel data (Uint8ClampedArray or similar)
 * @param width - Frame width
 * @param height - Frame height
 * @param downsampleFactor - Skip pixels (e.g., 4 = every 4th pixel)
 * @returns Downsampled luminance array
 */
export function extractLuminance(
  rgbaData: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  downsampleFactor: number = 1
): Uint8Array {
  const step = Math.max(1, downsampleFactor);
  const outWidth = Math.ceil(width / step);
  const outHeight = Math.ceil(height / step);
  const outSize = outWidth * outHeight;

  const gray = new Uint8Array(outSize);
  let outIdx = 0;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const pixelIdx = (y * width + x) * 4;
      const r = rgbaData[pixelIdx] ?? 0;
      const g = rgbaData[pixelIdx + 1] ?? 0;
      const b = rgbaData[pixelIdx + 2] ?? 0;

      // ITU-R BT.601 luminance weights
      const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      gray[outIdx++] = Math.min(255, Math.max(0, lum));
    }
  }

  return gray.slice(0, outIdx); // Trim to actual size
}

/**
 * Extract a rectangular ROI (Region of Interest) from RGBA data.
 * Returns downsampled luminance within ROI bounds.
 *
 * @param rgbaData - Full frame RGBA data
 * @param frameWidth - Full frame width
 * @param frameHeight - Full frame height
 * @param roiX - ROI left edge (pixels)
 * @param roiY - ROI top edge (pixels)
 * @param roiW - ROI width (pixels)
 * @param roiH - ROI height (pixels)
 * @param downsampleFactor - Skip pixels within ROI
 * @returns Downsampled luminance array for ROI
 */
export function extractRoiLuminance(
  rgbaData: Uint8ClampedArray | Uint8Array,
  frameWidth: number,
  frameHeight: number,
  roiX: number,
  roiY: number,
  roiW: number,
  roiH: number,
  downsampleFactor: number = 1
): Uint8Array {
  const step = Math.max(1, downsampleFactor);
  const roiX1 = Math.max(0, Math.min(frameWidth - 1, roiX));
  const roiY1 = Math.max(0, Math.min(frameHeight - 1, roiY));
  const roiX2 = Math.max(roiX1 + 1, Math.min(frameWidth, roiX + roiW));
  const roiY2 = Math.max(roiY1 + 1, Math.min(frameHeight, roiY + roiH));

  const outWidth = Math.ceil((roiX2 - roiX1) / step);
  const outHeight = Math.ceil((roiY2 - roiY1) / step);
  const outSize = outWidth * outHeight;

  const gray = new Uint8Array(outSize);
  let outIdx = 0;

  for (let y = roiY1; y < roiY2; y += step) {
    for (let x = roiX1; x < roiX2; x += step) {
      const pixelIdx = (y * frameWidth + x) * 4;
      const r = rgbaData[pixelIdx] ?? 0;
      const g = rgbaData[pixelIdx + 1] ?? 0;
      const b = rgbaData[pixelIdx + 2] ?? 0;

      const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      gray[outIdx++] = Math.min(255, Math.max(0, lum));
    }
  }

  return gray.slice(0, outIdx);
}

/**
 * Process VisionCamera frame data into normalized PixelSample.
 * Called from useFrameProcessor worklet.
 *
 * Note: In current Expo + VisionCamera v4, direct frame.image.toBase64()
 * is not available. This is a template for when frame pixel access is implemented.
 *
 * @param frameData - Base64 encoded frame or raw pixel buffer (placeholder)
 * @param frameWidth - Frame width
 * @param frameHeight - Frame height
 * @param tMs - Timestamp in milliseconds
 * @param config - Extraction config
 * @returns PixelSample or null if extraction fails
 */
export function extractPixelsFromVisionCameraFrame(
  frameData: string | Uint8ClampedArray,
  frameWidth: number,
  frameHeight: number,
  tMs: number,
  config?: Partial<PixelExtractorConfig>
): PixelSample | null {
  const cfg = { ...DEFAULT_CONFIG, ...(config ?? {}) };
  const startTime = Date.now();

  try {
    if (!frameData || frameWidth <= 0 || frameHeight <= 0) {
      if (cfg.debug) console.warn("[framePixelExtractor] Invalid frame dimensions");
      return null;
    }

    // For now, frameData is a placeholder string.
    // When frame.image.toBase64() or platform-specific pixel access is available:
    // 1. Decode frameData if it's base64
    // 2. Convert to Uint8ClampedArray if needed
    // 3. Extract luminance

    if (typeof frameData === "string" && frameData.length === 0) {
      // Placeholder: no actual pixel data yet
      if (cfg.debug) {
        console.log("[framePixelExtractor] Frame data not available (placeholder)");
      }
      return null;
    }

    let rgbaBuffer: Uint8ClampedArray;

    if (frameData instanceof Uint8ClampedArray) {
      rgbaBuffer = frameData;
    } else if (typeof frameData === "string") {
      // Would decode base64 here when implemented
      // const binaryString = atob(frameData);
      // const bytes = new Uint8ClampedArray(binaryString.length);
      // for (let i = 0; i < binaryString.length; i++) {
      //   bytes[i] = binaryString.charCodeAt(i);
      // }
      // rgbaBuffer = bytes;
      return null; // Placeholder
    } else {
      if (cfg.debug) console.warn("[framePixelExtractor] Unsupported frame data type");
      return null;
    }

    // Extract luminance data
    const gray = extractLuminance(rgbaBuffer, frameWidth, frameHeight, cfg.downsampleFactor);

    // Extract ROI if requested
    let roiSample: PixelSample["roiSample"] | undefined;
    if (cfg.roiOnly && cfg.roiX !== undefined && cfg.roiY !== undefined && cfg.roiW && cfg.roiH) {
      const roiData = extractRoiLuminance(
        rgbaBuffer,
        frameWidth,
        frameHeight,
        cfg.roiX,
        cfg.roiY,
        cfg.roiW,
        cfg.roiH,
        cfg.downsampleFactor
      );
      roiSample = {
        x: cfg.roiX,
        y: cfg.roiY,
        w: cfg.roiW,
        h: cfg.roiH,
        data: roiData,
      };
    }

    const extractionTimeMs = Date.now() - startTime;

    return {
      width: frameWidth,
      height: frameHeight,
      tMs,
      gray,
      roiSample,
      dataFormat: "uint8",
      source: "vision-camera",
      debug: {
        extractionTimeMs,
        dwnsampleFactor: cfg.downsampleFactor,
      },
    };
  } catch (error) {
    if (cfg.debug) {
      console.error("[framePixelExtractor] Extraction failed:", error);
    }
    return null;
  }
}

/**
 * Placeholder for offline AVFoundation frame extraction.
 * Would be implemented via native module when video file access is needed.
 *
 * @param videoUri - Path or URI to video file
 * @param frameIndex - Frame number to extract
 * @param nominalFps - Nominal FPS for timestamp calculation
 * @param config - Extraction config
 * @returns PixelSample or null if extraction fails
 */
export function extractPixelsFromAVFoundation(
  videoUri: string,
  frameIndex: number,
  nominalFps: number,
  config?: Partial<PixelExtractorConfig>
): PixelSample | null {
  // This would be implemented via a native module calling AVFoundation.
  // For now, return null to indicate not yet implemented.
  if (videoUri) {
    console.log("[framePixelExtractor] AVFoundation extraction not yet implemented");
  }
  return null;
}

/**
 * Safe wrapper: attempt to extract pixels, return null on any failure.
 * Designed for use in frame processor with error suppression.
 */
export function safeExtractPixels(
  frameData: string | Uint8ClampedArray,
  frameWidth: number,
  frameHeight: number,
  tMs: number,
  config?: Partial<PixelExtractorConfig>
): PixelSample | null {
  try {
    return extractPixelsFromVisionCameraFrame(frameData, frameWidth, frameHeight, tMs, config);
  } catch (error) {
    console.error("[framePixelExtractor] Safe extraction failed:", error);
    return null;
  }
}

/**
 * Compute simple statistics from a luminance sample.
 * Useful for edge detection and contrast analysis.
 */
export function computeLuminanceStats(
  gray: Uint8Array | Float32Array
): {
  min: number;
  max: number;
  mean: number;
  variance: number;
} {
  if (gray.length === 0) {
    return { min: 0, max: 0, mean: 0, variance: 0 };
  }

  let min = 255;
  let max = 0;
  let sum = 0;

  for (let i = 0; i < gray.length; i++) {
    const val = gray[i] ?? 0;
    min = Math.min(min, val);
    max = Math.max(max, val);
    sum += val;
  }

  const mean = sum / gray.length;
  let sumSqDiff = 0;

  for (let i = 0; i < gray.length; i++) {
    const val = (gray[i] ?? 0) - mean;
    sumSqDiff += val * val;
  }

  const variance = sumSqDiff / gray.length;

  return { min, max, mean, variance };
}
