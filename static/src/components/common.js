import {
  Component,
  EventBus,
  markup,
  onMounted,
  onWillUnmount,
  plugin,
  props,
  signal,
  t,
  useEffect,
  xml,
} from "@odoo/owl";
import { CodePlugin } from "../plugins/code_plugin.js";
import { ServerPlugin } from "../plugins/server_plugin.js";

export const appBus = new EventBus();

export const m = (s) => markup(s);

// map a mergebot state string to its color category (the badge's CSS class)

export function mbCategory(s) {
  if (s === "merged") return "merged";
  if (["ready", "approved", "validated", "mergeable", "reviewed"].includes(s)) return "ready";
  if (["staged", "staging", "squashed", "pending"].includes(s)) return "progress";
  if (["blocked", "error"].includes(s)) return "blocked";
  return "other";
}

export const ICONS = {
  dashboard: `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-.6 4"/><polyline points="20 4 20 11 13 11"/></svg>`,
  clear: `<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13"/></svg>`,
  copy: `<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`,
  star: `<svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z"/></svg>`,
  server: `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><circle cx="7" cy="7.5" r="1" fill="currentColor" stroke="none"/><circle cx="7" cy="16.5" r="1" fill="currentColor" stroke="none"/></svg>`,
  code: `<svg viewBox="0 0 24 24"><polyline points="8.5 8 4.5 12 8.5 16"/><polyline points="15.5 8 19.5 12 15.5 16"/></svg>`,
  target: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><line x1="12" y1="1.5" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22.5"/><line x1="1.5" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22.5" y2="12"/></svg>`,
  branches: `<svg viewBox="0 0 24 24"><line x1="6" y1="4" x2="6" y2="15"/><circle cx="6" cy="18" r="2.6"/><circle cx="18" cy="6" r="2.6"/><path d="M18 8.6c0 5.4-4 5.4-9 7.4"/></svg>`,
  pr: `<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="6" y1="9" x2="6" y2="15"/><circle cx="18" cy="18" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/></svg>`,
  tests: `<svg viewBox="0 0 24 24"><path d="M9 3h6"/><path d="M10 3v6.5L4.8 18a2 2 0 0 0 1.8 3h10.8a2 2 0 0 0 1.8-3L14 9.5V3"/><path d="M7.5 14h9"/></svg>`,
  databases: `<svg viewBox="0 0 24 24"><ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/><path d="M4 11.5v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/></svg>`,
  addons: `<svg viewBox="0 0 24 24"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5"/><path d="M12 12v9"/></svg>`,
  assets: `<svg viewBox="0 0 24 24"><polygon points="12 2 22 7 12 12 2 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`,
  config: `<svg viewBox="0 0 24 24"><line x1="4" y1="8" x2="20" y2="8"/><line x1="4" y1="16" x2="20" y2="16"/><circle cx="15" cy="8" r="2.4" class="knob"/><circle cx="9" cy="16" r="2.4" class="knob"/></svg>`,
  kebab: `<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.7" fill="currentColor" stroke="none"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>`,
  check: `<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>`,
  push: `<svg viewBox="0 0 24 24"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="6 11 12 5 18 11"/></svg>`,
  play: `<svg viewBox="0 0 24 24"><polygon points="6 4 20 12 6 20 6 4" fill="currentColor" stroke="none"/></svg>`,
  stop: `<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/></svg>`,
  external: `<svg viewBox="0 0 24 24"><path d="M7 17 17 7M9 7h8v8"/></svg>`,
  journal: `<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="2"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="13" y2="16"/></svg>`,
  terminal: `<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="6 9 10 12 6 15"/><line x1="12" y1="15" x2="18" y2="15"/></svg>`,
  history: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><line x1="2.5" y1="12" x2="8.8" y2="12"/><line x1="15.2" y1="12" x2="21.5" y2="12"/></svg>`,
  worktree: `<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="2.4"/><line x1="6" y1="8.4" x2="6" y2="20"/><path d="M6 12h6a2 2 0 0 1 2 2v1"/><rect x="14" y="9" width="7" height="6" rx="1.5"/></svg>`,
  nightly: `<svg viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
  memory: `<svg viewBox="0 0 24 24"><polyline points="2 17 6 11 10 13 14 7 18 10 22 4"/><polyline points="22 4 22 9 17 9"/></svg>`,
};

