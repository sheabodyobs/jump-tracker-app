// src/analysis/pogoSideViewAnalyzer.ts
import { type JumpAnalysis, EMPTY_ANALYSIS, type AnalysisFrame, type GroundModel2D } from "./jumpAnalysisContract";

const TARGET_FPS = 30;
const MAX_FRAMES = 36;

type PixelFrame = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  tMs: number;
};

type ContactSignal = {
  inContact: boolean;
  confidence: number;
  heel: number;
  toe: number;
  footX: number | null;
  footY: number | null;
};

type GroundSignal = {
  groundY: number | null;
  confidence: number;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function extractFramesWeb(uri: string): Promise<PixelFrame[]> {
  if (typeof document === "undefined") return Promise.resolve([]);

  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.src = uri;
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.preload = "auto";

    const cleanup = () => {
      video.pause();
      video.remove();
    };

    video.addEventListener(
      "loadedmetadata",
      async () => {
        const durationSec = Number.isFinite(video.duration) ? video.duration : 0;
        const totalFrames = Math.min(
          MAX_FRAMES,
          Math.max(1, Math.floor(durationSec * TARGET_FPS))
        );
        const intervalSec = durationSec > 0 ? durationSec / totalFrames : 1 / TARGET_FPS;

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          cleanup();
          resolve([]);
          return;
        }

        const targetWidth = Math.max(1, Math.floor(video.videoWidth || 320));
        const targetHeight = Math.max(1, Math.floor(video.videoHeight || 180));
        canvas.width = targetWidth;
        canvas.height = targetHeight;

        const frames: PixelFrame[] = [];

        for (let i = 0; i < totalFrames; i += 1) {
          const timeSec = i * intervalSec;
          await new Promise<void>((frameResolve) => {
            const onSeeked = () => {
              video.removeEventListener("seeked", onSeeked);
              frameResolve();
            };
            video.addEventListener("seeked", onSeeked);
            video.currentTime = timeSec;
          });

          ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
          const image = ctx.getImageData(0, 0, targetWidth, targetHeight);
          frames.push({
            width: targetWidth,
            height: targetHeight,
            data: image.data,
            tMs: Math.round(timeSec * 1000),
          });
        }

        cleanup();
        resolve(frames);
      },
      { once: true }
    );

    video.addEventListener(
      "error",
      () => {
        cleanup();
        resolve([]);
      },
      { once: true }
    );
  });
}

function seededRandom(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function generateSyntheticFrames(uri: string): PixelFrame[] {
  const seed = hashString(uri || "pogo");
  const rand = seededRandom(seed);
  const width = 160;
  const height = 90;
  const groundY = Math.floor(height * 0.78);
  const frames: PixelFrame[] = [];

  const contactPattern = [
    ...Array(8).fill(true),
    ...Array(10).fill(false),
    ...Array(10).fill(true),
  ];

  const totalFrames = Math.min(MAX_FRAMES, contactPattern.length);

  for (let i = 0; i < totalFrames; i += 1) {
    const data = new Uint8ClampedArray(width * height * 4);
    const inContact = contactPattern[i];
    const footX = Math.floor(width * (0.45 + rand() * 0.1));
    const footRadius = 6;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const idx = (y * width + x) * 4;
        const base = y > groundY ? 40 : 180;
        let value = base;
        if (inContact && Math.abs(x - footX) < footRadius && y >= groundY - 4 && y <= groundY + 2) {
          value = 30;
        }
        data[idx] = value;
        data[idx + 1] = value;
        data[idx + 2] = value;
        data[idx + 3] = 255;
      }
    }

    frames.push({
      width,
      height,
      data,
      tMs: Math.round((i / TARGET_FPS) * 1000),
    });
  }

  return frames;
}

