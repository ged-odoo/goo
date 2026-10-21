// Creating workspaces from the Workspaces screen, mounted in the whole app against a
// fake backend: the "Add" dialog (its source — a template, a runbot bundle, a local or
// remote branch, a pull request — prefilling the form), a forward-port sub workspace,
// and "Adopt current checkout".
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

async function openForm() {
  await click(mustText(app.root.querySelector(".wt-list-title")!, "Add"));
  expect(dialogTitle()).toBe("New workspace");
}

// pick one of the dialog's source radios by its label
async function pickSource(label: string) {
  const radio = [...mustDialog().querySelectorAll<HTMLLabelElement>(".cwd-source")].find(
    (l) => l.textContent!.trim() === label,
  );
  if (!radio) throw new Error(`no source "${label}"`);
  setChecked(radio.querySelector("input")!, true);
  await app.settle();
}

async function pickTemplate(id: string) {
  choose(field("Template").querySelector("select")!, id);
  await app.settle();
}

// the branch combobox's result rows, as "branch:repo/local|remote,…"
const branchRows = () =>
  [...mustDialog().querySelectorAll(".branch-cb .rbd-row")].map(
    (r) =>
      `${r.querySelector(".rbd-branch")!.textContent}:` +
      [...r.querySelectorAll(".rbd-repo-tag")]
        .map((t) => `${t.textContent}/${t.className.split(" ")[1]}`)
        .join(","),
  );