export const NAV = [
  { id: "dashboard", label: "Dashboard", icon: ICONS.dashboard },
  { id: "code", label: "Code", icon: ICONS.code },
  { id: "targets", label: "Targets", icon: ICONS.target },
  { id: "server", label: "Server", icon: ICONS.server },
  { id: "worktree", label: "Worktrees", icon: ICONS.worktree, optIn: true },
  { id: "tests", label: "Tests", icon: ICONS.tests },
  { id: "branches", label: "Branches", icon: ICONS.branches },
  { id: "prs", label: "PRs", icon: ICONS.pr },
  { id: "assets", label: "Assets", icon: ICONS.assets },
  { id: "addons", label: "Addons", icon: ICONS.addons },
  { id: "databases", label: "Databases", icon: ICONS.databases },
  { id: "nightly", label: "Nightly", icon: ICONS.nightly, optIn: true },
  { id: "memory", label: "Memory", icon: ICONS.memory, optIn: true },
  { id: "config", label: "Configuration", icon: ICONS.config },
];
// Merge a saved tab config with NAV → the ordered list of tab ids to show. The
// user's order is preserved for tabs they've configured; any NAV tab missing from
// their config (e.g. a newly-shipped one) is inserted at its natural NAV position
// — right after its NAV predecessor — instead of tacked on at the end.

export function mergedTabIds(configured) {
  const inNav = new Set(NAV.map((n) => n.id));
  const out = [];
  const seen = new Set();
  for (const t of configured || []) {
    if (!inNav.has(t.id) || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t.id);
  }
  let anchor = -1; // index in `out` of the last NAV tab we've placed/seen
  for (const n of NAV) {
    const idx = out.indexOf(n.id);
    if (idx !== -1) {
      anchor = idx;
    } else {
      out.splice(++anchor, 0, n.id);
    }
  }
  return out;
}
// ─────────────────────────── Topbar ───────────────────────────

export class LogConsole extends Component {
  static template = xml`
    <section class="console" t-att-class="this.consoleClass">
      <div t-if="!this.props.bare" class="log-toolbar">
        <span class="console-title"><span class="cdot" t-att-class="{on: this.live}"/><t t-out="this.props.title"/></span>
        <div class="toolbar-right">
          <label class="toggle" t-att-class="{on: this.props.buffer.autoScroll()}" t-on-click="() => this.toggleAuto()"><span class="switch"/>Autoscroll</label>
          <button class="tool-btn" t-on-click="() => this.props.buffer.clear()"><t t-out="this.clearIcon"/>Clear</button>
        </div>
      </div>
      <div class="log-host" t-ref="this.host"/>
    </section>`;

  props = props({
    title: t.string(),
    buffer: t.any(),
    extraClass: t.string().optional(),
    bare: t.boolean().optional(),
  });

  server = plugin(ServerPlugin);
  host = signal.ref(HTMLElement);
  clearIcon = m(ICONS.clear);

  setup() {
    onMounted(() => {
      this.host().appendChild(this.props.buffer.el);
      this.props.buffer.restore();
    });
    onWillUnmount(() => {
      this.props.buffer.savedScroll = this.props.buffer.el.scrollTop;
    });
  }

  get live() {
    return this.server.status().state === "running";
  }

  get consoleClass() {
    return [this.props.extraClass, this.props.bare ? "bare" : ""].filter(Boolean).join(" ");
  }

  toggleAuto() {
    const b = this.props.buffer;
    b.autoScroll.set(!b.autoScroll());
    if (b.autoScroll()) b.toBottom();
  }
}

// ─────────────────────────── Search box ───────────────────────────

// Reusable search input with a clear (✕) button; `value` is a signal.

export class SearchBox extends Component {
  static template = xml`
    <div class="search-box">
      <input type="text" t-att-value="this.props.value()" autocomplete="off" placeholder="Search…"
             t-on-input="ev => this.props.value.set(ev.target.value)"/>
      <button t-if="this.props.value()" class="search-clear" title="clear search" t-on-click="() => this.props.value.set('')">✕</button>
    </div>`;

  props = props({ value: t.any() });
}

// ─────────────────────────── Dirty badge + menu ──────────────────────────────

