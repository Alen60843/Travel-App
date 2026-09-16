import type { MemoryEntry, MemoryQuery } from '../memory/types';
import { buildMemoryGraph } from './graph';
import type { MemoryReader, RelevantMemoryQuery, RelevantMemoryResult } from './types';

function entriesOfKind<K extends MemoryEntry['kind']>(entries: readonly MemoryEntry[], kind: K): readonly Extract<MemoryEntry, { readonly kind: K }>[] {
  return entries.filter((entry): entry is Extract<MemoryEntry, { readonly kind: K }> => entry.kind === kind);
}

/** Loads one bounded exact Memory Foundation query and returns structured graph facts. */
export async function getRelevantMemory(
  reader: MemoryReader,
  query: RelevantMemoryQuery,
): Promise<RelevantMemoryResult> {
  const memoryQuery: MemoryQuery = {
    subject: query.subject,
    ...(query.runId === undefined ? {} : { runId: query.runId }),
    ...(query.taskId === undefined ? {} : { taskId: query.taskId }),
  };
  const entries = [...await reader.listMemory(memoryQuery)]
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const graph = buildMemoryGraph(entries);
  return {
    ...graph,
    subject: query.subject,
    ...(query.runId === undefined ? {} : { runId: query.runId }),
    ...(query.taskId === undefined ? {} : { taskId: query.taskId }),
    failures: entriesOfKind(entries, 'FAILURE'),
    actionCandidates: entriesOfKind(entries, 'ACTION_CANDIDATE'),
    outcomes: entriesOfKind(entries, 'OUTCOME'),
    decisions: entriesOfKind(entries, 'DECISION'),
    invariants: entriesOfKind(entries, 'INVARIANT'),
  };
}
