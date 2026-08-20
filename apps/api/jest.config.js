/**
 * `.spec.ts`      unit tests — no external dependencies, run in parallel.
 * `.int-spec.ts`  integration tests — real PostgreSQL/Redis, run serially.
 *
 * Phase 2 deliberately leans on integration tests: connection lifecycle,
 * SKIP LOCKED claiming and BullMQ delivery cannot be faithfully mocked.
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '.*\\.(spec|int-spec)\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json', isolatedModules: true }],
  },
  moduleNameMapper: {
    '^@tripwith/shared$': '<rootDir>/../../packages/shared/src/index.ts',
  },
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  testTimeout: 45000,
  clearMocks: true,
};
