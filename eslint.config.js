import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["static/lib/**", "node_modules/**"] },
  js.configs.recommended,
  {
    files: ["static/src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.browser, owl: "readonly" },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-control-regex": "off", // the log parser matches ANSI escape sequences
    },
  },
];
