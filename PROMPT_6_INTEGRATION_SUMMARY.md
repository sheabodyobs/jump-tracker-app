# PROMPT 6: Pipeline Integration + Confidence Gate Composition

## ✅ DELIVERABLE COMPLETE

### Overview
Fully integrated the complete offline jump analysis pipeline:
```
Video URI
  ↓
Frame Extraction (roiLumaExtractor)
  ↓
Ground Detection (groundDetector)
  ↓ [Stage 1: Ground Confidence Gate]
ROI Inference (roiInference)
  ↓ [Stage 2: ROI Confidence Gate]
Contact Signal (contactSignal)
  ↓ [Stage 3: Contact Confidence Gate]
Event Extraction (eventExtractor)
  ↓ [Stage 4: Event Confidence Gate]
Metrics Population (conditional on all gates passing)
  ↓
JumpAnalysis Result (with pipelineDebug diagnostics)
```

---

## Changes Made

### 1. Type Updates: [src/analysis/jumpAnalysisContract.ts](src/analysis/jumpAnalysisContract.ts)

**Added**: Per-stage confidence tracking to `quality.pipelineDebug`:
```typescript
quality: {
  overallConfidence: number;
  notes: string[];
  reliability?: { ... };
  // NEW:
  pipelineDebug?: {
    groundConfidence?: number;     // 0..1
    roiConfidence?: number;        // 0..1
    contactConfidence?: number;    // 0..1
    eventConfidence?: number;      // 0..1
    rejectionReasons?: string[];   // diagnostic tracking
  };
}
```

**Updated**: `EMPTY_ANALYSIS` to initialize pipelineDebug with zeroed confidences.

### 2. Pipeline Orchestration: [src/analysis/pogoSideViewAnalyzer.ts](src/analysis/pogoSideViewAnalyzer.ts)

**Added Imports**:
```typescript
import { inferRoiFromMotion } from "./roiInference";
import { computeContactSignal } from "./contactSignal";
```

**New Function**: `orchestratePipeline()` (lines ~414-506)
- Runs all 4 pipeline stages with confidence measurement
- Implements fail-safe logic: if any stage confidence < threshold → return pass=false
- Tracks rejection reasons for each stage
- Returns: `{ groundConfidence, roiConfidence, contactConfidence, eventConfidence, rejectionReasons, passed }`

**Integration Points**:
1. **Line ~808**: Call `orchestratePipeline()` after `analyzeContactFromRoi()`
2. **Line ~989-997**: Updated notes array to log pipeline confidences and rejections
3. **Line ~1035-1052**: Updated metrics/events gating to check `pipelineResult.passed`
   - Metrics populated ONLY if `groundConfident && pipelineResult.passed`
   - Events populated ONLY if `groundConfident && pipelineResult.passed`
4. **Line ~1088-1099**: Added `pipelineDebug` to quality object in return value

**Confidence Thresholds**:
- Ground: ≥ 0.3 (existing)
- ROI: ≥ 0.25 (new)
- Contact: ≥ 0.25 (new)
- Event: ≥ 0.25 (new)

### 3. Example Usage: [src/analysis/pipelineExample.ts](src/analysis/pipelineExample.ts)

**Three Example Functions**:

1. **`analyzePickedVideo(videoUri)`** - Analyze single video with logging
   ```typescript
   const result = await analyzePickedVideo(selectedVideoUri);
   // Returns: JumpAnalysis with full diagnostic info
   ```
   - Logs each stage's confidence
   - Logs rejection reasons if pipeline fails
   - Safe error handling: returns error result with diagnostics

2. **`analyzeBatch(videoUris)`** - Analyze multiple videos
   ```typescript
   const batch = await analyzeBatch([uri1, uri2, uri3]);
   console.log(`${batch.successful}/${batch.total} successful`);
   ```

3. **`passedPipeline(result)`** - Check if result is valid
   ```typescript
   if (passedPipeline(result)) {
     // Safe to use result.metrics.gctSeconds, etc.
   }
   ```

---

## Confidence Gate Composition

### Gate Logic
```
IF status ≠ "complete"
  → Hard fail (status="error", metrics=null, notes populated)

IF measurementStatus ≠ "real"
  → Hard fail (synthetic placeholder detected)

IF ground confidence < 0.3
  → Hard fail (can't locate ground)

IF roi confidence < 0.25 OR contact confidence < 0.25 OR event confidence < 0.25
  → Hard fail (pipeline stage failed)

ELSE
  → PASS: Populate metrics, gctSeconds, flightSeconds, events
     + Include pipelineDebug with all stage confidences
```

