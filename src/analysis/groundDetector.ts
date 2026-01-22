/**
 * groundDetector.ts
 *
 * Deterministic, camera-invariant ground detection for Jump Tracker.
 * Operates on small grayscale frames (e.g., 96x64, 160x120).
 *
 * Two-stage approach:
 *   Stage A: Per-frame candidate line generation via Sobel edge detection + Hough transform.
 *   Stage B: Temporal clustering and selection across N frames; score by persistence,
 *            edge support, stability, and plausibility.
 *
 * No ML, no heavy dependencies, fully deterministic.
 */

// ============================================================================
// Types
// ============================================================================

/** 2D point in pixels */
export interface Point2D {
  x: number;
  y: number;
}

/** Represents a detected line in polar coordinates (Hough space) */
export interface HoughLine {
  theta: number; // radians, [0, Math.PI)
  rho: number; // pixels, can be negative
  score: number; // edge magnitude sum along line
  endpoints: [Point2D, Point2D]; // visual line segment endpoints for debugging
}

/** Ground line candidate at a specific frame timestamp */
export interface FrameCandidate {
  tMs: number;
  frameIdx: number;
  lines: HoughLine[]; // top K candidates from this frame
}

/** Temporal cluster of similar lines across frames */
export interface LineCluster {
  thetaMean: number;
  rhoMean: number;
  thetaVariance: number;
  rhoVariance: number;
  persistence: number; // #frames with a member / total frames
  edgeSupport: number; // sum of all line scores in cluster
  count: number; // number of frames contributing
}

/** Final ground model from deterministic detection */
export interface GroundDetectorOutput {
  detected: boolean;
  confidence: number; // [0, 1], explicit formula in code
  theta: number | null; // radians
  rho: number | null; // pixels
  line: { x1: number; y1: number; x2: number; y2: number } | null; // visual line for rendering
  method: string; // "hough_temporal", or "none"
  diagnostics?: {
    stageSummary: string;
    topCandidatesPerFrame: number;
    clusterCount: number;
    selectedClusterPersistence: number;
    motionCellPresence?: number; // not used in v1, for future
  };
}

// ============================================================================
// Stage A: Per-Frame Candidate Generation
// ============================================================================

/**
 * Compute Sobel gradient magnitude and direction for a grayscale frame.
 *
 * DETERMINISM: Uses fixed Sobel kernels, no randomization.
 * Gradient magnitude stored as unsigned; direction is atan2(gy, gx).
 */
function sobelGradient(
  data: Uint8ClampedArray,
  width: number,
  height: number
): { magnitude: Float32Array; direction: Float32Array } {
  const magnitude = new Float32Array(width * height);
  const direction = new Float32Array(width * height);

  // Sobel kernels
  const sobelX = [[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]];
  const sobelY = [[-1, -2, -1], [0, 0, 0], [1, 2, 1]];

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      let gx = 0;
      let gy = 0;

      // Apply Sobel kernels
      for (let ky = -1; ky <= 1; ky += 1) {
        for (let kx = -1; kx <= 1; kx += 1) {
          const idx = ((y + ky) * width + (x + kx)) * 1; // grayscale: 1 byte per pixel
          const val = data[(y + ky) * width + (x + kx)];
          gx += val * sobelX[ky + 1][kx + 1];
          gy += val * sobelY[ky + 1][kx + 1];
        }
      }

      const idx = y * width + x;
      magnitude[idx] = Math.sqrt(gx * gx + gy * gy);
      direction[idx] = Math.atan2(gy, gx);
    }
  }

  return { magnitude, direction };
}

/**
 * Deterministically threshold edge map based on frame statistics.
 *
 * DETERMINISM: Uses mean + k*stdDev formula; no randomization.
 * Formula: threshold = mean(magnitude) + 1.5 * stdDev(magnitude)
 */
function computeEdgeThreshold(magnitude: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < magnitude.length; i += 1) {
    sum += magnitude[i];
  }
  const mean = sum / magnitude.length;

  let sumSq = 0;
  for (let i = 0; i < magnitude.length; i += 1) {
    const diff = magnitude[i] - mean;
    sumSq += diff * diff;
  }
  const variance = sumSq / magnitude.length;
  const stdDev = Math.sqrt(variance);

  return mean + 1.5 * stdDev;
}

