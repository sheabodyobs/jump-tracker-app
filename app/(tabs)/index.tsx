// app/(tabs)/index.tsx
import * as ImagePicker from "expo-image-picker";
import React, { useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import {
  EMPTY_ANALYSIS,
  type JumpAnalysis,
} from "../../src/analysis/jumpAnalysisContract";

import { analyzeVideo } from "../../src/analysis/analyzeVideo";
import { MOCK_ANALYSIS } from "../../src/analysis/mockAnalysis";
import { analyzePogoSideView } from "../../src/analysis/pogoSideViewAnalyzer";
import DebugOverlay from "../../src/components/DebugOverlay";
import { selfTestExtractFrames } from "../../src/video/selfTestExtractFrames";

/**
 * Runtime-safe fallback
 * - Must match the current contract version.
 * - Exists to prevent any "undefined" crash even if imports glitch.
 */
const FALLBACK_ANALYSIS: JumpAnalysis = {
  ...EMPTY_ANALYSIS,
  // If EMPTY_ANALYSIS import ever fails at runtime (rare), this object still exists.
  // But because we're spreading EMPTY_ANALYSIS here, keep a hard literal guard below too.
};

const HARD_FALLBACK: JumpAnalysis = {
  version: "0.2.0",
  status: "pending",
  measurementStatus: "synthetic_placeholder",
  metrics: {
    gctSeconds: null,
    gctMs: null,
    flightSeconds: null,
    footAngleDeg: { takeoff: null, landing: null, confidence: 0 },
    gctSecondsLeft: null,
    gctSecondsRight: null,
    gctMsLeft: null,
    gctMsRight: null,
  },
  events: {
    takeoff: { t: null, frame: null, confidence: 0 },
    landing: { t: null, frame: null, confidence: 0 },
  },
  frames: [],
  groundSummary: { type: "unknown", confidence: 0 },
  quality: {
    overallConfidence: 0,
    notes: [],
    reliability: {
      viewOk: false,
      groundDetected: false,
      jointsTracked: false,
      contactDetected: false,
    },
  },
  aiSummary: { text: "", tags: [] },
};

const CONFIDENCE_THRESHOLD = 0.6;

function coerceAnalysis(a: unknown): JumpAnalysis {
  if (!a || typeof a !== "object") return HARD_FALLBACK;

  const obj = a as Partial<JumpAnalysis>;

  // Minimal guards for app safety. If anything is missing, fall back.
  if (
    !obj.version ||
    !obj.status ||
    !obj.measurementStatus ||
    !obj.metrics ||
    !obj.events ||
    !obj.quality ||
    !obj.aiSummary
  ) {
    return HARD_FALLBACK;
  }

  return obj as JumpAnalysis;
}

export default function HomeScreen() {
  const initial = useMemo<JumpAnalysis>(() => {
    // Prefer contract default; fall back if anything is unexpectedly undefined.
    return coerceAnalysis(EMPTY_ANALYSIS ?? FALLBACK_ANALYSIS);
  }, []);

  const [analysis, setAnalysis] = useState<JumpAnalysis>(initial);
  const [videoUri, setVideoUri] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [frameTestReport, setFrameTestReport] = useState<string>("");
  const [groundYInput, setGroundYInput] = useState<string>("");
  const [roiPreset, setRoiPreset] = useState<"small" | "medium" | "large">("medium");
  const [showOverlay, setShowOverlay] = useState(false);

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
      setAnalysis(coerceAnalysis(EMPTY_ANALYSIS));
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
    setAnalysis({ ...coerceAnalysis(EMPTY_ANALYSIS), status: "pending" });

    try {
      const result = await analyzeVideo(videoUri);
      setAnalysis(coerceAnalysis(result));
    } catch {
      setAnalysis({ ...coerceAnalysis(EMPTY_ANALYSIS), status: "error" });
      Alert.alert("Run Analysis", "Analysis failed.");
    } finally {
      setIsAnalyzing(false);
    }
  }

  async function runFrameTest() {
    if (!videoUri) {
      Alert.alert("Frame Test", "Pick a video first.");
      return;
    }

    setFrameTestReport("Running frame extraction test...");

    try {
      const frameBatch = await selfTestExtractFrames(videoUri);
      const frames = frameBatch.frames ?? [];
      const first = frames[0];
      const last = frames[frames.length - 1];
      const groundYValue = Number.parseFloat(groundYInput);
      const roiPresets = {
        small: { roiWidthPx: 64, roiHeightPx: 48, roiPaddingPx: 6 },
        medium: {},
        large: { roiWidthPx: 120, roiHeightPx: 90, roiPaddingPx: 6 },
      } as const;
      const analysisResult = await analyzePogoSideView(videoUri, {
        ...(Number.isFinite(groundYValue) ? { groundY: groundYValue } : {}),
        ...roiPresets[roiPreset],
      });
      const debug = analysisResult.analysisDebug?.groundRoi;
      const scores = debug?.scores ?? {};
      const lines = [
        `Provider: ${frameBatch.debug?.provider ?? "unknown"}`,
        `Measurement: ${frameBatch.measurementStatus}`,
        `Frames: ${frames.length}`,
        `First tMs: ${first?.tMs ?? "—"}`,
        `Last tMs: ${last?.tMs ?? "—"}`,
        `Size: ${first?.width ?? "—"}x${first?.height ?? "—"}`,
        debug?.groundLine ? `GroundY: ${debug.groundLine.y}px` : "GroundY: —",
        debug?.roi
          ? `ROI: x${debug.roi.x}, y${debug.roi.y}, w${debug.roi.w}, h${debug.roi.h}`
          : "ROI: —",
        `ContactScore min/mean/max: ${scores.contactScoreMin?.toFixed?.(2) ?? "—"} / ${
          scores.contactScoreMean?.toFixed?.(2) ?? "—"
        } / ${scores.contactScoreMax?.toFixed?.(2) ?? "—"}`,
        `Takeoff: ${analysisResult.events.takeoff.t ?? "—"}s`,
        `Landing: ${analysisResult.events.landing.t ?? "—"}s`,
        frameBatch.error ? `Error: ${frameBatch.error.code} ${frameBatch.error.message}` : "Error: none",
      ];
      setFrameTestReport(lines.join("\n"));
    } catch {
      setFrameTestReport("Frame extraction test failed.");
    }
  }

  function setMock() {
    // MOCK_ANALYSIS should already match the contract, but keep it safe.
    setAnalysis(coerceAnalysis(MOCK_ANALYSIS));
  }

  function reset() {
    setVideoUri(null);
    setAnalysis(coerceAnalysis(EMPTY_ANALYSIS));
    setIsAnalyzing(false);
  }

  const safe = coerceAnalysis(analysis);
  const isComplete = safe.status === "complete";
  const isRealMeasurement = safe.measurementStatus === "real";

  const metrics = safe.metrics;
  const events = safe.events;
  const quality = safe.quality;
  const aiSummary = safe.aiSummary;

  const overallConfidence = Number.isFinite(quality.overallConfidence)
    ? quality.overallConfidence
    : 0;

  const notes = Array.isArray(quality.notes) ? quality.notes : [];

  const summaryText = typeof aiSummary.text === "string" ? aiSummary.text : "";
  const summaryTags = Array.isArray(aiSummary.tags) ? aiSummary.tags : [];

  const groundDetected =
    safe.groundSummary?.type !== "unknown" && (safe.groundSummary?.confidence ?? 0) > 0;

  const reliability = safe.quality?.reliability ?? {
    viewOk: false,
    groundDetected,
    jointsTracked: false,
    contactDetected: false,
  };

  const formatSeconds = (value: number | null, digits = 3) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return "—";
    return value.toFixed(digits);
  };

  const formatNumber = (value: number | null) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return "—";
    return value.toString();
  };

  // Confidence gate: metrics only render when analysis is complete and confidence is high.
  const metricsVisible = isComplete && overallConfidence >= CONFIDENCE_THRESHOLD;
  const overlayRoi = safe.analysisDebug?.groundRoi?.roi ?? null;
  const overlayEvents = [
    { type: "takeoff" as const, event: safe.events?.takeoff ?? null },
    { type: "landing" as const, event: safe.events?.landing ?? null },
  ];
  const contactScore = safe.analysisDebug?.groundRoi?.rawSamples?.map((s) => s.contactScore);

  // Debug overlay uses a fixed frame size for visualization (no video surface available).
  const debugFrameWidth = 320;
  const debugFrameHeight = 180;

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

        <Pressable style={[styles.button, styles.buttonSecondary]} onPress={reset}>
          <Text style={styles.buttonText}>Reset</Text>
        </Pressable>

        <Pressable style={[styles.button, styles.buttonSecondary]} onPress={runFrameTest}>
          <Text style={styles.buttonText}>Test frames</Text>
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
        <Text style={styles.muted}>
          Measurement: {isRealMeasurement ? "real" : "simulated (not real)"}
        </Text>
        {!isRealMeasurement && (
          <Text style={styles.warning}>
            Simulated output. Not a real measurement.
          </Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Signal</Text>

        <Text style={styles.row}>
          Ground:{" "}
          <Text style={styles.value}>
            {groundDetected ? "detected" : "unknown"}
          </Text>
        </Text>

        <Text style={styles.row}>
          Reliability:{" "}
          <Text style={styles.value}>
            {reliability.viewOk ? "view-ok" : "view-bad"},{" "}
            {reliability.jointsTracked ? "joints-ok" : "joints-missing"},{" "}
            {reliability.contactDetected ? "contact-ok" : "contact-missing"}
          </Text>
        </Text>

        <Text style={styles.row}>
          Overall confidence:{" "}
          <Text style={styles.value}>{overallConfidence.toFixed(2)}</Text>
        </Text>
      </View>

      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.sectionTitle}>Debug overlay</Text>
          <Pressable
            style={[styles.button, styles.buttonSecondary, showOverlay && styles.buttonActive]}
            onPress={() => setShowOverlay((prev) => !prev)}
          >
            <Text style={styles.buttonText}>Debug overlay</Text>
          </Pressable>
        </View>

        {/* Debug overlay helps diagnose ground/ROI/event alignment without changing analysis logic. */}
        {showOverlay ? (
          <View style={styles.debugFrame}>
            <DebugOverlay
              frameWidth={debugFrameWidth}
              frameHeight={debugFrameHeight}
              ground={safe.groundSummary ?? null}
              roi={overlayRoi}
              events={overlayEvents}
              contactScore={contactScore}
              confidence={overallConfidence}
            />
          </View>
        ) : (
          <Text style={styles.muted}>Overlay is off.</Text>
        )}
      </View>

      {/* Invariant:
          - render metrics ONLY when status === "complete"
          - otherwise show explanation + notes
      */}
      {metricsVisible ? (
        <>
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Primary</Text>

            <Text style={styles.row}>
              GCT (s):{" "}
              <Text style={styles.value}>
                {formatSeconds(metrics.gctSeconds)}
              </Text>
            </Text>

            <Text style={styles.row}>
              GCT (ms): <Text style={styles.value}>{formatNumber(metrics.gctMs)}</Text>
            </Text>

            <Text style={styles.row}>
              Flight (s):{" "}
              <Text style={styles.value}>
                {formatSeconds(metrics.flightSeconds)}
              </Text>
            </Text>

            <Text style={styles.row}>
              GCT L/R (ms):{" "}
              <Text style={styles.value}>
                {formatNumber(metrics.gctMsLeft ?? null)} / {formatNumber(metrics.gctMsRight ?? null)}
              </Text>
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Events</Text>

            <Text style={styles.row}>
              Takeoff t: <Text style={styles.value}>{formatNumber(events.takeoff?.t ?? null)}</Text>
            </Text>

            <Text style={styles.row}>
              Landing t: <Text style={styles.value}>{formatNumber(events.landing?.t ?? null)}</Text>
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Debug</Text>

            <Text style={styles.row}>
              Frames: <Text style={styles.value}>{safe.frames?.length ?? 0}</Text>
            </Text>

            <Text style={styles.row}>
              Ground conf:{" "}
              <Text style={styles.value}>
                {(safe.groundSummary?.confidence ?? 0).toFixed(2)}
              </Text>
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Notes</Text>
            <Text style={styles.muted}>{notes.length ? notes.join("\n") : "—"}</Text>
          </View>
        </>
      ) : (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Metrics hidden</Text>
          <Text style={styles.value}>
            {!isComplete
              ? "Analysis not complete yet."
              : overallConfidence < CONFIDENCE_THRESHOLD
              ? "Low confidence — improve angle, lighting, or framing"
              : !isRealMeasurement
              ? "Simulated output: measurements unavailable."
              : "Metrics unavailable."}
          </Text>
          <Text style={styles.muted}>{notes.length ? notes.join("\n") : ""}</Text>
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

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Frame extraction self-test</Text>
        <Text style={styles.row}>Ground Y (px)</Text>
        <TextInput
          style={styles.input}
          value={groundYInput}
          onChangeText={setGroundYInput}
          placeholder="Auto (leave blank)"
          keyboardType="numeric"
        />
        <Text style={styles.row}>ROI preset</Text>
        <View style={styles.actions}>
          {(["small", "medium", "large"] as const).map((preset) => (
            <Pressable
              key={preset}
              style={[
                styles.button,
                styles.buttonSecondary,
                roiPreset === preset && styles.buttonActive,
              ]}
              onPress={() => setRoiPreset(preset)}
            >
              <Text style={styles.buttonText}>{preset}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.muted}>{frameTestReport || "—"}</Text>
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
  buttonActive: { opacity: 1, borderColor: "#2563eb" },
  buttonText: { fontSize: 14, fontWeight: "600" },

  card: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  sectionTitle: { fontSize: 16, fontWeight: "700" },
  rowBetween: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  debugFrame: {
    width: 320,
    height: 180,
    backgroundColor: "#0f172a",
    borderRadius: 8,
    overflow: "hidden",
    position: "relative",
  },
  row: { fontSize: 14 },
  value: { fontSize: 14, fontWeight: "600" },
  muted: { fontSize: 12, opacity: 0.7 },
  warning: { fontSize: 12, fontWeight: "600", color: "#b45309" },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
  },
});
