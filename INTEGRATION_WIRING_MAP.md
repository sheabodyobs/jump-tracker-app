# Integration Wiring Map — Jump Tracker Offline Analysis Pipeline

**Date**: 2026-01-21  
**Version**: Phase 4-5 (Ground + ROI + Contact Signal) 

---

## 1. ENTRYPOINTS FOR OFFLINE ANALYSIS

### 1.1 UI Trigger
**File**: [app/(tabs)/index.tsx](app/(tabs)/index.tsx)  
**Function**: `pickVideo()` → `runAnalysis()`

```
pickVideo()
  └─ ImagePicker.launchImageLibraryAsync()
      └─ setVideoUri(uri: string)

runAnalysis()
  └─ analyzeVideo(videoUri)  [LINE 127]
      └─ setAnalysis(result)
```

### 1.2 Main Analysis Entry
**File**: [src/analysis/analyzeVideo.ts](src/analysis/analyzeVideo.ts)  
**Function**: `export async analyzeVideo(uri: string): Promise<JumpAnalysis>`

```typescript
analyzeVideo(uri)
  1. Try analyzePogoSideView(uri)  [LINE 29]
  2. Catch → fallback to MOCK_ANALYSIS with error status
  3. Apply confidence gate: applyConfidenceGate(draft)  [LINE 60]
  4. Return JumpAnalysis (always conforms to contract v0.2.0)
```

### 1.3 Pogo Side-View Analyzer (Real Pipeline)
**File**: [src/analysis/pogoSideViewAnalyzer.ts](src/analysis/pogoSideViewAnalyzer.ts)  
**Function**: `export async analyzePogoSideView(uri: string, config?: GroundRoiConfig): Promise<JumpAnalysis>`

**Stage 1: Frame Extraction**
```
analyzePogoSideView(uri)
  ├─ sampleFramesForAnalysis(uri)  [LINE 275]
  │   ├─ iosAvFoundationFrameProvider.sampleFrames(uri)  [iOS native]
  │   └─ convertToPixelFrames()
  │       └─ decodeBase64(frame.dataBase64) → Uint8ClampedArray
  └─ pixelFrames: PixelFrame[] = { width, height, data, tMs }
```

---

## 2. GROUND DETECTION PIPELINE

**File**: [src/analysis/groundDetector.ts](src/analysis/groundDetector.ts)

**Stage**: Camera-invariant ground line detection (Hough polar transform + temporal clustering)

```
toGrayscaleFrames(pixelFrames)  [pogoSideViewAnalyzer LINE 658]
  └─ grayscaleFrames: { width, height, data }[]

detectGround(grayscaleFrames)  [pogoSideViewAnalyzer LINE 659]
  ├─ Hough accumulator (rho, theta)
  ├─ Temporal clustering for persistence
  └─ GroundDetectorOutput = {
        detected: boolean,
        theta: number | null,
        rho: number | null,
        confidence: number,
        line: { x1, y1, x2, y2 } | null,
        diagnostics?: { ... }
     }

groundDetectorToModel(groundDetectorOutput)  [pogoSideViewAnalyzer LINE 660]
  └─ GroundModel2D = 
       | { type: "hough_polar", theta, rho, confidence, line, ... }
       | { type: "unknown", confidence: 0 }

Confidence Gate [pogoSideViewAnalyzer LINE 664]
  if (groundModel.confidence < 0.3) → use legacy ground inference
```

---

## 3. ROI INFERENCE PIPELINE

**File**: [src/analysis/roiInference.ts](src/analysis/roiInference.ts) **(NEW)**

**Stage**: Detect foot ROI by motion energy maximization above ground line

```
inferRoiFromGround(grayscaleFrames, groundDetectorOutput)
  [pogoSideViewAnalyzer LINE 669]
  └─ DEPRECATED: Old ROI inference from ground line slope

NEW: computeContactSignal() will use:
  inferRoiFromMotion(pixelFrames, groundModel, options)  [roiInference.ts]
    ├─ computeMotionEnergyInRoi(frames, roi)
    ├─ Sliding window search above ground
    └─ RoiInference = {
         roi: { x, y, w, h },
         confidence: number,
         diagnostics: { ... }
       }
```

