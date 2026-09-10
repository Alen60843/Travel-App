import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildAgentPrompt, type AgentRequest, type AgentRole } from '../../src/agents';
import {
  formatRepositoryContextHints,
  resolveRepositoryContextHints,
} from '../../src/context/repository-context';

test('graph context resolves explicit paths, referenced symbols, imports and workspace edges', () => {
  const root = makeRepositoryFixture();
  try {
    const context = resolveRepositoryContextHints(root, taskSpecification());
    assert.ok(context);
    const paths = context.hints.map((hint) => hint.path);

    assert.ok(paths.includes('apps/api/src/realtime/rooms.ts'));
    assert.ok(paths.includes('apps/api/src/database/social.ts'));
    assert.ok(paths.includes('apps/api/src/chat/service.ts'));
    assert.ok(paths.includes('packages/shared/src/index.ts'));
    assert.ok(paths.includes('packages/shared/src/thing.ts'));
    assert.equal(paths.includes('apps/api/src/unrelated.ts'), false);

    const formatted = formatRepositoryContextHints(context);
    assert.match(formatted, /NOT authority/);
    assert.match(formatted, /never treat absence from the graph as evidence/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('graph context is bounded and reports truncation instead of flooding the prompt', () => {
  const root = makeRepositoryFixture();
  try {
    const context = resolveRepositoryContextHints(root, taskSpecification(), 2);
    assert.ok(context);
    assert.equal(context.hints.length, 2);
    assert.equal(context.maxHints, 2);
    assert.equal(context.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent prompts receive graph hints only for repository-working roles', () => {
  const root = makeRepositoryFixture();
  try {
    const implementationPrompt = buildAgentPrompt(makeRequest(root, 'implementation'));
    const kernelIndex = implementationPrompt.indexOf('Agent kernel:');
    const graphIndex = implementationPrompt.indexOf('Repository context hints');
    const roleIndex = implementationPrompt.indexOf('Role contract:');

    assert.ok(kernelIndex >= 0);
    assert.ok(graphIndex > kernelIndex);
    assert.ok(roleIndex > graphIndex);
    assert.match(implementationPrompt, /apps\/api\/src\/realtime\/rooms\.ts/);

    const repairPrompt = buildAgentPrompt(makeRequest(root, 'handoff_repair'));
    assert.equal(repairPrompt.includes('Repository context hints'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function taskSpecification(): unknown {
  return {
    task: {
      id: 'chat-core',
      title: 'Authorize ChatMemberEntity chat rooms',
      files: ['apps/api/src/chat/**'],
      instructions: 'Inspect apps/api/src/realtime/rooms.ts and ChatMemberEntity before writing.',
    },
    actualDependencyDiff: '',
    responseSchema: { status: 'complete' },
  };
}

function makeRequest(root: string, role: AgentRole): AgentRequest {
  return {
    runId: 'run-graph-context',
    taskId: `${role}-graph-context`,
    role,
    worktreePath: root,
    baseSha: 'a'.repeat(40),
    taskSpecification: taskSpecification(),
    canonicalDesignDocumentPath: join(root, 'docs/design.md'),
    allowedFileOwnership: ['apps/api/src/chat/**'],
    dependencyHandoffs: [],
    previousReviewFindings: [],
    requestedEffort: 'high',
    timeoutMs: 60_000,
    artifactsDirectory: join(root, '.artifacts'),
  };
}

function makeRepositoryFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'tripwith-graph-context-'));
  write(root, 'packages/shared/package.json', '{"name":"@tripwith/shared"}\n');
  write(root, 'packages/shared/src/index.ts', "export { SharedThing } from './thing';\n");
  write(root, 'packages/shared/src/thing.ts', 'export class SharedThing {}\n');
  write(
    root,
    'apps/api/src/chat/service.ts',
    "import { SharedThing } from '@tripwith/shared';\nimport { userRoom } from '../realtime/rooms';\nexport class ChatService { use(value: SharedThing) { return userRoom(String(value)); } }\n",
  );
  write(root, 'apps/api/src/realtime/rooms.ts', 'export function userRoom(id: string) { return `user:${id}`; }\n');
  write(root, 'apps/api/src/database/social.ts', 'export class ChatMemberEntity {}\n');
  write(root, 'apps/api/src/unrelated.ts', 'export class UnrelatedThing {}\n');
  return root;
}

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
}
