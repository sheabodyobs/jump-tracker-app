// src/analysis/analyzeVideo.ts
import { applyConfidenceGate } from "./confidenceGate";
import { type JumpAnalysis, EMPTY_ANALYSIS } from "./jumpAnalysisContract";
import { analyzePogoSideView } from "./pogoSideViewAnalyzer";
import { MOCK_ANALYSIS } from "./mockAnalysis";

/**
 * analyzeVideo
 *
 * Contract-first implementation.
 * This function MUST always return a JumpAnalysis that conforms
 * to the latest contract (v0.2.0).
 *
 * Current behavior:
 * - Returns a mocked analysis
 * - Runs a hard confidence gate
 *
 * Future behavior:
 * - Decode video
 * - Run pose + foot + ground detection
 * - Populate frames[], groundSummary, and derived metrics
 * - Reuse the same confidence gate unchanged
 */
export async function analyzeVideo(uri: string): Promise<JumpAnalysis> {
  try {
    // Placeholder for real pipeline stages:
    // decodeVideo(uri)
    // → extractFrames
    // → estimatePose
    // → estimateGround
    // → detectContact
    // → deriveMetrics

    let draft: JumpAnalysis;

    try {
      draft = await analyzePogoSideView(uri);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown analyzer error";
      draft = {
        ...MOCK_ANALYSIS,
        status: "complete",
        measurementStatus: "synthetic_placeholder",
        quality: {
          ...MOCK_ANALYSIS.quality,
          notes: [...(MOCK_ANALYSIS.quality?.notes ?? []), `Analyzer fallback: ${message}`],
        },
      };
    }

    // Enforce confidence gate
    // If confidence < threshold, this will downgrade status
    // and zero out unsafe metrics
    return applyConfidenceGate(draft);
  } catch (e: unknown) {
    const message =
      e instanceof Error ? e.message : "unknown error";

    const draft: JumpAnalysis = {
      ...EMPTY_ANALYSIS,
      status: "error",
      measurementStatus: "synthetic_placeholder",
      quality: {
        overallConfidence: 0,
        notes: [`Analyze failed: ${message}`],
        reliability: {
          viewOk: false,
          groundDetected: false,
          jointsTracked: false,
          contactDetected: false,
        },
      },
      aiSummary: {
        text: "Analysis failed unexpectedly. No metrics were produced.",
        tags: ["analysis-error", "pipeline-failure"],
      },
      error: {
        message,
        code: "ANALYZE_VIDEO_FAILED",
      },
    };

    return applyConfidenceGate(draft);
  }
}
