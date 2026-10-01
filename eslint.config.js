import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["static/lib/**", "static/dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["static/src/**/*.ts", "static/tests/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser },
    },
    rules: {
      "no-unused-vars": "off", // the TS-aware rule below replaces it
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "no-control-regex": "off", // the log parser matches ANSI escape sequences
      // blank line between methods, but keep single-line field stanzas compact
      "lines-between-class-members": ["error", "always", { exceptAfterSingleLine: true }],
    },
  },
  {
    files: ["static/tests/**/*.ts"],
    // node globals too: setup.ts reads static/lib/owl.js off disk via node:fs/vm
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
);
