/**
 * roiInference.test.ts
 *
 * Tests for ROI inference via motion energy band search.
 */

import type { GroundModel2D } from "../jumpAnalysisContract";
import { inferRoiFromMotion } from "../roiInference";

/**
 * Generate synthetic grayscale frame with static noise baseline.
 */
function generateStaticFrame(width: number, height: number, seed: number): Uint8ClampedArray {
  const rng = seededRandom(seed);
  const data = new Uint8ClampedArray(width * height);
  for (let i = 0; i < width * height; i++) {
    data[i] = Math.floor(rng() * 50) + 100; // 100..150 (gray)
  }
  return data;
}

/**
 * Paint a moving blob at (cx, cy) with motion step (dx, dy).
 */
function paintBlob(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  cx: number,
  cy: number,
  blobRadius: number,
  intensity: number
) {
  for (let dy = -blobRadius; dy <= blobRadius; dy++) {
    for (let dx = -blobRadius; dx <= blobRadius; dx++) {
      const y = Math.floor(cy + dy);
      const x = Math.floor(cx + dx);
      if (x >= 0 && x < width && y >= 0 && y < height) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist <= blobRadius) {
          const idx = y * width + x;
          const falloff = 1 - dist / (blobRadius + 1);
          data[idx] = Math.min(255, data[idx] + intensity * falloff);
        }
      }
    }
  }
}

/**
 * Generate synthetic frame sequence with moving blob above ground line.
 */
function generateMovingBlobSequence(
  width: number,
  height: number,
  count: number,
  groundY: number,
  blobStartX: number,
  blobY: number,
  blobRadius: number,
  motionPerFrame: number,
  intensity: number
): { data: Uint8ClampedArray; width: number; height: number }[] {
  const frames = [];

  for (let t = 0; t < count; t++) {
    const baseData = generateStaticFrame(width, height, t);
    const blobX = blobStartX + motionPerFrame * t;

    // Only paint blob if above ground
    if (blobY < groundY) {
      paintBlob(baseData, width, height, blobX, blobY, blobRadius, intensity);
    }

    frames.push({
      data: baseData,
      width,
      height,
    });
  }

  return frames;
}

/**
 * Seeded RNG for reproducibility.
 */
function seededRandom(seed: number): () => number {
  return () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
}

// ============ Tests ============

export async function testDetectMovingBlobAboveGround(): Promise<{
  passed: boolean;
  message: string;
}> {
  const width = 320;
  const height = 240;
  const groundY = 180;

  const frames = generateMovingBlobSequence(
    width,
    height,
    10, // 10 frames
    groundY,
    80, // blob starts at x=80
    120, // blob at y=120 (above ground at y=180)
    15, // radius 15
    2, // move 2px/frame
    200 // intensity 200
  );

  const groundModel: GroundModel2D = {
    type: "y_scalar",
    y: groundY,
    confidence: 0.9,
  };

  const result = inferRoiFromMotion(frames, groundModel, {
    roiSize: { w: 64, h: 48 },
    stride: 2,
  });

  // Blob should be detected somewhere near x=80..120, y=96..144
  const expectedXRange = [60, 140];
  const expectedYRange = [100, 140];

  const roiCenterX = result.roi.x + result.roi.w / 2;
  const roiCenterY = result.roi.y + result.roi.h / 2;

  const xOk =
    roiCenterX >= expectedXRange[0] && roiCenterX <= expectedXRange[1];
  const yOk =
    roiCenterY >= expectedYRange[0] && roiCenterY <= expectedYRange[1];
  const energyOk = result.diagnostics.bestEnergy > 50;
  const confidenceOk = result.confidence > 0.4;

  const passed = xOk && yOk && energyOk && confidenceOk;

  return {
    passed,
    message: `testDetectMovingBlobAboveGround: ${passed ? "✓ PASS" : "✗ FAIL"}
      ROI center: (${roiCenterX.toFixed(1)}, ${roiCenterY.toFixed(1)}) [expected X: ${expectedXRange}, Y: ${expectedYRange}]
      Energy: ${result.diagnostics.bestEnergy.toFixed(1)} [expected > 50]
      Confidence: ${result.confidence.toFixed(2)} [expected > 0.4]
      X ok: ${xOk}, Y ok: ${yOk}, Energy ok: ${energyOk}, Conf ok: ${confidenceOk}`,
  };
}

