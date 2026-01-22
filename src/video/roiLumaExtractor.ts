/**
 * roiLumaExtractor.ts
 *
 * TypeScript wrapper for offline-first ROI pixel access.
 * - Validates inputs (ROI, timestamps, targetSize)
 * - Normalizes ROI space (pixels vs normalized)
 * - Returns typed Uint8Array frames
 * - Ensures deterministic output
 * - Fail-safe: extraction failure → no metrics
 */

import { NativeModules, Platform } from "react-native";

// ============================================================================
// Types
// ============================================================================

export interface RoiSpec {
  x: number;
  y: number;
  width: number;
  height: number;
  space?: "pixels" | "normalized"; // default "pixels"
}

export interface SizeSpec {
  width: number;
  height: number;
}

export interface ExtractionOptions {
  preferYPlane?: boolean; // unused in v1, reserved for future
}

export interface RoiLumaFrame {
  tMs: number; // requested timestamp (ms)
  tMsActual: number; // actual frame time (ms, after snapping)
  width: number; // target width (px)
  height: number; // target height (px)
  gray: Uint8Array; // luma data, 8-bit, row-major
}

export interface RoiLumaError {
  code: string; // USER_CANCELLED, PERMISSION_DENIED, URI_UNSUPPORTED, ASSET_EXPORT_FAILED, DECODE_FAILED, TIMESTAMP_OOB, ROI_INVALID, INTERNAL
  stage: string; // "URI", "ASSET", "EXTRACTION"
  recoverable: boolean;
  message?: string;
  details?: Record<string, any>;
}

export type RoiLumaResult =
  | { ok: true; frames: RoiLumaFrame[]; durationMs?: number; nominalFps?: number; diagnostics?: Record<string, any> }
  | { ok: false; error: RoiLumaError; diagnostics?: Record<string, any> };

// ============================================================================
// Native Module Type
// ============================================================================

type NativeRoiLumaExtractor = {
  extractRoiLumaFrames(params: Record<string, any>): Promise<any>;
};

const NativeModule: NativeRoiLumaExtractor | null = NativeModules?.RoiLumaExtractor ?? null;

// ============================================================================
// Validation
// ============================================================================

function validateRoi(roi: RoiSpec): { valid: boolean; error?: string } {
  if (typeof roi.x !== "number" || typeof roi.y !== "number") {
    return { valid: false, error: "ROI x,y must be numbers" };
  }
  if (typeof roi.width !== "number" || typeof roi.height !== "number") {
    return { valid: false, error: "ROI width,height must be numbers" };
  }
  if (roi.width <= 0 || roi.height <= 0) {
    return { valid: false, error: "ROI width,height must be > 0" };
  }
  if (roi.x < 0 || roi.y < 0) {
    return { valid: false, error: "ROI x,y must be >= 0" };
  }
  return { valid: true };
}

function validateTimestamps(timestamps: number[]): { valid: boolean; error?: string } {
  if (!Array.isArray(timestamps)) {
    return { valid: false, error: "timestamps must be an array" };
  }
  if (timestamps.length === 0) {
    return { valid: false, error: "timestamps must not be empty" };
  }
  for (const ts of timestamps) {
    if (typeof ts !== "number" || ts < 0) {
      return { valid: false, error: "All timestamps must be non-negative numbers" };
    }
  }
  return { valid: true };
}

