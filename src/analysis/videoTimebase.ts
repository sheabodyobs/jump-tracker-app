export type VideoTimebase =
  | {
      kind: "pts";                // per-frame timestamps available
      frameTimesSec: number[];    // t[i] in seconds
      fpsApprox: number;          // derived average fps
      vfr: boolean;
    }
  | {
      kind: "cfr_approx";         // constant frame rate approximation
      fps: number;
      durationSec?: number;
      frameCount?: number;
    };

export type VideoTimebaseResult = {
  ok: true;
  timebase: VideoTimebase;
} | {
  ok: false;
  reason: string;
};
