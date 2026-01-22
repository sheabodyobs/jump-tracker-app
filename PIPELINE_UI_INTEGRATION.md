# Using the Pipeline Example in the UI

## Quick Start: Import and Call

### Option 1: Simple Analysis
```typescript
import { analyzePickedVideo } from '@/src/analysis/pipelineExample';

// When user picks a video
async function handleVideoPicked(uri: string) {
  const result = await analyzePickedVideo(uri);
  
  if (result.status === "complete" && result.metrics.gctSeconds !== null) {
    showMetrics(result.metrics);  // Safe to display
  } else {
    showError("Analysis failed: " + result.quality.notes[0]);
  }
}
```

### Option 2: With Validation
```typescript
import { analyzePickedVideo, passedPipeline } from '@/src/analysis/pipelineExample';

async function handleVideoPicked(uri: string) {
  const result = await analyzePickedVideo(uri);
  
  if (passedPipeline(result)) {
    displayMetricsCard(result);
  } else {
    displayErrorCard(result.quality.pipelineDebug?.rejectionReasons ?? []);
  }
}
```

### Option 3: Batch Processing
```typescript
import { analyzeBatch } from '@/src/analysis/pipelineExample';

async function analyzeMultipleVideos(uris: string[]) {
  const batch = await analyzeBatch(uris);
  
  console.log(`${batch.successful}/${batch.total} videos analyzed successfully`);
  
  batch.results.forEach((result, i) => {
    if (result.status === "error") {
      console.log(`Video ${i}: FAILED - ${result.error?.message}`);
    } else if (result.metrics.gctSeconds) {
      console.log(`Video ${i}: GCT=${result.metrics.gctSeconds.toFixed(3)}s`);
    } else {
      console.log(`Video ${i}: INCOMPLETE - ${result.quality.notes[0]}`);
    }
  });
}
```

---

## UI Component Example: Metrics Display

```typescript
// components/MetricsDisplay.tsx
import type { JumpAnalysis } from '@/src/analysis/jumpAnalysisContract';
import { passedPipeline } from '@/src/analysis/pipelineExample';

export function MetricsDisplay({ result }: { result: JumpAnalysis }) {
  const passed = passedPipeline(result);
  
  if (!passed) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.title}>Analysis Incomplete</Text>
        <Text style={styles.message}>
          {result.quality.pipelineDebug?.rejectionReasons?.[0] ?? 
           "Pipeline failed confidence checks"}
        </Text>
        {result.quality.pipelineDebug && (
          <View style={styles.confidenceGrid}>
            <ConfidenceRow 
              label="Ground" 
              value={result.quality.pipelineDebug.groundConfidence ?? 0}
            />
            <ConfidenceRow 
              label="ROI" 
              value={result.quality.pipelineDebug.roiConfidence ?? 0}
            />
            <ConfidenceRow 
              label="Contact" 
              value={result.quality.pipelineDebug.contactConfidence ?? 0}
            />
            <ConfidenceRow 
              label="Events" 
              value={result.quality.pipelineDebug.eventConfidence ?? 0}
            />
          </View>
        )}
      </View>
    );
  }
  
  // Pipeline passed - safe to show metrics
  return (
    <View style={styles.container}>
      <MetricCard
        label="Ground Contact Time"
        value={result.metrics.gctSeconds ? `${(result.metrics.gctSeconds * 1000).toFixed(0)}ms` : 'N/A'}
        unit="milliseconds"
        confidence={result.quality.overallConfidence}
      />
      <MetricCard
        label="Flight Time"
        value={result.metrics.flightSeconds ? `${(result.metrics.flightSeconds * 1000).toFixed(0)}ms` : 'N/A'}
        unit="milliseconds"
        confidence={result.quality.overallConfidence}
      />
      <EventCard
        takeoff={result.events.takeoff.t}
        landing={result.events.landing.t}
        confidence={Math.min(
          result.events.takeoff.confidence,
          result.events.landing.confidence
        )}
      />
      <DebugCard result={result} />
    </View>
  );
}

function ConfidenceRow({ 
  label, 
  value 
}: { 
  label: string; 
  value: number;
}) {
  const percent = (value * 100).toFixed(0);
  const color = value >= 0.25 ? '#4CAF50' : '#f44336';
  
  return (
    <View style={styles.row}>
      <Text>{label}</Text>
      <View style={[styles.bar, { backgroundColor: color }]}>
        <Text style={styles.percent}>{percent}%</Text>
      </View>
    </View>
  );
}

function DebugCard({ result }: { result: JumpAnalysis }) {
  const debug = result.quality.pipelineDebug;
  if (!debug) return null;
  
  return (
    <View style={styles.debugCard}>
      <Text style={styles.debugTitle}>Pipeline Debug Info</Text>
      <Text style={styles.debugText}>
        Ground: {debug.groundConfidence?.toFixed(2) ?? 'N/A'}
      </Text>
      <Text style={styles.debugText}>
        ROI: {debug.roiConfidence?.toFixed(2) ?? 'N/A'}
      </Text>
      <Text style={styles.debugText}>
        Contact: {debug.contactConfidence?.toFixed(2) ?? 'N/A'}
      </Text>
      <Text style={styles.debugText}>
        Events: {debug.eventConfidence?.toFixed(2) ?? 'N/A'}
      </Text>
      {debug.rejectionReasons?.length > 0 && (
        <View style={styles.rejections}>
          <Text style={styles.rejectTitle}>Issues:</Text>
          {debug.rejectionReasons.map((reason, i) => (
            <Text key={i} style={styles.rejectItem}>• {reason}</Text>
          ))}
        </View>
      )}
    </View>
  );
}
```