function analyzeGround(frame: PixelFrame): GroundSignal {
  const { width, height, data } = frame;
  const rowAverages: number[] = new Array(height).fill(0);

  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      sum += luminance;
    }
    rowAverages[y] = sum / width;
  }

  const searchStart = Math.floor(height * 0.5);
  let bestRow = height - 1;
  let bestGradient = 0;

  for (let y = searchStart + 1; y < height; y += 1) {
    const gradient = Math.abs(rowAverages[y] - rowAverages[y - 1]);
    if (gradient > bestGradient) {
      bestGradient = gradient;
      bestRow = y;
    }
  }

  const confidence = clamp01(bestGradient / 80);

  return {
    groundY: Number.isFinite(bestRow) ? bestRow : null,
    confidence,
  };
}

function analyzeContact(frame: PixelFrame, ground: GroundSignal): ContactSignal {
  const { width, height, data } = frame;
  if (ground.groundY === null) {
    return { inContact: false, confidence: 0, heel: 0, toe: 0, footX: null, footY: null };
  }

  const bandHeight = Math.max(2, Math.floor(height * 0.08));
  const startY = Math.max(0, ground.groundY - bandHeight);
  const endY = Math.min(height - 1, ground.groundY);
  let darkCount = 0;
  let totalCount = 0;
  let sumX = 0;
  let sumY = 0;

  for (let y = startY; y <= endY; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      totalCount += 1;
      if (luminance < 80) {
        darkCount += 1;
        sumX += x;
        sumY += y;
      }
    }
  }

  const ratio = totalCount ? darkCount / totalCount : 0;
  const confidence = clamp01((ratio - 0.04) / 0.2);
  const footX = darkCount ? sumX / darkCount : null;
  const footY = darkCount ? sumY / darkCount : null;

  return {
    inContact: ratio > 0.08,
    confidence,
    heel: confidence,
    toe: confidence,
    footX,
    footY,
  };
}

function makeFrame(
  frame: PixelFrame,
  ground: GroundSignal,
  contact: ContactSignal
): AnalysisFrame {
  const emptyPoint = { x: null, y: null, confidence: 0 };
  const emptyLeg = {
    hip: emptyPoint,
    knee: emptyPoint,
    ankle: emptyPoint,
    heel: emptyPoint,
    toe: emptyPoint,
  };

  const footOffset = frame.width * 0.02;
  const footX = contact.footX;
  const footY = contact.footY;

  const heel =
    footX !== null && footY !== null
      ? { x: footX - footOffset, y: footY, confidence: contact.confidence }
      : emptyPoint;
  const toe =
    footX !== null && footY !== null
      ? { x: footX + footOffset, y: footY, confidence: contact.confidence }
      : emptyPoint;
  const ankle =
    footX !== null && footY !== null
      ? { x: footX, y: Math.max(0, footY - frame.height * 0.06), confidence: contact.confidence }
      : emptyPoint;

  const joints = {
    left: {
      ...emptyLeg,
      heel,
      toe,
      ankle,
    },
    right: {
      ...emptyLeg,
      heel,
      toe,
      ankle,
    },
  };

  const groundModel: GroundModel2D =
    ground.groundY === null
      ? { type: "unknown", confidence: 0 }
      : { type: "y_scalar", y: ground.groundY, confidence: ground.confidence };

  return {
    frameIndex: Math.round(frame.tMs / (1000 / TARGET_FPS)),
    tMs: frame.tMs,
    joints2d: joints,
    ground: groundModel,
    contact: {
      left: {
        heel: contact.heel,
        toe: contact.toe,
        inContact: contact.inContact,
      },
      right: {
        heel: contact.heel,
        toe: contact.toe,
        inContact: contact.inContact,
      },
    },
    confidence: contact.confidence,
  };
}

function deriveEvents(frames: AnalysisFrame[]) {
  const contacts = frames.map((frame) => frame.contact.left.inContact || frame.contact.right.inContact);
  let takeoffIndex = -1;
  let landingIndex = -1;

  for (let i = 1; i < contacts.length; i += 1) {
    if (contacts[i - 1] && !contacts[i] && takeoffIndex === -1) {
      takeoffIndex = i;
      continue;
    }
    if (takeoffIndex !== -1 && !contacts[i - 1] && contacts[i]) {
      landingIndex = i;
      break;
    }
  }

  const takeoffFrame = takeoffIndex >= 0 ? frames[takeoffIndex] : null;
  const landingFrame = landingIndex >= 0 ? frames[landingIndex] : null;

  return { takeoffIndex, landingIndex, takeoffFrame, landingFrame };
}

