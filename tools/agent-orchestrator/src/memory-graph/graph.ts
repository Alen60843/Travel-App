import { canonicalJson } from '../canonical-json';
import { OrchestratorError } from '../errors';
import type { MemoryEntry, MemorySubject } from '../memory/types';
import { MEMORY_GRAPH_RELATIONS, type MemoryGraph, type MemoryGraphEdge,
  type MemoryNodeRef } from './types';

function corrupt(message: string): never {
  throw new OrchestratorError('STATE_CORRUPT', `Memory graph: ${message}`);
}

function memory(memoryId: string): MemoryNodeRef {
  return { kind: 'memory', memoryId };
}

function subject(value: MemorySubject): MemoryNodeRef {
  return { kind: 'subject', subject: value };
}

function sameSubject(left: MemorySubject, right: MemorySubject): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNodes(left: MemoryNodeRef, right: MemoryNodeRef): number {
  return compareText(canonicalJson(left), canonicalJson(right));
}

function compareEdges(left: MemoryGraphEdge, right: MemoryGraphEdge): number {
  return compareNodes(left.source, right.source)
    || MEMORY_GRAPH_RELATIONS.indexOf(left.relation) - MEMORY_GRAPH_RELATIONS.indexOf(right.relation)
    || compareNodes(left.target, right.target);
}

/** Pure deterministic projection of immutable Memory facts into direct typed relations. */
export function buildMemoryGraph(entries: readonly MemoryEntry[]): MemoryGraph {
  const byId = new Map<string, MemoryEntry>();
  for (const entry of entries) {
    const existing = byId.get(entry.id);
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(entry)) {
      corrupt(`memory ID ${entry.id} has conflicting entries`);
    }
    byId.set(entry.id, entry);
  }

  const nodes = new Map<string, MemoryNodeRef>();
  const edges = new Map<string, MemoryGraphEdge>();
  const addNode = (node: MemoryNodeRef): void => { nodes.set(canonicalJson(node), node); };
  const addEdge = (edge: MemoryGraphEdge): void => {
    addNode(edge.source);
    addNode(edge.target);
    edges.set(canonicalJson(edge), edge);
  };

  for (const entry of [...byId.values()].sort((left, right) => compareText(left.id, right.id))) {
    const entryNode = memory(entry.id);
    addNode(entryNode);
    addNode(subject(entry.subject));
    if (entry.provenance.runId !== undefined) addNode({ kind: 'run', runId: entry.provenance.runId });

    if (entry.kind === 'FAILURE') {
      addEdge({ relation: 'AFFECTED', source: entryNode, target: subject(entry.subject) });
      if (entry.provenance.runId !== undefined) {
        addEdge({ relation: 'OCCURRED_IN', source: entryNode,
          target: { kind: 'run', runId: entry.provenance.runId } });
      }
      continue;
    }

    if (entry.kind === 'ACTION_CANDIDATE') {
      const referencedId = entry.data.sourceFailureMemoryId;
      const target = byId.get(referencedId);
      if (target === undefined) corrupt(`action ${entry.id} references missing failure ${referencedId}`);
      if (target.kind !== 'FAILURE') {
        corrupt(`action ${entry.id} references ${referencedId}, which is not a FAILURE`);
      }
      if (!sameSubject(entry.subject, target.subject)) {
        corrupt(`action ${entry.id} and failure ${referencedId} have incompatible subjects`);
      }
      if (entry.data.basisClassification !== target.data.classification) {
        corrupt(`action ${entry.id} and failure ${referencedId} have incompatible classifications`);
      }
      addEdge({ relation: 'CANDIDATE_ACTION', source: memory(referencedId), target: entryNode });
      continue;
    }

    if (entry.kind === 'OUTCOME') {
      const referencedId = entry.data.sourceActionMemoryId;
      const target = byId.get(referencedId);
      if (target === undefined) corrupt(`outcome ${entry.id} references missing action ${referencedId}`);
      if (target.kind !== 'ACTION_CANDIDATE') {
        corrupt(`outcome ${entry.id} references ${referencedId}, which is not an ACTION_CANDIDATE`);
      }
      if (!sameSubject(entry.subject, target.subject)) {
        corrupt(`outcome ${entry.id} and action ${referencedId} have incompatible subjects`);
      }
      addEdge({ relation: 'OUTCOME', source: memory(referencedId), target: entryNode });
      continue;
    }

    if (entry.kind === 'DECISION' || entry.kind === 'INVARIANT') {
      addEdge({ relation: 'ABOUT', source: entryNode, target: subject(entry.subject) });
      continue;
    }

    const unsupported: never = entry;
    void unsupported;
    corrupt('unsupported Memory kind');
  }

  return {
    version: 1,
    nodes: [...nodes.values()].sort(compareNodes),
    edges: [...edges.values()].sort(compareEdges),
  };
}
