/**
 * Example: How to Integrate Label Mode into Your Analysis Screen
 * 
 * This shows how to use AnalysisDebugHarness to add label mode capability
 * to your existing offline analysis UI.
 */

// ============================================================
// EXAMPLE 1: Wrapping Existing Analysis Component
// ============================================================

// import React, { useState, useEffect } from 'react';
// import { View } from 'react-native';
// import { analyzePickedVideo } from '../analysis/pipelineExample';
// import { AnalysisDebugHarness } from '../components/AnalysisDebugHarness';
// import type { JumpAnalysis } from '../analysis/jumpAnalysisContract';
//
// export function OfflineAnalysisScreen({ route }: { route: any }) {
//   const { videoUri } = route.params;
//   const [analysis, setAnalysis] = useState<JumpAnalysis | null>(null);
//   const [frames, setFrames] = useState<Array<{ tMs: number }>>([]);
//
//   useEffect(() => {
//     (async () => {
//       // Run analysis
//       const result = await analyzePickedVideo(videoUri);
//       setAnalysis(result);
//
//       // Extract frames (from your frame extraction logic)
//       // For now, create dummy frame objects with timestamps
//       const dummyFrames = Array.from({ length: 300 }, (_, i) => ({
//         tMs: i * (120000 / 300), // 120fps = ~8.3ms per frame
//       }));
//       setFrames(dummyFrames);
//     })();
//   }, [videoUri]);
//
//   return (
//     <AnalysisDebugHarness
//       videoUri={videoUri}
//       frames={frames}
//       jumpAnalysis={analysis}
//     >
//       <View style={{ flex: 1, padding: 16 }}>
//         <Text>Video: {videoUri}</Text>
//         <Text>Status: {analysis?.status}</Text>
//         <Text>GCT: {analysis?.metrics.gctSeconds?.toFixed(3)}s</Text>
//         <Text>Flight: {analysis?.metrics.flightSeconds?.toFixed(3)}s</Text>
//         {/* ...rest of your UI... */}
//       </View>
//     </AnalysisDebugHarness>
//   );
// }

// ============================================================
// EXAMPLE 2: Direct Label Mode Access (for testing)
// ============================================================

// import React, { useState } from 'react';
// import { View, TouchableOpacity, Text } from 'react-native';
// import { LabelModePanel } from '../components/LabelModePanel';
// import { analyzePickedVideo } from '../analysis/pipelineExample';
//
// export function TestLabelingScreen() {
//   const [showLabelMode, setShowLabelMode] = useState(false);
//   const [videoUri] = useState('file://path/to/video.mov');
//   const [analysis, setAnalysis] = useState(null);
//   const [frames, setFrames] = useState([]);
//
//   const startLabeling = async () => {
//     // Run analysis
//     const result = await analyzePickedVideo(videoUri);
//     setAnalysis(result);
//
//     // Create frame array
//     const frameCount = 300;
//     const fps = 120;
//     const dummyFrames = Array.from({ length: frameCount }, (_, i) => ({
//       tMs: (i * 1000) / fps,
//     }));
//     setFrames(dummyFrames);
//
//     setShowLabelMode(true);
//   };
//
//   if (showLabelMode) {
//     return (
//       <LabelModePanel
//         videoUri={videoUri}
//         frames={frames}
//         jumpAnalysis={analysis}
//         onClose={() => setShowLabelMode(false)}
//       />
//     );
//   }
//
//   return (
//     <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
//       <TouchableOpacity onPress={startLabeling}>
//         <Text>Start Labeling</Text>
//       </TouchableOpacity>
//     </View>
//   );
// }

// ============================================================
// EXAMPLE 3: Programmatic Label Access (for batch evaluation)
// ============================================================

// import {
//   loadVideoLabels,
//   addLabel,
//   evaluateEvents,
//   formatErrorMetrics,
//   type Label,
//   type AutoEvent,
// } from '../analysis/labelStorage';
//
// async function batchEvaluate(videoUris: string[]) {
//   for (const uri of videoUris) {
//     // Load ground-truth labels
//     const labelData = await loadVideoLabels(uri);
//     if (!labelData || !labelData.labels.length) {
//       console.log(`No labels for ${uri}`);
//       continue;
//     }
//
//     // Load auto analysis
//     const analysis = await analyzePickedVideo(uri);
//
//     // Extract auto events
//     const autoEvents: AutoEvent[] = [];
//     if (analysis.events.takeoff.t !== null) {
//       autoEvents.push({
//         type: 'takeoff',
//         tMs: analysis.events.takeoff.t * 1000,
//         confidence: analysis.events.takeoff.confidence ?? 0,
//       });
//     }
//     if (analysis.events.landing.t !== null) {
//       autoEvents.push({
//         type: 'landing',
//         tMs: analysis.events.landing.t * 1000,
//         confidence: analysis.events.landing.confidence ?? 0,
//       });
//     }
//
//     // Evaluate
//     const result = evaluateEvents(labelData.labels, autoEvents);
//     
//     // Print results
//     console.log(`\n=== ${uri} ===`);
//     console.log(formatErrorMetrics('Landing', result.metrics.landing));
//     console.log(formatErrorMetrics('Takeoff', result.metrics.takeoff));
//     if (result.metrics.gct) {
//       console.log(formatErrorMetrics('GCT', result.metrics.gct));
//     }
//   }
// }

