# FILES TO MODIFY — Jump Tracker Integration Checklist

**Date**: 2026-01-21  
**Status**: Reconnaissance complete. Ready for Phase 5 implementation.

---

## PHASE 5: CONTACT SIGNAL INTEGRATION (Immediate Next)

### Files to MODIFY

#### 1. [src/analysis/pogoSideViewAnalyzer.ts](src/analysis/pogoSideViewAnalyzer.ts)
**Changes**: Replace old contact signal logic with new module

| Line Range | What | Action |
|------------|------|--------|
| 1-20 | Imports | ADD: `import { computeContactSignal, type RawFrame } from "./contactSignal";` |
| 32-35 | Type definitions | REMOVE: `type ContactSignal` (now imported from contactSignal.ts) |
| 411-485 | `analyzeContactFromRoi()` function | REPLACE entire function with new contact signal pipeline |
| 703-704 | Call to analyzeContactFromRoi | WIRE: `const contactSignalResult = computeContactSignal(...)` |
| ~750 | Usage of contactSignals array | MAP: `contactSignalResult.state` to event detection |

**Specific code to replace**:
```typescript
// OLD (line 411-485)
function analyzeContactFromRoi(...) {
  // complex normalization + thresholding
  // returns: analyzedFrames, contactSignals, rawSamples, stats
}

// NEW
// Use computeContactSignal from contactSignal.ts
// Map state (0|1)[] to event detection pipeline
```

**Scope**: ~100 lines modified, ~200 lines removed, ~50 lines added

---

#### 2. [src/analysis/jumpAnalysisContract.ts](src/analysis/jumpAnalysisContract.ts)
**Changes**: OPTIONAL — only if adding diagnostic metadata

| Line | What | Action |
|------|------|--------|
| Optional | RawContactSample type | Keep unchanged (still useful for diagnostics) |

**Status**: No changes required. Schema stays same.

---

#### 3. [src/analysis/groundRoi.ts](src/analysis/groundRoi.ts)
**Changes**: MINIMAL — ensure event detection consumes contact state correctly

| Line | What | Action |
|------|------|--------|
| Unknown | `detectContactEventsFromSignal()` function | Verify it can accept state array (0|1)[] instead of just scores |

**Status**: Likely NO changes needed (already generic over signal type).

---

### Files to ADD

#### 1. [src/analysis/contactSignal.ts](src/analysis/contactSignal.ts)
**Status**: ✅ ALREADY CREATED (Phase 5)

#### 2. [src/analysis/__tests__/contactSignal.test.ts](src/analysis/__tests__/contactSignal.test.ts)
**Status**: ✅ ALREADY CREATED (Phase 5)

---

### Files UNCHANGED in Phase 5

| File | Reason |
|------|--------|
| analyzeVideo.ts | Already routes through analyzePogoSideView; no contact signal logic |
| confidenceGate.ts | Confidence gating remains unchanged |
| groundDetector.ts | Ground detection independent of contact signal |
| roiInference.ts | ROI inference already created; can be wired in Phase 6 (optional) |
| lowerBodyTracker.ts | Independent; used for confirmation |
| footRegionExtractor.ts | Independent; used for confirmation |
| app/(tabs)/index.tsx | No UI changes needed |

---

## PHASE 6: LABEL MODE + EVALUATION (Future)

### Files to ADD

| File | Purpose |
|------|---------|
| src/analysis/labelMode.ts | Frame-by-frame annotation UI + ground truth export |
| src/analysis/evaluationEngine.ts | Compare predicted vs. labeled events; compute metrics |
| src/analysis/__tests__/evaluationEngine.test.ts | Validation of evaluation logic |
| docs/LABEL_MODE_GUIDE.md | User guide for annotation workflow |

### Files to MODIFY

| File | Changes |
|------|---------|
| jumpAnalysisContract.ts | Add optional `groundTruth` field to AnalysisFrame |
| pogoSideViewAnalyzer.ts | Add label-mode flag check; preserve frames without gating |
| app/(tabs)/index.tsx | Add label-mode toggle; render overlay UI |
| confidenceGate.ts | Optional: different gate config for label mode |

---

## PHASE 7: PERFORMANCE OPTIMIZATION (Future)

### Files to MODIFY

| File | Changes |
|------|---------|
| pogoSideViewAnalyzer.ts | Frame decimation; early termination |
| roiInference.ts | Optional motion energy map downsampling |
| contactSignal.ts | Variable-alpha EMA (adaptive to contact state) |

### Files to ADD

| File | Purpose |
|------|---------|
| src/analysis/frameDecimation.ts | Selectable frame skipping (every Nth frame) |

---

## WIRING CHECKLIST FOR PHASE 5

```
☐ Import computeContactSignal into pogoSideViewAnalyzer.ts
☐ Remove old analyzeContactFromRoi() function
☐ Replace call to analyzeContactFromRoi() with computeContactSignal()
☐ Map contactSignalResult.state → event detection pipeline
☐ Map contactSignalResult.diagnostics → debug output
☐ Run TypeScript validation (npx tsc --noEmit)
☐ Run ESLint (npm run lint)
☐ Run full test suite
☐ Manual QA: test with real slow-mo video
☐ Verify metrics (gctSeconds, flightSeconds) match previous behavior
☐ Verify confidence gating still works
☐ Verify UI displays results correctly
```

---

## MINIMAL FILE TOUCHES FOR SAFE INTEGRATION

**Goal**: Integrate contactSignal.ts with zero breaking changes.

**Strategy**: 
1. Keep `rawSamples` data structure intact
2. Compute contactSignalResult separately
3. Extract `state` from result and convert to scores for event detection
4. Keep metrics derivation logic unchanged

**Files that MUST NOT break**:
- jumpAnalysisContract.ts (schema)
- analyzeVideo.ts (entry point)
- app/(tabs)/index.tsx (UI)
- confidenceGate.ts (gating logic)

**Files that CAN be refactored**:
- pogoSideViewAnalyzer.ts (internal implementation)
- groundRoi.ts (if needed, can adapt event detection)

---

## INTEGRATION RISK ASSESSMENT

| Risk | Severity | Mitigation |
|------|----------|-----------|
| Contact state encoding (0/1) vs. score normalization | MEDIUM | Keep both pipelines; only swap at event detection stage |
| Diagnostic data changes (chatterCount, normalization type) | LOW | Add to debug output; UI can ignore |
| Threshold tuning (enterThreshold, exitThreshold) | LOW | Use conservative defaults matching old behavior |
| Event timing precision | MEDIUM | Ensure state transition happens at same frame as old score spike |
| Confidence computation | LOW | New computation may differ slightly; apply gate same way |

---

## EXPECTED BEHAVIOR CHANGES (None Expected)

The new contactSignal.ts is designed to be a **drop-in replacement** for analyzeContactFromRoi():

**Before**:
```
analyzeContactFromRoi() 
  → contactScore (0..1)
  → thresholding (>0.55 = contact)
  → events (takeoff/landing)
```

**After**:
```
computeContactSignal()
  → scoreSmoothed (0..1, EMA-filtered)
  → hysteresis state machine (0|1)
  → events (same timing)
```

**Test validation**: Both should produce events at same frames ±1.

---

**READY FOR PHASE 5 IMPLEMENTATION** ✓
