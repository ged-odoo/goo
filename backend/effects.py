"""The IO seam: the single place goo reaches outside the process — subprocess and
network. The services layer (see services.py) depends on this module, or a fake of
it, so services can be unit-tested without spawning commands or hitting the network.
"""

import subprocess
import time
import urllib.request

TAG = "[goo]"

_subprocess_run = subprocess.run  # raw reference, so the rename to run() doesn't recurse


def log(message):
    """Write a line to the goo log (stdout)."""
    print(message, flush=True)


def log_request(target):
    """Announce an outgoing network/subprocess request on the terminal, so the user
    can see what goo is reaching out to (runbot, GitHub, git remotes)."""
    print(f"{TAG} {time.strftime('%H:%M:%S')} → {target}", flush=True)


def run(cmd, *, quiet=False, **kwargs):
    """Run a command, capturing its output. On a non-zero exit (unless quiet), dump
    the command and its raw stderr to the goo log — verbatim, no [goo] prefix — so a
    failed git/gh/psql/… call is never silent. Returns the CompletedProcess; raised
    errors (FileNotFoundError, TimeoutExpired, …) propagate to the caller as before."""
    if "capture_output" not in kwargs and "stdout" not in kwargs and "stderr" not in kwargs:
        kwargs["capture_output"] = True
    kwargs.setdefault("text", True)
    result = _subprocess_run(cmd, **kwargs)
    if result.returncode and not quiet:
        shown = cmd if isinstance(cmd, str) else " ".join(str(c) for c in cmd)
        detail = (result.stderr or result.stdout or "").strip()
        print(f"$ {shown}", flush=True)
        if detail:
            print(detail, flush=True)
    return result


def http_get(url, *, timeout=10):
    """GET a URL and return (text, error). Logs the request and never raises — a
    network/HTTP failure comes back as ("", "<reason>")."""
    log_request(f"GET {url}")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "goo/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="replace"), None
    except Exception as e:  # any network/HTTP error just means "unreachable"
        return "", str(e)
