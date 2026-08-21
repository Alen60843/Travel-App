import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { GitClient } from '../../src/git/git';

export interface TemporaryRepository {
  readonly container: string;
  readonly repository: string;
  readonly git: GitClient;
  readonly baseBranch: string;
  readonly baseSha: string;
  dispose(): Promise<void>;
}

export async function createTemporaryRepository(): Promise<TemporaryRepository> {
  const container = await mkdtemp(join(tmpdir(), 'tripwith-orchestrator-git-'));
  const repository = join(container, 'repository');
  await mkdir(repository);
  const git = new GitClient();
  await git.run(repository, ['init', '--initial-branch=phase4/base']);
  await git.run(repository, ['config', 'user.name', 'Orchestrator Test']);
  await git.run(repository, ['config', 'user.email', 'orchestrator-test@example.invalid']);
  await writeFile(join(repository, 'shared.txt'), 'base\n', 'utf8');
  await git.run(repository, ['add', '--', 'shared.txt']);
  await git.run(repository, ['commit', '-m', 'base']);
  const baseSha = await git.resolveCommit(repository, 'HEAD');
  return {
    container,
    repository,
    git,
    baseBranch: 'phase4/base',
    baseSha,
    dispose: async () => rm(container, { recursive: true, force: true }),
  };
}
