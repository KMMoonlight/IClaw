export interface EvalCase {
  name: string;
  /** Optional category for grouped reporting. */
  group?: string;
  /** Throw (or reject) to fail the case. */
  run: () => Promise<void> | void;
}

export interface EvalCaseResult {
  name: string;
  group: string;
  passed: boolean;
  error?: string;
  durationMs: number;
}

export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  results: EvalCaseResult[];
}
