// docs/FRAME_DATA_ACCESS.md
# Frame Pixel Data Access Strategy

## Overview

The jump-tracker-app uses a multi-path strategy for accessing frame pixel data on iOS with Expo + react-native-vision-camera.

## Current Architecture

### 1. **Live Capture Path (VisionCamera Frame Processor)**

**Status**: Ready for implementation when frame.image pixel access available

**File**: `src/video/framePixelExtractor.ts`

**Components**:
- `extractPixelsFromVisionCameraFrame()`: Extracts RGBA → luminance conversion
- `extractLuminance()`: Downsamples full frame to grayscale
- `extractRoiLuminance()`: Extracts and downsamples ROI only
- `safeExtractPixels()`: Error-wrapped version for frame processor

**Data Format Output**: `PixelSample`
```typescript
{
  width: number              // Frame width
  height: number             // Frame height
  tMs: number                // Timestamp in milliseconds
  gray: Uint8Array           // Downsampled grayscale (luminance)
  roiSample?: {              // Optional ROI extraction
    x, y, w, h, data
  }
  dataFormat: "uint8"        // Always uint8 for now
  source: "vision-camera"    // Path identifier
}
```

**Integration Point**:
```typescript
// In frame processor (capture.tsx)
const pixelSample = extractPixelsFromVisionCameraFrame(
  frameData,
  frameWidth,
  frameHeight,
  Date.now(),
  { downsampleFactor: 4, roiOnly: false }
);

if (pixelSample) {
  // Use for contact score and ground line detection
  const contactScore = computeContactScoreFromPixels(
    pixelSample,
    roi.x, roi.y, roi.w, roi.h,
    groundY
  );
  const groundLine = detector.detectGroundLineFromPixels(pixelSample);
}
```

### 2. **Offline Analysis Path (AVFoundation, Future)**

**Status**: Template/placeholder for future implementation

**File**: `src/video/framePixelExtractor.ts`

**Function**: `extractPixelsFromAVFoundation()`

**When Needed**: Video file analysis, post-processing, debugging

**Implementation**: Requires native module calling AVFoundation
- Would extract frames at specific indices
- Return PixelSample with offline timestamps
- Called from analysis pipeline, not real-time

### 3. **Fallback Path (Manual Ground Line)**

**Status**: Currently active (pixel data extraction not yet available)

**Behavior**:
- User drags ground line manually on capture screen
- No pixel analysis needed for measurement
- Ground line stored in `overlayState.groundY`
- Used by all downstream analysis

## Platform Details

### iOS + VisionCamera v4

**Current Limitation**:
- `frame.image.toBase64()` not directly available in Expo environment
- Requires either:
  1. Custom native module using AVFoundation
  2. VisionCamera v5+ native frame access
  3. React Native video frame interceptor

**Performance Considerations**:
- Frame processor runs on a separate thread (non-blocking UI)
- Downsampling aggressive (4×4 blocks = 25% of pixels)
- Grayscale only (no chroma planes) → 1 byte per pixel
- Typical 120fps frame ~80KB raw → ~20KB downsampled

**CPU Impact** (estimated):
- Full frame extraction: ~5-10ms per frame @ 120fps
- Downsampled + ROI only: ~1-2ms per frame
- Contact score computation: ~2-3ms
- Total: ~5ms per 2 frames (throttled) → negligible at 120fps

### Thermal/Battery:
- Grayscale luminance conversion: low cost (no color space conversion)
- EMA smoothing: O(1) per frame
- Ground line detection: O(W×H/ds²) with downsampling

## Usage Pattern

### Frame Processor Integration

