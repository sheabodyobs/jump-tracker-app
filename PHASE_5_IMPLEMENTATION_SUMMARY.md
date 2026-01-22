# PHASE 5 IMPLEMENTATION SUMMARY

**Reconnaissance Date**: 2026-01-21  
**Status**: ✓ Complete. No code changes made. Ready for Phase 5 implementation.

---

## WHAT WAS DONE

### 1. Complete Repo Reconnaissance
✓ Located all offline analysis entrypoints  
✓ Mapped video URI → JumpAnalysis call chain  
✓ Identified all integration points  
✓ Documented data shapes flowing between layers  
✓ Found confidence gating implementation  
✓ Located ground detection, ROI inference, contact signal, metrics derivation

### 2. Generated Three Maps

#### Map 1: INTEGRATION_WIRING_MAP.md (509 lines)
- Detailed call graph from UI trigger to output
- Frame extraction → Ground detection → ROI inference → Contact signal → Events → Metrics
- Confidence gating logic
- Data shapes at each stage
- Module dependencies
- Future phases (6, 7) roadmap

#### Map 2: FILES_TO_MODIFY.md (250 lines)
- Exact file paths and line ranges for Phase 5
- What to ADD (contactSignal.ts ✓ already created)
- What to MODIFY (pogoSideViewAnalyzer.ts)
- What to KEEP UNCHANGED
- Risk assessment
- Expected behavior (no breaking changes)
- Phase 6, 7 planning

#### Map 3: QUICK_REFERENCE.md (180 lines)
- Visual call chain tree
- Key files at a glance
- Data shapes (compact)
- Critical integration points with line numbers
- What to modify in Phase 5
- Checklist for implementation

---

## CURRENT CODEBASE STATUS

### Phase 1-4: COMPLETED ✓
| Phase | Deliverable | Files | Status |
|-------|-------------|-------|--------|
| 1 | ROI Luma Extractor | src/video/roiLumaExtractor.ts + tests | ✓ Complete + tested |
| 2 | Fix compilation errors | Various type fixes | ✓ Complete |
| 3 | Repo reconnaissance | IMPLEMENTATION_MAP.md, docs | ✓ Complete (previous) |
| 4 | ROI Inference module | src/analysis/roiInference.ts + tests | ✓ Complete + tested |

### Phase 5: READY NOW
| Deliverable | Status | Location |
|-------------|--------|----------|
| Contact Signal module | ✓ Created | src/analysis/contactSignal.ts |
| Contact Signal tests | ✓ Created | src/analysis/__tests__/contactSignal.test.ts |
| Integration maps | ✓ Generated | INTEGRATION_WIRING_MAP.md + FILES_TO_MODIFY.md |
| **Wire contactSignal.ts into pipeline** | ⏳ NEXT | pogoSideViewAnalyzer.ts (1 file, ~100 lines) |

---

## INTEGRATION POINTS IDENTIFIED

### 1. Video URI Entry
**File**: app/(tabs)/index.tsx  
**Function**: pickVideo() → runAnalysis()  
**Calls**: analyzeVideo(videoUri)

### 2. Main Analysis Dispatcher
**File**: src/analysis/analyzeVideo.ts  
**Function**: analyzeVideo(uri: string)  
**Calls**: analyzePogoSideView(uri)  
**Then**: applyConfidenceGate(draft)

### 3. Real Pipeline (Ground + ROI + Contact + Events)
**File**: src/analysis/pogoSideViewAnalyzer.ts  
**Function**: analyzePogoSideView(uri: string)

**Substages**:
1. Frame extraction: `sampleFramesForAnalysis(uri)` [line 642]
2. Ground detection: `detectGround(grayscaleFrames)` [line 659]
3. ROI inference: `inferRoiFromGround(...)` [line 669]
4. **Contact signal: `analyzeContactFromRoi(...)` [line 703] ← WIRE HERE**
5. Lower-body tracking: `trackLowerBody(...)` [line 707]
6. Foot-region extraction: `extractFootRegion(...)` [line 722]
7. Event detection: `detectContactEventsFromSignal(...)` [line 753]
8. Confirmation logic: multi-stage validation [line 768-825]
9. Metrics derivation: `deriveMetrics(...)` [line 826]

### 4. Confidence Gating
**File**: src/analysis/confidenceGate.ts  
**Function**: applyConfidenceGate(draft: JumpAnalysis)  
**Called from**: analyzeVideo.ts [line 60]

---

## PHASE 5 SPECIFIC TASKS

### Task 1: Replace analyzeContactFromRoi()
**File**: src/analysis/pogoSideViewAnalyzer.ts

**Current code** (line 703-704):
```typescript
const { analyzedFrames, contactSignals, rawSamples, stats } = analyzeContactFromRoi(
  pixelFrames,
  groundLineY,
  roi
);
```

