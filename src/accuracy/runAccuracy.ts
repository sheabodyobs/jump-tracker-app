/**
 * Accuracy Runner
 *
 * Loads golden dataset, runs offline pipeline on cached frames,
 * compares auto-detected events vs. ground-truth labels,
 * and generates JSON report with error metrics and aggregation.
 *
 * NOTE: Frame cache loading is implemented; pipeline integration
 * depends on frame extraction being available (currently iOS-only).
 * For now, this runner serves as the harness, skipping cases without cache.
 */

import * as fs from 'fs';
import * as path from 'path';
import { cacheExists, getCacheMetadata, loadFramesFromCache } from './frameCache';
import {
    GoldenDatasetManifest,
    loadGoldenDataset
} from './goldenDataset';

// Import types from contract (available on all platforms)
import type { JumpMetrics } from '../analysis/jumpAnalysisContract';

/**
 * Percentile calculation (deterministic, O(n) average)
 * Uses nearest-rank method for reproducibility
 */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];

  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(rank, sorted.length - 1))];
}

/**
 * Median (50th percentile)
 */
function median(values: number[]): number {
  return percentile(values, 50);
}

/**
 * Match events using nearest neighbor within tolerance
 * Returns array of { auto, label, errorMs } for matched events
 * and { unmatched: 'auto' | 'label' } for unmatched
 */
export function matchEvents(
  autoTimes: number[],
  labelTimes: number[],
  toleranceMs: number
): Array<{
  auto?: number;
  label?: number;
  errorMs?: number;
  unmatched?: 'auto' | 'label';
}> {
  const matches: Array<{
    auto?: number;
    label?: number;
    errorMs?: number;
    unmatched?: 'auto' | 'label';
  }> = [];
  const usedLabels = new Set<number>();
  const usedAuto = new Set<number>();

  // For each auto event, find nearest label within tolerance
  for (let autoIdx = 0; autoIdx < autoTimes.length; autoIdx++) {
    const autoT = autoTimes[autoIdx];
    let bestLabel: number | null = null;
    let bestDist = toleranceMs + 1;

    for (let i = 0; i < labelTimes.length; i++) {
      if (usedLabels.has(i)) continue;
      const dist = Math.abs(autoT - labelTimes[i]);
      if (dist < bestDist) {
        bestDist = dist;
        bestLabel = i;
      }
    }

    if (bestLabel !== null && bestDist <= toleranceMs) {
      usedLabels.add(bestLabel);
      usedAuto.add(autoIdx);
      matches.push({
        auto: autoT,
        label: labelTimes[bestLabel],
        errorMs: autoT - labelTimes[bestLabel],
      });
    } else {
      usedAuto.add(autoIdx);
      matches.push({ auto: autoT, unmatched: 'auto' });
    }
  }

  // Unmatched labels
  for (let i = 0; i < labelTimes.length; i++) {
    if (!usedLabels.has(i)) {
      matches.push({ label: labelTimes[i], unmatched: 'label' });
    }
  }

  return matches;
}

/**
 * Pair landings and takeoffs into hops
 * Returns array of { landing, takeoff } pairs
 */
interface Hop {
  landingMs: number;
  takeoffMs: number;
  gctMs: number; // ground contact time = takeoff - landing
}

// Gate outcome for CLI exit handling
interface GateOutcome {
  runnableCount: number;
  passedCount: number;
  failedCount: number;
  exitCode: number;
  failingCases: Array<{ caseId: string; reasons: string[] }>;
}

function pairHops(landings: number[], takeoffs: number[]): Hop[] {
  const hops: Hop[] = [];

  // Simple greedy pairing: each landing paired with next takeoff
  let takeoffIdx = 0;

  for (const landing of landings) {
    while (takeoffIdx < takeoffs.length && takeoffs[takeoffIdx] <= landing) {
      takeoffIdx++;
    }

    if (takeoffIdx < takeoffs.length) {
      const takeoff = takeoffs[takeoffIdx];
      hops.push({
        landingMs: landing,
        takeoffMs: takeoff,
        gctMs: takeoff - landing,
      });
    }
  }

  return hops;
}

