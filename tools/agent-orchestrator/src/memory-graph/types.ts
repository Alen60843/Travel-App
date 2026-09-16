import type { MemoryEntry, MemoryQuery, MemorySubject } from '../memory/types';

export const MEMORY_GRAPH_RELATIONS = [
  'AFFECTED',
  'OCCURRED_IN',
  'CANDIDATE_ACTION',
  'OUTCOME',
  'ABOUT',
] as const;

export type MemoryGraphRelation = (typeof MEMORY_GRAPH_RELATIONS)[number];

export type MemoryNodeRef =
  | { readonly kind: 'memory'; readonly memoryId: string }
  | { readonly kind: 'subject'; readonly subject: MemorySubject }
  | { readonly kind: 'run'; readonly runId: string };

export interface MemoryGraphEdge {
  readonly relation: MemoryGraphRelation;
  readonly source: MemoryNodeRef;
  readonly target: MemoryNodeRef;
}

export interface MemoryGraph {
  readonly version: 1;
  readonly nodes: readonly MemoryNodeRef[];
  readonly edges: readonly MemoryGraphEdge[];
}

/** Minimal read boundary. MemoryStore satisfies this interface structurally. */
export interface MemoryReader {
  getMemory(id: string): Promise<MemoryEntry | undefined>;
  listMemory(query?: MemoryQuery): Promise<readonly MemoryEntry[]>;
}

export interface RelevantMemoryQuery {
  readonly subject: MemorySubject;
  readonly runId?: string;
  readonly taskId?: string;
}

export interface RelevantMemoryResult extends MemoryGraph {
  readonly subject: MemorySubject;
  readonly runId?: string;
  readonly taskId?: string;
  readonly failures: readonly Extract<MemoryEntry, { readonly kind: 'FAILURE' }>[];
  readonly actionCandidates: readonly Extract<MemoryEntry, { readonly kind: 'ACTION_CANDIDATE' }>[];
  readonly outcomes: readonly Extract<MemoryEntry, { readonly kind: 'OUTCOME' }>[];
  readonly decisions: readonly Extract<MemoryEntry, { readonly kind: 'DECISION' }>[];
  readonly invariants: readonly Extract<MemoryEntry, { readonly kind: 'INVARIANT' }>[];
}
