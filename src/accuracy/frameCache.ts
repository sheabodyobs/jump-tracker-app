/**
 * Frame Cache Encoder/Loader
 *
 * Lightweight binary format for storing pre-extracted frames from video.
 * Enables deterministic offline analysis without device-side extraction.
 *
 * Format:
 *   frames.json: { width, height, tMsActual[], roiUsed, frameOffsets }
 *   gray.bin: Concatenated grayscale frame data (width*height bytes per frame)
 */

import * as fs from 'fs';
import * as path from 'path';

export interface FrameCacheMetadata {
  width: number;
  height: number;
  tMsActual: number[]; // timestamp in ms for each frame
  roiUsed: { x: number; y: number; width: number; height: number } | null;
  frameOffsets: number[]; // byte offset for each frame in gray.bin
}

export interface CachedFrame {
  pixels: Uint8Array; // width * height bytes (grayscale)
  tMs: number;
}

/**
 * Encode frames to cache format
 *
 * @param caseId - Golden test case ID (e.g., "pogo_tripod_good_01")
 * @param frames - Array of frames with pixels and timestamp
 * @param roi - ROI used for extraction (optional)
 * @throws If frames are empty or have inconsistent dimensions
 */
export function encodeFramesToCache(
  caseId: string,
  frames: Array<{ pixels: Uint8Array; tMs: number; width: number; height: number }>,
  roi?: { x: number; y: number; width: number; height: number }
): void {
  if (!frames || frames.length === 0) {
    throw new Error('No frames to encode');
  }

  const firstFrame = frames[0];
  const { width, height } = firstFrame;

  // Validate all frames have same dimensions
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].width !== width || frames[i].height !== height) {
      throw new Error(
        `Frame ${i} has dimensions ${frames[i].width}x${frames[i].height}, ` +
          `expected ${width}x${height}`
      );
    }
    if (frames[i].pixels.byteLength !== width * height) {
      throw new Error(
        `Frame ${i} pixel data is ${frames[i].pixels.byteLength} bytes, ` +
          `expected ${width * height}`
      );
    }
  }

  // Create case directory
  const caseDir = path.join(process.cwd(), 'datasets', 'gct-golden', 'cases', caseId);
  fs.mkdirSync(caseDir, { recursive: true });

  // Build binary data and offset table
  const chunks: Buffer[] = [];
  const frameOffsets: number[] = [];
  let offset = 0;

  for (const frame of frames) {
    frameOffsets.push(offset);
    const buffer = Buffer.from(frame.pixels);
    chunks.push(buffer);
    offset += buffer.byteLength;
  }

  // Write gray.bin (concatenated frames)
  const grayBinPath = path.join(caseDir, 'gray.bin');
  const combinedBuffer = Buffer.concat(chunks);
  fs.writeFileSync(grayBinPath, combinedBuffer);

  // Write frames.json (metadata)
  const metadata: FrameCacheMetadata = {
    width,
    height,
    tMsActual: frames.map((f) => f.tMs),
    roiUsed: roi || null,
    frameOffsets,
  };

  const framesJsonPath = path.join(caseDir, 'frames.json');
  fs.writeFileSync(framesJsonPath, JSON.stringify(metadata, null, 2));
}

/**
 * Load frames from cache
 *
 * @param caseId - Golden test case ID
 * @param caseBaseDir - Base directory for golden dataset (defaults to datasets/gct-golden)
 * @returns Array of cached frames with timestamps, or null if cache doesn't exist
 */
export function loadFramesFromCache(
  caseId: string,
  caseBaseDir: string = path.join(process.cwd(), 'datasets', 'gct-golden')
): CachedFrame[] | null {
  const caseDir = path.join(caseBaseDir, 'cases', caseId);

  // Check if cache exists
  const framesJsonPath = path.join(caseDir, 'frames.json');
  const grayBinPath = path.join(caseDir, 'gray.bin');

  if (!fs.existsSync(framesJsonPath) || !fs.existsSync(grayBinPath)) {
    return null;
  }

  try {
    // Load metadata
    const metadataJson = fs.readFileSync(framesJsonPath, 'utf-8');
    const metadata: FrameCacheMetadata = JSON.parse(metadataJson);

    // Load binary data
    const grayBinData = fs.readFileSync(grayBinPath);

    // Reconstruct frames
    const frames: CachedFrame[] = [];
    const frameSize = metadata.width * metadata.height;

    for (let i = 0; i < metadata.tMsActual.length; i++) {
      const offset = metadata.frameOffsets[i];
      const nextOffset = i + 1 < metadata.frameOffsets.length ? metadata.frameOffsets[i + 1] : grayBinData.byteLength;

      // Extract frame pixels
      const frameData = grayBinData.slice(offset, nextOffset);
      if (frameData.byteLength !== frameSize) {
        throw new Error(
          `Frame ${i} has ${frameData.byteLength} bytes, expected ${frameSize}`
        );
      }

      frames.push({
        pixels: new Uint8Array(frameData),
        tMs: metadata.tMsActual[i],
      });
    }

    return frames;
  } catch (error) {
    throw new Error(
      `Failed to load frame cache for case "${caseId}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Check if frame cache exists for a case
 *
 * @param caseId - Golden test case ID
 * @param caseBaseDir - Base directory for golden dataset
 * @returns true if both frames.json and gray.bin exist
 */
export function cacheExists(
  caseId: string,
  caseBaseDir: string = path.join(process.cwd(), 'datasets', 'gct-golden')
): boolean {
  const caseDir = path.join(caseBaseDir, 'cases', caseId);
  const framesJsonPath = path.join(caseDir, 'frames.json');
  const grayBinPath = path.join(caseDir, 'gray.bin');

  return fs.existsSync(framesJsonPath) && fs.existsSync(grayBinPath);
}

/**
 * Get cache metadata without loading full frame data
 *
 * @param caseId - Golden test case ID
 * @param caseBaseDir - Base directory for golden dataset
 * @returns Metadata only, or null if cache doesn't exist
 */
export function getCacheMetadata(
  caseId: string,
  caseBaseDir: string = path.join(process.cwd(), 'datasets', 'gct-golden')
): FrameCacheMetadata | null {
  const caseDir = path.join(caseBaseDir, 'cases', caseId);
  const framesJsonPath = path.join(caseDir, 'frames.json');

  if (!fs.existsSync(framesJsonPath)) {
    return null;
  }

  try {
    const metadataJson = fs.readFileSync(framesJsonPath, 'utf-8');
    return JSON.parse(metadataJson) as FrameCacheMetadata;
  } catch (error) {
    throw new Error(
      `Failed to load cache metadata for case "${caseId}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Delete cache for a case (cleanup)
 *
 * @param caseId - Golden test case ID
 * @param caseBaseDir - Base directory for golden dataset
 */
export function deleteCache(
  caseId: string,
  caseBaseDir: string = path.join(process.cwd(), 'datasets', 'gct-golden')
): void {
  const caseDir = path.join(caseBaseDir, 'cases', caseId);

  if (fs.existsSync(caseDir)) {
    fs.rmSync(caseDir, { recursive: true });
  }
}
