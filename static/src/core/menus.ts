import { Component, onMounted, signal, xml } from "@odoo/owl";
import { appBus } from "./common.ts";

// The appBus payloads that open these menus (dispatched by the screens as
// `new CustomEvent(name, { detail })`): the anchor's rect + the items to list.

// one "action-menu" entry
export interface MenuAction {
  label: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
}

export interface ActionMenuDetail {
  rect: DOMRect;
  actions: MenuAction[];
}

// one "ci-menu" row: a PR's CI check
export interface CiCheck {
  context: string;
  state?: string; // success | failure | pending | … (unknown when unset)
  url?: string;
}

export interface CiMenuDetail {
  rect: DOMRect;
  checks: CiCheck[];
}

// one "mb-menu" row: a repo's mergebot status
export interface MbRow {
  repo: string;
  state: string;
  detail?: string; // the unmet requirements, e.g. "Review, CI"
  cls: string; // the badge color category (mbCategory)
  url?: string;
}

export interface MbMenuDetail {
  rect: DOMRect;
  rows: MbRow[];
}

type Timer = ReturnType<typeof setTimeout>;

export class ActionMenu extends Component {
  static template = xml`
    <div class="dash-menu action-menu" t-att-class="{hidden: !this.open()}" t-on-click.stop="() => {}">
      <button t-foreach="this.actions()" t-as="a" t-key="a_index" class="dash-menu-item"
              t-att-class="{danger: a.danger}" t-att-disabled="a.disabled" t-att-title="a.title || ''"
              t-on-click="() => this.select(a)" t-out="a.label"/>
    </div>`;

  open = signal(false);
  actions = signal<MenuAction[]>([]);
  _el: HTMLElement | null = null;

  setup() {
    onMounted(() => {
      this._el = document.querySelector<HTMLElement>(".action-menu");
      appBus.addEventListener("action-menu", (e) =>
        this.openMenu((e as CustomEvent<ActionMenuDetail>).detail),
      );
      document.addEventListener("click", () => this.open.set(false));
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") this.open.set(false);
      });
    });
  }

  async openMenu({ rect, actions }: ActionMenuDetail) {
    this.actions.set(actions);
    this.open.set(true);
    await Promise.resolve(); // wait a tick so offsetWidth/Height reflect the items
    const el = this._el!; // set in onMounted, before the listener that calls this
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    // open below the anchor; flip above if it would overflow the viewport bottom
    let top = rect.bottom + 4;
    if (top + h > window.innerHeight - 12) top = Math.max(12, rect.top - h - 4);
    el.style.top = `${top}px`;
    // right-align the menu to the kebab, clamped to the viewport
    el.style.left = `${Math.max(12, Math.min(rect.right - w, window.innerWidth - w - 12))}px`;
  }

  select(a: MenuAction) {
    if (a.disabled) return;
    this.open.set(false);
    a.onClick?.();
  }
}

// ─────────────────────────── CI breakdown popover ────────────────────────────

// The full per-check CI status of a PR (runbot, style, lint, security, install,
// upgrade, l10n…), each row linking to its build. Opened via the appBus
// "ci-menu" event with an anchor rect + the checks list; fixed-positioned (like
// ActionMenu) so it escapes overflow-clipped containers.

export class CiMenu extends Component {
  static template = xml`
    <div class="dash-menu ci-menu" t-att-class="{hidden: !this.open()}"
         t-on-mouseenter="() => this.cancelClose()" t-on-mouseleave="() => this.scheduleClose()">
      <a t-foreach="this.checks()" t-as="c" t-key="c_index" class="ci-menu-item" t-att-class="c.state || 'unknown'"
         t-att-href="c.url || undefined" t-att-target="c.url ? '_blank' : undefined">
        <span class="ci-menu-dot"/>
        <span class="ci-menu-ctx" t-out="c.context"/>
        <span class="ci-menu-state" t-out="this.stateLabel(c.state)"/>
      </a>
    </div>`;

  open = signal(false);
  checks = signal<CiCheck[]>([]);
  _el: HTMLElement | null = null;
  _closeTimer: Timer | null = null;

