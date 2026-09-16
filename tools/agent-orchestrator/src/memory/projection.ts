import type { ActionCandidate } from '../action-mapping/types';
import type { FailureDiagnosis } from '../failure-intelligence/types';
import { createMemoryEntry } from './entry';
import type { ActionCandidateMemoryBody, FailureMemoryBody, MemoryEntry, MemorySubject } from './types';

function subjectOf(diagnosis: FailureDiagnosis): MemorySubject {
  if (diagnosis.subject.kind === 'task') {
    if (diagnosis.subject.taskId === undefined) throw new TypeError('Diagnosed task subject is missing taskId');
    return { kind: 'task', taskId: diagnosis.subject.taskId };
  }
  if (diagnosis.subject.kind === 'integration') return { kind: 'integration' };
  return { kind: 'run' };
}

/** Pure projection of already-proven diagnosis/action facts. Performs no I/O or revalidation. */
export function projectDiagnosisToMemory(
  diagnosis: FailureDiagnosis,
  actions: readonly ActionCandidate[],
): readonly MemoryEntry[] {
  if (diagnosis.status !== 'diagnosed' || diagnosis.classification === undefined) return [];
  const subject = subjectOf(diagnosis);
  const taskId = subject.kind === 'task' ? subject.taskId : undefined;
  const references = diagnosis.evidence.map((entry) => entry.reference);
  const failureBody: FailureMemoryBody = {
    version: 1,
    kind: 'FAILURE',
    subject,
    data: {
      diagnosisVersion: diagnosis.version,
      classification: diagnosis.classification,
      ...(diagnosis.variant === undefined ? {} : { variant: diagnosis.variant }),
      ...(diagnosis.agent === undefined ? {} : { agent: diagnosis.agent }),
    },
    provenance: {
      sourceKind: 'failure_diagnosis',
      producerVersion: 1,
      runId: diagnosis.runId,
      ...(taskId === undefined ? {} : { taskId }),
      references,
    },
  };
  const failure = createMemoryEntry(failureBody);
  const actionEntries = actions.map((action) => {
    if (JSON.stringify(action.subject) !== JSON.stringify(diagnosis.subject)
      || action.basis.classification !== diagnosis.classification
      || JSON.stringify(action.basis.evidenceReferences) !== JSON.stringify(references)) {
      throw new TypeError('Action candidate does not belong to the supplied failure diagnosis');
    }
    const body: ActionCandidateMemoryBody = {
      version: 1,
      kind: 'ACTION_CANDIDATE',
      subject,
      data: {
        actionVersion: action.version,
        actionId: action.id,
        mutatesState: action.mutatesState,
        execution: action.execution,
        authority: { ...action.authority },
        basisClassification: action.basis.classification,
        sourceFailureMemoryId: failure.id,
      },
      provenance: {
        sourceKind: 'action_mapping',
        producerVersion: 1,
        runId: diagnosis.runId,
        ...(taskId === undefined ? {} : { taskId }),
        references: [...action.basis.evidenceReferences],
      },
    };
    return createMemoryEntry(body);
  });
  return [failure, ...actionEntries];
}
