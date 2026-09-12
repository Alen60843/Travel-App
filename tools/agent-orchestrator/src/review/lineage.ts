import { TaskGraph } from '../tasks/scheduler';
import type { TaskSpec } from '../tasks/task-schema';

export const REVIEW_MODES = new Set(['review', 'synthesis', 'final_review']);

/**
 * Count successful review ancestors in this review/correction lineage.
 * Explicit reviewOf links select a lineage. Non-review dependency edges carry
 * lineages through corrections and other intermediate tasks. Implementation
 * starts new work and does not carry an upstream review lineage across that
 * boundary. An unlinked review always starts a fresh review budget.
 */
export function completedReviewRounds(
  task: TaskSpec,
  graph: TaskGraph,
  succeeded: (taskId: string) => boolean,
): number {
  const roots = new Map<string, ReadonlySet<string>>();
  for (const candidate of graph.topologicalOrder()) {
    const inherited = new Set<string>();
    const review = REVIEW_MODES.has(candidate.mode);
    if (candidate.mode !== 'implementation' && (!review || candidate.condition !== undefined)) {
      const sources = candidate.condition === undefined ? candidate.dependsOn : [candidate.condition.reviewOf];
      for (const source of sources) {
        for (const root of roots.get(source)!) inherited.add(root);
      }
    }
    if (review && candidate.condition === undefined) inherited.add(candidate.id);
    roots.set(candidate.id, inherited);
  }
  const lineage = roots.get(task.id)!;
  return graph.tasks.filter((candidate) =>
    REVIEW_MODES.has(candidate.mode)
    && succeeded(candidate.id)
    && graph.hasDependencyPath(task.id, candidate.id)
    && [...roots.get(candidate.id)!].some((root) => lineage.has(root)),
  ).length;
}
