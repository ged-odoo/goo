// Fixtures for the Workspaces screen's Code tab / history / create-delete dialog tests:
// a workspace record, a fake git backend for /api/code/branches, PR wire records,
// and DOM helpers to drive menus and the generic Dialog.
import type { WorkspaceConfig } from "../../src/core/config.ts";
import type { BranchInfo, ForwardPortRow, RepoStatusWire } from "../../src/core/observed_models.ts";
import type { PullRequestWire } from "../../src/core/models.ts";

export function workspace(over: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return {
    id: "w1",
    name: "master-feat",
    created_at: "2026-01-01T00:00:00Z",
    last_activity: "2026-01-01T00:00:00Z",
    favorite: false,
    category: "",
    parent: "",
    notes: "",
    db: "master-feat",
    on_create_args: "",
    demo_data: false,
    location: "main",
    worktree: null,
    port: null,
    checkouts: [
      { repo: "community", branch: "master-feat" },
      { repo: "enterprise", branch: "master-feat" },
    ],
    ...over,
  };
}

export function branch(name: string, over: Partial<BranchInfo> = {}): BranchInfo {
  return {
    name,
    date: "2026-01-01T00:00:00Z",
    subject: `work on ${name}`,
    sha: `sha-${name}`,
    remote: true,
    synced: false,
    ...over,
  };
}

// one repo's live git state, as the backend's /api/code/branches reports it
export type FakeRepo = Omit<RepoStatusWire, "id">;

// a mutable fake git backend: tests edit `repos` and the next scan reflects it
export function gitBackend(repos: Record<string, FakeRepo>): {
  repos: Record<string, FakeRepo>;
  route: (body: unknown) => { repos: RepoStatusWire[] };
} {
  const backend = {
    repos,
    route: (body: unknown) => {
      const asked = (body as { repos: { id: string }[] }).repos.map((r) => r.id);
      return {
        repos: asked
          .filter((id) => id in backend.repos)
          .map((id) => ({ id, ...backend.repos[id] })),
      };
    },
  };
  return backend;
}

// both repos on master-feat, 1 ahead / 2 behind master, pushed but not in sync
export function featRepos(over: Partial<FakeRepo> = {}): Record<string, FakeRepo> {
  const repo = (id: string): FakeRepo => ({
    current: "master-feat",
    dirty: false,
    ahead: 1,
    behind: 2,
    branches: [branch("master-feat", { sha: `sha-${id}`, subject: `feat ${id}` })],
    ...over,
  });
  return { community: repo("community"), enterprise: repo("enterprise") };
}

export function prWire(over: Partial<PullRequestWire> = {}): PullRequestWire {
  return {
    github: "odoo/odoo",
    number: 101,
    title: "a PR",
    url: "https://github.com/odoo/odoo/pull/101",
    state: "open",
    draft: false,
    branch: "master-feat",
    relation: "authored",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    ci: null,
    ...over,
  };
}

// /api/prs reply: the given PRs grouped onto their configured repo ids
export function prsReply(byRepo: Record<string, PullRequestWire[]>): unknown {
  return {
    repos: Object.entries(byRepo).map(([id, prs]) => ({
      id,
      github: prs[0]?.github ?? "",
      prs,
    })),
  };
}

export function forwardPortRow(
  branchName: string,
  pulls: { repository: string; number?: number; status?: string; detail?: string }[],
): ForwardPortRow {
  return {
    branch: branchName,
    cells: pulls.map((p) => ({
      repository: p.repository,
      pulls: p.number
        ? [
            {
              github: p.repository,
              number: p.number,
              status: p.status ?? "ok",
              detail: p.detail ?? "",
              category: "success",
            },
          ]
        : [],
    })),
  };
}

// ── DOM helpers ──────────────────────────────────────────────────────────────

const text = (el: Element) => (el.textContent || "").trim();

export function byText<T extends HTMLElement = HTMLButtonElement>(
  root: ParentNode,
  label: string,
  selector = "button",
): T | undefined {
  return [...root.querySelectorAll<T>(selector)].find((b) => text(b) === label);
}

export function mustText<T extends HTMLElement = HTMLButtonElement>(
  root: ParentNode,
  label: string,
  selector = "button",
): T {
  const el = byText<T>(root, label, selector);
  if (!el) throw new Error(`no ${selector} labelled "${label}"`);
  return el;
}

// the checkout card of one repo in the Code tab
export function card(root: ParentNode, repo: string): HTMLElement {
  const found = [...root.querySelectorAll<HTMLElement>(".ws-co-card")].find(
    (c) => text(c.querySelector(".ws-repo-tag")!) === repo,
  );
  if (!found) throw new Error(`no checkout card for ${repo}`);
  return found;
}

export function menuItems(root: ParentNode): string[] {
  return [...root.querySelectorAll(".dash-menu .dash-menu-item")].map(text);
}

// the topmost open generic Dialog
export function dialog(): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>(".dialog");
  return all.length ? all[all.length - 1] : null;
}

export function mustDialog(): HTMLElement {
  const d = dialog();
  if (!d) throw new Error("no dialog open");
  return d;
}

export function dialogTitle(): string {
  const d = dialog();
  return d ? text(d.querySelector(".dialog-title")!) : "";
}

// the field (a .dialog-field) whose label reads `label`
export function field(label: string): HTMLElement {
  const d = mustDialog();
  const found = [...d.querySelectorAll<HTMLElement>(".dialog-field")].find((f) => {
    const l = f.querySelector("label");
    return l && text(l) === label;
  });
  if (!found) throw new Error(`no dialog field "${label}"`);
  return found;
}

export function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export function setChecked(el: HTMLInputElement, checked: boolean): void {
  el.checked = checked;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

export function choose(el: HTMLSelectElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

export function dialogButton(label: string): HTMLButtonElement {
  return mustText(mustDialog().querySelector(".dialog-foot")!, label);
}

// the checkbox whose label reads `label`, within `root`
export function checkboxIn(root: ParentNode, label: string): HTMLInputElement {
  const found = [...root.querySelectorAll<HTMLLabelElement>("label")].find(
    (l) => text(l) === label && l.querySelector("input[type=checkbox]"),
  );
  if (!found) throw new Error(`no checkbox labelled "${label}"`);
  return found.querySelector<HTMLInputElement>("input[type=checkbox]")!;
}
