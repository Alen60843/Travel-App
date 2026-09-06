import { join, resolve } from 'node:path';
import { GitClient, resolveBaseSha } from '../git';
import type { PhaseConfig } from '../config';
import type { TaskSpec, TaskMode } from '../tasks';
import { AdaptiveCoordinator, type Clock } from './coordinator';
import { loadAdaptivePhaseConfig, type AdaptiveExecutorConfig, type AdaptivePhaseConfig } from './phase-config';
import { EvidenceDrivenPlanner } from './planner';
import { DeterministicCapabilityRouter, StaticCapabilityCatalog } from './router';
import type { AdaptiveRunState, DynamicWorkUnit, RouteCandidate, WorkRequest } from './types';
import {
  correctionDraftForImportedFinding,
  loadCanonicalContinuation,
  type LoadedCanonicalContinuation,
} from './continuation';

export interface AdaptivePlanResult {
  readonly strategy: 'adaptive';
  readonly repositoryRoot: string;
  readonly config: AdaptivePhaseConfig;
  readonly baseSha: string;
  readonly preview: AdaptiveRunState;
  readonly maximumPossibleConcurrency: number;
}

export interface AdaptivePlanOptions {
  readonly repositoryPath: string;
  readonly runsRoot?: string;
  readonly git?: GitClient;
  readonly clock?: () => Date;
}

export function executorCandidates(config: AdaptivePhaseConfig): RouteCandidate[] {
  return config.executors.map((executor) => ({
    executorId: executor.id,
    capabilities: executor.capabilities,
    available: executor.available,
    roles: executor.roles,
  }));
}

export function capabilityCatalog(config: AdaptivePhaseConfig): StaticCapabilityCatalog {
  return new StaticCapabilityCatalog(executorCandidates(config));
}

export function buildAdaptiveCoordinator(
  config: AdaptivePhaseConfig,
  clock: Clock,
  continuation?: LoadedCanonicalContinuation,
): AdaptiveCoordinator {
  const created = AdaptiveCoordinator.create(config.goal, config.policy, clock).snapshot();
  const initial = continuation === undefined ? created : {
    ...created,
    continuation: continuation.state,
    updatedAt: continuation.state.importedAt,
    events: [{
      sequence: 1,
      type: 'CANONICAL_FINDINGS_IMPORTED' as const,
      occurredAt: continuation.state.importedAt,
      detail: `${continuation.state.findings.length} finding(s) imported from ${continuation.state.sourceRunId}/${continuation.state.sourceWorkUnitId}`,
    }],
  };
  const coordinator = new AdaptiveCoordinator(
    initial,
    capabilityCatalog(config),
    clock,
  );
  if (continuation === undefined) {
    const planned = new EvidenceDrivenPlanner().plan(
      { goal: config.goal, candidates: config.initialCandidates },
      config.policy,
    );
    const requests = coordinator.submitMany(planned, { source: 'planner' });
    const reviews = requests.filter((request) => request.role === 'review');
    if (reviews.length > 1) {
      coordinator.createSynthesisTree(reviews.map((request) => request.id));
    }
  } else {
    for (const imported of continuation.state.findings) {
      coordinator.submitCanonicalFindingWork(
        correctionDraftForImportedFinding(continuation, imported.finding.id),
        {
          kind: 'canonical_finding',
          purpose: 'correction',
          canonicalFindingKey: imported.canonicalFindingKey,
          findingReference: imported.finding.id,
          sourceWorkUnitId: imported.sourceWorkUnitId,
          artifactPath: imported.sourceArtifactPath,
          round: 1,
          importedSource: {
            sourceRunId: imported.sourceRunId,
            sourceWorkUnitId: imported.sourceWorkUnitId,
            sourceBaseSha: imported.sourceBaseSha,
            artifactPath: imported.sourceArtifactPath,
            artifactSha256: imported.sourceArtifactSha256,
          },
        },
      );
    }
  }
  coordinator.arbitrate();
  return coordinator;
}

export function routeGrantedWork(
  coordinator: AdaptiveCoordinator,
  config: AdaptivePhaseConfig,
): void {
  const router = new DeterministicCapabilityRouter();
  for (const unit of coordinator.snapshot().workUnits) {
    if (unit.status !== 'GRANTED' || unit.route !== undefined) continue;
    const request = coordinator.snapshot().workRequests.find((candidate) => candidate.id === unit.requestId)!;
    const route = router.route(request, executorCandidates(config));
    const executor = config.executors.find((candidate) => candidate.id === route.executorId)!;
    coordinator.recordRoute(unit.id, { executorId: executor.id, adapter: executor.adapter });
  }
}

export function executorForRequest(
  config: AdaptivePhaseConfig,
  request: WorkRequest,
): AdaptiveExecutorConfig | undefined {
  const decision = new DeterministicCapabilityRouter().route(request, executorCandidates(config));
  return config.executors.find((executor) => executor.id === decision.executorId);
}

