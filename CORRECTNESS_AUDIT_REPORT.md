# CORRECTNESS AUDIT REPORT
## Deterministic Biomechanical Jump Tracker Pipeline

**Date**: January 22, 2026  
**Scope**: Offline-first GCT measurement system (ground detection, foot patch, contact signal, event extraction, accuracy validation)  
**Objective**: Identify correctness errors, logical inconsistencies, edge cases, and silent failure modes that could cause biased or inaccurate GCT/flight measurements.

---

## CRITICAL BUGS (Must Fix)

### 🔴 Bug #1: runAccuracy.ts Uses `indexOf()` on Floating-Point Array – Duplicates Cause Silent Mismatches

**File**: `src/accuracy/runAccuracy.ts`, lines 79–81  
**Function**: `matchEvents()`

```typescript
for (const autoT of autoTimes) {
  // ...
  usedAuto.add(autoTimes.indexOf(autoT)); // ← CRITICAL BUG
  // ...
}
```

**Issue**:  
- `indexOf()` returns the **first occurrence** of a value in the array
- If two autodetected events occur at **identical timestamps** (e.g., both 1500ms due to sub-frame refinement rounding), the second event will always map to index 0, causing a "ghost match"
- The usedAuto set grows but autoTimes[0] might be matched twice, bloating match statistics

**Impact**:  
- **Bias**: Event counts get inflated; unmatched labels for the second occurrence are lost
- **Silent failure**: No error raised; just silently wrong match lists
- **Reproducibility**: Results depend on frame timestamp quantization

**Fix** (minimal):  
Replace loop index tracking with a counter:
```typescript
for (let autoIdx = 0; autoIdx < autoTimes.length; autoIdx++) {
  const autoT = autoTimes[autoIdx];
  // ...
  if (bestLabel !== null && bestDist <= toleranceMs) {
    usedLabels.add(bestLabel);
    usedAuto.add(autoIdx);  // ← Use loop index, not indexOf
    // ...
  }
}
```

---

### 🔴 Bug #2: contactSignal.ts – First Frame Has Zero Energy, Incorrectly Gates Contact

**File**: `src/analysis/contactSignal.ts`, lines 48–53  
**Function**: `computeMotionEnergyInRoi()`

```typescript
for (let t = 0; t < frames.length; t++) {
  const frameData = frames[t].data;
  // ...
  if (t === 0) {
    energies.push(0);  // ← ALWAYS ZERO FOR FIRST FRAME
    continue;
  }
  // ...
}
```

**Issue**:  
- The first frame energy is always 0 because there is no previous frame to diff against
- This zero energy is normalized along with all real energies, artificially suppressing confidence at the start of the sequence
- If a jump starts immediately (frame 0–1 contact transition), the contact gate may fail due to depressed normalization baseline

**Impact**:  
- **Bias**: Early-contact videos may have artificially low contact confidence
- **False rejection**: Videos with immediate ground contact (frame 0) may fail stage 3 of orchestratePipeline
- **Non-uniform**: Later frames benefit from proper energy; frame 0 does not

**Fix** (minimal):  
Replicate the first frame or use frame[0] as the previous for frame[0]:
```typescript
for (let t = 0; t < frames.length; t++) {
  const frameData = frames[t].data;
  const width = frames[t].width;
  const height = frames[t].height;

  if (t === 0) {
    energies.push(0); // First frame has no prior; 0 is acceptable but document it
    continue;
  }
  // ... diff with prevData as before
}
// Alternatively, document that first frame is always 0 and skip it in normalization
```

**Better fix**: Document and skip first frame in confidence metric, OR use a synthetic "all-black" frame-1 as previous for frame 0.

---

### 🔴 Bug #3: eventExtractor.ts – `extractJumpEvents()` Signature Mismatch with orchestratePipeline Call

**File**: `src/analysis/pogoSideViewAnalyzer.ts`, line 486–492  
**Function**: `orchestratePipeline()`, Stage 4

```typescript
const jumpEvents = extractJumpEvents(
  contactState,
  pixelFrames,  // ← TYPE MISMATCH: PixelFrame[] expected, but extractJumpEvents signature is different
  {
    minGctMs: 50,
    maxGctMs: 450,
    minFlightMs: 100,
    maxFlightMs: 900,
    minIntervalMs: 50,
    refinementMethod: 'max_derivative',
    refinementWindowFrames: 3,
  },
  contactSignal.scoreSmoothed // ← Passing smoothed scores as 4th arg
);
```

**Expected signature** (from eventExtractor.ts):
```typescript
export function extractJumpEvents(
  state: (0 | 1)[],
  frames: PixelFrame[],  // or AnalysisFrame[]?
  options?: Partial<EventExtractorOptions>,
  smoothedScores?: number[]  // optional 4th arg
): JumpEvents
```

**Issue**:  
- The call passes `pixelFrames` as the 2nd argument but eventExtractor needs **timestamps**, not pixel data
- The function should receive `timestamps: number[]` (from `pixelFrames.map(f => f.tMs)`) to compute transition timings
- **Silent mismatch**: No compile error if PixelFrame[] is assignable to an expected frame type, but computations will fail

**Impact**:  
- **Silent failure**: Event timing will be nonsensical (using pixel data as timestamps)
- **GCT computation**: Will compute on wrong data, producing garbage timing
- **Rejection bias**: Events may be rejected due to implausible timing derived from pixel values