function validateTargetSize(size: SizeSpec | undefined): { valid: boolean; error?: string } {
  if (!size) return { valid: true }; // optional
  if (typeof size.width !== "number" || typeof size.height !== "number") {
    return { valid: false, error: "targetSize width,height must be numbers" };
  }
  if (size.width <= 0 || size.height <= 0) {
    return { valid: false, error: "targetSize must be > 0" };
  }
  return { valid: true };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Extract ROI luma frames from a video at specified timestamps.
 *
 * @param uri - file:// or ph:// URI to video file
 * @param roi - Region of interest {x, y, width, height, space?}
 * @param timestampsMs - Array of timestamps in milliseconds to extract
 * @param targetSize - Optional target size for downsampling (default 96x64)
 * @param options - Optional extraction options
 * @returns Promise with frames or error
 *
 * Example:
 * ```typescript
 * const result = await extractRoiLumaFrames(
 *   'file:///path/to/video.mov',
 *   { x: 100, y: 200, width: 400, height: 300, space: 'pixels' },
 *   [0, 500, 1000, 1500],
 *   { width: 96, height: 64 }
 * );
 *
 * if (result.ok) {
 *   for (const frame of result.frames) {
 *     console.log(`Frame at ${frame.tMs}ms (actual: ${frame.tMsActual}ms)`);
 *     console.log(`Luma size: ${frame.width}x${frame.height}`);
 *     console.log(`Luma data: ${frame.gray.length} bytes`);
 *   }
 * } else {
 *   console.error(`[${result.error.code}] ${result.error.message}`);
 * }
 * ```
 */
export async function extractRoiLumaFrames(
  uri: string,
  roi: RoiSpec,
  timestampsMs: number[],
  targetSize?: SizeSpec,
  options?: ExtractionOptions
): Promise<RoiLumaResult> {
  // Platform check
  if (Platform.OS !== "ios") {
    return {
      ok: false,
      error: {
        code: "PLATFORM_UNSUPPORTED",
        stage: "URI",
        recoverable: false,
        message: "ROI luma extraction is only supported on iOS"
      }
    };
  }

  // Native module check
  if (!NativeModule) {
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        stage: "URI",
        recoverable: false,
        message: "RoiLumaExtractor native module not available"
      }
    };
  }

  // Validate inputs
  const roiValidation = validateRoi(roi);
  if (!roiValidation.valid) {
    return {
      ok: false,
      error: {
        code: "ROI_INVALID",
        stage: "EXTRACTION",
        recoverable: false,
        message: roiValidation.error
      }
    };
  }

  const timestampValidation = validateTimestamps(timestampsMs);
  if (!timestampValidation.valid) {
    return {
      ok: false,
      error: {
        code: "TIMESTAMP_OOB",
        stage: "EXTRACTION",
        recoverable: false,
        message: timestampValidation.error
      }
    };
  }

  const sizeValidation = validateTargetSize(targetSize);
  if (!sizeValidation.valid) {
    return {
      ok: false,
      error: {
        code: "ROI_INVALID",
        stage: "EXTRACTION",
        recoverable: false,
        message: sizeValidation.error
      }
    };
  }

  // Call native module
  try {
    const nativeResult = await NativeModule.extractRoiLumaFrames({
      uri,
      roi,
      timestamps_ms: timestampsMs,
      target_size: targetSize,
      options
    });

    // Decode frames from base64
    if (nativeResult.ok && Array.isArray(nativeResult.frames)) {
      const frames: RoiLumaFrame[] = nativeResult.frames.map((frame: any) => ({
        tMs: frame.tMs,
        tMsActual: frame.tMsActual,
        width: frame.width,
        height: frame.height,
        gray: decodeBase64ToUint8Array(frame.gray)
      }));

      return {
        ok: true,
        frames,
        durationMs: nativeResult.durationMs,
        nominalFps: nativeResult.nominalFps,
        diagnostics: nativeResult.diagnostics
      };
    }

    // Error response
    if (!nativeResult.ok && nativeResult.error) {
      return {
        ok: false,
        error: nativeResult.error,
        diagnostics: nativeResult.diagnostics
      };
    }

    // Unexpected response format
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        stage: "EXTRACTION",
        recoverable: false,
        message: "Unexpected native response format",
        details: nativeResult
      }
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        stage: "EXTRACTION",
        recoverable: false,
        message: `Native call failed: ${error instanceof Error ? error.message : "unknown error"}`,
        details: { error: String(error) }
      }
    };
  }
}

/**
 * Convenience wrapper for extracting a single frame.
 */
export async function extractSingleRoiLumaFrame(
  uri: string,
  roi: RoiSpec,
  timestampMs: number,
  targetSize?: SizeSpec
): Promise<RoiLumaResult> {
  return extractRoiLumaFrames(uri, roi, [timestampMs], targetSize);
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Decode base64 string to Uint8Array.
 */
function decodeBase64ToUint8Array(base64: string): Uint8Array {
  if (typeof global.atob === "function") {
    // Browser/Node environment
    const binaryString = global.atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i += 1) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }

  // Fallback: manual base64 decode
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

  return new Uint8Array(output);
}

/**
 * Compute mean luma intensity (0..255).
 */
export function computeMeanLuma(frame: RoiLumaFrame): number {
  if (frame.gray.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.gray.length; i += 1) {
    sum += frame.gray[i];
  }
  return sum / frame.gray.length;
}

/**
 * Compute luma variance (diagnostic only).
 */
export function computeLumaVariance(frame: RoiLumaFrame): number {
  if (frame.gray.length === 0) return 0;
  const mean = computeMeanLuma(frame);
  let sumSq = 0;
  for (let i = 0; i < frame.gray.length; i += 1) {
    const diff = frame.gray[i] - mean;
    sumSq += diff * diff;
  }
  return sumSq / frame.gray.length;
}

/**
 * Type guard to ensure frames are present.
 */
export function isValidFrameResult(result: RoiLumaResult): result is RoiLumaResult & { ok: true; frames: RoiLumaFrame[] } {
  return result.ok === true && Array.isArray((result as any).frames);
}