/**
 * Hough transform to accumulate votes for lines.
 *
 * DETERMINISM: Fixed rho/theta resolution, deterministic accumulation.
 * Returns top K candidates (K=10) by score.
 */
function houghTransform(
  magnitude: Float32Array,
  direction: Float32Array,
  width: number,
  height: number,
  threshold: number,
  topK: number = 10
): HoughLine[] {
  const maxRho = Math.sqrt(width * width + height * height);
  const rhoSteps = Math.ceil(maxRho * 2); // quantize rho
  const thetaSteps = 180; // 1 degree per step

  const accumulator: Map<string, { count: number; score: number }> = new Map();
  const edgePixels: Array<{ x: number; y: number; mag: number }> = [];

  // Collect edge pixels
  const edgeThresh = threshold;
  for (let i = 0; i < magnitude.length; i += 1) {
    if (magnitude[i] >= edgeThresh) {
      const y = Math.floor(i / width);
      const x = i % width;
      edgePixels.push({ x, y, mag: magnitude[i] });
    }
  }

  // Vote for each edge pixel in Hough space
  for (const pixel of edgePixels) {
    for (let t = 0; t < thetaSteps; t += 1) {
      const theta = (t * Math.PI) / thetaSteps;
      const rho = pixel.x * Math.cos(theta) + pixel.y * Math.sin(theta);
      const rhoIdx = Math.round((rho + maxRho) / 2);
      const key = `${t},${rhoIdx}`;

      const existing = accumulator.get(key) ?? { count: 1, score: pixel.mag };
      accumulator.set(key, {
        count: existing.count + 1,
        score: existing.score + pixel.mag,
      });
    }
  }

  // Extract top K by score
  const candidates = Array.from(accumulator.entries())
    .map(([key, val]) => {
      const [t, rhoIdx] = key.split(",").map(Number);
      const theta = (t * Math.PI) / thetaSteps;
      const rho = rhoIdx * 2 - maxRho;
      return { theta, rho, score: val.score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  // Compute visual endpoints for each Hough line
  const lines: HoughLine[] = candidates.map((cand) => {
    const theta = cand.theta;
    const rho = cand.rho;

    // Line equation: rho = x*cos(theta) + y*sin(theta)
    // Find intersections with frame boundaries
    const endpoints = computeLineEndpoints(theta, rho, width, height);

    return {
      theta,
      rho,
      score: cand.score,
      endpoints: endpoints ?? [
        { x: 0, y: 0 },
        { x: width - 1, y: height - 1 },
      ],
    };
  });

  return lines;
}

/**
 * Compute the visual endpoints of a Hough line intersecting the frame boundary.
 */
function computeLineEndpoints(
  theta: number,
  rho: number,
  width: number,
  height: number
): [Point2D, Point2D] | null {
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  const intersections: Point2D[] = [];

  // Top edge (y=0)
  if (Math.abs(cos) > 1e-6) {
    const x = (rho - 0 * sin) / cos;
    if (x >= 0 && x <= width) {
      intersections.push({ x, y: 0 });
    }
  }

  // Bottom edge (y=height-1)
  if (Math.abs(cos) > 1e-6) {
    const x = (rho - (height - 1) * sin) / cos;
    if (x >= 0 && x <= width) {
      intersections.push({ x, y: height - 1 });
    }
  }

  // Left edge (x=0)
  if (Math.abs(sin) > 1e-6) {
    const y = (rho - 0 * cos) / sin;
    if (y >= 0 && y <= height) {
      intersections.push({ x: 0, y });
    }
  }

  // Right edge (x=width-1)
  if (Math.abs(sin) > 1e-6) {
    const y = (rho - (width - 1) * cos) / sin;
    if (y >= 0 && y <= height) {
      intersections.push({ x: width - 1, y });
    }
  }

  // Return two endpoints; if fewer than 2, report failure
  if (intersections.length >= 2) {
    return [
      intersections[0],
      intersections[intersections.length - 1],
    ] as [Point2D, Point2D];
  }

  return null;
}

/**
 * Stage A: Generate line candidates for a single frame.
 */
function generateCandidatesForFrame(
  frameData: Uint8ClampedArray,
  width: number,
  height: number,
  tMs: number,
  frameIdx: number
): FrameCandidate {
  const { magnitude } = sobelGradient(frameData, width, height);
  const threshold = computeEdgeThreshold(magnitude);
  const lines = houghTransform(magnitude, new Float32Array(), width, height, threshold, 10);

  return { tMs, frameIdx, lines };
}

// ============================================================================
// Stage B: Temporal Clustering and Selection
// ============================================================================

/**
 * Cluster line candidates from multiple frames by proximity in (theta, rho) space.
 *
 * DETERMINISM: Fixed cluster distance thresholds; stable sorting.
 * Thresholds: thetaDist = 15°, rhoDist = 20 px
 */
function clusterCandidates(
  candidates: FrameCandidate[],
  thetaDistRad: number = (15 * Math.PI) / 180,
  rhoDistPx: number = 20
): LineCluster[] {
  const clusters: LineCluster[] = [];

  for (const frameCandidate of candidates) {
    for (const line of frameCandidate.lines) {
      let bestCluster: LineCluster | null = null;
      let bestDist = Infinity;

      // Find best existing cluster
      for (const cluster of clusters) {
        const thetaDist = angleDifference(line.theta, cluster.thetaMean);
        const rhoDist = Math.abs(line.rho - cluster.rhoMean);

        if (thetaDist <= thetaDistRad && rhoDist <= rhoDistPx) {
          const combinedDist = thetaDist + rhoDist / 100; // weighted metric
          if (combinedDist < bestDist) {
            bestDist = combinedDist;
            bestCluster = cluster;
          }
        }
      }

      if (bestCluster) {
        // Update cluster with new line
        const oldCount = bestCluster.count;
        const newCount = oldCount + 1;

        bestCluster.thetaMean = (bestCluster.thetaMean * oldCount + line.theta) / newCount;
        bestCluster.rhoMean = (bestCluster.rhoMean * oldCount + line.rho) / newCount;
        bestCluster.edgeSupport += line.score;
        bestCluster.count = newCount;
      } else {
        // Create new cluster
        clusters.push({
          thetaMean: line.theta,
          rhoMean: line.rho,
          thetaVariance: 0,
          rhoVariance: 0,
          persistence: 1,
          edgeSupport: line.score,
          count: 1,
        });
      }
    }
  }

  // Compute persistence and variance
  const numFrames = candidates.length;
  for (const cluster of clusters) {
    cluster.persistence = cluster.count / numFrames;
    // Variance will be refined if needed; for now, estimate conservatively.
    cluster.thetaVariance = 0.1; // ~5.7 degrees variance (conservative)
    cluster.rhoVariance = 10; // ~10 px variance
  }

  return clusters;
}

/**
 * Compute the minimal difference between two angles (in radians).
 * Result is in [0, π/2].
 */
function angleDifference(a: number, b: number): number {
  let diff = Math.abs(a - b);
  while (diff > Math.PI) {
    diff = Math.abs(diff - Math.PI);
  }
  if (diff > Math.PI / 2) {
    diff = Math.PI - diff;
  }
  return diff;
}

/**
 * Score a cluster for likelihood of being the ground line.
 *
 * DETERMINISM: Explicit formula; all weights fixed.
 *
 * Scoring factors:
 *   - Persistence (frames with candidate): weight 0.4
 *   - Edge support (sum of scores): weight 0.3, normalized by max
 *   - Stability (inverse variance): weight 0.2
 *   - Plausibility (avoid ~vertical): weight 0.1
 *
 * Formula: score = 0.4*persistence + 0.3*normalized_support + 0.2*stability + 0.1*plausibility
 */
function scoreCluster(cluster: LineCluster, maxEdgeSupport: number): number {
  // Persistence score [0, 1]
  const persistenceScore = cluster.persistence;

  // Edge support score [0, 1], normalized
  const supportScore =
    maxEdgeSupport > 0 ? Math.min(1, cluster.edgeSupport / maxEdgeSupport) : 0;

  // Stability score [0, 1]; lower variance = higher score
  const stabilityScore = Math.exp(-(cluster.thetaVariance ** 2 + cluster.rhoVariance ** 2) / 200);

  // Plausibility score [0, 1]; penalize near-vertical lines (θ ≈ π/2)
  const verticalDist = Math.abs(cluster.thetaMean - Math.PI / 2);
  const plausibilityScore = Math.max(0, 1 - Math.exp(-(verticalDist ** 2) / 0.05)); // soft penalty

  const weightedScore =
    0.4 * persistenceScore +
    0.3 * supportScore +
    0.2 * stabilityScore +
    0.1 * plausibilityScore;

  return weightedScore;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Detect ground across a sequence of frames.
 *
 * @param frames - Array of {data: Uint8ClampedArray, width, height, tMs} for grayscale frames
 * @returns GroundDetectorOutput with detected ground line and confidence
 *
 * DETERMINISM: All internal operations use fixed thresholds, fixed clustering logic.
 * Output is stable across runs on the same input.
 */
export function detectGround(frames: Array<{
  data: Uint8ClampedArray;
  width: number;
  height: number;
  tMs: number;
}>): GroundDetectorOutput {
  const diagnostics = {
    stageSummary: "",
    topCandidatesPerFrame: 10,
    clusterCount: 0,
    selectedClusterPersistence: 0,
  };

  // Validate input
  if (!frames || frames.length === 0) {
    return {
      detected: false,
      confidence: 0,
      theta: null,
      rho: null,
      line: null,
      method: "none",
      diagnostics,
    };
  }

  try {
    // Stage A: Generate candidates per frame
    const candidates = frames.map((frame, idx) =>
      generateCandidatesForFrame(frame.data, frame.width, frame.height, frame.tMs, idx)
    );

    const totalEdgePixels = candidates.reduce((sum, c) => sum + c.lines.length, 0);
    if (totalEdgePixels === 0) {
      diagnostics.stageSummary = "Stage A: No edges detected (likely blank or uniform frame)";
      return {
        detected: false,
        confidence: 0,
        theta: null,
        rho: null,
        line: null,
        method: "none",
        diagnostics,
      };
    }

    // Stage B: Cluster and score
    const clusters = clusterCandidates(candidates);
    diagnostics.clusterCount = clusters.length;

    if (clusters.length === 0) {
      diagnostics.stageSummary = "Stage B: No clusters formed (inconsistent edge patterns)";
      return {
        detected: false,
        confidence: 0,
        theta: null,
        rho: null,
        line: null,
        method: "none",
        diagnostics,
      };
    }

    // Find best cluster
    const maxEdgeSupport = Math.max(...clusters.map((c) => c.edgeSupport));
    const scores = clusters.map((c) => scoreCluster(c, maxEdgeSupport));
    const bestIdx = scores.indexOf(Math.max(...scores));
    const bestCluster = clusters[bestIdx];
    const bestScore = scores[bestIdx];

    diagnostics.selectedClusterPersistence = bestCluster.persistence;
    diagnostics.stageSummary = `Stage B: Selected cluster ${bestIdx} with score ${bestScore.toFixed(3)}`;

    // Construct output
    const theta = bestCluster.thetaMean;
    const rho = bestCluster.rhoMean;

    // Confidence formula (explicit, documented):
    // confidence = (0.5 * clipped_score) + (0.3 * persistence) + (0.2 * support_normalized)
    // Result clipped to [0, 1]
    const confidenceScore =
      0.5 * bestScore + 0.3 * bestCluster.persistence + 0.2 * Math.min(1, bestCluster.edgeSupport / maxEdgeSupport);
    const confidence = Math.max(0, Math.min(1, confidenceScore));

    // Compute visual line endpoints for rendering
    const firstFrame = frames[0];
    const endpoints = computeLineEndpoints(theta, rho, firstFrame.width, firstFrame.height);
    if (!endpoints) {
      return {
        detected: false,
        confidence: 0,
        theta: null,
        rho: null,
        line: null,
        method: "none",
        diagnostics: {
          ...diagnostics,
          stageSummary: "Stage B: Endpoint computation failed",
        },
      };
    }

    return {
      detected: confidence >= 0.3, // Detection threshold
      confidence,
      theta,
      rho,
      line: {
        x1: endpoints[0].x,
        y1: endpoints[0].y,
        x2: endpoints[1].x,
        y2: endpoints[1].y,
      },
      method: "hough_temporal",
      diagnostics,
    };
  } catch (error) {
    return {
      detected: false,
      confidence: 0,
      theta: null,
      rho: null,
      line: null,
      method: "none",
      diagnostics: {
        ...diagnostics,
        stageSummary: `Error during detection: ${error instanceof Error ? error.message : "unknown"}`,
      },
    };
  }
}

/**
 * Compute signed distance from a point to the ground line (in Hough space).
 * Positive = point is on the normal-pointing side; negative = opposite side.
 *
 * Useful for ROI inference: "above ground" = negative distance side.
 */
export function pointToLineDistance(point: Point2D, theta: number, rho: number): number {
  return point.x * Math.cos(theta) + point.y * Math.sin(theta) - rho;
}

/**
 * Infer foot ROI based on ground line and motion energy.
 *
 * ALGORITHM:
 *   1. Define search band above ground (between ground line and top of frame).
 *   2. Compute temporal motion variance in this band.
 *   3. Select rectangle of fixed aspect ratio (foot-like) centered on highest motion region.
 *   4. Return ROI with confidence based on motion signal strength.
 *
 * @param frames - Sequence of frames
 * @param ground - Detected ground model (from detectGround)
 * @returns {roi: {x, y, w, h}, confidence}
 */
export function inferRoiFromGround(
  frames: Array<{ data: Uint8ClampedArray; width: number; height: number }>,
  ground: GroundDetectorOutput
): { roi: { x: number; y: number; w: number; h: number } | null; confidence: number } {
  if (!ground.detected || !ground.theta || !ground.rho) {
    return { roi: null, confidence: 0 };
  }

  if (frames.length < 2) {
    return { roi: null, confidence: 0 };
  }

  try {
    const width = frames[0].width;
    const height = frames[0].height;

    // Find max y on ground line within frame
    const groundYAtLeft = (ground.rho - 0 * Math.cos(ground.theta)) / Math.sin(ground.theta);
    const groundYAtRight = (ground.rho - width * Math.cos(ground.theta)) / Math.sin(ground.theta);
    const maxGroundY = Math.max(
      Math.min(groundYAtLeft, height - 1),
      Math.min(groundYAtRight, height - 1)
    );

    // Define search band above ground (from 0 to maxGroundY)
    const searchHeight = Math.ceil(maxGroundY);
    if (searchHeight <= 10) {
      return { roi: null, confidence: 0 };
    }

    // Compute temporal motion variance in the search band
    const motionEnergy = new Float32Array(width * searchHeight);

    for (let t = 1; t < frames.length; t += 1) {
      const prev = frames[t - 1];
      const curr = frames[t];
      for (let y = 0; y < searchHeight; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const idx = y * width + x;
          const prevVal = prev.data[idx] ?? 0;
          const currVal = curr.data[idx] ?? 0;
          motionEnergy[idx] += Math.abs(currVal - prevVal);
        }
      }
    }

    // Find peak motion column (x coordinate of center)
    let peakX = 0;
    let peakEnergy = 0;
    for (let x = 0; x < width; x += 1) {
      let colEnergy = 0;
      for (let y = 0; y < searchHeight; y += 1) {
        colEnergy += motionEnergy[y * width + x];
      }
      if (colEnergy > peakEnergy) {
        peakEnergy = colEnergy;
        peakX = x;
      }
    }

    // No significant motion detected
    if (peakEnergy < 50) {
      return { roi: null, confidence: 0 };
    }

    // Define ROI rectangle (foot-like aspect ratio: ~1.5:1, height ~30-50px)
    const roiHeight = Math.min(40, Math.ceil(searchHeight * 0.3));
    const roiWidth = Math.ceil(roiHeight * 1.2); // aspect ratio

    // Center ROI on peak motion, but keep it above ground
    const roiY = Math.max(0, Math.ceil(maxGroundY) - roiHeight - 5);
    const roiX = Math.max(0, Math.min(width - roiWidth, peakX - Math.floor(roiWidth / 2)));

    // Confidence based on motion signal strength (normalized)
    const confidence = Math.min(1, peakEnergy / 500);

    return {
      roi: { x: roiX, y: roiY, w: roiWidth, h: roiHeight },
      confidence,
    };
  } catch (error) {
    return { roi: null, confidence: 0 };
  }
}
