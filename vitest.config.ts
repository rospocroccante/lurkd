import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // D53: no test reaches the npm registry. A server a test starts, in this process or as a
    // child that inherits the environment, keeps the update check off unless the test injects
    // its own fetch and environment.
    env: { LURKD_NO_UPDATE_CHECK: '1' },
  },
});
