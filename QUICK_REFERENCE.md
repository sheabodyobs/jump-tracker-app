# QUICK REFERENCE: Offline Analysis Pipeline

**Reconnaissance Complete** | 2026-01-21 | No Code Changes Made

---

## CALL CHAIN (Video URI → JumpAnalysis)

```
app/(tabs)/index.tsx
  │
  ├─ pickVideo()
  │   └─ ImagePicker → setVideoUri(uri)
  │
  └─ runAnalysis()
      └─ analyzeVideo(videoUri)
          [src/analysis/analyzeVideo.ts LINE 25]
          │
          ├─ try: analyzePogoSideView(uri)
          │   [src/analysis/pogoSideViewAnalyzer.ts LINE 634]
          │   │
          │   ├─ sampleFramesForAnalysis(uri) [LINE 642]
          │   │   └─ iosAvFoundationFrameProvider.sampleFrames()
          │   │       └─ pixelFrames: PixelFrame[]
          │   │
          │   ├─ toGrayscaleFrames(pixelFrames) [LINE 658]
          │   │
          │   ├─ detectGround(grayscaleFrames) [LINE 659]
          │   │   └─ GroundDetectorOutput
          │   │
          │   ├─ inferRoiFromGround(...) [LINE 669] or computeGroundAndRoi (fallback)
          │   │   └─ roi: { x, y, w, h }
          │   │
          │   ├─ analyzeContactFromRoi(pixelFrames, groundLineY, roi) [LINE 703]
          │   │   └─ RawContactSample[], ContactSignal[]
          │   │   [WILL BE REPLACED: computeContactSignal(pixelFrames, roi, options)]
          │   │
          │   ├─ trackLowerBody(extractedFrames, roi, groundLineY) [LINE 707]
          │   │   └─ BlobSample[]
          │   │
          │   ├─ extractFootRegion(extractedFrames, roi, groundLineY) [LINE 722]
          │   │   └─ FootSample[]
          │   │
          │   ├─ detectContactEventsFromSignal(rawSamples) [LINE 753]
          │   │   └─ { takeoffMs, landingMs }
          │   │
          │   ├─ [multi-stage confirmation logic] [LINE 768-825]
          │   │   └─ confirmedTakeoff, confirmedLanding
          │   │
          │   ├─ deriveMetrics(analyzedFrames, takeoffIndex, landingIndex) [LINE 826]
          │   │   └─ { gctSeconds, gctMs, flightSeconds, footAngleDeg }
          │   │
          │   └─ return JumpAnalysis (complete, with all metrics)
          │
          ├─ catch error → return MOCK_ANALYSIS with error status
          │
          └─ applyConfidenceGate(draft) [LINE 60]
              [src/analysis/confidenceGate.ts]
              │
              ├─ Check: viewOk, groundDetected, jointsTracked, contactDetected
              │
              ├─ Hard fail: status="error", metrics=null
              │   (if overall confidence < 0.6 OR missing critical evidence)
              │
              └─ Soft fail: status="complete", redact per-metric
                  (if confidence > 0.6 but some metrics low confidence)

  └─ return JumpAnalysis
      └─ setAnalysis(result)
          [UI renders to screen, always safe]
```

---

## KEY FILES AT A GLANCE

| File | Purpose | Status |
|------|---------|--------|
| **analyzeVideo.ts** | Entry point | ✓ Entry |
| **pogoSideViewAnalyzer.ts** | Main pipeline | ⚠️ Will modify |
| **contactSignal.ts** | Contact state machine | ✓ Created |
| **groundDetector.ts** | Ground line detection | ✓ Complete |
| **confidenceGate.ts** | Metric gating | ✓ Complete |
| **jumpAnalysisContract.ts** | Schema | ✓ Stable |
| **iosAvFoundationFrameProvider.ts** | Frame extraction (native) | ✓ Used |
| **lowerBodyTracker.ts** | Confirmation logic | ✓ Used |
| **footRegionExtractor.ts** | Confirmation logic | ✓ Used |

---

## DATA SHAPES

### Input: URI
```
videoUri: string (file path or URI)
```

### Intermediate: Frames
```
pixelFrames: PixelFrame[] = {
  width: number,
  height: number,
  data: Uint8ClampedArray,
  tMs: number
}
```

### Ground Model
```
GroundModel2D = 
  | { type: "hough_polar", theta, rho, confidence, line, ... }
  | { type: "line2d", a, b, confidence }
  | { type: "y_scalar", y, confidence }
  | { type: "unknown", confidence: 0 }
```