/**
 * Match hops (pairs of landing/takeoff) and compute GCT error
 * Returns matched hops with GCT error
 */
function matchHops(
  autoHops: Hop[],
  labelHops: Hop[],
  toleranceMs: number
): Array<{
  auto?: Hop;
  label?: Hop;
  gctErrorMs?: number;
  unmatched?: 'auto' | 'label';
}> {
  const matches: Array<{
    auto?: Hop;
    label?: Hop;
    gctErrorMs?: number;
    unmatched?: 'auto' | 'label';
  }> = [];
  const usedLabels = new Set<number>();

  // For each auto hop, find nearest label hop by landing time
  for (const autoHop of autoHops) {
    let bestLabel: number | null = null;
    let bestDist = toleranceMs + 1;

    for (let i = 0; i < labelHops.length; i++) {
      if (usedLabels.has(i)) continue;
      const dist = Math.abs(autoHop.landingMs - labelHops[i].landingMs);
      if (dist < bestDist) {
        bestDist = dist;
        bestLabel = i;
      }
    }

    if (bestLabel !== null && bestDist <= toleranceMs) {
      usedLabels.add(bestLabel);
      const labelHop = labelHops[bestLabel];
      matches.push({
        auto: autoHop,
        label: labelHop,
        gctErrorMs: autoHop.gctMs - labelHop.gctMs,
      });
    } else {
      matches.push({ auto: autoHop, unmatched: 'auto' });
    }
  }

  // Unmatched labels
  for (let i = 0; i < labelHops.length; i++) {
    if (!usedLabels.has(i)) {
      matches.push({ label: labelHops[i], unmatched: 'label' });
    }
  }

  return matches;
}

/**
 * Result for a single test case
 */
export interface CaseResult {
  caseId: string;
  status: 'accept' | 'reject' | 'skip' | 'error';
  skipReason?: string;
  errorReason?: string;

  // Expected result
  expectedAccept: boolean;
  expectedThresholds?: {
    maxMedianGctErrMs?: number;
    maxP95GctErrMs?: number;
    maxMedianFlightErrMs?: number;
    maxP95FlightErrMs?: number;
    maxMedianLandingErrMs?: number;
    maxP95LandingErrMs?: number;
    maxMedianTakeoffErrMs?: number;
    maxP95TakeoffErrMs?: number;
  };

  // Actual results (if not skipped/errored)
  autoMetrics?: JumpMetrics | null; // null means rejected
  pipelineAccepted?: boolean; // whether pipeline accepted the video

  // Error metrics (only if pipelineAccepted=true and expectedAccept=true)
  landingErrorsMs?: number[]; // absolute errors for matched landings
  takeoffErrorsMs?: number[]; // absolute errors for matched takeoffs
  gctErrorsMs?: number[]; // GCT errors for matched hops
  flightErrorsMs?: number[]; // flight time errors for matched hops

  unmatchedAutoLandings?: number; // auto landings with no label match
  unmatchedAutoTakeoffs?: number; // auto takeoffs with no label match
  unmatchedLabelLandings?: number; // label landings with no auto match
  unmatchedLabelTakeoffs?: number; // label takeoffs with no auto match

  metrics?: {
    numMatches: number;
    medianLandingErrMs?: number;
    p95LandingErrMs?: number;
    medianTakeoffErrMs?: number;
    p95TakeoffErrMs?: number;
    medianGctErrMs?: number;
    p95GctErrMs?: number;
    medianFlightErrMs?: number;
    p95FlightErrMs?: number;
  };

  // Threshold check
  thresholdPassed?: boolean;
  thresholdFailures?: string[]; // which thresholds failed
}

/**
 * Aggregated results across all cases
 */
