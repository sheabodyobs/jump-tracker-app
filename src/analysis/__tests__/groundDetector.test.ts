/**
 * Tests for groundDetector.ts
 *
 * Deterministic synthetic frame tests for camera-invariant ground detection.
 * All tests use seeded frame generation for reproducibility.
 */

import { detectGround, inferRoiFromGround, pointToLineDistance } from "../groundDetector";

// ============================================================================
// Synthetic Frame Generators (Deterministic)
// ============================================================================

/**
 * Generate a horizontal ground line with a moving foot blob above it.
 * Simulates a typical side-view vertical jump scenario.
 */
function generateHorizontalGroundFrames(
  frameCount: number = 30
): Array<{ data: Uint8ClampedArray; width: number; height: number; tMs: number }> {
  const width = 160;
  const height = 120;
  const groundY = Math.floor(height * 0.7); // Ground at 70% down
  const frames = [];

  // Foot trajectory: starts on ground, lifts up, comes back down
  const footTrajectory = [
    ...Array(8).fill(groundY), // frames 0-7: on ground
    ...Array.from({ length: 10 }, (_, i) => groundY - 5 - i * 3), // frames 8-17: liftoff
    ...Array.from({ length: 7 }, (_, i) => groundY - 35 + i * 4), // frames 18-24: landing
    ...Array(6).fill(groundY), // frames 25-30: on ground
  ].slice(0, frameCount);

  for (let f = 0; f < frameCount; f += 1) {
    const data = new Uint8ClampedArray(width * height);
    const footY = footTrajectory[f];

    // Fill frame: dark background, bright ground line, moving foot blob
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const idx = y * width + x;

        if (y === groundY) {
          // Ground line: bright
          data[idx] = 200;
        } else if (y > groundY) {
          // Below ground: medium
          data[idx] = 80;
        } else if (Math.abs(y - footY) < 4 && Math.abs(x - 80) < 6) {
          // Foot blob: very dark
          data[idx] = 30;
        } else {
          // Sky/background: medium-bright
          data[idx] = 140;
        }
      }
    }

    frames.push({
      data,
      width,
      height,
      tMs: Math.round((f / 30) * 1000),
    });
  }

  return frames;
}

/**
 * Generate a tilted ground line (not horizontal).
 * Tests camera-invariant detection.
 */
function generateTiltedGroundFrames(
  angleRad: number = (30 * Math.PI) / 180,
  frameCount: number = 30
): Array<{ data: Uint8ClampedArray; width: number; height: number; tMs: number }> {
  const width = 160;
  const height = 120;
  const frames = [];

  // Foot trajectory above the tilted line
  const footTrajectory = [
    ...Array(8).fill(35),
    ...Array.from({ length: 10 }, (_, i) => 35 - 5 - i * 2.5),
    ...Array.from({ length: 7 }, (_, i) => 35 - 25 + i * 3),
    ...Array(6).fill(35),
  ].slice(0, frameCount);

  for (let f = 0; f < frameCount; f += 1) {
    const data = new Uint8ClampedArray(width * height);

    // Tilted ground line: y = height * 0.6 - (x - width/2) * tan(angle)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const idx = y * width + x;

        // Ground line position at this x
        const groundLineY = height * 0.6 - (x - width / 2) * Math.tan(angleRad);

        if (Math.abs(y - groundLineY) < 2) {
          // Ground line: bright
          data[idx] = 200;
        } else if (y > groundLineY) {
          // Below ground: darker
          data[idx] = 80;
        } else if (Math.abs(y - footTrajectory[f]) < 4 && Math.abs(x - 80) < 6) {
          // Foot blob
          data[idx] = 30;
        } else {
          // Background
          data[idx] = 140;
        }
      }
    }

    frames.push({
      data,
      width,
      height,
      tMs: Math.round((f / 30) * 1000),
    });
  }

  return frames;
}

/**
 * Generate noisy/textured frames with no clear ground line.
 * Should fail ground detection.
 */