export async function testNoMotionReturnsLowConfidence(): Promise<{
  passed: boolean;
  message: string;
}> {
  const width = 320;
  const height = 240;
  const groundY = 180;

  // Generate static frames (no motion)
  const frames = [];
  for (let i = 0; i < 10; i++) {
    frames.push({
      data: generateStaticFrame(width, height, 0), // same seed = same frame
      width,
      height,
    });
  }

  const groundModel: GroundModel2D = {
    type: "y_scalar",
    y: groundY,
    confidence: 0.9,
  };

  const result = inferRoiFromMotion(frames, groundModel);

  const passed = result.confidence === 0 || result.confidence < 0.1;

  return {
    passed,
    message: `testNoMotionReturnsLowConfidence: ${passed ? "✓ PASS" : "✗ FAIL"}
      Confidence: ${result.confidence.toFixed(2)} [expected ≈ 0]`,
  };
}

export async function testInsufficientFramesReturnsZeroConfidence(): Promise<{
  passed: boolean;
  message: string;
}> {
  const width = 320;
  const height = 240;
  const groundY = 180;

  // Only 1 frame (need ≥2)
  const frames = [
    {
      data: generateStaticFrame(width, height, 0),
      width,
      height,
    },
  ];

  const groundModel: GroundModel2D = {
    type: "y_scalar",
    y: groundY,
    confidence: 0.9,
  };

  const result = inferRoiFromMotion(frames, groundModel);

  const passed = result.confidence === 0;

  return {
    passed,
    message: `testInsufficientFramesReturnsZeroConfidence: ${passed ? "✓ PASS" : "✗ FAIL"}
      Confidence: ${result.confidence} [expected 0]`,
  };
}

export async function testUnknownGroundReturnsZeroConfidence(): Promise<{
  passed: boolean;
  message: string;
}> {
  const width = 320;
  const height = 240;

  const frames = generateMovingBlobSequence(
    width,
    height,
    10,
    180,
    80,
    120,
    15,
    2,
    200
  );

  const groundModel: GroundModel2D = {
    type: "unknown",
    confidence: 0,
  };

  const result = inferRoiFromMotion(frames, groundModel);

  const passed = result.confidence === 0;

  return {
    passed,
    message: `testUnknownGroundReturnsZeroConfidence: ${passed ? "✓ PASS" : "✗ FAIL"}
      Confidence: ${result.confidence} [expected 0]`,
  };
}

export async function testHoughPolarGround(): Promise<{
  passed: boolean;
  message: string;
}> {
  const width = 320;
  const height = 240;

  // Hough ground line: ~y = 180 (nearly horizontal)
  // In polar: theta ≈ π/2 (vertical slope), rho ≈ 180
  const theta = Math.PI / 2;
  const rho = 180;

  const frames = generateMovingBlobSequence(
    width,
    height,
    10,
    180, // visual y
    80,
    120,
    15,
    2,
    200
  );

  const groundModel: GroundModel2D = {
    type: "hough_polar",
    theta,
    rho,
    confidence: 0.9,
    method: "hough_temporal",
    line: { x1: 0, y1: 180, x2: 320, y2: 180 },
  };

  const result = inferRoiFromMotion(frames, groundModel);

  const passed =
    result.confidence > 0.3 && result.diagnostics.bestEnergy > 50;

  return {
    passed,
    message: `testHoughPolarGround: ${passed ? "✓ PASS" : "✗ FAIL"}
      Confidence: ${result.confidence.toFixed(2)} [expected > 0.3]
      Energy: ${result.diagnostics.bestEnergy.toFixed(1)} [expected > 50]`,
  };
}

export async function testRoiClippedByGround(): Promise<{
  passed: boolean;
  message: string;
}> {
  const width = 320;
  const height = 240;
  const groundY = 200; // very low

  // Blob at y=150 (close to ground)
  const frames = generateMovingBlobSequence(
    width,
    height,
    10,
    groundY,
    80,
    150, // blob near ground
    15,
    2,
    200
  );

  const groundModel: GroundModel2D = {
    type: "y_scalar",
    y: groundY,
    confidence: 0.9,
  };

  const result = inferRoiFromMotion(frames, groundModel);

  // ROI should exist but be marked as clipped
  const passed = result.diagnostics.bandClipped === true;

  return {
    passed,
    message: `testRoiClippedByGround: ${passed ? "✓ PASS" : "✗ FAIL"}
      Band clipped: ${result.diagnostics.bandClipped} [expected true]
      Confidence: ${result.confidence.toFixed(2)} (should be lower due to clipping)`,
  };
}

