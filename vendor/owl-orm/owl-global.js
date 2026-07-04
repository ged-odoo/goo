// Build-time shim: owl-orm imports `@odoo/owl`, but goo loads owl as the global
// `window.owl` (static/lib/owl.js, a classic <script>). esbuild aliases `@odoo/owl`
// to this module so the bundled ORM uses goo's OWN owl — one shared reactivity system
// (owl-orm's signals ARE the components' signals). Type-only imports (ReactiveValue,
// Signal) erase during TS compilation, so only the runtime primitives are re-exported.
const owl = globalThis.owl;
export const getScope = owl.getScope;
export const Scope = owl.Scope;
export const computed = owl.computed;
export const signal = owl.signal;
