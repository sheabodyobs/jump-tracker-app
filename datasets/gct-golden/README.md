# Golden Dataset for Pogo Hop Accuracy Validation

**Purpose**: A deterministic, repeatable test suite for measuring offline pogo hop detection accuracy.

**Status**: Foundational (manifest + loader ready; runner implementation TBD)

---

## 📋 Structure

```
datasets/gct-golden/
├── manifest.json          # Test case specifications
├── videos/                # Video files (local, gitignored)
│   ├── pogo_tripod_good_01.mov
│   ├── pogo_low_light_01.mov
│   └── pogo_camera_motion_01.mov
└── README.md              # This file
```

## 📦 Manifest Format

The `manifest.json` file defines:
1. **Metadata**: version, description, FPS assumption
2. **Test Cases**: one per pogo sequence
3. **Ground Truth**: manually labeled landing/takeoff timestamps
4. **Expected Results**: acceptance criteria + error thresholds

### Example Case

```json
{
  "id": "pogo_tripod_good_01",
  "uri": "file://./datasets/gct-golden/videos/pogo_tripod_good_01.mov",
  "notes": "Good lighting, tripod view, clean double-bounce pogo",
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
    "maxP95GctErrMs": 40,
    "maxMedianFlightErrMs": 20,
    "maxP95FlightErrMs": 50
  }
}
```

### Field Reference

#### `id` (required, string)
Unique identifier for the test case. Used in logs and result reporting.

```
Pattern: <jump_type>_<condition>_<index>
Examples:
  - pogo_tripod_good_01
  - pogo_low_light_01
  - pogo_camera_motion_01
```

#### `uri` (required, string)
Video file path. Supports:
- **Relative paths**: `./videos/filename.mov` → resolved relative to manifest directory
- **Absolute paths**: `/full/path/to/file.mov`
- **File URIs**: `file://./relative/path` or `file:///absolute/path`

**Note**: Videos are not stored in git (add to `.gitignore`). The manifest remains stable; contributors use local copies.

#### `roi` (required, object)
Region of interest where feet/leg motion is visible.

- `space`: "normalized" or "pixel"
  - "normalized": coordinates in [0..1] relative to video frame
  - "pixel": absolute pixel coordinates
- `x, y`: Top-left corner
- `width, height`: Dimensions

**Best practice**: Use normalized coordinates for cross-resolution stability.

#### `labels` (required, object)
Ground-truth event timings.

- `source`: One of:
  - "manual-label-mode" - Labeled using in-app label mode UI
  - "external" - Labeled with external tool (Dartfish, etc.)
  - "synthetic" - Generated for testing (not for accuracy validation)
- `toleranceMs`: Matching tolerance (typically 50ms = ±6 frames at 120fps)
- `landingsMs`: Array of ground contact (foot touches ground) timestamps in milliseconds
- `takeoffsMs`: Array of liftoff (foot leaves ground) timestamps in milliseconds

**Constraints**:
- Arrays must be sorted (monotonic increasing)
- Each landing must have a corresponding takeoff after it
- No duplicate timestamps
- `landingsMs[i] < takeoffsMs[i] < landingsMs[i+1]` (valid hop pattern)

#### `expected` (required, object)
Acceptance criteria and error thresholds.

##### If `shouldAccept: true`
The pipeline SHOULD successfully detect hops and meet error bounds.

**At least one** threshold must be specified:

- `maxMedianGctErrMs`: Max acceptable median GCT error (milliseconds)
- `maxP95GctErrMs`: Max acceptable 95th percentile GCT error
- `maxMedianFlightErrMs`: Max acceptable median flight time error
- `maxP95FlightErrMs`: Max acceptable 95th percentile flight time error
- `maxMedianLandingErrMs`: Max acceptable median landing detection error
- `maxP95LandingErrMs`: Max acceptable 95th percentile landing detection error
- `maxMedianTakeoffErrMs`: Max acceptable median takeoff detection error
- `maxP95TakeoffErrMs`: Max acceptable 95th percentile takeoff detection error

