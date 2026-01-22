// app/(tabs)/capture.tsx
import { Canvas, Circle, Group, Line, Rect } from "@shopify/react-native-skia";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
    Alert,
    Dimensions,
    GestureResponderEvent,
    Pressable,
    SafeAreaView,
    StyleSheet,
    Text,
    View,
} from "react-native";
import {
    Camera,
    useCameraDevice, useCameraPermission,
    useFrameProcessor,
    type CameraDeviceFormat,
    type CameraRuntimeError,
} from "react-native-vision-camera";
import { applyConfidenceGate } from "../../src/analysis/confidenceGate";
import type { JumpAnalysis } from "../../src/analysis/jumpAnalysisContract";
import { buildDraftAnalysisFromCapture, type LiveCaptureEvent, type LiveCaptureSample } from "../../src/analysis/liveCaptureToAnalysis";
import { computeContactScore, smoothContactScore } from "../../src/video/contactScoreProcessor";
import { GroundLineDetector } from "../../src/video/groundLineDetector";

type FpsState = {
  targetFps: number | null; // 240, 120, or null if unsupported
  effectiveFps: number | null; // computed from frame timestamps
  isRecording: boolean;
  isReliable: boolean; // false if effectiveFps dipped below 120 during recording
};

type OverlayState = {
  groundY: number; // Ground line Y position (pixels)
  roi: { x: number; y: number; w: number; h: number }; // ROI rectangle
  contactScore: number; // 0.00 to 1.00
  inContact: boolean; // Hysteresis-based contact state
  lastGctMs: number | null; // Last ground contact time
  lastFlightMs: number | null; // Last flight time
  lastTakeoffFrameIndex: number | null;
  lastLandingFrameIndex: number | null;
  lastTakeoffTimeMs: number | null;
  lastLandingTimeMs: number | null;
};

type EventMarker = {
  type: "takeoff" | "landing";
  displayUntilMs: number; // Time when marker should disappear
};

const CONTACT_ON_THRESHOLD = 0.60;
const CONTACT_OFF_THRESHOLD = 0.40;
const EVENT_MARKER_DURATION_MS = 500;

