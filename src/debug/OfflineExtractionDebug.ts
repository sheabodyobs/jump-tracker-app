/**
 * src/debug/OfflineExtractionDebug.ts
 * 
 * Minimal debug component for testing offline extraction without UI setup.
 * Import and call testOfflineExtraction() from anywhere in your app.
 * 
 * Usage:
 *   import { testOfflineExtraction } from './src/debug/OfflineExtractionDebug';
 *   await testOfflineExtraction('file:///path/to/video.mov', 3000);
 */

import { useState } from 'react';
import { analyzeVideoOffline } from '../video/offlineAnalysis';
import { formatSelfTestResult, selfTestExtractRoi } from '../video/selfTestExtractRoi';

/**
 * Test offline frame extraction and pixel access.
 * Runs self-test and basic analysis, logs results to console.
 */
export async function testOfflineExtraction(
  videoUri: string,
  durationMs: number = 3000
): Promise<{ selfTest: any; analysis: any }> {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  Testing Offline Video Frame Extraction                   ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  // Test 1: Self-Test
  console.log('Test 1/2: Self-test pixel extraction...\n');
  try {
    const selfTest = await selfTestExtractRoi(videoUri, durationMs);
    console.log(formatSelfTestResult(selfTest));

    if (!selfTest.success) {
      console.warn('⚠ Self-test did not fully succeed');
      if (selfTest.errors.length > 0) {
        console.error('Errors:');
        selfTest.errors.forEach((e) => console.error(`  • ${e}`));
      }
    } else {
      console.log('✓ Self-test PASSED\n');
    }

    // Test 2: Offline Analysis
    console.log('Test 2/2: Running offline analysis...\n');
    try {
      const analysis = await analyzeVideoOffline({
        videoUri,
        durationMs,
        fps: 120,
        roi: {
          x: 300,
          y: 700,
          w: 400,
          h: 300,
        },
        samplesPerSecond: 50, // Sample fewer for faster testing
      });

      console.log('═══════════════════════════════════════════════════════════');
      console.log('ANALYSIS RESULTS');
      console.log('═══════════════════════════════════════════════════════════');
      console.log(`Video: ${analysis.videoUri}`);
      console.log(`Duration: ${analysis.durationMs}ms`);
      console.log(`Samples collected: ${analysis.samplesCollected}`);
      console.log(`Events detected: ${analysis.eventsDetected}`);
      console.log('');

      if (analysis.estimatedGct !== undefined) {
        console.log(`✓ Ground Contact Time (GCT): ${analysis.estimatedGct}ms`);
      } else {
        console.log('✗ GCT: Not estimated');
      }

      if (analysis.estimatedFlight !== undefined) {
        console.log(`✓ Flight Time: ${analysis.estimatedFlight}ms`);
      } else {
        console.log('✗ Flight Time: Not estimated');
      }

      if (analysis.errors.length > 0) {
        console.log('');
        console.warn(`Errors during analysis (${analysis.errors.length}):`);
        analysis.errors.forEach((e) => console.warn(`  • ${e}`));
      }

      if (analysis.notes.length > 0) {
        console.log('');
        console.log('Notes:');
        analysis.notes.forEach((n) => console.log(`  • ${n}`));
      }

      console.log('═══════════════════════════════════════════════════════════\n');

      const success = analysis.success && selfTest.success;
      console.log(success ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED');
      console.log('');

      return { selfTest, analysis };
    } catch (err: any) {
      console.error('Analysis failed:', err.message || String(err));
      throw err;
    }
  } catch (err: any) {
    console.error('Self-test failed:', err.message || String(err));
    throw err;
  }
}

/**
 * Quick validation without full logging.
 */
export async function validateOfflineExtraction(
  videoUri: string,
  durationMs: number = 3000
): Promise<boolean> {
  try {
    const result = await selfTestExtractRoi(videoUri, durationMs);
    return result.success && result.frames.length > 0;
  } catch {
    return false;
  }
}

/**
 * Example: Call this from a dev button or app startup
 */
export async function quickDebugExtraction() {
  // This is a placeholder - in real use, get URI from file picker or test fixture
  const testVideoUri = 'file:///var/mobile/Containers/Data/Application/.../test_video.mov';

  try {
    const result = await testOfflineExtraction(testVideoUri, 3000);
    console.log('Test complete:', result);
  } catch (error) {
    console.error('Test failed:', error);
  }
}

/**
 * React Hook for integration into components
 */

export function useOfflineExtraction() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const test = async (videoUri: string, durationMs: number = 3000) => {
    setLoading(true);
    setError(null);

    try {
      const { selfTest, analysis } = await testOfflineExtraction(videoUri, durationMs);
      setResult({ selfTest, analysis });
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  return { loading, result, error, test };
}
