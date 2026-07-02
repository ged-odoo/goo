"""Monkey-patch ``AssetsBundle`` to bundle JS with the odoo_bundler Rust extension.

``AssetsBundle`` is a plain Python class (not an ORM model), so it cannot be
extended through ``_inherit``. Instead its ``js()`` method is patched at import
time, so no core file is modified.

goo auto-installs this module in every database it launches, so unlike the
upstream addon (where installing is the switch) activation is opt-in: the patch
is only applied when the ``RUST_BUNDLER`` env var is truthy (goo sets it from
the "rust bundler" checkbox in the config's Miscellaneous section) AND the
``odoo_bundler`` extension imports (one warning at startup otherwise). Any
failure on the Rust path falls back to the original Python bundler.
"""

import logging
import os

from odoo.addons.base.models.assetsbundle import AssetsBundle

_logger = logging.getLogger(__name__)

try:
    import odoo_bundler
except ImportError:
    odoo_bundler = None


def _rust_js(self, minified=True):
    """Build the JS bundle with the ``odoo_bundler`` Rust extension.

    The Rust bundler reads the source files from disk, transpiles odoo modules
    (``import`` -> ``odoo.define``), minifies, and bundles the QWeb XML
    templates, mirroring the pure-Python path in :meth:`AssetsBundle.js`.

    :return: the bundle content as a string, or ``None`` to tell the caller to
        fall back to the Python bundler (an asset has no on-disk file and
        therefore cannot be read by Rust, or the Rust bundler failed).
    """
    # Ordered list of on-disk paths: JS entry points first (order matters),
    # then the QWeb XML templates. The Rust bundler filters by extension and
    # emits the JS, then the templates block, like js()/generate_xml_bundle.
    files = []
    for asset in self.javascripts + self.templates:
        if not asset._filename:
            # Inline or ir.attachment-backed asset with no file on disk.
            _logger.info(
                "Asset %r has no on-disk file; falling back to the Python bundler for %r.",
                asset.url,
                self.name,
            )
            return None
        files.append(asset._filename)

    try:
        result = odoo_bundler.bundle(
            self.name,
            files,
            minify_level="whitespace" if minified else "none",
        )
    except Exception:
        _logger.exception(
            "odoo_bundler failed on %r; falling back to the Python bundler.", self.name
        )
        return None
    return result["content"]


_original_js = AssetsBundle.js


def js(self):
    is_minified = not self.is_debug_assets
    extension = "min.js" if is_minified else "js"

    if not self.get_attachments(extension):
        content_bundle = self._rust_js(minified=is_minified)
        if content_bundle is not None:
            js_attachment = self.save_attachment(extension, content_bundle)
            return js_attachment[0]

    return _original_js(self)


_enabled = os.environ.get("RUST_BUNDLER", "").strip().lower() in ("1", "true", "on")

if not _enabled:
    _logger.info(
        "rust_bundler is installed but RUST_BUNDLER is not set; using the Python "
        "bundler. Tick 'rust bundler' in goo's Miscellaneous config section (or "
        "`export RUST_BUNDLER=1`) to activate it."
    )
elif odoo_bundler is None:
    _logger.warning(
        "RUST_BUNDLER is set but the odoo_bundler extension is not importable; "
        "JS bundling stays on the pure-Python path. Build it into the Odoo venv with "
        "`maturin develop --release` (https://github.com/Goaman/odoo_bundler)."
    )
else:
    AssetsBundle._rust_js = _rust_js
    AssetsBundle.js = js