**Fix** (minimal):  
Extract timestamps and pass them explicitly:
```typescript
const timestamps = pixelFrames.map(f => f.tMs);
const jumpEvents = extractJumpEvents(
  contactState,
  timestamps,
  { /* options */ },
  contactSignal.scoreSmoothed
);
```

Ensure `extractJumpEvents` signature is:
```typescript
export function extractJumpEvents(
  state: (0 | 1)[],
  timestamps: number[],  // ← not frames
  options?: Partial<EventExtractorOptions>,
  smoothedScores?: number[]
): JumpEvents
```

---

### 🔴 Bug #4: labelStorage.ts – Matching Tolerance Is Too Permissive; No Penalty for Multiple Matches

**File**: `src/analysis/labelStorage.ts`, lines 186–206  
**Function**: `matchEvents()`

```typescript
function matchEvents(
  labels: Label[],
  autoEvents: AutoEvent[],
  toleranceMs: number = 50  // ← Default 50ms is large for fast motions
): { matched: MatchedPair[]; unmatchedLabels: Label[]; unmatchedAuto: AutoEvent[] } {
  const matched: MatchedPair[] = [];
  const usedLabels = new Set<number>();
  const usedAuto = new Set<number>();

  // For each label, find nearest auto within tolerance
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    let bestAuto = -1;
    let bestError = toleranceMs;  // ← Threshold set at default
    let usedRefinedForBest = false;

    for (let j = 0; j < autoEvents.length; j++) {
      if (usedAuto.has(j)) continue;

      const auto = autoEvents[j];
      if (auto.type !== label.type) continue;

      // Prefer refined timestamp if available, otherwise use frame-based
      const autoTMs = auto.refinedTMs ?? auto.tMs;
      const error = Math.abs(autoTMs - label.tMs);
      
      if (error < bestError) {  // ← Greedy nearest match
        bestError = error;
        bestAuto = j;
        usedRefinedForBest = auto.refinedTMs !== undefined;
      }
    }
    // ...
  }
}
```

**Issue**:  
1. **Tolerance too large**: 50ms at 240fps is 12 frames. A landing could match to the wrong hop if hops are close.
2. **Greedy matching**: For each label, it finds **nearest** auto, but if two labels are close (e.g., 40ms apart) and two autos are also close, the pairing may be suboptimal (not globally consistent).
3. **No cross-checking**: If label A matches auto X (error 20ms) and label B matches auto Y (error 15ms), but label B could match auto X (error 5ms), the algorithm doesn't detect the better pairing.

**Impact**:  
- **Bias**: Videos with multiple hops close together will have inflated error metrics
- **False positives**: Two hops only 30ms apart might both match to a single label, masking detection failure
- **Accuracy inflation**: Reported accuracy will be optimistically biased

**Fix** (minimal):  
1. Reduce tolerance to 25–35ms (typical frame quantum at 120fps ≈ 8.3ms, at 240fps ≈ 4.2ms)
2. Add a **global optimization** step (Hungarian algorithm or simpler greedy with backtracking) instead of local greedy
3. Flag matched pairs with error > 25ms as "questionable"

**Recommended**:
```typescript
toleranceMs = 25; // Tighten from 50ms

// After matching, validate that no two matches share an auto event
for (const pair of matched) {
  if (pair.errorMs > 25) {
    pair.confidence = 0.5; // Flag as uncertain
  }
}
```

---

### 🔴 Bug #5: pogoSideViewAnalyzer.ts – footPatchConfidence Threshold Inconsistency

**File**: `src/analysis/pogoSideViewAnalyzer.ts`, lines 447–450, 461–463  
**Function**: `orchestratePipeline()` Stage 2

```typescript
// Stage 2: Foot patch confidence
const footPatchConfidence = footPatchResult?.confidence ?? 0;
if (footPatchConfidence < 0.3) {
  reasons.push(`Foot patch confidence too low: ${footPatchConfidence.toFixed(2)}`);
}
// ...
// Overall pass: all stages above minimum
const CONFIDENCE_THRESHOLD = 0.25;
const passed = 
  groundConfidence >= GROUND_CONFIDENCE_MIN &&
  footPatchConfidence >= CONFIDENCE_THRESHOLD &&  // ← Uses 0.25, not 0.3!
  contactConfidence >= CONFIDENCE_THRESHOLD &&
  eventConfidence >= CONFIDENCE_THRESHOLD;
```

**Issue**:  
- Stage 2 rejects if `footPatchConfidence < 0.3` (reason logged)
- But overall pass check gates at `>= 0.25`
- This **inconsistency** means:
  - If footPatch = 0.28, the rejection reason "Foot patch confidence too low: 0.28" is added
  - But then the overall pass check passes (0.28 >= 0.25)
  - Pipeline returns `passed: true` with contradictory `rejectionReasons` array

**Impact**:  
- **Confusion**: Caller sees `passed: true` but reasons include foot patch rejection
- **UI misalignment**: Metrics may be computed despite logged rejection
- **Silent inconsistency**: No error, just contradictory state

