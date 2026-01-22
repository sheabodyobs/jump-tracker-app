/**
 * Golden Dataset Loader & Validator
 *
 * Loads and validates the golden dataset manifest for accuracy testing.
 * Provides runtime schema validation without external dependencies.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * ROI specification with normalized coordinates [0..1]
 */
export interface RoiSpec {
  space: 'normalized' | 'pixel';
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Ground-truth labels for a test case
 */
export interface LabelsSpec {
  source: 'manual-label-mode' | 'external' | 'synthetic';
  toleranceMs: number;
  landingsMs: number[];
  takeoffsMs: number[];
}

/**
 * Expected accuracy thresholds and acceptance criteria
 */
export interface ExpectedSpec {
  shouldAccept: boolean;
  reason?: string;
  maxMedianGctErrMs?: number;
  maxP95GctErrMs?: number;
  maxMedianFlightErrMs?: number;
  maxP95FlightErrMs?: number;
  maxMedianLandingErrMs?: number;
  maxP95LandingErrMs?: number;
  maxMedianTakeoffErrMs?: number;
  maxP95TakeoffErrMs?: number;
}

/**
 * A single golden dataset test case
 */
export interface GoldenTestCase {
  id: string;
  uri: string;
  notes?: string;
  roi: RoiSpec;
  labels: LabelsSpec;
  expected: ExpectedSpec;
}

/**
 * Golden dataset manifest
 */
export interface GoldenDatasetManifest {
  version: string;
  description: string;
  fpsAssumption: number;
  cases: GoldenTestCase[];
}

/**
 * Error type for validation failures
 */
export class ValidationError extends Error {
  constructor(message: string, public path: string, public details?: any) {
    super(`${path}: ${message}`);
    this.name = 'ValidationError';
  }
}

/**
 * Validate ROI specification
 */
function validateRoiSpec(roi: any, casePath: string): RoiSpec {
  if (!roi || typeof roi !== 'object') {
    throw new ValidationError('roi must be an object', casePath);
  }

  if (!['normalized', 'pixel'].includes(roi.space)) {
    throw new ValidationError(`roi.space must be 'normalized' or 'pixel'`, `${casePath}.roi.space`);
  }

  const required = ['x', 'y', 'width', 'height'];
  for (const field of required) {
    if (typeof roi[field] !== 'number') {
      throw new ValidationError(`roi.${field} must be a number`, `${casePath}.roi.${field}`);
    }
  }

  if (roi.space === 'normalized') {
    if (roi.x < 0 || roi.x > 1 || roi.y < 0 || roi.y > 1 ||
        roi.width < 0 || roi.width > 1 || roi.height < 0 || roi.height > 1) {
      throw new ValidationError('normalized roi values must be in [0..1]', `${casePath}.roi`);
    }
  }

  return roi as RoiSpec;
}

/**
 * Validate labels specification
 */
function validateLabelsSpec(labels: any, casePath: string): LabelsSpec {
  if (!labels || typeof labels !== 'object') {
    throw new ValidationError('labels must be an object', casePath);
  }

  if (!['manual-label-mode', 'external', 'synthetic'].includes(labels.source)) {
    throw new ValidationError(
      `labels.source must be 'manual-label-mode', 'external', or 'synthetic'`,
      `${casePath}.labels.source`
    );
  }

  if (typeof labels.toleranceMs !== 'number' || labels.toleranceMs < 0) {
    throw new ValidationError('labels.toleranceMs must be a non-negative number', `${casePath}.labels.toleranceMs`);
  }

  if (!Array.isArray(labels.landingsMs)) {
    throw new ValidationError('labels.landingsMs must be an array', `${casePath}.labels.landingsMs`);
  }

  if (!Array.isArray(labels.takeoffsMs)) {
    throw new ValidationError('labels.takeoffsMs must be an array', `${casePath}.labels.takeoffsMs`);
  }

  // Validate all elements are numbers
  for (let i = 0; i < labels.landingsMs.length; i++) {
    if (typeof labels.landingsMs[i] !== 'number') {
      throw new ValidationError(
        `landingsMs[${i}] must be a number`,
        `${casePath}.labels.landingsMs[${i}]`
      );
    }
  }

  for (let i = 0; i < labels.takeoffsMs.length; i++) {
    if (typeof labels.takeoffsMs[i] !== 'number') {
      throw new ValidationError(
        `takeoffsMs[${i}] must be a number`,
        `${casePath}.labels.takeoffsMs[${i}]`
      );
    }
  }

  // Validate monotonicity
  const allEvents = [
    ...(labels.landingsMs as number[]).map((t) => ({ t, type: 'landing' })),
    ...(labels.takeoffsMs as number[]).map((t) => ({ t, type: 'takeoff' })),
  ].sort((a, b) => a.t - b.t);

  for (let i = 0; i < allEvents.length - 1; i++) {
    if (allEvents[i].t === allEvents[i + 1].t) {
      throw new ValidationError(
        `duplicate timestamp at ${allEvents[i].t}ms`,
        `${casePath}.labels`
      );
    }
  }

  // Validate pairing: landings must precede takeoffs in a pattern
  for (let i = 0; i < labels.landingsMs.length; i++) {
    const landing = labels.landingsMs[i];
    // Must have a takeoff after this landing
    const nextTakeoff = (labels.takeoffsMs as number[]).find((t) => t > landing);
    if (!nextTakeoff) {
      throw new ValidationError(
        `landing at ${landing}ms has no corresponding takeoff`,
        `${casePath}.labels`
      );
    }
  }

  return labels as LabelsSpec;
}

/**
 * Validate expected specification
 */
function validateExpectedSpec(expected: any, casePath: string): ExpectedSpec {
  if (!expected || typeof expected !== 'object') {
    throw new ValidationError('expected must be an object', casePath);
  }

  if (typeof expected.shouldAccept !== 'boolean') {
    throw new ValidationError('expected.shouldAccept must be a boolean', `${casePath}.expected.shouldAccept`);
  }

  // If shouldAccept is false, optional reason
  if (!expected.shouldAccept && expected.reason) {
    if (typeof expected.reason !== 'string') {
      throw new ValidationError('expected.reason must be a string', `${casePath}.expected.reason`);
    }
  }

  // If shouldAccept is true, must have at least one threshold
  if (expected.shouldAccept) {
    const hasThreshold =
      typeof expected.maxMedianGctErrMs === 'number' ||
      typeof expected.maxP95GctErrMs === 'number' ||
      typeof expected.maxMedianFlightErrMs === 'number' ||
      typeof expected.maxP95FlightErrMs === 'number' ||
      typeof expected.maxMedianLandingErrMs === 'number' ||
      typeof expected.maxP95LandingErrMs === 'number' ||
      typeof expected.maxMedianTakeoffErrMs === 'number' ||
      typeof expected.maxP95TakeoffErrMs === 'number';

    if (!hasThreshold) {
      throw new ValidationError(
        'shouldAccept=true requires at least one maxMedian* or maxP95* threshold',
        `${casePath}.expected`
      );
    }
  }

  // Validate all threshold fields if present
  const thresholds = [
    'maxMedianGctErrMs',
    'maxP95GctErrMs',
    'maxMedianFlightErrMs',
    'maxP95FlightErrMs',
    'maxMedianLandingErrMs',
    'maxP95LandingErrMs',
    'maxMedianTakeoffErrMs',
    'maxP95TakeoffErrMs',
  ];

  for (const field of thresholds) {
    if (field in expected) {
      if (typeof expected[field] !== 'number' || expected[field] < 0) {
        throw new ValidationError(
          `expected.${field} must be a non-negative number`,
          `${casePath}.expected.${field}`
        );
      }
    }
  }

  return expected as ExpectedSpec;
}

/**
 * Normalize a URI to an absolute file path
 * Supports: file://..., relative paths, absolute paths
 */
export function normalizeUri(uri: string, baseDir: string): string {
  if (uri.startsWith('file://')) {
    // Remove file:// prefix
    const filePath = uri.substring(7);
    if (path.isAbsolute(filePath)) {
      return filePath;
    } else {
      // Relative path after file://
      return path.resolve(baseDir, filePath);
    }
  } else if (path.isAbsolute(uri)) {
    return uri;
  } else {
    // Relative path
    return path.resolve(baseDir, uri);
  }
}

/**
 * Validate a single test case
 */
function validateTestCase(testCase: any, caseIndex: number, baseDir: string): GoldenTestCase {
  const casePath = `cases[${caseIndex}]`;

  if (!testCase || typeof testCase !== 'object') {
    throw new ValidationError('must be an object', casePath);
  }

  // Validate required fields
  if (typeof testCase.id !== 'string' || !testCase.id) {
    throw new ValidationError('id is required and must be a non-empty string', `${casePath}.id`);
  }

  if (typeof testCase.uri !== 'string' || !testCase.uri) {
    throw new ValidationError('uri is required and must be a non-empty string', `${casePath}.uri`);
  }

  // Normalize URI
  let normalizedUri: string;
  try {
    normalizedUri = normalizeUri(testCase.uri, baseDir);
  } catch (e) {
    throw new ValidationError(`failed to normalize uri: ${e instanceof Error ? e.message : String(e)}`, `${casePath}.uri`);
  }

  // Validate optional notes
  if (testCase.notes && typeof testCase.notes !== 'string') {
    throw new ValidationError('notes must be a string', `${casePath}.notes`);
  }

  const roi = validateRoiSpec(testCase.roi, casePath);
  const labels = validateLabelsSpec(testCase.labels, casePath);
  const expected = validateExpectedSpec(testCase.expected, casePath);

  return {
    id: testCase.id,
    uri: normalizedUri,
    notes: testCase.notes,
    roi,
    labels,
    expected,
  };
}

/**
 * Load and validate golden dataset manifest
 */
export function loadGoldenDataset(manifestPath: string): GoldenDatasetManifest {
  // Read file
  let content: string;
  try {
    content = fs.readFileSync(manifestPath, 'utf-8');
  } catch (e) {
    throw new Error(`Failed to read manifest: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Parse JSON
  let manifest: any;
  try {
    manifest = JSON.parse(content);
  } catch (e) {
    throw new Error(`Failed to parse manifest JSON: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Validate schema
  if (!manifest || typeof manifest !== 'object') {
    throw new ValidationError('manifest must be an object', 'root');
  }

  if (typeof manifest.version !== 'string') {
    throw new ValidationError('version is required and must be a string', 'version');
  }

  if (typeof manifest.fpsAssumption !== 'number' || manifest.fpsAssumption <= 0) {
    throw new ValidationError('fpsAssumption must be a positive number', 'fpsAssumption');
  }

  if (!Array.isArray(manifest.cases)) {
    throw new ValidationError('cases must be an array', 'cases');
  }

  if (manifest.cases.length === 0) {
    throw new ValidationError('cases array must not be empty', 'cases');
  }

  // Validate each test case
  const baseDir = path.dirname(manifestPath);
  const validatedCases: GoldenTestCase[] = [];

  for (let i = 0; i < manifest.cases.length; i++) {
    const testCase = validateTestCase(manifest.cases[i], i, baseDir);
    validatedCases.push(testCase);
  }

  return {
    version: manifest.version,
    description: manifest.description || '',
    fpsAssumption: manifest.fpsAssumption,
    cases: validatedCases,
  };
}

/**
 * Validate that a test case video file exists
 */
export function validateVideoExists(testCase: GoldenTestCase): boolean {
  try {
    return fs.existsSync(testCase.uri);
  } catch {
    return false;
  }
}

/**
 * Get summary statistics for a golden dataset
 */
export interface DatasetStats {
  totalCases: number;
  acceptCases: number;
  rejectCases: number;
  totalLabeledLandings: number;
  totalLabeledTakeoffs: number;
  averageHopsPerCase: number;
}

export function getDatasetStats(manifest: GoldenDatasetManifest): DatasetStats {
  let acceptCount = 0;
  let rejectCount = 0;
  let totalLandings = 0;
  let totalTakeoffs = 0;

  for (const testCase of manifest.cases) {
    if (testCase.expected.shouldAccept) {
      acceptCount++;
    } else {
      rejectCount++;
    }
    totalLandings += testCase.labels.landingsMs.length;
    totalTakeoffs += testCase.labels.takeoffsMs.length;
  }

  return {
    totalCases: manifest.cases.length,
    acceptCases: acceptCount,
    rejectCases: rejectCount,
    totalLabeledLandings: totalLandings,
    totalLabeledTakeoffs: totalTakeoffs,
    averageHopsPerCase: totalLandings > 0 ? totalLandings / manifest.cases.length : 0,
  };
}

/**
 * Validate all URIs in manifest
 * Returns list of cases with missing videos
 */
export function validateAllUris(manifest: GoldenDatasetManifest): { missing: string[]; found: number } {
  const missing: string[] = [];
  let found = 0;

  for (const testCase of manifest.cases) {
    if (validateVideoExists(testCase)) {
      found++;
    } else {
      missing.push(`${testCase.id}: ${testCase.uri}`);
    }
  }

  return { missing, found };
}
