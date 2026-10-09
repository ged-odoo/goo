// Creating workspaces from the Workspaces screen, mounted in the whole app against a
// fake backend: the "Add" wizard (template / blank / runbot bundle source → the
// create form), a forward-port sub workspace, and "Adopt current checkout".
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountApp, type MountedApp, type Route } from "../helpers/app.ts";
import {
  DEFAULT_CONFIG,
  type Config,
  type TemplateConfig,
  type WorkspaceConfig,
} from "../../src/core/config.ts";
import {
  branch,
  choose,
  dialog,
  dialogButton,
  dialogTitle,
  featRepos,
  field,
  forwardPortRow,
  gitBackend,
  mustDialog,
  mustText,
  prWire,
  prsReply,
  setChecked,
  typeInto,
  workspace,
  type FakeRepo,
} from "../helpers/code_fixtures.ts";

let app: MountedApp;
afterEach(() => app?.destroy());

interface Setup {
  repos?: Record<string, FakeRepo>;
  workspaces?: WorkspaceConfig[];
  config?: Partial<Config>;
  routes?: Record<string, Route>;
  databases?: string[];
}

async function mountScreen(s: Setup = {}) {
  const git = gitBackend(s.repos ?? featRepos());
  app = await mountApp({
    section: "workspaces",
    config: {
      targets: [], // no legacy targets to migrate into workspaces
      workspaces: s.workspaces ?? [workspace({ name: "existing", db: "existing" })],
      ...s.config,
    },
    routes: {
      "/api/code/branches": (body: unknown) => git.route(body),
      "/api/prs": { repos: [] },
      "/api/prs/for-branches": { prs: [] },
      "/api/databases": {
        ok: true,
        databases: (s.databases ?? []).map((name) => ({ name, size: null })),
      },
      "/api/code/branches/create": (body: unknown) => ({
        results: (body as { branches: { name: string }[] }).branches.map((b) => ({
          name: b.name,
          ok: true,
        })),
      }),
      "/api/code/checkout": { results: [] },
      ...s.routes,
    },
  });
  return git;
}

async function click(el: HTMLElement) {
  el.click();
  await app.settle();
}

const failure = (status: number, body: object) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const wizard = () => document.querySelector<HTMLElement>(".ws-wiz");

async function openWizard() {
  await click(mustText(app.root.querySelector(".wt-list-title")!, "Add"));
  expect(wizard()).not.toBeNull();
}

async function continueWizard() {
  await click(mustText(wizard()!, "Continue"));
}

const input = (label: string) => field(label).querySelector<HTMLInputElement>("input")!;
const checkbox = (label: string) =>
  field(label).querySelector<HTMLInputElement>("input[type=checkbox]")!;
const hint = (label: string) => field(label).querySelector(".dialog-field-hint")?.textContent ?? "";

async function type(label: string, value: string) {
  typeInto(input(label), value);
  await app.settle();
}

async function tick(label: string, on: boolean) {
  setChecked(checkbox(label), on);
  await app.settle();
}

// the workspaces in the screen's list
const listNames = () => [...app.root.querySelectorAll(".wt-item-name")].map((e) => e.textContent);

// a workspace as the app saved it to the server config — the save is debounced,
// so wait for it (bounded)
async function savedWorkspace(name: string): Promise<WorkspaceConfig> {
  return vi.waitFor(
    () => {
      const saves = app.callsTo("/api/config").filter((c) => c.method === "POST");
      const last = saves.at(-1)?.body as { config?: Config } | undefined;
      const found = last?.config?.workspaces.find((w) => w.name === name);
      if (!found) throw new Error(`workspace "${name}" was never saved`);
      return found;
    },
    { timeout: 5000 },
  );
}

const detailName = () => app.root.querySelector(".wt-detail-name")?.textContent;