---

## Integration with Existing Video Picker

### In `app/(tabs)/index.tsx`

```typescript
import { analyzePickedVideo, passedPipeline } from '@/src/analysis/pipelineExample';

export default function HomeScreen() {
  const [analysisResult, setAnalysisResult] = useState<JumpAnalysis | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  async function handlePickVideo() {
    try {
      // Use existing video picker (whatever you have)
      const pickerResult = await pickVideoAsync();
      
      if (!pickerResult.cancelled) {
        setIsAnalyzing(true);
        
        // NEW: Call the pipeline
        const result = await analyzePickedVideo(pickerResult.uri);
        setAnalysisResult(result);
        
        // Log diagnostics to console
        console.log('[UI] Pipeline result:', {
          status: result.status,
          passed: passedPipeline(result),
          confidence: result.quality.overallConfidence,
          gct: result.metrics.gctSeconds,
          reasons: result.quality.pipelineDebug?.rejectionReasons,
        });
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to analyze video: ' + error);
    } finally {
      setIsAnalyzing(false);
    }
  }

  return (
    <View style={styles.container}>
      <Button 
        title={isAnalyzing ? "Analyzing..." : "Pick & Analyze Video"}
        onPress={handlePickVideo}
        disabled={isAnalyzing}
      />
      
      {analysisResult && (
        <MetricsDisplay result={analysisResult} />
      )}
    </View>
  );
}
```

---

## Error Scenarios & Handling

### Scenario 1: Low Ground Confidence
```
User picks video with poor ground visibility (night, shadows)
  ↓
Ground detector returns: confidence = 0.15
  ↓
Pipeline fails at Stage 1
  ↓
Result: {
  status: "complete",
  metrics: { gctSeconds: null, ... },
  quality: {
    notes: ["Ground detection failed"],
    pipelineDebug: {
      groundConfidence: 0.15,  // < 0.3 threshold
      rejectionReasons: ["Ground confidence too low: 0.15 < 0.3"]
    }
  }
}
  ↓
UI Shows: "Cannot detect ground plane. Try better lighting."
```

### Scenario 2: Network/Processing Error
```
User picks video
  ↓
analyzePickedVideo() throws error during contact signal
  ↓
Catch block returns error JumpAnalysis
  ↓
Result: {
  status: "error",
  metrics: { gctSeconds: null, ... },
  error: {
    code: "PIPELINE_ERROR",
    message: "Contact signal failed: ..."
  },
  quality: {
    pipelineDebug: {
      rejectionReasons: ["Contact signal failed: ..."]
    }
  }
}
  ↓
UI Shows: "Processing error. Please try again."
```

### Scenario 3: All Gates Pass
```
User picks high-quality slow-motion video
  ↓
All 4 pipeline stages succeed with confidence > 0.25
  ↓
pipelineResult.passed = true
  ↓
Metrics populated: {
  gctSeconds: 0.285,
  flightSeconds: 0.620,
  ...
}
  ↓
UI Shows: metrics in large, prominent display
```

---

## Debug Tips

### Enable Console Logging
```typescript
// In pipelineExample.ts, already includes:
console.log('[Pipeline] Starting analysis on:', videoUri);
console.log('[Pipeline] Stage confidences:', ...);
console.log('[Pipeline] ✓ Metrics computed successfully');
```

### Inspect Pipeline Debug
```typescript
const result = await analyzePickedVideo(uri);
const debug = result.quality.pipelineDebug;

console.table({
  Ground: debug?.groundConfidence,
  ROI: debug?.roiConfidence,
  Contact: debug?.contactConfidence,
  Events: debug?.eventConfidence,
});

debug?.rejectionReasons?.forEach(r => {
  console.error('❌', r);
});
```

### Check Individual Stages
```typescript
// To isolate which stage is failing:
if (!result.quality.pipelineDebug) {
  console.log('pipelineDebug not available');
  return;
}

const { groundConfidence, roiConfidence, contactConfidence, eventConfidence } = 
  result.quality.pipelineDebug;

if (groundConfidence < 0.3) {
  console.log('FAIL: Ground detection');
} else if (roiConfidence < 0.25) {
  console.log('FAIL: ROI inference');
} else if (contactConfidence < 0.25) {
  console.log('FAIL: Contact signal');
} else if (eventConfidence < 0.25) {
  console.log('FAIL: Event extraction');
} else {
  console.log('PASS: All stages');
}
```

---

## Performance Expectations

| Operation | Time | Notes |
|-----------|------|-------|
| Frame extraction | 500ms - 2s | Depends on video length |
| Ground detection | 100-300ms | Hough + clustering |
| ROI inference | 50-150ms | Motion energy search |
| Contact signal | 100-200ms | EMA + hysteresis |
| Event extraction | 20-50ms | State machine |
| **Total** | **800ms - 3s** | Full pipeline on 120-frame video |

---

## What's Safe to Show Users

✅ **Always Safe**:
- `result.quality.overallConfidence` (0..1)
- `result.quality.notes` (explanation of what ran)
- `result.quality.reliability` (which subsystems worked)
- `result.quality.pipelineDebug` (diagnostic info)

❌ **Only If `passedPipeline(result)` is true**:
- `result.metrics.gctSeconds`
- `result.metrics.flightSeconds`
- `result.events.takeoff.t`
- `result.events.landing.t`

---

**Next**: Integrate this into your existing UI and run on real videos to validate threshold tuning.
