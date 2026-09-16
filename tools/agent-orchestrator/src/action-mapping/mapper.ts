import type { FailureDiagnosis } from '../failure-intelligence/types';
import type { ActionCandidate, ActionId } from './types';

interface CandidateOptions {
  readonly id: ActionId;
  readonly mutatesState: boolean;
  readonly reason: string;
  readonly script?: string;
  readonly args?: readonly string[];
}

/** Pure classification-to-candidate mapping. It performs no eligibility checks or I/O. */
export function mapFailureToActions(diagnosis: FailureDiagnosis): readonly ActionCandidate[] {
  if (diagnosis.status !== 'diagnosed' || diagnosis.classification === undefined) return [];
  const taskId = diagnosis.subject.kind === 'task' ? diagnosis.subject.taskId : undefined;
  switch (diagnosis.classification) {
    case 'AGENT_EXECUTABLE_DRIFT':
      if (taskId === undefined) return [];
      return [candidate(diagnosis, {
        id: 'REPIN_AGENT_EXECUTABLE',
        mutatesState: true,
        reason: 'Explicitly select a replacement executable; the repin command must independently validate the complete migration evidence.',
        script: 'agents:repin-agent-executable',
        args: [diagnosis.runId, diagnosis.agent ?? '<agent>', '<absolute-executable-path>'],
      })];
    case 'MALFORMED_REVIEW_OUTPUT':
      if (taskId === undefined) return [];
      return [candidate(diagnosis, {
        id: 'RETRY_REVIEW_OUTPUT',
        mutatesState: true,
        reason: 'Request the existing one-time same-round structured review retry; that command must independently revalidate every safety invariant.',
        script: 'agents:retry-review-output',
        args: [diagnosis.runId, taskId],
      })];
    case 'PROVIDER_OUTPUT_CONTRACT_FAILURE':
      if (taskId === undefined) return [];
      if (diagnosis.variant === 'CLAUDE_TEXT_CONTRACT_MIGRATION') {
        return [candidate(diagnosis, {
          id: 'CONTINUE_CLAUDE_REVIEW_OUTPUT',
          mutatesState: true,
          reason: 'The diagnosis proves the narrow Claude prompt-only contract migration; the continuation command must independently revalidate its full authorization contract.',
          script: 'agents:continue-claude-review-output',
          args: [diagnosis.runId, taskId],
        })];
      }
      return [manualInspection(diagnosis,
        'The ordinary retry is consumed, but the diagnosis does not prove the one supported Claude text-contract migration; inspect without authorizing another generic retry.')];
    case 'OWNERSHIP_EXPANSION_REQUIRED':
      if (taskId === undefined) return [];
      if (diagnosis.variant === 'EXISTING_REPLAN_CHECKPOINT') {
        return [manualInspection(diagnosis,
          'Inspect the existing replan checkpoint and use its current bounded command; do not restart or bypass that workflow.')];
      }
      if (diagnosis.variant === 'NON_REPOSITORY_WRITE_BOUNDARY') {
        return [manualInspection(diagnosis,
          'The accepted request includes a non-repository write boundary that the static replan command cannot safely normalize.')];
      }
      return [candidate(diagnosis, {
        id: 'PROPOSE_REPLAN',
        mutatesState: true,
        reason: 'Ask the existing bounded replan command to interpret and validate the accepted resource claims; a separate authorization remains required before execution.',
        script: 'agents:propose-replan',
        args: [diagnosis.runId, taskId],
      })];
    case 'INTEGRATION_ENVIRONMENT_MISMATCH':
      if (diagnosis.subject.kind !== 'integration') return [];
      return [candidate(diagnosis, {
        id: 'RETRY_INTEGRATION',
        mutatesState: true,
        reason: 'Correct the external environment first, then explicitly retry only the deterministic integration gate.',
        script: 'agents:retry-integration',
        args: [diagnosis.runId],
      })];
  }
}

function manualInspection(diagnosis: FailureDiagnosis, reason: string): ActionCandidate {
  return candidate(diagnosis, { id: 'MANUAL_INSPECTION', mutatesState: false, reason });
}

function candidate(diagnosis: FailureDiagnosis, options: CandidateOptions): ActionCandidate {
  return {
    version: 1,
    id: options.id,
    subject: { ...diagnosis.subject },
    mutatesState: options.mutatesState,
    execution: 'manual',
    authority: { kind: 'human', required: options.mutatesState },
    reason: options.reason,
    basis: {
      classification: diagnosis.classification!,
      evidenceReferences: diagnosis.evidence.map((entry) => entry.reference),
    },
    ...(options.script === undefined || options.args === undefined
      ? {}
      : { command: { script: options.script, args: [...options.args] } }),
  };
}