**Example**:
```json
{
  "shouldAccept": true,
  "maxMedianGctErrMs": 15,
  "maxP95GctErrMs": 40
}
```

##### If `shouldAccept: false`
The pipeline SHOULD REJECT the video (return null metrics or low confidence).

Optional `reason` field documents why:
- `"low_light"` - Shadows, insufficient brightness
- `"camera_motion"` - Shaky, panned, or zoomed
- `"obscured_ground"` - Ground plane occluded
- `"multiple_people"` - Multiple legs in frame
- `"non_vertical"` - Forward/backward or spinning jump

**Example**:
```json
{
  "shouldAccept": false,
  "reason": "low_light"
}
```

---

## 🎯 How to Add a Test Case

### Step 1: Collect Video
- Record pogo hop on iPhone with 120fps+ slow motion (≥30 frames of contact)
- Ensure clear view of ground contact point
- Keep scene stable or document camera motion

### Step 2: Extract Ground-Truth Labels
1. Open **Jump Tracker** in offline analysis mode
2. Load video
3. Tap **📝 (debug button)** to enter **Label Mode**
4. Frame-by-frame scrubbing:
   - **Prev/Next**: Navigate to each landing (foot touches ground)
   - Tap **Mark Landing** → records timestamp
   - Navigate to each takeoff (foot leaves ground)
   - Tap **Mark Takeoff** → records timestamp
5. Copy accuracy metrics JSON (shown in panel):
   ```
   {
     "landingsMs": [150, 450, 750],
     "takeoffsMs": [300, 600, 900],
     "tolerance": 50
   }
   ```

### Step 3: Measure ROI
1. In label mode, visually identify region containing foot motion
2. Either:
   - Use **pixel coordinates** from frame (width/height known)
   - Estimate **normalized coordinates** as fraction of frame
3. Add to manifest

### Step 4: Add to Manifest
1. Store video in `datasets/gct-golden/videos/`
2. Create new entry in `manifest.json`:
   ```json
   {
     "id": "pogo_<condition>_<num>",
     "uri": "file://./datasets/gct-golden/videos/pogo_<condition>_<num>.mov",
     "notes": "...",
     "roi": { "space": "normalized", "x": ..., "y": ..., "width": ..., "height": ... },
     "labels": { "source": "manual-label-mode", "toleranceMs": 50, "landingsMs": [...], "takeoffsMs": [...] },
     "expected": { "shouldAccept": true, "maxMedianGctErrMs": 15, "maxP95GctErrMs": 40 }
   }
   ```

### Step 5: Validate
```bash
# Dry-run loader validation
npm test -- src/accuracy/goldenDataset.test.ts
# (test file TBD)
```

---

## 💾 Video Storage (Local-Only)

Videos are **not** stored in git to keep repo size small and allow local iteration.

### Setup
1. Create `datasets/gct-golden/videos/` (done; check `.gitignore`)
2. Place video files locally:
   ```bash
   cp ~/Downloads/pogo_tripod_good_01.mov datasets/gct-golden/videos/
   ```
3. Manifest remains stable; contributors work with local copies

### For CI
When implementing the accuracy runner, it will:
1. Check for missing videos
2. Skip (or fail loudly) if video not found
3. Report which tests could not run

---

## 📊 Dataset Statistics

### Current Cases (Stub Manifest)

| ID | Condition | Status | Hops | Expected |
|----|-----------|--------|------|----------|
| `pogo_tripod_good_01` | Good lighting, tripod | ✅ Accept | 3 | median < 15ms |
| `pogo_low_light_01` | Low light | ❌ Reject | 2 | N/A |
| `pogo_camera_motion_01` | Shaky camera | ❌ Reject | 2 | N/A |

