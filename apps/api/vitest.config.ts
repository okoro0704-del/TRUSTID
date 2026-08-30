import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "tests/**/*.test.ts",
      "../../tests/silent-auth.test.ts",
    ],
    setupFiles: ["./tests/setup.ts"],
    fileParallelism: false,
    hookTimeout: 60000,
    testTimeout: 30000,
  },
});
