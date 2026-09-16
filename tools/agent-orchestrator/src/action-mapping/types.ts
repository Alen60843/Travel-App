import type { FailureClassification, FailureDiagnosis } from '../failure-intelligence/types';

export const ACTION_IDS = [
  'REPIN_AGENT_EXECUTABLE',
  'RETRY_REVIEW_OUTPUT',
  'CONTINUE_CLAUDE_REVIEW_OUTPUT',
  'PROPOSE_REPLAN',
  'RETRY_INTEGRATION',
  'MANUAL_INSPECTION',
] as const;

export type ActionId = (typeof ACTION_IDS)[number];

export interface ActionCandidate {
  readonly version: 1;
  readonly id: ActionId;
  readonly subject: FailureDiagnosis['subject'];
  readonly mutatesState: boolean;
  readonly execution: 'manual';
  readonly authority: {
    readonly kind: 'human';
    readonly required: boolean;
  };
  readonly reason: string;
  readonly basis: {
    readonly classification: FailureClassification;
    readonly evidenceReferences: readonly string[];
  };
  readonly command?: {
    readonly script: string;
    readonly args: readonly string[];
  };
}