export async function testConfidenceScalesWithEnergy(): Promise<{
  passed: boolean;
  message: string;
}> {
  const width = 320;
  const height = 240;
  const groundY = 180;

  // Generate two sequences: high motion vs low motion
  const highMotionFrames = generateMovingBlobSequence(
    width,
    height,
    10,
    groundY,
    80,
    120,
    20, // large blob
    5, // fast motion
    250 // high intensity
  );

  const lowMotionFrames = generateMovingBlobSequence(
    width,
    height,
    10,
    groundY,
    80,
    120,
    8, // small blob
    1, // slow motion
    100 // low intensity
  );

  const groundModel: GroundModel2D = {
    type: "y_scalar",
    y: groundY,
    confidence: 0.9,
  };

  const highResult = inferRoiFromMotion(highMotionFrames, groundModel);
  const lowResult = inferRoiFromMotion(lowMotionFrames, groundModel);

  const highEnergy = highResult.diagnostics.bestEnergy;
  const lowEnergy = lowResult.diagnostics.bestEnergy;
  const highConf = highResult.confidence;
  const lowConf = lowResult.confidence;

  // High motion should have more energy and higher confidence
  const energyOk = highEnergy > lowEnergy;
  const confOk = highConf > lowConf;

  const passed = energyOk && confOk;

  return {
    passed,
    message: `testConfidenceScalesWithEnergy: ${passed ? "✓ PASS" : "✗ FAIL"}
      High motion: energy=${highEnergy.toFixed(1)}, conf=${highConf.toFixed(2)}
      Low motion:  energy=${lowEnergy.toFixed(1)}, conf=${lowConf.toFixed(2)}
      Energy scales: ${energyOk}, Confidence scales: ${confOk}`,
  };
}

export async function testBelowGroundBlobIgnored(): Promise<{
  passed: boolean;
  message: string;
}> {
  const width = 320;
  const height = 240;
  const groundY = 120;

  // Blob BELOW ground (y=180, ground=120)
  const frames = generateMovingBlobSequence(
    width,
    height,
    10,
    groundY,
    80,
    180, // below ground!
    15,
    2,
    200
  );

  const groundModel: GroundModel2D = {
    type: "y_scalar",
    y: groundY,
    confidence: 0.9,
  };

  const result = inferRoiFromMotion(frames, groundModel);

  // Should have low confidence since blob is below ground
  const passed = result.confidence < 0.2;

  return {
    passed,
    message: `testBelowGroundBlobIgnored: ${passed ? "✓ PASS" : "✗ FAIL"}
      Confidence: ${result.confidence.toFixed(2)} [expected < 0.2]
      Diagnostics: ${result.diagnostics.stageSummary}`,
  };
}

export async function testMultipleBlobsSelectsHighestEnergy(): Promise<{
  passed: boolean;
  message: string;
}> {
  const width = 320;
  const height = 240;
  const groundY = 180;

  // Generate two blobs: one weak at x=80, one strong at x=200
  const frames: { data: Uint8ClampedArray; width: number; height: number }[] = [];

  for (let t = 0; t < 10; t++) {
    const data = generateStaticFrame(width, height, t);

    // Weak blob at x=80, y=120
    paintBlob(data, width, height, 80, 120, 10, 100);

    // Strong blob at x=200, y=130
    paintBlob(data, width, height, 200, 130, 20, 250);

    frames.push({ data, width, height });
  }

  const groundModel: GroundModel2D = {
    type: "y_scalar",
    y: groundY,
    confidence: 0.9,
  };

  const result = inferRoiFromMotion(frames, groundModel, {
    roiSize: { w: 64, h: 48 },
    stride: 2,
  });

  // ROI should be near the strong blob at x=200
  const roiCenterX = result.roi.x + result.roi.w / 2;
  const nearStrongBlob = roiCenterX > 160 && roiCenterX < 240;

  const passed = nearStrongBlob && result.confidence > 0.3;

  return {
    passed,
    message: `testMultipleBlobsSelectsHighestEnergy: ${passed ? "✓ PASS" : "✗ FAIL"}
      ROI center X: ${roiCenterX.toFixed(1)} [expected near 200]
      Near strong blob: ${nearStrongBlob}
      Confidence: ${result.confidence.toFixed(2)} [expected > 0.3]`,
  };
}

/**
 * Run all tests.
 */
export async function runAllRoiInferenceTests(): Promise<void> {
  const tests = [
    testDetectMovingBlobAboveGround,
    testNoMotionReturnsLowConfidence,
    testInsufficientFramesReturnsZeroConfidence,
    testUnknownGroundReturnsZeroConfidence,
    testHoughPolarGround,
    testRoiClippedByGround,
    testConfidenceScalesWithEnergy,
    testBelowGroundBlobIgnored,
    testMultipleBlobsSelectsHighestEnergy,
  ];

  let passCount = 0;
  let failCount = 0;

  console.log("=== ROI Inference Tests ===\n");

  for (const test of tests) {
    const result = await test();
    console.log(result.message);
    if (result.passed) {
      passCount++;
    } else {
      failCount++;
    }
    console.log("");
  }

  console.log(`\n=== Summary ===`);
  console.log(`PASS: ${passCount}/${tests.length}`);
  console.log(`FAIL: ${failCount}/${tests.length}`);
}
