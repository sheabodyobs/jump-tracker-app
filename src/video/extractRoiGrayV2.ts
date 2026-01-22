/**
 * src/video/extractRoiGrayV2.ts
 *
 * Instrument-grade offline ROI extraction wrapper.
 * Specs:
 * - Deterministic downsampling (floor for aspect, ceiling for fixed_step)
 * - Y-plane luma via CGContext grayscale rendering
 * - Batch extraction to minimize JS bridge overhead
 * - Structured error taxonomy (ok: bool, error: { code, stage, recoverable, ... })
 * - ph:// workaround with temp export + cleanup
 */

import { NativeModules } from 'react-native';

const { RoiGrayExtractorV2 } = NativeModules;

// MARK: - Type Definitions

/**
 * Requested frame timestamp + actual decoded time.
 */
export interface RoiGrayFrameV2 {
  /** Requested timestamp in milliseconds */
  tMs: number;
  /** Actual decoded frame timestamp (snapped to frame boundary), in milliseconds */
  tMsActual: number;
  /** Final downsampled width */
  width: number;
  /** Final downsampled height */
  height: number;
  /** Luma bytes: length = width * height, values 0..255 */
  gray: Uint8Array;
}

/**
 * Downsampling strategy.
 * - "target_aspect": fit ROI into target size while preserving aspect ratio (floor rounding)
 * - "fixed_step": divide ROI by constant step factors (ceiling division)
 */
export type DownsampleRule = 'target_aspect' | 'fixed_step';

/**
 * Downsampling parameters.
 */
export interface DownsampleConfig {
  /** Target output width/height (used for target_aspect rule). Default: 96x64. */
  targetSize?: { width: number; height: number };
  /** Downsampling rule. Default: "target_aspect". */
  rule?: DownsampleRule;
  /** Step factor for X (fixed_step rule). Default: 4. */
  fixedStepX?: number;
  /** Step factor for Y (fixed_step rule). Default: 4. */
  fixedStepY?: number;
}

/**
 * ROI specification in pixel coordinates.
 */
