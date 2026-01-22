# Quick Reference: Offline ROI Extraction V2

## API Overview

### Main Function: Batch Extraction
```typescript
extractBatchGrayV2(
  uri: string,                          // file:// or ph://
  roi: { x, y, width, height },         // pixels
  timestampsMs: number[],               // milliseconds
  config?: {
    targetSize?: { width, height },     // default 96×64
    rule?: 'target_aspect' | 'fixed_step',  // default target_aspect
    fixedStepX?: number,                // default 4
    fixedStepY?: number                 // default 4
  }
): Promise<{
  ok: boolean,
  frames?: RoiGrayFrameV2[],
  error?: RoiGrayErrorV2
}>
```

### Frame Output
```typescript
interface RoiGrayFrameV2 {
  tMs: number;        // requested time
  tMsActual: number;  // actual decoded frame (snapped)
  width: number;      // downsampled width
  height: number;     // downsampled height
  gray: Uint8Array;   // luma bytes (length = width*height)
}
```

## Common Patterns

### Check if result is valid
```typescript
import { isValidExtractResult } from './src/video/extractRoiGrayV2';

const result = await extractBatchGrayV2(...);

if (!isValidExtractResult(result)) {
  // result.error exists; show to user
  console.error(`Error: [${result.error!.code}] ${result.error!.message}`);
  return; // Don't proceed with metrics
}

// Only here: result.frames is guaranteed present
for (const frame of result.frames) {
  // Safe to use frame data
}
```

### Compute expected output size
```typescript
import { computeOutputDims } from './src/video/extractRoiGrayV2';

const dims = computeOutputDims(
  400,  // roiW
  300,  // roiH
  'target_aspect',
  { targetSize: { width: 96, height: 64 } }
);
// dims = { width: 85, height: 63 }
```

### Compute luma statistics
```typescript
import {
  computeMeanIntensityV2,
  computeVarianceV2
} from './src/video/extractRoiGrayV2';

const mean = computeMeanIntensityV2(frame.gray);
const variance = computeVarianceV2(frame.gray);
console.log(`Luma: mean=${mean.toFixed(1)}, var=${variance.toFixed(1)}`);
```

### Single-frame extraction
```typescript
import { extractSingleGrayV2 } from './src/video/extractRoiGrayV2';

const frame = await extractSingleGrayV2(
  'file:///path/to/video.mov',
  { x: 200, y: 400, width: 400, height: 300 },
  1000, // single timestamp in ms
  { rule: 'target_aspect' }
);

if (frame && 'gray' in frame) {
  // frame is RoiGrayFrameV2
  console.log(`Extracted ${frame.width}×${frame.height}`);
} else if (frame) {
  // frame is RoiGrayErrorV2
  console.error(`[${frame.code}] ${frame.message}`);
}
```

## Downsampling Rules Quick Ref

### target_aspect (default)
- **When**: Preserve aspect ratio, fit to target size
- **Formula**: `floor(roi_dim * min(targetW/roiW, targetH/roiH))`
- **Example**: 400×300 → 96×64 target = 85×63 output
- **Rounding**: floor (conservative)

### fixed_step
- **When**: Divide ROI by constant step (strided sampling)
- **Formula**: `ceil(roi_dim / step)`
- **Example**: 400×300, step=4 = 100×75 output
- **Rounding**: ceil (all pixels sampled)

## Error Codes (Recovery)

| Code | Recoverable | Action |
|------|-------------|--------|
| `USER_CANCELLED` | ✓ | User cancelled |
| `PERMISSION_DENIED` | ✓ | Retry or request permission |
| `URI_UNSUPPORTED` | ✗ | Use file:// or ph:// |
| `ASSET_EXPORT_FAILED` | ✓ | Retry (network/permission) |
| `DECODE_FAILED` | ✗ | Video may be corrupted |
| `TIMESTAMP_OOB` | ✗ | Timestamp beyond duration |
| `ROI_INVALID` | ✗ | Fix ROI bounds |
| `INTERNAL` | ✗ | Unexpected; log + report |

## Performance Tips

- **Batch multiple frames**: `extractBatchGrayV2([t1, t2, ..., t10])` faster than 10 individual calls
- **Reduce output size**: Use smaller target (e.g., 64×48 instead of 96×64)
- **Sample fewer timestamps**: Don't extract every frame; sample intelligently
- **Reuse output dims**: Call `computeOutputDims()` once; use for pre-allocation

## File URIs

**file:// URIs**:
```typescript
'file:///var/mobile/Containers/Data/Application/.../video.mov'
'file:///tmp/video.mov'
```

**ph:// URIs (Photos Library)**:
```typescript
// From Photos picker or camera roll:
'ph://ASSET_ID_FROM_PICKER'
// Exported to temp automatically; cleanup automatic on next launch
```

## Integration Template

```typescript
import {
  extractBatchGrayV2,
  isValidExtractResult,
  computeOutputDims,
  type DownsampleConfig,
} from './src/video/extractRoiGrayV2';

async function analyzeVideoOffline(videoUri: string) {
  const roi = { x: 300, y: 700, width: 400, height: 300 };
  const timestamps = [0, 500, 1000, 1500, 2000, 2500];
  const config: DownsampleConfig = {
    rule: 'target_aspect',
    targetSize: { width: 96, height: 64 }
  };

  // Pre-compute output size
  const dims = computeOutputDims(roi.width, roi.height, config.rule, config);
  console.log(`Expected output: ${dims!.width}×${dims!.height}`);

  // Extract frames
  const result = await extractBatchGrayV2(videoUri, roi, timestamps, config);

  // Guard: only proceed if ok
  if (!isValidExtractResult(result)) {
    const error = result.error!;
    console.error(`[${error.code}] ${error.message}`);
    if (error.recoverable) {
      console.log('Try again later');
    } else {
      console.log('Fix the issue and retry');
    }
    return null;
  }

  // Process frames (guaranteed valid)
  for (const frame of result.frames) {
    const mean = computeMeanIntensityV2(frame.gray);
    console.log(`Frame ${frame.tMsActual}ms: mean=${mean.toFixed(1)}`);
    // Use frame.gray for biomechanical analysis, confidence gating, etc.
  }

  return result.frames;
}
```

## Testing

```bash
# Run tests
npm test src/video/__tests__/extractRoiGrayV2.test.ts

# Or manually:
import { runAllTests } from './src/video/__tests__/extractRoiGrayV2.test';
await runAllTests();
```

---

**Full Spec**: See [docs/OFFLINE_EXTRACTION_V2_SPECS.md](./OFFLINE_EXTRACTION_V2_SPECS.md)  
**Summary**: See [docs/OFFLINE_EXTRACTION_V2_SUMMARY.md](./OFFLINE_EXTRACTION_V2_SUMMARY.md)
