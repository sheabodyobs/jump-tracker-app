/**
 * src/video/selfTestExtractRoi.ts
 * 
 * Self-test for offline ROI extraction.
 * Given a video URI, samples multiple timestamps and validates pixel access.
 */

import {
    computeMeanIntensity,
    computeStdDev,
    computeVariance,
    extractRoiGray,
    RoiGrayError,
} from './extractRoiGray';

/**
 * Self-test result from extraction validation.
 */
export interface SelfTestResult {
  success: boolean;
  videoUri: string;
  totalFrames: number;
  videoHeightEstimate: number;
  videoWidthEstimate: number;
  frames: {
    timeMs: number;
    mean: number;
    variance: number;
    stdDev: number;
    histogramPeak: number;
    histogramPeakBucket: number;
    notes: string;
  }[];
  errors: string[];
  notes: string[];
  duration: number;
}

/**
 * Run self-test on a video URI.
 * 
 * Strategy:
 * 1. Assume video is ~720x1280 (portrait)
 * 2. Choose default ROI near bottom-center (foot region): {x:160, y:900, w:400, h:256}
 * 3. Sample 10 timestamps across the video duration
 * 4. Extract grayscale ROI for each (96x64 output)
 * 5. Compute and log mean, variance, histogram
 * 
 * @param videoUri File URI of video to test
 * @param videoDurationMs Approximate video duration in ms (if unknown, use 10000)
 * @returns SelfTestResult with frame statistics
 * 
 * @example
 * const result = await selfTestExtractRoi('file:///path/to/video.mov', 3000);
 * console.log(result);
 */
export async function selfTestExtractRoi(
  videoUri: string,
  videoDurationMs: number = 10000
): Promise<SelfTestResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  const notes: string[] = [];

  // Assume landscape iPhone with typical dimensions
  const estimatedVideoWidth = 1920;
  const estimatedVideoHeight = 1080;

  // Default ROI: near bottom-center, typical foot region
  // Portrait: x ~25% from left, y ~70% down, w ~50%, h ~25%
  const roi = {
    x: Math.floor(estimatedVideoWidth * 0.25),
    y: Math.floor(estimatedVideoHeight * 0.65),
    w: Math.floor(estimatedVideoWidth * 0.5),
    h: Math.floor(estimatedVideoHeight * 0.3),
  };

  const outputSize = { w: 96, h: 64 };
  const numSamples = 10;
  const frames: SelfTestResult['frames'] = [];

  // Sample timestamps: uniformly spaced across duration
  const timestamps = Array.from({ length: numSamples }, (_, i) =>
    Math.floor((i / (numSamples - 1)) * videoDurationMs)
  );

  console.log('[selfTestExtractRoi] Starting test');
  console.log(`  Video URI: ${videoUri}`);
  console.log(`  Duration: ${videoDurationMs}ms`);
  console.log(`  ROI: x=${roi.x} y=${roi.y} w=${roi.w} h=${roi.h}`);
  console.log(`  Output: ${outputSize.w}x${outputSize.h}`);
  console.log(`  Sampling ${numSamples} timestamps...`);

  for (const timeMs of timestamps) {
    try {
      const frame = await extractRoiGray(
        videoUri,
        timeMs,
        roi.x,
        roi.y,
        roi.w,
        roi.h,
        outputSize.w,
        outputSize.h
      );

      const mean = computeMeanIntensity(frame.gray);
      const variance = computeVariance(frame.gray);
      const stdDev = computeStdDev(frame.gray);

      // Compute histogram peak
      const histogram = new Array(256).fill(0);
      for (const val of frame.gray) {
        histogram[val]++;
      }
      const histogramPeak = Math.max(...histogram);
      const histogramPeakBucket = histogram.indexOf(histogramPeak);

      const frameResult = {
        timeMs: frame.tMs,
        mean,
        variance,
        stdDev,
        histogramPeak,
        histogramPeakBucket,
        notes: '',
      };

      // Annotate if variance is suspicious
      if (variance < 10) {
        frameResult.notes += 'Low variance (likely flat/solid color); ';
      }
      if (variance > 5000) {
        frameResult.notes += 'High variance (complex texture); ';
      }
      if (mean < 50) {
        frameResult.notes += 'Dark frame; ';
      }
      if (mean > 200) {
        frameResult.notes += 'Bright frame; ';
      }

      frames.push(frameResult);

      console.log(`  [${timeMs}ms] mean=${mean.toFixed(1)} var=${variance.toFixed(0)} stdDev=${stdDev.toFixed(1)}`);
    } catch (error: any) {
      const errorMsg = (error as RoiGrayError).message || String(error);
      errors.push(`${timeMs}ms: ${errorMsg}`);
      console.error(`  [${timeMs}ms] FAILED: ${errorMsg}`);
    }
  }

  const duration = Date.now() - startTime;

  // Validation checks
  if (errors.length === frames.length) {
    notes.push('All extractions failed; native module may not be available or video URI is invalid.');
  } else if (errors.length > 0) {
    notes.push(`${errors.length} / ${numSamples} samples failed.`);
  }

  // Check if intensity changes over time (indicates video is playing, not frozen)
  if (frames.length >= 2) {
    const means = frames.map((f) => f.mean);
    const meanVariance = computeVariance(new Uint8Array(means.map((m) => Math.round(m))));
    if (meanVariance < 1) {
      notes.push('Mean intensity is constant across frames; video may be frozen or ROI has no detail.');
    } else {
      notes.push(`Mean intensity varies across frames (variance=${meanVariance.toFixed(1)}); pixel access is working.`);
    }
  }

  const success = errors.length < numSamples;

  return {
    success,
    videoUri,
    totalFrames: frames.length,
    videoHeightEstimate: estimatedVideoHeight,
    videoWidthEstimate: estimatedVideoWidth,
    frames,
    errors,
    notes,
    duration,
  };
}