**Current interim behavior** (pogoSideViewAnalyzer):
```
if (groundConfident && groundDetectorOutput.line)
  roi = inferRoiFromGround(...)  // OLD logic
else
  roi = computeGroundAndRoi(...).roi  // Legacy fallback
```

---

## 4. CONTACT SIGNAL COMPUTATION

**File**: [src/analysis/contactSignal.ts](src/analysis/contactSignal.ts) **(NEW)**

**Stage**: Motion energy → normalized score → hysteresis state machine → contact events

```
CURRENT (analyzeContactFromRoi, pogoSideViewAnalyzer LINE 411):
  pixelFrames, groundLineY, roi
    ├─ extractRoiLuma(frame, roi)
    ├─ computeEdgeEnergy(luma, w, h)
    ├─ computeBottomBandEnergy(luma, w, h)
    └─ contactScore = edge * (1 - motion)
         [Simple normalization + thresholding]
    └─ ContactSignal[] = { inContact, confidence }

WIRED (when contactSignal.ts replaces analyzeContactFromRoi):
  pixelFrames, roi, groundModel
    └─ computeContactSignal(pixelFrames, roi, options)
         ├─ computeMotionEnergyInRoi(frames, roi)
         ├─ normalizeScore(scores, method: "medianMAD" | "percentile")
         ├─ applyEmaSmoothing(scores, alpha)
         ├─ applyHysteresis(smoothed, enterThreshold, exitThreshold, minStateFrames)
         └─ ContactSignal = {
              score: number[],
              scoreSmoothed: number[],
              state: (0 | 1)[],
              thresholds: { enter, exit },
              confidence: number,
              diagnostics: { norm, chatterCount }
            }
```

---

## 5. EVENT EXTRACTION PIPELINE

**Files**: 
- [src/analysis/groundRoi.ts](src/analysis/groundRoi.ts) — `detectContactEventsFromSignal()`
- [src/analysis/pogoSideViewAnalyzer.ts](src/analysis/pogoSideViewAnalyzer.ts) — confirmation logic + metrics derivation

**Stage**: Contact state → takeoff/landing events → confirmed events → metrics

```
RAW SAMPLES (from analyzeContactFromRoi):
  rawSamples: RawContactSample[] = {
    tMs,
    contactScore,
    edgeEnergy,
    motionEnergy,
    bottomBandEnergy
  }

EVENT DETECTION:
  detectContactEventsFromSignal(rawSamples.map(s => ({tMs, contactScore})))
    [pogoSideViewAnalyzer LINE 753]
    └─ ContactEvents = {
         takeoffMs: number | undefined,
         landingMs: number | undefined,
         eventSignals?: array of contact transitions
       }

CONFIRMATION (multi-stage):
  1. Lower-body confirmation (lowerBodyTracker)
  2. Foot-region confirmation (footRegionExtractor)
  3. Biomechanical validation
     └─ Takeoff: centroidMovingUp + bottomDropped
     └─ Landing: areaSpike + bottomSpike

METRICS DERIVATION:
  deriveMetrics(analyzedFrames, takeoffIndex, landingIndex)
    [pogoSideViewAnalyzer LINE 789]
    └─ Metrics = {
         gctSeconds,
         gctMs,
         flightSeconds,
         footAngleDeg: { takeoff, landing, confidence }
       }
```

---

## 6. CONFIDENCE GATING & OUTPUT

**File**: [src/analysis/confidenceGate.ts](src/analysis/confidenceGate.ts)

**Stage**: Hard fail or metric-level redaction based on confidence

```
applyConfidenceGate(draft: JumpAnalysis) [analyzeVideo LINE 60]
  1. Check reliability flags:
     ├─ viewOk: groundModel.type !== "unknown" && confidence > 0.3
     ├─ groundDetected: groundModel.confidence > 0
     ├─ jointsTracked: trackedRatio >= 0.6 (from lowerBodyTracker)
     └─ contactDetected: typeof takeoff === "number" && typeof landing === "number"

  2. Hard fail if:
     └─ Overall confidence < 0.6 OR missing required evidence
       └─ status = "error", metrics redacted to nulls

  3. Soft fail (partial metrics):
     ├─ Status = "complete"
     ├─ Per-metric gating:
     │   ├─ gct: redact if confidence < 0.65
     │   ├─ flight: redact if confidence < 0.65
     │   ├─ events: redact if confidence < 0.7
     │   └─ footAngle: redact if confidence < 0.7
     └─ Bounds checking:
         ├─ gctSeconds <= 0.45
         └─ flightSeconds <= 0.9

  4. UI rendering invariant:
     └─ JumpAnalysis always valid (never undefined/null)
       → Fallback to EMPTY_ANALYSIS if anything fails
```

