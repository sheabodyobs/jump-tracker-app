import { extractJumpEvents } from '../eventExtractor';

/**
 * Test 1: Single hop (landing → takeoff → landing).
 */
function testSingleHop(): void {
  const state: (0 | 1)[] = [0, 0, 1, 1, 1, 0, 0];
  const timestamps = state.map((_, i) => i * 100); // 0, 100, 200, 300, 400, 500, 600

  const result = extractJumpEvents(state, timestamps);

  if (result.landings.length !== 1) {
    throw new Error(`Expected 1 landing, got ${result.landings.length}`);
  }
  if (result.landings[0].tMs !== 200) {
    throw new Error(`Landing at wrong time: ${result.landings[0].tMs} !== 200`);
  }

  if (result.takeoffs.length !== 1) {
    throw new Error(`Expected 1 takeoff, got ${result.takeoffs.length}`);
  }
  if (result.takeoffs[0].tMs !== 500) {
    throw new Error(`Takeoff at wrong time: ${result.takeoffs[0].tMs} !== 500`);
  }

  if (result.hops.length !== 1) {
    throw new Error(`Expected 1 hop, got ${result.hops.length}`);
  }

  const hop = result.hops[0];
  if (hop.gctMs !== 300) {
    throw new Error(`GCT should be 300, got ${hop.gctMs}`);
  }
  if (hop.flightMs !== 100) {
    throw new Error(`Flight should be 100, got ${hop.flightMs}`);
  }

  console.log('✓ testSingleHop PASSED');
}

/**
 * Test 2: Multiple hops (clean alternation).
 */
function testMultipleHops(): void {
  // Pattern: flight (0,0) → landing (1,1,1) → takeoff (0,0) → landing (1,1) → takeoff (0)
  const state: (0 | 1)[] = [0, 0, 1, 1, 1, 0, 0, 1, 1, 0];
  const timestamps = state.map((_, i) => i * 100);

  const result = extractJumpEvents(state, timestamps);

  if (result.hops.length !== 2) {
    throw new Error(`Expected 2 hops, got ${result.hops.length}`);
  }

  // First hop: landing at 200, takeoff at 500
  if (result.hops[0].gctMs !== 300) {
    throw new Error(`First hop GCT should be 300, got ${result.hops[0].gctMs}`);
  }

  // Second hop: landing at 700, takeoff at 900
  if (result.hops[1].gctMs !== 200) {
    throw new Error(`Second hop GCT should be 200, got ${result.hops[1].gctMs}`);
  }

  if (result.summary.hopCount !== 2) {
    throw new Error(`Summary should report 2 hops, got ${result.summary.hopCount}`);
  }

  console.log('✓ testMultipleHops PASSED');
}

/**
 * Test 3: GCT rejection (too short).
 */
function testGctTooShort(): void {
  // Landing at 100, takeoff at 120 (GCT = 20ms, below default min of 50ms)
  const state: (0 | 1)[] = [0, 1, 1, 0];
  const timestamps = [0, 100, 120, 200];

  const result = extractJumpEvents(state, timestamps, {
    minGctMs: 50,
    maxGctMs: 450,
  });

  if (result.hops.length !== 0) {
    throw new Error(`Expected 0 valid hops (GCT too short), got ${result.hops.length}`);
  }

  if (result.diagnostics.rejectedTransitions !== 1) {
    throw new Error(`Expected 1 rejection, got ${result.diagnostics.rejectedTransitions}`);
  }

  if (!result.diagnostics.reasons['gct_too_short']) {
    throw new Error('Expected gct_too_short reason');
  }

  console.log('✓ testGctTooShort PASSED');
}

/**
 * Test 4: Flight rejection (too long).
 */
