export const FAILURE_CLASSIFICATIONS = [
  'AGENT_EXECUTABLE_DRIFT',
  'MALFORMED_REVIEW_OUTPUT',
  'PROVIDER_OUTPUT_CONTRACT_FAILURE',
  'OWNERSHIP_EXPANSION_REQUIRED',
  'INTEGRATION_ENVIRONMENT_MISMATCH',
] as const;

export type FailureClassification = (typeof FAILURE_CLASSIFICATIONS)[number];

export type DiagnosisEvidenceKind =
  | 'state'
  | 'attempt'
  | 'event'
  | 'artifact'
  | 'log'
  | 'filesystem';

export interface DiagnosisEvidence {
  readonly kind: DiagnosisEvidenceKind;
  readonly reference: string;
  readonly summary: string;
}

export interface RecommendedAction {
  readonly id: string;
  readonly command?: string;
  readonly requiresHumanAuthorization: boolean;
  readonly execution: 'manual';
  readonly reason: string;
}

export interface FailureDiagnosis {
  readonly version: 1;
  readonly status: 'diagnosed' | 'unknown' | 'no_active_failure';
  readonly runId: string;
  readonly subject: {
    readonly kind: 'task' | 'integration' | 'run';
    readonly taskId?: string;
  };
  readonly classification?: FailureClassification;
  readonly evidence: readonly DiagnosisEvidence[];
  readonly recommendedAction?: RecommendedAction;
}
