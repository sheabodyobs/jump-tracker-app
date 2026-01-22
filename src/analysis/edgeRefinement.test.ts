import assert from 'assert';
import { refineLandingEdge, refineTakeoffEdge } from './edgeRefinement';

function testLandingEdgeAtStart(): void {
  const scores = [0.1, 0.6, 0.7];
  const timestamps = [0, 10, 20];

  const result = refineLandingEdge(scores, 1, timestamps, { method: 'max_derivative', windowFrames: 3 });

  assert.ok(Number.isFinite(result.refinedTMs), 'refinedTMs should be finite');
  assert.ok(result.refinedTMs >= 0 && result.refinedTMs <= 20, 'refinedTMs should be within bounds');
  console.log('✓ testLandingEdgeAtStart PASSED');
}

function testTakeoffEdgeAtEnd(): void {
  const scores = [0.8, 0.4, 0.1];
  const timestamps = [0, 10, 20];

  const result = refineTakeoffEdge(scores, 2, timestamps, { method: 'max_derivative', windowFrames: 3 });

  assert.ok(Number.isFinite(result.refinedTMs), 'refinedTMs should be finite');
  assert.ok(result.refinedTMs >= 0 && result.refinedTMs <= 20, 'refinedTMs should be within bounds');
  console.log('✓ testTakeoffEdgeAtEnd PASSED');
}

export function runAllEdgeRefinementTests(): void {
  console.log('\n=== Edge Refinement Tests ===\n');
  try {
    testLandingEdgeAtStart();
    testTakeoffEdgeAtEnd();
    console.log('\n=== All Edge Refinement Tests PASSED ✓ ===\n');
  } catch (error) {
    console.error('\n=== Test FAILED ✗ ===');
    console.error(error);
    throw error;
  }
}

if (require.main === module) {
  try {
    runAllEdgeRefinementTests();
  } catch (err: unknown) {
    console.error('Test execution failed:', err);
    process.exit(1);
  }
}
