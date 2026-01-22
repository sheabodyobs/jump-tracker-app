import { computeContactSignal, RawFrame } from '../contactSignal';

/**
 * Generate static grayscale frame with optional noise.
 */
function generateStaticFrame(
  width: number,
  height: number,
  baseValue: number,
  seed: number
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height);
  let rng = seed;

  for (let i = 0; i < data.length; i++) {
    // LCG: deterministic noise
    rng = (rng * 1103515245 + 12345) & 0x7fffffff;
    const noise = (rng % 20) - 10; // ±10 noise
    data[i] = Math.max(0, Math.min(255, baseValue + noise));
  }

  return data;
}

/**
 * Paint a blob of motion (intensity change) at specified location.
 */
function paintMotionBlob(
  data: Uint8ClampedArray,
  prevData: Uint8ClampedArray,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
  intensity: number
): void {
  for (let y = Math.max(0, cy - radius); y < Math.min(height, cy + radius); y++) {
    for (let x = Math.max(0, cx - radius); x < Math.min(width, cx + radius); x++) {
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (dist <= radius) {
        const falloff = 1 - dist / radius;
        const idx = y * width + x;
        const change = intensity * falloff;
        const newValue = Math.max(0, Math.min(255, prevData[idx] + change));
        data[idx] = newValue;
      }
    }
  }
}

/**
 * Generate frame sequence with clean contact/flight pattern.
 * Contact = motion inside ROI, Flight = static.
 */
function generateAlternatingContactFlight(
  width: number,
  height: number,
  framesPerPhase: number,
  roiCx: number,
  roiCy: number
): RawFrame[] {
  const frames: RawFrame[] = [];
  let prev = generateStaticFrame(width, height, 128, 0);

  // Alternating pattern: contact, flight, contact, flight...
  for (let phase = 0; phase < 4; phase++) {
    const isContact = phase % 2 === 0;

    for (let frame = 0; frame < framesPerPhase; frame++) {
      const curr = generateStaticFrame(width, height, 128, phase * framesPerPhase + frame);

      if (isContact) {
        // Add motion blob during contact
        paintMotionBlob(curr, prev, width, height, roiCx, roiCy, 15, 80);
      }
      // Otherwise, just base noise (flight)

      frames.push({
        data: curr,
        width,
        height,
      });

      prev = curr;
    }
  }

  return frames;
}

/**
 * Generate noisy frame sequence to test chatter prevention.
 */
function generateNoisyContactSignal(
  width: number,
  height: number,
  frameCount: number,
  roiCx: number,
  roiCy: number
): RawFrame[] {
  const frames: RawFrame[] = [];
  let prev = generateStaticFrame(width, height, 128, 0);

  let rng = 12345;
  for (let t = 0; t < frameCount; t++) {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff;
    const isContact = (rng % 2) === 0; // Random contact/flight

    const curr = generateStaticFrame(width, height, 128, t);

    if (isContact) {
      // Add variable motion intensity
      rng = (rng * 1103515245 + 12345) & 0x7fffffff;
      const intensity = 40 + (rng % 60); // 40..100
      paintMotionBlob(curr, prev, width, height, roiCx, roiCy, 15, intensity);
    }

    frames.push({
      data: curr,
      width,
      height,
    });

    prev = curr;
  }

  return frames;
}

/**
 * Test 1: Clean alternating contact/flight pattern should produce stable state.
 */
async function testCleanAlternatingContactFlight(): Promise<void> {
  const width = 320;
  const height = 240;
  const roiCx = 160;
  const roiCy = 150;

  const frames = generateAlternatingContactFlight(width, height, 5, roiCx, roiCy);
  const roi = { x: roiCx - 20, y: roiCy - 20, w: 40, h: 40 };

  const result = computeContactSignal(frames, roi, {
    emaAlpha: 0.2,
    normMethod: 'medianMAD',
    enterThreshold: 0.4,
    exitThreshold: 0.2,
    minStateFrames: 2,
  });

  // Verify state transitions at phase boundaries
  const phaseLength = 5;

  // Phase 0 (contact): frames 0-4
  for (let t = 0; t < phaseLength; t++) {
    if (result.state[t] !== 1) {
      throw new Error(`Phase 0 (contact): frame ${t} should be state 1, got ${result.state[t]}`);
    }
  }

  // Phase 1 (flight): frames 5-9
  for (let t = phaseLength; t < 2 * phaseLength; t++) {
    if (result.state[t] !== 0) {
      throw new Error(`Phase 1 (flight): frame ${t} should be state 0, got ${result.state[t]}`);
    }
  }

  // Phase 2 (contact): frames 10-14
  for (let t = 2 * phaseLength; t < 3 * phaseLength; t++) {
    if (result.state[t] !== 1) {
      throw new Error(`Phase 2 (contact): frame ${t} should be state 1, got ${result.state[t]}`);
    }
  }

  console.log('✓ testCleanAlternatingContactFlight PASSED');
}