### Planned Cases (To Add)
- [ ] `pogo_floor_good_01` - Floor-level view, clean hops
- [ ] `pogo_multibounce_good_01` - 5+ consecutive bounces
- [ ] `pogo_forward_motion_01` - Forward motion (rejection case)
- [ ] `pogo_obscured_ground_01` - Ground partially hidden
- [ ] `pogo_multiple_people_01` - Multiple legs in frame
- [ ] `pogo_stiffness_test_01` - High vs. low stiffness (GCT variation)

---

## 🔄 Validation Rules

The loader (`src/accuracy/goldenDataset.ts`) validates:

### Schema
- ✅ Required fields present
- ✅ Type correctness (strings, numbers, arrays)
- ✅ FPS > 0
- ✅ ROI coordinates in valid range [0..1] for normalized
- ✅ Tolerance ≥ 0

### Data Integrity
- ✅ Timestamps monotonically increasing (no duplicates)
- ✅ Each landing has a corresponding takeoff after it
- ✅ No interleaved takeoff/landing violations
- ✅ At least one threshold for `shouldAccept: true`

### Runtime (When Runner Implemented)
- ❌ Video file exists
- ❌ Video can be decoded
- ❌ Video duration ≥ max timestamp + 100ms
- ❌ FPS matches assumption (or close)

---

## 🛠️ Loader API

```typescript
import { loadGoldenDataset, validateAllUris, getDatasetStats } from './src/accuracy/goldenDataset';

// Load manifest with validation
const manifest = loadGoldenDataset('datasets/gct-golden/manifest.json');
console.log(manifest.cases.length); // 3

// Check which videos are available locally
const { missing, found } = validateAllUris(manifest);
console.log(`Found: ${found}, Missing: ${missing.length}`);

// Get summary stats
const stats = getDatasetStats(manifest);
console.log(`${stats.totalCases} test cases, ${stats.acceptCases} accept, ${stats.rejectCases} reject`);
```

---

## 📝 Notes on Determinism

The golden dataset is designed for **deterministic, repeatable** accuracy measurement:

1. **Same video** → Same frame sequence
2. **Same labels** → Same ground truth
3. **Same pipeline** → Same detected events
4. **Same matching** (50ms tolerance) → Same error metrics
5. **Median/P95 of same errors** → Identical results

This allows:
- ✅ Local testing and parameter tuning
- ✅ CI/CD validation (once runner added)
- ✅ Regression detection (changes in accuracy)
- ✅ Parameter impact analysis (before/after tuning)

**One caveat**: If pipeline uses randomness (e.g., random sampling), must seed the RNG for determinism.

---

## 🚀 Next Steps

### Immediate
1. Add 5-10 real pogo videos with manual labels
2. Implement accuracy runner (PROMPT B)
3. Run locally and iterate on thresholds

### Short-term
1. Expand to 20-30 diverse cases
2. Add corner cases (low light, camera motion, etc.)
3. Parameterize by athlete type (stiffness, jump height)

### Long-term
1. Integrate into CI/CD pipeline
2. Track accuracy regression over commits
3. Archive old results for historical comparison

---

## ❓ FAQ

**Q: Can I use synthetic/simulated videos?**
A: Yes, set `source: "synthetic"`, but such cases do not count toward accuracy targets. They're useful for stress-testing the loader.

**Q: What if my video doesn't match FPS assumption (120)?**
A: Loader will accept it; runner will warn but proceed. Timestamps are in milliseconds, so 60fps or 240fps videos work (just label differently).

**Q: How do I store videos if repo is shared?**
A: Use `git lfs` (large file storage) or external S3 bucket. For now, recommend local-only with documented path structure. CI will skip missing videos.

**Q: Can I have multiple labels per test case?**
A: Not currently. If video is ambiguous, consider splitting into separate cases.

**Q: How precise should labels be?**
A: ±1-2 frames (8-16ms at 120fps) is typical. Tolerance field accounts for frame discretization.

---

**Version**: 0.1.0  
**Last Updated**: January 21, 2026
