import { type JumpAnalysis } from "./jumpAnalysisContract";
import { MOCK_ANALYSIS } from "./mockAnalysis";

// v0: return mock immediately. Later replace internals with real CV.
export async function analyzeVideo(_uri: string): Promise<JumpAnalysis> {
  return MOCK_ANALYSIS;
}
