# Offline Video Frame Extraction (iOS)

## Overview

This module provides offline pixel access from iOS video files using AVFoundation. It enables analysis of slow-motion videos picked from the device library without requiring live capture.

**Architecture:**
```
User picks video (file://)
    ↓
extractRoiGray (JS) → RoiGrayExtractor (native Swift)
    ↓
AVAssetImageGenerator → Extract frame at timestamp
    ↓
Crop to ROI → Convert to grayscale → Downsample
    ↓
Base64 encode → Return to JS
    ↓
Decode base64 → Uint8Array (PixelSample format)
    ↓
Biomechanical analysis (ground detection, contact scoring)
```

## Files

### Native Code

- **`ios/RoiGrayExtractor.swift`** (430 lines)
  - Main implementation using AVFoundation
  - `extractRoiGray()` function accepts video URI, timestamp, ROI bounds, output size
  - Returns base64-encoded grayscale bytes
  - Supports `file://` URIs; `ph://` (Photos library) not yet supported

- **`ios/RoiGrayExtractor.m`** (25 lines)
  - Objective-C bridge for React Native module registration
  - Declares method signature for JS interface

### JavaScript Code

- **`src/video/extractRoiGray.ts`** (180 lines)
  - Wrapper around native module
  - Decodes base64 to `Uint8Array`
  - Type-safe return: `RoiGrayFrame` interface
  - Utility functions: `computeMeanIntensity()`, `computeVariance()`, `computeStdDev()`, `computeHistogram()`
  - Error handling: `RoiGrayError` interface

- **`src/video/offlineAnalysis.ts`** (260 lines)
  - High-level analysis orchestration
  - `analyzeVideoOffline()` function processes entire video
  - Integrates ground detection + contact scoring
  - Detects landing/takeoff events
  - Estimates GCT and flight time

- **`src/video/selfTestExtractRoi.ts`** (210 lines)
  - Self-test and validation utility
  - Samples 10 timestamps uniformly across video
  - Computes statistics: mean, variance, standard deviation, histogram
  - `formatSelfTestResult()` for pretty-printing results
  - Validates that pixel access is working

## Usage

### Basic Extraction

```typescript
import { extractRoiGray } from './src/video/extractRoiGray';

const frame = await extractRoiGray(
  'file:///var/mobile/Containers/.../video.mov', // Video URI
  1500,                                            // Time in ms
  200,  // ROI origin X
  400,  // ROI origin Y
  400,  // ROI width
  300,  // ROI height
  96,   // Output width (downsampled)
  64    // Output height (downsampled)
);

console.log(`Frame at ${frame.tMs}ms`);
console.log(`Intensity: mean=${computeMeanIntensity(frame.gray)}, var=${computeVariance(frame.gray)}`);
```

### Self-Test

```typescript
import { selfTestExtractRoi, formatSelfTestResult } from './src/video/selfTestExtractRoi';

const result = await selfTestExtractRoi(
  'file:///path/to/video.mov',
  3000  // Duration in ms
);

console.log(formatSelfTestResult(result));
```

Expected output:
```
═══════════════════════════════════════════════════════════
[selfTestExtractRoi] ✓ PASS
───────────────────────────────────────────────────────────
Video: file:///...
Extracted frames: 10 / 10
Duration: 142ms

Frame Statistics:
  Time (ms) │ Mean │ Variance │ StdDev │ Peak │ Notes
  ──────────┼──────┼──────────┼────────┼──────┼────────────────────────
        0 │ 87.3 │      156 │   12.5 │  85  │ Dark frame; 
      333 │ 92.1 │      189 │   13.7 │  87  │ 
      ...
```

### Full Offline Analysis

```typescript
import { analyzeVideoOffline } from './src/video/offlineAnalysis';

const result = await analyzeVideoOffline({
  videoUri: 'file:///path/to/video.mov',
  durationMs: 3000,
  fps: 120,
  roi: {
    x: 300,    // Foot region, bottom-center
    y: 700,
    w: 400,
    h: 300,
  },
});

console.log(`GCT: ${result.estimatedGct}ms`);
console.log(`Flight: ${result.estimatedFlight}ms`);
console.log(`Samples: ${result.samplesCollected}, Events: ${result.eventsDetected}`);
```

## Native Module Integration

### Step 1: Copy Files

Place the native files in the iOS project:
```
ios/RoiGrayExtractor.swift
ios/RoiGrayExtractor.m
```

### Step 2: Link to React Native

If using **Expo managed workflow**, you may need to:
1. Eject with `expo prebuild` (or use bare React Native)
2. Xcode will auto-discover `.swift` and `.m` files if in the right folder
3. Ensure the files are added to target: **Build Phases → Compile Sources**

If using **bare React Native**, link manually in Xcode:
1. Open `RCTBridging-Header.h`
2. Import: `#import "RoiGrayExtractor.h"` (auto-generated)

### Step 3: Handle Limitations

**Limitations:**
- `file://` URIs are fully supported
- `ph://` (Photos library) URIs are **not yet supported**
  - Workaround: Save video to app Documents folder first, then use `file://` path
  - Alternative: Use Photo Picker library to save to temp directory
- Frame timestamps have ±1 frame tolerance (due to AVAssetImageGenerator)

### Step 4: Verify on Device

Test the self-test function:
```typescript
// In a dev button or temporary debug path:
const result = await selfTestExtractRoi(videoUri, 3000);
console.log(formatSelfTestResult(result));
```

If all frames extract successfully and intensity varies across timestamps, the module is working.

## Performance

### Per-Frame Cost
- **Extraction**: ~50ms (IO + CGImage generation)
- **Conversion to grayscale**: ~10ms
- **Downsampling to 96×64**: ~5ms
- **Base64 encoding**: ~10ms
- **JS decode**: ~5ms
- **Total per frame**: ~80ms (varies by device and frame size)