function generateNoisyTextureFrames(frameCount: number = 30): Array<{
  data: Uint8ClampedArray;
  width: number;
  height: number;
  tMs: number;
}> {
  const width = 160;
  const height = 120;
  const frames = [];

  for (let f = 0; f < frameCount; f += 1) {
    const data = new Uint8ClampedArray(width * height);

    // Deterministic pseudo-random noise (seeded)
    for (let i = 0; i < width * height; i += 1) {
      const noise = Math.sin(i * 12.9898 + f * 78.233) * 43758.5453;
      data[i] = Math.floor(((noise % 1) + 1) / 2 * 255);
    }

    frames.push({
      data,
      width,
      height,
      tMs: Math.round((f / 30) * 1000),
    });
  }

  return frames;
}

/**
 * Generate a single strong vertical line (wall, not ground).
 * Should be rejected or low confidence.
 */
function generateVerticalLineFrames(frameCount: number = 30): Array<{
  data: Uint8ClampedArray;
  width: number;
  height: number;
  tMs: number;
}> {
  const width = 160;
  const height = 120;
  const frames = [];
  const verticalLineX = Math.floor(width / 2);

  for (let f = 0; f < frameCount; f += 1) {
    const data = new Uint8ClampedArray(width * height);

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const idx = y * width + x;
        if (Math.abs(x - verticalLineX) < 2) {
          // Vertical line: bright
          data[idx] = 200;
        } else {
          // Background
          data[idx] = 140;
        }
      }
    }

    frames.push({
      data,
      width,
      height,
      tMs: Math.round((f / 30) * 1000),
    });
  }

  return frames;
}

/**
 * Generate two strong lines (floor + table edge).
 * Should select the lower one (more likely ground) with higher persistence.
 */
function generateTwoLinesFrames(frameCount: number = 30): Array<{
  data: Uint8ClampedArray;
  width: number;
  height: number;
  tMs: number;
}> {
  const width = 160;
  const height = 120;
  const frames = [];
  const groundY = Math.floor(height * 0.75); // lower line (ground)
  const tableY = Math.floor(height * 0.35); // upper line (table)

  for (let f = 0; f < frameCount; f += 1) {
    const data = new Uint8ClampedArray(width * height);

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const idx = y * width + x;

        if (Math.abs(y - groundY) < 2) {
          // Ground line: very bright
          data[idx] = 220;
        } else if (Math.abs(y - tableY) < 2) {
          // Table line: bright but slightly less
          data[idx] = 200;
        } else {
          // Background
          data[idx] = 140;
        }
      }
    }

    frames.push({
      data,
      width,
      height,
      tMs: Math.round((f / 30) * 1000),
    });
  }

  return frames;
}

/**
 * Generate blank/uniform frame.
 * Should fail detection.
 */
function generateBlankFrames(frameCount: number = 30): Array<{
  data: Uint8ClampedArray;
  width: number;
  height: number;
  tMs: number;
}> {
  const width = 160;
  const height = 120;
  const frames = [];

  for (let f = 0; f < frameCount; f += 1) {
    const data = new Uint8ClampedArray(width * height);
    data.fill(128); // Uniform gray
    frames.push({
      data,
      width,
      height,
      tMs: Math.round((f / 30) * 1000),
    });
  }

  return frames;
}

// ============================================================================
// Tests
// ============================================================================

export async function testHorizontalGroundDetection(): Promise<{
  passed: boolean;
  message: string;
}> {
  const frames = generateHorizontalGroundFrames(30);
  const result = detectGround(frames);

  const passed =
    result.detected &&
    result.confidence >= 0.5 &&
    result.theta !== null &&
    result.rho !== null &&
    // Horizontal line should have theta near 0 or π
    (Math.abs(result.theta) < 0.3 || Math.abs(result.theta - Math.PI) < 0.3);

  return {
    passed,
    message: `Horizontal ground detection: ${passed ? "✓ PASS" : "✗ FAIL"}
      detected=${result.detected}, confidence=${result.confidence?.toFixed(3)}, theta=${result.theta?.toFixed(3)}`,
  };
}