**Fix** (minimal):  
Use consistent threshold:
```typescript
const FOOT_PATCH_CONFIDENCE_MIN = 0.25; // or 0.3, but pick one
const footPatchConfidence = footPatchResult?.confidence ?? 0;
if (footPatchConfidence < FOOT_PATCH_CONFIDENCE_MIN) {
  reasons.push(`Foot patch confidence too low: ${footPatchConfidence.toFixed(2)}`);
}
// ...
const passed = 
  groundConfidence >= GROUND_CONFIDENCE_MIN &&
  footPatchConfidence >= FOOT_PATCH_CONFIDENCE_MIN &&  // Same threshold
  contactConfidence >= CONFIDENCE_THRESHOLD &&
  eventConfidence >= CONFIDENCE_THRESHOLD;
```

---

## LIKELY ACCURACY BIASES

### 📊 Bias #1: Frame Indexing Off-by-One in edgeRefinement.ts

**File**: `src/analysis/edgeRefinement.ts`, lines 107–130  
**Function**: `refineByMaxPositiveDerivative()`

```typescript
function refineByMaxPositiveDerivative(
  smoothedScores: number[],
  transitionFrameIndex: number,
  timestamps: number[],
  windowStart: number,
  windowEnd: number
): EdgeRefinementResult {
  let maxDerivative = 0;
  let maxIdx = transitionFrameIndex;

  for (let i = windowStart; i < windowEnd; i++) {  // ← Loop ends at windowEnd - 1
    const derivative = smoothedScores[i + 1] - smoothedScores[i];
    if (derivative > maxDerivative) {
      maxDerivative = derivative;
      maxIdx = i;
    }
  }
  // ...
  const subFrameOffsetMs = interpolateSubFrameOffset(
    smoothedScores[maxIdx],
    smoothedScores[maxIdx + 1],  // ← Accesses [maxIdx + 1]
    timestamps[maxIdx],
    timestamps[maxIdx + 1],      // ← May be out of bounds if maxIdx == windowEnd - 1
    0.5,
    'rising'
  );
  // ...
}
```

**Issue**:  
- Loop condition `i < windowEnd` means `i` goes up to `windowEnd - 1`
- Inside loop, accesses `smoothedScores[i + 1]`, which is OK
- But after loop, `maxIdx` could be `windowEnd - 1`
- Then `interpolateSubFrameOffset` accesses `timestamps[maxIdx + 1]`, which is `timestamps[windowEnd]`
- If `windowEnd = smoothedScores.length - 1`, then `timestamps[windowEnd]` is valid
- **But**: If `windowEnd < smoothedScores.length - 1`, accessing `[windowEnd]` is off-bounds or accesses a different frame

**Impact**:  
- **Silent boundary error**: May read wrong timestamps, biasing sub-frame refinement
- **Landing/takeoff timing**: Could be off by one frame quantum (e.g., 4.2ms at 240fps)
- **GCT bias**: Depending on whether landing or takeoff is refined off, GCT could be systematically too high or too low

**Fix** (minimal):  
Bounds-check or adjust loop:
```typescript
for (let i = windowStart; i < Math.min(windowEnd, smoothedScores.length - 1); i++) {
  const derivative = smoothedScores[i + 1] - smoothedScores[i];
  // ...
}

// Or adjust windowEnd calculation upfront:
const windowEnd = Math.min(windowEnd_requested, smoothedScores.length - 1);
```

---

### 📊 Bias #2: EMA Smoothing Introduces Systematic Latency

**File**: `src/analysis/contactSignal.ts`, lines 118–130  
**Function**: `applyEmaSmoothing()`

```typescript
function applyEmaSmoothing(scores: number[], alpha: number): number[] {
  if (scores.length === 0) return [];

  const smoothed: number[] = [];
  let ema = scores[0];
  smoothed.push(ema);

  for (let i = 1; i < scores.length; i++) {
    ema = alpha * scores[i] + (1 - alpha) * ema;
    smoothed.push(ema);
  }

  return smoothed;
}
```

**Issue**:  
- EMA introduces a **causal low-pass filter** with group delay ~ 1 / (2π * alpha)
- Default alpha = 0.2 → delay ≈ 0.8 frames at typical fps
- Landing (contact onset) is smoothed later than actual; takeoff is also delayed
- **Net effect**: GCT = takeoff - landing will have both delayed, but takeoff might lag more than landing (non-linear)

**Impact**:  
- **Bias**: GCT will be systematically biased (typically upward, as smoothing delays takeoff slightly more)
- **Not symmetric**: Landing onset is "slurred" upward in time; takeoff onset is also delayed, but the derivative (used for edge refinement) may favor one direction
- **Deterministic but inaccurate**: Same bias every run, but physically wrong

**Fix** (minimal):  
1. Document the latency and accept it, or
2. Use zero-phase filter (filter forward and backward) to remove latency:
   ```typescript
   const forward = applyEmaSmoothing(scores, alpha);
   const backward = applyEmaSmoothing([...forward].reverse(), alpha).reverse();
   const result = backward.map((v, i) => (v + forward[i]) / 2);
   ```
3. Use a narrower window in edge refinement to capture pre-smoothing peaks

---

### 📊 Bias #3: normalizeScore() in contactSignal.ts Depends on Full-Sequence Statistics

**File**: `src/analysis/contactSignal.ts`, lines 88–134  
**Function**: `normalizeScore()`