---

## 7. DATA FLOW SUMMARY

### Frame Data Shape
```
PixelFrame {
  width: number,
  height: number,
  data: Uint8ClampedArray (grayscale luma),
  tMs: number
}
```

### Ground Model Shape
```
GroundModel2D = 
  | { type: "hough_polar", theta, rho, line, confidence, method, diagnostics }
  | { type: "line2d", a, b, confidence }
  | { type: "y_scalar", y, confidence }
  | { type: "unknown", confidence }
```

### ROI Shape
```
ROI = {
  x: number,
  y: number,
  w: number,
  h: number
}
```

### Contact Signal Shape (NEW)
```
ContactSignal = {
  score: number[],           // raw motion energy
  scoreSmoothed: number[],   // after EMA + normalization
  state: (0 | 1)[],          // binary contact/flight after hysteresis
  thresholds: { enter, exit },
  confidence: number,        // 0..1 based on energy + stability
  diagnostics: {
    norm: { type, values... },
    chatterCount: number
  }
}
```

### Raw Contact Sample Shape
```
RawContactSample = {
  tMs: number,
  contactScore: number,
  edgeEnergy: number,
  motionEnergy: number,
  bottomBandEnergy: number
}
```

### Final JumpAnalysis Shape
```
JumpAnalysis = {
  version: "0.2.0",
  status: "complete" | "error" | "pending",
  measurementStatus: "real" | "synthetic_placeholder",
  
  metrics: {
    gctSeconds: number | null,
    gctMs: number | null,
    flightSeconds: number | null,
    footAngleDeg: { takeoff, landing, confidence }
  },
  
  events: {
    takeoff: { t, frame, confidence },
    landing: { t, frame, confidence }
  },
  
  frames: AnalysisFrame[],
  groundSummary: GroundModel2D,
  
  quality: {
    overallConfidence: number,
    reliability: {
      viewOk: boolean,
      groundDetected: boolean,
      jointsTracked: boolean,
      contactDetected: boolean
    },
    notes: string[]
  },
  
  debug: {
    contact: { ... },
    lowerBody: { ... },
    foot: { ... }
  }
}
```

---

## 8. FILES TO MODIFY FOR EACH PHASE

### Phase 5: Contact Signal Integration (NEXT)

**Files to MODIFY**:
1. [src/analysis/pogoSideViewAnalyzer.ts](src/analysis/pogoSideViewAnalyzer.ts)
   - Replace `analyzeContactFromRoi()` with new contact signal pipeline
   - Wire `computeContactSignal()` from contactSignal.ts
   - Keep event extraction logic, but feed contact state instead of contact score

**Files to ADD**:
- [src/analysis/contactSignal.ts](src/analysis/contactSignal.ts) ✓ (already created)
- [src/analysis/__tests__/contactSignal.test.ts](src/analysis/__tests__/contactSignal.test.ts) ✓ (already created)

**Files UNCHANGED**:
- analyzeVideo.ts (already routes through analyzePogoSideView)
- confidenceGate.ts (confidence logic unchanged)
- jumpAnalysisContract.ts (schema unchanged)

---

### Phase 6: Label Mode + Evaluation (FUTURE)

**Files to ADD**:
1. [src/analysis/labelMode.ts](src/analysis/labelMode.ts) (NEW)
   - UI overlay for frame-by-frame annotation
   - Ground truth tagging (takeoff/landing frames)
   - Export labeled dataset

2. [src/analysis/evaluationEngine.ts](src/analysis/evaluationEngine.ts) (NEW)
   - Compare predicted events vs. labeled ground truth
   - Compute precision, recall, F1
   - Per-metric error analysis

3. [src/analysis/__tests__/evaluationEngine.test.ts](src/analysis/__tests__/evaluationEngine.test.ts)
   - Test metrics computation correctness

**Files to MODIFY**:
- jumpAnalysisContract.ts
  - Add optional `groundTruth` field to AnalysisFrame
  - Add `evaluation` section to JumpAnalysis output

