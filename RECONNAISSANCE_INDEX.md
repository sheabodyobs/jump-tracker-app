# RECONNAISSANCE COMPLETE — Documentation Index

**Date**: 2026-01-21 | **Status**: ✓ Ready for Phase 5 Implementation | **Code Changes**: 0

---

## START HERE

**If you want the big picture**: Read [QUICK_REFERENCE.md](QUICK_REFERENCE.md) (5 min)

**If you're implementing Phase 5**: Follow [FILES_TO_MODIFY.md](FILES_TO_MODIFY.md) (10 min)

**If you need deep details**: Study [INTEGRATION_WIRING_MAP.md](INTEGRATION_WIRING_MAP.md) (20 min)

---

## DOCUMENT SUMMARY

| Document | Size | Purpose | For Whom |
|----------|------|---------|----------|
| **QUICK_REFERENCE.md** | 180 lines | Call chain + data shapes + checklist | Everyone (start here) |
| **FILES_TO_MODIFY.md** | 250 lines | Exact files, line ranges, phases 5-7 | Implementers |
| **INTEGRATION_WIRING_MAP.md** | 509 lines | Complete call graph + diagnostics | Architects |
| **PHASE_5_IMPLEMENTATION_SUMMARY.md** | 280 lines | Recap + specific tasks + code snippets | Implementation lead |

---

## RECONNAISSANCE FINDINGS

### Entrypoints Identified ✓
- **UI**: app/(tabs)/index.tsx → pickVideo() → runAnalysis()
- **Analysis**: analyzeVideo() → analyzePogoSideView() → applyConfidenceGate()
- **Native**: iosAvFoundationFrameProvider (sampleFrames)

### Integration Points Identified ✓
1. Frame extraction (line 642 in pogoSideViewAnalyzer.ts)
2. Ground detection (line 659)
3. ROI inference (line 669)
4. **Contact signal ← PHASE 5 WIRING POINT** (line 703)
5. Event detection (line 753)
6. Metrics derivation (line 826)
7. Confidence gating (analyzeVideo.ts line 60)

### Data Shapes Documented ✓
- PixelFrame
- GroundModel2D (4 variants)
- ContactSignal (NEW)
- RawContactSample
- JumpAnalysis (output)

### Confidence Gate Understood ✓
- Hard fail: status="error", metrics=null (if confidence < 0.6)
- Soft fail: status="complete", per-metric redaction (if confidence > 0.6)
- UI rendering: always safe (no nulls/undefined)

### Files to Modify Identified ✓
- Phase 5: 1 main file (pogoSideViewAnalyzer.ts)
- Phase 6: 3 new files (labelMode, evaluationEngine, tests)
- Phase 7: 1 new file (frameDecimation)

---

## CURRENT IMPLEMENTATION STATUS

### Completed Phases
| Phase | Deliverable | Status |
|-------|-------------|--------|
| 1 | ROI Luma Extractor (native + TS wrapper) | ✓ 650 lines (Swift) + 450 lines (TS) |
| 2 | Fix TypeScript errors | ✓ Fixed |
| 3 | Repo reconnaissance (first pass) | ✓ Complete |
| 4 | ROI Inference module (motion energy) | ✓ 320 lines + 530 line test suite |

### Phase 5: READY NOW
| Task | Status | Files |
|------|--------|-------|
| Create contactSignal.ts | ✓ Done | src/analysis/contactSignal.ts (291 lines) |
| Create contactSignal tests | ✓ Done | src/analysis/__tests__/contactSignal.test.ts (417 lines) |
| **Wire into pogoSideViewAnalyzer** | ⏳ Next | pogoSideViewAnalyzer.ts (modify line 703) |
| Generate integration maps | ✓ Done | 4 documents created |

### Not Yet Started
- Phase 6: Label mode + evaluation
- Phase 7: Performance optimization

---

## QUICK INTEGRATION CHECKLIST (PHASE 5)

```
PRE-WORK:
☐ Read QUICK_REFERENCE.md
☐ Read PHASE_5_IMPLEMENTATION_SUMMARY.md

MODIFICATION:
☐ Open: src/analysis/pogoSideViewAnalyzer.ts
☐ Add import: computeContactSignal from contactSignal.ts (line ~20)
☐ Remove: analyzeContactFromRoi() function (lines 411-485)
☐ Remove: ContactSignal type definition (lines 32-35)
☐ Replace: Line 703 call with new computeContactSignal()
☐ Map: contactSignalResult to backward-compatible data structures

VALIDATION:
☐ Run: npx tsc --noEmit (expect: no errors)
☐ Run: npm run lint (expect: no errors)
☐ Run: npm test (expect: all pass)
☐ Manual QA: test with real slow-mo video

VERIFICATION:
☐ Metrics match baseline (gctSeconds, flightSeconds)
☐ Events detected at same frames (±1)
☐ Confidence gating still works
☐ UI displays results correctly
☐ No regression in other tests

COMPLETION:
☐ Commit changes with clear message
☐ Document any behavior changes (expect: none)
☐ Plan Phase 6 (label mode)
```

