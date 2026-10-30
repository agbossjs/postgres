import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // a test that asserts nothing proves nothing (the core's #180)
    expect: { requireAssertions: true },
    // every test file needs AGBOSS_POSTGRES_TEST_URL: it fails without it, never skips
    globalSetup: ["./tests/support/global-setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "html", "json-summary"],
      // the core's thresholds (packages/agboss/vitest.config.ts), its 90 % for the stores' kind
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
    },
  },
});
