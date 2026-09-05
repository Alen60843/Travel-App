import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { OrchestratorError } from '../errors';
import { parseReview, type StructuredReview } from '../review/findings';
import { StateStore } from '../state';
import type {
  AdaptiveContinuationConfig,
  AdaptiveContinuationState,
  AdaptiveRunState,
  WorkRequestDraft,
} from './types';

export interface LoadedCanonicalContinuation {
  readonly state: AdaptiveContinuationState;
  readonly review: StructuredReview;
  readonly sourceConcern: string;
}

function invalid(message: string, details: Record<string, unknown> = {}, cause?: unknown): never {
  throw new OrchestratorError('CONTINUATION_SOURCE_INVALID', message, {
    ...(cause === undefined ? {} : { cause }),
    details,
  });
}

function isCanonicalReviewSource(
  adaptive: AdaptiveRunState,
  requestId: string,
  role: string,
  source: string,
  dependencies: readonly string[],
): boolean {
  const synthesisRequests = adaptive.workRequests.filter((request) => request.role === 'synthesis');
  const feedsSynthesis = synthesisRequests.some((request) => request.dependencies.includes(requestId));
  if (role === 'synthesis') {
    return source === 'orchestrator' && dependencies.length > 0 && !feedsSynthesis;
  }
  if (role === 'final_review') return !feedsSynthesis;
  // A lone review can be canonical. A shard in a run that has synthesis cannot.
  return role === 'review' && synthesisRequests.length === 0;
}

