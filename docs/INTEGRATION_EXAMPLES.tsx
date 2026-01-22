/**
 * INTEGRATION_EXAMPLES.ts
 * 
 * Quick reference for using offline video frame extraction.
 * Copy/paste these examples into your app as needed.
 */

/**
 * EXAMPLE 1: Basic Extraction
 * Extract a single ROI grayscale frame from a video file.
 */
async function example_basicExtraction() {
  import { extractRoiGray } from './src/video/extractRoiGray';

  const videoUri = 'file:///var/mobile/Containers/Data/Application/.../video.mov';
  const timeMs = 1500; // 1.5 seconds

  try {
    const frame = await extractRoiGray(
      videoUri,
      timeMs,
      200,  // ROI x
      400,  // ROI y
      400,  // ROI width
      300,  // ROI height
      96,   // Output width (downsampled)
      64    // Output height (downsampled)
    );

    console.log(`Extracted frame at ${frame.tMs}ms`);
    console.log(`Size: ${frame.width}x${frame.height}`);
    console.log(`Grayscale bytes: ${frame.gray.length}`);
  } catch (error: any) {
    console.error('Extraction failed:', error.message);
  }
}

/**
 * EXAMPLE 2: Self-Test (Validation)
 * Verify pixel access is working by extracting multiple frames.
 */
async function example_selfTest() {
  import {
    selfTestExtractRoi,
    formatSelfTestResult,
  } from './src/video/selfTestExtractRoi';

  const videoUri = 'file:///path/to/video.mov';
  const durationMs = 3000; // Video is 3 seconds

  const result = await selfTestExtractRoi(videoUri, durationMs);
  console.log(formatSelfTestResult(result));

  if (result.success) {
    console.log('✓ Pixel access is working!');
    console.log(`  Extracted ${result.totalFrames} / ${result.frames.length + result.errors.length} frames`);
  } else {
    console.error('✗ Some extractions failed:');
    result.errors.forEach((e) => console.error(`  - ${e}`));
  }
}

/**
 * EXAMPLE 3: Full Offline Analysis
 * Analyze an entire video: detect ground line, compute contact score, find events.
 */
async function example_fullAnalysis() {
  import { analyzeVideoOffline } from './src/video/offlineAnalysis';

  const result = await analyzeVideoOffline({
    videoUri: 'file:///path/to/slo-mo-video.mov',
    durationMs: 3000,
    fps: 120, // Slo-mo frame rate
    roi: {
      x: 300,  // Foot region, bottom-center
      y: 700,
      w: 400,
      h: 300,
    },
    outputSize: { w: 96, h: 64 }, // Optional, defaults shown
    contactThreshold: 0.6,         // Optional
    samplesPerSecond: 100,         // Optional, sample fewer frames for speed
  });

  console.log(`Samples collected: ${result.samplesCollected}`);
  console.log(`Events detected: ${result.eventsDetected}`);

  if (result.estimatedGct !== undefined) {
    console.log(`Ground contact time: ${result.estimatedGct}ms`);
  }
  if (result.estimatedFlight !== undefined) {
    console.log(`Flight time: ${result.estimatedFlight}ms`);
  }

  if (result.errors.length > 0) {
    console.warn('Errors during analysis:');
    result.errors.forEach((e) => console.warn(`  - ${e}`));
  }

  console.log('Analysis notes:');
  result.notes.forEach((n) => console.log(`  - ${n}`));
}

/**
 * EXAMPLE 4: Compute Statistics
 * Extract one frame and analyze its intensity distribution.
 */
async function example_statistics() {
  import {
    extractRoiGray,
    computeMeanIntensity,
    computeVariance,
    computeStdDev,
    computeHistogram,
  } from './src/video/extractRoiGray';

  const frame = await extractRoiGray(
    'file:///path/to/video.mov',
    1500,
    200, 400, 400, 300,
    96, 64
  );

  const mean = computeMeanIntensity(frame.gray);
  const variance = computeVariance(frame.gray);
  const stdDev = computeStdDev(frame.gray);
  const histogram = computeHistogram(frame.gray);

  console.log(`Mean intensity: ${mean.toFixed(1)}`);
  console.log(`Variance: ${variance.toFixed(1)}`);
  console.log(`Standard deviation: ${stdDev.toFixed(1)}`);
  console.log(`Histogram peak bucket: ${histogram.indexOf(Math.max(...histogram))}`);
}

/**
 * EXAMPLE 5: UI Integration (React)
 * Use offline analysis in a React component.
 */
import React, { useState } from 'react';
import { Button, Text, ActivityIndicator, ScrollView } from 'react-native';
import { DocumentPickerAsset } from 'expo-document-picker';
import * as DocumentPicker from 'expo-document-picker';

export function OfflineAnalysisScreen() {
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const pickAndAnalyzeVideo = async () => {
    try {
      setAnalyzing(true);
      setError(null);

      // Pick video from device
      const doc = await DocumentPicker.getDocumentAsync({
        type: 'video/*',
      });

      if (doc.canceled || !doc.assets[0]) {
        setAnalyzing(false);
        return;
      }

      const videoUri = doc.assets[0].uri;
      const durationMs = 3000; // Assume 3 seconds (or get actual duration)

      // Run analysis
      const { analyzeVideoOffline } = await import('./src/video/offlineAnalysis');
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
      });

      setResult(analysis);
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <ScrollView style={{ padding: 16, backgroundColor: '#fff' }}>
      <Text style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 16 }}>
        Offline Video Analysis
      </Text>

      <Button
        title={analyzing ? 'Analyzing...' : 'Pick & Analyze Video'}
        onPress={pickAndAnalyzeVideo}
        disabled={analyzing}
      />

      {analyzing && <ActivityIndicator size="large" style={{ marginTop: 16 }} />}

      {error && (
        <Text style={{ color: 'red', marginTop: 16 }}>
          Error: {error}
        </Text>
      )}

      {result && (
        <>
          <Text style={{ fontSize: 16, fontWeight: 'bold', marginTop: 16 }}>
            Results
          </Text>

          <Text>Samples: {result.samplesCollected}</Text>
          <Text>Events: {result.eventsDetected}</Text>

          {result.estimatedGct !== undefined && (
            <Text>GCT: {result.estimatedGct}ms</Text>
          )}

          {result.estimatedFlight !== undefined && (
            <Text>Flight: {result.estimatedFlight}ms</Text>
          )}

          <Text style={{ marginTop: 12, fontStyle: 'italic' }}>
            {result.success ? 'Analysis complete' : 'Analysis incomplete'}
          </Text>
        </>
      )}
    </ScrollView>
  );
}

/**
 * EXAMPLE 6: Development/Debug
 * Add a debug button to your app to test extraction.
 */
async function debugButton_testExtraction() {
  import { selfTestExtractRoi, formatSelfTestResult } from './src/video/selfTestExtractRoi';

  // Get a video URI from somewhere (file picker, test fixtures, etc.)
  const videoUri = 'file:///path/to/test/video.mov';

  console.log('Testing offline extraction...');
  const result = await selfTestExtractRoi(videoUri, 3000);
  console.log(formatSelfTestResult(result));
}

export {
  example_basicExtraction,
  example_selfTest,
  example_fullAnalysis,
  example_statistics,
  debugButton_testExtraction,
};