export interface RoiPixels {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Error details in structured form.
 */
export interface RoiGrayErrorV2 {
  /** Error code: USER_CANCELLED | PERMISSION_DENIED | URI_UNSUPPORTED | ASSET_EXPORT_FAILED
   *              | DECODE_FAILED | TIMESTAMP_OOB | ROI_INVALID | INTERNAL */
  code: string;
  /** Processing stage where error occurred */
  stage: string;
  /** Whether error is recoverable (e.g., retry might succeed) */
  recoverable: boolean;
  /** Human-readable message */
  message: string;
  /** Additional diagnostic details */
  details?: Record<string, string>;
}

/**
 * Result from batch extraction: either ok with frames, or error.
 */
export interface ExtractBatchResult {
  ok: boolean;
  frames?: RoiGrayFrameV2[];
  error?: RoiGrayErrorV2;
}

// MARK: - Public API

/**
 * Extract downsampled grayscale ROI frames from a video file.
 *
 * ROI-only extraction: never decodes or returns full-frame pixels.
 * Downsampling is deterministic based on rule and rounding strategy.
 * Luma is computed via CGContext grayscale rendering (BT.601 equivalent).
 *
 * @param uri Video file URI (file:// or ph://)
 * @param roi ROI bounds in pixel coordinates
 * @param timestampsMs Array of requested frame timestamps in milliseconds
 * @param downsample Downsampling configuration (optional)
 *
 * @returns ExtractBatchResult with ok flag and frames or error
 *
 * @example
 * const result = await extractBatchGrayV2(
 *   'file:///path/to/video.mov',
 *   { x: 200, y: 400, width: 400, height: 300 },
 *   [0, 500, 1000, 1500],
 *   { rule: 'target_aspect', targetSize: { width: 96, height: 64 } }
 * );
 *
 * if (result.ok) {
 *   for (const frame of result.frames!) {
 *     console.log(`Frame at ${frame.tMsActual}ms: ${frame.width}x${frame.height}`);
 *     // frame.gray is Uint8Array of luma bytes
 *   }
 * } else {
 *   console.error(`[${result.error!.code}] ${result.error!.message}`);
 * }
 */
export async function extractBatchGrayV2(
  uri: string,
  roi: RoiPixels,
  timestampsMs: number[],
  downsample?: DownsampleConfig
): Promise<ExtractBatchResult> {
  if (!RoiGrayExtractorV2) {
    return {
      ok: false,
      error: {
        code: 'INTERNAL',
        stage: 'module_load',
        recoverable: false,
        message: 'RoiGrayExtractorV2 native module not found',
        details: {},
      },
    };
  }

  // Validate inputs
  if (!uri) {
    return {
      ok: false,
      error: {
        code: 'URI_UNSUPPORTED',
        stage: 'uri_resolve',
        recoverable: false,
        message: 'URI must be non-empty',
        details: { uri },
      },
    };
  }

  if (roi.width <= 0 || roi.height <= 0) {
    return {
      ok: false,
      error: {
        code: 'ROI_INVALID',
        stage: 'roi_validate',
        recoverable: false,
        message: 'ROI width and height must be positive',
        details: { roiW: String(roi.width), roiH: String(roi.height) },
      },
    };
  }

  if (timestampsMs.length === 0) {
    return {
      ok: false,
      error: {
        code: 'INTERNAL',
        stage: 'param_validate',
        recoverable: false,
        message: 'timestampsMs must not be empty',
        details: {},
      },
    };
  }

  const dsConfig = downsample || {};
  const rule = dsConfig.rule ?? 'target_aspect';
  const targetW = dsConfig.targetSize?.width ?? 96;
  const targetH = dsConfig.targetSize?.height ?? 64;

  try {
    const nativeResult = await RoiGrayExtractorV2.extractBatch(
      uri,
      roi.x,
      roi.y,
      roi.width,
      roi.height,
      timestampsMs,
      targetW,
      targetH,
      rule,
      dsConfig.fixedStepX,
      dsConfig.fixedStepY
    );

    if (!nativeResult.ok) {
      return {
        ok: false,
        error: nativeResult.error,
      };
    }

    // Decode base64 gray buffers to Uint8Array
    const frames = nativeResult.frames.map((frame: any) => ({
      tMs: frame.tMs,
      tMsActual: frame.tMsActual,
      width: frame.width,
      height: frame.height,
      gray: decodeBase64ToUint8Array(frame.gray),
    }));

    return {
      ok: true,
      frames,
    };
  } catch (error: any) {
    const message = error.message ?? String(error);
    const code = error.code ?? 'INTERNAL';

    return {
      ok: false,
      error: {
        code,
        stage: 'native_call',
        recoverable: false,
        message,
        details: error.userInfo ?? {},
      },
    };
  }
}

/**
 * Extract a single frame at a requested timestamp.
 * Convenience wrapper around extractBatchGrayV2.
 *
 * @param uri Video file URI
 * @param roi ROI bounds
 * @param timeMs Requested timestamp in milliseconds
 * @param downsample Downsampling configuration
 *
 * @returns Frame or error
 */
export async function extractSingleGrayV2(
  uri: string,
  roi: RoiPixels,
  timeMs: number,
  downsample?: DownsampleConfig
): Promise<RoiGrayFrameV2 | RoiGrayErrorV2 | null> {
  const result = await extractBatchGrayV2(uri, roi, [timeMs], downsample);

  if (!result.ok) {
    return result.error || null;
  }

  return result.frames?.[0] ?? null;
}

// MARK: - Utilities

/**
 * Decode base64 string to Uint8Array.
 * Used internally to convert native base64 output to typed array.
 */
function decodeBase64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Compute expected output dimensions given ROI and downsample rule.
 * Useful for pre-allocation or validation.
 *
 * @param roiW ROI width
 * @param roiH ROI height
 * @param rule Downsample rule
 * @param config Optional downsampling config
 *
 * @returns { width, height } or null if invalid
 */
export function computeOutputDims(
  roiW: number,
  roiH: number,
  rule: DownsampleRule = 'target_aspect',
  config?: DownsampleConfig
): { width: number; height: number } | null {
  if (roiW <= 0 || roiH <= 0) {
    return null;
  }

  if (rule === 'target_aspect') {
    const targetW = config?.targetSize?.width ?? 96;
    const targetH = config?.targetSize?.height ?? 64;

    const scaleX = targetW / roiW;
    const scaleY = targetH / roiH;
    const scale = Math.min(scaleX, scaleY);

    const outW = Math.floor(roiW * scale);
    const outH = Math.floor(roiH * scale);

    return {
      width: Math.max(1, outW),
      height: Math.max(1, outH),
    };
  } else if (rule === 'fixed_step') {
    const sx = config?.fixedStepX ?? 4;
    const sy = config?.fixedStepY ?? 4;

    if (sx <= 0 || sy <= 0) {
      return null;
    }

    const outW = Math.ceil(roiW / sx);
    const outH = Math.ceil(roiH / sy);

    return { width: outW, height: outH };
  }

  return null;
}

/**
 * Compute mean intensity from grayscale bytes.
 * Useful for validation and diagnostics.
 */
export function computeMeanIntensityV2(gray: Uint8Array): number {
  if (gray.length === 0) return 0;
  const sum = Array.from(gray).reduce((a, b) => a + b, 0);
  return sum / gray.length;
}

/**
 * Compute variance of intensity.
 */
export function computeVarianceV2(gray: Uint8Array): number {
  if (gray.length === 0) return 0;
  const mean = computeMeanIntensityV2(gray);
  const sumSqDiff = Array.from(gray).reduce((sum, val) => {
    const diff = val - mean;
    return sum + diff * diff;
  }, 0);
  return sumSqDiff / gray.length;
}

/**
 * Check if extraction result contains valid frames (ok + frames).
 * Use before rendering or processing metrics.
 */
export function isValidExtractResult(result: ExtractBatchResult): result is ExtractBatchResult & { frames: RoiGrayFrameV2[] } {
  return result.ok && Array.isArray(result.frames) && result.frames.length > 0;
}