export async function testTiltedGroundDetection(): Promise<{
  passed: boolean;
  message: string;
}> {
  const angleRad = (30 * Math.PI) / 180;
  const frames = generateTiltedGroundFrames(angleRad, 30);
  const result = detectGround(frames);

  const passed =
    result.detected &&
    result.confidence >= 0.4 &&
    result.theta !== null &&
    // Tilted line should have theta near 30° or its supplement
    (Math.abs(result.theta - angleRad) < 0.5 ||
      Math.abs(result.theta - (angleRad + Math.PI)) < 0.5);

  return {
    passed,
    message: `Tilted ground detection (30°): ${passed ? "✓ PASS" : "✗ FAIL"}
      detected=${result.detected}, confidence=${result.confidence?.toFixed(3)}, theta=${result.theta?.toFixed(3)} (expected ≈ ${angleRad.toFixed(3)})`,
  };
}

export async function testNoisyFramesDetection(): Promise<{
  passed: boolean;
  message: string;
}> {
  const frames = generateNoisyTextureFrames(30);
  const result = detectGround(frames);

  // Noisy frames should NOT produce confident ground detection
  const passed = !result.detected || result.confidence < 0.4;

  return {
    passed,
    message: `Noisy frames rejection: ${passed ? "✓ PASS" : "✗ FAIL"}
      detected=${result.detected}, confidence=${result.confidence?.toFixed(3)} (should be low or false)`,
  };
}

export async function testVerticalLineRejection(): Promise<{
  passed: boolean;
  message: string;
}> {
  const frames = generateVerticalLineFrames(30);
  const result = detectGround(frames);

  // Vertical line should be rejected or have very low confidence
  // (plausibility penalty in scoring function)
  const passed = !result.detected || result.confidence < 0.35;

  return {
    passed,
    message: `Vertical line rejection: ${passed ? "✓ PASS" : "✗ FAIL"}
      detected=${result.detected}, confidence=${result.confidence?.toFixed(3)} (should be low)`,
  };
}

export async function testTwoLinesDisambiguation(): Promise<{
  passed: boolean;
  message: string;
}> {
  const frames = generateTwoLinesFrames(30);
  const result = detectGround(frames);

  // Should detect the lower line (ground at 75%) with good confidence
  const height = 120;
  const expectedGroundY = Math.floor(height * 0.75);

  // Reconstruct y from rho and theta at x=80 (mid-frame)
  let detectedGroundY: number | null = null;
  if (result.theta !== null && result.rho !== null) {
    const x = 80;
    if (Math.abs(Math.sin(result.theta)) > 1e-6) {
      detectedGroundY = (result.rho - x * Math.cos(result.theta)) / Math.sin(result.theta);
    }
  }

  const passed =
    result.detected &&
    result.confidence >= 0.5 &&
    detectedGroundY !== null &&
    Math.abs(detectedGroundY - expectedGroundY) < 10;

  return {
    passed,
    message: `Two-line disambiguation: ${passed ? "✓ PASS" : "✗ FAIL"}
      detected=${result.detected}, confidence=${result.confidence?.toFixed(3)}, detectedGroundY=${detectedGroundY?.toFixed(1)} (expected ≈ ${expectedGroundY})`,
  };
}

export async function testBlankFrameRejection(): Promise<{
  passed: boolean;
  message: string;
}> {
  const frames = generateBlankFrames(30);
  const result = detectGround(frames);

  // Blank frames should not produce detection
  const passed = !result.detected && result.confidence < 0.3;

  return {
    passed,
    message: `Blank frame rejection: ${passed ? "✓ PASS" : "✗ FAIL"}
      detected=${result.detected}, confidence=${result.confidence?.toFixed(3)} (should be false/low)`,
  };
}

export async function testEmptyInputRejection(): Promise<{
  passed: boolean;
  message: string;
}> {
  const result = detectGround([]);

  const passed = !result.detected && result.confidence === 0;

  return {
    passed,
    message: `Empty input rejection: ${passed ? "✓ PASS" : "✗ FAIL"}
      detected=${result.detected}, confidence=${result.confidence}`,
  };
}