```typescript
if (method === 'medianMAD') {
  const sorted = [...scores].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  const deviations = scores.map((x) => Math.abs(x - median)).sort((a, b) => a - b);
  const mad = deviations[Math.floor(deviations.length / 2)];

  const scale = Math.max(1.48 * mad, 0.001);
  const normalized = scores.map((x) => {
    const normalized_val = (x - median) / scale;
    return Math.max(0, Math.min(1, 0.5 + normalized_val * 0.5));
  });
  // ...
}
```

**Issue**:  
- Normalization uses **median and MAD of the entire sequence**
- If the sequence contains many flight frames (low energy) and few contact frames (high energy), the median will be biased downward
- Contact frames will be normalized to [0.6, 1.0], flight frames to [0, 0.4], appearing well-separated
- **But**: If the video has weak contact (e.g., barefoot pogo), the median might be ~0.3, and contact frames only reach 0.5, causing false rejection
- **Non-local**: The threshold itself changes based on global statistics, not local signal quality

**Impact**:  
- **Bias**: Videos with naturally low contact energy (thin shoes, soft ground) are rejected
- **False negatives**: Legitimate weak contacts fail stage 3
- **Video-dependent**: Same person, different shoe, different result

**Fix** (minimal):  
1. Use **adaptive threshold** based on local contrast, not global median:
   ```typescript
   const contactPeaks = scores.filter(s => s > median);
   const flightFloor = scores.filter(s => s < median);
   const scale = Math.max(median - flightFloor_median, 0.1); // Use separation, not MAD
   ```
2. Or add a second validation: if confidence < 0.4 but signal is present, escalate to human review

---

## SILENT FAILURE RISKS

### ⚠️ Risk #1: No Null Check on Frame Data Before Pixel Extraction

**File**: `src/analysis/pogoSideViewAnalyzer.ts`, lines 538–560  
**Function**: `analyzeContactFromRoi()`

```typescript
pixelFrames.forEach((frame) => {
  const luma = extractRoiLuma(frame, roi);  // ← No check if frame.data is valid
  const edgeEnergy = computeEdgeEnergy(luma, roi.w, roi.h);
  // ...
});

function extractRoiLuma(frame: PixelFrame, roi: { x: number; y: number; w: number; h: number }) {
  const luma = new Float32Array(roi.w * roi.h);
  let ptr = 0;
  for (let y = 0; y < roi.h; y += 1) {
    const row = roi.y + y;
    for (let x = 0; x < roi.w; x += 1) {
      const col = roi.x + x;
      const idx = (row * frame.width + col) * 4;
      luma[ptr] = lumaAt(frame.data, idx);  // ← If frame.data is empty, silent 0
      ptr += 1;
    }
  }
  return luma;
}

function lumaAt(data: Uint8ClampedArray, idx: number) {
  const r = data[idx];      // ← Undefined becomes 0
  const g = data[idx + 1];
  const b = data[idx + 2];
  return 0.299 * r + 0.587 * g + 0.114 * b;
}
```

**Issue**:  
- If `frame.data` is empty or corrupted, `lumaAt()` silently returns 0 (all channels undefined → 0)
- All luma values become 0, energies become 0, contact score becomes 0, pipeline is rejected
- **Silent**: No error is thrown; rejection reason is vague ("Contact signal confidence too low")

**Impact**:  
- **Silent rejection**: Frame extraction failure is hidden as "weak contact"
- **No diagnostic**: Caller can't distinguish between low-contrast foot and broken frame data
- **Untraceability**: Accuracy audits will flag as "false negative," not "frame error"

**Fix** (minimal):  
Add explicit check:
```typescript
if (!frame.data || frame.data.length === 0) {
  throw new Error(`Frame data missing at tMs=${frame.tMs}`);
}
```

---

### ⚠️ Risk #2: eventExtractor.ts Does Not Validate State Array Length Matches Timestamps

**File**: `src/analysis/eventExtractor.ts`, lines 65–85  
**Function**: `findTransitions()`

```typescript
function findTransitions(
  state: (0 | 1)[],
  timestamps: number[]
): { frameIndex: number; tMs: number; from: 0 | 1; to: 0 | 1 }[] {
  const transitions: { frameIndex: number; tMs: number; from: 0 | 1; to: 0 | 1 }[] = [];

  for (let i = 1; i < state.length; i++) {  // ← Assumes timestamps[i] exists
    if (state[i] !== state[i - 1]) {
      transitions.push({
        frameIndex: i,
        tMs: timestamps[i],  // ← May be undefined if timestamps.length < state.length
        from: state[i - 1],
        to: state[i],
      });
    }
  }

  return transitions;
}
```

**Issue**:  
- No check that `state.length === timestamps.length`
- If `timestamps` is shorter (e.g., timestamps are decimated), `timestamps[i]` is undefined
- Undefined timestamp becomes NaN in downstream computations (e.g., hop.gctMs = NaN - landing.tMs = NaN)
- **Silent**: NaN propagates through; no error until metrics are serialized

**Impact**:  
- **Silent NaN**: GCT becomes NaN, passes serialization (JSON allows NaN), but breaks UI
- **Metric inflation**: Accuracy runner sees NaN in matching; comparison fails silently
- **Data loss**: GCT metrics become null/NaN, indistinguishable from legitimate rejection

