# Golden Dataset + Accuracy Runner Quick Start

Complete workflow for reproducible offline accuracy testing.

---

## 🎯 Workflow

### Phase 1: Collect Ground-Truth Labels

**On iOS Device:**

1. Open Jump Tracker app
2. Record pogo hop video (120fps slow motion)
3. Load video in offline analysis view
4. Tap **📝 Debug Label Mode** button
5. Frame-by-frame label:
   - **Prev/Next**: Navigate frames
   - **Mark Landing**: When foot touches ground
   - **Mark Takeoff**: When foot leaves ground
6. Copy JSON output: `{ landingsMs, takeoffsMs, tolerance }`

### Phase 2: Add Test Case to Manifest

**On Laptop:**

1. Copy recorded video to `datasets/gct-golden/videos/<caseId>.mov`
   ```bash
   cp ~/Videos/pogo_jump.mov datasets/gct-golden/videos/pogo_new_case_01.mov
   ```

2. Add entry to `datasets/gct-golden/manifest.json`:
   ```json
   {
     "id": "pogo_new_case_01",
     "uri": "file://./datasets/gct-golden/videos/pogo_new_case_01.mov",
     "notes": "Good lighting, tripod view",
     "roi": {
       "space": "normalized",
       "x": 0.35,
       "y": 0.55,
       "width": 0.3,
       "height": 0.35
     },
     "labels": {
       "source": "manual-label-mode",
       "toleranceMs": 50,
       "landingsMs": [150, 450, 750],
       "takeoffsMs": [300, 600, 900]
     },
     "expected": {
       "shouldAccept": true,
       "maxMedianGctErrMs": 15,
       "maxP95GctErrMs": 40
     }
   }
   ```

3. Validate manifest:
   ```bash
   npm test -- src/accuracy/goldenDataset.test.ts  # (when test file exists)
   ```

### Phase 3: Extract and Cache Frames

**On Laptop (with frame extraction available):**

```typescript
import { encodeFramesToCache } from './src/accuracy/frameCache';

// After extracting frames from video:
const frames = [ /* array of extracted frames */ ];

encodeFramesToCache('pogo_new_case_01', frames, roi);
// Writes: datasets/gct-golden/cases/pogo_new_case_01/{frames.json, gray.bin}
```

**Stub for now:**
```bash
# Frame extraction integration pending
# For now, cases without cache will be SKIPPED
```

### Phase 4: Run Accuracy Tests

```bash
npm run accuracy:run
```

**Output:**
```
ACCURACY SUMMARY
============================================================
Cases: 15 total
  - Accept: 10
  - Reject: 5
  - Skipped: 0
  - Errors: 0
...
============================================================

Report written to datasets/gct-golden/reports/latest.json
```

### Phase 5: Review Results

**Console:**
```bash
# Already printed above
npm run accuracy:run  # See console summary
```

**JSON Report:**
```bash
cat datasets/gct-golden/reports/latest.json | jq .
```

**Specific Case:**
```bash
jq '.cases[] | select(.caseId == "pogo_tripod_good_01")' \
  datasets/gct-golden/reports/latest.json
```

---

## 📂 Directory Structure

```
datasets/gct-golden/
├── manifest.json                  # Test case specs
├── README.md                      # How to add cases
├── reports/
│   └── latest.json               # Latest accuracy report
├── videos/                        # Original .mov files (not in git)
│   ├── pogo_tripod_good_01.mov
│   ├── pogo_low_light_01.mov
│   └── pogo_camera_motion_01.mov
└── cases/                         # Frame caches (created by encodeFramesToCache)
    ├── pogo_tripod_good_01/
    │   ├── frames.json
    │   └── gray.bin
    ├── pogo_low_light_01/
    │   ├── frames.json
    │   └── gray.bin
    └── ...
```

---

## 🔌 API Reference

### Frame Cache

```typescript
import { 
  encodeFramesToCache, 
  loadFramesFromCache,
  cacheExists,
  getCacheMetadata,
  deleteCache,
  type CachedFrame,
  type FrameCacheMetadata 
} from './src/accuracy/frameCache';

// Save frames to cache
encodeFramesToCache('pogo_tripod_good_01', frames, roi);

// Load frames from cache
const frames = loadFramesFromCache('pogo_tripod_good_01');

// Check if cache exists
if (cacheExists('pogo_tripod_good_01')) { ... }

// Get metadata only (without loading pixel data)
const metadata = getCacheMetadata('pogo_tripod_good_01');

// Cleanup
deleteCache('pogo_tripod_good_01');
```

### Accuracy Runner

```typescript
import { 
  runAccuracy,
  type AccuracyReport,
  type CaseResult,
  type GlobalMetrics,
  type RejectMetrics 
} from './src/accuracy/runAccuracy';

// Run full analysis
const report = runAccuracy(
  'datasets/gct-golden/manifest.json',
  'datasets/gct-golden/reports'
);

// Access results
console.log(report.summary.allThresholdsPassed);
console.log(report.global?.medianGctErrMs);
console.log(report.cases[0].metrics);
```

### Golden Dataset

