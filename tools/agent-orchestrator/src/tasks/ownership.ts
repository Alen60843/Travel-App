import { OrchestratorError } from '../errors';
import { TaskGraph } from './scheduler';
import type { TaskSpec } from './task-schema';

export interface OwnershipOverlap {
  readonly leftTaskId: string;
  readonly rightTaskId: string;
  readonly leftPattern: string;
  readonly rightPattern: string;
}

export interface OwnershipValidation {
  readonly changedFiles: readonly string[];
  readonly violations: readonly string[];
}

export function normalizeRepositoryPath(path: string): string {
  if (
    path.length === 0 ||
    path.includes('\0') ||
    path.includes('\\') ||
    path.startsWith('/') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new OrchestratorError(
      'OWNERSHIP_VIOLATION',
      `Unsafe repository path: ${JSON.stringify(path)}`,
      { details: { path } },
    );
  }
  return path;
}

function normalizePattern(pattern: string): string[] {
  const normalized = normalizeRepositoryPath(pattern);
  if (normalized.startsWith('!')) {
    throw new OrchestratorError(
      'CONFIG_INVALID',
      `Negative ownership globs are not supported: ${pattern}`,
    );
  }
  return normalized.split('/');
}

function segmentMatches(pattern: string, value: string): boolean {
  let expression = '^';
  for (const character of pattern) {
    if (character === '*') {
      expression += '.*';
    } else if (character === '?') {
      expression += '.';
    } else {
      expression += character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    }
  }
  expression += '$';
  return new RegExp(expression, 'u').test(value);
}