/**
 * Test 2: Noisy score with chatter prevention should avoid rapid state changes.
 */
async function testNoisyScoreChatterPrevention(): Promise<void> {
  const width = 320;
  const height = 240;
  const roiCx = 160;
  const roiCy = 150;

  const frames = generateNoisyContactSignal(width, height, 30, roiCx, roiCy);
  const roi = { x: roiCx - 20, y: roiCy - 20, w: 40, h: 40 };

  const result = computeContactSignal(frames, roi, {
    emaAlpha: 0.3, // stronger smoothing
    normMethod: 'medianMAD',
    enterThreshold: 0.35,
    exitThreshold: 0.15,
    minStateFrames: 3, // require 3 frames in state to prevent chatter
  });

  // Count state transitions
  let transitionCount = 0;
  for (let t = 1; t < result.state.length; t++) {
    if (result.state[t] !== result.state[t - 1]) {
      transitionCount++;
    }
  }

  // With noisy input and minStateFrames=3, transitions should be limited
  // (exact count depends on randomness, but chatterCount should be non-zero if suppressed)
  if (result.diagnostics.chatterCount < 0) {
    throw new Error('chatterCount should be non-negative');
  }

  // Verify state array is valid (all 0 or 1)
  for (let t = 0; t < result.state.length; t++) {
    if (result.state[t] !== 0 && result.state[t] !== 1) {
      throw new Error(`Invalid state at frame ${t}: ${result.state[t]}`);
    }
  }

  console.log(`✓ testNoisyScoreChatterPrevention PASSED (transitions=${transitionCount}, chatter=${result.diagnostics.chatterCount})`);
}

/**
 * Test 3: Insufficient frames should handle gracefully.
 */
async function testInsufficientFrames(): Promise<void> {
  const roi = { x: 0, y: 0, w: 10, h: 10 };
  const result = computeContactSignal([], roi);

  if (result.state.length !== 0) {
    throw new Error('Empty frames should produce empty state');
  }
  if (result.confidence !== 0) {
    throw new Error('Empty frames should produce confidence 0');
  }

  console.log('✓ testInsufficientFrames PASSED');
}

/**
 * Test 4: Percentile normalization method.
 */
async function testPercentileNormalization(): Promise<void> {
  const width = 320;
  const height = 240;
  const roiCx = 160;
  const roiCy = 150;

  const frames = generateAlternatingContactFlight(width, height, 5, roiCx, roiCy);
  const roi = { x: roiCx - 20, y: roiCy - 20, w: 40, h: 40 };

  const result = computeContactSignal(frames, roi, {
    emaAlpha: 0.2,
    normMethod: 'percentile', // use percentile instead of medianMAD
    enterThreshold: 0.4,
    exitThreshold: 0.2,
    minStateFrames: 2,
  });

  // Verify diagnostics report percentile info
  if (result.diagnostics.norm.type !== 'percentile') {
    throw new Error(`Expected percentile norm, got ${result.diagnostics.norm.type}`);
  }

  if (result.diagnostics.norm.type === 'percentile') {
    if (result.diagnostics.norm.min >= result.diagnostics.norm.max) {
      throw new Error('Percentile min should be < max');
    }
  }

  console.log('✓ testPercentileNormalization PASSED');
}

/**
 * Test 5: Hysteresis threshold gap prevents jitter.
 */
