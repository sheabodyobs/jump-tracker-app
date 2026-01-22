# ROI Luma Extractor - Device Integration Checklist

## Pre-Integration Verification ✅

- [x] TypeScript strict mode: PASS
- [x] ESLint validation: PASS
- [x] All 4 files created successfully
  - [x] `ios/RoiLumaExtractor.swift` (650+ lines)
  - [x] `ios/RoiLumaExtractor.m` (30 lines)
  - [x] `src/video/roiLumaExtractor.ts` (450+ lines)
  - [x] `src/video/__tests__/roiLumaExtractor.test.ts` (300+ lines)
- [x] Documentation complete
  - [x] `docs/ROI_LUMA_EXTRACTOR.md` (600+ lines)
  - [x] `OFFLINE_ROI_LUMA_IMPLEMENTATION.md` (comprehensive summary)

## Build Integration Steps

### 1. Link Native Module in Xcode

**Location**: `ios/jumptrackerapp.xcodeproj`

In Xcode:
1. Open `ios/jumptrackerapp.xcodeproj`
2. Select target `jumptrackerapp`
3. Build Phases → Compile Sources
4. Add these files:
   - [ ] `RoiLumaExtractor.swift`
   - [ ] `RoiLumaExtractor.m`
5. Verify linked libraries include React Native core

### 2. Configure Swift-Objective-C Bridging

Check `jumptrackerapp-Bridging-Header.h`:
- [ ] Ensure it exists in `ios/jumptrackerapp/`
- [ ] Verify it includes Swift exports:
  ```objective-c
  //
  //  jumptrackerapp-Bridging-Header.h
  //

  #ifndef jumptrackerapp_Bridging_Header_h
  #define jumptrackerapp_Bridging_Header_h

  #import <React/RCTBridgeModule.h>

  #endif /* jumptrackerapp_Bridging_Header_h */
  ```

### 3. Verify Swift Module Naming

In `RoiLumaExtractor.swift`, confirm at top:
```swift
import Foundation
import AVFoundation
import React
```

The `@objc class RoiLumaExtractor` should be automatically exposed via `RCT_EXPORT_MODULE()`

### 4. Build & Test

```bash
# From workspace root
cd ios

# Clean build folder
xcodebuild clean -workspace jumptrackerapp.xcworkspace -scheme jumptrackerapp

# Build for simulator or device
xcodebuild build -workspace jumptrackerapp.xcworkspace \
  -scheme jumptrackerapp \
  -configuration Debug \
  -sdk iphonesimulator

# Check for Swift compilation errors
```

### 5. Verify Native Module Registration

In React Native code (JS):
```typescript
import { NativeModules } from 'react-native';

const { RoiLumaExtractor } = NativeModules;

if (!RoiLumaExtractor) {
  console.error('RoiLumaExtractor native module not found!');
} else {
  console.log('✅ RoiLumaExtractor module ready');
}
```

## Runtime Testing

### Phase 1: Module Availability (No Real Video)

```typescript
// src/video/__tests__/roiLumaExtractor.test.ts
import { runAllRoiLumaTests } from '../roiLumaExtractor.test';

// Run in JS context
await runAllRoiLumaTests();
// Expected: 10 PASS, 1 SKIP (determinism requires device video)
```

### Phase 2: Minimal Native Call (Sim or Device)

Create a simple test that calls the native module:

```typescript
// Test file
import { NativeModules } from 'react-native';

const { RoiLumaExtractor } = NativeModules;

async function testNativeModuleAvailable() {
  try {
    // Call with minimal params to verify module is linked
    const result = await RoiLumaExtractor.extractRoiLumaFrames({
      uri: 'file:///nonexistent.mov',  // Will fail, but module called
      roi: { x: 0, y: 0, width: 100, height: 100, space: 'pixels' },
      timestampsMs: [0],
      targetSize: { width: 96, height: 64 }
    });
    
    console.error('Unexpected success (file should not exist)');
  } catch (error) {
    // Expected: "URI not found" or similar
    console.log('✅ Native module callable, error:', error.message);
  }
}
```

### Phase 3: Real Video Testing

**Prerequisite**: iOS device or simulator with sample video file

```typescript
// After getting real video URI from file system or Photos
import { extractRoiLumaFrames } from '../video/roiLumaExtractor';

async function testRealVideo() {
  const videoUri = 'file:///path/to/slow-mo-video.mov';
  
  const result = await extractRoiLumaFrames(
    videoUri,
    { x: 100, y: 150, width: 400, height: 300, space: 'pixels' },
    [0, 100, 200, 300, 400, 500],  // 6 frames at 100ms intervals
    { width: 96, height: 64 }
  );

  if (result.ok) {
    console.log(`✅ Extracted ${result.frames.length} frames`);
    console.log(`   Duration: ${result.durationMs}ms`);
    console.log(`   FPS: ${result.nominalFps}`);
    
    for (const frame of result.frames) {
      console.log(`   Frame at ${frame.tMsActual}ms: ${frame.width}x${frame.height}, ${frame.gray.length} bytes`);
    }
  } else {
    console.error(`❌ Extraction failed: [${result.error.code}] ${result.error.message}`);
  }
}
```