// ============================================================
// EXAMPLE 4: Manual Label Creation (for test fixtures)
// ============================================================

// import { saveVideoLabels, type Label } from '../analysis/labelStorage';
//
// async function createTestLabels() {
//   const videoUri = 'file://test_video.mov';
//   
//   // Define ground truth: landing at 150ms, takeoff at 300ms
//   const labels: Label[] = [
//     { type: 'landing', tMs: 150 },
//     { type: 'takeoff', tMs: 300 },
//   ];
//
//   await saveVideoLabels(videoUri, labels);
//   console.log('Test labels saved');
// }

// ============================================================
// EXAMPLE 5: Error Inspection
// ============================================================

// import { evaluateEvents } from '../analysis/labelStorage';
//
// function inspectErrors(labels, autoEvents) {
//   const result = evaluateEvents(labels, autoEvents);
//
//   console.log('=== Matched Pairs ===');
//   result.matchedPairs.forEach(pair => {
//     console.log(
//       `${pair.label.type} @ ${pair.label.tMs}ms => ` +
//       `auto @ ${pair.auto.tMs}ms (error: ${pair.errorMs.toFixed(1)}ms)`
//     );
//   });
//
//   if (result.unmatchedLabels.length > 0) {
//     console.log('\n=== False Negatives (Missed) ===');
//     result.unmatchedLabels.forEach(label => {
//       console.log(`${label.type} @ ${label.tMs}ms - NOT DETECTED`);
//     });
//   }
//
//   if (result.unmatchedAuto.length > 0) {
//     console.log('\n=== False Positives (Spurious) ===');
//     result.unmatchedAuto.forEach(auto => {
//       console.log(`${auto.type} @ ${auto.tMs}ms (conf=${auto.confidence.toFixed(2)}) - UNLABELED`);
//     });
//   }
//
//   console.log('\n=== Metrics ===');
//   console.log(result.metrics);
// }

// ============================================================
// FILE MANIFEST
// ============================================================

/**
 * New files created:
 *
 * 1. src/analysis/labelStorage.ts
 *    - Label interface and types
 *    - Storage functions (load, save, add, clear)
 *    - Event matching and evaluation logic
 *    - Error metric computation
 *
 * 2. src/components/LabelModePanel.tsx
 *    - Frame navigation (prev/next)
 *    - Mark Landing / Takeoff buttons
 *    - Labels list view
 *    - Evaluation metrics display
 *
 * 3. src/components/AnalysisDebugHarness.tsx
 *    - Wrapper component for analysis screens
 *    - Floating debug button (📝)
 *    - Toggles between standard view and label mode
 *
 * 4. ACCURACY_VALIDATION.md
 *    - Complete labeling guide
 *    - Error computation explanation
 *    - Acceptance targets for pogo hops
 *    - Rejection criteria and troubleshooting
 *    - Best practices
 */

// ============================================================
// QUICK API REFERENCE
// ============================================================

/**
 * Storage:
 *   loadVideoLabels(uri) → VideoLabels | null
 *   saveVideoLabels(uri, labels) → Promise<void>
 *   addLabel(uri, label) → Promise<void>
 *   clearVideoLabels(uri) → Promise<void>
 *
 * Types:
 *   Label: { type: 'landing' | 'takeoff', tMs: number, confidence?: number }
 *   VideoLabels: { videoId, videoUri, labels[], createdAt, updatedAt }
 *   AutoEvent: { type, tMs, confidence }
 *   EvaluationResult: { matchedPairs[], unmatchedLabels[], metrics: {...} }
 *   ErrorMetrics: { count, medianMs, p95Ms, minMs, maxMs, meanMs }
 *
 * Evaluation:
 *   evaluateEvents(labels, autoEvents, toleranceMs=50) → EvaluationResult
 *   formatErrorMetrics(name, metrics) → string
 *
 * UI:
 *   <LabelModePanel videoUri, frames, jumpAnalysis, onClose>
 *   <AnalysisDebugHarness videoUri, frames, jumpAnalysis>
 *     {children}
 *   </AnalysisDebugHarness>
 */

export const LABEL_MODE_EXAMPLES = true;

