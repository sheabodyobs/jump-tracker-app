# Foot Recognition = Contact Patch Detection (No ML)

Deterministic, explainable contact-patch detector used for pogo/jump GCT measurement. Prefers rejection over hallucination and runs offline on iOS-only pipeline.

## Algorithm (Summary)
1. **Band-limited motion energy**: Compute frame-to-frame abs diff in a narrow band above the ground line.
2. **Candidate scan (global)**: Slide fixed-size ROI; score by:
   - **Sharpness**: Peak positive spikes in energy derivative (landings) vs. median abs derivative.
   - **Cadence stability**: Peak interval consistency (low CV of peak intervals).
   - **Concentration**: ROI energy density vs. band energy density (reject whole-band motion).
   - **Ground proximity**: Centroid closeness to ground within band.
   - **Anti-body coupling**: Correlation penalty vs. a body ROI above the band.
3. **Footness**: Weighted, clamped blend of the above. Deterministic (no randomness).
4. **Tracking**: After initial ROI, track locally per frame (±trackMaxShiftPx). Stability = lockedFrames / total; re-init when score drops.
5. **Confidence**: Combines footness and stability. If below threshold -> reject and force pipeline to block metrics.

## Fail-safe Rules
- Confidence < minFootness → reject (return low-confidence result with reasons).
- High body correlation or low sharpness/cadence → reject.
- Never fall back to permissive ROI; legacy ROI is only used for debug while gate stays low.

## Diagnostics
- `footPatch` block in analysis debug:
  - `roi`, `footness`, `stability`, `confidence`
  - `featureScores`: sharpness, cadenceStability, concentration, groundProximity, bodyCorr
  - `selectedFrom`: globalScan/track, `reinitCount`, `avgShiftPx`, `band`
  - `reasons`: e.g., LOW_SHARPNESS, HIGH_BODY_CORR, LOW_CONFIDENCE

## Tuning (use golden dataset runner)
- Adjust weights or thresholds in `footPatchDetector.ts` and run `npm run accuracy:run`.
- Look for false accepts (body sway) vs. false rejects (barefoot/low texture). Increase `concentration` weight to reject band-wide noise; increase `sharpness` weight for clearer impacts.
- Ensure `minFootness` stays conservative (prefer reject) until metrics are stable across cached cases.