export async function testPointToLineDistance(): Promise<{
  passed: boolean;
  message: string;
}> {
  // Horizontal line at y=60 (rho=60 for theta=π/2)
  const theta = Math.PI / 2;
  const rho = 60;

  const p1 = { x: 50, y: 50 }; // Above line
  const p2 = { x: 50, y: 60 }; // On line
  const p3 = { x: 50, y: 70 }; // Below line

  const d1 = pointToLineDistance(p1, theta, rho);
  const d2 = pointToLineDistance(p2, theta, rho);
  const d3 = pointToLineDistance(p3, theta, rho);

  const passed = d1 < -5 && Math.abs(d2) < 1 && d3 > 5;

  return {
    passed,
    message: `Point-to-line distance: ${passed ? "✓ PASS" : "✗ FAIL"}
      d1=${d1.toFixed(2)} (above), d2=${d2.toFixed(2)} (on), d3=${d3.toFixed(2)} (below)`,
  };
}

export async function testRoiInferenceFromGround(): Promise<{
  passed: boolean;
  message: string;
}> {
  const frames = generateHorizontalGroundFrames(20);
  const ground = detectGround(frames);

  if (!ground.detected) {
    return {
      passed: false,
      message: "ROI inference: Ground not detected (prerequisite failed)",
    };
  }

  const { roi, confidence } = inferRoiFromGround(frames, ground);

  const passed =
    roi !== null &&
    roi.w > 5 &&
    roi.h > 5 &&
    roi.y >= 0 &&
    confidence > 0.1;

  return {
    passed,
    message: `ROI inference from ground: ${passed ? "✓ PASS" : "✗ FAIL"}
      roi=${roi ? `{x:${roi.x},y:${roi.y},w:${roi.w},h:${roi.h}}` : "null"}, confidence=${confidence?.toFixed(3)}`,
  };
}

export async function testDeterminism(): Promise<{
  passed: boolean;
  message: string;
}> {
  const frames = generateHorizontalGroundFrames(15);

  // Run detection twice
  const result1 = detectGround(frames);
  const result2 = detectGround(frames);

  const passed =
    result1.detected === result2.detected &&
    (result1.theta ?? -999) === (result2.theta ?? -999) &&
    (result1.rho ?? -999) === (result2.rho ?? -999) &&
    (result1.confidence ?? -999) === (result2.confidence ?? -999);

  return {
    passed,
    message: `Determinism check: ${passed ? "✓ PASS" : "✗ FAIL"}
      Run1: detected=${result1.detected}, theta=${result1.theta?.toFixed(4)}, rho=${result1.rho?.toFixed(2)}
      Run2: detected=${result2.detected}, theta=${result2.theta?.toFixed(4)}, rho=${result2.rho?.toFixed(2)}`,
  };
}

export async function testNoMetricsOnFailure(): Promise<{
  passed: boolean;
  message: string;
}> {
  // Test with blank frames (should fail)
  const frames = generateBlankFrames(10);
  const ground = detectGround(frames);

  if (ground.detected) {
    return {
      passed: false,
      message: "No metrics on failure: Ground should not be detected (prerequisite failed)",
    };
  }

  // Attempt ROI inference
  const { roi, confidence } = inferRoiFromGround(frames, ground);

  // When ground not detected, ROI should be null and confidence should be 0
  const passed = roi === null && confidence === 0;

  return {
    passed,
    message: `No metrics on failure: ${passed ? "✓ PASS" : "✗ FAIL"}
      roi=${roi}, confidence=${confidence}`,
  };
}

// ============================================================================
// Test Runner
// ============================================================================

export async function runAllGroundDetectorTests(): Promise<void> {
  const tests = [
    testHorizontalGroundDetection,
    testTiltedGroundDetection,
    testNoisyFramesDetection,
    testVerticalLineRejection,
    testTwoLinesDisambiguation,
    testBlankFrameRejection,
    testEmptyInputRejection,
    testPointToLineDistance,
    testRoiInferenceFromGround,
    testDeterminism,
    testNoMetricsOnFailure,
  ];

  console.log("\n=== Ground Detector Tests ===\n");

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