### Phase 4: Determinism Validation

```typescript
async function validateDeterminism() {
  const videoUri = 'file:///path/to/video.mov';
  const roi = { x: 100, y: 150, width: 400, height: 300 };
  const timestamps = [500];  // Single frame
  
  const extractions: Uint8Array[] = [];
  
  // Extract 3 times
  for (let i = 0; i < 3; i++) {
    const result = await extractRoiLumaFrames(videoUri, roi, timestamps);
    if (result.ok) {
      extractions.push(result.frames[0].gray);
    }
  }
  
  // Verify byte-identical
  const bytes0 = new Uint8Array(extractions[0]);
  const bytes1 = new Uint8Array(extractions[1]);
  const bytes2 = new Uint8Array(extractions[2]);
  
  const identical01 = bytes0.every((v, i) => v === bytes1[i]);
  const identical12 = bytes1.every((v, i) => v === bytes2[i]);
  
  if (identical01 && identical12) {
    console.log('✅ DETERMINISM VALIDATED: 3 extractions are byte-identical');
  } else {
    console.error('❌ Determinism failed: extractions differ');
  }
}
```

## Xcode Build Troubleshooting

### Issue: "RCT_EXTERN_METHOD not found"
**Solution**: 
- Verify `RoiLumaExtractor.m` is in Compile Sources
- Check Bridging Header exists and is specified in build settings
- Ensure Swift header generation is enabled

### Issue: "RoiLumaExtractor is not defined"
**Solution**:
- Check RoiLumaExtractor.swift is in Compile Sources
- Verify @objc class declaration at top of file
- Check for Swift syntax errors (run swift compiler directly)

### Issue: "NativeModules.RoiLumaExtractor is undefined"
**Solution**:
- Ensure both .swift and .m files are compiled
- Rebuild from clean: `xcodebuild clean -workspace jumptrackerapp.xcworkspace`
- Check app log for linking errors

## Integration with Analysis Pipeline

After device testing confirms functionality:

### 1. Update `src/analysis/pogoSideViewAnalyzer.ts`

Add ROI luma extraction before metrics calculation:

```typescript
import { extractRoiLumaFrames } from '../video/roiLumaExtractor';

// In analysis function
const roiLumaResult = await extractRoiLumaFrames(
  videoUri,
  groundModel.roiSpec,  // Use detected ground ROI
  timestampsMs,
  { width: 96, height: 64 }
);

if (!roiLumaResult.ok) {
  return { status: 'complete', metrics: { ...nulls... } };  // Fail-safe
}

// Process luma frames
const lumaFrames = roiLumaResult.frames;
// ... use for analysis ...
```

### 2. Update `jumpAnalysisContract.ts`

May add new analysis result type:

```typescript
interface AnalysisMetricsWithRoiFrames extends AnalysisMetrics {
  roiLumaFrames?: RoiLumaFrame[];  // Raw luma data for downstream
}
```

## Post-Integration Verification

- [ ] App builds without errors on iOS simulator
- [ ] App builds without errors on iOS device
- [ ] `NativeModules.RoiLumaExtractor` accessible in JS
- [ ] Can extract frames from test video file
- [ ] Extracted frames have correct dimensions
- [ ] Determinism test passes (3 extractions byte-identical)
- [ ] Performance acceptable (<500ms for 30 frames)
- [ ] ph:// support works (tested with Photos asset)
- [ ] Temp files cleaned up after ph:// extraction
- [ ] Error handling works (bad URI → error, not crash)

## Performance Targets

- **Per-frame extraction**: 5–10ms
- **Batch (30 frames)**: 150–300ms
- **Memory peak**: <20 MB (ROI + downsampling only, no full-frame buffering)

## Next Steps (After Validation)

1. ✅ **Code Complete**: All files written and validated
2. ⏳ **Device Build**: Link in Xcode and compile
3. ⏳ **Runtime Testing**: Test with real video on device/simulator
4. ⏳ **Determinism Validation**: Verify byte-identical output
5. ⏳ **Integration**: Wire into analysis pipeline
6. ⏳ **Performance Profiling**: Measure real-world speed
7. ⏳ **User Testing**: Test with user-picked slow-mo videos

## Reference Files

| File | Purpose |
|------|---------|
| [ios/RoiLumaExtractor.swift](ios/RoiLumaExtractor.swift) | Native iOS module |
| [ios/RoiLumaExtractor.m](ios/RoiLumaExtractor.m) | Objective-C bridge |
| [src/video/roiLumaExtractor.ts](src/video/roiLumaExtractor.ts) | TypeScript wrapper |
| [src/video/__tests__/roiLumaExtractor.test.ts](src/video/__tests__/roiLumaExtractor.test.ts) | Tests |
| [docs/ROI_LUMA_EXTRACTOR.md](docs/ROI_LUMA_EXTRACTOR.md) | Full API reference |
