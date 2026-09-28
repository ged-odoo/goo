"""Tests for backend/claude.py — the headless Claude chat (ClaudeManager) and its
persisted review versions.

The real `claude` CLI is replaced by a fake executable prepended to PATH: it reads
the prompt from stdin like the real one and prints a scripted stream-json sequence
chosen by the prompt text. Assertions are on what a chat user sees: the items
pushed on the bus, the transcript, the review files on disk.

Run from the repo root: `python3 -m unittest discover`
"""

import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock

from backend import claude
from backend.claude import ClaudeManager

FAKE_CLAUDE = """\
import json, os, sys, time

args = sys.argv[1:]
prompt = sys.stdin.read()


def opt(name):
    return args[args.index(name) + 1] if name in args else None


def emit(obj):
    print(json.dumps(obj), flush=True)


def say(*blocks):
    emit({"type": "assistant", "message": {"content": list(blocks)}})


def text(t):
    return {"type": "text", "text": t}


def done(**kw):
    emit({"type": "result", "is_error": False, "total_cost_usd": 0.25, **kw})


resume = opt("--resume")
emit({"type": "system", "subtype": "init", "session_id": resume or "sess-1"})

if prompt == "whoami":
    add_dirs = [args[i + 1] for i, a in enumerate(args) if a == "--add-dir"]
    context = ""
    if os.environ.get("CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD") == "1":
        for d in add_dirs:
            p = os.path.join(d, ".claude", "CLAUDE.md")
            if os.path.exists(p):
                context += open(p).read()
    say(text(f"cwd={os.getcwd()}"))
    say(text(f"model={opt('--model')} resume={resume} mode={opt('--permission-mode')}"))
    say(text(f"dirs={len(add_dirs)} context={context}"))
    done()
elif prompt == "tools":
    say(
        text("  working on it  "),
        text("   "),
        {"type": "tool_use", "name": "Edit", "input": {"file_path": "/x/y/models.py"}},
        {"type": "tool_use", "name": "Bash", "input": {"command": "git   status\\n -s"}},
        {"type": "tool_use", "name": "Grep", "input": {"pattern": "def foo"}},
        {"type": "tool_use", "name": "Task", "input": {"description": "explore"}},
        {"type": "tool_use", "name": "WebFetch", "input": {"url": "https://x.test"}},
        {"type": "tool_use", "name": "NotebookEdit", "input": {"notebook_path": "/n/a.ipynb"}},
        {"type": "tool_use", "name": "TodoWrite", "input": {"todos": []}},
        {"type": "tool_use", "name": "Read"},
    )
    done()
elif prompt == "fail":
    say(text("trying"))
    emit({"type": "result", "is_error": True, "result": "rate limited"})
elif prompt == "fail-bare":
    emit({"type": "result", "is_error": True})
elif prompt == "crash":
    print("Traceback (most recent call last):", flush=True)
    print("RuntimeError: boom", flush=True)
    sys.exit(3)
elif prompt == "silent":
    sys.exit(2)
elif prompt == "hang":
    say(text("thinking..."))
    time.sleep(30)
elif prompt.startswith("review"):
    say(text("## Findings"), {"type": "tool_use", "name": "Read", "input": {}})
    say(text(f"LGTM ({prompt})"))
    done()
elif prompt == "many":
    for i in range(10):
        say(text(f"part {i}"))
    done()
else:
    say(text(f"echo: {prompt}"))
    done()
"""


class RecordingBus:
    def __init__(self):
        self.lock = threading.Lock()
        self.claude = []
        self.logs = []

    def publish_claude(self, payload):
        with self.lock:
            self.claude.append(payload)

    def publish_log(self, line, server="main"):
        with self.lock:
            self.logs.append(line)

    def items(self, target="w1"):
        with self.lock:
            return [
                {k: v for k, v in p.items() if k != "workspace"}
                for p in self.claude
                if p["workspace"] == target
            ]


class FakeGit:
    """Only what ClaudeManager.send() uses: the branch + writing the dev context."""

    def __init__(self, branch="17.0-feature"):
        self.branch = branch

    def current_branch(self, path):
        return self.branch

    def write_dev_context(self, out_dir, community_path, branch):
        os.makedirs(os.path.join(out_dir, ".claude"), exist_ok=True)
        with open(os.path.join(out_dir, ".claude", "CLAUDE.md"), "w") as f:
            f.write(f"branch {branch}")


