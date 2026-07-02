# rust_bundler

Routes Odoo's JavaScript asset bundling (transpile + concat + minify + QWeb XML
templates) through the [`odoo_bundler`](https://github.com/Goaman/odoo_bundler)
Rust extension instead of the pure-Python `AssetsBundle`. Upstream measured
~25–30× faster bundling (e.g. `web.assets_web`: 1958 ms → 77 ms).

Adapted from the upstream experiment:
[odoo-dev/odoo@1a731d1](https://github.com/odoo-dev/odoo/commit/1a731d1ce911f79b0964708b30615a5d969267f0).
Its `benchmark.py` is included — measured here: `web.assets_web` 1658 ms → 136 ms (12.2×).

## How it works

`AssetsBundle` is a plain Python class (not an ORM model), so it can't be
extended with `_inherit`. This module **monkey-patches** `AssetsBundle.js()` at
import time (`models/assetsbundle.py`) — no core file is edited. `js()` then
collects the bundle's ordered on-disk file paths (`javascripts + templates`)
and calls `odoo_bundler.bundle(name, files, minify_level=...)`, saving the
result as the bundle attachment.

goo appends this `addons/` directory to every instance's `--addons-path`, and
the module is `auto_install`, so it is present in every database goo creates —
but **activation is opt-in**: the patch is only applied when the `RUST_BUNDLER`
env var is truthy (`1`/`true`/`on`) at registry load. goo sets `RUST_BUNDLER=1`
on the odoo command when the "rust bundler" checkbox in the config screen's
Miscellaneous section is ticked (main server, worktree servers, and shell-based
asset pregeneration alike); toggling takes effect on the next server start.

Even when activated it is designed to never get in the way — it falls back to
the pure-Python bundler when:

- the `odoo_bundler` extension isn't importable (one warning at startup, then
  the patch simply isn't applied; goo also probes the instance's venv on every
  server start with the checkbox on and explains this in its own log), or
- an asset has no on-disk file (inline / `ir.attachment`-backed), or
- the Rust bundler raises for any reason.

## Setup

1. Build & install the Rust extension into the venv that runs Odoo:

   ```bash
   git clone https://github.com/Goaman/odoo_bundler
   cd odoo_bundler
   pip install maturin
   maturin develop --release
   ```

2. Tick "rust bundler" in goo's config → Miscellaneous section (or
   `export RUST_BUNDLER=1` for manual runs outside goo) and (re)start the
   server. Untick / unset to revert to the pure-Python bundler.

## Caveats

Rust output is not byte-for-byte identical to Python's (different minifier:
oxc whitespace vs rjsmin; non-stable `odoo.define` dependency-array order), but
upstream verified the same module/template set and header URLs are emitted.
