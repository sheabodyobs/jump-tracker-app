// src/analysis/time.ts
// Canonical timing utilities to eliminate ms/seconds drift.
// Internal representation: milliseconds (integer).
// External representation: seconds (derived from ms).

/**
 * Convert milliseconds to seconds.
 * Ensures finite result; clamps negative or non-finite inputs to 0.
 *
 * Round-trip: msToSeconds(secondsToMs(x)) ≈ x (within ±0.001 due to rounding)
 */
export function msToSeconds(ms: number): number {
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return ms / 1000;
}

/**
 * Convert seconds to milliseconds.
 * Returns integer milliseconds via rounding.
 * Clamps negative or non-finite inputs to 0.
 */
export function secondsToMs(sec: number): number {
  if (!Number.isFinite(sec) || sec < 0) return 0;
  return Math.round(sec * 1000);
}

/**
 * Convert frames to milliseconds given a frame rate.
 * Returns integer milliseconds via rounding.
 * Assumes nominal FPS; if fps <= 0 or non-finite, returns 0.
 *
 * Precision note: frame-to-ms conversion is bounded by 1/fps.
 * For 120 fps, precision is ~8.3 ms per frame.
 */
export function framesToMs(frames: number, fps: number): number {
  if (!Number.isFinite(frames) || frames < 0) return 0;
  if (!Number.isFinite(fps) || fps <= 0) return 0;
  return Math.round((frames / fps) * 1000);
}

/**
 * Build a canonical event time object from either:
 * - Explicit tMs (milliseconds, preferred), or
 * - Computed from frame index + fps
 *
 * Always returns {tMs (integer), tSeconds (derived)}.
 *
 * @param args { tMs?: number; frame?: number; fps: number }
 * @returns { tMs: number; tSeconds: number }
 */
export interface EventTimeArgs {
  tMs?: number;
  frame?: number;
  fps: number;
}

export interface EventTime {
  tMs: number; // integer milliseconds (source of truth)
  tSeconds: number; // derived: tMs / 1000
}

export function buildEventTime(args: EventTimeArgs): EventTime {
  let tMs = 0;

  // Prefer explicit tMs if provided and finite
  if (typeof args.tMs === "number" && Number.isFinite(args.tMs) && args.tMs >= 0) {
    tMs = Math.round(args.tMs);
  } else if (typeof args.frame === "number" && Number.isFinite(args.frame) && args.frame >= 0) {
    // Fall back to frame-based computation
    tMs = framesToMs(args.frame, args.fps);
  }

  return {
    tMs,
    tSeconds: msToSeconds(tMs),
  };
}

/**
 * Compute duration in milliseconds between two timestamps.
 * Returns max(0, endMs - startMs) to prevent negative durations.
 */
export function buildDurationMs(startMs: number, endMs: number): number {
  if (!Number.isFinite(startMs)) startMs = 0;
  if (!Number.isFinite(endMs)) endMs = 0;
  if (startMs < 0) startMs = 0;
  if (endMs < 0) endMs = 0;
  return Math.max(0, endMs - startMs);
}

/**
 * Compute duration in seconds between two timestamps (in ms).
 * Internally uses buildDurationMs; result is always finite and non-negative.
 */
export function buildDurationSeconds(startMs: number, endMs: number): number {
  return msToSeconds(buildDurationMs(startMs, endMs));
}

/**
 * Sanity check: verify round-trip accuracy.
 * ms → sec → ms should differ by ≤ 1 ms due to rounding.
 * For testing/validation only.
 */
export function validateRoundTrip(originalMs: number): boolean {
  const sec = msToSeconds(originalMs);
  const backToMs = secondsToMs(sec);
  const drift = Math.abs(originalMs - backToMs);
  return drift <= 1;
}
