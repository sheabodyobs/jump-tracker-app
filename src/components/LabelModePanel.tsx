/**
 * src/components/LabelModePanel.tsx
 * 
 * Minimal label mode UI for ground-truth annotation.
 * - Frame scrubber with prev/next
 * - Current frame time display
 * - Mark Landing/Takeoff/Clear buttons
 * - Evaluation readout
 */

import React, { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import type { JumpAnalysis } from '../analysis/jumpAnalysisContract';
import {
    addLabel,
    type AutoEvent,
    clearVideoLabels,
    evaluateEvents,
    formatErrorMetrics,
    type Label,
    loadVideoLabels
} from '../analysis/labelStorage';

export interface LabelModePanelProps {
  videoUri: string;
  frames: Array<{ tMs: number }>;
  jumpAnalysis: JumpAnalysis | null;
  onClose?: () => void;
}

export function LabelModePanel(props: LabelModePanelProps) {
  const { videoUri, frames, jumpAnalysis, onClose } = props;

  const [frameIndex, setFrameIndex] = useState(0);
  const [labels, setLabels] = useState<Label[]>([]);
  const [loading, setLoading] = useState(true);
  const [evaluation, setEvaluation] = useState<any>(null);

  // Load existing labels on mount
  useEffect(() => {
    (async () => {
      const loaded = await loadVideoLabels(videoUri);
      if (loaded?.labels) {
        setLabels(loaded.labels);
      }
      setLoading(false);
    })();
  }, [videoUri]);

  // Recompute evaluation when labels or analysis changes
  useEffect(() => {
    if (!labels.length || !jumpAnalysis) {
      setEvaluation(null);
      return;
    }

    // Extract auto events from analysis
    const autoEvents: AutoEvent[] = [];
    if (jumpAnalysis.events.takeoff.t !== null) {
      autoEvents.push({
        type: 'takeoff',
        tMs: jumpAnalysis.events.takeoff.t * 1000,
        confidence: jumpAnalysis.events.takeoff.confidence ?? 0,
      });
    }
    if (jumpAnalysis.events.landing.t !== null) {
      autoEvents.push({
        type: 'landing',
        tMs: jumpAnalysis.events.landing.t * 1000,
        confidence: jumpAnalysis.events.landing.confidence ?? 0,
      });
    }

    if (autoEvents.length > 0) {
      const result = evaluateEvents(labels, autoEvents);
      setEvaluation(result);
    }
  }, [labels, jumpAnalysis]);

  const currentFrame = frames[frameIndex];
  const currentTMs = currentFrame?.tMs ?? 0;

  const handlePrevFrame = () => {
    setFrameIndex(Math.max(0, frameIndex - 1));
  };

  const handleNextFrame = () => {
    setFrameIndex(Math.min(frames.length - 1, frameIndex + 1));
  };

  const handleMarkLanding = async () => {
    const newLabel: Label = {
      type: 'landing',
      tMs: currentTMs,
    };
    await addLabel(videoUri, newLabel);
    setLabels([...labels, newLabel].sort((a, b) => a.tMs - b.tMs));
  };

  const handleMarkTakeoff = async () => {
    const newLabel: Label = {
      type: 'takeoff',
      tMs: currentTMs,
    };
    await addLabel(videoUri, newLabel);
    setLabels([...labels, newLabel].sort((a, b) => a.tMs - b.tMs));
  };

  const handleClear = async () => {
    if (confirm('Clear all labels for this video?')) {
      await clearVideoLabels(videoUri);
      setLabels([]);
    }
  };

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#0000ff" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>Label Mode - Ground Truth</Text>

      {/* Frame Navigation */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Frame Navigation</Text>
        <Text style={styles.frameInfo}>
          Frame {frameIndex + 1} / {frames.length}
        </Text>
        <Text style={styles.frameInfo}>
          Time: {(currentTMs / 1000).toFixed(3)}s ({currentTMs.toFixed(0)}ms)
        </Text>

        <View style={styles.buttonRow}>
          <TouchableOpacity style={styles.button} onPress={handlePrevFrame}>
            <Text style={styles.buttonText}>← Prev</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.button} onPress={handleNextFrame}>
            <Text style={styles.buttonText}>Next →</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Label Buttons */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Mark Event</Text>
        <View style={styles.buttonRow}>
          <TouchableOpacity style={[styles.button, styles.landingBtn]} onPress={handleMarkLanding}>
            <Text style={styles.buttonText}>Mark Landing</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.button, styles.takeoffBtn]} onPress={handleMarkTakeoff}>
            <Text style={styles.buttonText}>Mark Takeoff</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity style={[styles.button, styles.dangerBtn]} onPress={handleClear}>
          <Text style={styles.buttonText}>Clear All</Text>
        </TouchableOpacity>
      </View>

      {/* Labels List */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Labels ({labels.length})</Text>
        {labels.length === 0 ? (
          <Text style={styles.emptyText}>No labels yet. Mark events above.</Text>
        ) : (
          labels.map((label, idx) => (
            <View key={idx} style={styles.labelItem}>
              <Text style={styles.labelType}>
                {label.type === 'landing' ? '↓ Landing' : '↑ Takeoff'} @ {label.tMs.toFixed(0)}ms
              </Text>
            </View>
          ))
        )}
      </View>

      {/* Evaluation Results */}
      {evaluation && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Accuracy Metrics</Text>
          <Text style={styles.metricLine}>Labels: {evaluation.labelCount}</Text>
          <Text style={styles.metricLine}>Auto Events: {evaluation.autoEventCount}</Text>
          <Text style={styles.metricLine}>Matched: {evaluation.matchedPairs.length}</Text>

          {evaluation.metrics.landing.count > 0 && (
            <Text style={styles.metricLine}>
              {formatErrorMetrics('Landing Error', evaluation.metrics.landing)}
            </Text>
          )}
          {evaluation.metrics.takeoff.count > 0 && (
            <Text style={styles.metricLine}>
              {formatErrorMetrics('Takeoff Error', evaluation.metrics.takeoff)}
            </Text>
          )}
          {evaluation.metrics.gct && evaluation.metrics.gct.count > 0 && (
            <Text style={styles.metricLine}>
              {formatErrorMetrics('GCT Error', evaluation.metrics.gct)}
            </Text>
          )}

          {evaluation.unmatchedLabels.length > 0 && (
            <Text style={[styles.metricLine, styles.warningText]}>
              Unmatched labels: {evaluation.unmatchedLabels.length}
            </Text>
          )}
          {evaluation.unmatchedAuto.length > 0 && (
            <Text style={[styles.metricLine, styles.warningText]}>
              Unmatched auto: {evaluation.unmatchedAuto.length}
            </Text>
          )}
        </View>
      )}

      {/* Close Button */}
      {onClose && (
        <TouchableOpacity style={[styles.button, styles.closeBtn]} onPress={onClose}>
          <Text style={styles.buttonText}>Close Label Mode</Text>
        </TouchableOpacity>
      )}

      <View style={styles.spacer} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#f5f5f5',
    padding: 12,
  },
  title: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 16,
    color: '#333',
  },
  section: {
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#ddd',
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
    color: '#555',
  },
  frameInfo: {
    fontSize: 12,
    color: '#666',
    marginBottom: 4,
    fontFamily: 'Courier',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 8,
    flexWrap: 'wrap',
  },
  button: {
    backgroundColor: '#007AFF',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 6,
    minWidth: 80,
    alignItems: 'center',
  },
  buttonText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  landingBtn: {
    backgroundColor: '#FF6B35',
  },
  takeoffBtn: {
    backgroundColor: '#004E89',
  },
  dangerBtn: {
    backgroundColor: '#A23B72',
    marginTop: 8,
  },
  closeBtn: {
    backgroundColor: '#666',
    marginTop: 8,
  },
  labelItem: {
    paddingVertical: 6,
    paddingHorizontal: 8,
    backgroundColor: '#f9f9f9',
    borderRadius: 4,
    marginBottom: 4,
    borderLeftWidth: 3,
    borderLeftColor: '#007AFF',
  },
  labelType: {
    fontSize: 12,
    color: '#333',
    fontFamily: 'Courier',
  },
  emptyText: {
    fontSize: 12,
    color: '#999',
    fontStyle: 'italic',
  },
  metricLine: {
    fontSize: 11,
    color: '#333',
    marginBottom: 4,
    fontFamily: 'Courier',
  },
  warningText: {
    color: '#FF6B35',
    fontWeight: '600',
  },
  spacer: {
    height: 20,
  },
});