**Fix** (minimal):  
Add validation:
```typescript
if (state.length !== timestamps.length) {
  throw new Error(`State (${state.length}) and timestamps (${timestamps.length}) length mismatch`);
}
```

---

### ⚠️ Risk #3: groundDetector.ts Hough Transform Can Return Vertical Lines with Theta Near π/2, Causing Division by Near-Zero

**File**: `src/analysis/groundDetector.ts`, lines 323–355  
**Function**: `computeLineEndpoints()`

```typescript
function computeLineEndpoints(
  theta: number,
  rho: number,
  width: number,
  height: number
): [Point2D, Point2D] {
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  const intersections: Point2D[] = [];

  // Top edge (y=0)
  if (Math.abs(sin) > 1e-6) {
    const x = (rho - 0 * sin) / cos;  // ← Divides by cos; if cos ≈ 0 (vertical line), x is huge
    if (x >= 0 && x <= width) {
      intersections.push({ x, y: 0 });
    }
  }
  // ...
}
```

**Issue**:  
- For a vertical line (theta ≈ π/2), cos ≈ 0
- Check `Math.abs(sin) > 1e-6` protects against vertical division by zero in the sin denominator
- **But**: Check for cos is missing (`if (Math.abs(cos) > 1e-6)` for the division by cos)
- If sin ≈ 1 and cos ≈ 0 (a true vertical line), and we try to compute intersection with top/bottom edges, we divide by cos ≈ 0, yielding x = ±∞
- The `if (x >= 0 && x <= width)` check may fail, but the computation happened and could overflow or produce Infinity

**Impact**:  
- **Silent overflow**: Infinity coordinates in line endpoints; rendering might silently skip or crash
- **Rarely triggered**: Only for truly vertical lines (rare in pogo videos)
- **Nondeterministic fallback**: If intersections.length < 2, returns hardcoded corners (bad fallback)

**Fix** (minimal):  
Check cos before division:
```typescript
// Top edge (y=0)
if (Math.abs(sin) > 1e-6 && Math.abs(cos) > 1e-6) {  // ← Add cos check
  const x = (rho - 0 * sin) / cos;
  if (x >= 0 && x <= width) {
    intersections.push({ x, y: 0 });
  }
}
```

---

## DETERMINISM RISKS

### 🔄 Risk #1: Floating-Point Accumulation in Median and Percentile Calculations

**File**: `src/analysis/contactSignal.ts`, lines 88–134  
**Function**: `normalizeScore()`

```typescript
const normalized = scores.map((x) => {
  const normalized_val = (x - median) / scale;
  return Math.max(0, Math.min(1, 0.5 + normalized_val * 0.5));  // ← Floating-point ops
});
```

**Issue**:  
- Computing `(x - median) / scale` involves floating-point subtraction and division
- Results depend on **CPU architecture** (x86-64 vs ARM) and **optimization level** (O0 vs O3)
- On different devices, the same input may produce slightly different normalized values (e.g., 0.5000000001 vs 0.4999999999)
- Thresholds like `0.55` for contact decision may flip due to FP error

**Impact**:  
- **Device variance**: Same video, different phone, might get slightly different results
- **CI vs device mismatch**: Automated tests may pass on CI (x86-64) but fail on device (ARM)
- **Non-reproducible**: Offline testing won't catch this

**Fix** (minimal):  
1. Use **rounding and fixed-precision** in threshold comparisons:
   ```typescript
   const normalized = Math.round(normalized_val * 1e6) / 1e6;
   if (normalized > 0.55 + 1e-6) { /* ... */ }  // Add epsilon tolerance
   ```
2. Or accept the variance and document it as ±0.001 in metrics

---

### 🔄 Risk #2: Object Key Iteration Order in Diagnostics (Minor)

**File**: Multiple files use `diagnostics: { ... }`  
**Issue**:  
- In JS, object key iteration order is **insertion order** for string keys, but not guaranteed in all contexts
- If diagnostics objects are copied or reconstructed, key order may vary
- Mostly cosmetic, but affects JSON serialization determinism

**Fix** (minimal):  
Use OrderedMap or explicitly sort keys:
```typescript
const diagnostics = {
  featureScores: { /* sorted alphabetically */ },
  selectedFrom,
  reinitCount,
  avgShiftPx,
  band,
  reasons,
};
```

---

### 🔄 Risk #3: Synthetic Frame Generation Uses Seeded PRNG – Is It Truly Deterministic?

**File**: `src/analysis/pogoSideViewAnalyzer.ts`, lines 172–198  
**Function**: `generateSyntheticFrames()`

```typescript
function seededRandom(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;  // ← Linear congruential generator
    return (state - 1) / 2147483646;
  };
}

function generateSyntheticFrames(uri: string): PixelFrame[] {
  const seed = hashString(uri || "pogo");  // ← Hash of URI
  const rand = seededRandom(seed);
  // ...
  const footX = Math.floor(width * (0.45 + rand() * 0.1));
  // ...
}
```

**Issue**:  
- `hashString()` implementation uses `<<` and bitwise OR, which are JS-specific
- The **same URI** should produce the **same hash**, but `String.charCodeAt()` behavior may vary across JS engines (Node vs V8 vs Safari JSC)
- Seed is deterministic **within a single JS engine**, but not guaranteed across engines

