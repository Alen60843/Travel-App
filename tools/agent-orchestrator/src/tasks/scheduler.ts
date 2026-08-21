import { OrchestratorError } from '../errors';
import type { TaskSpec } from './task-schema';

export const TASK_STATUSES = [
  'PENDING',
  'READY',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'BLOCKED',
  'CANCELLED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

const TERMINAL_STATUSES = new Set<TaskStatus>([
  'SUCCEEDED',
  'FAILED',
  'BLOCKED',
  'CANCELLED',
]);

export class TaskGraph {
  readonly tasks: readonly TaskSpec[];
  private readonly byId: ReadonlyMap<string, TaskSpec>;
  private readonly inputOrder: ReadonlyMap<string, number>;

  constructor(tasks: readonly TaskSpec[]) {
    this.tasks = [...tasks];
    const byId = new Map<string, TaskSpec>();
    const inputOrder = new Map<string, number>();
    tasks.forEach((task, index) => {
      if (byId.has(task.id)) {
        throw new OrchestratorError(
          'CONFIG_INVALID',
          `Duplicate task id: ${task.id}`,
          { details: { taskId: task.id } },
        );
      }
      byId.set(task.id, task);
      inputOrder.set(task.id, index);
    });
    for (const task of tasks) {
      for (const dependency of task.dependsOn) {
        if (!byId.has(dependency)) {
          throw new OrchestratorError(
            'CONFIG_INVALID',
            `Task ${task.id} depends on unknown task ${dependency}`,
            { details: { taskId: task.id, dependency } },
          );
        }
      }
    }
    this.byId = byId;
    this.inputOrder = inputOrder;
    this.assertAcyclic();
  }

  get(taskId: string): TaskSpec {
    const task = this.byId.get(taskId);
    if (task === undefined) {
      throw new OrchestratorError('CONFIG_INVALID', `Unknown task: ${taskId}`, {
        details: { taskId },
      });
    }
    return task;
  }

  hasDependencyPath(taskId: string, possibleAncestorId: string): boolean {
    const visited = new Set<string>();
    const visit = (currentId: string): boolean => {
      if (visited.has(currentId)) {
        return false;
      }
      visited.add(currentId);
      for (const dependency of this.get(currentId).dependsOn) {
        if (dependency === possibleAncestorId || visit(dependency)) {
          return true;
        }
      }
      return false;
    };
    return visit(taskId);
  }

  topologicalOrder(): TaskSpec[] {
    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const task of this.tasks) {
      indegree.set(task.id, task.dependsOn.length);
      for (const dependency of task.dependsOn) {
        const entries = dependents.get(dependency) ?? [];
        entries.push(task.id);
        dependents.set(dependency, entries);
      }
    }
    const ready = this.tasks
      .filter((task) => task.dependsOn.length === 0)
      .map((task) => task.id);
    const result: TaskSpec[] = [];
    while (ready.length > 0) {
      ready.sort((left, right) =>
        (this.inputOrder.get(left) ?? 0) - (this.inputOrder.get(right) ?? 0),
      );
      const id = ready.shift();
      if (id === undefined) {
        break;
      }
      result.push(this.get(id));
      for (const dependent of dependents.get(id) ?? []) {
        const next = (indegree.get(dependent) ?? 0) - 1;
        indegree.set(dependent, next);
        if (next === 0) {
          ready.push(dependent);
        }
      }
    }
    if (result.length !== this.tasks.length) {
      this.throwCycle();
    }
    return result;
  }

  executionWaves(concurrency = Number.POSITIVE_INFINITY): TaskSpec[][] {
    if (!(concurrency > 0)) {
      throw new OrchestratorError('CONFIG_INVALID', 'Concurrency must be positive');
    }
    const completed = new Set<string>();
    const remaining = new Set(this.tasks.map((task) => task.id));
    const waves: TaskSpec[][] = [];
    while (remaining.size > 0) {
      const ready = this.tasks.filter(
        (task) =>
          remaining.has(task.id) &&
          task.dependsOn.every((dependency) => completed.has(dependency)),
      );
      if (ready.length === 0) {
        this.throwCycle();
      }
      for (let offset = 0; offset < ready.length; offset += concurrency) {
        const wave = ready.slice(offset, offset + concurrency);
        waves.push(wave);
        for (const task of wave) {
          remaining.delete(task.id);
          completed.add(task.id);
        }
      }
    }
    return waves;
  }

  private assertAcyclic(): void {
    this.topologicalOrder();
  }

  private throwCycle(): never {
    const white = new Set(this.tasks.map((task) => task.id));
    const gray = new Set<string>();
    const stack: string[] = [];
    const visit = (taskId: string): string[] | undefined => {
      white.delete(taskId);
      gray.add(taskId);
      stack.push(taskId);
      for (const dependency of this.get(taskId).dependsOn) {
        if (gray.has(dependency)) {
          const start = stack.indexOf(dependency);
          return [...stack.slice(start), dependency];
        }
        if (white.has(dependency)) {
          const cycle = visit(dependency);
          if (cycle !== undefined) {
            return cycle;
          }
        }
      }
      stack.pop();
      gray.delete(taskId);
      return undefined;
    };
    for (const task of this.tasks) {
      if (white.has(task.id)) {
        const cycle = visit(task.id);
        if (cycle !== undefined) {
          throw new OrchestratorError(
            'DAG_CYCLE',
            `Task dependency cycle: ${cycle.join(' -> ')}`,
            { details: { cycle } },
          );
        }
      }
    }
    throw new OrchestratorError('DAG_CYCLE', 'Task dependency graph contains a cycle');
  }
}

