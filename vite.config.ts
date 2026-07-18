/// <reference types="vitest/config" />
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
    sourcemap: true,
    // Rapier ships its WASM base64-inlined and Three is large; both are needed
    // on boot, so code-splitting wouldn't defer meaningful work.
    chunkSizeWarningLimit: 3000,
  },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
