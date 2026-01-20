// app/(tabs)/index.tsx

import * as ImagePicker from "expo-image-picker";
import React, { useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";

import {
  EMPTY_ANALYSIS,
  type JumpAnalysis,
} from "../../src/analysis/jumpAnalysisContract";

import { analyzeVideo } from "../../src/analysis/analyzeVideo";
import { MOCK_ANALYSIS } from "../../src/analysis/mockAnalysis";

// Absolute runtime-safe fallback (prevents any "metrics of undefined" crash even if imports glitch)
const FALLBACK_ANALYSIS: JumpAnalysis = {
  version: "0.1.0",
  status: "pending",
  metrics: {
    gctSeconds: null,
    gctMs: null,
    flightSeconds: null,
    footAngleDeg: { takeoff: null, landing: null, confidence: 0 },
  },
  events: {
    takeoff: { t: null, frame: null, confidence: 0 },
    landing: { t: null, frame: null, confidence: 0 },
  },
  quality: { overallConfidence: 0, notes: [] },
  aiSummary: { text: "", tags: [] },
};

export default function HomeScreen() {
  // Ensure the initial value is NEVER undefined at runtime.
  const initial = useMemo<JumpAnalysis>(() => {
    return (EMPTY_ANALYSIS as JumpAnalysis | undefined) ?? FALLBACK_ANALYSIS;
  }, []);

  const [analysis, setAnalysis] = useState<JumpAnalysis>(initial);
  const [videoUri, setVideoUri] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  async function pickVideo() {
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Videos,
        quality: 1,
      });

      if (res.canceled) return;

      const uri = res.assets?.[0]?.uri ?? null;
      if (!uri) {
        Alert.alert("Pick Video", "No video URI returned.");
        return;
      }

      setVideoUri(uri);
      setAnalysis((EMPTY_ANALYSIS as JumpAnalysis | undefined) ?? FALLBACK_ANALYSIS);
    } catch {
      Alert.alert("Pick Video", "Failed to open photo library.");
    }
  }

  async function runAnalysis() {
    if (!videoUri) {
      Alert.alert("Run Analysis", "Pick a video first.");
      return;
    }

    setIsAnalyzing(true);
    setAnalysis({
      ...(((EMPTY_ANALYSIS as JumpAnalysis | undefined) ?? FALLBACK_ANALYSIS) as JumpAnalysis),
      status: "pending",
    });

    try {
      const result = await analyzeVideo(videoUri);

      // Extra runtime safety: never let analysis become undefined/null.
      if (!result || typeof result !== "object") {
        throw new Error("Invalid analysis output");
      }

      setAnalysis(result as JumpAnalysis);
    } catch {
      setAnalysis({
        ...(((EMPTY_ANALYSIS as JumpAnalysis | undefined) ?? FALLBACK_ANALYSIS) as JumpAnalysis),
        status: "error",
      });
      Alert.alert("Run Analysis", "Analysis failed.");
    } finally {
      setIsAnalyzing(false);
    }
  }

  function setMock() {
    // Make sure mock can never be undefined.
    setAnalysis((MOCK_ANALYSIS as JumpAnalysis | undefined) ?? FALLBACK_ANALYSIS);
  }

  function reset() {
    setVideoUri(null);
    setAnalysis((EMPTY_ANALYSIS as JumpAnalysis | undefined) ?? FALLBACK_ANALYSIS);
    setIsAnalyzing(false);
  }

  // Runtime-safe reads (even if something goes wrong, these won't crash)
  const safe = analysis ?? FALLBACK_ANALYSIS;
  const metrics = safe.metrics ?? FALLBACK_ANALYSIS.metrics;
  const events = safe.events ?? FALLBACK_ANALYSIS.events;
  const quality = safe.quality ?? FALLBACK_ANALYSIS.quality;
  const aiSummary = safe.aiSummary ?? FALLBACK_ANALYSIS.aiSummary;

  const gctSeconds = metrics.gctSeconds ?? null;
  const gctMs = metrics.gctMs ?? null;
  const flightSeconds = metrics.flightSeconds ?? null;

  const takeoffT = events.takeoff?.t ?? null;
  const landingT = events.landing?.t ?? null;

  const overallConfidence = Number.isFinite(quality.overallConfidence)
    ? quality.overallConfidence
    : 0;
  const notes = Array.isArray(quality.notes) ? quality.notes : [];

  const summaryText = typeof aiSummary.text === "string" ? aiSummary.text : "";
  const summaryTags = Array.isArray(aiSummary.tags) ? aiSummary.tags : [];

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Jump Tracker</Text>

      <View style={styles.actions}>
        <Pressable style={styles.button} onPress={pickVideo}>
          <Text style={styles.buttonText}>Pick video</Text>
        </Pressable>

        <Pressable
          style={[styles.button, isAnalyzing && styles.buttonDisabled]}
          onPress={runAnalysis}
          disabled={isAnalyzing}
        >
          <Text style={styles.buttonText}>
            {isAnalyzing ? "Analyzing..." : "Run analysis"}
          </Text>
        </Pressable>

        <Pressable style={[styles.button, styles.buttonSecondary]} onPress={setMock}>
          <Text style={styles.buttonText}>Mock</Text>
        </Pressable>

        <Pressable
          style={[styles.button, styles.buttonSecondary]}
          onPress={reset}
        >
          <Text style={styles.buttonText}>Reset</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Selected video</Text>
        <Text style={styles.muted} numberOfLines={2}>
          {videoUri ?? "—"}
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Status</Text>
        <Text style={styles.value}>{safe.status}</Text>
        <Text style={styles.muted}>v{safe.version}</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Primary</Text>

        <Text style={styles.row}>
          GCT (s):{" "}
          <Text style={styles.value}>
            {gctSeconds !== null ? gctSeconds.toFixed(3) : "—"}
          </Text>
        </Text>

        <Text style={styles.row}>
          GCT (ms): <Text style={styles.value}>{gctMs ?? "—"}</Text>
        </Text>

        <Text style={styles.row}>
          Flight (s):{" "}
          <Text style={styles.value}>
            {flightSeconds !== null ? flightSeconds.toFixed(3) : "—"}
          </Text>
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Events</Text>

        <Text style={styles.row}>
          Takeoff t: <Text style={styles.value}>{takeoffT ?? "—"}</Text>
        </Text>

        <Text style={styles.row}>
          Landing t: <Text style={styles.value}>{landingT ?? "—"}</Text>
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Quality</Text>

        <Text style={styles.row}>
          Overall confidence:{" "}
          <Text style={styles.value}>{overallConfidence.toFixed(2)}</Text>
        </Text>

            <Text style={styles.row}>
              Notes:{" "}
              <Text style={styles.value}>
                {notes.length ? notes.join(", ") : "—"}
              </Text>
            </Text>
          </View>
        </>
      ) : (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Metrics hidden</Text>
          <Text style={styles.value}>
            {safe.status === "error"
              ? "Insufficient confidence to report metrics."
              : "Analysis not complete yet."}
          </Text>
          <Text style={styles.muted}>
            {notes.length ? notes.join("\n") : ""}
          </Text>
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Summary</Text>

        <Text style={styles.value}>
          {summaryText.trim().length ? summaryText : "—"}
        </Text>

        <Text style={styles.muted}>
          {summaryTags.length ? summaryTags.map((t) => `#${t}`).join(" ") : ""}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 12 },
  title: { fontSize: 24, fontWeight: "700" },

  actions: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  button: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
  },
  buttonSecondary: { opacity: 0.7 },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { fontSize: 14, fontWeight: "600" },

  card: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  sectionTitle: { fontSize: 16, fontWeight: "700" },
  row: { fontSize: 14 },
  value: { fontSize: 14, fontWeight: "600" },
  muted: { fontSize: 12, opacity: 0.7 },
});