```typescript
const frameProcessor = useFrameProcessor((frame) => {
  try {
    // 1. Extract pixel data (when available)
    const pixelSample = safeExtractPixels(
      frameData,           // Will be empty until frame.image access available
      300,                 // Placeholder dimensions
      400,
      Date.now(),
      { downsampleFactor: 4 }
    );

    if (!pixelSample) {
      // Pixel data not available; use manual ground line
      return;
    }

    // 2. Compute contact score from pixels
    const { score } = computeContactScoreFromPixels(
      pixelSample,
      roi.x, roi.y, roi.w, roi.h,
      groundY
    );

    // 3. Detect ground line from pixels (optional auto-detection)
    if (autoDetectGround) {
      const ground = detector.detectGroundLineFromPixels(pixelSample);
      if (ground.confidence > 0.6) {
        setOverlayState(prev => ({ ...prev, groundY: ground.y }));
      }
    }

    // 4. Apply smoothing and store sample
    const smoothed = smoothContactScore(score, prevScore, 0.3);
    setCaptureSamples(prev => [...prev, {
      frameIndex,
      tMs: Date.now(),
      contactScore: smoothed,
      inContact: hysteresisState,
      groundY,
      roi
    }]);
  } catch (error) {
    console.error("Frame processor error:", error);
  }
}, [overlayState, autoDetectGround]);
```

## Error Handling

All extraction functions:
1. Validate input dimensions (> 0)
2. Clamp ROI to frame bounds
3. Return null on decode/format errors
4. Log warnings (debug mode only) to avoid spam
5. Never throw exceptions to frame processor

**Safety Pattern**:
```typescript
const sample = safeExtractPixels(...);
if (!sample) {
  // Gracefully skip frame; UI continues
  return;
}
// Use sample
```

## Future Enhancements

### When Frame.Image Access Available

1. **Implement `extractPixelsFromVisionCameraFrame()`**
   - Decode frame.image data (likely NV21 or YUV on iOS)
   - Extract Y-plane directly (already grayscale)
   - Skip RGB conversion overhead

2. **Per-Frame Statistics**
   - Store min/max/mean luminance for debugging
   - Compute motion vectors (frame-to-frame differences)
   - Track lighting stability

3. **Upgrade Edge Detection**
   - Implement Sobel operator instead of simple variance
   - Horizontal + vertical edge maps
   - More robust ground line detection

4. **Multi-Scale Analysis**
   - Different downsample factors for different ROIs
   - Coarse + fine detail tracking

### When Native Modules Available

1. **AVFoundation Integration**
   - Extract frames from video files
   - Batch offline analysis
   - Frame timing synchronization

2. **Hardware Acceleration**
   - MetalKit for downsampling
   - GPU edge detection

## Files Touched

- **New**:
  - `src/video/framePixelExtractor.ts` — Extraction utilities
  - `docs/FRAME_DATA_ACCESS.md` — This file

- **Modified**:
  - `src/video/contactScoreProcessor.ts` — Added `computeContactScoreFromPixels()`
  - `src/video/groundLineDetector.ts` — Added `detectGroundLineFromPixels()`
  - `app/(tabs)/capture.tsx` — Frame processor ready for integration

## Assumptions

1. **120 fps nominal**: Time calculations assume ~8.3ms per frame
2. **Side-view orientation**: Ground line in bottom 60-90% of frame
3. **Stable lighting**: Edge detection works on typical gym floors
4. **No perspective distortion**: Camera perpendicular to floor (user responsibility)

## Testing Checklist

- [ ] Frame processor doesn't block UI (measure via React Profiler)
- [ ] Contact score computation < 5ms per throttled frame
- [ ] Ground line detection converges within 30 frames
- [ ] Pixel extraction memory usage < 10MB (no leaks)
- [ ] Graceful fallback to manual ground line
- [ ] Error logging doesn't spam console
- [ ] 120fps capture doesn't thermal throttle device

## References

- **VisionCamera Docs**: https://react-native-vision-camera.com/
- **AVFoundation**: Apple's native video framework
- **Luminance Weights**: ITU-R BT.601 standard (0.299R + 0.587G + 0.114B)
- **Downsampling**: 4×4 blocks reduce data by 93.75% with minimal quality loss
