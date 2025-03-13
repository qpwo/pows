module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  collectCoverageFrom: [
    'packages/*/src/**/*.ts',
    '!**/node_modules/**',
    '!**/dist/**',
    '!**/__tests__/**'
  ],
  moduleNameMapper: {
    '^@tsws/core$': '<rootDir>/packages/core/src',
    '^@tsws/node$': '<rootDir>/packages/node/src',
    '^@tsws/browser$': '<rootDir>/packages/browser/src'
  }
};