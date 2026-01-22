/**
 * pipelineExample.ts
 * 
 * Example: Run the complete offline jump analysis pipeline on a selected video.
 * Demonstrates:
 * - Video URI → frame extraction
 * - Ground detection → ROI inference → Contact signal → Event extraction
 * - Confidence gating at each stage
 * - Safe metric population (null if any stage fails)
 * - Error handling and diagnostic reporting
 */

import { analyzeVideo } from "./analyzeVideo";
import type { JumpAnalysis } from "./jumpAnalysisContract";

/**
 * Example: Analyze a jump video from a picked URI
 * Usage:
 *   const result = await analyzePickedVideo(selectedVideoUri);
 *   console.log("Status:", result.status);
 *   console.log("Confidence:", result.quality.overallConfidence);
 *   console.log("GCT:", result.metrics.gctSeconds);
 */
export async function analyzePickedVideo(videoUri: string): Promise<JumpAnalysis> {
  console.log("[Pipeline] Starting analysis on:", videoUri);

  try {
    // Call the main entry point which orchestrates the full pipeline:
    // 1. Frame extraction (roiLumaExtractor)
    // 2. Ground detection (groundDetector)
    // 3. ROI inference (roiInference)
    // 4. Contact signal (contactSignal)
    // 5. Event extraction (eventExtractor)
    // 6. Confidence gating at each stage
    const result = await analyzeVideo(videoUri);

    // Log pipeline results
    console.log("[Pipeline] Analysis complete");
    console.log(`  Status: ${result.status}`);
    console.log(`  Measurement: ${result.measurementStatus}`);
    console.log(`  Overall Confidence: ${result.quality.overallConfidence.toFixed(2)}`);

    // Log per-stage confidences
    const pipDebug = result.quality.pipelineDebug;
    if (pipDebug) {
      console.log("[Pipeline] Stage confidences:");
      console.log(`  Ground:  ${pipDebug.groundConfidence?.toFixed(2) ?? "N/A"}`);
      console.log(`  ROI:     ${pipDebug.roiConfidence?.toFixed(2) ?? "N/A"}`);
      console.log(`  Contact: ${pipDebug.contactConfidence?.toFixed(2) ?? "N/A"}`);
      console.log(`  Events:  ${pipDebug.eventConfidence?.toFixed(2) ?? "N/A"}`);
      if (pipDebug.rejectionReasons && pipDebug.rejectionReasons.length > 0) {
        console.log("[Pipeline] Rejection reasons:");
        pipDebug.rejectionReasons.forEach((r) => console.log(`  - ${r}`));
      }
    }

    // Metrics are only populated if status="complete" AND all confidences pass
    if (result.status === "complete" && result.metrics.gctSeconds !== null) {
      console.log("[Pipeline] ✓ Metrics computed successfully");
      console.log(`  GCT: ${result.metrics.gctSeconds.toFixed(3)}s (${result.metrics.gctMs}ms)`);
      console.log(`  Flight: ${result.metrics.flightSeconds?.toFixed(3) ?? "N/A"}s`);
      console.log(`  Events: takeoff=${result.events.takeoff.t?.toFixed(2)}s, landing=${result.events.landing.t?.toFixed(2)}s`);
    } else {
      console.log("[Pipeline] ✗ Metrics redacted (failed confidence gates)");
      if (result.quality.notes.length > 0) {
        console.log("[Pipeline] Notes:");
        result.quality.notes.forEach((n) => console.log(`  - ${n}`));
      }
    }

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[Pipeline] FAILED:", message);

    // Return a safe error result
    return {
      version: "0.2.0",
      status: "error",
      measurementStatus: "synthetic_placeholder",
      metrics: {
        gctSeconds: null,
        gctMs: null,
        flightSeconds: null,
        footAngleDeg: { takeoff: null, landing: null, confidence: 0 },
      },
      events: {
        takeoff: { t: null, frame: null, confidence: 0 },
        landing: { t: null, frame: null, confidence: 0 },
      },
      frames: [],
      groundSummary: { type: "unknown", confidence: 0 },
      quality: {
        overallConfidence: 0,
        notes: [`Pipeline error: ${message}`],
        reliability: {
          viewOk: false,
          groundDetected: false,
          jointsTracked: false,
          contactDetected: false,
        },
        pipelineDebug: {
          groundConfidence: 0,
          roiConfidence: 0,
          contactConfidence: 0,
          eventConfidence: 0,
          rejectionReasons: [message],
        },
      },
      aiSummary: {
        text: "Analysis failed. No metrics available.",
        tags: ["pipeline-error"],
      },
      error: {
        message,
        code: "PIPELINE_ERROR",
      },
    };
  }
}

/**
 * Example: Batch analyze multiple videos with result summary
 */
export async function analyzeBatch(videoUris: string[]): Promise<{
  total: number;
  successful: number;
  failed: number;
  results: JumpAnalysis[];
}> {
  const results: JumpAnalysis[] = [];
  let successful = 0;
  let failed = 0;

  for (const uri of videoUris) {
    try {
      const result = await analyzePickedVideo(uri);
      results.push(result);
      if (result.status === "complete") {
        successful++;
      } else {
        failed++;
      }
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : "Unknown error";
      console.error(`[Batch] Failed on ${uri}: ${msg}`);
    }
  }

  return { total: videoUris.length, successful, failed, results };
}

/**
 * Example: Check if a result passed the confidence pipeline
 */
export function passedPipeline(result: JumpAnalysis): boolean {
  const debug = result.quality.pipelineDebug;
  if (!debug) return false;

  const CONFIDENCE_MIN = 0.25;
  return (
    (debug.groundConfidence ?? 0) >= 0.3 &&
    (debug.roiConfidence ?? 0) >= CONFIDENCE_MIN &&
    (debug.contactConfidence ?? 0) >= CONFIDENCE_MIN &&
    (debug.eventConfidence ?? 0) >= CONFIDENCE_MIN &&
    result.status === "complete" &&
    result.metrics.gctSeconds !== null
  );
}