function deriveMetrics(frames: AnalysisFrame[], takeoffIndex: number, landingIndex: number) {
  if (takeoffIndex <= 0 || landingIndex <= takeoffIndex) {
    return { gctSeconds: null, gctMs: null, flightSeconds: null };
  }

  let contactStart = takeoffIndex - 1;
  while (contactStart > 0 && frames[contactStart - 1].contact.left.inContact) {
    contactStart -= 1;
  }

  const takeoffTime = frames[takeoffIndex].tMs ?? 0;
  const contactStartTime = frames[contactStart].tMs ?? 0;
  const landingTime = frames[landingIndex].tMs ?? 0;

  const gctSeconds = Math.max(0, (takeoffTime - contactStartTime) / 1000);
  const flightSeconds = Math.max(0, (landingTime - takeoffTime) / 1000);

  return {
    gctSeconds,
    gctMs: Math.round(gctSeconds * 1000),
    flightSeconds,
  };
}

export async function analyzePogoSideView(uri: string): Promise<JumpAnalysis> {
  const frames = await extractFramesWeb(uri);
  const pixelFrames = frames.length ? frames : generateSyntheticFrames(uri);

  const analyzedFrames: AnalysisFrame[] = [];
  const groundConfidences: number[] = [];
  const groundYs: number[] = [];
  const contactSignals: ContactSignal[] = [];

  pixelFrames.forEach((frame) => {
    const ground = analyzeGround(frame);
    const contact = analyzeContact(frame, ground);
    analyzedFrames.push(makeFrame(frame, ground, contact));
    contactSignals.push(contact);

    if (ground.groundY !== null && ground.confidence > 0) {
      groundYs.push(ground.groundY);
      groundConfidences.push(ground.confidence);
    }
  });

  const groundSummary: GroundModel2D = groundYs.length
    ? {
        type: "y_scalar",
        y: Math.round(median(groundYs)),
        confidence: clamp01(mean(groundConfidences)),
      }
    : { type: "unknown", confidence: 0 };

  const { takeoffIndex, landingIndex, takeoffFrame, landingFrame } = deriveEvents(analyzedFrames);
  const metrics = deriveMetrics(analyzedFrames, takeoffIndex, landingIndex);

  const trackedRatio =
    contactSignals.filter((signal) => signal.footX !== null && signal.confidence > 0.2).length /
    Math.max(1, contactSignals.length);

  const viewOk = groundSummary.type !== "unknown" && groundSummary.confidence > 0.2;
  const jointsTracked = trackedRatio >= 0.6;
  const contactDetected = takeoffIndex >= 0 && landingIndex > takeoffIndex;

  const overallConfidence = clamp01(
    0.2 +
      (viewOk ? 0.3 : 0) +
      (jointsTracked ? 0.25 : 0) +
      (contactDetected ? 0.25 : 0) +
      (groundSummary.confidence > 0.4 ? 0.1 : 0)
  );

  const notes = [
    `Analyzer: ${frames.length ? "web-canvas" : "synthetic"}.`,
    `Frames: ${analyzedFrames.length}.`,
    `FPS (target): ${TARGET_FPS}.`,
    `Ground confidence: ${groundSummary.confidence.toFixed(2)}.`,
    `Contact frames: ${contactSignals.filter((signal) => signal.inContact).length}.`,
    contactDetected
      ? `Takeoff frame: ${takeoffIndex}, landing frame: ${landingIndex}.`
      : "No contact transitions detected.",
    metrics.gctSeconds !== null ? `GCT: ${metrics.gctSeconds.toFixed(3)}s.` : "GCT unavailable.",
    metrics.flightSeconds !== null ? `Flight: ${metrics.flightSeconds.toFixed(3)}s.` : "Flight unavailable.",
  ];

  const takeoffTime = takeoffFrame?.tMs;
  const landingTime = landingFrame?.tMs;

  return {
    ...EMPTY_ANALYSIS,
    status: "complete",
    metrics: {
      ...EMPTY_ANALYSIS.metrics,
      gctSeconds: metrics.gctSeconds,
      gctMs: metrics.gctMs,
      flightSeconds: metrics.flightSeconds,
      footAngleDeg: { takeoff: null, landing: null, confidence: 0 },
    },
    events: {
      takeoff: {
        t: typeof takeoffTime === "number" ? takeoffTime / 1000 : null,
        frame: takeoffFrame ? takeoffFrame.frameIndex : null,
        confidence: clamp01(takeoffFrame?.confidence ?? 0),
      },
      landing: {
        t: typeof landingTime === "number" ? landingTime / 1000 : null,
        frame: landingFrame ? landingFrame.frameIndex : null,
        confidence: clamp01(landingFrame?.confidence ?? 0),
      },
    },
    frames: analyzedFrames,
    groundSummary,
    quality: {
      overallConfidence,
      notes,
      reliability: {
        viewOk,
        groundDetected: groundSummary.type !== "unknown",
        jointsTracked,
        contactDetected,
      },
    },
    aiSummary: {
      text: contactDetected ? "Contact and flight detected." : "Contact detection uncertain.",
      tags: ["pogo-side-view", frames.length ? "web-canvas" : "synthetic"],
    },
  };
}

