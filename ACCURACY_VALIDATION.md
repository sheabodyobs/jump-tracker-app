# ACCURACY_VALIDATION.md

## Label Mode: Ground-Truth Annotation & Error Measurement

This document describes how to use Label Mode to evaluate the accuracy of the offline jump analysis pipeline.

---

## Quick Start

### Enable Label Mode
1. Open the offline analysis screen after analyzing a video
2. Tap the **📝 debug button** (orange, bottom-right corner)
3. Label Mode panel opens with frame navigation and marking tools

### Label a Video
1. Use **← Prev** / **Next →** buttons to navigate frames
2. When you see a landing (foot touches ground), tap **Mark Landing**
3. When you see a takeoff (foot leaves ground), tap **Mark Takeoff**
4. Repeat until video is fully labeled
5. See accuracy metrics appear automatically

### Clear Labels
- Tap **Clear All** to delete all labels for this video (will prompt for confirmation)

---

## Label Mode UI Walkthrough

```
┌─ Label Mode - Ground Truth ─────────────────────────────────┐
│                                                              │
│ Frame Navigation                                             │
│ Frame 45 / 300                                               │
│ Time: 0.150s (150ms)                                         │
│ [← Prev]  [Next →]                                           │
│                                                              │
│ Mark Event                                                   │
│ [Mark Landing]  [Mark Takeoff]                               │
│ [Clear All]                                                  │
│                                                              │
│ Labels (2)                                                   │
│ ↓ Landing @ 150ms                                            │
│ ↑ Takeoff @ 300ms                                            │
│                                                              │
│ Accuracy Metrics                                             │
│ Labels: 2                                                    │
│ Auto Events: 2                                               │
│ Matched: 2                                                   │
│ Landing Error (n=1): median=5.2ms, p95=5.2ms                │
│ Takeoff Error (n=1): median=-3.1ms, p95=-3.1ms              │
│ GCT Error (n=1): median=8.3ms, p95=8.3ms                    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## How Errors Are Computed

### 1. Event Matching (Nearest-Neighbor)

For each ground-truth label, the algorithm finds the closest auto-detected event of the same type:

```
Rule: Match if distance < 50ms tolerance
      (configurable in evaluateEvents() function)

Landing Labels:     ↓ 150ms  ↓ 450ms  ↓ 800ms
Auto Takeoffs:      ↑ 143ms  ↑ 452ms  ↑ 805ms
                    ↓ 145ms  ↓ 451ms  ↓ 799ms
                    └─ MATCH 5ms
                    └─ MATCH 1ms
                                    └─ MATCH 1ms
```

### 2. Error Calculation

For each matched pair:
```
error_ms = auto_tMs - label_tMs

Examples:
- Auto takeoff @ 143ms, Label @ 150ms  → error = -7ms (early)
- Auto landing @ 451ms, Label @ 450ms  → error = +1ms (late)
- Auto takeoff @ 805ms, Label @ 800ms  → error = +5ms (late)
```

### 3. Aggregate Metrics

From error list: [-7, +1, +5]

**Median Error**:
- Sort: [-7, +1, +5]
- Middle value: +1ms
- Interpretation: Typical takeoff detection is **1ms late**

**P95 Error** (95th percentile):
- Calculate: (95% of 3 = 2.85) → index 2 (rounded)
- Value: +5ms
- Interpretation: In 95% of cases, error is ≤ **5ms**

### 4. GCT Error (Ground Contact Time)

For each pair of matched landing → takeoff labels:
```
label_gct_ms = takeoff_label_tMs - landing_label_tMs
auto_gct_ms  = takeoff_auto_tMs - landing_auto_tMs

gct_error_ms = auto_gct_ms - label_gct_ms

Example:
Landing label @ 150ms, Takeoff label @ 300ms
  → label_gct = 150ms

Auto takeoff @ 143ms, Auto landing @ 452ms
  → auto_gct = 309ms