export class DirtyBadge extends Component {
  static template = xml`
    <button class="dirty-badge" t-on-click.stop="(ev) => this.openMenu(ev)" title="uncommitted changes">dirty</button>`;

  props = props({ path: t.string(), repo: t.string() });
  openMenu(ev) {
    const rect = ev.currentTarget.getBoundingClientRect();
    appBus.dispatchEvent(
      new CustomEvent("dirty-menu", {
        detail: { rect, path: this.props.path, repo: this.props.repo },
      }),
    );
  }
}

export class DirtyMenu extends Component {
  static template = xml`
    <div class="dash-menu dirty-menu" t-att-class="{hidden: !this.open()}" t-on-click.stop="() => {}">
      <button class="dash-menu-item" t-on-click="() => this.wipCommit()">WIP commit</button>
      <button class="dash-menu-item danger" t-on-click="() => this.discard()">Discard changes</button>
    </div>`;

  code = plugin(CodePlugin);
  open = signal(false);
  _path = null;
  _repo = null;
  _el = null;

  setup() {
    onMounted(() => {
      this._el = document.querySelector(".dirty-menu");
      appBus.addEventListener("dirty-menu", (e) => this.openMenu(e.detail));
      document.addEventListener("click", () => this.open.set(false));
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") this.open.set(false);
      });
    });
  }

  async openMenu({ rect, path, repo }) {
    this._path = path;
    this._repo = repo;
    this.open.set(true);
    await Promise.resolve();
    const w = this._el.offsetWidth;
    this._el.style.top = `${rect.bottom + 4}px`;
    this._el.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - w - 12))}px`;
  }

  wipCommit() {
    this.open.set(false);
    this.code.wipCommit(this._path, this._repo);
  }

  discard() {
    this.open.set(false);
    this.code.discard(this._path, this._repo);
  }
}

// ─────────────────────────── Dashboard screen ───────────────────────────

// Per-target view of the code state: for each target, the git/runbot/PR state
// of every repo:branch in its config. Reuses CodePlugin's branch + PR data.

export function loadScript(src, isLoaded) {
  return new Promise((resolve, reject) => {
    if (isLoaded()) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

// lazy-load Chart.js + its zoom/pan plugin (both vendored, not a CDN) on first
// use — shared by the Nightly and Memory panels, each of which draws its own
// line chart(s) on a <canvas>. Wheel-zooms and drag-pans; no pinch (that needs
// hammer.js too, and this is a desktop dev tool).

export function useDragResize({ w = 780, h = 440, place = null } = {}) {
  const handle = signal.ref(HTMLElement);
  let x = 0;
  let y = 0;
  let width = w;
  let height = h;
  let placed = false;
  let dragging = false;
  let resizing = false;
  let offX = 0;
  let offY = 0;
  let startX = 0;
  let startY = 0;
  let startW = 0;
  let startH = 0;
  const apply = () => {
    const el = handle();
    if (!el) return;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
  };
  const onMouseMove = (e) => {
    if (dragging) {
      x = Math.max(0, e.clientX - offX);
      y = Math.max(0, e.clientY - offY);
      apply();
    } else if (resizing) {
      width = Math.max(300, startW + e.clientX - startX);
      height = Math.max(200, startH + e.clientY - startY);
      apply();
    }
  };
  const onMouseUp = () => {
    dragging = false;
    resizing = false;
  };
  onMounted(() => {
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });
  onWillUnmount(() => {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  });
  // when the panel root (re)mounts, center it once then write the position
  // directly. The effect runs before the browser paints, so there is no flash;
  // x/y persist in this closure, so a dragged window keeps its spot if reshown.
  useEffect(() => {
    const el = handle();
    if (!el) return;
    if (!placed) {
      const p = place ? place(width, height) : null;
      x = p ? p.x : Math.max(0, Math.floor((window.innerWidth - width) / 2));
      y = p ? p.y : Math.max(0, Math.floor((window.innerHeight - height) / 2));
      placed = true;
    }
    apply();
  });
  return {
    handle,
    onDragStart: (e) => {
      if (e.button !== 0) return;
      dragging = true;
      offX = e.clientX - x;
      offY = e.clientY - y;
      e.preventDefault();
    },
    onResizeStart: (e) => {
      if (e.button !== 0) return;
      resizing = true;
      startX = e.clientX;
      startY = e.clientY;
      startW = width;
      startH = height;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}
