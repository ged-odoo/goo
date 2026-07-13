# rust_bundler

Routes Odoo's JavaScript asset bundling (transpile, concatenate, minify, and
compile QWeb XML templates) through Goo's in-tree `goo_odoo_bundler` Rust
extension. The extension is a minimal fork of `Goaman/odoo_bundler`; provenance
is recorded in [`native/ORIGIN.md`](native/ORIGIN.md).

## Exact Odoo bundle membership

Odoo resolves each manifest's asset operations into an ordered list before this
addon calls Rust. That list is authoritative: the native extension reads and
emits exactly those JavaScript/TypeScript files, in that order. Static imports
are converted to runtime `odoo.define` dependencies but are never followed, so
an import cannot pull a file into a bundle unless an Odoo manifest selected it.

## Install and activate

Goo injects this addon into every managed Odoo instance and auto-installs it in
each database. Native activation remains opt-in:

1. Configure the Odoo environment with `venv_activate` when needed.
2. In Goo's Configuration screen, click **Build / update Rust bundler**. This
   runs pip against `native/` in that environment; Rust/Cargo and pip must be
   available. A first build may need network access for Maturin and Cargo crates.
3. Enable **rust bundler** and restart Odoo.

The build action never enables the feature or restarts Odoo automatically.
Untick the checkbox and restart to return to the pure-Python bundler.

The addon also falls back for the whole bundle when the extension is missing or
stale, an asset has no on-disk filename, or native processing raises an error.

## Development

```bash
cd addons/rust_bundler/native
cargo fmt --check
cargo test --locked
cargo clippy --locked --all-targets --features python -- -D warnings
```

`benchmark.py` compares the Python and Rust paths against a live Odoo database.
Before reporting timings it asserts that Rust's emitted JavaScript marker order
exactly matches Odoo's resolved `bundle.javascripts` list.