```typescript
import { 
  loadGoldenDataset,
  validateAllUris,
  getDatasetStats,
  type GoldenDatasetManifest,
  type GoldenTestCase,
  class ValidationError
} from './src/accuracy/goldenDataset';

// Load and validate manifest
const manifest = loadGoldenDataset('datasets/gct-golden/manifest.json');

// Check which videos are available
const { missing, found } = validateAllUris(manifest);

// Get summary stats
const stats = getDatasetStats(manifest);
```

---

## 🧪 Testing Scenarios

### Scenario 1: Add New Accept Case

```bash
# 1. Record video, label in app
# 2. Add to manifest with expectedAccept=true, thresholds
# 3. Generate frame cache (when pipeline available)
# 4. Run accuracy:run
# 5. Verify thresholdPassed=true
```

### Scenario 2: Add Rejection Case (Low Light)

```bash
# In manifest.json
{
  "id": "pogo_low_light_02",
  "uri": "...",
  "labels": { ... },
  "expected": {
    "shouldAccept": false,
    "reason": "low_light"
  }
}

# Run: npm run accuracy:run
# Check: cases[i].status should be "accept" if pipeline correctly rejects
```

### Scenario 3: Detect Regression

```bash
# Save previous good report
cp datasets/gct-golden/reports/latest.json baseline.json

# Make code changes (parameter tuning)
# Re-run
npm run accuracy:run

# Compare
diff baseline.json datasets/gct-golden/reports/latest.json

# Check if medianGctErrMs increased significantly
```

---

## 🚀 CI/CD Integration

### GitHub Actions Example

```yaml
name: Accuracy Tests

on:
  push:
    branches: [main, develop]

jobs:
  accuracy:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v3
      
      # Install dependencies
      - name: Install dependencies
        run: npm ci
      
      # Run accuracy tests
      - name: Run accuracy tests
        run: npm run accuracy:run
      
      # Check thresholds
      - name: Validate thresholds
        run: |
          PASSED=$(jq '.summary.allThresholdsPassed' \
            datasets/gct-golden/reports/latest.json)
          if [ "$PASSED" != "true" ]; then
            echo "Accuracy thresholds failed"
            exit 1
          fi
      
      # Check reject rate < 5%
      - name: Validate reject rate
        run: |
          RATE=$(jq '.rejectMetrics.rejectRate' \
            datasets/gct-golden/reports/latest.json)
          if (( $(echo "$RATE > 5" | bc -l) )); then
            echo "Reject rate too high: $RATE%"
            exit 1
          fi
      
      # Upload report as artifact
      - name: Upload report
        uses: actions/upload-artifact@v3
        if: always()
        with:
          name: accuracy-report
          path: datasets/gct-golden/reports/latest.json
```

### Pre-commit Hook

```bash
#!/bin/bash
# .git/hooks/pre-commit

npm run accuracy:run || exit 1
git add datasets/gct-golden/reports/latest.json
```

---

## 📊 Metrics to Track

### Per-Case
- Landing error (ms)
- Takeoff error (ms)
- GCT error (ms)
- Flight time error (ms)
- Threshold pass/fail

### Global
- Median GCT error across all cases
- P95 GCT error (worst 5%)
- Reject rate when should accept
- False-accept rate when should reject

### Trends Over Time
- Track metrics.json through CI runs
- Plot median GCT error over commits
- Alert on regressions (error > baseline + threshold)

---

## ❓ FAQ

**Q: Video not found when running accuracy tests?**  
A: Case will be SKIPPED (not FAILED). Video must be in `datasets/gct-golden/videos/` and path in manifest must be relative or file:// URI.

**Q: How do I generate frame caches?**  
A: Call `encodeFramesToCache()` after extracting frames from video. Frame extraction integration pending (awaiting offline pipeline).

**Q: Can I run tests without frame caches?**  
A: Yes, cases without cache will be SKIPPED. At least one case must have cache for meaningful results.

**Q: What's the expected GCT error for "good" conditions?**  
A: 10-20ms median error is typical for side-view foot contact detection. P95 should be < 40ms.

**Q: How do I add a rejection test case?**  
A: Set `expected.shouldAccept=false` and optionally add `reason` (low_light, camera_motion, etc.). Pipeline must correctly reject to pass.

**Q: Can I modify pipeline parameters and re-test?**  
A: Yes. Change parameters, run `npm run accuracy:run` again, compare `latest.json` to previous.

---

## 🔗 Related Files

- **Manifest Spec**: [datasets/gct-golden/README.md](datasets/gct-golden/README.md)
- **Report Schema**: [src/accuracy/REPORT_SCHEMA.md](src/accuracy/REPORT_SCHEMA.md)
- **Implementation**: [src/accuracy/IMPLEMENTATION_SUMMARY.md](src/accuracy/IMPLEMENTATION_SUMMARY.md)
- **Source Code**: 
  - [src/accuracy/frameCache.ts](src/accuracy/frameCache.ts)
  - [src/accuracy/runAccuracy.ts](src/accuracy/runAccuracy.ts)
  - [src/accuracy/goldenDataset.ts](src/accuracy/goldenDataset.ts)

---

**Version**: 1.0.0  
**Last Updated**: January 21, 2026
