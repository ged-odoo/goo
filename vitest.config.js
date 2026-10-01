import { defineConfig } from "vitest/config";

// Mirrors the --alias:@odoo/owl=./vendor/owl-orm/owl-global.ts flag in
// package.json's "build" script — keep both pointing at the same shim.
export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./static/tests/setup.ts"],
    include: ["static/tests/**/*.test.ts"],
    // whole-app tests take ~0.2–1.5s each; the default 5s left too little headroom
    // on a loaded machine
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      include: ["static/src/**/*.ts"],
      // main.ts only mounts the app into the real page (its pieces are tested)
      exclude: ["static/src/**/*.d.ts", "static/src/main.ts"],
      reporter: ["text-summary", "text"],
      // CI fails below these (npm run test:coverage) — raise them as coverage grows,
      // never lower them to make a PR pass
      thresholds: { lines: 95, statements: 93, functions: 95, branches: 80 },
    },
  },
  resolve: {
    alias: {
      "@odoo/owl": new URL("./vendor/owl-orm/owl-global.ts", import.meta.url).pathname,
    },
  },
});
