import { defineConfig } from "vitest/config";

export default defineConfig({
  server: {
    fs: {
      allow: ["C:/Users/Hp/Desktop/DDI", "C:/Users/Hp/Desktop/TRUST ID"],
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
  },
});
