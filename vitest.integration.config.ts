import { defineConfig } from "vitest/config";

// Protocol tests that drive a real `wrangler dev` (local D1, R2 and Queues) with tsdav.
export default defineConfig({
  test: {
    include: ["test-integration/**/*.test.ts"],
    globalSetup: ["./test-integration/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