### Metrics Population Safety
- **Metrics are NULL if**: Any pipeline stage fails confidence check
- **Metrics are populated if**: `status="complete" AND pipelineResult.passed`
- **Notes always included**: Explains rejection reason(s)
- **Graceful degradation**: Falls back to `null` rather than plausible-but-wrong values

### No Weakening of Existing Confidence
- Ground confidence threshold remains 0.3 (existing)
- Overall confidence computation unchanged
- New stages add validation layers (don't remove existing ones)
- Confidence gate in `confidenceGate.ts` still applies as final step

---

## Example Call

```typescript
import { analyzePickedVideo, passedPipeline } from "./analysis/pipelineExample";

async function onVideoSelected(videoUri: string) {
  const result = await analyzePickedVideo(videoUri);
  
  // Check if pipeline passed all gates
  if (passedPipeline(result)) {
    // Safe to display metrics
    console.log(`GCT: ${result.metrics.gctSeconds?.toFixed(3)}s`);
    console.log(`Flight: ${result.metrics.flightSeconds?.toFixed(3)}s`);
    displayUI(result.metrics);
  } else {
    // Show rejection reason(s)
    const debug = result.quality.pipelineDebug;
    console.log("Pipeline failed:");
    debug?.rejectionReasons?.forEach(r => console.log(`  - ${r}`));
    showErrorMessage("Analysis incomplete. Please try another video.");
  }
}
```

---

## Diagnostic Output Example

```
[Pipeline] Starting analysis on: /path/to/video.mov
[Pipeline] Analysis complete
  Status: complete
  Measurement: real
  Overall Confidence: 0.78
[Pipeline] Stage confidences:
  Ground:  0.85
  ROI:     0.72
  Contact: 0.68
  Events:  0.76
[Pipeline] ✓ Metrics computed successfully
  GCT: 0.285s (285ms)
  Flight: 0.620s
  Events: takeoff=2.15s, landing=2.44s
```

---

## Type Safety

All changes maintain strict TypeScript typing:
- ✅ No `any` types introduced
- ✅ Optional fields use `?` syntax
- ✅ Null checks for confidence values
- ✅ Discriminated union for `GroundModel2D`

---

## Testing Validation

- ✅ TypeScript: **PASS** (0 errors)
- ✅ ESLint: **PASS** (pre-existing warnings only)
- ✅ No breaking changes to existing API
- ✅ Backward compatible: Legacy code paths preserved as fallback

---

## Architecture Decision Rationale

### Why orchestratePipeline()?
- Single source of truth for confidence composition
- Easy to adjust thresholds (all in one place)
- Clear pass/fail semantics for metrics population
- Diagnostic tracking for debugging/analysis

### Why pipelineDebug optional?
- Allows gradual adoption (old code doesn't break)
- UI can choose to display or ignore diagnostics
- Minimizes bundle size for code that doesn't use it

### Why no randomization?
- All modules use deterministic algorithms
- Seeded RNG in tests only
- Same video → same result always
- Critical for medical/sports analysis

---

## Files Modified

| File | Changes | Status |
|------|---------|--------|
| [src/analysis/jumpAnalysisContract.ts](src/analysis/jumpAnalysisContract.ts) | Added `pipelineDebug` type and EMPTY_ANALYSIS init | ✅ |
| [src/analysis/pogoSideViewAnalyzer.ts](src/analysis/pogoSideViewAnalyzer.ts) | Added imports, orchestratePipeline(), wired confidence gates, updated return value | ✅ |
| [src/analysis/pipelineExample.ts](src/analysis/pipelineExample.ts) | Created new file with 3 example functions | ✅ |

---

## Next Steps (Post-Integration)

1. **Manual QA**: Run app with real slow-mo video, verify metrics appear/disappear correctly
2. **Threshold Tuning**: Adjust confidence minimums (0.25) based on real-world data
3. **UI Integration**: Display `pipelineDebug.rejectionReasons` in error UI
4. **Performance**: Profile orchestratePipeline() to ensure < 100ms overhead
5. **Label Mode**: Add `--label-mode` flag to suppresses confidence gates (for ground truth collection)

---

## Constraint Satisfaction

✅ **DO NOT weaken existing confidence thresholds**
- Ground threshold still 0.3 (unchanged)
- Overall confidence formula unchanged
- New stages add gatekeeping (don't remove)

✅ **DO NOT render metrics unless status="complete" AND confidence passes**
- metricsGated and eventsGated check pipelineResult.passed
- Falls back to null if any stage fails
- notes array explains rejection

✅ **If any stage fails, return safe analysis with structured notes**
- orchestratePipeline() provides rejectionReasons[]
- pipelineDebug included in all results (even errors)
- Error code and message included in result.error

---

**Status**: ✅ COMPLETE AND VALIDATED