export function runPogoAnalyzerSelfTest(): JumpAnalysis {
  const synthetic = generateSyntheticFrames("self-test");
  const analyzedFrames = synthetic.map((frame) => {
    const ground = analyzeGround(frame);
    const contact = analyzeContact(frame, ground);
    return makeFrame(frame, ground, contact);
  });

  const groundYs = analyzedFrames
    .filter((frame) => frame.ground.type === "y_scalar" && typeof frame.ground.y === "number")
    .map((frame) => frame.ground.y as number);
  const groundSummary: GroundModel2D = groundYs.length
    ? { type: "y_scalar", y: Math.round(median(groundYs)), confidence: 0.5 }
    : { type: "unknown", confidence: 0 };

  const { takeoffIndex, landingIndex } = deriveEvents(analyzedFrames);
  const metrics = deriveMetrics(analyzedFrames, takeoffIndex, landingIndex);

  console.info("Pogo analyzer self-test", {
    fps: TARGET_FPS,
    frames: analyzedFrames.length,
    contactFrames: analyzedFrames.filter((frame) => frame.contact.left.inContact).length,
    takeoffIndex,
    landingIndex,
    gctSeconds: metrics.gctSeconds,
    flightSeconds: metrics.flightSeconds,
  });

  return {
    ...EMPTY_ANALYSIS,
    status: "complete",
    metrics: {
      ...EMPTY_ANALYSIS.metrics,
      gctSeconds: metrics.gctSeconds,
      gctMs: metrics.gctMs,
      flightSeconds: metrics.flightSeconds,
      footAngleDeg: { takeoff: null, landing: null, confidence: 0 },
    },
    events: {
      takeoff: { t: null, frame: takeoffIndex >= 0 ? takeoffIndex : null, confidence: 0.4 },
      landing: { t: null, frame: landingIndex >= 0 ? landingIndex : null, confidence: 0.4 },
    },
    frames: analyzedFrames,
    groundSummary,
    quality: {
      overallConfidence: 0.4,
      notes: ["Self-test synthetic analyzer run."],
      reliability: {
        viewOk: true,
        groundDetected: true,
        jointsTracked: true,
        contactDetected: takeoffIndex >= 0 && landingIndex > takeoffIndex,
      },
    },
    aiSummary: { text: "Synthetic self-test run.", tags: ["self-test"] },
  };
}
