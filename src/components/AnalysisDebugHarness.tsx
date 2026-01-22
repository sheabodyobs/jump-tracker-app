/**
 * src/components/AnalysisDebugHarness.tsx
 * 
 * Debug wrapper for offline analysis with label mode toggle.
 * Minimal UI to switch between standard view and label mode.
 */

import React, { useState } from 'react';
import {
    SafeAreaView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from 'react-native';
import type { JumpAnalysis } from '../analysis/jumpAnalysisContract';
import { LabelModePanel } from './LabelModePanel';

export interface AnalysisDebugHarnessProps {
  videoUri: string;
  frames: Array<{ tMs: number; [key: string]: any }>;
  jumpAnalysis: JumpAnalysis | null;
  // Children: the standard analysis view
  children?: React.ReactNode;
}

export function AnalysisDebugHarness(props: AnalysisDebugHarnessProps) {
  const { videoUri, frames, jumpAnalysis, children } = props;
  const [labelModeActive, setLabelModeActive] = useState(false);

  if (labelModeActive) {
    return (
      <SafeAreaView style={styles.container}>
        <LabelModePanel
          videoUri={videoUri}
          frames={frames}
          jumpAnalysis={jumpAnalysis}
          onClose={() => setLabelModeActive(false)}
        />
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.container}>
      {children}

      {/* Debug button in corner */}
      <TouchableOpacity
        style={styles.debugButton}
        onPress={() => setLabelModeActive(true)}
      >
        <Text style={styles.debugButtonText}>📝</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  debugButton: {
    position: 'absolute',
    bottom: 20,
    right: 20,
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#FF6B35',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
  },
  debugButtonText: {
    fontSize: 24,
  },
});
