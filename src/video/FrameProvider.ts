export type MeasurementStatus = "real" | "synthetic_placeholder";

export type ExtractedFrame = {
  tMs: number;
  width: number;
  height: number;
  format: "rgba" | "luma";
  dataBase64: string; // base64 of raw bytes
};

export type ExtractedFrameBatch = {
  measurementStatus: MeasurementStatus;
  durationMs?: number;
  nominalFps?: number;
  frames: ExtractedFrame[];
  debug: { provider: "ios_avfoundation" | "web_canvas" | "synthetic"; notes: string[] };
  error?: { code: string; message: string };
};

export interface FrameProvider {
  sampleFrames(
    videoUri: string,
    timestampsMs: number[],
    options?: { maxWidth?: number; format?: "rgba" | "luma" }
  ): Promise<ExtractedFrameBatch>;
}
