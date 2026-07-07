// Build-time shim: goo loads owl as the global `window.owl` (static/lib/owl.js, a
// classic <script>), but both the app modules and the vendored owl-orm import it as
// `@odoo/owl`. esbuild aliases `@odoo/owl` to this module (see `npm run build`) so the
// whole bundle uses goo's OWN owl — one shared reactivity system (owl-orm's signals ARE
// the components' signals). Only runtime primitives are re-exported here; type-only
// imports (ReactiveValue, Signal) erase during TS compilation.
//
// This is the single source for "what the app imports from @odoo/owl". Adding a new owl
// primitive to a component/plugin means adding one re-export line below.
const owl = globalThis.owl;

// owl-orm internals
export const getScope = owl.getScope;
export const Scope = owl.Scope;

// app: reactivity
export const signal = owl.signal;
export const computed = owl.computed;
export const untrack = owl.untrack;

// app: components + templating
export const Component = owl.Component;
export const xml = owl.xml;
export const markup = owl.markup;
export const props = owl.props;
export const t = owl.t;
export const mount = owl.mount;
export const EventBus = owl.EventBus;

// app: lifecycle hooks
export const onMounted = owl.onMounted;
export const onPatched = owl.onPatched;
export const onWillStart = owl.onWillStart;
export const onWillUnmount = owl.onWillUnmount;
export const useEffect = owl.useEffect;
export const useApp = owl.useApp;

// app: plugin system
export const Plugin = owl.Plugin;
export const plugin = owl.plugin;
