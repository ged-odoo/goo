# Origin and permission

This native extension is a Goo-specific derivative of
[`Goaman/odoo_bundler`](https://github.com/Goaman/odoo_bundler), pinned from
commit `37bf2915b973d0ad3c0abfee9603ee93a03ef847` (2025-11-25), authored by
Nicolas Bayet.

The upstream project did not declare a license. The Goo maintainer confirmed
that permission is held to redistribute and modify the selected source in this
repository.

The fork retains the JavaScript/TypeScript transpilers, OXC minifier, XML
template compiler, and PyO3 binding. Goo removed the standalone CLI, source-map
and metrics support, and—most importantly—the recursive JavaScript import
crawler. Odoo's resolved asset list is now the sole authority for which files
are included and for their order.