**Impact**:  
- **CI consistency**: If CI runs on Node and device runs on React Native JSC, hashes may differ
- **Frame mismatch**: Different synthetic frames for "real" measurement failure, leading to different analysis results
- **False negatives**: Benchmarks run on CI might pass but fail on device

**Fix** (minimal):  
1. Use a stable hash (e.g., SHA-256 of URI), not char code sum:
   ```typescript
   import crypto from 'crypto';
   const hash = parseInt(crypto.createHash('sha256').update(uri).digest('hex').slice(0, 8), 16);
   ```
2. Or accept synthetic frames as "placeholder" and never trust them for accuracy

---

## CONFIDENCE GATE WEAKNESSES

### 🔐 Weakness #1: Foot Patch Confidence Can Be Set Too Low in Fallback

**File**: `src/analysis/pogoSideViewAnalyzer.ts`, lines 858–880  
**Function**: `analyzePogoSideView()`, ROI fallback logic

```typescript
if (footPatchResult && footPatchResult.confidence >= 0.25) {
  roi = footPatchResult.roi;
  footPatchConfidence = footPatchResult.confidence;
} else if (groundDetectorOutput.line) {
  // Fallback to motion-based ROI from ground inference (legacy)
  const roiInference = inferRoiFromGround(grayscaleFrames, groundDetectorOutput);
  if (roiInference.roi) {
    roi = roiInference.roi;
    footPatchConfidence = Math.min(0.25, roiInference.confidence);  // ← Capped at 0.25!
  } else {
    const { roi: legacyRoi } = computeGroundAndRoi(extractedFrames, config);
    roi = legacyRoi;
    footPatchConfidence = 0.1;
  }
} else {
  const { roi: legacyRoi } = computeGroundAndRoi(extractedFrames, config);
  roi = legacyRoi;
  footPatchConfidence = 0.1;
}
```

**Issue**:  
- If footPatch fails but ground is detected, fallback sets `footPatchConfidence = Math.min(0.25, ...)` (capped)
- But then in orchestratePipeline, the pass check is `footPatchConfidence >= 0.25`
- **Result**: Fallback ROI is assigned confidence = 0.25 or 0.1, but both pass the gate
- **No distinction**: Confident foot patch (0.8) and desperate fallback (0.1) both pass as long as they reach 0.25

**Impact**:  
- **Accuracy inflation**: Fallback ROI may be completely wrong (e.g., picking arm instead of foot) but passes confidence gate
- **No differentiation**: Metrics derived from fallback are just as "trusted" as those from real foot detection
- **Silent degradation**: Caller sees `passed: true` and doesn't know the ROI is a guess

**Fix** (minimal):  
Add a flag to distinguish fallback from detected:
```typescript
let roiSource: 'foot_patch' | 'ground_inference' | 'legacy' = 'legacy';

if (footPatchResult && footPatchResult.confidence >= 0.25) {
  roi = footPatchResult.roi;
  footPatchConfidence = footPatchResult.confidence;
  roiSource = 'foot_patch';
} else if (groundDetectorOutput.line) {
  // ...
  roiSource = 'ground_inference';
}

// In orchestratePipeline:
if (roiSource === 'legacy') {
  reasons.push('ROI from legacy fallback only; no foot patch detected');
  footPatchConfidence = 0;  // Force failure
}
```

---

### 🔐 Weakness #2: Contact Signal Confidence Can Be Artificially High When Norm Fails

**File**: `src/analysis/contactSignal.ts`, lines 158–250  
**Function**: `computeContactSignal()`

```typescript
export function computeContactSignal(
  frames: RawFrame[],
  roi: { x: number; y: number; w: number; h: number }
): ContactSignal {
  // ... compute scores ...
  
  const { normalized: scoreNorm, diagnostics: normDiag } = normalizeScore(scores, normMethod);
  // ... apply EMA ...
  const smoothed = applyEmaSmoothing(scoreNorm, emaAlpha);
  // ... apply hysteresis ...
  const { state, chatterCount } = applyHysteresis(smoothed, enterThresh, exitThresh, minFrames);
  
  // Confidence is based on threshold separation and stability
  const confidence = clamp01(
    (enterThresh - exitThresh) / 0.5 + (1 - chatterCount / state.length) / 2
  );

  return {
    score: scores,
    scoreSmoothed: smoothed,
    state,
    thresholds: { enter: enterThresh, exit: exitThresh },
    confidence,
    diagnostics: { norm: normDiag, chatterCount },
  };
}
```

**Issue**:  
- Confidence is computed as: `(enterThresh - exitThresh) / 0.5 + (1 - chatterCount / state.length) / 2`
- If `enterThresh = 0.3, exitThresh = 0.15`, then `(0.3 - 0.15) / 0.5 = 0.3`, confidence = 0.3 + stability/2
- **Problem**: The formula is not validated; if hysteresis width is small, confidence is low
- **But**: No check that the normalized signal actually contains a clear contact region (e.g., multiple frames in [enter, exit])
- A flat signal with tiny noise could have high chatterCount = 0, high confidence, but no real contact

**Impact**:  
- **False positive**: Noisy video with no contact can pass confidence gate
- **Silent degradation**: Metrics computed on flat signal, all zeros, but passed as valid