describe("New workspace wizard — source step", () => {
  it("cancelling the wizard creates nothing", async () => {
    await mountScreen();
    await openWizard();
    await click(mustText(wizard()!, "Cancel"));
    expect(wizard()).toBeNull();
    expect(dialog()).toBeNull();
    expect(listNames()).toEqual(["existing"]);
  });

  it("Escape closes the wizard", async () => {
    await mountScreen();
    await openWizard();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await app.settle();
    expect(wizard()).toBeNull();
  });

  it("a bundle source needs a URL before it can continue", async () => {
    await mountScreen();
    await openWizard();
    const bundleRadio = wizard()!.querySelector<HTMLInputElement>("input[value=bundle]")!;
    setChecked(bundleRadio, true);
    await app.settle();
    expect(mustText(wizard()!, "Continue").disabled).toBe(true);
    typeInto(wizard()!.querySelector<HTMLInputElement>(".ws-wiz-url")!, "https://runbot/x");
    await app.settle();
    expect(mustText(wizard()!, "Continue").disabled).toBe(false);
  });
});

describe("New workspace — blank form", () => {
  it("names the branches and database after the typed name, then creates and selects it", async () => {
    await mountScreen();
    await openWizard();
    await continueWizard(); // no templates: starts blank
    expect(app.callsTo("/api/runbot/dumps")).toEqual([]); // no base version to look up
    expect(dialogTitle()).toBe("New workspace");
    expect(dialogButton("Create").disabled).toBe(true); // a name is required
    await type("Name", "master-newtask");
    expect(input("Config").value).toBe("community:master-newtask,enterprise:master-newtask");
    expect(input("Database").value).toBe("master-newtask");
    expect(hint("Config")).toBe(
      "community: fork new from master · enterprise: fork new from master",
    );
    await tick("Activate it (main)", false);
    await click(dialogButton("Create"));
    expect(dialog()).toBeNull();
    const created = await savedWorkspace("master-newtask");
    expect(created).toMatchObject({
      location: "main",
      db: "master-newtask",
      parent: "",
      checkouts: [
        { repo: "community", branch: "master-newtask" },
        { repo: "enterprise", branch: "master-newtask" },
      ],
    });
    const [create] = app.callsTo("/api/code/branches/create");
    expect(create.body).toEqual({
      branches: [
        {
          path: "/home/odoo/work/community",
          name: "master-newtask",
          start_point: "master",
          fresh_start: true,
          pull_remote: "origin",
          repo: "community",
        },
        {
          path: "/home/odoo/work/enterprise",
          name: "master-newtask",
          start_point: "master",
          fresh_start: true,
          pull_remote: "origin",
          repo: "enterprise",
        },
      ],
    });
    expect(detailName()).toBe("master-newtask");
  });

  it("refuses a name that's already taken", async () => {
    await mountScreen();
    await openWizard();
    await continueWizard();
    await type("Name", "existing");
    expect(dialogButton("Create").disabled).toBe(true);
    expect(mustDialog().querySelector(".form-error")!.textContent).toBe(
      'a workspace named "existing" already exists',
    );
  });

  it("unticking a repository drops it from the config", async () => {
    await mountScreen();
    await openWizard();
    await continueWizard();
    await type("Name", "master-x");
    const enterprise = [...field("Repositories").querySelectorAll("label")].find((l) =>
      l.textContent!.includes("enterprise"),
    )!;
    setChecked(enterprise.querySelector("input")!, false);
    await app.settle();
    expect(input("Config").value).toBe("community:master-x");
  });

  it("leaves an opt-in repository unticked", async () => {
    await mountScreen({
      config: {
        repos: [
          ...DEFAULT_CONFIG.repos,
          { ...DEFAULT_CONFIG.repos[1], id: "upgrade", path: "/w/upgrade", opt_in: true },
        ],
      },
    });
    await openWizard();
    await continueWizard();
    await type("Name", "master-x");
    const upgrade = [...field("Repositories").querySelectorAll("label")].find((l) =>
      l.textContent!.includes("upgrade"),
    )!;
    expect(upgrade.querySelector("input")!.checked).toBe(false);
    expect(input("Config").value).toBe("community:master-x,enterprise:master-x");
  });

  it("keeps a hand-edited database name when the name changes later", async () => {
    await mountScreen();
    await openWizard();
    await continueWizard();
    await type("Name", "master-a");
    await type("Database", "db-master-a-copy");
    await type("Name", "master-b");
    expect(input("Database").value).toBe("db-master-b-copy");
  });

  it("attaches a branch that already exists locally instead of forking it", async () => {
    await mountScreen();
    await openWizard();
    await continueWizard();
    await type("Name", "master-feat"); // featRepos has master-feat in both repos
    expect(hint("Config")).toBe(
      'community: attach existing "master-feat" · enterprise: attach existing "master-feat"',
    );
    await tick("Activate it (main)", false);
    await click(dialogButton("Create"));
    expect(app.callsTo("/api/code/branches/create")).toEqual([]);
    expect(listNames()).toContain("master-feat");
  });

  it("activating the new workspace checks its branches out", async () => {
    await mountScreen();
    await openWizard();
    await continueWizard();
    await type("Name", "master-feat");
    await click(dialogButton("Create"));
    const [checkout] = app.callsTo("/api/code/checkout");
    expect(checkout.body).toMatchObject({
      repos: [
        { repo: "community", branch: "master-feat" },
        { repo: "enterprise", branch: "master-feat" },
      ],
    });
  });

  it("clones the selected database into the new one", async () => {
    await mountScreen({
      databases: ["master-base"],
      routes: { "/api/databases/clone": { ok: true } },
    });
    await openWizard();
    await continueWizard();
    await type("Name", "master-newtask");
    await tick("Activate it (main)", false);
    await tick("Clone db", true);
    expect(field("Clone db").querySelector("select")!.value).toBe("master-base");
    await click(dialogButton("Create"));
    expect(app.callsTo("/api/databases/clone").map((c) => c.body)).toEqual([
      expect.objectContaining({ source: "master-base", dest: "master-newtask" }),
    ]);
  });

  it("refuses a venv outside a worktree", async () => {
    await mountScreen();
    await openWizard();
    await continueWizard();
    await type("Name", "master-newtask");
    await tick("Create venv from requirements.txt (worktree)", true);
    expect(dialogButton("Create").disabled).toBe(true);
    expect(mustDialog().querySelector(".form-error")!.textContent).toContain(
      "a venv needs Location",
    );
  });

  it("an own-worktree workspace is created by the backend, not activated", async () => {
    await mountScreen({ routes: { "/api/workspace/create": { ok: true, results: [] } } });
    await openWizard();
    await continueWizard();
    await type("Name", "master-wt");
    choose(field("Location").querySelector("select")!, "worktree");
    await app.settle();
    expect(() => field("Activate it (main)")).toThrow(); // hidden for a worktree
    await click(dialogButton("Create"));
    const [create] = app.callsTo("/api/workspace/create");
    const body = create.body as { repos: Record<string, string>[] };
    expect(body.repos.map((r) => [r.repo, r.newBranch, r.startPoint])).toEqual([
      ["community", "master-wt", "master"],
      ["enterprise", "master-wt", "master"],
    ]);
    expect(app.callsTo("/api/code/checkout")).toEqual([]);
    const created = await savedWorkspace("master-wt");
    expect(created.location).toBe("worktree");
    expect(detailName()).toBe("master-wt");
  });

  it("discarding the form creates nothing", async () => {
    await mountScreen();
    await openWizard();
    await continueWizard();
    await type("Name", "master-x");
    await click(dialogButton("Discard"));
    expect(listNames()).toEqual(["existing"]);
    expect(app.callsTo("/api/code/branches/create")).toEqual([]);
  });
});

