import { defineConfig } from "vitest/config";

// Mirrors the --alias:@odoo/owl=./vendor/owl-orm/owl-global.ts flag in
// package.json's "build" script — keep both pointing at the same shim.
export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./static/tests/setup.ts"],
    include: ["static/tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["static/src/**/*.ts"],
      exclude: ["static/src/**/*.d.ts"],
      reporter: ["text-summary", "text"],
    },
  },
  resolve: {
    alias: {
      "@odoo/owl": new URL("./vendor/owl-orm/owl-global.ts", import.meta.url).pathname,
    },
  },
});