### Contact Signal (NEW)
```
ContactSignal = {
  score: number[],
  scoreSmoothed: number[],
  state: (0 | 1)[],
  thresholds: { enter, exit },
  confidence: number,
  diagnostics: { norm, chatterCount }
}
```

### Raw Samples (Diagnostics)
```
RawContactSample = {
  tMs: number,
  contactScore: number,
  edgeEnergy: number,
  motionEnergy: number,
  bottomBandEnergy: number
}
```

### Output: JumpAnalysis
```
JumpAnalysis = {
  version: "0.2.0",
  status: "complete" | "error" | "pending",
  metrics: { gctSeconds, gctMs, flightSeconds, footAngleDeg },
  events: { takeoff, landing },
  frames: AnalysisFrame[],
  groundSummary: GroundModel2D,
  quality: { overallConfidence, reliability, notes },
  debug: { contact, lowerBody, foot }
}
```

---

## CRITICAL INTEGRATION POINTS

### 1. Frame Entry
**File**: pogoSideViewAnalyzer.ts **Line**: 642  
**What**: `sampleFramesForAnalysis(uri)` returns pixelFrames

### 2. Ground Detection
**File**: pogoSideViewAnalyzer.ts **Line**: 659  
**What**: `detectGround(grayscaleFrames)` produces GroundModel2D

### 3. ROI Inference
**File**: pogoSideViewAnalyzer.ts **Line**: 669  
**What**: `inferRoiFromGround()` or legacy fallback produces roi

### 4. Contact Signal (TO BE WIRED)
**File**: pogoSideViewAnalyzer.ts **Line**: 703  
**What**: `analyzeContactFromRoi()` → will become `computeContactSignal()`

### 5. Event Detection
**File**: pogoSideViewAnalyzer.ts **Line**: 753  
**What**: `detectContactEventsFromSignal()` detects takeoff/landing

### 6. Confidence Gate
**File**: analyzeVideo.ts **Line**: 60  
**What**: `applyConfidenceGate()` redacts unsafe metrics

---

## WHAT TO MODIFY IN PHASE 5

**File**: [src/analysis/pogoSideViewAnalyzer.ts](src/analysis/pogoSideViewAnalyzer.ts)

**Change 1: Add import** (line ~20)
```typescript
import { computeContactSignal, type RawFrame } from "./contactSignal";
```

**Change 2: Remove old type** (line ~32)
```typescript
// DELETE: type ContactSignal = { inContact: boolean; confidence: number }
```

**Change 3: Replace function** (line 411-485)
```typescript
// DELETE: function analyzeContactFromRoi(...) { ... }

// KEEP: But simplify to adapt contactSignalResult to old event pipeline
```

**Change 4: Wire new module** (line 703)
```typescript
// OLD:
const { analyzedFrames, contactSignals, rawSamples, stats } = analyzeContactFromRoi(...)

// NEW:
const contactSignalResult = computeContactSignal(pixelFrames, roi, { ... });
// Map result to rawSamples and contactSignals for downstream code
```

---

## PHASE 5 CHECKLIST

- [ ] Import `computeContactSignal` into pogoSideViewAnalyzer.ts
- [ ] Remove `analyzeContactFromRoi()` function
- [ ] Wire `computeContactSignal()` call at line 703
- [ ] Map state (0|1)[] to event detection pipeline
- [ ] Run: `npx tsc --noEmit`
- [ ] Run: `npm run lint`
- [ ] Run tests
- [ ] Manual QA with real video
- [ ] Verify metrics match baseline behavior
- [ ] Commit and document changes

---

## DOCUMENTATION GENERATED

1. **INTEGRATION_WIRING_MAP.md** (509 lines)
   - Complete call graph
   - Data shapes for each stage
   - File-by-file breakdown

2. **FILES_TO_MODIFY.md** (250 lines)
   - Specific line ranges to change
   - Phase 5, 6, 7 roadmap
   - Risk assessment

3. **QUICK_REFERENCE.md** (this document)
   - At-a-glance summary
   - Call chain visualization
   - Checklist for Phase 5

---

**STATUS**: ✓ Ready for Phase 5 implementation.  
**NO CODE CHANGES MADE** in this reconnaissance pass.  
**ALL MAPS AND REFERENCES GENERATED**.

