import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
  test: {
    expect: { poll: { timeout: 7000 } },
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.{js,mjs}"],
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.{js,mjs}"],
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
      {
        test: {
          name: "browser",
          include: ["tests/browser/**/*.test.{js,mjs}"],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: "chromium" }],
          },
        },
      },
      {
        test: {
          name: "e2e",
          environment: "node",
          include: ["tests/e2e/**/*.test.{js,mjs}"],
          testTimeout: 60000,
          hookTimeout: 60000,
          fileParallelism: false,
          expect: { poll: { timeout: 7000 } },
        },
      },
    ],
  },
});
