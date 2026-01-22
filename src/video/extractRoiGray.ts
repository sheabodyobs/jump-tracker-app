/**
 * src/video/extractRoiGray.ts
 * 
 * JavaScript wrapper for native iOS ROI grayscale extraction.
 * Converts base64 bytes to Uint8Array and provides typed result.
 */

import { NativeModules } from 'react-native';

const { RoiGrayExtractor } = NativeModules;

/**
 * ROI grayscale frame data from native extractor.
 */
export interface RoiGrayFrame {
  /** Actual extraction time in milliseconds (may differ from requested) */
  tMs: number;
  /** Output width (pixels) */
  width: number;
  /** Output height (pixels) */
  height: number;
  /** Grayscale bytes (8-bit, value 0..255) */
  gray: Uint8Array;
  /** Source file URI for reference */
  uri?: string;
}

/**
 * Error result when extraction fails.
 */
export interface RoiGrayError {
  code: string;
  message: string;
}

/**
 * Extract grayscale ROI bytes from a video file at a specific timestamp.
 * 
 * @param uri Video file URI (file:// supported; ph:// not yet supported)
 * @param timeMs Requested timestamp in milliseconds
 * @param roiX ROI origin x (pixels)
 * @param roiY ROI origin y (pixels)
 * @param roiW ROI width (pixels)
 * @param roiH ROI height (pixels)
 * @param outW Output width (default 96 for 384px → 96px = 4:1 downsample)
 * @param outH Output height (default 64 for 256px → 64px = 4:1 downsample)
 * 
 * @returns RoiGrayFrame with decoded bytes, or throws error
 * @throws RoiGrayError if extraction fails
 * 
 * @example
 * const frame = await extractRoiGray(
 *   'file:///var/mobile/Containers/Data/Application/.../video.mov',
 *   1500, // 1.5 seconds
 *   { x: 200, y: 400, w: 400, h: 300 }, // ROI near bottom-center
 *   { w: 96, h: 64 } // Output size
 * );
 * console.log('Mean intensity:', computeMean(frame.gray));
 */
export async function extractRoiGray(
  uri: string,
  timeMs: number,
  roiX: number,
  roiY: number,
  roiW: number,
  roiH: number,
  outW: number = 96,
  outH: number = 64
): Promise<RoiGrayFrame> {
  if (!RoiGrayExtractor) {
    throw {
      code: 'NATIVE_MODULE_NOT_FOUND',
      message: 'RoiGrayExtractor native module not available; ensure iOS build includes the module',
    } as RoiGrayError;
  }

  try {
    const result = await RoiGrayExtractor.extractRoiGray(
      uri,
      timeMs,
      roiX,
      roiY,
      roiW,
      roiH,
      outW,
      outH
    );

    // Decode base64 to Uint8Array
    const binaryString = atob(result.bytesBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    return {
      tMs: result.actualTimeMs,
      width: result.width,
      height: result.height,
      gray: bytes,
      uri,
    };
  } catch (error: any) {
    throw {
      code: error.code || 'UNKNOWN_ERROR',
      message: error.message || String(error),
    } as RoiGrayError;
  }
}

/**
 * Compute mean intensity from grayscale bytes.
 */
export function computeMeanIntensity(gray: Uint8Array): number {
  if (gray.length === 0) return 0;
  const sum = Array.from(gray).reduce((a, b) => a + b, 0);
  return sum / gray.length;
}

/**
 * Compute variance of intensity.
 */
export function computeVariance(gray: Uint8Array): number {
  if (gray.length === 0) return 0;
  const mean = computeMeanIntensity(gray);
  const sumSqDiff = Array.from(gray).reduce((sum, val) => {
    const diff = val - mean;
    return sum + diff * diff;
  }, 0);
  return sumSqDiff / gray.length;
}

/**
 * Compute standard deviation of intensity.
 */
export function computeStdDev(gray: Uint8Array): number {
  return Math.sqrt(computeVariance(gray));
}

/**
 * Compute histogram (256-bin, value 0..255).
 */
export function computeHistogram(gray: Uint8Array): number[] {
  const hist = new Array(256).fill(0);
  for (const val of gray) {
    hist[val]++;
  }
  return hist;
}
