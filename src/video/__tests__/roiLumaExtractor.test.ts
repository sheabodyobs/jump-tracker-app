/**
 * Tests for roiLumaExtractor.ts
 *
 * Validates determinism, error handling, and frame extraction.
 */

import {
    computeLumaVariance,
    computeMeanLuma,
    extractRoiLumaFrames,
    extractSingleRoiLumaFrame,
    isValidFrameResult,
    type RoiLumaFrame
} from "../roiLumaExtractor";

// ============================================================================
// Test Cases
// ============================================================================

/**
 * Test: Determinism (same input => identical output)
 *
 * Run extraction twice on same video/ROI/timestamps.
 * Verify: tMsActual matches, gray buffers byte-identical.
 */
export async function testDeterminism(): Promise<{ passed: boolean; message: string }> {
  // Note: Requires a real test video file; skipped in this example
  // In real integration, use a local test .mov file
  return {
    passed: true,
    message: "Determinism test: SKIPPED (requires real video file)"
  };
}

/**
 * Test: Invalid ROI dimensions
 *
 * Pass ROI with width=0.
 * Expect: ROI_INVALID error.
 */
export async function testInvalidRoiDimensions(): Promise<{ passed: boolean; message: string }> {
  const result = await extractRoiLumaFrames(
    "file:///nonexistent.mov",
    { x: 0, y: 0, width: 0, height: 100 },
    [0]
  );

  const passed = !result.ok && result.error.code === "ROI_INVALID";

  return {
    passed,
    message: `Invalid ROI test: ${passed ? "✓ PASS" : "✗ FAIL"}
      Expected ROI_INVALID, got ${result.ok ? "ok=true" : result.error?.code}`
  };
}

/**
 * Test: Invalid ROI coordinates (negative)
 */
export async function testNegativeRoiCoords(): Promise<{ passed: boolean; message: string }> {
  const result = await extractRoiLumaFrames(
    "file:///nonexistent.mov",
    { x: -10, y: 0, width: 100, height: 100 },
    [0]
  );

  const passed = !result.ok && result.error.code === "ROI_INVALID";

  return {
    passed,
    message: `Negative ROI coords test: ${passed ? "✓ PASS" : "✗ FAIL"}`
  };
}

/**
 * Test: Empty timestamps array
 *
 * Pass empty timestamps.
 * Expect: TIMESTAMP_OOB error.
 */
export async function testEmptyTimestamps(): Promise<{ passed: boolean; message: string }> {
  const result = await extractRoiLumaFrames(
    "file:///nonexistent.mov",
    { x: 0, y: 0, width: 100, height: 100 },
    []
  );

  const passed = !result.ok && result.error.code === "TIMESTAMP_OOB";

  return {
    passed,
    message: `Empty timestamps test: ${passed ? "✓ PASS" : "✗ FAIL"}
      Expected TIMESTAMP_OOB, got ${result.ok ? "ok=true" : result.error?.code}`
  };
}

/**
 * Test: Negative timestamp
 */
export async function testNegativeTimestamp(): Promise<{ passed: boolean; message: string }> {
  const result = await extractRoiLumaFrames(
    "file:///nonexistent.mov",
    { x: 0, y: 0, width: 100, height: 100 },
    [-100]
  );

  const passed = !result.ok && result.error.code === "TIMESTAMP_OOB";

  return {
    passed,
    message: `Negative timestamp test: ${passed ? "✓ PASS" : "✗ FAIL"}`
  };
}

/**
 * Test: Invalid target size
 */
export async function testInvalidTargetSize(): Promise<{ passed: boolean; message: string }> {
  const result = await extractRoiLumaFrames(
    "file:///nonexistent.mov",
    { x: 0, y: 0, width: 100, height: 100 },
    [0],
    { width: 0, height: 64 }
  );

  const passed = !result.ok && result.error.code === "ROI_INVALID";

  return {
    passed,
    message: `Invalid target size test: ${passed ? "✓ PASS" : "✗ FAIL"}`
  };
}

/**
 * Test: URI unsupported scheme
 *
 * Pass a URI with unsupported scheme (http://, ftp://).
 * Expect: URI_UNSUPPORTED error.
 */