function testFlightTooLong(): void {
  // Landing at 100, takeoff at 200, next landing at 1200 (flight = 1000ms, above default max of 900ms)
  const state: (0 | 1)[] = [0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
  const timestamps = state.map((_, i) => i * 100);

  const result = extractJumpEvents(state, timestamps, {
    minGctMs: 50,
    maxGctMs: 450,
    minFlightMs: 100,
    maxFlightMs: 900,
  });

  if (result.hops.length !== 0) {
    throw new Error(`Expected 0 valid hops (flight too long), got ${result.hops.length}`);
  }

  if (!result.diagnostics.reasons['flight_too_long']) {
    throw new Error('Expected flight_too_long reason');
  }

  console.log('✓ testFlightTooLong PASSED');
}

/**
 * Test 5: Empty state.
 */
function testEmptyState(): void {
  const result = extractJumpEvents([], []);

  if (result.hops.length !== 0) {
    throw new Error(`Expected 0 hops for empty state`);
  }

  if (result.confidence !== 0) {
    throw new Error(`Expected 0 confidence for empty state`);
  }

  console.log('✓ testEmptyState PASSED');
}

/**
 * Test 6: No transitions (constant state).
 */
function testNoTransitions(): void {
  const state: (0 | 1)[] = [0, 0, 0, 0];
  const timestamps = state.map((_, i) => i * 100);

  const result = extractJumpEvents(state, timestamps);

  if (result.landings.length !== 0 || result.takeoffs.length !== 0) {
    throw new Error('Expected no events for constant state');
  }

  if (result.hops.length !== 0) {
    throw new Error('Expected no hops for constant state');
  }

  if (result.confidence !== 0) {
    throw new Error('Expected 0 confidence for no hops');
  }

  console.log('✓ testNoTransitions PASSED');
}

/**
 * Test 7: Confidence computation.
 */
function testConfidenceComputation(): void {
  // Valid hop: should have good confidence
  const state1: (0 | 1)[] = [0, 1, 1, 0];
  const timestamps1 = state1.map((_, i) => i * 100);
  const result1 = extractJumpEvents(state1, timestamps1);

  if (result1.hops.length !== 1 || result1.confidence <= 0.5) {
    throw new Error(`Expected good confidence for valid hop, got ${result1.confidence}`);
  }

  // Multiple valid hops: should have excellent confidence
  const state2: (0 | 1)[] = [0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0];
  const timestamps2 = state2.map((_, i) => i * 100);
  const result2 = extractJumpEvents(state2, timestamps2);

  if (result2.hops.length !== 3) {
    throw new Error(`Expected 3 hops, got ${result2.hops.length}`);
  }

  if (result2.confidence <= result1.confidence) {
    throw new Error('Multiple hops should have higher confidence than single hop');
  }

  console.log('✓ testConfidenceComputation PASSED');
}

/**
 * Test 8: Median computation.
 */
function testMedianComputation(): void {
  // Three hops with GCT: 200, 300, 400 → median = 300
  const state: (0 | 1)[] = [0, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0];
  const timestamps = state.map((_, i) => i * 100);

  const result = extractJumpEvents(state, timestamps, {
    minGctMs: 50,
    maxGctMs: 500,
  });

  if (result.hops.length !== 3) {
    throw new Error(`Expected 3 hops, got ${result.hops.length}`);
  }

  const medianGct = result.summary.medianGctMs;
  if (medianGct !== 300) {
    throw new Error(`Expected median GCT of 300, got ${medianGct}`);
  }

  console.log('✓ testMedianComputation PASSED');
}

/**
 * Test 9: Incomplete last hop (takeoff without next landing).
 */
function testIncompleteLastHop(): void {
  // Landing at 100, takeoff at 300, no next landing
  const state: (0 | 1)[] = [0, 1, 1, 0];
  const timestamps = state.map((_, i) => i * 100);

  const result = extractJumpEvents(state, timestamps);

  if (result.hops.length !== 1) {
    throw new Error(`Expected 1 hop with null flightMs`);
  }

  if (result.hops[0].flightMs !== null) {
    throw new Error(`Expected null flightMs for incomplete hop`);
  }

  if (result.summary.medianFlightMs !== null) {
    throw new Error(`Expected null median flight time (no complete hops)`);
  }

  console.log('✓ testIncompleteLastHop PASSED');
}

/**
 * Test 10: Bounds with custom options.
 */
function testCustomBounds(): void {
  const state: (0 | 1)[] = [0, 1, 1, 0];
  const timestamps = state.map((_, i) => i * 100); // GCT = 200ms

  // Default bounds (min: 50, max: 450) → should pass
  const result1 = extractJumpEvents(state, timestamps);
  if (result1.hops.length !== 1) {
    throw new Error('GCT 200ms should pass default bounds');
  }

  // Custom bounds (min: 300, max: 400) → should fail
  const result2 = extractJumpEvents(state, timestamps, {
    minGctMs: 300,
    maxGctMs: 400,
  });
  if (result2.hops.length !== 0) {
    throw new Error('GCT 200ms should fail custom min bound of 300ms');
  }

  console.log('✓ testCustomBounds PASSED');
}

/**
 * Test 11: Mixed valid and invalid hops.
 */
function testMixedValidInvalid(): void {
  // Two hops: one valid (GCT 200), one too short (GCT 30)
  const state: (0 | 1)[] = [0, 1, 1, 0, 0, 1, 0, 0];
  const timestamps = [0, 100, 300, 500, 600, 630, 700, 800];

  const result = extractJumpEvents(state, timestamps, {
    minGctMs: 50,
    maxGctMs: 450,
  });

  if (result.hops.length !== 1) {
    throw new Error(`Expected 1 valid hop, got ${result.hops.length}`);
  }

  if (result.diagnostics.rejectedTransitions !== 1) {
    throw new Error(`Expected 1 rejection, got ${result.diagnostics.rejectedTransitions}`);
  }

  console.log('✓ testMixedValidInvalid PASSED');
}

/**
 * Test 12: Takeoff before landing (edge case).
 */
function testTakeoffBeforeLanding(): void {
  // Starts with state=1 (in contact), then transitions to 0 (takeoff)
  // This is a takeoff without a preceding landing
  const state: (0 | 1)[] = [1, 1, 0, 0, 1, 1, 0];
  const timestamps = state.map((_, i) => i * 100);

  const result = extractJumpEvents(state, timestamps);

  // Should have: 1 takeoff (at 200), 1 landing (at 400), 0 hops
  // Because takeoff at 200 comes before landing at 400
  if (result.hops.length !== 1) {
    throw new Error(`Expected 1 hop (second takeoff pairs with implicit next landing attempt)`);
  }

  if (result.diagnostics.reasons['takeoff_before_landing']) {
    // Takeoff at 200 should be skipped, landing at 400 and takeoff at 600 should pair
    if (result.hops[0].landingMs !== 400) {
      throw new Error('Landing should be at 400');
    }
  }

  console.log('✓ testTakeoffBeforeLanding PASSED');
}

/**
 * Run all event extractor tests.
 */
export function runAllEventExtractorTests(): void {
  console.log('\n=== Event Extractor Tests ===\n');

  try {
    testSingleHop();
    testMultipleHops();
    testGctTooShort();
    testFlightTooLong();
    testEmptyState();
    testNoTransitions();
    testConfidenceComputation();
    testMedianComputation();
    testIncompleteLastHop();
    testCustomBounds();
    testMixedValidInvalid();
    testTakeoffBeforeLanding();

    console.log('\n=== All Event Extractor Tests PASSED ✓ ===\n');
  } catch (error) {
    console.error('\n=== Test FAILED ✗ ===');
    console.error(error);
    throw error;
  }
}

// Run tests if executed directly
if (require.main === module) {
  try {
    runAllEventExtractorTests();
  } catch (err: unknown) {
    console.error('Test execution failed:', err);
    process.exit(1);
  }
}
