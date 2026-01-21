import { NativeModules, Platform } from "react-native";

import type { ExtractedFrameBatch, FrameProvider } from "./FrameProvider";

type NativeFrameProvider = {
  sampleFrames(
    videoUri: string,
    timestampsMs: number[],
    options?: { maxWidth?: number; format?: "rgba" | "luma" }
  ): Promise<ExtractedFrameBatch>;
  getVideoMetadata(videoUri: string): Promise<{
    measurementStatus: "real" | "synthetic_placeholder";
    durationMs?: number;
    nominalFps?: number;
    debug?: { provider: "ios_avfoundation"; notes: string[] };
    error?: { code: string; message: string };
  }>;
};

const NativeRealFrameProvider: NativeFrameProvider | null =
  NativeModules?.RealFrameProvider ?? null;

export const iosAvFoundationFrameProvider: FrameProvider = {
  async sampleFrames(videoUri, timestampsMs, options) {
    if (Platform.OS !== "ios") {
      return {
        measurementStatus: "synthetic_placeholder",
        frames: [],
        debug: {
          provider: "synthetic",
          notes: ["iOS-only frame extraction is unavailable on this platform."],
        },
        error: {
          code: "PLATFORM_UNSUPPORTED",
          message: "Frame extraction is only supported on iOS.",
        },
      };
    }

    if (!NativeRealFrameProvider) {
      return {
        measurementStatus: "synthetic_placeholder",
        frames: [],
        debug: {
          provider: "synthetic",
          notes: ["Native module not available; returning synthetic placeholder batch."],
        },
        error: {
          code: "NATIVE_MODULE_UNAVAILABLE",
          message: "RealFrameProvider native module not available.",
        },
      };
    }

    try {
      const batch = await NativeRealFrameProvider.sampleFrames(videoUri, timestampsMs, options);
      return batch;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown native extraction error.";
      return {
        measurementStatus: "synthetic_placeholder",
        frames: [],
        debug: {
          provider: "synthetic",
          notes: ["Native extraction failed; returning synthetic placeholder batch."],
        },
        error: {
          code: "NATIVE_MODULE_FAILURE",
          message,
        },
      };
    }
  },
};

export async function getIosVideoMetadata(videoUri: string): Promise<{
  measurementStatus: "real" | "synthetic_placeholder";
  durationMs?: number;
  nominalFps?: number;
  debug?: { provider: "ios_avfoundation"; notes: string[] };
  error?: { code: string; message: string };
}> {
  if (Platform.OS !== "ios") {
    return {
      measurementStatus: "synthetic_placeholder",
      debug: {
        provider: "ios_avfoundation",
        notes: ["iOS-only metadata is unavailable on this platform."],
      },
      error: {
        code: "PLATFORM_UNSUPPORTED",
        message: "Metadata is only supported on iOS.",
      },
    };
  }

  if (!NativeRealFrameProvider?.getVideoMetadata) {
    return {
      measurementStatus: "synthetic_placeholder",
      debug: {
        provider: "ios_avfoundation",
        notes: ["Native metadata module not available."],
      },
      error: {
        code: "NATIVE_MODULE_UNAVAILABLE",
        message: "RealFrameProvider native module not available.",
      },
    };
  }

  try {
    return await NativeRealFrameProvider.getVideoMetadata(videoUri);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown metadata error.";
    return {
      measurementStatus: "synthetic_placeholder",
      debug: {
        provider: "ios_avfoundation",
        notes: ["Native metadata fetch failed."],
      },
      error: {
        code: "NATIVE_MODULE_FAILURE",
        message,
      },
    };
  }
}
