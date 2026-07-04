# Vendored: @odoo/owl-orm

The client ORM the goo frontend is being rewritten onto (design doc's "Plan: rewrite
goo on a client ORM"). Vendored here (pinned) so the bundle is reproducible without the
owl monorepo checkout.

- Source: `/home/odoo/work/owl/packages/owl-orm/src/` (`@odoo/owl-orm` v0.1.0)
- Targets: `@odoo/owl` 3.0.0-alpha.41 (imports `getScope, Scope, computed, signal`)
- Public API: `Model`, `ORM`, `fields`

`@odoo/owl` is NOT bundled in — at build time it's aliased to `owl-global.js`, which
re-exports goo's global `window.owl` (from `static/lib/owl.js`), so the ORM shares the
one reactivity system the components already use.

Chosen over gloomraven's `owlx` (a closely-related copy) because that one imports
`useContext`, which goo's vendored owl build does not expose; owl-orm's imports all do.

Regenerate the served bundle with: `npm run build:owlx` → `static/lib/owlx.js`.
