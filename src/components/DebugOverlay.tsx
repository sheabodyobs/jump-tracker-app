import React from "react";
import { StyleSheet, Text, View } from "react-native";

import type { GroundModel2D, JumpEvent } from "../analysis/jumpAnalysisContract";

const CONFIDENCE_THRESHOLD = 0.6;

export type DebugOverlayProps = {
  frameWidth: number;
  frameHeight: number;
  ground?: GroundModel2D | null;
  roi?: { x: number; y: number; w: number; h: number } | null;
  events?: Array<{ type: "landing" | "takeoff"; event: JumpEvent | null }>;
  contactScore?: number[];
  confidence: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function getGroundEndpoints(
  ground: GroundModel2D | null | undefined,
  frameWidth: number,
  frameHeight: number
): { x1: number; y1: number; x2: number; y2: number } | null {
  if (!ground || ground.type === "unknown") return null;

  if (ground.type === "hough_polar" && ground.line) {
    return {
      x1: clamp(ground.line.x1, 0, frameWidth),
      y1: clamp(ground.line.y1, 0, frameHeight),
      x2: clamp(ground.line.x2, 0, frameWidth),
      y2: clamp(ground.line.y2, 0, frameHeight),
    };
  }

  if (ground.type === "y_scalar" && typeof ground.y === "number") {
    const y = clamp(ground.y, 0, frameHeight);
    return { x1: 0, y1: y, x2: frameWidth, y2: y };
  }

  if (ground.type === "line2d" && ground.a !== null && ground.b !== null) {
    const y1 = clamp(ground.a * 0 + ground.b, 0, frameHeight);
    const y2 = clamp(ground.a * frameWidth + ground.b, 0, frameHeight);
    return { x1: 0, y1, x2: frameWidth, y2 };
  }

  return null;
}

function Line({ x1, y1, x2, y2, color }: { x1: number; y1: number; x2: number; y2: number; color: string }) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx);
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;

  return (
    <View
      style={[
        styles.line,
        {
          width: length,
          left: midX - length / 2,
          top: midY - 1,
          backgroundColor: color,
          transform: [{ rotateZ: `${angle}rad` }],
        },
      ]}
    />
  );
}

export default function DebugOverlay(props: DebugOverlayProps) {
  const {
    frameWidth,
    frameHeight,
    ground,
    roi,
    events,
    contactScore,
    confidence,
  } = props;

  const groundLine = getGroundEndpoints(ground, frameWidth, frameHeight);
  const groundColor = (ground?.confidence ?? 0) >= CONFIDENCE_THRESHOLD ? "#22c55e" : "#f59e0b";

  const totalFrames = contactScore?.length ?? 0;

  return (
    <View style={[styles.overlay, { width: frameWidth, height: frameHeight }]}>
      {groundLine && (
        <Line
          x1={groundLine.x1}
          y1={groundLine.y1}
          x2={groundLine.x2}
          y2={groundLine.y2}
          color={groundColor}
        />
      )}

      {roi && (
        <View
          style={[
            styles.roi,
            {
              left: roi.x,
              top: roi.y,
              width: roi.w,
              height: roi.h,
            },
          ]}
        />
      )}

      {events && totalFrames > 1 &&
        events.map((item, idx) => {
          const frame = item.event?.frame;
          if (typeof frame !== "number") return null;
          const x = clamp((frame / (totalFrames - 1)) * frameWidth, 0, frameWidth - 1);
          const color = item.type === "landing" ? "#a855f7" : "#3b82f6";
          return (
            <View
              key={`${item.type}-${idx}`}
              style={[
                styles.eventMarker,
                {
                  left: x,
                  backgroundColor: color,
                },
              ]}
            />
          );
        })}

      <View style={styles.badge}>
        <Text style={styles.badgeText}>conf {confidence.toFixed(2)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    left: 0,
    top: 0,
  },
  line: {
    position: "absolute",
    height: 2,
  },
  roi: {
    position: "absolute",
    borderWidth: 1,
    borderColor: "#22d3ee",
  },
  eventMarker: {
    position: "absolute",
    width: 2,
    height: "100%",
  },
  badge: {
    position: "absolute",
    left: 6,
    top: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: "rgba(0,0,0,0.55)",
    borderRadius: 6,
  },
  badgeText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "600",
  },
});
