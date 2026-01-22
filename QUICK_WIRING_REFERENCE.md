# Quick Wiring Reference

## Entry Points
- **UI**: [app/(tabs)/index.tsx:runAnalysis()](app/(tabs)/index.tsx#L117) → picks video, calls analyzeVideo()
- **Main**: [analyzeVideo(uri)](src/analysis/analyzeVideo.ts#L1) → delegates to analyzePogoSideView() + applyConfidenceGate()
- **Real**: [analyzePogoSideView(uri, config)](src/analysis/pogoSideViewAnalyzer.ts#L638) → 11-stage pipeline

## 11-Stage Pipeline (pogoSideViewAnalyzer.ts)
1. **Frames**: sampleFramesForAnalysis() → pixelFrames[] (RGBA)
2. **Grayscale**: toGrayscaleFrames() → gray[] (for ground detector)
3. **Ground**: detectGround(gray) → GroundDetectorOutput (Hough + temporal)
4. **Ground→Model**: groundDetectorToModel() → GroundModel2D (hough_polar type)
5. **ROI**: inferRoiFromGround() → ROI + confidence (foot region location)
6. **Contact**: analyzeContactFromRoi(frames, roi, groundY) → analyzedFrames[], contactSignals[], rawSamples[]
7. **LowerBody**: trackLowerBody(frames, roi, groundY) → blob samples (confirmation)
8. **Foot**: extractFootRegion(frames, roi, groundY) → foot samples (confirmation)
9. **Events**: detectContactEventsFromSignal(rawSamples) → takeoffMs, landingMs (or undefined)
10. **Metrics**: deriveMetrics(frames, takeoffIdx, landingIdx) → gctSeconds, flightSeconds
11. **Return**: assemble JumpAnalysis (status="complete", measurementStatus="real")

Then: applyConfidenceGate() → enforce safety (may redact metrics)

## Key Functions (by module)

### Ground Detection [groundDetector.ts]
- `detectGround(grayscaleFrames)` → GroundDetectorOutput {detected, theta, rho, confidence, line, method, diagnostics}
- `inferRoiFromGround(grayscaleFrames, output)` → {roi, confidence}

### Contact Signal [pogoSideViewAnalyzer.ts]
- `analyzeContactFromRoi(pixelFrames, groundY, roi)` → {analyzedFrames, contactSignals, rawSamples, stats}
  - Per-frame: edgeEnergy + motionEnergy → contactScore
  - Output: inContact=true if contactScore ≥ 0.55

### Events [groundRoi.ts]
- `detectContactEventsFromSignal(samples: {tMs, contactScore}[])` → {takeoffMs?, landingMs?, contacts[], debugNotes}
  - Threshold: on@0.65, off@0.45, minContact@40ms, minFlight@40ms
  - Returns first takeoff (end of contact 0) and landing (start of contact 1)

### Metrics [pogoSideViewAnalyzer.ts]
- `deriveMetrics(frames, takeoffIdx, landingIdx)` → {gctSeconds, gctMs, flightSeconds}
  - GCT = takeoffTime - contactStartTime (walk back from takeoffIdx)
  - Flight = landingTime - takeoffTime

### Confirmation [pogoSideViewAnalyzer.ts]
- Lower body: centroid moving up + bottom dropped
- Foot region: area spike + density spike + strike bias shift

### Confidence [pogoSideViewAnalyzer.ts]
- Computed from: viewOk (ground conf > 0.3) + jointsTracked (contact ratio) + contactDetected (takeoff/landing exist) + ground confidence
- Stability penalty if contactScoreStd > 0.25
- Synthetic→real: reduce max confidence to 0.35

### Gating [confidenceGate.ts]
- Hard fail: synthetic, not complete, no evidence, low overall confidence, bad reliability, out-of-bounds
- Per-metric: redact if low confidence OR out-of-bounds
- Bounds: GCT ≤ 0.45s, Flight ≤ 0.9s

## Data Shapes

### PixelFrame (RGBA)
```typescript
{width, height, data: Uint8ClampedArray, tMs}
```

### AnalysisFrame
```typescript
{
  frameIndex, tMs,
  joints2d, ground: GroundModel2D,
  contact: {left: {inContact, confidence}, right?: {...}},
  derived?, confidence?
}
```

### RawContactSample
```typescript
{tMs, contactScore, edgeEnergy, motionEnergy, bottomBandEnergy}
```

### JumpAnalysis
```typescript
{
  version: "0.2.0",
  status: "pending" | "complete" | "error",
  measurementStatus: "real" | "synthetic_placeholder",
  metrics: {gctSeconds, gctMs, flightSeconds, footAngleDeg, ...},
  events: {takeoff, landing},
  frames: AnalysisFrame[],
  groundSummary: GroundModel2D,
  quality: {overallConfidence, notes, reliability},
  capture: {nominalFps, durationMs},
  debug: {contact, lowerBody, foot}
}
```

## Fail-Safe Gates

### In Analyzer (pogoSideViewAnalyzer.ts:657)
```typescript
if (groundModel.confidence < 0.3) {
  metrics = EMPTY_ANALYSIS.metrics  // all nulls
  events = {takeoff: {t: null, ...}, landing: {t: null, ...}}
}
```

### In Gate (confidenceGate.ts)
- Check 1: measurementStatus === "real" required
- Check 2: status === "complete" required
- Check 3: framesOk OR eventsOk required
- Check 4: overallConfidence ≥ dynamic threshold
- Check 5: Reliability (viewOk, jointsTracked, contactDetected)
- Check 6: Sanity (bounds, timing)
- Check 7: Per-metric confidence & bounds

**Result**: status="error" with metrics redacted, OR status="complete" with partial metrics

## UI Rendering Rule (index.tsx:303)
```typescript
if (status === "complete" && measurementStatus === "real") {
  // Show metrics (may have nulls from per-metric gating)
} else {
  // Show explanation: "Analysis pending" or "Insufficient confidence"
}
```

## Files for Label Mode + Evaluation

### Modify (preserve existing logic)
- jumpAnalysisContract.ts — add `labels?` field
- pogoSideViewAnalyzer.ts — add labelMode config
- confidenceGate.ts — add mode check to skip gating
- index.tsx — add UI toggle

### Create (new)
- labelingContract.ts — FrameLabel, EvaluationResult types
- labelingUtils.ts — matching, metrics functions
- evaluationEngine.ts — confusion matrix, precision/recall
- labelExport.ts — JSON/CSV export
- labelStore.ts — persistence (optional)

## ROI Luma Extractor Status
- **Location**: [src/video/roiLumaExtractor.ts](src/video/roiLumaExtractor.ts)
- **Native**: [ios/RoiLumaExtractor.swift](ios/RoiLumaExtractor.swift) + [ios/RoiLumaExtractor.m](ios/RoiLumaExtractor.m)
- **Status**: Complete, tested, but NOT YET integrated into main pipeline
- **Current path**: Full-frame RGBA sampling → inline RGBA→luma conversion in analyzers
- **Future path**: Could replace with ROI-only luma extraction for performance/determinism