GCT error = 309 - 150 = +159ms (auto overestimate)
```

---

## Acceptance Targets

### Pogo Hops (Single Bounce)

**Landing Detection**:
- ✅ Target: median error < **10ms**, p95 < **25ms**
- ✅ Typical: ±5ms
- ⚠️ Acceptable: ±15ms
- ❌ Reject: > ±25ms

**Takeoff Detection**:
- ✅ Target: median error < **10ms**, p95 < **25ms**
- ✅ Typical: ±5ms
- ⚠️ Acceptable: ±15ms
- ❌ Reject: > ±25ms

**GCT (Ground Contact Time)**:
- ✅ Target: median error < **20ms**, p95 < **50ms**
- ✅ Typical: ±10ms
- ⚠️ Acceptable: ±25ms
- ❌ Reject: > ±50ms

### Multi-Bounce Sequences

For sequences of 3+ hops:
- **Median error for each landing/takeoff**: still < 10ms
- **Consistency**: p95 should not exceed 3× median
- **Cumulative GCT error**: should not drift > 50ms across sequence

---

## Rejection Criteria (Expected Failures)

The pipeline should gracefully reject analysis in these scenarios:

### 1. Low Light / Shadows
```
Symptoms:
- Contact signal confidence < 0.25
- "Contact signal confidence too low" in rejection reasons
- Metrics = null

Action: Mark labels anyway to quantify the miss rate.
```

### 2. Obscured Ground
```
Symptoms:
- Ground detection confidence < 0.3
- "Ground confidence too low" in rejection reasons
- Metrics = null

Action: Verify ground line is visible in video.
```

### 3. Multiple People
```
Symptoms:
- Foot region detection unreliable
- Unmatched labels (labels marked, but auto found nothing)
- ROI confidence < 0.25

Action: Ensure only one person in frame.
```

### 4. Camera Motion / Blur
```
Symptoms:
- Contact signal choppy (hysteresis triggering)
- Many unmatched auto events (false positives)
- High GCT error variance (p95 >> median)

Action: Use stable camera mount or slow-motion video.
```

### 5. Non-Vertical Jump
```
Symptoms:
- Takeoff happens but landing not detected
- Landing late (>50ms) because foot approach is slow
- GCT error high and positive

Action: Ensure jump is primarily vertical, foot lands on same spot.
```

---

## Step-by-Step Labeling Guide

### Before Labeling
1. **Slow down video**: Open in slow-motion player if possible (120fps helps)
2. **Identify events**: Watch once to find landing/takeoff frames
3. **Check quality**: Ensure good lighting, stable camera

### During Labeling
1. **Start from beginning**: Frame 1
2. **Navigate carefully**: Use Prev/Next, don't skip frames
3. **Mark precisely**: Stop ON the frame where foot touches/leaves
4. **Label in order**: landings → takeoffs should alternate (or be close)

### Typical Pattern
```
Ground:        ═══════════════════════════════════════════
Contact:       OFF  ON↓  OFF↑  ON↓  OFF↑  ON↓  OFF↑
Frame:         [Landing]  [Takeoff]  [Landing]  [Takeoff]
Mark:          Mark Landing → Prev/Next → Mark Takeoff
```

### Verification
- Each landing should be followed by a takeoff
- Time gaps:
  - Landing → Takeoff (GCT): typically 100-400ms
  - Takeoff → Next Landing (flight): typically 100-900ms

---

## Troubleshooting

### No auto-detected events
```
Problem: Metrics are null, so nothing to compare against
Solution: Check rejection reasons in quality.pipelineDebug
Example: "Ground confidence too low: 0.15 < 0.3"
Action: Improve lighting or camera angle
```

### Unmatched labels
```
Problem: I marked an event, but "Unmatched labels: N"
Reason: Auto detector didn't find event within 50ms
Meaning: This is a false negative (missed detection)
Action: Note the frame number, check pipeline diagnostics
```

### Unmatched auto events
```
Problem: "Unmatched auto: N"
Reason: Pipeline detected events you didn't label
Meaning: This is a false positive (spurious detection)
Action: May indicate noisy contact signal (bad lighting)
```

### GCT error very high
```
Problem: GCT error > 100ms median
Reason: Systematic timing shift across all hops
Meaning: Possible ground line detection offset
Action: Verify ground location, re-mark labels
```

---

## Error Interpretation

### Negative Error (Early Detection)
```
error = -5ms means auto detected 5ms BEFORE actual event

