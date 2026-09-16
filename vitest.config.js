import { defineConfig } from "vitest/config";

// Mirrors the --alias:@odoo/owl=./vendor/owl-orm/owl-global.js flag in
// package.json's "build" script — keep both pointing at the same shim.
export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./static/tests/setup.js"],
    include: ["static/tests/**/*.test.js"],
  },
  resolve: {
    alias: {
      "@odoo/owl": new URL("./vendor/owl-orm/owl-global.js", import.meta.url).pathname,
    },
  },
});