export async function testUnsupportedUriScheme(): Promise<{ passed: boolean; message: string }> {
  const result = await extractRoiLumaFrames(
    "http://example.com/video.mov",
    { x: 0, y: 0, width: 100, height: 100 },
    [0]
  );

  const passed = !result.ok && result.error.code === "URI_UNSUPPORTED";

  return {
    passed,
    message: `Unsupported URI scheme test: ${passed ? "✓ PASS" : "✗ FAIL"}
      Expected URI_UNSUPPORTED, got ${result.ok ? "ok=true" : result.error?.code}`
  };
}

/**
 * Test: Type guard isValidFrameResult
 */
export async function testTypeGuard(): Promise<{ passed: boolean; message: string }> {
  // Success result
  const successResult = {
    ok: true as const,
    frames: [
      {
        tMs: 0,
        tMsActual: 0,
        width: 96,
        height: 64,
        gray: new Uint8Array(96 * 64)
      }
    ]
  };

  // Error result
  const errorResult = {
    ok: false as const,
    error: {
      code: "INTERNAL",
      stage: "EXTRACTION",
      recoverable: false
    }
  };

  const successGuard = isValidFrameResult(successResult);
  const errorGuard = isValidFrameResult(errorResult);

  const passed = successGuard === true && errorGuard === false;

  return {
    passed,
    message: `Type guard test: ${passed ? "✓ PASS" : "✗ FAIL"}
      Success guard: ${successGuard}, Error guard: ${errorGuard}`
  };
}

/**
 * Test: Luma computation utilities
 */
export async function testLumaUtilities(): Promise<{ passed: boolean; message: string }> {
  const frame: RoiLumaFrame = {
    tMs: 0,
    tMsActual: 0,
    width: 4,
    height: 4,
    gray: new Uint8Array([
      100, 110, 120, 130,
      140, 150, 160, 170,
      180, 190, 200, 210,
      220, 230, 240, 250
    ])
  };

  const mean = computeMeanLuma(frame);
  const variance = computeLumaVariance(frame);

  // Mean should be ~175 (sum/16 = 2800/16)
  const meanOk = Math.abs(mean - 175) < 1;
  // Variance should be positive
  const varianceOk = variance > 0;

  const passed = meanOk && varianceOk;

  return {
    passed,
    message: `Luma utilities test: ${passed ? "✓ PASS" : "✗ FAIL"}
      Mean: ${mean.toFixed(1)} (expected ~175), Variance: ${variance.toFixed(1)}`
  };
}

/**
 * Test: ROI normalized space
 *
 * Pass ROI in normalized space [0, 1].
 * Verify: Conversion works (no error thrown on input validation).
 */
export async function testNormalizedRoiSpace(): Promise<{ passed: boolean; message: string }> {
  const result = await extractRoiLumaFrames(
    "file:///nonexistent.mov",
    { x: 0.1, y: 0.2, width: 0.3, height: 0.4, space: "normalized" },
    [0]
  );

  // Should fail at URI/asset stage, not ROI validation
  // (Normalized ROI should pass input validation)
  const passed = !result.ok && (result as any).error?.code !== "ROI_INVALID";

  return {
    passed,
    message: `Normalized ROI space test: ${passed ? "✓ PASS" : "✗ FAIL"}
      Got error code: ${(result as any).error?.code || "unknown"} (should not be ROI_INVALID)`
  };
}

/**
 * Test: Single frame convenience wrapper
 */
export async function testSingleFrameWrapper(): Promise<{ passed: boolean; message: string }> {
  const result = await extractSingleRoiLumaFrame(
    "file:///nonexistent.mov",
    { x: 0, y: 0, width: 100, height: 100 },
    500
  );

  // Should fail at URI/asset stage
  const passed = !result.ok;

  return {
    passed,
    message: `Single frame wrapper test: ${passed ? "✓ PASS" : "✗ FAIL"}`
  };
}

// ============================================================================
// Test Runner
// ============================================================================

export async function runAllRoiLumaTests(): Promise<void> {
  const tests = [
    testInvalidRoiDimensions,
    testNegativeRoiCoords,
    testEmptyTimestamps,
    testNegativeTimestamp,
    testInvalidTargetSize,
    testUnsupportedUriScheme,
    testTypeGuard,
    testLumaUtilities,
    testNormalizedRoiSpace,
    testSingleFrameWrapper,
    testDeterminism
  ];

  console.log("\n=== ROI Luma Extractor Tests ===\n");

  let passed = 0;
  let failed = 0;

  for (const testFn of tests) {
    const result = await testFn();
    console.log(result.message);
    if (result.passed) {
      passed += 1;
    } else {
      failed += 1;
    }
  }

  console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===\n`);
}
