import { describe, expect, it } from "vitest";
import type { Plugin, PluginConstructor } from "@odoo/owl";
import { CodePane } from "../../src/workspaces_screen/code_pane.ts";
import { CodePlugin } from "../../src/core/code_plugin.ts";
import { ConfigPlugin } from "../../src/core/config_plugin.ts";
import { DatabasePlugin } from "../../src/core/database_plugin.ts";
import { DialogPlugin } from "../../src/core/dialog_plugin.ts";
import { EventLogPlugin } from "../../src/core/event_log_plugin.ts";
import { StorePlugin } from "../../src/core/store_plugin.ts";
import { WorkspacePlugin } from "../../src/core/workspace_plugin.ts";
import type { BranchInfo } from "../../src/core/observed_models.ts";
import type { WorkspaceConfig } from "../../src/core/config.ts";

// owl renders on the next animation frame
const nextFrame = () =>
  new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

// mount CodePane for one main-checkout workspace whose community checkout is on
// `branches`' current branch, with fake plugins standing in for what it reads
async function mountCodePane(branches: BranchInfo[]): Promise<HTMLElement> {
  // a fixture with only the fields CodePane reads
  const ws = {
    id: "w1",
    checkouts: [{ repo: "community", branch: "master-feat" }],
  } as WorkspaceConfig;
  const groups = {
    githubByRepo: { community: "odoo/odoo" },
    pathByRepo: { community: "/src/community" },
    pullRemoteByRepo: {},
    pushRemoteByRepo: {},
    prIndex: {},
    prsIndex: {},
  };
  const status = { id: "community", current: "master-feat", branches, ahead: 1, behind: 0 };
  // test fakes implement only what CodePane's render reads
  const fakes: [PluginConstructor, object][] = [
    [
      CodePlugin,
      {
        groups: () => groups,
        branchRepos: () => [status],
        repoWorking: () => false,
        mergebot: () => ({}),
        mbForwardPorts: () => ({}),
        prCreateUrl: () => "https://github.com/odoo/odoo/compare",
      },
    ],
    [
      StorePlugin,
      {
        workspaceView: () => ({
          checkouts: [{ repo: "community", branch: "master-feat", matches: true, dirty: false }],
        }),
      },
    ],
    [ConfigPlugin, { config: { repos: [{ id: "community" }] }, workspace: () => null }],
    [WorkspacePlugin, { isWorktree: () => false }],
    [DialogPlugin, {}],
    [EventLogPlugin, {}],
    [DatabasePlugin, {}],
  ];
  const app = new globalThis.owl.App({});
  for (const [P, fake] of fakes) app.pluginManager.plugins[P.id] = fake as Plugin;
  const el = document.createElement("div");
  document.body.appendChild(el);
  await app.createRoot(CodePane, { props: { ws } }).mount(el);
  return el;
}

describe("CodePane checkout menu", () => {
  it("offers Open PR for a pushed, PR-less work branch", async () => {
    const el = await mountCodePane([
      { name: "master-feat", date: "", subject: "x", sha: "abc", remote: true, synced: true },
    ]);
    el.querySelector<HTMLElement>(".ws-co-menu .dash-kebab")!.click(); // the card's kebab exists
    await nextFrame();
    const items = [...el.querySelectorAll(".dash-menu-item")].map((b) => b.textContent);
    expect(items).toContain("Open PR");
  });

  it("hides Open PR while the branch isn't pushed", async () => {
    const el = await mountCodePane([
      { name: "master-feat", date: "", subject: "x", sha: "abc", remote: false, synced: false },
    ]);
    el.querySelector<HTMLElement>(".ws-co-menu .dash-kebab")!.click(); // the card's kebab exists
    await nextFrame();
    const items = [...el.querySelectorAll(".dash-menu-item")].map((b) => b.textContent);
    expect(items).not.toContain("Open PR");
    expect(items).toContain("Push");
  });
});
