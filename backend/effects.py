"""The IO seam: the single place goo reaches outside the process — subprocess,
network, and the filesystem. The services layer (see services.py) depends on this
module, or a fake of it, so services can be unit-tested without spawning commands,
hitting the network, or touching disk.
"""

import json
import os
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


# ─────────────────────────── filesystem ───────────────────────────


def is_dir(path):
    return os.path.isdir(os.path.expanduser(path))


def list_dir(path):
    """Sorted directory entries, or [] if it can't be read."""
    try:
        return sorted(os.listdir(os.path.expanduser(path)))
    except OSError:
        return []


def read_text(path):
    """A file's contents as text, or None if it can't be read."""
    try:
        with open(os.path.expanduser(path), encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def read_json_file(path):
    """Read a JSON data file. Returns (data, error); a missing file is not an error
    — it returns (None, None) so the caller can create it on first use."""
    p = os.path.expanduser(path)
    if not os.path.exists(p):
        return None, None
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f), None
    except (OSError, ValueError) as e:
        return None, str(e)


def write_json_file(path, data):
    """Write data as pretty JSON, creating parent dirs. Returns (ok, error)."""
    p = os.path.expanduser(path)
    try:
        parent = os.path.dirname(p)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        return True, None
    except OSError as e:
        return False, str(e)
