#!/usr/bin/env python3
"""goo - GED Odoo Overseer, a local web app for Odoo development.

Thin launcher: run `python3 goo.py` (or `--open` to open the browser). The
implementation lives in the `backend/` package; this just calls into it.
"""

from backend.server import main

if __name__ == "__main__":
    raise SystemExit(main())