describe("New workspace — from a template", () => {
  const TEMPLATE: TemplateConfig = {
    id: "t1",
    name: "Sale",
    db: "tpl-db",
    on_create_args: "-i sale",
    demo_data: false,
    category: "",
    checkouts: [{ repo: "community", branch: "saas-19.1" }],
  };
  const DUMPS = [
    { slot: "Enterprise Run", db: "all", url: "https://runbot/e-all.zip", size: 1.5 * 1024 ** 3 },
    { slot: "Community Run", db: "base", url: "https://runbot/c-base.zip" },
    { slot: "Community Run", db: "all", url: "https://runbot/c-all.zip" },
  ];

  async function openTemplateForm(routes: Record<string, Route> = {}, databases: string[] = []) {
    await mountScreen({
      config: { templates: [TEMPLATE] },
      databases,
      routes: { "/api/runbot/dumps": { dumps: DUMPS }, ...routes },
    });
    await openWizard();
    await continueWizard();
  }

  it("prefills the form from the template and offers its base version's runbot dumps", async () => {
    await openTemplateForm();
    expect(app.callsTo("/api/runbot/dumps").map((c) => c.body)).toEqual([{ branch: "saas-19.1" }]);
    expect(dialogTitle()).toBe('New workspace — from template "Sale"');
    expect(input("Name").value).toBe("saas-19.1");
    expect(input("Config").value).toBe("community:saas-19.1");
    expect(input("Database").value).toBe("tpl-db");
    expect(input("Start args").value).toBe("-i sale");
    expect(checkbox("Demo data").checked).toBe(false);
    await tick("Restore runbot database", true);
    const select = field("Restore runbot database").querySelector("select")!;
    // a community-only checkout defaults to the Community run's full database
    expect(select.value).toBe("https://runbot/c-all.zip");
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "Enterprise Run — all (1.5 GB)",
      "Community Run — base",
      "Community Run — all",
    ]);
    expect(hint("Restore runbot database")).toContain("downloaded from runbot");
  });

  it("keeps the template's demo-data setting while the name is typed", async () => {
    await mountScreen({
      config: { templates: [{ ...TEMPLATE, demo_data: true }] },
      routes: { "/api/runbot/dumps": { dumps: DUMPS } },
    });
    await openWizard();
    await continueWizard();
    expect(checkbox("Demo data").checked).toBe(true);
    await type("Name", "saas-19.1-mytask");
    expect(checkbox("Demo data").checked).toBe(true);
  });

  it("forks from the template's branch and restores the dump last", async () => {
    await openTemplateForm({ "/api/databases/restore-dump": { ok: true } });
    await type("Name", "saas-19.1-mytask");
    await tick("Activate it (main)", false);
    await tick("Restore runbot database", true);
    await click(dialogButton("Create"));
    const [create] = app.callsTo("/api/code/branches/create");
    expect(create.body).toMatchObject({
      branches: [{ name: "saas-19.1-mytask", start_point: "saas-19.1", repo: "community" }],
    });
    expect(app.callsTo("/api/databases/restore-dump").map((c) => c.body)).toEqual([
      expect.objectContaining({ name: "tpl-db", url: "https://runbot/c-all.zip" }),
    ]);
  });

  it("reports a failed dump restore but keeps the workspace", async () => {
    await openTemplateForm({
      "/api/databases/restore-dump": failure(500, { error: "download failed" }),
    });
    await type("Name", "saas-19.1-mytask");
    await tick("Activate it (main)", false);
    await tick("Restore runbot database", true);
    await click(dialogButton("Create"));
    expect(dialogTitle()).toBe("Restoring the runbot database failed");
    expect(mustDialog().textContent).toContain("download failed");
    expect(listNames()).toContain("saas-19.1-mytask");
  });

  it("refuses to clone and restore into the same database", async () => {
    await openTemplateForm({}, ["tpl-db-src"]);
    await tick("Restore runbot database", true);
    await tick("Clone db", true);
    expect(mustDialog().querySelector(".form-error")!.textContent).toBe(
      "clone a database or restore the runbot dump — not both",
    );
  });

  it("starts without the dump offer when runbot can't be reached", async () => {
    await openTemplateForm({ "/api/runbot/dumps": failure(502, { error: "runbot down" }) });
    expect(dialogTitle()).toBe('New workspace — from template "Sale"');
    expect(() => field("Restore runbot database")).toThrow();
  });
});