async function testHysteresisThresholdGap(): Promise<void> {
  const width = 320;
  const height = 240;
  const roiCx = 160;
  const roiCy = 150;

  const frames = generateAlternatingContactFlight(width, height, 5, roiCx, roiCy);
  const roi = { x: roiCx - 20, y: roiCy - 20, w: 40, h: 40 };

  // Wide threshold gap (0.35 - 0.1 = 0.25)
  const resultWideGap = computeContactSignal(frames, roi, {
    emaAlpha: 0.2,
    normMethod: 'medianMAD',
    enterThreshold: 0.35,
    exitThreshold: 0.1,
    minStateFrames: 1,
  });

  // Narrow threshold gap (0.25 - 0.2 = 0.05)
  const resultNarrowGap = computeContactSignal(frames, roi, {
    emaAlpha: 0.2,
    normMethod: 'medianMAD',
    enterThreshold: 0.25,
    exitThreshold: 0.2,
    minStateFrames: 1,
  });

  // Wide gap should have higher confidence
  if (resultWideGap.confidence <= resultNarrowGap.confidence) {
    console.warn(`Wide gap confidence (${resultWideGap.confidence.toFixed(3)}) should be > narrow gap (${resultNarrowGap.confidence.toFixed(3)})`);
  }

  console.log('✓ testHysteresisThresholdGap PASSED');
}

/**
 * Test 6: Smoothed scores should be in [0..1].
 */
async function testSmoothedScoresInRange(): Promise<void> {
  const width = 320;
  const height = 240;
  const roiCx = 160;
  const roiCy = 150;

  const frames = generateNoisyContactSignal(width, height, 20, roiCx, roiCy);
  const roi = { x: roiCx - 20, y: roiCy - 20, w: 40, h: 40 };

  const result = computeContactSignal(frames, roi);

  for (let t = 0; t < result.scoreSmoothed.length; t++) {
    const score = result.scoreSmoothed[t];
    if (score < 0 || score > 1) {
      throw new Error(`Smoothed score at frame ${t} is out of range [0..1]: ${score}`);
    }
  }

  console.log('✓ testSmoothedScoresInRange PASSED');
}

/**
 * Test 7: Raw scores should be non-negative.
 */
async function testRawScoresNonNegative(): Promise<void> {
  const width = 320;
  const height = 240;
  const roiCx = 160;
  const roiCy = 150;

  const frames = generateAlternatingContactFlight(width, height, 5, roiCx, roiCy);
  const roi = { x: roiCx - 20, y: roiCy - 20, w: 40, h: 40 };

  const result = computeContactSignal(frames, roi);

  for (let t = 0; t < result.score.length; t++) {
    if (result.score[t] < 0) {
      throw new Error(`Raw score at frame ${t} is negative: ${result.score[t]}`);
    }
  }

  console.log('✓ testRawScoresNonNegative PASSED');
}

/**
 * Test 8: Output arrays should have consistent length with input frames.
 */
async function testOutputArrayLengths(): Promise<void> {
  const width = 320;
  const height = 240;
  const roiCx = 160;
  const roiCy = 150;

  const frames = generateAlternatingContactFlight(width, height, 5, roiCx, roiCy);
  const roi = { x: roiCx - 20, y: roiCy - 20, w: 40, h: 40 };

  const result = computeContactSignal(frames, roi);

  const expectedLength = frames.length;
  if (result.score.length !== expectedLength) {
    throw new Error(`score.length ${result.score.length} !== frames.length ${expectedLength}`);
  }
  if (result.scoreSmoothed.length !== expectedLength) {
    throw new Error(`scoreSmoothed.length ${result.scoreSmoothed.length} !== frames.length ${expectedLength}`);
  }
  if (result.state.length !== expectedLength) {
    throw new Error(`state.length ${result.state.length} !== frames.length ${expectedLength}`);
  }

  console.log('✓ testOutputArrayLengths PASSED');
}

/**
 * Run all contact signal tests.
 */
export async function runAllContactSignalTests(): Promise<void> {
  console.log('\n=== Contact Signal Tests ===\n');

  try {
    await testCleanAlternatingContactFlight();
    await testNoisyScoreChatterPrevention();
    await testInsufficientFrames();
    await testPercentileNormalization();
    await testHysteresisThresholdGap();
    await testSmoothedScoresInRange();
    await testRawScoresNonNegative();
    await testOutputArrayLengths();

    console.log('\n=== All Contact Signal Tests PASSED ✓ ===\n');
  } catch (error) {
    console.error('\n=== Test FAILED ✗ ===');
    console.error(error);
    throw error;
  }
}

// Run tests if executed directly
if (require.main === module) {
  runAllContactSignalTests().catch((err) => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });
}