**Fix** (minimal):  
Add minimum width check and peak presence:
```typescript
const thresholdWidth = enterThresh - exitThresh;
if (thresholdWidth < 0.1) {  // Too narrow
  confidence *= 0.5;
}

// Count frames actually in hysteresis band
const bandFrames = scoreNorm.filter(s => s >= exitThresh && s <= enterThresh).length;
if (bandFrames < 2) {  // Too few
  confidence = 0;
}
```

---

## EDGE CASES NOT COVERED

### 🧩 Edge Case #1: Hop with Landing but No Takeoff (Incomplete Last Hop)

**File**: `src/analysis/eventExtractor.ts`, lines 220–238  
**Function**: `computeFlightTimes()`

```typescript
function computeFlightTimes(hops: Hop[], landings: JumpEvent[]): Hop[] {
  return hops.map((hop, idx) => {
    const nextLanding = landings.find((l) => l.tMs > hop.takeoffMs);
    if (nextLanding) {
      const flightMs = nextLanding.tMs - hop.takeoffMs;
      return { ...hop, flightMs };
    }
    return hop;  // ← flightMs remains null
  });
}
```

**Issue**:  
- If a takeoff has no next landing (video ends, or contact resumes), `flightMs` is null
- Downstream, `applyPlausibilityBounds()` skips null flights:
  ```typescript
  if (hop.flightMs !== null) {
    if (hop.flightMs < options.minFlightMs) {
      // reject
    }
  }
  ```
- **Result**: Incomplete hops pass all flight bounds, but their GCT may be wrong if landing was mis-detected

**Impact**:  
- **Silent bias**: Last hop in a video has unvalidated GCT, may be inflated if contact extends past frame limit
- **Metrics**: Median GCT includes the incomplete hop, biasing upward
- **No warning**: No rejection reason for "incomplete hop"

**Fix** (minimal):  
Add explicit rejection for incomplete hops:
```typescript
const validHops = hops.filter((hop) => {
  // Incomplete hops: reject if we're not sure of the takeoff
  if (hop.flightMs === null) {
    reasons['no_next_landing'] = (reasons['no_next_landing'] ?? 0) + 1;
    return false;  // Require complete hop
  }
  // ...
});
```

Or mark them with lower confidence:
```typescript
if (hop.flightMs === null) {
  hop.confidence = 0.3;  // Add confidence field
}
```

---

### 🧩 Edge Case #2: Zero-Length Video (Single Frame)

**File**: `src/analysis/pogoSideViewAnalyzer.ts`, lines 820–839  
**Function**: `analyzePogoSideView()`

```typescript
export async function analyzePogoSideView(
  uri: string,
  config: GroundRoiConfig = {}
): Promise<JumpAnalysis> {
  // ...
  const { pixelFrames, batch, measurementStatus, nominalFps } = await sampleFramesForAnalysis(uri);
  // ...
  const grayscaleFrames = toGrayscaleFrames(pixelFrames);
  const groundDetectorOutput = detectGround(grayscaleFrames);  // ← What if grayscaleFrames.length === 1?
  // ...
  const { analyzedFrames, contactSignals, rawSamples, stats } = analyzeContactFromRoi(
    pixelFrames,
    groundLineY,
    roi
  );
  // ...
}
```

**Issue**:  
- If `pixelFrames.length === 1`, there's only one frame
- `detectGround()` requires multiple frames for temporal clustering; behavior undefined with 1 frame
- `contactSignal` computes energy as diff to prior frame; for frame 0, energy = 0, but frame 1 doesn't exist
- `eventExtractor` finds transitions; with 1 frame and state = [0], no transitions
- **Result**: Empty events, no hops, metrics = null, but **passed: true** if confidence gates are skipped

**Impact**:  
- **Edge case**: User records a 1-frame video (accidental tap); analysis returns metrics: null without clear rejection reason
- **Silent**: No error; just empty results

**Fix** (minimal):  
Add explicit check:
```typescript
if (pixelFrames.length < 2) {
  return buildSlowMoFailure('Requires at least 2 frames.');
}
```

---

### 🧩 Edge Case #3: All Frames in Contact (No Takeoff)

**File**: `src/analysis/eventExtractor.ts`, lines 173–215  
**Function**: `pairLandingsAndTakeoffs()`

```typescript
if (landings.length === 0 || takeoffs.length === 0) {
  reasons['no_events'] = 1;
  return { hops, reasons };  // ← Returns empty hops array
}
```

**Issue**:  
- If state = [1, 1, 1, ...] (always contact), there's one implicit landing at frame 0 and no takeoff
- `findTransitions()` finds no transitions (state never changes)
- Landings = [], takeoffs = [], hops = [], reasons['no_events'] = 1
- Metrics = null, confidence = 0, **passed: false** ✓

**This is correct**, but the **implicit assumption** is: "if no transitions, no hops." This is true but not documented.

**Risk**: If a future change modifies state detection (e.g., implicit initial state is 1 instead of 0), this assumption breaks silently.

**Fix** (minimal):  
Document explicitly:
```typescript
// NOTE: This assumes state[0] is always 0 (in flight at start).
// If state[0] === 1, a landing is implicit at frame 0.
// Implement if needed:
if (state[0] === 1) {
  const implicitLanding = { frameIndex: 0, tMs: timestamps[0], from: 0, to: 1 };
  // process...
}
```