export default function CaptureScreen() {
  const { hasPermission, requestPermission } = useCameraPermission();
  const cameraRef = useRef<Camera>(null);
  const screenWidth = Dimensions.get("window").width;
  const screenHeight = Dimensions.get("window").height;

  const [selectedFormat, setSelectedFormat] = useState<CameraDeviceFormat | null>(null);
  const [fpsState, setFpsState] = useState<FpsState>({
    targetFps: null,
    effectiveFps: null,
    isRecording: false,
    isReliable: true,
  });

  // Overlay state
  const [overlayState, setOverlayState] = useState<OverlayState>({
    groundY: screenHeight * 0.8, // Default: 80% down screen
    roi: {
      x: Math.round(screenWidth * 0.3),
      y: Math.round(screenHeight * 0.5),
      w: Math.round(screenWidth * 0.4),
      h: Math.round(screenHeight * 0.2),
    },
    contactScore: 0,
    inContact: false,
    lastGctMs: null,
    lastFlightMs: null,
    lastTakeoffFrameIndex: null,
    lastLandingFrameIndex: null,
    lastTakeoffTimeMs: null,
    lastLandingTimeMs: null,
  });

  // Event markers for visual feedback
  const [eventMarkers, setEventMarkers] = useState<EventMarker[]>([]);

  // Live capture samples and events for analysis
  const [captureSamples, setCaptureSamples] = useState<LiveCaptureSample[]>([]);
  const [captureEvents, setCaptureEvents] = useState<LiveCaptureEvent[]>([]);
  
  // Analyzed result (draft + gated)
  const [analysisResult, setAnalysisResult] = useState<JumpAnalysis | null>(null);

  // Track ground line drag state
  const [draggingGround, setDraggingGround] = useState(false);
  const [draggingRoiX, setDraggingRoiX] = useState(false);
  const [draggingRoiY, setDraggingRoiY] = useState(false);
  const dragThreshold = 30; // pixels for hit area

  // Ground line detector (automatic detection from frames)
  const groundLineDetectorRef = useRef(new GroundLineDetector());
  const [detectedGroundY, setDetectedGroundY] = useState<number | null>(null);
  const [groundLineConfidence, setGroundLineConfidence] = useState(0);
  const [autoDetectGround, setAutoDetectGround] = useState(false); // User toggle

  // Frame timestamp tracking for live FPS calculation
  const timestampsRef = useRef<number[]>([]);

  // Contact score smoothing and frame counting refs
  const frameCountRef = useRef(0);
  const lastFrameProcessTimeRef = useRef(0);

  const device = useCameraDevice("back");

  // Initialize camera format on mount
  useEffect(() => {
    if (!device?.formats) return;

    // Find best format: prefer 240fps, fallback to 120fps
    let best240: CameraDeviceFormat | null = null;
    let best120: CameraDeviceFormat | null = null;

    for (const fmt of device.formats) {
      const maxFps = fmt.maxFps;
      if (maxFps >= 240 && !best240) {
        best240 = fmt;
      }
      if (maxFps >= 120 && maxFps < 240 && !best120) {
        best120 = fmt;
      }
    }

    const selected = best240 || best120;
    const targetFps = best240 ? 240 : best120 ? 120 : null;

    setSelectedFormat(selected ?? null);
    setFpsState((prev) => ({
      ...prev,
      targetFps,
    }));

    if (!selected) {
      Alert.alert(
        "Unsupported Device",
        "This device does not support 120fps capture. Please use an iPhone with Slo-Mo capability."
      );
    }
  }, [device?.formats]);

  // Request camera permission on mount
  useEffect(() => {
    if (hasPermission) return;
    requestPermission();
  }, [hasPermission, requestPermission]);

  // Ground line drag handler
  const handleGroundLinePress = (e: GestureResponderEvent) => {
    const { pageY } = e.nativeEvent;
    const safeAreaOffset = 0; // Adjust if SafeAreaView affects layout
    const localY = pageY - safeAreaOffset;
    if (Math.abs(localY - overlayState.groundY) < dragThreshold) {
      setDraggingGround(true);
    }
  };

  const handleGroundLineMove = (e: GestureResponderEvent) => {
    if (!draggingGround) return;
    const { pageY } = e.nativeEvent;
    const newY = Math.max(0, Math.min(screenHeight, pageY));
    setOverlayState((prev) => ({ ...prev, groundY: newY }));
  };

  const handleGroundLineRelease = () => {
    setDraggingGround(false);
  };

  // ROI drag handlers (simplified: drag top-left corner)
  // Note: ROI adjustment is currently done via buttons; these handlers are reserved for future enhancement
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _handleRoiPress = (e: GestureResponderEvent) => {
    const { pageX, pageY } = e.nativeEvent;
    const { roi } = overlayState;
    const distX = Math.abs(pageX - roi.x);
    const distY = Math.abs(pageY - roi.y);
    const dragThreshold = 30; // pixels for hit area
    if (distX < dragThreshold && distY < dragThreshold) {
      setDraggingRoiX(true);
      setDraggingRoiY(true);
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _handleRoiMove = (e: GestureResponderEvent) => {
    if (!draggingRoiX && !draggingRoiY) return;
    const { pageX, pageY } = e.nativeEvent;
    setOverlayState((prev) => {
      const newRoi = { ...prev.roi };
      if (draggingRoiX) {
        newRoi.x = Math.max(0, Math.min(screenWidth - newRoi.w, pageX));
      }
      if (draggingRoiY) {
        newRoi.y = Math.max(0, Math.min(screenHeight - newRoi.h, pageY));
      }
      return { ...prev, roi: newRoi };
    });
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _handleRoiRelease = () => {
    setDraggingRoiX(false);
    setDraggingRoiY(false);
  };

  // ROI dimension adjustment helpers
  const adjustRoiWidth = (delta: number) => {
    setOverlayState((prev) => ({
      ...prev,
      roi: {
        ...prev.roi,
        w: Math.max(20, Math.min(screenWidth - prev.roi.x, prev.roi.w + delta)),
      },
    }));
  };

  const adjustRoiHeight = (delta: number) => {
    setOverlayState((prev) => ({
      ...prev,
      roi: {
        ...prev.roi,
        h: Math.max(20, Math.min(screenHeight - prev.roi.y, prev.roi.h + delta)),
      },
    }));
  };

  // Hysteresis state machine refs
  const prevContactStateRef = useRef<boolean>(false);
  const frameIndexRef = useRef<number>(0);
  const prevSmoothedScoreRef = useRef<number>(0);

  // Frame processor: compute contact score from pixels in ground band
  const frameProcessor = useFrameProcessor((frame) => {
    try {
      frameCountRef.current += 1;
      frameIndexRef.current += 1;

      // Throttle processing: every Nth frame (e.g., 1 out of 2 to save CPU)
      if (frameCountRef.current % 2 !== 0) return;

      const now = Date.now();
      if (now - lastFrameProcessTimeRef.current < 30) {
        // Skip if less than 30ms since last process
        return;
      }
      lastFrameProcessTimeRef.current = now;

      // NOTE: VisionCamera frame extraction requires platform-specific setup.
      // For iOS, frame.image.toBase64() or native bridge is needed.
      // This is a stub that demonstrates the integration point.
      // In production, implement frame data extraction via:
      //   - frame.pixelFormat
      //   - frame.isMirrored
      //   - Native module call to get frame bytes
      //   - Or use a worklet-based frame processor library

      // For now, we'll just track that the processor is running
      // Real contact score will be computed once frame data access is available
      const frameData = ""; // Would be base64 frame data

      // Attempt automatic ground line detection if enabled
      if (autoDetectGround && frameData) {
        const groundResult = groundLineDetectorRef.current.detectGroundLine(
          frameData,
          300, // Placeholder width (should be frame.width)
          400, // Placeholder height (should be frame.height)
          "rgba"
        );

        // Update detected ground line state (will use if confidence is high)
        setDetectedGroundY(groundResult.y);
        setGroundLineConfidence(groundResult.confidence);

        // Optionally auto-apply if confidence is sufficient (>0.6)
        if (groundResult.confidence > 0.6) {
          setOverlayState((prev) => ({
            ...prev,
            groundY: groundResult.y,
          }));
        }
      }

      let score = 0;
      if (frameData) {
        // Frame data available: compute contact score
        const result = computeContactScore(
          frameData,
          300, // Placeholder width (should be frame.width)
          400, // Placeholder height (should be frame.height)
          "rgba",
          overlayState.roi.x,
          overlayState.roi.y,
          overlayState.roi.w,
          overlayState.roi.h,
          overlayState.groundY,
          { bandHeightPx: 12, downsampleFactor: 2, emaAlpha: 0.3 }
        );
        score = result.score;
      }

      // Apply EMA smoothing
      const smoothed = smoothContactScore(score, prevSmoothedScoreRef.current, 0.3);
      prevSmoothedScoreRef.current = smoothed;

      // Collect sample for later analysis
      const sample: LiveCaptureSample = {
        frameIndex: frameIndexRef.current,
        tMs: now,
        contactScore: smoothed,
        inContact: prevContactStateRef.current, // Use previous state before transition check
        groundY: overlayState.groundY,
        roi: overlayState.roi,
      };
      setCaptureSamples((prev) => [...prev, sample]);

      // Hysteresis state machine: apply thresholds with hysteresis
      let newInContact = prevContactStateRef.current;
      if (smoothed > CONTACT_ON_THRESHOLD) {
        newInContact = true;
      } else if (smoothed < CONTACT_OFF_THRESHOLD) {
        newInContact = false;
      }
      // Otherwise keep previous state (hysteresis band)

      // Detect transitions and emit events
      const stateChanged = newInContact !== prevContactStateRef.current;
      if (stateChanged) {
        prevContactStateRef.current = newInContact;

        if (newInContact) {
          // Transition false -> true: LANDING event
          const landingFrameIndex = frameIndexRef.current;
          const landingTimeMs = now;

          // Record capture event
          setCaptureEvents((prev) => [
            ...prev,
            { type: "landing", frameIndex: landingFrameIndex, tMs: landingTimeMs },
          ]);

          setOverlayState((prev) => {
            // Compute GCT: time from last takeoff to landing
            const gct =
              prev.lastTakeoffTimeMs !== null
                ? landingTimeMs - prev.lastTakeoffTimeMs
                : null;

            return {
              ...prev,
              inContact: true,
              lastLandingFrameIndex: landingFrameIndex,
              lastLandingTimeMs: landingTimeMs,
              lastGctMs: gct,
            };
          });

          // Add landing event marker (auto-hide after 500ms)
          setEventMarkers((prev) => [
            ...prev,
            { type: "landing", displayUntilMs: now + EVENT_MARKER_DURATION_MS },
          ]);
        } else {
          // Transition true -> false: TAKEOFF event
          const takeoffFrameIndex = frameIndexRef.current;
          const takeoffTimeMs = now;

          // Record capture event
          setCaptureEvents((prev) => [
            ...prev,
            { type: "takeoff", frameIndex: takeoffFrameIndex, tMs: takeoffTimeMs },
          ]);

          setOverlayState((prev) => {
            // Compute flight time: time from last landing to takeoff
            const flight =
              prev.lastLandingTimeMs !== null
                ? takeoffTimeMs - prev.lastLandingTimeMs
                : null;

            return {
              ...prev,
              inContact: false,
              lastTakeoffFrameIndex: takeoffFrameIndex,
              lastTakeoffTimeMs: takeoffTimeMs,
              lastFlightMs: flight,
            };
          });

          // Add takeoff event marker (auto-hide after 500ms)
          setEventMarkers((prev) => [
            ...prev,
            { type: "takeoff", displayUntilMs: now + EVENT_MARKER_DURATION_MS },
          ]);
        }
      }

      // Update contact score and clean expired event markers
      setOverlayState((prev) => ({
        ...prev,
        contactScore: smoothed,
      }));

      setEventMarkers((prev) => prev.filter((marker) => marker.displayUntilMs > now));
    } catch (error) {
      console.error("Frame processor error:", error);
      // On error, set score to 0 but don't crash
      setOverlayState((prev) => ({
        ...prev,
        contactScore: 0,
      }));
    }
  }, [overlayState.roi, overlayState.groundY]);

  const startRecording = useCallback(() => {
    if (!cameraRef.current || !selectedFormat) {
      Alert.alert("Start Recording", "Camera not ready.");
      return;
    }

    timestampsRef.current = [];
    groundLineDetectorRef.current.reset(); // Reset ground line detector
    setDetectedGroundY(null);
    setGroundLineConfidence(0);
    
    setFpsState((prev) => ({
      ...prev,
      isRecording: true,
      isReliable: true,
    }));

    // In a real implementation, call cameraRef.current.startRecording() here
    // For now, we simulate recording by starting frame processing
  }, [selectedFormat]);

  const stopRecording = useCallback(() => {
    setFpsState((prev) => ({
      ...prev,
      isRecording: false,
    }));

    // In a real implementation, call cameraRef.current.stopRecording() here
  }, []);

  const finalizeAnalysis = useCallback(() => {
    if (captureSamples.length === 0) {
      Alert.alert("No Data", "No capture samples collected. Please record first.");
      return;
    }

    try {
      // Build draft analysis from samples and events
      const draft = buildDraftAnalysisFromCapture(captureSamples, captureEvents, {
        nominalFps: fpsState.targetFps ?? 120,
      });

      // Apply confidence gate to prevent metric leakage
      const gated = applyConfidenceGate(draft);

      // Store result
      setAnalysisResult(gated);

      // Show summary
      const message = `Analysis complete\nStatus: ${gated.status}\nGCT: ${gated.metrics.gctMs ?? "—"}ms\nFlight: ${(gated.metrics.flightSeconds ?? 0).toFixed(2)}s`;
      Alert.alert("Analysis Result", message);
    } catch (error) {
      console.error("Finalize analysis error:", error);
      Alert.alert("Error", `Failed to finalize analysis: ${error}`);
    }
  }, [captureSamples, captureEvents, fpsState.targetFps]);

  const canRecord = fpsState.targetFps !== null;
  const fpsWarning = fpsState.effectiveFps !== null && fpsState.effectiveFps < 120;

  // Skia overlay component
  const SkiaOverlay = () => (
    <Canvas
      style={{
        position: "absolute",
        width: screenWidth,
        height: screenHeight,
      }}
      onResponderMove={handleGroundLineMove}
      onResponderRelease={handleGroundLineRelease}
      onStartShouldSetResponder={() => draggingGround}
      onMoveShouldSetResponder={() => draggingGround}
    >
      {/* Ground line (horizontal) */}
      <Line
        p1={{ x: 0, y: overlayState.groundY }}
        p2={{ x: screenWidth, y: overlayState.groundY }}
        color="#0f0"
        strokeWidth={2}
      />
      {/* Ground line label */}
      <Circle
        cx={20}
        cy={overlayState.groundY}
        r={6}
        color="#0f0"
      />

      {/* ROI box */}
      <Rect
        x={overlayState.roi.x}
        y={overlayState.roi.y}
        width={overlayState.roi.w}
        height={overlayState.roi.h}
        color="rgba(0, 200, 255, 0.1)"
        strokeWidth={2}
      />
      {/* ROI border - using Line elements */}
      <Line
        p1={{ x: overlayState.roi.x, y: overlayState.roi.y }}
        p2={{ x: overlayState.roi.x + overlayState.roi.w, y: overlayState.roi.y }}
        color="#0c8"
        strokeWidth={2}
      />
      <Line
        p1={{ x: overlayState.roi.x + overlayState.roi.w, y: overlayState.roi.y }}
        p2={{ x: overlayState.roi.x + overlayState.roi.w, y: overlayState.roi.y + overlayState.roi.h }}
        color="#0c8"
        strokeWidth={2}
      />
      <Line
        p1={{ x: overlayState.roi.x + overlayState.roi.w, y: overlayState.roi.y + overlayState.roi.h }}
        p2={{ x: overlayState.roi.x, y: overlayState.roi.y + overlayState.roi.h }}
        color="#0c8"
        strokeWidth={2}
      />
      <Line
        p1={{ x: overlayState.roi.x, y: overlayState.roi.y + overlayState.roi.h }}
        p2={{ x: overlayState.roi.x, y: overlayState.roi.y }}
        color="#0c8"
        strokeWidth={2}
      />

      {/* ROI corner handle (top-left) */}
      <Circle
        cx={overlayState.roi.x}
        cy={overlayState.roi.y}
        r={8}
        color="#0c8"
      />

      {/* Contact score bar (horizontal meter below ROI) */}
      {/* Background bar (static width) */}
      <Rect
        x={overlayState.roi.x}
        y={overlayState.roi.y + overlayState.roi.h + 10}
        width={overlayState.roi.w}
        height={8}
        color="rgba(50, 50, 50, 0.8)"
      />
      {/* Active score indicator (dynamic width) */}
      <Rect
        x={overlayState.roi.x}
        y={overlayState.roi.y + overlayState.roi.h + 10}
        width={overlayState.roi.w * overlayState.contactScore}
        height={8}
        color={overlayState.contactScore > 0.6 ? "#f00" : "#0f0"}
      />

      {/* Event markers (takeoff/landing indicators) */}
      {eventMarkers.map((marker, idx) => (
        <Group key={`event-${idx}`}>
          {/* Marker circle */}
          <Circle
            cx={overlayState.roi.x + overlayState.roi.w + 20}
            cy={overlayState.roi.y + idx * 30}
            r={8}
            color={marker.type === "takeoff" ? "#ff0" : "#f0f"}
          />
          {/* Marker label text (via positioning near circle) */}
          {/* Note: Skia Canvas doesn't have native text, so we use a label via React Native below */}
        </Group>
      ))}
    </Canvas>
  );

  return (
    <SafeAreaView style={styles.container}>
      {hasPermission ? (
        <>
          {device && selectedFormat ? (
            <>
              <Camera
                ref={cameraRef}
                device={device}
                format={selectedFormat}
                fps={fpsState.targetFps || 30}
                isActive={true}
                photo={true}
                video={true}
                audio={false}
                frameProcessor={frameProcessor}
                style={StyleSheet.absoluteFill}
                onError={(error: CameraRuntimeError) => {
                  console.error("Camera error:", error);
                  Alert.alert("Camera Error", error.message);
                }}
              />

              {/* Gesture overlay for ground line and ROI */}
              <View
                style={StyleSheet.absoluteFill}
                onResponderMove={handleGroundLineMove}
                onResponderRelease={handleGroundLineRelease}
                onStartShouldSetResponder={() => draggingGround}
                onMoveShouldSetResponder={() => draggingGround}
                onResponderGrant={handleGroundLinePress}
              >
                <SkiaOverlay />
              </View>

              {/* HUD Overlay (React Native Text) */}
              <View style={styles.skiaHudContainer}>
                <View style={styles.hudInfoBox}>
                  <Text style={styles.hudInfoLabel}>Ground Y: {Math.round(overlayState.groundY)}</Text>
                  <Text style={styles.hudInfoLabel}>ROI: {overlayState.roi.w}x{overlayState.roi.h}</Text>
                  <Text style={[styles.hudInfoLabel, { color: overlayState.inContact ? "#f00" : "#0f0" }]}>
                    Score: {overlayState.contactScore.toFixed(2)}
                  </Text>
                  <Text style={[styles.hudInfoLabel, { color: overlayState.inContact ? "#f00" : "#0f0" }]}>
                    Contact: {overlayState.inContact ? "YES" : "NO"}
                  </Text>
                  <Text style={styles.hudInfoLabel}>GCT: {overlayState.lastGctMs ?? "—"}ms</Text>
                  <Text style={styles.hudInfoLabel}>Flight: {overlayState.lastFlightMs ?? "—"}ms</Text>
                </View>
              </View>

              {/* Event Markers Display */}
              <View style={styles.eventMarkersContainer}>
                {eventMarkers.map((marker, idx) => (
                  <View
                    key={`event-${idx}`}
                    style={[
                      styles.eventMarkerBadge,
                      { backgroundColor: marker.type === "takeoff" ? "#ff0" : "#f0f" },
                    ]}
                  >
                    <Text style={styles.eventMarkerText}>
                      {marker.type === "takeoff" ? "TO" : "LAND"}
                    </Text>
                  </View>
                ))}
              </View>

              {/* Ground Line Detection Controls */}
              <View style={styles.groundLineControlsContainer}>
                <Text style={styles.groundLineLabel}>Ground Detection</Text>
                <Pressable
                  style={[styles.toggleButton, autoDetectGround && styles.toggleButtonActive]}
                  onPress={() => setAutoDetectGround(!autoDetectGround)}
                >
                  <Text style={styles.toggleButtonText}>
                    {autoDetectGround ? "Auto ON" : "Auto OFF"}
                  </Text>
                </Pressable>
                {detectedGroundY !== null && groundLineConfidence > 0 && (
                  <Text style={styles.groundLineLabel}>
                    Detected: {Math.round(detectedGroundY)}px (conf: {(groundLineConfidence * 100).toFixed(0)}%)
                  </Text>
                )}
              </View>

              {/* ROI adjustment controls */}
              <View style={styles.roiControlsContainer}>
                <Text style={styles.roiLabel}>ROI Controls</Text>
                <View style={styles.roiButtonRow}>
                  <Pressable
                    style={styles.smallButton}
                    onPress={() => adjustRoiWidth(-10)}
                  >
                    <Text style={styles.smallButtonText}>W-</Text>
                  </Pressable>
                  <Pressable
                    style={styles.smallButton}
                    onPress={() => adjustRoiWidth(10)}
                  >
                    <Text style={styles.smallButtonText}>W+</Text>
                  </Pressable>
                  <Pressable
                    style={styles.smallButton}
                    onPress={() => adjustRoiHeight(-10)}
                  >
                    <Text style={styles.smallButtonText}>H-</Text>
                  </Pressable>
                  <Pressable
                    style={styles.smallButton}
                    onPress={() => adjustRoiHeight(10)}
                  >
                    <Text style={styles.smallButtonText}>H+</Text>
                  </Pressable>
                </View>
              </View>

              {/* FPS HUD */}
              <View style={styles.hudContainer}>
                <View style={styles.hudBox}>
                  <Text style={styles.hudLabel}>Target FPS</Text>
                  <Text style={styles.hudValue}>
                    {fpsState.targetFps ?? "—"}
                  </Text>
                </View>
                <View style={styles.hudBox}>
                  <Text style={styles.hudLabel}>Effective FPS</Text>
                  <Text
                    style={[
                      styles.hudValue,
                      fpsWarning && styles.hudWarning,
                    ]}
                  >
                    {fpsState.effectiveFps ?? "—"}
                  </Text>
                </View>
              </View>

              {/* FPS Warning Banner */}
              {fpsWarning && (
                <View style={styles.warningBanner}>
                  <Text style={styles.warningText}>
                    ⚠️ FPS too low for GCT (need ≥120)
                  </Text>
                </View>
              )}

              {/* Recording Status */}
              {fpsState.isRecording && (
                <View style={styles.recordingBadge}>
                  <Text style={styles.recordingText}>● RECORDING</Text>
                </View>
              )}

              {/* Reliability Warning */}
              {fpsState.isRecording && !fpsState.isReliable && (
                <View style={styles.reliabilityBanner}>
                  <Text style={styles.reliabilityText}>
                    ⚠️ Session marked as unreliable (FPS dipped below 120)
                  </Text>
                </View>
              )}

              {/* Controls */}
              <View style={styles.controlsContainer}>
                {!fpsState.isRecording ? (
                  <>
                    <Pressable
                      style={[
                        styles.button,
                        !canRecord && styles.buttonDisabled,
                      ]}
                      onPress={startRecording}
                      disabled={!canRecord}
                    >
                      <Text style={styles.buttonText}>Start Recording</Text>
                    </Pressable>
                    {captureSamples.length > 0 && (
                      <Pressable style={styles.button} onPress={finalizeAnalysis}>
                        <Text style={styles.buttonText}>Analyze</Text>
                      </Pressable>
                    )}
                  </>
                ) : (
                  <Pressable style={styles.button} onPress={stopRecording}>
                    <Text style={styles.buttonText}>Stop Recording</Text>
                  </Pressable>
                )}
              </View>

              {/* Analysis Results Display */}
              {analysisResult && (
                <View style={styles.analysisResultsContainer}>
                  <View style={styles.analysisBox}>
                    <Text style={styles.analysisTitle}>Analysis: {analysisResult.status}</Text>
                    {analysisResult.status === "error" && analysisResult.error && (
                      <Text style={[styles.analysisLabel, { color: "#f44" }]}>
                        Error: {analysisResult.error.message}
                      </Text>
                    )}
                    {analysisResult.metrics.gctMs !== null && (
                      <Text style={styles.analysisLabel}>
                        GCT: {analysisResult.metrics.gctMs}ms
                      </Text>
                    )}
                    {analysisResult.metrics.flightSeconds !== null && (
                      <Text style={styles.analysisLabel}>
                        Flight: {(analysisResult.metrics.flightSeconds * 1000).toFixed(0)}ms
                      </Text>
                    )}
                    {analysisResult.quality.notes.length > 0 && (
                      <Text style={[styles.analysisLabel, { fontSize: 9, marginTop: 6 }]}>
                        {analysisResult.quality.notes.slice(0, 2).join("; ")}
                      </Text>
                    )}
                  </View>
                </View>
              )}
            </>
          ) : (
            <View style={styles.noDeviceContainer}>
              <Text style={styles.noDeviceText}>
                This device does not support 120fps capture.
              </Text>
            </View>
          )}
        </>
      ) : (
        <View style={styles.permissionContainer}>
          <Text style={styles.permissionText}>Camera permission required</Text>
          <Pressable style={styles.button} onPress={requestPermission}>
            <Text style={styles.buttonText}>Grant Permission</Text>
          </Pressable>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
  },
  hudContainer: {
    position: "absolute",
    top: 60,
    left: 20,
    right: 20,
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10,
    zIndex: 10,
  },
  hudBox: {
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    flex: 1,
  },
  hudLabel: {
    color: "#ccc",
    fontSize: 11,
    fontWeight: "600",
  },
  hudValue: {
    color: "#0f0",
    fontSize: 18,
    fontWeight: "bold",
    marginTop: 4,
  },
  hudWarning: {
    color: "#f80",
  },
  warningBanner: {
    position: "absolute",
    top: 150,
    left: 20,
    right: 20,
    backgroundColor: "rgba(255, 136, 0, 0.9)",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 6,
    zIndex: 10,
  },
  warningText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "600",
  },
  recordingBadge: {
    position: "absolute",
    top: 20,
    right: 20,
    backgroundColor: "#ff0000",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    zIndex: 10,
  },
  recordingText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "bold",
  },
  reliabilityBanner: {
    position: "absolute",
    bottom: 120,
    left: 20,
    right: 20,
    backgroundColor: "rgba(255, 136, 0, 0.9)",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 6,
    zIndex: 10,
  },
  reliabilityText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "600",
  },
  roiControlsContainer: {
    position: "absolute",
    bottom: 120,
    left: 20,
    right: 20,
    backgroundColor: "rgba(0, 0, 0, 0.8)",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 6,
    zIndex: 10,
  },
  roiLabel: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "600",
    marginBottom: 8,
  },
  roiButtonRow: {
    flexDirection: "row",
    gap: 6,
  },
  smallButton: {
    flex: 1,
    backgroundColor: "#0c8",
    paddingVertical: 6,
    borderRadius: 4,
    alignItems: "center",
  },
  smallButtonText: {
    color: "#000",
    fontSize: 10,
    fontWeight: "600",
  },
  skiaHudContainer: {
    position: "absolute",
    top: 120,
    left: 20,
    right: 20,
    zIndex: 5,
  },
  hudInfoBox: {
    backgroundColor: "rgba(0, 0, 0, 0.75)",
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 6,
  },
  hudInfoLabel: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "500",
    lineHeight: 14,
  },
  controlsContainer: {
    position: "absolute",
    bottom: 40,
    left: 20,
    right: 20,
    flexDirection: "row",
    gap: 12,
  },
  button: {
    flex: 1,
    backgroundColor: "#007AFF",
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
  },
  buttonDisabled: {
    backgroundColor: "#999",
    opacity: 0.5,
  },
  buttonText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "600",
  },
  permissionContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 20,
  },
  permissionText: {
    color: "#fff",
    fontSize: 16,
    marginBottom: 20,
    textAlign: "center",
  },
  noDeviceContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 20,
  },
  noDeviceText: {
    color: "#f44",
    fontSize: 18,
    fontWeight: "600",
    textAlign: "center",
  },
  eventMarkersContainer: {
    position: "absolute",
    top: 220,
    left: 20,
    flexDirection: "row",
    gap: 8,
    zIndex: 5,
  },
  eventMarkerBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    minWidth: 40,
    alignItems: "center",
  },
  eventMarkerText: {
    color: "#000",
    fontSize: 10,
    fontWeight: "700",
  },
  analysisResultsContainer: {
    position: "absolute",
    bottom: 160,
    left: 20,
    right: 20,
    zIndex: 5,
  },
  analysisBox: {
    backgroundColor: "rgba(0, 150, 0, 0.85)",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 6,
    borderLeftWidth: 3,
    borderLeftColor: "#0f0",
  },
  analysisTitle: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 6,
  },
  analysisLabel: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "500",
    lineHeight: 14,
  },
  groundLineControlsContainer: {
    position: "absolute",
    top: 280,
    left: 20,
    backgroundColor: "rgba(0, 0, 0, 0.8)",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 6,
    zIndex: 10,
  },
  groundLineLabel: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "600",
    marginBottom: 8,
  },
  toggleButton: {
    backgroundColor: "#555",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 4,
    alignItems: "center",
  },
  toggleButtonActive: {
    backgroundColor: "#0c8",
  },
  toggleButtonText: {
    color: "#000",
    fontSize: 10,
    fontWeight: "700",
  },
});