async function pickBranchRow(branchName: string) {
  const row = [...mustDialog().querySelectorAll<HTMLElement>(".branch-cb .rbd-row")].find(
    (r) => r.querySelector(".rbd-branch")!.textContent === branchName,
  )!;
  row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  await app.settle();
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

// the ticked repositories, each with the branch it'll check out — "repo:branch,…"
const tickedRepos = () =>
  [...field("Repositories").querySelectorAll(".cwd-repo")].filter(
    (r) => r.querySelector<HTMLInputElement>("input")!.checked,
  );
const configText = () =>
  tickedRepos()
    .map((r) => {
      const branchName = r.querySelector(".cwd-repo-branch")?.textContent ?? "";
      return `${r.querySelector(".cwd-repo-id")!.textContent}:${branchName}`;
    })
    .filter((c) => !c.endsWith(":"))
    .join(",");
// each ticked repository's attach / fork preview — "repo: action · …"
const repoPreview = () =>
  tickedRepos()
    .map(
      (r) =>
        `${r.querySelector(".cwd-repo-id")!.textContent}: ${r.querySelector(".cwd-repo-action")!.textContent}`,
    )
    .join(" · ");

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

describe("New workspace — source", () => {
  it("Escape closes the dialog", async () => {
    await mountScreen();
    await openForm();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await app.settle();
    expect(dialog()).toBeNull();
  });

  it("opens on the Template source, blank when there's no template", async () => {
    await mountScreen();
    await openForm();
    const checked = mustDialog().querySelector<HTMLInputElement>(".cwd-source input:checked")!;
    expect(checked.value).toBe("template");
    expect(field("Template").querySelector("select")!.value).toBe("");
    expect(input("Name").value).toBe("");
    expect(document.activeElement).toBe(input("Name"));
  });

  it("each source shows its own input", async () => {
    await mountScreen();
    await openForm();
    const labels = [...mustDialog().querySelectorAll(".cwd-source")].map((l) =>
      l.textContent!.trim(),
    );
    expect(labels).toEqual([
      "Template",
      "Odoo version",
      "Local branch",
      "Remote branch",
      "Runbot bundle",
      "Pull request",
    ]);
    await pickSource("Runbot bundle");
    expect(() => field("Template")).toThrow();
    expect(field("Bundle URL")).toBeTruthy();
    await pickSource("Local branch");
    expect(field("Branch").querySelector(".branch-cb-input")).toBeTruthy();
    await pickSource("Pull request");
    expect(field("Pull request URL")).toBeTruthy();
  });

  it("a bundle source refuses Create until its URL is loaded", async () => {
    await mountScreen();
    await openForm();
    await pickSource("Runbot bundle");
    await type("Bundle URL", "https://runbot/x");
    await type("Name", "master-x");
    expect(dialogButton("Create").disabled).toBe(true);
    expect(mustDialog().querySelector(".form-error")!.textContent).toBe(
      "load the runbot bundle first",
    );
  });

  it("the bundle URL field explains which address runbot lets goo read", async () => {
    await mountScreen();
    await openForm();
    await pickSource("Runbot bundle");
    expect(hint("Bundle URL")).toContain("…/bundle/525170");
    expect(hint("Bundle URL")).toContain("redirected it to the name form");
  });
});

describe("New workspace — blank form", () => {
  it("names the branches and database after the typed name, then creates and selects it", async () => {
    await mountScreen();
    await openForm();
    expect(app.callsTo("/api/runbot/dumps")).toEqual([]); // no base version to look up
    expect(dialogTitle()).toBe("New workspace");
    expect(dialogButton("Create").disabled).toBe(true); // a name is required
    await type("Name", "master-newtask");
    expect(configText()).toBe("community:master-newtask,enterprise:master-newtask");
    expect(input("Database").value).toBe("master-newtask");
    expect(repoPreview()).toBe(
      "community: fork from origin/master · enterprise: fork from origin/master",
    );
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

  it("names the pull remote a branch forks from", async () => {
    await mountScreen({
      config: {
        repos: DEFAULT_CONFIG.repos.map((r) =>
          r.id === "enterprise" ? { ...r, pull_remote: "prod" } : r,
        ),
      },
    });
    await openForm();
    await type("Name", "master-x");
    expect(repoPreview()).toBe(
      "community: fork from origin/master · enterprise: fork from prod/master",
    );
  });

  it("refuses a name that's already taken", async () => {
    await mountScreen();
    await openForm();
    await type("Name", "existing");
    expect(dialogButton("Create").disabled).toBe(true);
    expect(mustDialog().querySelector(".form-error")!.textContent).toBe(
      'a workspace named "existing" already exists',
    );
  });

  it("unticking a repository drops it from the config", async () => {
    await mountScreen();
    await openForm();
    await type("Name", "master-x");
    const enterprise = [...field("Repositories").querySelectorAll("label")].find((l) =>
      l.textContent!.includes("enterprise"),
    )!;
    setChecked(enterprise.querySelector("input")!, false);
    await app.settle();
    expect(configText()).toBe("community:master-x");
  });

  it("needs at least one repository", async () => {
    await mountScreen();
    await openForm();
    await type("Name", "master-x");
    for (const r of tickedRepos()) setChecked(r.querySelector("input")!, false);
    await app.settle();
    expect(configText()).toBe("");
    expect(mustDialog().querySelector(".form-error")!.textContent).toBe(
      "tick at least one repository",
    );
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
    await openForm();
    await type("Name", "master-x");
    const upgrade = [...field("Repositories").querySelectorAll("label")].find((l) =>
      l.textContent!.includes("upgrade"),
    )!;
    expect(upgrade.querySelector("input")!.checked).toBe(false);
    expect(configText()).toBe("community:master-x,enterprise:master-x");
  });

  it("keeps a hand-edited database name when the name changes later", async () => {
    await mountScreen();
    await openForm();
    await type("Name", "master-a");
    await type("Database", "db-master-a-copy");
    await type("Name", "master-b");
    expect(input("Database").value).toBe("db-master-b-copy");
  });

  it("attaches a branch that already exists locally instead of forking it", async () => {
    await mountScreen();
    await openForm();
    await type("Name", "master-feat"); // featRepos has master-feat in both repos
    expect(repoPreview()).toBe("community: attach existing · enterprise: attach existing");
    await click(dialogButton("Create"));
    expect(app.callsTo("/api/code/branches/create")).toEqual([]);
    expect(listNames()).toContain("master-feat");
  });

  it("Create only adds the workspace; Create and activate also checks its branches out", async () => {
    await mountScreen();
    await openForm();
    await type("Name", "master-other");
    await click(dialogButton("Create"));
    expect(listNames()).toContain("master-other");
    expect(app.callsTo("/api/code/checkout")).toEqual([]);
    await openForm();
    await type("Name", "master-feat");
    await click(dialogButton("Create and activate"));
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
    await openForm();
    await type("Name", "master-newtask");
    await tick("Clone db", true);
    expect(field("Clone db").querySelector("select")!.value).toBe("master-base");
    await click(dialogButton("Create"));
    expect(app.callsTo("/api/databases/clone").map((c) => c.body)).toEqual([
      expect.objectContaining({ source: "master-base", dest: "master-newtask" }),
    ]);
  });

  it("offers a dedicated venv only for an own worktree, and builds it", async () => {
    await mountScreen({
      routes: {
        "/api/workspace/create": { ok: true, results: [] },
        "/api/workspace/venv/create": { ok: true },
      },
    });
    await openForm();
    await type("Name", "master-wt");
    const venv = "Create a venv from requirements.txt";
    expect(() => field(venv)).toThrow(); // a main checkout uses the global venv
    choose(field("Location").querySelector("select")!, "worktree");
    await app.settle();
    await tick(venv, true);
    await click(dialogButton("Create"));
    const [create] = app.callsTo("/api/workspace/venv/create");
    const body = create.body as { venvPath: string; requirementsPath: string };
    expect(body.venvPath).toMatch(/\/\.venv$/);
    expect(body.requirementsPath).toMatch(/\/community\/requirements\.txt$/);
  });

  it("an own-worktree workspace is created by the backend, not activated", async () => {
    await mountScreen({ routes: { "/api/workspace/create": { ok: true, results: [] } } });
    await openForm();
    await type("Name", "master-wt");
    choose(field("Location").querySelector("select")!, "worktree");
    await app.settle();
    // a worktree runs concurrently: there's nothing to activate
    expect(() => dialogButton("Create and activate")).toThrow();
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
    await openForm();
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
    await openForm();
  }

  it("prefills the form from the template and offers its base version's runbot dumps", async () => {
    await openTemplateForm();
    expect(app.callsTo("/api/runbot/dumps").map((c) => c.body)).toEqual([{ branch: "saas-19.1" }]);
    expect(field("Template").querySelector("select")!.value).toBe("t1");
    expect(input("Name").value).toBe("saas-19.1");
    expect(configText()).toBe("community:saas-19.1");
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
    await openForm();
    expect(checkbox("Demo data").checked).toBe(true);
    await type("Name", "saas-19.1-mytask");
    expect(checkbox("Demo data").checked).toBe(true);
  });

  it("forks from the template's branch and restores the dump last", async () => {
    await openTemplateForm({ "/api/databases/restore-dump": { ok: true } });
    await type("Name", "saas-19.1-mytask");
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
    expect(input("Name").value).toBe("saas-19.1");
    expect(() => field("Restore runbot database")).toThrow();
  });

  it("switching to blank clears what the template prefilled", async () => {
    await openTemplateForm();
    await pickTemplate("");
    expect(input("Name").value).toBe("");
    expect(configText()).toBe("");
    expect(input("Start args").value).toBe("");
    expect(() => field("Restore runbot database")).toThrow();
    await type("Name", "master-x");
    await click(dialogButton("Create"));
    // no template: forks from the name's own base
    const [create] = app.callsTo("/api/code/branches/create");
    expect(create.body).toMatchObject({
      branches: [
        { name: "master-x", start_point: "master", repo: "community" },
        { name: "master-x", start_point: "master", repo: "enterprise" },
      ],
    });
  });

  it("switching back to the template prefills it again", async () => {
    await openTemplateForm();
    await pickTemplate("");
    await pickTemplate("t1");
    expect(input("Name").value).toBe("saas-19.1");
    expect(input("Database").value).toBe("tpl-db");
    expect(app.callsTo("/api/runbot/dumps")).toHaveLength(2);
    expect(field("Restore runbot database")).toBeTruthy();
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
    await openForm();
    await pickSource("Runbot bundle");
    await type("Bundle URL", " https://runbot/bundle/1 ");
    await click(mustText(field("Bundle URL"), "Load"));
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
    expect(configText()).toBe("community:master-colleague");
    expect(dialogButton("Create").disabled).toBe(false);
  });

  it("Enter in the URL field loads it", async () => {
    await mountScreen({
      routes: { "/api/runbot/bundle-info": BUNDLE, "/api/code/remote-branch/fetch": { ok: true } },
    });
    await openForm();
    await pickSource("Runbot bundle");
    await type("Bundle URL", "https://runbot/bundle/1");
    input("Bundle URL").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await app.settle();
    expect(app.callsTo("/api/runbot/bundle-info")).toHaveLength(1);
    expect(dialogTitle()).toBe("New workspace"); // loaded, not submitted
    expect(input("Name").value).toBe("master-colleague");
  });

  it("an edited URL must be loaded again", async () => {
    await fromBundle({
      "/api/runbot/bundle-info": BUNDLE,
      "/api/code/remote-branch/fetch": { ok: true },
    });
    await type("Bundle URL", "https://runbot/bundle/2");
    expect(dialogButton("Create").disabled).toBe(true);
  });

  it("offers the bundle's own runbot dumps", async () => {
    await fromBundle({
      "/api/runbot/bundle-info": {
        ...BUNDLE,
        dumps: [{ slot: "Community Run", db: "all", url: "https://runbot/c-all.zip" }],
      },
      "/api/code/remote-branch/fetch": { ok: true },
    });
    await tick("Restore runbot database", true);
    expect(field("Restore runbot database").querySelector("select")!.value).toBe(
      "https://runbot/c-all.zip",
    );
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
    expect(configText()).toBe("community:master-colleague,enterprise:master-colleague");
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

  it("reports a bundle lookup error and keeps the form open", async () => {
    await fromBundle({ "/api/runbot/bundle-info": failure(404, { error: "no such bundle" }) });
    expect(dialogTitle()).toBe("Reading the runbot bundle failed");
    expect(mustDialog().textContent).toContain("no such bundle");
    await click(dialogButton("OK"));
    expect(dialogTitle()).toBe("New workspace");
    expect(dialogButton("Create").disabled).toBe(true);
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
    // the form stays open, still waiting for a loaded bundle
    expect(dialogTitle()).toBe("New workspace");
    expect(input("Name").value).toBe("");
    expect(dialogButton("Create").disabled).toBe(true);
  });
});

describe("New workspace — from an Odoo version", () => {
  const DUMPS = [{ slot: "Community Run", db: "all", url: "https://runbot/19-all.zip" }];

  it("lists runbot's versions and prefills the form from the newest", async () => {
    await mountScreen({
      routes: {
        "/api/runbot/sticky": { ok: true, versions: ["master", "19.0"] },
        "/api/runbot/dumps": (body: unknown) => ({
          ok: true,
          dumps: (body as { branch: string }).branch === "19.0" ? DUMPS : [],
        }),
      },
    });
    await openForm();
    await pickSource("Odoo version");
    const select = field("Odoo version").querySelector("select")!;
    expect([...select.options].map((o) => o.value)).toEqual(["master", "19.0"]);
    expect(select.value).toBe("master");
    expect(input("Name").value).toBe("master");
    expect(configText()).toBe("community:master,enterprise:master");
    expect(() => field("Restore runbot database")).toThrow(); // master has no dumps here
    choose(select, "19.0");
    await app.settle();
    expect(input("Name").value).toBe("19.0");
    expect(input("Database").value).toBe("19.0");
    expect(field("Restore runbot database")).toBeTruthy();
    // a task branch named off the version forks from it
    await type("Name", "19.0-mytask");
    expect(repoPreview()).toBe(
      "community: fork from origin/19.0 · enterprise: fork from origin/19.0",
    );
    expect(dialogButton("Create").disabled).toBe(false);
    expect(app.callsTo("/api/runbot/sticky")).toHaveLength(1);
  });

  it("says why when runbot's versions can't be read", async () => {
    await mountScreen({
      routes: { "/api/runbot/sticky": failure(502, { error: "runbot down" }) },
    });
    await openForm();
    await pickSource("Odoo version");
    expect(field("Odoo version").querySelector(".form-error")!.textContent).toContain(
      "could not load runbot's versions",
    );
    expect(dialogButton("Create").disabled).toBe(true);
  });
});

describe("New workspace — from a local branch", () => {
  it("searches the local branches and attaches the picked one", async () => {
    await mountScreen({ routes: { "/api/runbot/dumps": { dumps: [] } } });
    await openForm();
    await pickSource("Local branch");
    const search = field("Branch").querySelector<HTMLInputElement>(".branch-cb-input")!;
    expect(document.activeElement).toBe(search);
    typeInto(search, "feat");
    await app.settle();
    expect(branchRows()).toEqual(["master-feat:community/local,enterprise/local"]);
    expect(dialogButton("Create").disabled).toBe(true); // nothing picked yet
    await pickBranchRow("master-feat");
    expect(search.value).toBe("master-feat");
    expect(input("Name").value).toBe("master-feat");
    expect(configText()).toBe("community:master-feat,enterprise:master-feat");
    expect(app.callsTo("/api/code/remote-branch/fetch")).toEqual([]); // already local
    expect(app.callsTo("/api/runbot/dumps").map((c) => c.body)).toEqual([{ branch: "master" }]);
    await click(dialogButton("Create"));
    expect(app.callsTo("/api/code/branches/create")).toEqual([]);
    expect(listNames()).toContain("master-feat");
  });

  it("arrow keys and Enter pick a result; Escape closes the list, not the dialog", async () => {
    await mountScreen({
      repos: featRepos({
        branches: [branch("master-feat"), branch("master-feat-2")],
      }),
      routes: { "/api/runbot/dumps": { dumps: [] } },
    });
    await openForm();
    await pickSource("Local branch");
    const search = field("Branch").querySelector<HTMLInputElement>(".branch-cb-input")!;
    typeInto(search, "feat");
    await app.settle();
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await app.settle();
    expect(dialog()).not.toBeNull();
    expect(branchRows()).toEqual([]); // list closed
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    await app.settle();
    expect(mustDialog().querySelector(".rbd-row.selected .rbd-branch")!.textContent).toBe(
      "master-feat-2",
    );
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await app.settle();
    expect(input("Name").value).toBe("master-feat-2");
  });

  it("the arrow keys scroll the highlighted result into view", async () => {
    // jsdom has no layout, so no scrollIntoView: record which row asks to be shown
    const shown: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      shown.push(this.querySelector(".rbd-branch")!.textContent!);
    };
    try {
      await mountScreen({
        repos: featRepos({
          branches: [branch("master-feat-1"), branch("master-feat-2"), branch("master-feat-3")],
        }),
      });
      await openForm();
      await pickSource("Local branch");
      const search = field("Branch").querySelector<HTMLInputElement>(".branch-cb-input")!;
      typeInto(search, "feat");
      await app.settle();
      const key = async (k: string) => {
        search.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
        await app.settle();
      };
      await key("ArrowDown");
      await key("ArrowDown");
      await key("ArrowDown"); // wraps around to the first
      await key("ArrowUp"); // and back to the last
      expect(shown).toEqual(["master-feat-2", "master-feat-3", "master-feat-1", "master-feat-3"]);
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });
});

describe("New workspace — from a remote branch", () => {
  it("searches GitHub and fetches the picked branch before attaching it", async () => {
    await mountScreen({
      routes: {
        "/api/code/remote-branches/search": {
          ok: true,
          results: [{ repo: "enterprise", branch: "master-colleague", remote: "dev" }],
        },
        "/api/code/remote-branch/fetch": { ok: true },
        "/api/runbot/dumps": { dumps: [] },
      },
    });
    await openForm();
    await pickSource("Remote branch");
    typeInto(field("Branch").querySelector<HTMLInputElement>(".branch-cb-input")!, "colleague");
    await vi.waitFor(async () => {
      await app.settle();
      expect(branchRows()).toEqual(["master-colleague:enterprise/remote"]);
    });
    expect(app.callsTo("/api/code/remote-branches/search")[0].body).toMatchObject({
      query: "colleague",
    });
    await pickBranchRow("master-colleague");
    expect(app.callsTo("/api/code/remote-branch/fetch").map((c) => c.body)).toEqual([
      {
        path: "/home/odoo/work/enterprise",
        branch: "master-colleague",
        pull_remote: "dev",
        force: false,
      },
    ]);
    expect(input("Name").value).toBe("master-colleague");
    expect(configText()).toBe("enterprise:master-colleague");
    expect(dialogButton("Create").disabled).toBe(false);
  });

  it("reports a failed fetch and loads nothing", async () => {
    await mountScreen({
      routes: {
        "/api/code/remote-branches/search": {
          ok: true,
          results: [{ repo: "community", branch: "master-gone", remote: "origin" }],
        },
        "/api/code/remote-branch/fetch": failure(500, { error: "no such ref" }),
      },
    });
    await openForm();
    await pickSource("Remote branch");
    typeInto(field("Branch").querySelector<HTMLInputElement>(".branch-cb-input")!, "gone");
    await vi.waitFor(async () => {
      await app.settle();
      expect(branchRows()).toHaveLength(1);
    });
    await pickBranchRow("master-gone");
    expect(dialogTitle()).toBe("Fetching branch failed");
    expect(mustDialog().textContent).toContain("community: no such ref");
    await click(dialogButton("OK"));
    expect(input("Name").value).toBe("");
    expect(mustDialog().querySelector(".form-error")).toBeNull(); // untouched yet
    expect(dialogButton("Create").disabled).toBe(true);
  });
});

describe("New workspace — from a pull request", () => {
  async function fromPr(url: string, routes: Record<string, Route> = {}) {
    await mountScreen({ routes });
    await openForm();
    await pickSource("Pull request");
    await type("Pull request URL", url);
    await click(mustText(field("Pull request URL"), "Load"));
  }

  it("fetches the PR's head and attaches it", async () => {
    await fromPr("https://github.com/odoo/enterprise/pull/42/files", {
      "/api/prs/head": { branch: "master-fix-pr" },
      "/api/code/remote-branch/fetch-pr": { ok: true },
      "/api/runbot/dumps": { dumps: [] },
    });
    expect(app.callsTo("/api/prs/head").map((c) => c.body)).toEqual([
      { repo: "odoo/enterprise", number: 42 },
    ]);
    expect(app.callsTo("/api/code/remote-branch/fetch-pr").map((c) => c.body)).toEqual([
      {
        path: "/home/odoo/work/enterprise",
        github: "odoo/enterprise",
        number: 42,
        branch: "master-fix-pr",
        force: false,
      },
    ]);
    expect(input("Name").value).toBe("master-fix-pr");
    expect(configText()).toBe("enterprise:master-fix-pr");
    expect(dialogButton("Create").disabled).toBe(false);
  });

  it("refuses a URL that isn't a pull request", async () => {
    await fromPr("https://github.com/odoo/odoo");
    expect(dialogTitle()).toBe("Pull request");
    expect(mustDialog().textContent).toContain("not a pull request URL");
  });

  it("refuses a pull request in a repository goo doesn't know", async () => {
    await fromPr("https://github.com/acme/thing/pull/1");
    expect(mustDialog().textContent).toContain("acme/thing isn't one of your configured repos");
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
    expect(configText()).toBe(`community:${FW_BRANCH}`);
    // the child lands in its parent's category
    expect(field("Category").querySelector("select")!.value).toBe("dev");
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