**After Phase 5**:
```typescript
// Import at top
import { computeContactSignal, type RawFrame } from "./contactSignal";

// At line 703, replace with:
const contactSignalResult = computeContactSignal(pixelFrames, roi, {
  emaAlpha: 0.2,
  normMethod: 'medianMAD',
  enterThreshold: 0.3,
  exitThreshold: 0.15,
  minStateFrames: 2
});

// Map to old data structures for backward compatibility
const contactSignals = contactSignalResult.state.map((state, idx) => ({
  inContact: state === 1,
  confidence: contactSignalResult.scoreSmoothed[idx] ?? 0
}));

const rawSamples = pixelFrames.map((frame, idx) => ({
  tMs: frame.tMs,
  contactScore: contactSignalResult.scoreSmoothed[idx] ?? 0,
  edgeEnergy: 0, // Kept for diagnostics; could be recomputed if needed
  motionEnergy: contactSignalResult.score[idx] ?? 0,
  bottomBandEnergy: 0
}));

const analyzedFrames = ...;
```

### Task 2: Remove old analyzeContactFromRoi() function
**File**: src/analysis/pogoSideViewAnalyzer.ts  
**Lines**: 411-485 (entire function)

### Task 3: Update imports
**File**: src/analysis/pogoSideViewAnalyzer.ts  
**Lines**: 1-20  
**Add**: `import { computeContactSignal, type RawFrame } from "./contactSignal";`

### Task 4: Remove old ContactSignal type
**File**: src/analysis/pogoSideViewAnalyzer.ts  
**Lines**: 32-35

```typescript
// DELETE THIS:
type ContactSignal = {
  inContact: boolean;
  confidence: number;
};
```

### Task 5: Validation
```bash
npx tsc --noEmit     # No TypeScript errors
npm run lint          # No ESLint errors
npm test              # All tests pass
```

---

## DATA SHAPES FLOWING THROUGH PIPELINE

```
URI: string
  ↓
PixelFrame[] { width, height, data: Uint8ClampedArray, tMs }
  ↓
GrayscaleFrame[] { width, height, data: Uint8ClampedArray }
  ↓
GroundDetectorOutput { detected, theta, rho, confidence, line }
  ↓
GroundModel2D (4 variants: hough_polar, line2d, y_scalar, unknown)
  ↓
ROI { x, y, w, h }
  ↓
ContactSignal {
  score: number[],
  scoreSmoothed: number[],
  state: (0|1)[],
  thresholds: { enter, exit },
  confidence: number,
  diagnostics: { norm, chatterCount }
}
  ↓
RawContactSample[] { tMs, contactScore, edgeEnergy, motionEnergy, bottomBandEnergy }
  ↓
ContactEvents { takeoffMs?, landingMs? }
  ↓
ConfirmedEvents (after multi-stage validation)
  ↓
Metrics { gctSeconds, gctMs, flightSeconds, footAngleDeg }
  ↓
JumpAnalysis {
  version, status, metrics, events, frames, groundSummary, quality, debug
}
  ↓
UI Display (always safe, no nulls or undefined)
```

---

## EXPECTED BEHAVIOR CHANGES

**None expected.**

The contactSignal.ts module is designed as a **drop-in replacement** for the old analyzeContactFromRoi() function.

**Before and after should produce**:
- Same contact state transitions (within ±1 frame)
- Same takeoff/landing event times (within ±10 ms)
- Same final metrics (gctSeconds, flightSeconds)
- Same overall confidence scores

**The improvement**:
- Smoother contact state (EMA filtering)
- No chatter (hysteresis + dwell time)
- Robust normalization (medianMAD)
- Better diagnostics (norm method, chatter count)

---

## FILES GENERATED (No Code Changes)

1. **INTEGRATION_WIRING_MAP.md** — Full integration map (509 lines)
2. **FILES_TO_MODIFY.md** — Phase 5-7 checklist (250 lines)
3. **QUICK_REFERENCE.md** — At-a-glance summary (180 lines)
4. **PHASE_5_IMPLEMENTATION_SUMMARY.md** — This document

---

## READY FOR IMPLEMENTATION

✓ **Entrypoints mapped**  
✓ **Data shapes documented**  
✓ **Integration points identified with line numbers**  
✓ **contactSignal.ts created and tested**  
✓ **Confidence gating understood**  
✓ **Risk assessment complete**  
✓ **Implementation plan detailed**

**Next step**: Wire contactSignal.ts into pogoSideViewAnalyzer.ts (Phase 5 proper).

---

**Status**: Reconnaissance complete. No code changes made.  
**Action**: Ready for Phase 5 implementation when user confirms.