### Memory
- 96×64 grayscale ROI: 6 KB
- Output buffer: ~20 KB (base64 + temp)
- No accumulation; per-frame processing

### Optimization Tips
- Sample fewer timestamps (e.g., every 5 frames instead of every frame)
- Reduce output size (e.g., 64×48 instead of 96×64)
- Use on background thread (already done in `analyzeVideoOffline`)

## Troubleshooting

### "Native module not found"
- Ensure `ios/RoiGrayExtractor.swift` and `.m` are in Xcode project
- Clean and rebuild: `cd ios && rm -rf Pods && pod install && cd .. && xcodebuild clean -workspace ios/RNApp.xcworkspace -scheme RNApp`

### "Invalid file URI"
- Ensure URI starts with `file://`
- Check file exists: `ls $(echo 'uri' | sed 's|file://||')`

### "ROI outside image bounds"
- Verify ROI coordinates are within video frame
- Use smaller ROI or adjust coordinates

### "All extractions failed"
- Try with a known good video first
- Check system logs: `xcrun simctl spawn booted log stream --predicate 'process == "YourApp"'`

### Extraction is slow (~200ms per frame)
- Normal on older devices (iPhone 11, 12)
- Sample fewer frames (increase `sampleInterval` in `analyzeVideoOffline`)
- Reduce output size (96×64 → 64×48)

## Future Enhancements

1. **Photos Library Support**
   - Use `PHAsset` and `PHImageRequestOptions` to load from `ph://` URIs
   - Requires additional permissions in `Info.plist`

2. **GPU Acceleration**
   - Use Metal or SceneKit for grayscale + downsample (reduce to ~10ms)

3. **YUV Direct Extraction**
   - Extract Y-plane directly from H.264 video without decoding full RGBA (reduce to ~20ms)

4. **Batch Processing**
   - Load multiple frames into memory, process in parallel

5. **Edge Detection**
   - Implement Sobel/Canny on native side (faster than JS variance calculation)

## Testing Checklist

- [ ] Build iOS app successfully (`xcodebuild -workspace ios/RNApp.xcworkspace -scheme RNApp`)
- [ ] `npx tsc --noEmit` passes
- [ ] `npm run lint` passes
- [ ] Pick a slo-mo video from device library or simulator
- [ ] Call `selfTestExtractRoi()` with video URI
- [ ] Verify: all 10 samples extract successfully
- [ ] Verify: mean intensity varies across frames
- [ ] Call `analyzeVideoOffline()` on same video
- [ ] Verify: events detected and GCT/flight estimated
- [ ] Manual test: use in capture UI (if integrated)

## API Reference

### RoiGrayExtractor (Native, Swift)

```swift
func extractRoiGray(
  _ uri: String,
  timeMs: NSNumber,
  roiX: NSNumber, roiY: NSNumber, roiW: NSNumber, roiH: NSNumber,
  outW: NSNumber, outH: NSNumber,
  resolver: RCTPromiseResolveBlock,
  rejecter: RCTPromiseRejectBlock
)
```

**Parameters:**
- `uri`: Video file path (e.g., `file:///path/to/video.mov`)
- `timeMs`: Timestamp in milliseconds (e.g., `1500`)
- `roiX, roiY, roiW, roiH`: ROI bounds in video pixel coordinates
- `outW, outH`: Output grayscale frame dimensions
- `resolver`: Resolves with `{ actualTimeMs, width, height, bytesBase64 }`
- `rejecter`: Rejects with error code and message

**Returns:**
```typescript
{
  actualTimeMs: number,      // Actual frame time (may differ by ±1 frame)
  width: number,             // Output width (== outW)
  height: number,            // Output height (== outH)
  bytesBase64: string        // Base64-encoded grayscale bytes
}
```

### extractRoiGray (JS)

```typescript
async function extractRoiGray(
  uri: string,
  timeMs: number,
  roiX: number,
  roiY: number,
  roiW: number,
  roiH: number,
  outW?: number,
  outH?: number
): Promise<RoiGrayFrame>
```

**Returns:**
```typescript
interface RoiGrayFrame {
  tMs: number;               // Actual frame timestamp
  width: number;
  height: number;
  gray: Uint8Array;          // Grayscale bytes (0..255)
  uri?: string;              // Source video URI
}
```

### analyzeVideoOffline (JS)

```typescript
async function analyzeVideoOffline(
  config: OfflineAnalysisConfig
): Promise<OfflineAnalysisResult>
```

**Input:**
```typescript
interface OfflineAnalysisConfig {
  videoUri: string;
  durationMs: number;
  fps: number;
  roi: { x: number; y: number; w: number; h: number };
  outputSize?: { w: number; h: number };
  contactThreshold?: number;
  groundY?: number;
  samplesPerSecond?: number;
}
```

**Output:**
```typescript
interface OfflineAnalysisResult {
  success: boolean;
  videoUri: string;
  durationMs: number;
  samplesCollected: number;
  eventsDetected: number;
  estimatedGct?: number;    // milliseconds
  estimatedFlight?: number; // milliseconds
  samples: LiveCaptureSample[];
  events: LiveCaptureEvent[];
  errors: string[];
  notes: string[];
}
```

## Confidence & Reliability

- **Ground line detection**: Confidence 0..1 based on edge stability (see `groundLineDetector.ts`)
- **Contact scoring**: Confidence 0..1 based on pixel band analysis
- **Event detection**: Hysteresis threshold (default 0.60) to prevent bouncing
- **GCT/Flight estimates**: Only returned if ≥2 events detected

All metrics are gated by `confidenceGate.ts` before display to prevent leakage of unreliable data.

---

**Status:** Ready for integration (requires iOS build + native module linking)
