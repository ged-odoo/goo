// The few Node built-ins static/tests/setup.ts uses (it runs under vitest, in
// Node). Declared here instead of installing @types/node, whose globals would
// retype the browser ones (e.g. setTimeout's return) for static/src too.

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
}

declare module "node:path" {
  const path: { join(...parts: string[]): string };
  export default path;
}

declare module "node:vm" {
  const vm: { runInThisContext(code: string, options?: { filename?: string }): unknown };
  export default vm;
}

declare const process: { cwd(): string };