describe("New workspace — from a runbot bundle", () => {
  const BUNDLE = {
    name: "master-colleague",
    branches: [{ github: "odoo-dev/odoo", branch: "master-colleague" }],
    dumps: [],
  };

  async function fromBundle(routes: Record<string, Route>) {
    await mountScreen({ routes });
    await openWizard();
    setChecked(wizard()!.querySelector<HTMLInputElement>("input[value=bundle]")!, true);
    await app.settle();
    typeInto(
      wizard()!.querySelector<HTMLInputElement>(".ws-wiz-url")!,
      " https://runbot/bundle/1 ",
    );
    await app.settle();
    await continueWizard();
  }

  it("fetches the bundle's branches and opens the form attached to them", async () => {
    await fromBundle({
      "/api/runbot/bundle-info": BUNDLE,
      "/api/code/remote-branch/fetch": { ok: true },
    });
    expect(app.callsTo("/api/runbot/bundle-info").map((c) => c.body)).toEqual([
      { url: "https://runbot/bundle/1" },
    ]);
    // a fork's branch comes from the push remote
    expect(app.callsTo("/api/code/remote-branch/fetch").map((c) => c.body)).toEqual([
      {
        path: "/home/odoo/work/community",
        branch: "master-colleague",
        pull_remote: "dev",
        force: false,
      },
    ]);
    expect(input("Name").value).toBe("master-colleague");
    expect(input("Config").value).toBe("community:master-colleague");
    expect(checkbox("Create branches").checked).toBe(false);
  });

  it("asks before forking a repo the bundle didn't carry", async () => {
    await fromBundle({
      "/api/runbot/bundle-info": BUNDLE,
      "/api/code/remote-branch/fetch": { ok: true },
    });
    const enterprise = [...field("Repositories").querySelectorAll("label")].find((l) =>
      l.textContent!.includes("enterprise"),
    )!;
    setChecked(enterprise.querySelector("input")!, true);
    await app.settle();
    // the fetched branch survives ticking another repo
    expect(input("Config").value).toBe("community:master-colleague,enterprise:master-colleague");
    await tick("Activate it (main)", false);
    await click(dialogButton("Create"));
    expect(dialogTitle()).toBe("Unconfirmed branch");
    expect(mustDialog().textContent).toContain("enterprise:master");
    await click(dialogButton("Fork from base & create"));
    const [create] = app.callsTo("/api/code/branches/create");
    expect((create.body as { branches: { repo: string }[] }).branches.map((b) => b.repo)).toEqual([
      "enterprise",
    ]);
  });

  it("cancelling the unconfirmed-branch question creates nothing", async () => {
    await fromBundle({
      "/api/runbot/bundle-info": BUNDLE,
      "/api/code/remote-branch/fetch": { ok: true },
    });
    const enterprise = [...field("Repositories").querySelectorAll("label")].find((l) =>
      l.textContent!.includes("enterprise"),
    )!;
    setChecked(enterprise.querySelector("input")!, true);
    await app.settle();
    await click(dialogButton("Create"));
    await click(dialogButton("Cancel"));
    expect(listNames()).toEqual(["existing"]);
  });

  it("shows a bundle lookup error in the wizard itself", async () => {
    await fromBundle({ "/api/runbot/bundle-info": failure(404, { error: "no such bundle" }) });
    expect(wizard()!.querySelector(".form-error")!.textContent).toBe("no such bundle");
  });

  it("explains when none of the bundle's repositories are configured", async () => {
    await fromBundle({
      "/api/runbot/bundle-info": { name: "x", branches: [{ github: "acme/thing", branch: "x" }] },
    });
    expect(dialogTitle()).toBe("Workspace from bundle");
    expect(mustDialog().textContent).toContain("acme/thing");
  });

  it("offers to overwrite a local branch that diverged, and refetches with force", async () => {
    await fromBundle({
      "/api/runbot/bundle-info": BUNDLE,
      "/api/code/remote-branch/fetch": (body: unknown) =>
        (body as { force: boolean }).force
          ? { ok: true }
          : failure(409, { error: "non-fast-forward", non_ff: true }),
    });
    expect(dialogTitle()).toBe("Branch has diverged");
    await click(dialogButton("Overwrite"));
    expect(
      app.callsTo("/api/code/remote-branch/fetch").map((c) => (c.body as { force: boolean }).force),
    ).toEqual([false, true]);
    expect(input("Name").value).toBe("master-colleague");
  });

  it("skipping the overwrite abandons the bundle with an error", async () => {
    await fromBundle({
      "/api/runbot/bundle-info": BUNDLE,
      "/api/code/remote-branch/fetch": failure(409, { error: "non-fast-forward", non_ff: true }),
    });
    await click(dialogButton("Skip"));
    expect(dialogTitle()).toBe("Fetching bundle branches failed");
    expect(mustDialog().textContent).toContain("community: non-fast-forward");
    await click(dialogButton("OK"));
    expect(dialog()).toBeNull(); // no create form: nothing was fetched
  });
});