Causes:
- Foot approaching too slowly (grazes before full contact)
- ROI too large (includes pre-contact motion)
- Aggressive hysteresis threshold (enters early)

Action: Acceptable if < ±10ms
```

### Positive Error (Late Detection)
```
error = +5ms means auto detected 5ms AFTER actual event

Causes:
- Hysteresis exit threshold too high
- Contact motion energy peaks after actual contact
- Frame sampling misses exact transition

Action: Acceptable if < ±10ms
```

### Systematic Bias
```
Landing errors: [-2, -3, -4] ms
Takeoff errors: [+3, +4, +5] ms

Interpretation:
- Landing consistently EARLY (hysteresis enters fast)
- Takeoff consistently LATE (hysteresis exits slow)

Action: Adjust enterThreshold / exitThreshold in contactSignal.ts
```

---

## Data Storage

Labels are stored in **memory cache** during app session:
- Key: `video_{hash(uri)}`
- Data: `{ videoUri, labels[], createdAt, updatedAt }`
- Persistence: **Session only** (reset on app restart)

### To Export Labels
```typescript
import { loadVideoLabels } from './analysis/labelStorage';

const labels = await loadVideoLabels(videoUri);
// Manually copy JSON and save to file system
console.log(JSON.stringify(labels, null, 2));
```

### To Import Labels
```typescript
// Manually create VideoLabels object and:
import { saveVideoLabels } from './analysis/labelStorage';

await saveVideoLabels(videoUri, labels);
```

---

## Metrics Reference

### What Each Metric Means

| Metric | Formula | Unit | Target |
|--------|---------|------|--------|
| **Landing Error** | auto_land_tMs - label_land_tMs | ms | < 10ms median |
| **Takeoff Error** | auto_takeoff_tMs - label_takeoff_tMs | ms | < 10ms median |
| **GCT Error** | (auto_takeoff - auto_landing) - (label_takeoff - label_landing) | ms | < 20ms median |
| **P95 Error** | 95th percentile of absolute errors | ms | < 25ms |
| **Reject Rate** | (videos with null metrics) / total | % | < 10% |

### How to Read Output
```
Landing Error (n=5): median=2.1ms, p95=8.3ms

n=5          → 5 matched landing pairs
median=2.1ms → Typical error is ~2ms
p95=8.3ms    → 95% of errors are ≤ 8ms
             → Best case: ±2ms, worst case: ±8ms
```

---

## Best Practices

1. **Label consistently**: Use same landmarks (heel contact, toe off) for all hops
2. **Label complete sequences**: Don't skip frames; mark all detectable transitions
3. **Verify in context**: Check auto metrics match your expectations
4. **Document issues**: If reject rate high, note the failure mode
5. **Iterate**: Re-label after pipeline tuning; error should decrease

---

## Next Steps

After collecting accuracy data:

1. **Analyze Results**: Do median errors meet targets?
2. **Identify Weak Points**: Which scenarios have highest error?
3. **Tune Parameters**:
   - contactSignal: enterThreshold, exitThreshold, emaAlpha
   - roiInference: searchBandPx, stride
   - eventExtractor: plausibility bounds
4. **Re-evaluate**: Re-label same videos after tuning
5. **Statistical Analysis**: Plot error distributions, identify outliers

---

## References

- [labelStorage.ts](src/analysis/labelStorage.ts) - Storage API
- [LabelModePanel.tsx](src/components/LabelModePanel.tsx) - UI component
- [PROMPT_6_QUICK_REFERENCE.md](PROMPT_6_QUICK_REFERENCE.md) - Pipeline confidence thresholds
- [contactSignal.ts](src/analysis/contactSignal.ts) - Hysteresis tuning

---

**Status**: Label Mode ready for accuracy validation. Ground truth collection can now begin.
