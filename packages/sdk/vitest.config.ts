import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
    server: {
      deps: {
        // Inlined so vi.resetModules() gives each runtime test a fresh ORT
        // backend registry (per-backend init/aborted state is module-level).
        inline: ["onnxruntime-common"],
      },
    },
  },
});
