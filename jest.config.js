/**
 * Jest configuration with three projects:
 *   - unit:        pure logic, no Nest app, no DB (fast, deterministic)
 *   - integration: full Nest app + in-memory SQLite + in-process mock HCM
 *   - e2e:         HTTP-level tests against a booted Nest app via supertest
 *
 * Coverage is collected across all projects when running `npm run test:cov`.
 */
const base = {
  rootDir: '.',
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  moduleNameMapper: {
    '^@app/(.*)$': '<rootDir>/src/$1',
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
};

module.exports = {
  ...base,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.module.ts',
    '!src/main.ts',
    '!src/mock-hcm/main.ts',
    '!src/**/index.ts',
    '!src/**/*.dto.ts',
    '!src/**/dto/*.ts',
    '!src/**/entities/*.ts',
  ],
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: ['text', 'text-summary', 'html', 'lcov', 'json-summary'],
  coverageThreshold: {
    global: {
      statements: 90,
      branches: 80,
      functions: 90,
      lines: 90,
    },
  },
  projects: [
    {
      ...base,
      displayName: 'unit',
      testMatch: ['<rootDir>/test/unit/**/*.spec.ts'],
    },
    {
      ...base,
      displayName: 'integration',
      testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
    },
    {
      ...base,
      displayName: 'e2e',
      testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'],
    },
  ],
};