async function readOwnedArtifact(
  sourceStore: StateStore,
  sourceWorkUnitId: string,
  persistedPath: string,
): Promise<{ readonly path: string; readonly source: string; readonly sha256: string }> {
  const expectedPath = resolve(sourceStore.runDirectory, 'reviews', `${sourceWorkUnitId}.json`);
  if (resolve(persistedPath) !== expectedPath) {
    invalid('Source artifact does not belong to the requested run/work unit', {
      expectedPath,
      persistedPath,
    });
  }
  const [runDirectory, artifactPath] = await Promise.all([
    realpath(sourceStore.runDirectory),
    realpath(expectedPath).catch((error) => invalid('Source review artifact is missing', { expectedPath }, error)),
  ]);
  const reviewsDirectory = join(runDirectory, 'reviews');
  if (artifactPath !== join(reviewsDirectory, `${sourceWorkUnitId}.json`)
    || (!artifactPath.startsWith(`${reviewsDirectory}${sep}`))) {
    invalid('Source artifact resolves outside the source run reviews directory', { artifactPath });
  }
  const metadata = await lstat(expectedPath).catch((error) => invalid('Source review artifact is missing', { expectedPath }, error));
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    invalid('Source review artifact must be a regular non-symlink file', { expectedPath });
  }
  let handle;
  try {
    handle = await open(expectedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const source = await handle.readFile('utf8');
    return {
      path: expectedPath,
      source,
      sha256: createHash('sha256').update(source, 'utf8').digest('hex'),
    };
  } catch (error) {
    return invalid('Could not securely read source review artifact', { expectedPath }, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Read-only import boundary. It accepts pointers from YAML, never finding
 * contents, and returns a self-contained snapshot for the new run.
 */
export async function loadCanonicalContinuation(
  config: AdaptiveContinuationConfig,
  options: {
    readonly runsRoot: string;
    readonly repositoryRoot: string;
    readonly targetBaseSha: string;
    readonly clock: () => Date;
  },
): Promise<LoadedCanonicalContinuation> {
  if (options.targetBaseSha.toLowerCase() !== config.expectedBaseSha) {
    invalid('Continuation target base does not match expectedBaseSha', {
      targetBaseSha: options.targetBaseSha,
      expectedBaseSha: config.expectedBaseSha,
    });
  }
  const sourceStore = new StateStore(options.runsRoot, config.sourceRunId);
  let sourceRun;
  try {
    sourceRun = await sourceStore.load();
  } catch (error) {
    invalid('Source run does not exist or its state is invalid', { sourceRunId: config.sourceRunId }, error);
  }
  if (sourceRun.strategy !== 'adaptive' || sourceRun.adaptive === undefined) {
    invalid('Source run is not an adaptive run', { sourceRunId: config.sourceRunId });
  }
  const [sourceRepositoryRoot, targetRepositoryRoot] = await Promise.all([
    realpath(sourceRun.repositoryRoot).catch(() => resolve(sourceRun.repositoryRoot)),
    realpath(options.repositoryRoot).catch(() => resolve(options.repositoryRoot)),
  ]);
  if (sourceRepositoryRoot !== targetRepositoryRoot) {
    invalid('Source run belongs to a different repository', {
      expected: targetRepositoryRoot,
      actual: sourceRepositoryRoot,
    });
  }
  if (!['BLOCKED', 'COMPLETED'].includes(sourceRun.status)) {
    invalid('Source run is not in a settled continuation-eligible status', { status: sourceRun.status });
  }
  if (sourceRun.baseSha.toLowerCase() !== config.expectedBaseSha) {
    invalid('Source run base does not match expectedBaseSha', {
      sourceBaseSha: sourceRun.baseSha,
      expectedBaseSha: config.expectedBaseSha,
    });
  }

  const unit = sourceRun.adaptive.workUnits.find((candidate) => candidate.id === config.sourceWorkUnitId);
  const task = sourceRun.tasks[config.sourceWorkUnitId];
  if (unit === undefined || task === undefined || unit.status !== 'SUCCEEDED' || task.status !== 'SUCCEEDED') {
    invalid('Source work unit is missing or did not succeed', { sourceWorkUnitId: config.sourceWorkUnitId });
  }
  const request = sourceRun.adaptive.workRequests.find((candidate) => candidate.id === unit.requestId);
  if (request === undefined || !isCanonicalReviewSource(
    sourceRun.adaptive,
    request.id,
    request.role,
    request.source,
    request.dependencies,
  )) {
    invalid('Source work unit is not an accepted canonical review/synthesis unit', {
      sourceWorkUnitId: config.sourceWorkUnitId,
      role: request?.role,
    });
  }
  if (request.authorization !== undefined) {
    invalid('Source work unit is a follow-up review, not an original canonical review result', {
      sourceWorkUnitId: config.sourceWorkUnitId,
    });
  }
  if (request.dependencies.some((dependency) => {
    const dependencyUnit = sourceRun.adaptive!.workUnits.find((candidate) => candidate.requestId === dependency);
    return dependencyUnit?.status !== 'SUCCEEDED';
  })) {
    invalid('Source canonical unit has an unsuccessful input', { sourceWorkUnitId: config.sourceWorkUnitId });
  }
  if (task.preparedHeadSha?.toLowerCase() !== sourceRun.baseSha.toLowerCase() || task.commit !== undefined) {
    invalid('Source review was not executed read-only at the source base', {
      preparedHeadSha: task.preparedHeadSha,
      sourceBaseSha: sourceRun.baseSha,
    });
  }
  const artifactPath = task.reviewPaths.at(-1);
  if (artifactPath === undefined) {
    invalid('Source work unit has no persisted review artifact', { sourceWorkUnitId: config.sourceWorkUnitId });
  }
  const artifact = await readOwnedArtifact(sourceStore, config.sourceWorkUnitId, artifactPath);
  if (config.expectedArtifactSha256 !== undefined && artifact.sha256 !== config.expectedArtifactSha256) {
    invalid('Source review artifact SHA-256 does not match the continuation contract', {
      expectedArtifactSha256: config.expectedArtifactSha256,
      actualArtifactSha256: artifact.sha256,
    });
  }
  let review: StructuredReview;
  try {
    review = parseReview(artifact.source);
  } catch (error) {
    invalid('Source artifact does not satisfy the strict review schema', { artifactPath: artifact.path }, error);
  }
  if (review.status !== 'changes_requested') {
    invalid('Canonical finding continuation requires a changes_requested source review', {
      reviewStatus: review.status,
    });
  }
  const importedAt = options.clock().toISOString();
  const findings = review.findings.map((finding) => ({
    canonicalFindingKey: `${config.sourceRunId}:${config.sourceWorkUnitId}:${finding.id}`,
    finding,
    sourceRunId: config.sourceRunId,
    sourceWorkUnitId: config.sourceWorkUnitId,
    sourceArtifactPath: artifact.path,
    sourceBaseSha: sourceRun.baseSha,
    sourceArtifactSha256: artifact.sha256,
    importedAt,
    round: 1 as const,
  }));
  return {
    review,
    sourceConcern: request.concern,
    state: {
      ...config,
      sourceBaseSha: sourceRun.baseSha,
      sourceArtifactPath: artifact.path,
      sourceArtifactSha256: artifact.sha256,
      sourceReviewStatus: 'changes_requested',
      importedAt,
      findings,
    },
  };
}

export function correctionDraftForImportedFinding(
  loaded: LoadedCanonicalContinuation,
  findingId: string,
): WorkRequestDraft {
  const imported = loaded.state.findings.find((candidate) => candidate.finding.id === findingId);
  if (imported === undefined) invalid('Imported finding is missing from continuation snapshot', { findingId });
  const finding = imported.finding;
  const proposal = loaded.review.additionalWorkRequests?.find((candidate) =>
    (candidate.role === 'correction' || candidate.role === 'testing')
    && candidate.resourceClaims?.some((claim) => claim.mode === 'write')
    && candidate.evidence?.some((evidence) => evidence.kind === 'finding' && evidence.reference === finding.id),
  );
  const role = proposal?.role === 'testing' || (proposal === undefined && finding.category === 'testing')
    ? 'testing' as const
    : 'correction' as const;
  return {
    role,
    concern: proposal?.concern ?? (finding.category === 'testing' ? 'testing' : loaded.sourceConcern),
    objective: proposal?.objective ?? `Correct ${finding.id}: ${finding.problem}`,
    reason: proposal?.reason ?? finding.suggestedFix,
    dependencies: [],
    capabilities: proposal?.capabilities ?? [{ capability: role === 'testing' ? 'testing' : 'typescript_backend_editing' }],
    resourceClaims: proposal?.resourceClaims ?? [{ kind: 'repository_path', key: finding.file, mode: 'write' }],
    evidence: proposal?.evidence ?? [{ kind: 'finding', reference: finding.id, summary: finding.evidence }],
    risk: proposal?.risk ?? finding.severity,
    priority: proposal?.priority ?? (finding.severity === 'critical' ? 100 : finding.severity === 'high' ? 90 : finding.severity === 'medium' ? 75 : 50),
    ...(proposal?.estimatedCostUnits === undefined ? {} : { estimatedCostUnits: proposal.estimatedCostUnits }),
  };
}