/** Match repository-relative paths. `*` is segment-local and `**` spans segments. */
export function matchesOwnershipPattern(path: string, pattern: string): boolean {
  const pathSegments = normalizeRepositoryPath(path).split('/');
  const patternSegments = normalizePattern(pattern);
  const memo = new Map<string, boolean>();
  const match = (patternIndex: number, pathIndex: number): boolean => {
    const key = `${patternIndex}:${pathIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let result: boolean;
    if (patternIndex === patternSegments.length) {
      result = pathIndex === pathSegments.length;
    } else if (patternSegments[patternIndex] === '**') {
      result =
        match(patternIndex + 1, pathIndex) ||
        (pathIndex < pathSegments.length && match(patternIndex, pathIndex + 1));
    } else {
      const segment = patternSegments[patternIndex];
      const value = pathSegments[pathIndex];
      result =
        segment !== undefined &&
        value !== undefined &&
        segmentMatches(segment, value) &&
        match(patternIndex + 1, pathIndex + 1);
    }
    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}

/**
 * Determines whether two glob languages can contain the same path. Supported
 * glob syntax intentionally stays small: literal characters, `?`, `*`, `**`.
 */
export function ownershipGlobsOverlap(left: string, right: string): boolean {
  const leftSegments = normalizePattern(left);
  const rightSegments = normalizePattern(right);
  const segmentMemo = new Map<string, boolean>();

  const segmentsOverlap = (a: string, b: string): boolean => {
    const memo = new Map<string, boolean>();
    const visit = (i: number, j: number): boolean => {
      const key = `${i}:${j}`;
      const cached = memo.get(key);
      if (cached !== undefined) {
        return cached;
      }
      // Set pessimistically before recursion; recursive paths always advance at
      // least one side, but this also protects future syntax extensions.
      memo.set(key, false);
      let result: boolean;
      if (i === a.length || j === b.length) {
        result =
          (i === a.length && [...b.slice(j)].every((char) => char === '*')) ||
          (j === b.length && [...a.slice(i)].every((char) => char === '*'));
      } else {
        const ac = a[i];
        const bc = b[j];
        if (ac === '*') {
          result = visit(i + 1, j) || (bc === '*' ? visit(i, j + 1) : visit(i, j + 1));
        } else if (bc === '*') {
          result = visit(i, j + 1) || visit(i + 1, j);
        } else {
          result = (ac === '?' || bc === '?' || ac === bc) && visit(i + 1, j + 1);
        }
      }
      memo.set(key, result);
      return result;
    };
    return visit(0, 0);
  };

  const visit = (i: number, j: number): boolean => {
    const key = `${i}:${j}`;
    const cached = segmentMemo.get(key);
    if (cached !== undefined) {
      return cached;
    }
    segmentMemo.set(key, false);
    let result: boolean;
    if (i === leftSegments.length && j === rightSegments.length) {
      result = true;
    } else if (i === leftSegments.length) {
      result = rightSegments.slice(j).every((segment) => segment === '**');
    } else if (j === rightSegments.length) {
      result = leftSegments.slice(i).every((segment) => segment === '**');
    } else {
      const a = leftSegments[i];
      const b = rightSegments[j];
      if (a === '**') {
        result = visit(i + 1, j) || visit(i, j + 1);
      } else if (b === '**') {
        result = visit(i, j + 1) || visit(i + 1, j);
      } else {
        result =
          a !== undefined &&
          b !== undefined &&
          segmentsOverlap(a, b) &&
          visit(i + 1, j + 1);
      }
    }
    segmentMemo.set(key, result);
    return result;
  };

  return visit(0, 0);
}

export function findParallelOwnershipOverlaps(
  tasks: readonly TaskSpec[],
): OwnershipOverlap[] {
  const graph = new TaskGraph(tasks);
  const writers = tasks.filter((task) => task.writer);
  const overlaps: OwnershipOverlap[] = [];
  for (let leftIndex = 0; leftIndex < writers.length; leftIndex += 1) {
    const left = writers[leftIndex];
    if (left === undefined) {
      continue;
    }
    for (let rightIndex = leftIndex + 1; rightIndex < writers.length; rightIndex += 1) {
      const right = writers[rightIndex];
      if (right === undefined) {
        continue;
      }
      // A dependency path serializes the writers, so correction tasks may own
      // the same files as the implementation they correct.
      if (
        graph.hasDependencyPath(left.id, right.id) ||
        graph.hasDependencyPath(right.id, left.id)
      ) {
        continue;
      }
      for (const leftPattern of left.files) {
        for (const rightPattern of right.files) {
          if (ownershipGlobsOverlap(leftPattern, rightPattern)) {
            overlaps.push({
              leftTaskId: left.id,
              rightTaskId: right.id,
              leftPattern,
              rightPattern,
            });
          }
        }
      }
    }
  }
  return overlaps;
}

export function assertNoParallelOwnershipOverlap(tasks: readonly TaskSpec[]): void {
  const overlaps = findParallelOwnershipOverlaps(tasks);
  if (overlaps.length > 0) {
    throw new OrchestratorError(
      'OWNERSHIP_OVERLAP',
      `Parallel writer ownership overlaps (${overlaps.length})`,
      { details: { overlaps } },
    );
  }
}

export function validateChangedFileOwnership(
  changedFiles: readonly string[],
  allowedPatterns: readonly string[],
): OwnershipValidation {
  const normalized = [...new Set(changedFiles.map(normalizeRepositoryPath))].sort();
  const violations = normalized.filter(
    (path) => !allowedPatterns.some((pattern) => matchesOwnershipPattern(path, pattern)),
  );
  return { changedFiles: normalized, violations };
}

export function assertChangedFileOwnership(
  taskId: string,
  changedFiles: readonly string[],
  allowedPatterns: readonly string[],
): void {
  const result = validateChangedFileOwnership(changedFiles, allowedPatterns);
  if (result.violations.length > 0) {
    throw new OrchestratorError(
      'OWNERSHIP_VIOLATION',
      `Task ${taskId} modified files outside its ownership`,
      {
        details: {
          taskId,
          allowedPatterns,
          violations: result.violations,
        },
      },
    );
  }
}