- pogoSideViewAnalyzer.ts
  - Check for label-mode flag in config
  - If in label mode, preserve frames without early gating

- app/(tabs)/index.tsx
  - Add "Enable Label Mode" toggle
  - Render label UI overlay on video playback

---

### Phase 7: Performance Optimization (FUTURE)

**Files to MODIFY**:
- pogoSideViewAnalyzer.ts
  - Frame downsampling pipeline
  - ROI-only extraction path (reuse roiLumaExtractor.ts)
  - Early termination on low confidence

- roiInference.ts
  - Optional decimation of motion energy map

- contactSignal.ts
  - Optional variable-alpha EMA (tighter during contact)

---

## 9. CRITICAL INTEGRATION POINTS

### 9.1 Where `pixelFrames` Enters
**pogoSideViewAnalyzer.ts LINE 638-642**
```typescript
const { pixelFrames, batch, measurementStatus, nominalFps } = await sampleFramesForAnalysis(uri);
```

### 9.2 Where Ground is Computed
**pogoSideViewAnalyzer.ts LINE 658-660**
```typescript
const grayscaleFrames = toGrayscaleFrames(pixelFrames);
const groundDetectorOutput = detectGround(grayscaleFrames);
const groundModel = groundDetectorToModel(groundDetectorOutput);
```

### 9.3 Where Contact Signal Currently Computed
**pogoSideViewAnalyzer.ts LINE 703-704**
```typescript
const { analyzedFrames, contactSignals, rawSamples, stats } = analyzeContactFromRoi(
  pixelFrames,
  groundLineY,
  roi
);
```

### 9.4 Where Events are Detected
**pogoSideViewAnalyzer.ts LINE 753**
```typescript
const contactEvents = detectContactEventsFromSignal(
  rawSamples.map((s) => ({ tMs: s.tMs, contactScore: s.contactScore }))
);
```

### 9.5 Where Metrics are Derived
**pogoSideViewAnalyzer.ts LINE 789**
```typescript
const metrics = deriveMetrics(analyzedFrames, takeoffIndex ?? -1, landingIndex ?? -1);
```

### 9.6 Where Confidence Gate is Applied
**analyzeVideo.ts LINE 60**
```typescript
return applyConfidenceGate(draft);
```

---

## 10. MODULE DEPENDENCIES

```
app/(tabs)/index.tsx
  └─ analyzeVideo(uri)
       ├─ analyzePogoSideView(uri)
       │    ├─ sampleFramesForAnalysis() → iosAvFoundationFrameProvider
       │    ├─ detectGround() → groundDetector.ts
       │    ├─ inferRoiFromGround() → groundDetector.ts
       │    ├─ analyzeContactFromRoi() [REPLACE WITH]
       │    │    └─ computeContactSignal() → contactSignal.ts (NEW)
       │    ├─ trackLowerBody() → lowerBodyTracker.ts
       │    ├─ extractFootRegion() → footRegionExtractor.ts
       │    ├─ detectContactEventsFromSignal() → groundRoi.ts
       │    ├─ deriveMetrics() → pogoSideViewAnalyzer.ts (local)
       │    └─ return JumpAnalysis
       │
       └─ applyConfidenceGate(draft)
            └─ confidenceGate.ts
                 └─ return gated JumpAnalysis

jumpAnalysisContract.ts (canonical schema)
  ├─ JumpAnalysis (output)
  ├─ AnalysisFrame (per-frame data)
  ├─ GroundModel2D (ground variant)
  └─ RawContactSample (diagnostic)
```

---

## 11. NEXT IMPLEMENTATION STEPS

### Step 1: Wire contactSignal.ts into pogoSideViewAnalyzer.ts
- Import `computeContactSignal` from contactSignal.ts
- Replace `analyzeContactFromRoi()` call with:
  ```typescript
  const contactSignalResult = computeContactSignal(pixelFrames, roi, {
    emaAlpha: 0.2,
    normMethod: 'medianMAD',
    enterThreshold: 0.3,
    exitThreshold: 0.15,
    minStateFrames: 2
  });
  ```
- Map contactSignalResult.state → rawSamples for event detection

### Step 2: Validate no regression
- Run full test suite
- Manual QA on real video

### Step 3: Optimize (later)
- ROI-only pixel extraction path
- Frame decimation
- Early termination

---

**END OF MAP**