def wait_for(cond, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cond():
            return
        time.sleep(0.005)
    raise AssertionError("condition not met before timeout")


def join_readers(timeout=5.0):
    for t in threading.enumerate():
        if t is not threading.current_thread() and "_reader" in t.name:
            t.join(timeout)


class ClaudeTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="goo-test-claude-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        bindir = os.path.join(self.tmp, "bin")
        os.makedirs(bindir)
        exe = os.path.join(bindir, "claude")
        with open(exe, "w") as f:
            f.write(f"#!{sys.executable} -S\n{FAKE_CLAUDE}")
        os.chmod(exe, 0o755)
        env = unittest.mock.patch.dict(
            os.environ, {"PATH": bindir + os.pathsep + os.environ.get("PATH", "")}
        )
        env.start()
        self.addCleanup(env.stop)
        self.wt = os.path.join(self.tmp, "wt")
        os.makedirs(self.wt)
        self.reviews = os.path.join(self.tmp, "reviews")
        self.bus = RecordingBus()
        self.mgr = ClaudeManager(self.bus, self.reviews)
        self.addCleanup(join_readers)
        self.addCleanup(self.mgr.shutdown)
        self.git = FakeGit()

    def send(self, prompt, target="w1", **kw):
        return self.mgr.send(target, prompt, kw.pop("cwd", self.wt), git=self.git, **kw)

    def turn(self, prompt, target="w1", **kw):
        """Send and wait until the turn's result item arrives; return the new items."""
        before = len(self.bus.items(target))
        ok, detail = self.send(prompt, target, **kw)
        self.assertTrue(ok, detail)
        wait_for(lambda: any(i["role"] == "result" for i in self.bus.items(target)[before:]))
        return self.bus.items(target)[before:]

    def texts(self, items):
        return [i["text"] for i in items if i["role"] == "assistant"]


class TestChatTurns(ClaudeTestCase):
    def test_simple_turn_streams_reply_and_result(self):
        items = self.turn("hi there")
        self.assertEqual(
            items,
            [
                {"role": "assistant", "text": "echo: hi there"},
                {"role": "result", "ok": True, "cost": 0.25},
            ],
        )
        self.assertEqual(self.mgr.history_for("w1")["state"], "idle")

    def test_history_keeps_user_prompt_but_bus_does_not_echo_it(self):
        self.turn("hi there")
        hist = self.mgr.history_for("w1")
        self.assertEqual(hist["items"][0], {"role": "user", "text": "hi there"})
        self.assertEqual([i["role"] for i in hist["items"]], ["user", "assistant", "result"])
        self.assertNotIn("user", [i["role"] for i in self.bus.items()])

    def test_tool_activity_is_summarized(self):
        items = self.turn("tools")
        self.assertEqual(items[0], {"role": "assistant", "text": "working on it"})
        tools = [(i["tool"], i["text"]) for i in items if i["role"] == "tool"]
        self.assertEqual(
            tools,
            [
                ("Edit", "models.py"),
                ("Bash", "git status -s"),
                ("Grep", "def foo"),
                ("Task", "explore"),
                ("WebFetch", "https://x.test"),
                ("NotebookEdit", "a.ipynb"),
                ("TodoWrite", ""),
                ("Read", ""),
            ],
        )

    def test_runs_in_worktree_with_full_autonomy_and_model(self):
        items = self.turn("whoami", model="opus[1m]")
        texts = self.texts(items)
        self.assertEqual(texts[0], f"cwd={os.path.realpath(self.wt)}")
        self.assertEqual(texts[1], "model=opus[1m] resume=None mode=bypassPermissions")

    def test_fresh_conversation_gets_dev_context_for_current_branch(self):
        extra = os.path.join(self.tmp, "enterprise")
        os.makedirs(extra)
        self.git.branch = "18.0-my-fix"
        texts = self.texts(self.turn("whoami", add_dirs=[extra, ""]))
        # the extra dir + the generated context dir, whose CLAUDE.md claude reads
        self.assertEqual(texts[2], "dirs=2 context=branch 18.0-my-fix")

    def test_next_turn_resumes_the_session(self):
        self.turn("hello")
        texts = self.texts(self.turn("whoami"))
        self.assertIn("resume=sess-1", texts[1])
        # the context dir from the first turn is still passed along
        self.assertEqual(texts[2], "dirs=1 context=branch 17.0-feature")

    def test_conversations_are_per_target(self):
        self.turn("hello", target="w1")
        texts = self.texts(self.turn("whoami", target="w2"))
        self.assertIn("resume=None", texts[1])
        self.assertEqual(self.bus.items("w2")[0]["role"], "assistant")
        self.assertEqual(len(self.mgr.history_for("w1")["items"]), 3)

    def test_tilde_cwd_is_expanded(self):
        with unittest.mock.patch.dict(os.environ, {"HOME": self.tmp}):
            texts = self.texts(self.turn("whoami", cwd="~/wt"))
        self.assertEqual(texts[0], f"cwd={os.path.realpath(self.wt)}")


class TestFailures(ClaudeTestCase):
    def test_missing_prompt_or_target(self):
        self.assertEqual(self.send("   "), (False, "missing workspace or prompt"))
        self.assertEqual(self.send("hi", target=""), (False, "missing workspace or prompt"))
        self.assertEqual(self.bus.claude, [])

    def test_missing_worktree(self):
        ok, detail = self.send("hi", cwd=os.path.join(self.tmp, "nope"))
        self.assertFalse(ok)
        self.assertIn("worktree checkout not found", detail)
        self.assertEqual(self.mgr.history_for("w1"), {"items": [], "state": "idle"})

    def test_error_result_is_reported(self):
        items = self.turn("fail")
        self.assertEqual(
            items[-1], {"role": "result", "ok": False, "cost": None, "error": "rate limited"}
        )
        items = self.turn("fail-bare")
        self.assertEqual(items[-1]["error"], "claude reported an error")

    def test_crash_surfaces_its_output(self):
        items = self.turn("crash")
        self.assertEqual(
            items,
            [
                {"role": "error", "text": "Traceback (most recent call last):\nRuntimeError: boom"},
                {"role": "result", "ok": False},
            ],
        )
        self.assertEqual(self.mgr.history_for("w1")["state"], "idle")

    def test_silent_exit_reports_exit_code(self):
        items = self.turn("silent")
        self.assertEqual(
            items[0], {"role": "error", "text": "claude exited (code 2) with no result"}
        )
        self.assertEqual(items[1], {"role": "result", "ok": False})

    def test_claude_not_on_path(self):
        empty = os.path.join(self.tmp, "empty")
        os.makedirs(empty)
        with unittest.mock.patch.dict(os.environ, {"PATH": empty}):
            ok, _ = self.send("hi")
        self.assertFalse(ok)
        items = self.bus.items()
        self.assertEqual(items[0]["role"], "error")
        self.assertIn("could not launch claude", items[0]["text"])
        self.assertEqual(items[1], {"role": "result", "ok": False})
        # not stuck running: a retry once claude is available works
        self.assertEqual(self.texts(self.turn("again")), ["echo: again"])


class TestStop(ClaudeTestCase):
    def start_hanging(self, target="w1"):
        ok, detail = self.send("hang", target)
        self.assertEqual((ok, detail), (True, {"state": "running"}))
        wait_for(lambda: self.bus.items(target))
        process = self.mgr.convos[target]["process"]
        self.assertIsNone(process.poll())
        return process

    def test_one_run_at_a_time(self):
        self.start_hanging()
        self.assertEqual(self.mgr.history_for("w1")["state"], "running")
        self.assertEqual(self.send("again"), (False, "already_running"))

    def test_stop_kills_the_run_and_the_conversation_carries_on(self):
        process = self.start_hanging()
        self.assertEqual(self.mgr.stop("w1"), (True, "stopped"))
        self.assertIsNotNone(process.poll())
        join_readers()
        self.assertEqual(self.bus.items()[-1], {"role": "result", "ok": True})
        self.assertEqual(self.mgr.history_for("w1")["state"], "idle")
        self.assertIn("resume=sess-1", self.texts(self.turn("whoami"))[1])

    def test_stop_does_not_report_the_interrupted_turn_as_an_error(self):
        self.start_hanging()
        real_terminate = claude.terminate_process

        def terminate_then_let_reader_finish(process):
            real_terminate(process)
            join_readers()

        with unittest.mock.patch.object(
            claude, "terminate_process", side_effect=terminate_then_let_reader_finish
        ):
            self.mgr.stop("w1")
        join_readers()
        self.assertEqual(
            self.bus.items(),
            [
                {"role": "assistant", "text": "thinking..."},
                {"role": "result", "ok": True},
            ],
        )

    def test_stop_when_idle_is_harmless(self):
        self.assertEqual(self.mgr.stop("nobody"), (True, "stopped"))
        self.assertEqual(self.bus.items("nobody"), [{"role": "result", "ok": True}])

    def test_stop_reports_a_failure_to_kill(self):
        process = self.start_hanging()
        self.addCleanup(claude.terminate_process, process)
        with unittest.mock.patch.object(
            claude, "terminate_process", side_effect=RuntimeError("nope")
        ):
            self.mgr.stop("w1")
        self.assertTrue(any("error stopping claude" in line for line in self.bus.logs))
        self.assertEqual(self.mgr.history_for("w1")["state"], "idle")

    def test_shutdown_stops_runs_and_removes_context_dirs(self):
        p1 = self.start_hanging("w1")
        self.turn("hello", target="w2")
        ctx_dirs = [self.mgr.convos[t]["ctx_dir"] for t in ("w1", "w2")]
        self.assertTrue(all(os.path.isdir(d) for d in ctx_dirs))
        self.mgr.shutdown()
        self.assertIsNotNone(p1.poll())
        self.assertFalse(any(os.path.exists(d) for d in ctx_dirs))

    def test_forget_drops_conversation_context_and_reviews(self):
        self.turn("review it", review=True)
        ctx = self.mgr.convos["w1"]["ctx_dir"]
        self.assertTrue(self.mgr.review_text("w1")["text"])
        self.mgr.forget("w1")
        self.assertFalse(os.path.exists(ctx))
        self.assertEqual(self.mgr.history_for("w1"), {"items": [], "state": "idle"})
        self.assertEqual(self.mgr.review_text("w1")["versions"], [])
        # a new conversation starts fresh
        self.assertIn("resume=None", self.texts(self.turn("whoami"))[1])


class TestReviews(ClaudeTestCase):
    def test_review_turn_is_persisted_as_markdown(self):
        self.turn("review one", review=True)
        rv = self.mgr.review_text("w1")
        self.assertEqual(rv["text"], "## Findings\n\nLGTM (review one)")
        self.assertEqual((rv["version"], rv["versions"]), (1, [1]))
        self.assertIsInstance(rv["created"], float)

    def test_ordinary_turns_are_not_persisted(self):
        self.turn("review one", review=True)
        self.turn("review two")
        self.assertEqual(self.mgr.review_text("w1")["versions"], [1])

    def test_failed_review_is_not_persisted(self):
        self.turn("fail", review=True)
        self.assertEqual(self.mgr.review_text("w1")["versions"], [])

    def test_versions_accumulate_and_are_selectable(self):
        self.turn("review one", review=True)
        self.turn("review two", review=True)
        latest = self.mgr.review_text("w1")
        self.assertEqual((latest["version"], latest["versions"]), (2, [1, 2]))
        self.assertIn("review two", latest["text"])
        self.assertIn("review one", self.mgr.review_text("w1", 1)["text"])
        self.assertEqual(self.mgr.review_text("w1", 99)["version"], 2)

    def test_no_review(self):
        self.assertEqual(
            self.mgr.review_text("w1"),
            {"text": "", "version": None, "versions": [], "created": None},
        )

    def test_review_only_keeps_its_own_turn_even_when_history_is_trimmed(self):
        self.mgr.HISTORY_MAX = 4
        self.turn("hello")
        self.turn("many", review=True)
        text = self.mgr.review_text("w1")["text"]
        self.assertNotIn("echo: hello", text)
        self.assertTrue(text.endswith("part 9"))

    def test_review_survives_restart(self):
        self.turn("review one", review=True)
        fresh = ClaudeManager(RecordingBus(), self.reviews)
        self.assertEqual(
            fresh.history_for("w1"),
            {
                "items": [{"role": "assistant", "text": "## Findings\n\nLGTM (review one)"}],
                "state": "idle",
            },
        )
        self.assertEqual(fresh.history_for("other"), {"items": [], "state": "idle"})

    def test_hostile_target_stays_inside_reviews_dir(self):
        for target in ("../../evil", "..."):
            self.turn("review x", target=target, review=True)
        self.assertEqual(sorted(os.listdir(self.reviews)), ["evil", "workspace"])
        self.assertEqual(self.mgr.review_text("../../evil")["versions"], [1])


if __name__ == "__main__":
    unittest.main()