---

## KEY INSIGHTS FROM RECONNAISSANCE

### 1. Strong Contract-First Design
- JumpAnalysis schema is stable (v0.2.0)
- Mock analysis available for testing
- Confidence gate enforces safety (no unsafe metrics leak to UI)

### 2. Multi-Layer Confirmation
- Contact events are triple-checked:
  - Lower-body tracker confirmation
  - Foot-region tracker confirmation
  - Biomechanical bounds checking
- This explains why contactSignal.ts can focus purely on motion energy

### 3. Graceful Degradation
- Ground detection: hough_polar (preferred) → line2d → y_scalar → unknown
- ROI inference: detected ground → legacy fallback
- Contact signal: real frames → synthetic placeholder
- No hard crashes; always returns valid JumpAnalysis

### 4. Minimal Touch Points
- Contact signal integration is **one file, one function call**
- Backward compatibility maintained via data mapping
- No schema changes needed
- No UI changes needed

### 5. Testing Infrastructure
- Self-test: runPogoAnalyzerSelfTest()
- Frame test: runFrameTest() in UI
- Mock analysis: MOCK_ANALYSIS in contract
- Easy validation path for new code

---

## PHASE 6 & 7 PREVIEW

### Phase 6: Label Mode + Evaluation
**Goal**: Enable ground-truth annotation and metric validation

**Files to create**:
- labelMode.ts (frame-by-frame UI overlay)
- evaluationEngine.ts (compare predicted vs. labeled)

**Files to modify**:
- pogoSideViewAnalyzer.ts (preserve frames in label mode)
- app/(tabs)/index.tsx (add label mode toggle)

**Expected impact**: Low risk, isolated to new modules

### Phase 7: Performance Optimization
**Goal**: Frame decimation, early termination, adaptive thresholds

**Files to create**:
- frameDecimation.ts (selectable frame skipping)

**Files to modify**:
- pogoSideViewAnalyzer.ts (plumb decimation)
- contactSignal.ts (adaptive alpha)

**Expected impact**: Speed improvement, same accuracy

---

## TROUBLESHOOTING REFERENCE

### If TypeScript fails:
→ Check imports in pogoSideViewAnalyzer.ts  
→ Ensure contactSignal.ts is in src/analysis/  
→ Run `npx tsc --noEmit` to see exact errors

### If metrics regress:
→ Check mapping of contactSignalResult → rawSamples  
→ Verify enterThreshold/exitThreshold defaults match old behavior  
→ Compare old contactScore vs. new scoreSmoothed distribution

### If tests fail:
→ Run `npm test` to see specific failures  
→ Check groundLineY mapping in analyzeContactFromRoi replacement  
→ Verify pixelFrames format hasn't changed

### If confidence drops:
→ New normalization may differ from old  
→ Check confidence computation in confidenceGate.ts  
→ May need threshold tuning (not code changes)

---

## DOCUMENTS CREATED (NO CODE MODIFIED)

```
/repo_root/
├─ QUICK_REFERENCE.md                    ← Start here (5 min read)
├─ FILES_TO_MODIFY.md                    ← For implementers (10 min)
├─ INTEGRATION_WIRING_MAP.md             ← Deep dive (20 min)
├─ PHASE_5_IMPLEMENTATION_SUMMARY.md     ← Recap + tasks (10 min)
├─ RECONNAISSANCE_INDEX.md               ← This file
│
├─ src/analysis/
│  ├─ contactSignal.ts                   ✓ Created (Phase 4)
│  ├─ __tests__/contactSignal.test.ts    ✓ Created (Phase 4)
│  └─ roiInference.ts                    ✓ Created (Phase 4)
│
└─ [Other files unchanged]
```

---

## NEXT STEPS

1. **Confirm** you're ready for Phase 5 implementation
2. **Read** QUICK_REFERENCE.md for overview
3. **Follow** FILES_TO_MODIFY.md for specific changes
4. **Execute** the 5 modification tasks
5. **Validate** with TypeScript + ESLint + tests
6. **Commit** with clear message
7. **Plan** Phase 6 (label mode)

---

**STATUS**: ✓ RECONNAISSANCE COMPLETE  
**CODE CHANGES IN THIS PHASE**: 0  
**DOCUMENTATION GENERATED**: 4 files  
**READY FOR PHASE 5**: YES ✓

---

For questions, refer to the maps above or review the code comments in:
- contactSignal.ts (implementation + algorithm explanation)
- pogoSideViewAnalyzer.ts (context where contact signal will be wired)
