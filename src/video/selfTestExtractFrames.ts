import type { ExtractedFrameBatch } from "./FrameProvider";
import { iosAvFoundationFrameProvider } from "./iosAvFoundationFrameProvider";

const DEFAULT_TEST_WINDOW_MS = 2000;
const TEST_FRAME_COUNT = 10;

function buildEvenTimestamps(durationMs: number) {
  const span = Math.max(1, durationMs);
  const step = span / (TEST_FRAME_COUNT - 1);
  return Array.from({ length: TEST_FRAME_COUNT }, (_, i) => Math.round(i * step));
}

export async function selfTestExtractFrames(videoUri: string): Promise<ExtractedFrameBatch> {
  const initialTimestamps = buildEvenTimestamps(DEFAULT_TEST_WINDOW_MS);
  const firstBatch = await iosAvFoundationFrameProvider.sampleFrames(videoUri, initialTimestamps, {
    maxWidth: 256,
    format: "rgba",
  });

  const durationMs = firstBatch.durationMs;
  if (!durationMs || durationMs <= DEFAULT_TEST_WINDOW_MS) {
    return firstBatch;
  }

  const timestamps = buildEvenTimestamps(durationMs);
  return iosAvFoundationFrameProvider.sampleFrames(videoUri, timestamps, {
    maxWidth: 256,
    format: "rgba",
  });
}