const TRANSITIONS: Readonly<Record<TaskStatus, ReadonlySet<TaskStatus>>> = {
  PENDING: new Set(['READY', 'BLOCKED', 'CANCELLED']),
  READY: new Set(['RUNNING', 'BLOCKED', 'CANCELLED']),
  RUNNING: new Set(['SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED']),
  SUCCEEDED: new Set(),
  FAILED: new Set(['READY', 'BLOCKED', 'CANCELLED']),
  BLOCKED: new Set(),
  CANCELLED: new Set(),
};

/** In-memory scheduling primitive. Persistence remains the caller's responsibility. */
export class TaskScheduler {
  readonly graph: TaskGraph;
  readonly concurrency: number;
  private readonly states = new Map<string, TaskStatus>();

  constructor(
    tasks: readonly TaskSpec[],
    concurrency: number,
    initialStates: Readonly<Record<string, TaskStatus>> = {},
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new OrchestratorError('CONFIG_INVALID', 'Concurrency must be a positive integer');
    }
    this.graph = new TaskGraph(tasks);
    this.concurrency = concurrency;
    for (const task of tasks) {
      this.states.set(task.id, initialStates[task.id] ?? 'PENDING');
    }
    this.refreshWaitingTasks();
  }

  snapshot(): Record<string, TaskStatus> {
    return Object.fromEntries(this.states);
  }

  status(taskId: string): TaskStatus {
    this.graph.get(taskId);
    return this.states.get(taskId) ?? 'PENDING';
  }

  claimReady(): TaskSpec[] {
    this.refreshWaitingTasks();
    const running = [...this.states.values()].filter((state) => state === 'RUNNING').length;
    const capacity = Math.max(0, this.concurrency - running);
    const ready = this.graph.tasks
      .filter((task) => this.status(task.id) === 'READY')
      .slice(0, capacity);
    for (const task of ready) {
      this.transition(task.id, 'RUNNING');
    }
    return ready;
  }

  transition(taskId: string, next: TaskStatus): void {
    const current = this.status(taskId);
    if (current === next) {
      return;
    }
    if (!TRANSITIONS[current].has(next)) {
      throw new OrchestratorError(
        'TASK_STATE_INVALID',
        `Invalid task transition ${taskId}: ${current} -> ${next}`,
        { details: { taskId, current, next } },
      );
    }
    this.states.set(taskId, next);
    this.refreshWaitingTasks();
  }

  isFinished(): boolean {
    return [...this.states.values()].every((status) => TERMINAL_STATUSES.has(status));
  }

  private refreshWaitingTasks(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of this.graph.tasks) {
        const current = this.states.get(task.id) ?? 'PENDING';
        if (current !== 'PENDING') {
          continue;
        }
        const dependencies = task.dependsOn.map(
          (dependency) => this.states.get(dependency) ?? 'PENDING',
        );
        if (dependencies.some((status) => ['FAILED', 'BLOCKED', 'CANCELLED'].includes(status))) {
          this.states.set(task.id, 'BLOCKED');
          changed = true;
        } else if (dependencies.every((status) => status === 'SUCCEEDED')) {
          this.states.set(task.id, 'READY');
          changed = true;
        }
      }
    }
  }
}

export function computeExecutionWaves(
  tasks: readonly TaskSpec[],
  concurrency = Number.POSITIVE_INFINITY,
): TaskSpec[][] {
  return new TaskGraph(tasks).executionWaves(concurrency);
}

export function assertReviewRoundAllowed(
  completedRounds: number,
  maxReviewRounds: number,
): void {
  if (completedRounds >= maxReviewRounds) {
    throw new OrchestratorError(
      'BLOCKED_FOR_HUMAN_REVIEW',
      `Maximum review rounds reached (${maxReviewRounds})`,
      { details: { completedRounds, maxReviewRounds } },
    );
  }
}
