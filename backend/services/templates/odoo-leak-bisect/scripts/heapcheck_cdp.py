#!/usr/bin/env python3
"""Standalone empirical mail-hoot-suite leak check via raw CDP.

Mirrors odoo/tests/common.py ChromeBrowser: waits for the exact console.log
text "[HOOT] Test suite succeeded" via Runtime.consoleAPICalled, then reads
heap usage via HeapProfiler.collectGarbage + Runtime.getHeapUsage (same calls
ChromeBrowser._handle_console itself makes on success). Also grabs full heap
snapshots before/after for later inspection with memlab if useful.
"""
import asyncio
import json
import re
import subprocess
import sys
import time
import uuid

ENDED_RE = re.compile(r'"([^"]+)" ended')

import requests
import websockets

PORT = int(sys.argv[1])
DB = sys.argv[2]
LABEL = sys.argv[3]
OUT_DIR = sys.argv[4]
FILTER = sys.argv[5] if len(sys.argv) > 5 else ""
CDP_PORT = int(sys.argv[6]) if len(sys.argv) > 6 else 9300 + PORT % 100
BASE = f"http://127.0.0.1:{PORT}"
SUCCESS = "[HOOT] Test suite succeeded"


async def cdp_call(ws, mid_box, method, params=None):
    mid_box[0] += 1
    mid = mid_box[0]
    await ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    while True:
        raw = await ws.recv()
        msg = json.loads(raw)
        if msg.get("id") == mid:
            return msg


def fmt_arg(a):
    if "value" in a:
        return str(a["value"])
    return a.get("description", "")


