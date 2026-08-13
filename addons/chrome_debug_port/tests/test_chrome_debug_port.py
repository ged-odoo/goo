"""Forces Odoo's test ChromeBrowser onto a fixed CDP port (default 9222,
Chrome's conventional remote-debugging port — override with the
CHROME_DEBUG_PORT env var) instead of a random one picked at launch — so an
external DevTools client (chrome://inspect, an editor's debugger, the
chrome-devtools MCP server, which needs a port configured ahead of time and
can't discover a random one) can attach live to the SAME browser Odoo's own
test framework launches for a tour/HOOT/memcheck run. The chrome-devtools MCP
server is pointed at this same default via --browserUrl=http://127.0.0.1:9222
in its own config (~/.claude.json) — keep both in sync if you override the
port here.

`ChromeBrowser.remote_debugging_port` is hardcoded to 0 in Odoo core
(odoo/tests/common.py, with the comment "change it in a non-git-tracked
file") — this addon's own test file IS that non-git-tracked override,
applied via a class-attribute patch at import time. Odoo's test loader
imports every installed module's tests/ package to discover TestCase
classes whenever any --test-tags/--test-enable run happens at all (see
odoo/tests/loader.py) — no TestCase class is needed here for the patch to
take effect, the import itself is enough.

Once this addon is installed, EVERY future browser test on this checkout
uses this port, unconditionally — including ones you didn't mean to inspect
live. Only one Chrome instance can bind a given port at a time, so don't run
two browser tests concurrently (or against two databases at once) while
this is installed, and uninstall it again if that becomes a problem.
"""

import os

from odoo.tests.common import ChromeBrowser

ChromeBrowser.remote_debugging_port = int(os.environ.get("CHROME_DEBUG_PORT", 9222))