describe("Sub workspace from a forward port", () => {
  const FW_BRANCH = "saas-19.1-master-feat-abcd-fw";

  async function mountChain(routes: Record<string, Route>, repository = "odoo/odoo") {
    await mountScreen({
      workspaces: [
        workspace({ category: "dev", checkouts: [{ repo: "community", branch: "master-feat" }] }),
      ],
      config: { workspace_categories_enabled: true },
      routes: {
        "/api/prs": prsReply({ community: [prWire({ state: "merged" })] }),
        "/api/mergebot": {
          states: { "odoo/odoo#101": "merged" },
          forward_ports: {
            "odoo/odoo#101": [forwardPortRow("saas-19.1", [{ repository, number: 150 }])],
          },
        },
        ...routes,
      },
    });
    await click(mustText(app.root.querySelector(".ws-fp-row")!, "Create sub workspace"));
  }

  it("fetches the forward port's head and creates a child workspace on it", async () => {
    await mountChain({
      "/api/prs/head": { branch: FW_BRANCH },
      "/api/code/remote-branch/fetch-pr": { ok: true },
    });
    expect(app.callsTo("/api/prs/head").map((c) => c.body)).toEqual([
      { repo: "odoo/odoo", number: 150 },
    ]);
    expect(app.callsTo("/api/code/remote-branch/fetch-pr").map((c) => c.body)).toEqual([
      {
        path: "/home/odoo/work/community",
        github: "odoo/odoo",
        number: 150,
        branch: FW_BRANCH,
        force: false,
      },
    ]);
    expect(input("Name").value).toBe(FW_BRANCH);
    expect(input("Config").value).toBe(`community:${FW_BRANCH}`);
    // the child lands in its parent's category
    expect(field("Category").querySelector("select")!.value).toBe("dev");
    await tick("Activate it (main)", false);
    await click(dialogButton("Create"));
    const child = await savedWorkspace(FW_BRANCH);
    expect(child).toMatchObject({ parent: "w1", category: "dev" });
  });

  it("reports a forward port whose head can't be resolved", async () => {
    await mountChain({ "/api/prs/head": {} });
    expect(dialogTitle()).toBe("Fetching PR branch failed");
    expect(mustDialog().textContent).toContain("could not resolve the PR's head branch");
  });

  it("reports a forward port in a repository goo doesn't know", async () => {
    await mountChain({}, "acme/unknown");
    expect(dialogTitle()).toBe("Create sub workspace");
    expect(mustDialog().textContent).toContain("acme/unknown");
  });
});