/**
 * Pretty-print self-test result.
 */
export function formatSelfTestResult(result: SelfTestResult): string {
  const lines: string[] = [];

  lines.push(`═══════════════════════════════════════════════════════════`);
  lines.push(`[selfTestExtractRoi] ${result.success ? '✓ PASS' : '✗ FAIL'}`);
  lines.push(`───────────────────────────────────────────────────────────`);
  lines.push(`Video: ${result.videoUri}`);
  lines.push(`Extracted frames: ${result.totalFrames} / ${result.frames.length + result.errors.length}`);
  lines.push(`Duration: ${result.duration}ms`);
  lines.push(``);

  if (result.frames.length > 0) {
    lines.push(`Frame Statistics:`);
    lines.push(`  Time (ms) │ Mean │ Variance │ StdDev │ Peak │ Notes`);
    lines.push(`  ──────────┼──────┼──────────┼────────┼──────┼────────────────────────`);
    for (const frame of result.frames) {
      const timeStr = String(frame.timeMs).padStart(9);
      const meanStr = frame.mean.toFixed(1).padStart(5);
      const varStr = frame.variance.toFixed(0).padStart(8);
      const stdStr = frame.stdDev.toFixed(1).padStart(6);
      const peakStr = String(frame.histogramPeakBucket).padStart(4);
      const notes = frame.notes || '(ok)';
      lines.push(`  ${timeStr} │ ${meanStr} │ ${varStr} │ ${stdStr} │ ${peakStr} │ ${notes}`);
    }
  }

  if (result.errors.length > 0) {
    lines.push(``);
    lines.push(`Errors:`);
    for (const error of result.errors) {
      lines.push(`  • ${error}`);
    }
  }

  if (result.notes.length > 0) {
    lines.push(``);
    lines.push(`Notes:`);
    for (const note of result.notes) {
      lines.push(`  • ${note}`);
    }
  }

  lines.push(`═══════════════════════════════════════════════════════════`);

  return lines.join('\n');
}