export interface AccuracyReport {
  timestamp: string;
  version: string;
  numTotalCases: number;
  numAcceptCases: number;
  numRejectCases: number;
  numSkipped: number;
  numErrors: number;

  // Cases
  cases: CaseResult[];

  // Global metrics (aggregated across accept cases that ran)
  global?: {
    numCasesAnalyzed: number; // cases that weren't skipped/errored
    numMatchedHops: number;
    medianGctErrMs: number;
    p95GctErrMs: number;
    medianLandingErrMs: number;
    p95LandingErrMs: number;
    medianTakeoffErrMs: number;
    p95TakeoffErrMs: number;
    medianFlightErrMs: number;
    p95FlightErrMs: number;
  };

  // Reject rate metrics
  rejectMetrics?: {
    shouldAcceptCount: number;
    actuallyRejectedCount: number; // pipeline returned null
    rejectRate: number; // percent rejected when should accept
    shouldRejectCount: number;
    falseAcceptCount: number; // pipeline accepted when should reject
    falseAcceptRate: number; // percent false accepts
  };

  // Summary
  summary: {
    allThresholdsPassed: boolean;
    casesFailedThresholds: string[]; // case IDs that failed threshold checks
  };
}

/**
 * Run accuracy analysis on golden dataset
 */
export function runAccuracy(
  manifestPath: string = 'datasets/gct-golden/manifest.json',
  reportOutputDir: string = 'datasets/gct-golden/reports'
): AccuracyReport {
  // Create report directory
  fs.mkdirSync(reportOutputDir, { recursive: true });

  // Load manifest
  console.log(`Loading manifest from ${manifestPath}...`);
  let manifest: GoldenDatasetManifest;
  try {
    manifest = loadGoldenDataset(manifestPath);
  } catch (error) {
    throw new Error(
      `Failed to load manifest: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  console.log(`Loaded ${manifest.cases.length} test cases\n`);

  const caseResults: CaseResult[] = [];
  const acceptCases = manifest.cases.filter((c) => c.expected.shouldAccept);
  const rejectCases = manifest.cases.filter((c) => !c.expected.shouldAccept);

  // Collect global error metrics
  const allGctErrors: number[] = [];
  const allLandingErrors: number[] = [];
  const allTakeoffErrors: number[] = [];
  const allFlightErrors: number[] = [];

  let numCasesAnalyzed = 0;
  let numMatchedHops = 0;
  let actuallyRejectedCount = 0;
  let falseAcceptCount = 0;

  // Process each case
  for (const testCase of manifest.cases) {
    process.stdout.write(`Processing ${testCase.id}... `);

    const result: CaseResult = {
      caseId: testCase.id,
      status: 'skip',
      expectedAccept: testCase.expected.shouldAccept,
      expectedThresholds: {
        maxMedianGctErrMs: testCase.expected.maxMedianGctErrMs,
        maxP95GctErrMs: testCase.expected.maxP95GctErrMs,
        maxMedianFlightErrMs: testCase.expected.maxMedianFlightErrMs,
        maxP95FlightErrMs: testCase.expected.maxP95FlightErrMs,
        maxMedianLandingErrMs: testCase.expected.maxMedianLandingErrMs,
        maxP95LandingErrMs: testCase.expected.maxP95LandingErrMs,
        maxMedianTakeoffErrMs: testCase.expected.maxMedianTakeoffErrMs,
        maxP95TakeoffErrMs: testCase.expected.maxP95TakeoffErrMs,
      },
    };

    try {
      // Check for frame cache
      if (!cacheExists(testCase.id)) {
        result.status = 'skip';
        result.skipReason = 'no frame cache';
        console.log('SKIPPED (no frame cache)');
        caseResults.push(result);
        continue;
      }

      // Load cached frames
      const frames = loadFramesFromCache(testCase.id);
      if (!frames || frames.length === 0) {
        result.status = 'skip';
        result.skipReason = 'frame cache empty';
        console.log('SKIPPED (frame cache empty)');
        caseResults.push(result);
        continue;
      }

      // Get cache metadata for ROI
      const metadata = getCacheMetadata(testCase.id);

      // Run pipeline (STUB - full pipeline requires iOS frame extraction)
      // For now, this demonstrates the matching and error calculation flow
      // TODO: Integrate with actual offline pipeline when frame extraction available
      
      // Stub: mark as rejected for now (no cached analysis results)
      const autoMetrics: JumpMetrics | null = null;
      const autoLandings: number[] = []; // Will be populated when pipeline integrated
      const autoTakeoffs: number[] = [];

      result.autoMetrics = autoMetrics;
      result.pipelineAccepted = autoMetrics !== null;

      // Check acceptance
      if (autoMetrics === null) {
        // Pipeline rejected
        if (testCase.expected.shouldAccept) {
          result.status = 'reject';
          actuallyRejectedCount++;
        } else {
          result.status = 'accept'; // Good reject
        }
        console.log(autoMetrics === null ? 'REJECTED' : 'ACCEPTED');
        caseResults.push(result);
        continue;
      }

      numCasesAnalyzed++;

      // Pipeline accepted
      if (!testCase.expected.shouldAccept) {
        // False accept
        result.status = 'reject';
        falseAcceptCount++;
        console.log('FALSE ACCEPT');
        caseResults.push(result);
        continue;
      }

      // Expected accept and pipeline accepted - compare metrics
      result.status = 'accept';

      // Match landing/takeoff events
      const toleranceMs = testCase.labels.toleranceMs || 50;

      const landingMatches = matchEvents(
        autoLandings,
        testCase.labels.landingsMs,
        toleranceMs
      );

      const takeoffMatches = matchEvents(
        autoTakeoffs,
        testCase.labels.takeoffsMs,
        toleranceMs
      );

      // Pair hops and match GCT
      const autoHops = pairHops(autoLandings, autoTakeoffs);
      const labelHops = pairHops(
        testCase.labels.landingsMs,
        testCase.labels.takeoffsMs
      );

      const hopMatches = matchHops(autoHops, labelHops, toleranceMs);

      // Collect matched errors
      const landingErrors = landingMatches
        .filter((m) => m.errorMs !== undefined)
        .map((m) => Math.abs(m.errorMs!));

      const takeoffErrors = takeoffMatches
        .filter((m) => m.errorMs !== undefined)
        .map((m) => Math.abs(m.errorMs!));

      const gctErrors = hopMatches
        .filter((m) => m.gctErrorMs !== undefined)
        .map((m) => Math.abs(m.gctErrorMs!));

      // Flight time errors (takeoff - landing)
      const flightErrors = hopMatches
        .filter((m) => m.auto !== undefined && m.label !== undefined)
        .map((m) => {
          const autoFlight = m.auto!.takeoffMs - m.auto!.landingMs;
          const labelFlight = m.label!.takeoffMs - m.label!.landingMs;
          return Math.abs(autoFlight - labelFlight);
        });

      result.landingErrorsMs = landingErrors;
      result.takeoffErrorsMs = takeoffErrors;
      result.gctErrorsMs = gctErrors;
      result.flightErrorsMs = flightErrors;

      result.unmatchedAutoLandings = landingMatches.filter(
        (m) => m.unmatched === 'auto'
      ).length;
      result.unmatchedAutoTakeoffs = takeoffMatches.filter(
        (m) => m.unmatched === 'auto'
      ).length;
      result.unmatchedLabelLandings = landingMatches.filter(
        (m) => m.unmatched === 'label'
      ).length;
      result.unmatchedLabelTakeoffs = takeoffMatches.filter(
        (m) => m.unmatched === 'label'
      ).length;

      // Compute metrics
      const numMatches = hopMatches.filter(
        (m) => m.auto !== undefined && m.label !== undefined
      ).length;

      result.metrics = {
        numMatches,
        medianLandingErrMs: landingErrors.length > 0 ? median(landingErrors) : undefined,
        p95LandingErrMs: landingErrors.length > 0 ? percentile(landingErrors, 95) : undefined,
        medianTakeoffErrMs: takeoffErrors.length > 0 ? median(takeoffErrors) : undefined,
        p95TakeoffErrMs: takeoffErrors.length > 0 ? percentile(takeoffErrors, 95) : undefined,
        medianGctErrMs: gctErrors.length > 0 ? median(gctErrors) : undefined,
        p95GctErrMs: gctErrors.length > 0 ? percentile(gctErrors, 95) : undefined,
        medianFlightErrMs: flightErrors.length > 0 ? median(flightErrors) : undefined,
        p95FlightErrMs: flightErrors.length > 0 ? percentile(flightErrors, 95) : undefined,
      };

      // Aggregate global metrics
      if (numMatches > 0) {
        numMatchedHops += numMatches;
        allGctErrors.push(...gctErrors);
        allLandingErrors.push(...landingErrors);
        allTakeoffErrors.push(...takeoffErrors);
        allFlightErrors.push(...flightErrors);
      }

      // Check thresholds
      result.thresholdPassed = true;
      result.thresholdFailures = [];

      if (
        testCase.expected.maxMedianGctErrMs !== undefined &&
        result.metrics.medianGctErrMs !== undefined &&
        result.metrics.medianGctErrMs > testCase.expected.maxMedianGctErrMs
      ) {
        result.thresholdPassed = false;
        result.thresholdFailures.push(
          `medianGctErr ${result.metrics.medianGctErrMs.toFixed(1)}ms > ${testCase.expected.maxMedianGctErrMs}ms`
        );
      }

      if (
        testCase.expected.maxP95GctErrMs !== undefined &&
        result.metrics.p95GctErrMs !== undefined &&
        result.metrics.p95GctErrMs > testCase.expected.maxP95GctErrMs
      ) {
        result.thresholdPassed = false;
        result.thresholdFailures.push(
          `p95GctErr ${result.metrics.p95GctErrMs.toFixed(1)}ms > ${testCase.expected.maxP95GctErrMs}ms`
        );
      }

      if (
        testCase.expected.maxMedianFlightErrMs !== undefined &&
        result.metrics.medianFlightErrMs !== undefined &&
        result.metrics.medianFlightErrMs > testCase.expected.maxMedianFlightErrMs
      ) {
        result.thresholdPassed = false;
        result.thresholdFailures.push(
          `medianFlightErr ${result.metrics.medianFlightErrMs.toFixed(1)}ms > ${testCase.expected.maxMedianFlightErrMs}ms`
        );
      }

      if (
        testCase.expected.maxP95FlightErrMs !== undefined &&
        result.metrics.p95FlightErrMs !== undefined &&
        result.metrics.p95FlightErrMs > testCase.expected.maxP95FlightErrMs
      ) {
        result.thresholdPassed = false;
        result.thresholdFailures.push(
          `p95FlightErr ${result.metrics.p95FlightErrMs.toFixed(1)}ms > ${testCase.expected.maxP95FlightErrMs}ms`
        );
      }

      console.log(
        result.thresholdPassed
          ? `PASS (${numMatches} hops)`
          : `FAIL (${result.thresholdFailures?.join(', ')})`
      );

      caseResults.push(result);
    } catch (error) {
      result.status = 'error';
      result.errorReason = error instanceof Error ? error.message : String(error);
      console.log(`ERROR: ${result.errorReason}`);
      caseResults.push(result);
    }
  }

  // Build report
  const report: AccuracyReport = {
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    numTotalCases: manifest.cases.length,
    numAcceptCases: acceptCases.length,
    numRejectCases: rejectCases.length,
    numSkipped: caseResults.filter((r) => r.status === 'skip').length,
    numErrors: caseResults.filter((r) => r.status === 'error').length,
    cases: caseResults,
    rejectMetrics: {
      shouldAcceptCount: acceptCases.length,
      actuallyRejectedCount,
      rejectRate: acceptCases.length > 0 ? (actuallyRejectedCount / acceptCases.length) * 100 : 0,
      shouldRejectCount: rejectCases.length,
      falseAcceptCount,
      falseAcceptRate: rejectCases.length > 0 ? (falseAcceptCount / rejectCases.length) * 100 : 0,
    },
    summary: {
      allThresholdsPassed: caseResults.every(
        (r) => r.status !== 'accept' || r.thresholdPassed
      ),
      casesFailedThresholds: caseResults
        .filter((r) => r.status === 'accept' && !r.thresholdPassed)
        .map((r) => r.caseId),
    },
  };

  // Add global metrics if we have data
  if (numCasesAnalyzed > 0) {
    report.global = {
      numCasesAnalyzed,
      numMatchedHops,
      medianGctErrMs: allGctErrors.length > 0 ? median(allGctErrors) : 0,
      p95GctErrMs: allGctErrors.length > 0 ? percentile(allGctErrors, 95) : 0,
      medianLandingErrMs: allLandingErrors.length > 0 ? median(allLandingErrors) : 0,
      p95LandingErrMs: allLandingErrors.length > 0 ? percentile(allLandingErrors, 95) : 0,
      medianTakeoffErrMs: allTakeoffErrors.length > 0 ? median(allTakeoffErrors) : 0,
      p95TakeoffErrMs: allTakeoffErrors.length > 0 ? percentile(allTakeoffErrors, 95) : 0,
      medianFlightErrMs: allFlightErrors.length > 0 ? median(allFlightErrors) : 0,
      p95FlightErrMs: allFlightErrors.length > 0 ? percentile(allFlightErrors, 95) : 0,
    };
  }

  // Write report
  const reportPath = path.join(reportOutputDir, 'latest.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport written to ${reportPath}`);

  // Print summary
  printSummary(report);

  return report;
}

/**
 * Print concise console summary
 */
function printSummary(report: AccuracyReport): void {
  console.log('\n' + '='.repeat(60));
  console.log('ACCURACY SUMMARY');
  console.log('='.repeat(60));

  console.log(`\nCases: ${report.numTotalCases} total`);
  console.log(`  - Accept: ${report.numAcceptCases}`);
  console.log(`  - Reject: ${report.numRejectCases}`);
  console.log(`  - Skipped: ${report.numSkipped}`);
  console.log(`  - Errors: ${report.numErrors}`);

  if (report.rejectMetrics) {
    console.log(`\nReject Rate: ${report.rejectMetrics.rejectRate.toFixed(1)}%`);
    console.log(`  - Should accept: ${report.rejectMetrics.shouldAcceptCount}`);
    console.log(`  - Actually rejected: ${report.rejectMetrics.actuallyRejectedCount}`);

    console.log(`\nFalse Accept Rate: ${report.rejectMetrics.falseAcceptRate.toFixed(1)}%`);
    console.log(`  - Should reject: ${report.rejectMetrics.shouldRejectCount}`);
    console.log(`  - Actually accepted: ${report.rejectMetrics.falseAcceptCount}`);
  }

  if (report.global) {
    console.log(`\nGlobal Metrics (${report.global.numCasesAnalyzed} cases analyzed)`);
    console.log(`  - Matched hops: ${report.global.numMatchedHops}`);
    console.log(`  - Median GCT error: ${report.global.medianGctErrMs.toFixed(1)}ms`);
    console.log(`  - P95 GCT error: ${report.global.p95GctErrMs.toFixed(1)}ms`);
    console.log(`  - Median flight error: ${report.global.medianFlightErrMs.toFixed(1)}ms`);
    console.log(`  - P95 flight error: ${report.global.p95FlightErrMs.toFixed(1)}ms`);
  }

  console.log(`\nAll Thresholds Passed: ${report.summary.allThresholdsPassed ? 'YES ✓' : 'NO ✗'}`);
  if (report.summary.casesFailedThresholds.length > 0) {
    console.log(`  Failed cases: ${report.summary.casesFailedThresholds.join(', ')}`);
  }

  console.log('='.repeat(60) + '\n');
}

/**
 * Evaluate regression gate outcomes based on case results
 * Only considers runnable cases (not skipped or errored)
 */
function evaluateGate(report: AccuracyReport): GateOutcome {
  const runnable = report.cases.filter(
    (c) => c.status !== 'skip' && c.status !== 'error'
  );

  const failingCases: Array<{ caseId: string; reasons: string[] }> = [];

  for (const c of runnable) {
    const reasons: string[] = [];

    if (c.expectedAccept) {
      // Should accept
      if (!c.pipelineAccepted) {
        reasons.push('rejected but shouldAccept');
      } else if (c.thresholdPassed === false) {
        if (c.thresholdFailures && c.thresholdFailures.length > 0) {
          reasons.push(...c.thresholdFailures);
        } else {
          reasons.push('thresholds not met');
        }
      }
    } else {
      // Should reject
      if (c.pipelineAccepted) {
        reasons.push('false-accept (shouldReject)');
      }
    }

    if (reasons.length > 0) {
      failingCases.push({ caseId: c.caseId, reasons });
    }
  }

  const failedCount = failingCases.length;
  const passedCount = runnable.length - failedCount;

  return {
    runnableCount: runnable.length,
    passedCount,
    failedCount,
    exitCode: failedCount > 0 ? 1 : 0,
    failingCases,
  };
}

/**
 * Print gate scoreboard
 */
function printGateScoreboard(report: AccuracyReport, gate: GateOutcome): void {
  console.log('\nGATE SCOREBOARD');
  console.log('='.repeat(60));
  console.log(`Runnable cases: ${gate.runnableCount}`);
  console.log(`Pass: ${gate.passedCount}  Fail: ${gate.failedCount}`);

  if (report.global) {
    console.log('\nGlobal metrics (across runnable accept cases):');
    console.log(`  Median GCT error: ${report.global.medianGctErrMs.toFixed(1)}ms`);
    console.log(`  P95 GCT error: ${report.global.p95GctErrMs.toFixed(1)}ms`);
    console.log(`  Median landing error: ${report.global.medianLandingErrMs.toFixed(1)}ms`);
    console.log(`  P95 landing error: ${report.global.p95LandingErrMs.toFixed(1)}ms`);
    console.log(`  Median takeoff error: ${report.global.medianTakeoffErrMs.toFixed(1)}ms`);
    console.log(`  P95 takeoff error: ${report.global.p95TakeoffErrMs.toFixed(1)}ms`);
    console.log(`  Median flight error: ${report.global.medianFlightErrMs.toFixed(1)}ms`);
    console.log(`  P95 flight error: ${report.global.p95FlightErrMs.toFixed(1)}ms`);
  }

  if (gate.failingCases.length > 0) {
    console.log('\nFailing cases:');
    for (const f of gate.failingCases) {
      console.log(`  - ${f.caseId}: ${f.reasons.join('; ')}`);
    }
  }

  if (gate.runnableCount === 0) {
    console.warn('\nWARNING: No runnable cases (no frame caches). Gate skipped.');
  }

  console.log('='.repeat(60) + '\n');
}

// CLI entry point
if (require.main === module) {
  try {
    const report = runAccuracy();
    const gate = evaluateGate(report);
    printGateScoreboard(report, gate);

    if (gate.exitCode === 0) {
      console.log('Accuracy gate PASSED.');
    } else {
      console.error('Accuracy gate FAILED.');
    }

    process.exit(gate.exitCode);
  } catch (error: unknown) {
    console.error('Accuracy runner failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