async def main():
    user_data_dir = f"/tmp/chrome-profile-{LABEL}-{uuid.uuid4().hex[:8]}"
    chrome = subprocess.Popen(
        [
            "google-chrome", "--headless=new", "--no-sandbox", "--disable-gpu",
            "--disable-dev-shm-usage",
            f"--remote-debugging-port={CDP_PORT}",
            f"--user-data-dir={user_data_dir}", "about:blank",
        ],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(60):
            try:
                r = requests.get(f"http://127.0.0.1:{CDP_PORT}/json/version", timeout=1)
                if r.ok:
                    break
            except Exception:
                pass
            time.sleep(0.5)
        else:
            raise RuntimeError("chrome CDP never came up")

        r = requests.put(f"http://127.0.0.1:{CDP_PORT}/json/new?about:blank", timeout=10)
        tab = r.json()
        ws_url = tab["webSocketDebuggerUrl"]

        async with websockets.connect(ws_url, max_size=None) as ws:
            mid = [0]
            await cdp_call(ws, mid, "Network.enable")
            await cdp_call(ws, mid, "Page.enable")
            await cdp_call(ws, mid, "Runtime.enable")
            await cdp_call(ws, mid, "HeapProfiler.enable")

            # Log in from inside the page itself (same-origin fetch) instead of
            # transplanting a session_id cookie captured via a separate `requests`
            # call: Odoo rotates the session id around login, so a cookie grabbed
            # a moment earlier can already be stale by the time it's injected,
            # silently bouncing the next navigation to /web/login.
            print(f"[{LABEL}] logging in...", flush=True)
            await cdp_call(ws, mid, "Page.navigate", {"url": f"{BASE}/web/login"})
            deadline = time.time() + 30
            while time.time() < deadline:
                raw = await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - time.time()))
                msg = json.loads(raw)
                if msg.get("method") == "Page.loadEventFired":
                    break
            login_res = await cdp_call(ws, mid, "Runtime.evaluate", {
                "expression": (
                    "fetch('/web/session/authenticate', {method: 'POST', credentials: 'same-origin', "
                    "headers: {'Content-Type': 'application/json'}, "
                    "body: JSON.stringify({jsonrpc: '2.0', method: 'call', params: "
                    f"{{db: '{DB}', login: 'admin', password: 'admin'}}}})"
                    "}).then(r => r.json()).then(d => JSON.stringify(d))"
                ),
                "awaitPromise": True,
                "returnByValue": True,
            })
            login_value = login_res.get("result", {}).get("result", {}).get("value", "")
            if '"error"' in login_value:
                raise RuntimeError(f"authenticate failed: {login_value[:300]}")
            print(f"[{LABEL}] logged in", flush=True)
            # The authenticate POST resolves once the response body is read,
            # but the browser's own cookie jar has been observed to commit
            # the new (rotated) session cookie slightly after that: a
            # Page.navigate fired immediately after can still race and use
            # the pre-login cookie, landing back on the login page. Give it
            # a moment to settle.
            await asyncio.sleep(1)

            async def get_heap():
                await cdp_call(ws, mid, "HeapProfiler.collectGarbage")
                res = await cdp_call(ws, mid, "Runtime.getHeapUsage")
                return res["result"]

            async def snapshot(path):
                chunks = []
                mid[0] += 1
                take_id = mid[0]
                await ws.send(json.dumps({"id": take_id, "method": "HeapProfiler.takeHeapSnapshot", "params": {}}))
                while True:
                    raw = await ws.recv()
                    msg = json.loads(raw)
                    if msg.get("method") == "HeapProfiler.addHeapSnapshotChunk":
                        chunks.append(msg["params"]["chunk"])
                    elif msg.get("id") == take_id:
                        break
                with open(path, "w") as f:
                    f.write("".join(chunks))
                print(f"[{LABEL}] wrote {path} ({sum(len(c) for c in chunks)} bytes)", flush=True)

            test_url = (
                f"{BASE}/web/tests?headless&loglevel=2&preset=desktop"
                f"&timeout=15000{FILTER}"
            )
            print(f"[{LABEL}] navigating to {test_url}", flush=True)
            await cdp_call(ws, mid, "Page.navigate", {"url": test_url})

            deadline = time.time() + 60
            while time.time() < deadline:
                raw = await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - time.time()))
                msg = json.loads(raw)
                if msg.get("method") == "Page.loadEventFired":
                    break

            print(f"[{LABEL}] page loaded, settling before baseline...", flush=True)
            await asyncio.sleep(3)

            baseline = await get_heap()
            print(f"[{LABEL}] baseline heap: {baseline}", flush=True)
            await snapshot(f"{OUT_DIR}/{LABEL}_baseline.heapsnapshot")

            print(f"[{LABEL}] waiting for '{SUCCESS}' console signal...", flush=True)
            deadline = time.time() + 3600
            status = None
            had_failure = False
            meminfo_lines = []
            while time.time() < deadline:
                raw = await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - time.time()))
                msg = json.loads(raw)
                if msg.get("method") != "Runtime.consoleAPICalled":
                    continue
                params = msg["params"]
                text = " ".join(fmt_arg(a) for a in params.get("args", []))
                if params.get("type") == "error":
                    had_failure = True
                    print(f"[{LABEL}] console.error: {text[:300]}", flush=True)
                if text == SUCCESS:
                    status = "success"
                    break
                if text.startswith("Some tests failed"):
                    status = "failed"
                    print(f"[{LABEL}] {text[:200]}", flush=True)
                    break
                if "[MEMINFO]" in text:
                    meminfo_lines.append(text)
                    print(f"[{LABEL}] {text}", flush=True)
                elif "[HOOT]" in text and ("ended" in text or "Passed" in text or "Failed" in text):
                    print(f"[{LABEL}] {text[:200]}", flush=True)
                    m = ENDED_RE.search(text)
                    if m:
                        suite = m.group(1)
                        h = await get_heap()
                        line = f"[MEMINFO-CDP] {suite} (after GC) - used: {h['usedSize']} - total: {h['totalSize']}"
                        meminfo_lines.append(line)
                        print(f"[{LABEL}] {line}", flush=True)

            print(f"[{LABEL}] done waiting, status={status} had_failure={had_failure}", flush=True)
            await asyncio.sleep(2)

            target = await get_heap()
            print(f"[{LABEL}] target heap: {target}", flush=True)
            await snapshot(f"{OUT_DIR}/{LABEL}_target.heapsnapshot")

            with open(f"{OUT_DIR}/{LABEL}_result.json", "w") as f:
                json.dump({
                    "label": LABEL, "baseline": baseline, "target": target,
                    "status": status, "had_failure": had_failure,
                }, f, indent=2)
            with open(f"{OUT_DIR}/{LABEL}_meminfo.txt", "w") as f:
                f.write("\n".join(meminfo_lines))
    finally:
        chrome.terminate()
        try:
            chrome.wait(timeout=10)
        except Exception:
            chrome.kill()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        import traceback
        print(f"[{LABEL}] FATAL:", flush=True)
        traceback.print_exc()
        raise
