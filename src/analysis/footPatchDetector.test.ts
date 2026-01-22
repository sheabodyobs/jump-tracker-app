import assert from 'assert';
import { detectFootPatch } from './footPatchDetector';
import type { GroundModel2D } from './jumpAnalysisContract';

type Frame = { data: Uint8ClampedArray; width: number; height: number };

function makeBlankFrame(width: number, height: number, value = 0): Frame {
  const data = new Uint8ClampedArray(width * height);
  data.fill(value);
  return { data, width, height };
}

function addBlob(frame: Frame, x0: number, y0: number, w: number, h: number, value: number): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (x >= 0 && x < frame.width && y >= 0 && y < frame.height) {
        frame.data[y * frame.width + x] = value;
      }
    }
  }
}

function buildSequence(options: {
  width: number;
  height: number;
  frames: number;
  footBlob?: { x: number; y: number; w: number; h: number; onFrames: number[] };
  bodyBlob?: { x: number; y: number; w: number; h: number; onFrames: number[] };
  noise?: boolean;
}): Frame[] {
  const seq: Frame[] = [];
  for (let t = 0; t < options.frames; t++) {
    const f = makeBlankFrame(options.width, options.height, 0);
    if (options.footBlob && options.footBlob.onFrames.includes(t)) {
      addBlob(f, options.footBlob.x, options.footBlob.y, options.footBlob.w, options.footBlob.h, 255);
    }
    if (options.bodyBlob && options.bodyBlob.onFrames.includes(t)) {
      addBlob(f, options.bodyBlob.x, options.bodyBlob.y, options.bodyBlob.w, options.bodyBlob.h, 255);
    }
    if (options.noise) {
      // add mild random noise
      for (let i = 0; i < f.data.length; i += 13) {
        f.data[i] = (t * 7 + i) % 255;
      }
    }
    seq.push(f);
  }
  return seq;
}

const ground: GroundModel2D = { type: 'y_scalar', y: 45, confidence: 0.8 };

// Test 1: Foot blob near ground with periodic impacts
(() => {
  const frames = buildSequence({
    width: 64,
    height: 48,
    frames: 40,
    footBlob: { x: 20, y: 40, w: 8, h: 5, onFrames: [5, 15, 25, 35] },
  });
  const res = detectFootPatch(frames, ground, { minFootness: 0.2 });
  assert(res, 'should detect foot patch');
  assert(res.confidence > 0.35, `expected confidence > 0.35, got ${res?.confidence}`);
})();

// Test 2: Whole-body motion high above ground should be penalized
(() => {
  const frames = buildSequence({
    width: 64,
    height: 48,
    frames: 30,
    bodyBlob: { x: 10, y: 10, w: 20, h: 10, onFrames: [3, 7, 11, 15, 19, 23, 27] },
  });
  const res = detectFootPatch(frames, ground, { minFootness: 0.3 });
  assert(!res || res.confidence < 0.3, 'should reject or be low confidence for body sway');
})();

// Test 3: Noisy band should reject
(() => {
  const frames = buildSequence({ width: 64, height: 48, frames: 25, noise: true });
  const res = detectFootPatch(frames, ground, { minFootness: 0.3 });
  assert(!res || res.confidence < 0.3, 'should reject noisy band');
})();

// Test 4: Two blobs near ground - pick stronger
(() => {
  const frames = buildSequence({
    width: 64,
    height: 48,
    frames: 40,
    footBlob: { x: 10, y: 40, w: 6, h: 4, onFrames: [4, 14, 24, 34] },
    bodyBlob: { x: 40, y: 38, w: 10, h: 6, onFrames: [5, 15, 25, 35] },
  });
  const res = detectFootPatch(frames, ground, { minFootness: 0.2 });
  assert(res, 'should detect one blob');
  assert(res.roi.x >= 35, 'should pick stronger/larger blob near x=40');
})();
