import { OrchestratorError } from '../errors';
import type { StructuredHandoff } from './schemas';

export interface RequiredCanonicalFinding {
  readonly findingId: string;
  readonly canonicalFindingKey: string;
  readonly sourceWorkUnitId: string;
  readonly artifactPath: string;
  readonly finding?: unknown;
}

/** Context-sensitive validation: generic handoffs deliberately remain unchanged. */
export function validateCanonicalFindingResponses(
  handoff: StructuredHandoff,
  required: readonly RequiredCanonicalFinding[],
): void {
  if (required.length === 0) return;
  const requiredIds = new Set(required.map((item) => item.findingId));
  if (requiredIds.size !== required.length) {
    throw invalid('canonical finding assignment contains duplicate IDs');
  }
  const responses = handoff.findingResponses ?? [];
  const unknown = responses.find((response) => !requiredIds.has(response.findingId));
  if (unknown !== undefined) {
    throw invalid(`response ${unknown.findingId} does not belong to this task's canonical assignment`);
  }
  const answered = new Set(responses.map((response) => response.findingId));
  const missing = required.filter((item) => !answered.has(item.findingId)).map((item) => item.findingId);
  if (missing.length > 0) {
    throw invalid(`canonical finding response required for: ${missing.join(', ')}`);
  }
  for (const response of responses) {
    const assignment = required.find((item) => item.findingId === response.findingId)!;
    if (response.canonicalFindingKey !== assignment.canonicalFindingKey) {
      throw invalid(`${response.findingId} response does not match assigned canonical provenance`);
    }
    if (response.resolution === undefined) {
      throw invalid(`${response.findingId} requires a strict resolution`);
    }
    if (response.decision === 'rejected') {
      if (response.resolution !== 'not_applicable') {
        throw invalid(`${response.findingId} rejected responses must use not_applicable`);
      }
      if (response.reason === undefined || response.evidence.trim() === '') {
        throw invalid(`${response.findingId} rejected responses require reason and evidence`);
      }
    } else {
      if (response.resolution === 'not_applicable') {
        throw invalid(`${response.findingId} confirmed responses cannot use not_applicable`);
      }
      if (response.resolution === 'resolved'
        && (response.evidence.trim() === '' || response.fix === undefined || response.verification === undefined)) {
        throw invalid(`${response.findingId} confirmed/resolved responses require evidence, fix, and verification`);
      }
    }
  }
  if (handoff.status === 'complete' && missing.length > 0) {
    throw invalid('complete handoff contains unanswered canonical findings');
  }
}

function invalid(message: string): OrchestratorError {
  return new OrchestratorError('HANDOFF_INVALID', message, {
    details: { contract: 'canonical_finding_response' },
  });
}
