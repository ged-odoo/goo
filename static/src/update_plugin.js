// goo self-update: how the local checkout compares to origin/master (computed by
// the backend at startup, GET /api/goo/update). Surfaces a navbar badge and, when
// it's a clean fast-forward, a one-click "update & restart" that fast-forwards
// goo, restarts the server, waits for it to come back, and reloads the page so the
// new JS/CSS is picked up. Local commits / a dirty tree are never touched.

import { postJSON } from "./utils.js";

const { Plugin, signal } = owl;

export class UpdatePlugin extends Plugin {
  // { checked, is_repo, branch, behind, ahead, dirty, can_fast_forward } | null
  info = signal(null);
  applying = signal(false); // true while updating + restarting (drives an overlay)

  setup() {
    this._load();
    // the backend re-checks hourly; refresh periodically so the badge appears on
    // long-open tabs without needing a reload
    setInterval(() => this._load(true), 30 * 60 * 1000);
  }

  async _load(retried = false) {
    try {
      const data = await (await fetch("/api/goo/update", { cache: "no-store" })).json();
      this.info.set(data);
      // the startup `git fetch` may not have finished when the UI first loaded —
      // re-check once shortly after so the badge still appears
      if (!data.checked && !retried) setTimeout(() => this._load(true), 3000);
    } catch {
      /* offline / endpoint missing — no badge */
    }
  }

  // fast-forward goo onto origin/master, restart the server, then reload the page
  // once it's back. Returns { ok, error }; on success the page is reloading.
  async applyAndRestart() {
    this.applying.set(true);
    const boot = this.info()?.boot; // remember this process so we can detect the new one
    try {
      await postJSON("/api/goo/update"); // git merge --ff-only (backend re-validates)
      await postJSON("/api/goo/restart").catch(() => {}); // re-exec; the reply may not arrive
      if (await this._waitUntilRestarted(boot)) {
        location.reload(); // pick up the new JS/CSS (page goes away here)
        return { ok: true };
      }
      this.applying.set(false);
      return { ok: false, error: "goo was updated but didn't come back — restart it manually." };
    } catch (e) {
      this.applying.set(false);
      return { ok: false, error: e.message };
    }
  }

  // wait until the re-exec'd goo is serving: a changed boot id is the reliable
  // signal (the old, still-shutting-down server keeps the old id); fall back to
  // "saw it go down, then back up" if we never had a boot id to compare.
  async _waitUntilRestarted(boot, timeout = 30000) {
    const t0 = Date.now();
    let wentDown = false;
    await new Promise((r) => setTimeout(r, 600));
    while (Date.now() - t0 < timeout) {
      try {
        const data = await (await fetch("/api/goo/update", { cache: "no-store" })).json();
        if (boot ? data.boot && data.boot !== boot : wentDown) return true;
      } catch {
        wentDown = true; // observed the restart gap
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  }
}