export async function planAdaptivePhase(
  phaseFile: string,
  options: AdaptivePlanOptions,
): Promise<AdaptivePlanResult> {
  const config = await loadAdaptivePhaseConfig(resolve(phaseFile));
  const git = options.git ?? new GitClient();
  const repositoryRoot = await git.repositoryRoot(resolve(options.repositoryPath));
  const baseSha = await resolveBaseSha(git, repositoryRoot, config.baseBranch);
  const clock: Clock = { now: options.clock ?? (() => new Date()) };
  const continuation = config.continuation === undefined
    ? undefined
    : await loadCanonicalContinuation(config.continuation, {
        runsRoot: resolve(options.runsRoot ?? join(repositoryRoot, 'tools/agent-orchestrator/runs')),
        repositoryRoot,
        targetBaseSha: baseSha,
        clock: clock.now,
      });
  const coordinator = buildAdaptiveCoordinator(config, clock, continuation);
  return {
    strategy: 'adaptive', repositoryRoot, config, baseSha,
    preview: coordinator.snapshot(),
    maximumPossibleConcurrency: Math.min(
      config.policy.limits.maxConcurrentAgents,
      coordinator.snapshot().workUnits.length,
    ),
  };
}

function taskMode(role: DynamicWorkUnit['role']): TaskMode {
  return role === 'integration_assistance' ? 'integration' : role;
}

export function taskSpecForAdaptiveUnit(
  unit: DynamicWorkUnit,
  state: AdaptiveRunState,
  config: AdaptivePhaseConfig,
): TaskSpec {
  if (unit.route === undefined) {
    throw new Error(`Adaptive work unit ${unit.id} has not been routed`);
  }
  const executor = config.executors.find((candidate) => candidate.id === unit.route!.executorId);
  if (executor === undefined || executor.adapter !== unit.route.adapter) {
    throw new Error(`Adaptive work unit ${unit.id} references an unknown or mismatched executor`);
  }
  const requestToUnit = new Map(state.workUnits.map((candidate) => [candidate.requestId, candidate.id]));
  const files = unit.resourceClaims
    .filter((claim) => claim.kind === 'repository_path')
    .map((claim) => claim.key);
  const writer = unit.resourceClaims.some(
    (claim) => claim.kind === 'repository_path' && claim.mode === 'write',
  );
  const request = state.workRequests.find((candidate) => candidate.id === unit.requestId)!;
  const evidence = request.evidence.map((item) => `${item.kind}:${item.reference} — ${item.summary}`);
  const imported = state.continuation?.findings.find(
    (finding) => finding.canonicalFindingKey === request.authorization?.canonicalFindingKey,
  );
  return {
    id: unit.id,
    title: unit.objective,
    owner: executor.adapter,
    effort: executor.effort,
    ...(executor.model === undefined ? {} : { model: executor.model }),
    mode: taskMode(unit.role),
    files,
    dependsOn: unit.dependencyRequestIds.map((id) => {
      const dependency = requestToUnit.get(id);
      if (dependency === undefined) throw new Error(`${unit.id} has an unmaterialized dependency ${id}`);
      return dependency;
    }),
    writer,
    instructions: [
      `Adaptive objective: ${unit.objective}`,
      `Reason: ${unit.reason}`,
      `Concern: ${unit.concern}`,
      ...(config.constraints.length === 0 ? [] : [`Phase constraints:\n- ${config.constraints.join('\n- ')}`]),
      ...(evidence.length === 0 ? [] : [`Evidence:\n- ${evidence.join('\n- ')}`]),
      ...(imported === undefined ? [] : [
        `Imported canonical finding provenance: ${JSON.stringify({
          sourceRunId: imported.sourceRunId,
          sourceWorkUnitId: imported.sourceWorkUnitId,
          sourceBaseSha: imported.sourceBaseSha,
          sourceArtifactPath: imported.sourceArtifactPath,
          sourceArtifactSha256: imported.sourceArtifactSha256,
          canonicalFindingKey: imported.canonicalFindingKey,
        })}`,
        `Original canonical finding: ${JSON.stringify(imported.finding)}`,
      ]),
      'Do not create or invoke other agents. Propose narrowly justified follow-up work only through additionalWorkRequests.',
    ].join('\n\n'),
  };
}

export function runtimePhaseConfig(
  config: AdaptivePhaseConfig,
  state: AdaptiveRunState,
): PhaseConfig {
  return {
    phase: config.phase,
    name: config.name,
    baseBranch: config.baseBranch,
    canonicalDesignDocument: config.canonicalDesignDocument,
    concurrency: config.policy.limits.maxConcurrentAgents,
    maxReviewRounds: config.policy.limits.maxTotalWorkUnits,
    agentRetries: config.agentRetries,
    agentTimeoutMs: config.agentTimeoutMs,
    agentWorktree: config.agentWorktree,
    tasks: state.workUnits
      .filter((unit) => unit.route !== undefined)
      .map((unit) => taskSpecForAdaptiveUnit(unit, state, config)),
    integration: config.integration,
    maxHandoffRepairAttempts: config.maxHandoffRepairAttempts,
    salvage: config.salvage,
  };
}
