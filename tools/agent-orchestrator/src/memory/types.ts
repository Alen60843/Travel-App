import type { ActionId } from '../action-mapping/types';
import type { FailureClassification, FailureVariant } from '../failure-intelligence/types';

export const MEMORY_KINDS = [
  'FAILURE',
  'ACTION_CANDIDATE',
  'OUTCOME',
  'DECISION',
  'INVARIANT',
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

export type MemorySubject =
  | { readonly kind: 'run' }
  | { readonly kind: 'task'; readonly taskId: string }
  | { readonly kind: 'integration' };

export type JsonValue = null | boolean | number | string | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface MemoryProvenance {
  readonly sourceKind: 'failure_diagnosis' | 'action_mapping' | 'outcome'
    | 'trusted_decision' | 'trusted_invariant';
  readonly producerVersion: 1;
  readonly runId?: string;
  readonly taskId?: string;
  readonly references: readonly string[];
}

interface MemoryEntryBodyBase<K extends MemoryKind, D> {
  readonly version: 1;
  readonly kind: K;
  readonly subject: MemorySubject;
  readonly data: D;
  readonly provenance: MemoryProvenance;
}

export type FailureMemoryBody = MemoryEntryBodyBase<'FAILURE', {
  readonly diagnosisVersion: 1;
  readonly classification: FailureClassification;
  readonly variant?: FailureVariant;
  readonly agent?: 'codex' | 'claude';
}>;

export type ActionCandidateMemoryBody = MemoryEntryBodyBase<'ACTION_CANDIDATE', {
  readonly actionVersion: 1;
  readonly actionId: ActionId;
  readonly mutatesState: boolean;
  readonly execution: 'manual';
  readonly authority: { readonly kind: 'human'; readonly required: boolean };
  readonly basisClassification: FailureClassification;
  readonly sourceFailureMemoryId: string;
}>;

export type OutcomeMemoryBody = MemoryEntryBodyBase<'OUTCOME', {
  readonly sourceActionMemoryId: string;
  readonly status: 'succeeded' | 'failed' | 'blocked' | 'cancelled';
  readonly resultCode?: string;
}>;

export type DecisionMemoryBody = MemoryEntryBodyBase<'DECISION', {
  readonly key: string;
  readonly value: JsonValue;
  readonly rationale: string;
}>;

export type InvariantMemoryBody = MemoryEntryBodyBase<'INVARIANT', {
  readonly key: string;
  readonly rule: JsonValue;
  readonly rationale?: string;
}>;

export type MemoryEntryBody = FailureMemoryBody | ActionCandidateMemoryBody
  | OutcomeMemoryBody | DecisionMemoryBody | InvariantMemoryBody;

export type MemoryEntry = MemoryEntryBody & { readonly id: string };

export interface MemoryQuery {
  readonly kind?: MemoryKind;
  readonly subject?: MemorySubject;
  readonly runId?: string;
  readonly taskId?: string;
}
