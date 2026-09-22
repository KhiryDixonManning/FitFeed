import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Two suites run under Vitest:
//   tests/rules/**       Firebase security rules, against the local emulators
//   tests/components/**  React component behaviour in jsdom (per-file docblock)
// Browser end-to-end flows stay in Playwright under tests/*.spec.ts.
export default defineConfig({
  plugins: [react()],
  // tests/ sits outside tsconfig.app.json, so esbuild would otherwise fall
  // back to the classic JSX runtime and require React in scope.
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['tests/rules/**/*.test.ts', 'tests/components/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 20000,
    hookTimeout: 60000,
    // The rules suites share one emulator instance and clear state between
    // cases, so files must not run concurrently.
    fileParallelism: false,
  },
});
