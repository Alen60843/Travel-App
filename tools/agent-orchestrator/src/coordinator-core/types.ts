import type { ActionId } from '../action-mapping/types';
import type {
  ContextActionCandidate,
  ContextBundle,
  ContextLimitExceeded,
  ContextScope,
} from '../context-builder/types';

export const MAX_COORDINATOR_REASON_BYTES = 2_000;
export const MAX_COORDINATOR_REFERENCES = 16;
export const MAX_COORDINATOR_REFERENCE_BYTES = 2_000;

export type CoordinatorReference =
  | { readonly kind: 'current_evidence'; readonly reference: string }
  | { readonly kind: 'memory'; readonly memoryId: string }
  | { readonly kind: 'repository_hint'; readonly path: string };

interface CoordinatorProposalBase {
  readonly version: 1;
  readonly reason: string;
  readonly supportingReferences: readonly CoordinatorReference[];
}

export type CoordinatorProposal =
  | (CoordinatorProposalBase & { readonly decision: 'no_action' })
  | (CoordinatorProposalBase & {
    readonly decision: 'select_action';
    readonly actionId: ActionId;
  })
  | (CoordinatorProposalBase & { readonly decision: 'human_required' });

interface CoordinatorDecisionBase {
  readonly version: 1;
  readonly scope: ContextScope;
  readonly reason: string;
  readonly supportingReferences: readonly CoordinatorReference[];
}

export type CoordinatorDecision =
  | (CoordinatorDecisionBase & { readonly kind: 'NO_ACTION' })
  | (CoordinatorDecisionBase & {
    readonly kind: 'SELECT_ACTION';
    readonly selectedAction: ContextActionCandidate;
  })
  | (CoordinatorDecisionBase & { readonly kind: 'HUMAN_REQUIRED' });

export interface CoordinatorReasoner {
  propose(context: ContextBundle): Promise<unknown>;
}

export type CoordinatorResult =
  | {
    readonly version: 1;
    readonly status: 'decided';
    readonly decision: CoordinatorDecision;
  }
  | {
    readonly version: 1;
    readonly status: 'context_unavailable';
    readonly scope: ContextScope;
    readonly reason: 'limit_exceeded';
    readonly limit: ContextLimitExceeded['limit'];
  }
  | {
    readonly version: 1;
    readonly status: 'reasoner_failed';
    readonly scope: ContextScope;
    readonly code: 'REASONER_ERROR' | 'PROPOSAL_INVALID';
  };