describe("Adopt current checkout", () => {
  it("turns what's checked out into a loaded workspace named after the feature branch", async () => {
    const repos = featRepos();
    repos.enterprise = { ...repos.enterprise, current: "master", branches: [branch("master")] };
    await mountScreen({ workspaces: [], repos });
    await click(mustText(app.root, "Adopt current checkout"));
    const ws = await savedWorkspace("master-feat");
    expect(ws).toMatchObject({
      name: "master-feat",
      db: "master-feat",
      location: "main",
      checkouts: [
        { repo: "community", branch: "master-feat" },
        { repo: "enterprise", branch: "master" },
      ],
    });
    expect(detailName()).toBe("master-feat");
    // adopting checks nothing out — the checkout already matches
    expect(app.callsTo("/api/code/checkout")).toEqual([]);
  });

  it("can't adopt a detached community checkout", async () => {
    await mountScreen({
      workspaces: [],
      repos: { community: { current: "(detached)", branches: [] } },
    });
    await click(mustText(app.root, "Adopt current checkout"));
    expect(dialogTitle()).toBe("Adopt current checkout");
    expect(mustDialog().textContent).toContain("detached HEAD?");
    expect(listNames()).toEqual([]);
  });

  it("asks to stop a running main server before adopting", async () => {
    await mountScreen({
      workspaces: [],
      routes: {
        "/api/status": { id: "main", state: "running", workspace: "other" },
        "/api/stop": { ok: true },
      },
    });
    await click(mustText(app.root, "Adopt current checkout"));
    expect(dialogTitle()).toBe("Adopt current checkout");
    expect(mustDialog().textContent).toContain("The main server is running");
    await click(dialogButton("Stop & adopt"));
    expect(app.callsTo("/api/stop")).toHaveLength(1);
    expect(detailName()).toBe("master-feat");
  });
});