  setup() {
    onMounted(() => {
      this._el = document.querySelector<HTMLElement>(".ci-menu");
      // opened on badge hover; lingers briefly on leave so the mouse can cross the
      // gap into the popover (to use its per-check build links)
      appBus.addEventListener("ci-menu", (e) =>
        this.openMenu((e as CustomEvent<CiMenuDetail>).detail),
      );
      appBus.addEventListener("ci-menu-hide", () => this.scheduleClose());
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") this.close();
      });
    });
  }

  cancelClose() {
    if (this._closeTimer) {
      clearTimeout(this._closeTimer);
      this._closeTimer = null;
    }
  }

  scheduleClose() {
    this.cancelClose();
    this._closeTimer = setTimeout(() => this.open.set(false), 180);
  }

  close() {
    this.cancelClose();
    this.open.set(false);
  }

  async openMenu({ rect, checks }: CiMenuDetail) {
    this.cancelClose(); // moving onto another badge cancels the pending close
    this.checks.set(checks);
    this.open.set(true);
    await Promise.resolve(); // let the list render so offsetWidth/Height are real
    const el = this._el!; // set in onMounted, before the listener that calls this
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let top = rect.bottom + 4;
    if (top + h > window.innerHeight - 12) top = Math.max(12, rect.top - h - 4);
    el.style.top = `${top}px`;
    el.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - w - 12))}px`;
  }

  stateLabel(state: string): string {
    const labels: Record<string, string> = { success: "ok", failure: "ko", pending: "running" };
    return labels[state] || "—";
  }
}

// ─────────────────────────── Mergebot breakdown popover ──────────────────────

// The per-repo mergebot status of a target's PRs (one row per repo), each linking
// to its mergebot page; a blocked row also shows its unmet requirements. Opened
// via the appBus "mb-menu" event with an anchor rect + the rows list;
// fixed-positioned (like CiMenu) so it escapes overflow-clipped containers.

export class MbMenu extends Component {
  static template = xml`
    <div class="dash-menu mb-menu" t-att-class="{hidden: !this.open()}"
         t-on-mouseenter="() => this.cancelClose()" t-on-mouseleave="() => this.scheduleClose()">
      <a t-foreach="this.rows()" t-as="r" t-key="r_index" class="ci-menu-item mb-menu-item" t-att-class="r.cls"
         t-att-href="r.url || undefined" t-att-target="r.url ? '_blank' : undefined">
        <span class="ci-menu-dot"/>
        <span class="ci-menu-ctx" t-out="r.repo"/>
        <span class="ci-menu-state" t-out="this.label(r)"/>
      </a>
    </div>`;

  open = signal(false);
  rows = signal<MbRow[]>([]);
  _el: HTMLElement | null = null;
  _closeTimer: Timer | null = null;

  setup() {
    onMounted(() => {
      this._el = document.querySelector<HTMLElement>(".mb-menu");
      // opened on badge hover; lingers briefly on leave so the mouse can cross the
      // gap into the popover (to use its per-repo mergebot links)
      appBus.addEventListener("mb-menu", (e) =>
        this.openMenu((e as CustomEvent<MbMenuDetail>).detail),
      );
      appBus.addEventListener("mb-menu-hide", () => this.scheduleClose());
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") this.close();
      });
    });
  }

  cancelClose() {
    if (this._closeTimer) {
      clearTimeout(this._closeTimer);
      this._closeTimer = null;
    }
  }

  scheduleClose() {
    this.cancelClose();
    this._closeTimer = setTimeout(() => this.open.set(false), 180);
  }

  close() {
    this.cancelClose();
    this.open.set(false);
  }

  async openMenu({ rect, rows }: MbMenuDetail) {
    this.cancelClose(); // moving onto another badge cancels the pending close
    this.rows.set(rows);
    this.open.set(true);
    await Promise.resolve(); // let the list render so offsetWidth/Height are real
    const el = this._el!; // set in onMounted, before the listener that calls this
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let top = rect.bottom + 4;
    if (top + h > window.innerHeight - 12) top = Math.max(12, rect.top - h - 4);
    el.style.top = `${top}px`;
    el.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - w - 12))}px`;
  }

  // "blocked · Review, CI" — the state word, plus the unmet requirements when present
  label(r: MbRow): string {
    return r.detail ? `${r.state} · ${r.detail}` : r.state;
  }
}

// ─────────────────────────── Remote branch dialog ────────────────────────────
// Search for a branch on GitHub across all configured repos, select one, then
// hand back { branch, repos } to the caller to create a local tracking branch.
