# Implementation Map: Offline Analysis Pipeline

**Purpose**: Identify real integration points and minimal file changes for wiring the next layer (label mode + evaluation).

**Status**: Reconnaissance complete. No code changes in this document.

---

## 1. Entry Points for Offline Analysis

### 1.1 Main UI Entry
**File**: [app/(tabs)/index.tsx](app/(tabs)/index.tsx#L117)
**Function**: `runAnalysis()`
- Calls `analyzeVideo(videoUri)` 
- Sets `analysis` state with result
- Renders metrics/events based on `safe.status` and `safe.measurementStatus`

```
User picks video
  ↓
app/(tabs)/index.tsx:runAnalysis()
  ↓
analyzeVideo(uri) → JumpAnalysis
  ↓
UI renders (metrics/events hidden unless status="complete" AND measurementStatus="real")
```

### 1.2 Analysis Pipeline Entry
**File**: [src/analysis/analyzeVideo.ts](src/analysis/analyzeVideo.ts#L1)
**Function**: `analyzeVideo(uri: string) → Promise<JumpAnalysis>`
- Wrapper that delegates to `analyzePogoSideView(uri)`
- Applies `applyConfidenceGate()` on result
- Catches errors and returns safe JumpAnalysis

**Call sequence**:
```
analyzeVideo(uri)
  ↓
analyzePogoSideView(uri)  [Main analyzer]
  ↓
applyConfidenceGate()     [Safety enforcement]
  ↓
return JumpAnalysis
```

### 1.3 Real Analysis Pipeline
**File**: [src/analysis/pogoSideViewAnalyzer.ts](src/analysis/pogoSideViewAnalyzer.ts#L638)
**Function**: `analyzePogoSideView(uri: string, config?: GroundRoiConfig) → Promise<JumpAnalysis>`

**High-level stages**:
1. **Frame Sampling**: `sampleFramesForAnalysis(uri)` → `pixelFrames[]`, `ExtractedFrameBatch`
2. **Ground Detection**: `detectGround(grayscaleFrames)` → `GroundDetectorOutput`
3. **Ground→Model Conversion**: `groundDetectorToModel()` → `GroundModel2D`
4. **ROI Inference**: `inferRoiFromGround(grayscaleFrames, groundDetectorOutput)` → ROI + confidence
5. **Contact Signal**: `analyzeContactFromRoi(pixelFrames, groundLineY, roi)` → contact frames + signal
6. **Lower Body Confirmation**: `trackLowerBody(extractedFrames, roi, groundY)` → blob samples
7. **Foot Region Extraction**: `extractFootRegion(extractedFrames, roi, groundY)` → foot samples
8. **Event Extraction**: `detectContactEventsFromSignal(rawSamples)` → takeoff/landing timestamps
9. **Metrics Derivation**: `deriveMetrics(analyzedFrames, takeoffIdx, landingIdx)` → gctSeconds, flightSeconds
10. **Confidence & Gating**: Compute `overallConfidence`, apply fail-safe gates
11. **Return**: Assembled `JumpAnalysis` with status="complete"

---

## 2. ROI Luma Extractor Integration Points

### 2.1 Native Module Call
**File**: [src/video/roiLumaExtractor.ts](src/video/roiLumaExtractor.ts)
**Function**: `extractRoiLumaFrames(uri, roi, timestampsMs, targetSize?, options?) → Promise<RoiLumaResult>`

**Currently NOT used in main pipeline** — exists as standalone utility for future offline ROI extraction.

**Where it could be wired**:
- As alternative frame provider (post-ground detection, pre-contact analysis)
- For deterministic per-frame ROI analysis (replacing current RGBA → luma inline conversion)

### 2.2 Current Frame Path (RGBA)
**File**: [src/analysis/pogoSideViewAnalyzer.ts](src/analysis/pogoSideViewAnalyzer.ts#L254)
**Function**: `sampleFramesForAnalysis(uri)` → `PixelFrame[]` with RGBA data
- iOS: `iosAvFoundationFrameProvider.sampleFrames()` → full-frame RGBA
- Web: Canvas extraction → full-frame RGBA
- Luma conversion happens inline in analyzers: `extractRoiLuma(frame, roi)` → Float32Array

**Key converters** (in pogoSideViewAnalyzer.ts):
- `toGrayscaleFrames()`: RGBA → Uint8ClampedArray (for ground detection)
- `extractRoiLuma()`: PixelFrame + ROI → Float32Array (for contact analysis)

---

## 3. Current GCT / FlightSeconds / Events Computation

### 3.1 Contact Score → Contact Frames
**File**: [src/analysis/pogoSideViewAnalyzer.ts](src/analysis/pogoSideViewAnalyzer.ts#L412)
**Function**: `analyzeContactFromRoi(pixelFrames, groundLineY, roi)`

**Computes per-frame**:
```typescript
edgeEnergy = computeEdgeEnergy(luma, roiW, roiH)           // Sobel edges
motionEnergy = ||luma - prevLuma||                         // Frame diff
bottomBandEnergy = computeBottomBandEnergy(luma, roiW, roiH)

// Contact score combines edge + inverse motion
contactScore = edgeEnergy * (1 - normalizedMotion)
inContact = contactScore >= CONTACT_FRAME_THRESHOLD (0.55)
```

**Output**: 
- `analyzedFrames: AnalysisFrame[]` — per-frame data with contact.left.inContact
- `rawSamples: RawContactSample[]` — contactScore time series
- `stats: { contactScoreMin, contactScoreMax, contactScoreMean, contactScoreStd, ... }`

### 3.2 Event Extraction (Takeoff/Landing)
**File**: [src/analysis/groundRoi.ts](src/analysis/groundRoi.ts#L96)
**Function**: `detectContactEventsFromSignal(samples: {tMs, contactScore}[])`

**Algorithm**:
- Threshold-based contact transitions (onThreshold=0.65, offThreshold=0.45)
- Finds 2+ contact periods (ground contact + flight + re-contact)
- Returns `{ takeoffMs?, landingMs?, contacts[], debugNotes[] }`

### 3.3 Contact Confirmation
**File**: [src/analysis/pogoSideViewAnalyzer.ts](src/analysis/pogoSideViewAnalyzer.ts#L757)
**Functions**: Multi-stage confirmation
- Lower body: checks centroid movement & bottom band energy
- Foot region: checks foot area spike, density spike, strike bias shift

**Result**: `confirmedTakeoff` and `confirmedLanding` (may be undefined if rejected)

### 3.4 Metrics Derivation
**File**: [src/analysis/pogoSideViewAnalyzer.ts](src/analysis/pogoSideViewAnalyzer.ts#L540)
**Function**: `deriveMetrics(frames: AnalysisFrame[], takeoffIndex, landingIndex)`

```typescript
// Find contact start (walk back from takeoffIndex)
while (frames[contactStart-1].contact.left.inContact) contactStart--

gctSeconds = (takeoffTime - contactStartTime) / 1000
flightSeconds = (landingTime - takeoffTime) / 1000
```

**Output**: `{ gctSeconds, gctMs, flightSeconds }`

---

## 4. Confidence Gate & Fail-Safe Design

### 4.1 Fail-Safe in Analyzer
**File**: [src/analysis/pogoSideViewAnalyzer.ts](src/analysis/pogoSideViewAnalyzer.ts#L657)
**Mechanism**: Ground confidence threshold
```typescript
const GROUND_CONFIDENCE_THRESHOLD = 0.3
const groundConfident = groundModel.confidence >= GROUND_CONFIDENCE_THRESHOLD

if (!groundConfident) {
  // No metrics
  metricsGated = EMPTY_ANALYSIS.metrics  // all nulls
  eventsGated = { takeoff: {t: null, ...}, landing: {t: null, ...} }
}
```

### 4.2 Confidence Gate (Hard Policy)
**File**: [src/analysis/confidenceGate.ts](src/analysis/confidenceGate.ts#L1)
**Function**: `applyConfidenceGate(draft: JumpAnalysis, override?: Partial<GateConfig>) → JumpAnalysis`

**Check sequence**:
1. `measurementStatus !== "real"` → hard fail
2. `status !== "complete"` → hard fail
3. No frames AND no events → hard fail
4. `overallConfidence < required` → hard fail (required depends on evidence)
5. Reliability checks (viewOk, jointsTracked, contactDetected) → hard fail if violated
6. Sanity checks (GCT ≤ 0.45s, flight ≤ 0.9s, landing > takeoff) → hard fail
7. **Per-metric gating**:
   - GCT: redact if `confidence < 0.65` OR out-of-bounds
   - Flight: redact if `confidence < 0.65` OR out-of-bounds
   - Events: redact if `confidence < 0.70`
   - Foot angle: redact if `confidence < 0.70`

**Result**: Status → "error" with metrics redacted, OR status → "complete" with partial/full metrics.

### 4.3 UI Rendering Invariant
**File**: [app/(tabs)/index.tsx](app/(tabs)/index.tsx#L303)
**Rendering rule**:
```typescript
if (isComplete && isRealMeasurement) {
  // Show metrics (may include nulls from per-metric gating)
} else {
  // Show explanation: synthetic, incomplete, or insufficient confidence
}
```

---

## 5. Data Shape Flow

### 5.1 URI → Frames
```
user picks video: uri (string)
  ↓ sampleFramesForAnalysis()
pixelFrames: PixelFrame[] {
  width, height,
  data: Uint8ClampedArray,  // RGBA
  tMs: number
}
```

### 5.2 Frames → Ground
```
pixelFrames → toGrayscaleFrames()
  ↓
grayscaleFrames: {data: Uint8ClampedArray, width, height, tMs}[]
  ↓ detectGround()
GroundDetectorOutput {
  detected: boolean,
  theta: number | null,      // radians [0, π)
  rho: number | null,        // pixels
  confidence: number,        // [0, 1]
  line: {x1, y1, x2, y2},
  method: "hough_temporal",
  diagnostics: {...}
}
  ↓ groundDetectorToModel()
GroundModel2D {
  type: "hough_polar",
  theta, rho, line,
  confidence,
  method,
  diagnostics
}
```

### 5.3 Ground + Frames → ROI
```
GroundDetectorOutput + grayscaleFrames → inferRoiFromGround()
  ↓
RoiInferenceResult {
  roi?: {x, y, w, h},
  confidence: number
}
```

### 5.4 Frames + ROI → Contact Signal
```
pixelFrames + roi → analyzeContactFromRoi()
  ↓
{
  analyzedFrames: AnalysisFrame[],
  contactSignals: {inContact, confidence}[],
  rawSamples: {tMs, contactScore, edgeEnergy, motionEnergy, bottomBandEnergy}[],
  stats: {contactScoreMin/Max/Mean/Std, ...}
}
```

### 5.5 Contact Signal → Events
```
rawSamples → detectContactEventsFromSignal()
  ↓
{
  takeoffMs?: number,
  landingMs?: number,
  contacts: {startMs, endMs}[],
  debugNotes: string[]
}
```

### 5.6 Events + Frames → Metrics
```
(confirmedTakeoff, confirmedLanding) + analyzedFrames → deriveMetrics()
  ↓
{
  gctSeconds: number | null,
  gctMs: number | null,
  flightSeconds: number | null
}
```

### 5.7 All → JumpAnalysis
```
JumpAnalysis {
  version: "0.2.0",
  status: "complete" | "error" | "pending",
  measurementStatus: "real" | "synthetic_placeholder",
  
  metrics: {gctSeconds, gctMs, flightSeconds, footAngleDeg, ...},
  events: {takeoff: {t, frame, confidence}, landing: {...}},
  frames: AnalysisFrame[],        // per-frame contact + ground
  groundSummary: GroundModel2D,
  quality: {
    overallConfidence,
    notes: string[],
    reliability: {viewOk, jointsTracked, contactDetected, groundDetected}
  },
  capture: {nominalFps?, durationMs?},
  aiSummary: {text, tags},
  debug: {contact: {...}, lowerBody: {...}, foot: {...}}
}
```

---

## 6. Minimal File Set for Label Mode + Evaluation

### Purpose
Preserve all current analysis logic, add:
- Timestamp → frame label mapping (video time + index)
- Confidence visualization (per-frame, per-metric)
- Evaluation metrics (accuracy, precision, recall vs ground truth)
- Label export/import (JSON, CSV, Parquet)

### 6.1 Files to MODIFY (existing behavior preserved)

| File | Change | Why |
|------|--------|-----|
| [src/analysis/jumpAnalysisContract.ts](src/analysis/jumpAnalysisContract.ts) | Add optional `labels?` field to `JumpAnalysis` | Store frame-level ground truth + confidence |
| [src/analysis/pogoSideViewAnalyzer.ts](src/analysis/pogoSideViewAnalyzer.ts) | Add label mode config to `GroundRoiConfig` | Accept ground truth timestamps, suppress confidence gating |
| [src/analysis/confidenceGate.ts](src/analysis/confidenceGate.ts) | Add `mode: "normal" \| "label"` to `GateConfig` | Skip gating in label mode to preserve raw metrics |
| [app/(tabs)/index.tsx](app/(tabs)/index.tsx) | Add "Label Mode" UI section | Toggle + label editor UI |

### 6.2 Files to ADD (new functionality)

| File | Purpose |
|------|---------|
| `src/analysis/labelingContract.ts` | Types: FrameLabel, LabelSet, EvaluationResult, ConfusionMatrix |
| `src/analysis/labelingUtils.ts` | Functions: createLabelFromTimestamp, matchLabelsToFrames, computeMetrics |
| `src/analysis/evaluationEngine.ts` | Functions: evaluateDetection, evaluateTiming, generateReport |
| `src/video/labelExport.ts` | Functions: exportLabelsJSON, exportLabelsCSV, exportLabelsParquet |
| `src/ui/LabelingScreen.tsx` | UI component for labeling mode (optional, can be in index.tsx) |

### 6.3 Database / Persistence (minimal)

| File | Purpose |
|------|---------|
| `src/storage/labelStore.ts` | AsyncStorage or SQLite for label persistence |

---

## 7. Call Graph (Main Pipeline)

```
analyzeVideo(uri)
├─→ analyzePogoSideView(uri)
│   ├─→ sampleFramesForAnalysis(uri)
│   │   └─→ iosAvFoundationFrameProvider.sampleFrames() [iOS]
│   │
│   ├─→ toGrayscaleFrames(pixelFrames)
│   │
│   ├─→ detectGround(grayscaleFrames) [groundDetector.ts]
│   │   └─→ returns GroundDetectorOutput
│   │
│   ├─→ groundDetectorToModel(output)
│   │
│   ├─→ inferRoiFromGround(grayscaleFrames, output) [groundDetector.ts]
│   │   └─→ returns {roi, confidence}
│   │
│   ├─→ analyzeContactFromRoi(pixelFrames, groundLineY, roi)
│   │   ├─→ extractRoiLuma(frame, roi)
│   │   ├─→ computeEdgeEnergy(luma, w, h)
│   │   ├─→ computeBottomBandEnergy(luma, w, h)
│   │   └─→ returns {analyzedFrames, contactSignals, rawSamples, stats}
│   │
│   ├─→ trackLowerBody(extractedFrames, roi, groundY) [lowerBodyTracker.ts]
│   │   └─→ returns {samples, debug}
│   │
│   ├─→ extractFootRegion(extractedFrames, roi, groundY) [footRegionExtractor.ts]
│   │   └─→ returns {samples, debug}
│   │
│   ├─→ detectContactEventsFromSignal(rawSamples) [groundRoi.ts]
│   │   └─→ returns {takeoffMs?, landingMs?, contacts, debugNotes}
│   │
│   ├─→ deriveMetrics(analyzedFrames, takeoffIdx, landingIdx)
│   │   └─→ returns {gctSeconds, gctMs, flightSeconds}
│   │
│   ├─→ Confidence computation & fail-safe gating
│   │   └─→ sets metricsGated, eventsGated
│   │
│   └─→ return JumpAnalysis { complete }
│
└─→ applyConfidenceGate(draft)
    ├─→ Validation checks (status, measurementStatus, frames, events, reliability)
    ├─→ Sanity checks (bounds, timing consistency)
    ├─→ Per-metric gating (GCT, flight, events, foot angle)
    └─→ return JumpAnalysis { complete or error }
```

---

## 8. Summary: Minimal Touch Points

### To Enable Label Mode:
1. **Contract** [jumpAnalysisContract.ts]: Add `labels?: FrameLabelSet`
2. **Config** [pogoSideViewAnalyzer.ts]: Accept `labelMode?: boolean` in config
3. **Gate** [confidenceGate.ts]: Add mode check to skip gating if `labelMode=true`
4. **UI** [index.tsx]: Add toggle + label editor (optional separate component)
5. **Utilities** [NEW labelingUtils.ts]: Frame↔label matching, metrics computation

### To Support Evaluation:
6. **Metrics** [NEW evaluationEngine.ts]: Confusion matrix, precision/recall, timing accuracy
7. **Export** [NEW labelExport.ts]: JSON, CSV, Parquet export
8. **Storage** [NEW labelStore.ts]: Persist labels (optional)

### No Changes Needed:
- Ground detection (already working)
- Contact signal (already working)
- Metrics derivation (already working)
- Confidence gate (just skip in label mode)

---

## 9. Known Constraints & Decisions

### Frame Time Handling
- Frames sampled at irregular intervals (adaptive 2s window)
- Ground truth labels must be matched to nearest frame index (not exact timestamp match)
- Tolerance: ±50ms to nearest frame time

### Measurement Status
- Only `"real"` measurements allowed in evaluation
- `"synthetic_placeholder"` frames excluded from metrics

### Confidence Storage
- Per-metric confidence currently derived from `overallConfidence`
- To support true per-metric credibility: add `metricsConfidence: {gct, flight, events, footAngle}` to contract

### Label Format (TBD)
- Ground truth: `{frameIndex, contact: boolean, timestamp: number}`
- Evaluated: `{frameIndex, predictedContact, predictedConfidence, gtContact, match}`
- Can be extended for side-specific (left/right) labels

---

## 10. Wiring Checklist (Do NOT implement yet)

- [ ] Define `FrameLabel`, `FrameLabelSet`, `EvaluationResult` types
- [ ] Extend `JumpAnalysis.labels?` in contract
- [ ] Extend `GroundRoiConfig.labelMode` option
- [ ] Extend `GateConfig.mode: "normal" | "label"` + gate skip logic
- [ ] Create `labelingUtils.ts` with matching + metrics functions
- [ ] Create `evaluationEngine.ts` with confusion matrix + reporting
- [ ] Add UI toggle in index.tsx (or separate LabelingScreen)
- [ ] Implement label persistence (AsyncStorage)
- [ ] (Optional) Add export/import UI
- [ ] (Optional) Add visualization (per-frame confidence overlay)

---

**Next Step**: Implement the label mode layer following this map without modifying core analysis logic.