---

## RECOMMENDED FIXES (Minimal, Deterministic)

### Priority 1: Critical Bugs (Fix Before Deployment)

| Bug | File | Lines | Fix |
|-----|------|-------|-----|
| **indexOf() on array with duplicates** | runAccuracy.ts | 79–81 | Use loop index instead of indexOf |
| **First frame zero energy** | contactSignal.ts | 48–53 | Document or use synthetic prior frame |
| **Type mismatch in extractJumpEvents call** | pogoSideViewAnalyzer.ts | 486 | Pass timestamps array, not frames |
| **Confidence threshold inconsistency** | pogoSideViewAnalyzer.ts | 447, 461 | Use single threshold (0.25 or 0.3) |

### Priority 2: Accuracy Biases (Fix for Correct Metrics)

| Bias | File | Lines | Fix |
|------|------|-------|-----|
| **Off-by-one in edge refinement** | edgeRefinement.ts | 107–130 | Bounds-check window before accessing [i+1] |
| **EMA smoothing introduces latency** | contactSignal.ts | 118–130 | Use zero-phase filtering or document delay |
| **Normalization depends on global stats** | contactSignal.ts | 88–134 | Use local contrast or adaptive threshold |
| **Matching tolerance too permissive** | labelStorage.ts | 186–206 | Reduce from 50ms to 25ms; use global optimization |

### Priority 3: Silent Failures (Fix to Add Diagnostics)

| Risk | File | Fix |
|------|------|-----|
| **No null check on frame data** | pogoSideViewAnalyzer.ts | Throw if frame.data is empty |
| **State/timestamps length mismatch** | eventExtractor.ts | Assert state.length === timestamps.length |
| **Vertical line division by zero** | groundDetector.ts | Add cos check before division |
| **Fallback ROI marked as detected** | pogoSideViewAnalyzer.ts | Add roiSource flag; fail if legacy |
| **Incomplete hops not rejected** | eventExtractor.ts | Reject hops with flightMs === null |
| **Single-frame videos accepted** | pogoSideViewAnalyzer.ts | Assert pixelFrames.length >= 2 |

---

## INVARIANTS TO ENFORCE

These invariants should **always** hold; violations indicate a bug:

### Invariant 1: Metrics Are Null ⟺ Pipeline Passed = False

```typescript
// In JumpAnalysis:
if (metrics.gctMs !== null || metrics.flightSeconds !== null) {
  assert(pipelineDebug.passed === true, "Metrics populated despite failed pipeline");
}
```

**Why**: Metrics should never be computed if any confidence gate failed.

---

### Invariant 2: State Array and Timestamps Have Equal Length

```typescript
assert(state.length === timestamps.length, 
  `State (${state.length}) and timestamps (${timestamps.length}) length mismatch`);
```

**Why**: Every frame must have a timestamp; indices must align.

---

### Invariant 3: Landing Comes Before Takeoff in Each Hop

```typescript
for (const hop of hops) {
  assert(hop.landingMs < hop.takeoffMs, 
    `Landing (${hop.landingMs}) not before takeoff (${hop.takeoffMs})`);
}
```

**Why**: Contact phase must have duration ≥ 0.

---

### Invariant 4: GCT and Flight Bounds Are Respected

```typescript
for (const hop of validHops) {
  assert(hop.gctMs >= options.minGctMs && hop.gctMs <= options.maxGctMs,
    `GCT ${hop.gctMs} out of bounds [${options.minGctMs}, ${options.maxGctMs}]`);
  if (hop.flightMs !== null) {
    assert(hop.flightMs >= options.minFlightMs && hop.flightMs <= options.maxFlightMs,
      `Flight ${hop.flightMs} out of bounds [${options.minFlightMs}, ${options.maxFlightMs}]`);
  }
}
```

**Why**: Plausibility bounds must be enforced; invalid hops must be rejected.

---

### Invariant 5: Confidence Is Always in [0, 1]

```typescript
function assertConfidence(c: number, label: string) {
  assert(Number.isFinite(c) && c >= 0 && c <= 1,
    `${label} confidence ${c} not in [0, 1]`);
}

assertConfidence(groundConfidence, "Ground");
assertConfidence(footPatchConfidence, "Foot patch");
assertConfidence(contactConfidence, "Contact");
assertConfidence(eventConfidence, "Event");
```

**Why**: Confidence values drive decision logic; NaN or out-of-range breaks gates.

---

## SUMMARY

This pipeline is **well-architected** with clear confidence gating, but has **5 critical bugs** that cause silent failures or biased metrics:

1. **runAccuracy.ts `indexOf()` bug** → Silent duplicate matches
2. **contactSignal.ts first-frame zero energy** → Rejects early contact
3. **pogoSideViewAnalyzer.ts type mismatch** → Garbage event timing
4. **pogoSideViewAnalyzer.ts threshold inconsistency** → Contradictory rejection logic
5. **labelStorage.ts tolerance too permissive** → Inflated accuracy metrics

Additionally, **3 accuracy biases** introduce systematic errors:
- EMA smoothing latency
- Normalization based on global statistics
- Edge refinement off-by-one bounds

**Recommended action**: Fix Priority 1 bugs immediately, add invariant assertions, and re-run accuracy validation on golden dataset.

