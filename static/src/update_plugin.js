// goo self-update: how the local checkout compares to origin/master (computed by
// the backend at startup, GET /api/goo/update). Surfaces a navbar badge and, when
// it's a clean fast-forward, a one-click "update & restart" that fast-forwards
// goo, restarts the server, waits for it to come back, and reloads the page so the
// new JS/CSS is picked up. Local commits / a dirty tree are never touched.

import { ServerPlugin } from "./server_plugin.js";
import { DialogPlugin } from "./dialog_plugin.js";
import { postJSON } from "./utils.js";

const { Plugin, plugin, signal } = owl;

export class UpdatePlugin extends Plugin {
  server = plugin(ServerPlugin);
  dialogs = plugin(DialogPlugin);
  // { checked, is_repo, branch, behind, ahead, dirty, can_fast_forward } | null
  info = signal(null);
  applying = signal(false); // true while updating + restarting (drives an overlay)

  setup() {
    this._load();
    // the backend re-checks hourly; refresh periodically so the badge appears on
    // long-open tabs without needing a reload
    setInterval(() => this._load(true), 30 * 60 * 1000);
    // …and react immediately when the backend's hourly check pushes a new status
    // over SSE, so the navbar badge appears without waiting for the next poll
    this.server.onGooUpdate((status) => this.info.set(status));
  }

  // on-demand re-check (the Config tab's "Check for update" button): fetch +
  // recompute on the backend, refresh `info`, and return the fresh result
  async check() {
    try {
      const data = await postJSON("/api/goo/check");
      this.info.set(data);
      return data;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // confirm, then (when it's a clean fast-forward) update + restart goo and reload;
  // otherwise explain how to update manually so local work is never clobbered.
  // Only meaningful when behind > 0 (the badge / a positive check gate it).
  async promptUpdate() {
    const u = this.info() || {};
    if (!u.behind) return;
    if (!u.can_fast_forward) {
      let why = `goo is ${u.behind} commit${u.behind === 1 ? "" : "s"} behind origin/master`;
      if (u.ahead) why += `, with ${u.ahead} local commit${u.ahead === 1 ? "" : "s"} on top`;
      if (u.dirty) why += ", and the working tree has uncommitted changes";
      why += ". Update manually to keep your work, e.g. `git pull --rebase`.";
      return void this.dialogs.open({
        title: "goo update available",
        message: why,
        okLabel: "OK",
        cancelLabel: null,
      });
    }
    const serverNote =
      this.server.status().state === "running" ? " The running Odoo server will be stopped." : "";
    const ok = await this.dialogs.open({
      title: "goo update available",
      message: `goo is ${u.behind} commit${u.behind === 1 ? "" : "s"} behind origin/master and can be updated cleanly. goo will fast-forward, restart, and this page will reload automatically.${serverNote}`,
      okLabel: "Update & restart",
      cancelLabel: "Later",
    });
    if (!ok) return;
    const res = await this.applyAndRestart();
    if (!res.ok)
      this.dialogs.open({
        title: "Update failed",
        message: res.error,
        cls: "dialog-error",
        okLabel: "OK",
        cancelLabel: null,
      });
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
