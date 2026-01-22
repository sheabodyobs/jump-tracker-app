import assert from 'assert';
import { matchEvents } from './runAccuracy';

function testDuplicateAutoTimestamps(): void {
  const autoTimes = [1000, 1000];
  const labelTimes = [1000, 1000];

  const matches = matchEvents(autoTimes, labelTimes, 0);

  const unmatchedLabels = matches.filter((m) => m.unmatched === 'label');
  const unmatchedAutos = matches.filter((m) => m.unmatched === 'auto');
  const matched = matches.filter((m) => m.auto !== undefined && m.label !== undefined);

  assert.strictEqual(unmatchedLabels.length, 0, 'No labels should remain unmatched');
  assert.strictEqual(unmatchedAutos.length, 0, 'No autos should remain unmatched');
  assert.strictEqual(matched.length, 2, 'Expected two matched pairs');
  assert.ok(matched.every((m) => m.errorMs === 0), 'All matches should have zero error');

  console.log('✓ testDuplicateAutoTimestamps PASSED');
}

export function runAllAccuracyRunnerTests(): void {
  console.log('\n=== Accuracy Runner Tests ===\n');
  try {
    testDuplicateAutoTimestamps();
    console.log('\n=== All Accuracy Runner Tests PASSED ✓ ===\n');
  } catch (error) {
    console.error('\n=== Test FAILED ✗ ===');
    console.error(error);
    throw error;
  }
}

if (require.main === module) {
  try {
    runAllAccuracyRunnerTests();
  } catch (err: unknown) {
    console.error('Test execution failed:', err);
    process.exit(1);
  }
}
