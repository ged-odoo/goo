// The Configuration screen's list editors (repositories, Docker images, templates,
// categories, test presets), the Tabs editor and the Navbar links editor: each
// edit is saved to /api/config, and the test asserts the list the server stored.
import { afterEach, describe, expect, it } from "vitest";
import { mountApp, type MountedApp } from "../helpers/app.ts";
import {
  byText,
  check,
  configBackend,
  pointer,
  savesFrom,
  setRect,
  type,
  until,
} from "../helpers/screen_fixtures.ts";
import type { Config, TemplateConfig, WorkspaceConfig } from "../../src/core/config.ts";

let app: MountedApp;
let be: ReturnType<typeof configBackend>;
afterEach(() => app?.destroy());

async function openConfig(config: Partial<Config> = {}) {
  // no legacy targets: they'd migrate into workspaces/templates of their own
  be = configBackend({ targets: [], ...config });
  app = await mountApp({
    section: "config",
    routes: {
      "/api/config": be.route,
      "/api/goo/update": { ok: true, checked: true },
      "/api/rust-bundler": { installed: true, current: true, version: "1" },
      "/api/review-prompt": { content: "" },
    },
  });
  be.saves.length = 0;
}
// wait for the next debounced save → the config the server stored
async function saved(): Promise<Config> {
  const n = be.saves.length;
  await until(app, () => be.saves.length > n);
  return be.last().config!;
}

const block = (title: string) =>
  [...app.root.querySelectorAll<HTMLElement>(".config-block")].find(
    (b) => b.querySelector("h2")?.textContent === title,
  )!;
const field = (scope: Element, placeholder: string, i = 0) =>
  scope.querySelectorAll<HTMLInputElement>(`input[placeholder="${placeholder}"]`)[i];
const message = (title: string) => block(title).querySelector(".config-actions span")!;
const escape = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
const stack = (els: Iterable<Element>) =>
  [...els].forEach((el, i) => setRect(el, { top: i * 40, height: 40 }));

describe("Repositories editor", () => {
  it("saves an edited repository, keeping its stored-only keys", async () => {
    await openConfig();
    const card = block("Repositories").querySelectorAll(".edit-card")[0];
    expect(field(card, "community").value).toBe("community");
    type(field(card, "~/work/community"), " /src/community ");
    const repos = (await saved()).repos;
    expect(repos.map((r) => r.id)).toEqual(["community", "enterprise"]);
    expect(repos[0]).toMatchObject({
      id: "community",
      path: "/src/community",
      github: "odoo/odoo",
      pull_remote: "origin",
      push_remote: "dev",
      favorite: true, // carried through though no field edits it
    });

    check(card.querySelector<HTMLInputElement>("input[type=checkbox]")!); // auto-reload
    expect((await saved()).repos[0].autoreload).toBe(true);
  });

  it("refuses to lose the main repository, showing why", async () => {
    await openConfig();
    const card = block("Repositories").querySelectorAll(".edit-card")[0];
    type(field(card, "community"), "core");
    await app.settle();
    expect(message("Repositories").classList).toContain("error");
    expect(message("Repositories").textContent).toContain('a "community" repository is required');
    expect(be.saves).toHaveLength(0);
  });

  it("refuses to remove a repository a workspace still uses", async () => {
    const ws = {
      id: "w1",
      name: "feature",
      checkouts: [{ repo: "enterprise", branch: "master" }],
    } as unknown as WorkspaceConfig;
    await openConfig({ workspaces: [ws] });
    block("Repositories").querySelectorAll<HTMLButtonElement>(".edit-card-remove")[1].click();
    await app.settle();
    expect(message("Repositories").textContent).toBe(
      'repository "enterprise" is still used by workspace "feature"',
    );
    expect(be.saves).toHaveLength(0);
  });

  it("adds a repository once its required fields are filled; removes one", async () => {
    await openConfig();
    byText(block("Repositories"), "Add repository").click();
    await app.settle();
    const cards = block("Repositories").querySelectorAll(".edit-card");
    expect(cards).toHaveLength(3);
    // a new row starts with the default remotes
    expect(field(cards[2], "origin").value).toBe("origin");
    expect(field(cards[2], "dev").value).toBe("dev");
    // half-filled: saved without it, silently
    type(field(cards[2], "community"), "tutorials");
    expect((await saved()).repos.map((r) => r.id)).toEqual(["community", "enterprise"]);
    expect(message("Repositories").textContent).toBe("");
    type(field(cards[2], "~/work/community"), "/src/tutorials");
    const repos = (await saved()).repos;
    expect(repos[2]).toMatchObject({
      id: "tutorials",
      path: "/src/tutorials",
      pull_remote: "origin",
      push_remote: "dev",
    });

    block("Repositories").querySelectorAll<HTMLButtonElement>(".edit-card-remove")[1].click();
    expect((await saved()).repos.map((r) => r.id)).toEqual(["community", "tutorials"]);
  });

  it("does not save a duplicated repository name", async () => {
    await openConfig();
    byText(block("Repositories"), "Add repository").click();
    await app.settle();
    const card = block("Repositories").querySelectorAll(".edit-card")[2];
    type(field(card, "~/work/community"), "/elsewhere", false);
    expect(savesFrom(app, () => type(field(card, "community"), "community"))).toBe(0);
  });
});

describe("Docker images editor", () => {
  it("only shows in docker mode, and requires exactly one default image", async () => {
    await openConfig();
    expect(block("Docker images")).toBeUndefined();
    app.destroy();

    await openConfig({ launch_mode: "docker" });
    const b = block("Docker images");
    byText(b, "Add image").click();
    await app.settle();
    const card = b.querySelectorAll(".edit-card")[0];
    type(field(card, "16.0,17.0"), "16.0, 17.0,");
    type(field(card, "jammy (16.0/17.0)"), "jammy");
    await app.settle();
    expect(message("Docker images").textContent).toBe("one Docker image must be marked default");
    expect(be.saves).toHaveLength(0);

    check(card.querySelector<HTMLInputElement>("input[type=checkbox]")!);
    const [img] = (await saved()).docker_images;
    expect(img).toMatchObject({ label: "jammy", versions: ["16.0", "17.0"], is_default: true });
    expect(img.id).toBeTruthy(); // minted for the new row

    byText(b, "Add image").click();
    await app.settle();
    const second = b.querySelectorAll(".edit-card")[1];
    type(field(second, "jammy (16.0/17.0)"), "noble", false);
    type(field(second, "16.0,17.0"), "18.0");
    check(second.querySelector<HTMLInputElement>("input[type=checkbox]")!);
    await app.settle();
    expect(message("Docker images").textContent).toBe(
      "only one Docker image may be marked default",
    );
  });

  it("shows stored images with their version list", async () => {
    await openConfig({
      launch_mode: "docker",
      docker_images: [
        { id: "i1", label: "noble", versions: ["18.0", "saas-18"], is_default: true },
      ],
    });
    const card = block("Docker images").querySelector(".edit-card")!;
    expect(field(card, "16.0,17.0").value).toBe("18.0,saas-18");
    expect(card.querySelector<HTMLInputElement>("input[type=checkbox]")!.checked).toBe(true);
  });
});

describe("Templates editor", () => {
  const tpl = (id: string, name: string, branch: string): TemplateConfig => ({
    id,
    name,
    db: "",
    on_create_args: "",
    demo_data: true,
    category: "",
    checkouts: [{ repo: "community", branch }],
  });

  it("edits a template's checkouts in repo:branch form, keeping its id", async () => {
    await openConfig({ templates: [tpl("t1", "master", "master")] });
    const b = block("Workspace templates");
    const checkouts = field(b, "community:master,enterprise:master");
    expect(checkouts.value).toBe("community:master");
    type(checkouts, "community:17.0, enterprise:17.0");
    const [t] = (await saved()).templates;
    expect(t).toMatchObject({
      id: "t1",
      name: "master",
      checkouts: [
        { repo: "community", branch: "17.0" },
        { repo: "enterprise", branch: "17.0" },
      ],
    });
  });

  it("adds a template with a fresh id", async () => {
    await openConfig({ templates: [tpl("t1", "master", "master")] });
    const b = block("Workspace templates");
    byText(b, "Add template").click();
    await app.settle();
    type(field(b, "name (e.g. master)", 1), "saas", false);
    type(field(b, "community:master,enterprise:master", 1), "community:saas-18.1");
    const templates = (await saved()).templates;
    expect(templates.map((t) => t.name)).toEqual(["master", "saas"]);
    expect(templates[1].id).toBeTruthy();
    expect(templates[1].id).not.toBe("t1");
    expect(templates[1].demo_data).toBe(true); // the new row's default
  });

  it("reorders templates by dragging, and Escape cancels a drag", async () => {
    await openConfig({
      templates: [tpl("t1", "a", "master"), tpl("t2", "b", "17.0"), tpl("t3", "c", "16.0")],
    });
    const names = () =>
      [...block("Workspace templates").querySelectorAll<HTMLInputElement>(".edit-row .w-name")]
        .filter((i) => i.placeholder === "name (e.g. master)")
        .map((i) => i.value);
    const rows = block("Workspace templates").querySelectorAll(".edit-row");
    stack(rows);
    pointer("pointerdown", 0, 90, rows[2].querySelector(".row-handle")!);
    pointer("pointermove", 0, 5);
    await app.settle();
    expect(names()).toEqual(["c", "a", "b"]);
    escape();
    await app.settle();
    expect(names()).toEqual(["a", "b", "c"]);
    expect(be.saves).toHaveLength(0);

    pointer("pointerdown", 0, 5, rows[0].querySelector(".row-handle")!);
    pointer("pointermove", 0, 200);
    pointer("pointerup", 0, 200);
    expect((await saved()).templates.map((t) => t.id)).toEqual(["t2", "t3", "t1"]);
  });
});

describe("Categories and test presets editors", () => {
  it("removes a category", async () => {
    await openConfig();
    const b = block("Workspace categories");
    expect(
      [...b.querySelectorAll<HTMLInputElement>(".edit-row input")].map((i) => i.value),
    ).toEqual(["dev", "base"]);
    b.querySelector<HTMLButtonElement>(".row-remove")!.click();
    expect((await saved()).workspace_categories).toEqual([{ id: "base" }]);
  });

  it("adds a test preset, skipping a blank row", async () => {
    await openConfig();
    const b = block("Test presets");
    byText(b, "Add preset").click();
    byText(b, "Add preset").click();
    await app.settle();
    type(b.querySelectorAll<HTMLInputElement>(".edit-row input")[1], " /sale:TestUi ");
    expect((await saved()).test_presets).toEqual([
      { tags: "/web:WebSuite[@web]" },
      { tags: "/sale:TestUi" },
    ]);
  });
});

describe("Tabs editor", () => {
  const tabLabels = () =>
    [...block("Tabs").querySelectorAll(".tab-row")].map((l) => l.textContent!.trim());
  const tabBox = (label: string) =>
    [...block("Tabs").querySelectorAll(".tab-row")]
      .find((l) => l.textContent!.trim() === label)!
      .querySelector<HTMLInputElement>("input")!;
  const sidebar = () =>
    [...app.root.querySelectorAll(".sidebar .nav-item .nav-label")].map((s) => s.textContent);

  it("lists every tab, opt-in ones off and Configuration locked on", async () => {
    await openConfig();
    expect(tabLabels()).toEqual([
      "Workspaces",
      "Branches & PRs",
      "Reviews",
      "Todo",
      "Databases",
      "Memory",
      "CI",
      "Configuration",
    ]);
    expect(tabBox("Todo").checked).toBe(false);
    expect(tabBox("Databases").checked).toBe(true);
    expect(tabBox("Configuration").disabled).toBe(true);
  });

  it("showing or hiding a tab saves it and updates the sidebar", async () => {
    await openConfig();
    expect(sidebar()).not.toContain("Todo");
    check(tabBox("Todo"));
    const tabs = (await saved()).tabs!;
    expect(tabs.find((t) => t.id === "todo")).toEqual({ id: "todo", visible: true });
    expect(sidebar()).toContain("Todo");

    check(tabBox("Databases"), false);
    expect((await saved()).tabs!.find((t) => t.id === "databases")!.visible).toBe(false);
    expect(sidebar()).not.toContain("Databases");
  });

  it("reorders tabs by dragging", async () => {
    await openConfig();
    const rows = block("Tabs").querySelectorAll(".edit-row");
    stack(rows);
    // drag Configuration (last) to the top
    pointer("pointerdown", 0, 7 * 40 + 5, rows[7].querySelector(".row-handle")!);
    pointer("pointermove", 0, 5);
    await app.settle();
    expect(tabLabels()[0]).toBe("Configuration");
    pointer("pointerup", 0, 5);
    const tabs = (await saved()).tabs!;
    expect(tabs[0]).toEqual({ id: "config", visible: true });
    expect(tabs).toHaveLength(8);
    expect(sidebar()[0]).toBe("Configuration");
  });

  it("Escape cancels a tab drag without saving", async () => {
    await openConfig();
    const rows = block("Tabs").querySelectorAll(".edit-row");
    stack(rows);
    pointer("pointerdown", 0, 5, rows[0].querySelector(".row-handle")!);
    pointer("pointermove", 0, 1000);
    await app.settle();
    expect(tabLabels().at(-1)).toBe("Workspaces");
    expect(savesFrom(app, escape)).toBe(0);
    await app.settle();
    expect(tabLabels()[0]).toBe("Workspaces");
  });
});

describe("Navbar links editor", () => {
  const editor = () => app.root.querySelector<HTMLElement>(".links-editor")!;

  it("edits, adds and removes top-level links, dropping blank ones", async () => {
    await openConfig({ links: [{ label: "docs", href: "https://a" }] });
    const e = editor();
    type(field(e, "label"), " handbook ");
    expect((await saved()).links).toEqual([{ label: "handbook", href: "https://a" }]);

    byText(e, "Add link").click();
    await app.settle();
    type(field(e, "label", 1), "runbot", false);
    type(field(e, "href (https://…)", 1), "https://runbot");
    expect((await saved()).links).toEqual([
      { label: "handbook", href: "https://a" },
      { label: "runbot", href: "https://runbot" },
    ]);

    e.querySelector<HTMLButtonElement>(".link-row .row-remove")!.click();
    expect((await saved()).links).toEqual([{ label: "runbot", href: "https://runbot" }]);
  });

  it("builds a menu of links; an empty menu is kept, blank children are not", async () => {
    await openConfig({ links: [] });
    const e = editor();
    byText(e, "Add menu").click();
    await app.settle();
    type(field(e, "menu name"), "CI");
    expect((await saved()).links).toEqual([{ label: "CI", children: [] }]);

    byText(e, "+ link").click();
    byText(e, "+ link").click();
    await app.settle();
    const child = e.querySelectorAll(".link-child")[0];
    type(field(child, "label"), "mergebot", false);
    type(field(child, "href (https://…)"), "https://mergebot");
    expect((await saved()).links).toEqual([
      { label: "CI", children: [{ label: "mergebot", href: "https://mergebot" }] },
    ]);

    e.querySelector<HTMLButtonElement>(".link-child .row-remove")!.click();
    expect((await saved()).links).toEqual([{ label: "CI", children: [] }]);
    e.querySelector<HTMLButtonElement>(".link-menu-head .row-remove")!.click();
    expect((await saved()).links).toEqual([]);
  });

  describe("dragging", () => {
    // jsdom has no layout: the drag hit-tests through elementFromPoint, so each
    // test says which element is "under the pointer"
    let under: Element | null = null;
    const original = document.elementFromPoint;
    afterEach(() => {
      document.elementFromPoint = original;
    });
    async function drag(handle: Element, target: () => Element | null) {
      document.elementFromPoint = () => under;
      pointer("pointerdown", 0, 0, handle);
      await app.settle();
      under = target();
      pointer("pointermove", 1, 1);
      await app.settle();
    }
    const MENU = {
      label: "CI",
      children: [
        { label: "runbot", href: "https://runbot" },
        { label: "mergebot", href: "https://mergebot" },
      ],
    };
    const handleOf = (label: string) =>
      [...editor().querySelectorAll(".edit-row")]
        .find((r) => r.querySelector<HTMLInputElement>("input")!.value === label)!
        .querySelector(".row-handle")!;
    const rowOf = (label: string) => handleOf(label).closest(".edit-row")!;

    it("drops a link into a menu", async () => {
      await openConfig({ links: [{ label: "docs", href: "https://docs" }, MENU] });
      await drag(handleOf("docs"), () => editor().querySelector(".link-menu-body"));
      expect(editor().querySelector(".link-menu-body.drag-over")).not.toBeNull();
      pointer("pointerup", 1, 1);
      expect((await saved()).links).toEqual([
        {
          label: "CI",
          children: [...MENU.children, { label: "docs", href: "https://docs" }],
        },
      ]);
    });

    it("drops a menu link before a top-level row", async () => {
      await openConfig({ links: [MENU, { label: "docs", href: "https://docs" }] });
      await drag(handleOf("mergebot"), () => rowOf("docs").querySelector("input"));
      expect(rowOf("docs").classList).toContain("drag-over");
      pointer("pointerup", 1, 1);
      expect((await saved()).links).toEqual([
        { label: "CI", children: [MENU.children[0]] },
        { label: "mergebot", href: "https://mergebot" },
        { label: "docs", href: "https://docs" },
      ]);
    });

    it("moves a menu link to the end of the top level", async () => {
      await openConfig({ links: [MENU] });
      await drag(handleOf("runbot"), () => editor().querySelector(".links-drop-end"));
      expect(editor().querySelector(".links-drop-end.drag-over")).not.toBeNull();
      pointer("pointerup", 1, 1);
      expect((await saved()).links).toEqual([
        { label: "CI", children: [MENU.children[1]] },
        { label: "runbot", href: "https://runbot" },
      ]);
      expect(editor().querySelector(".links-drop-end")).toBeNull(); // only while dragging
    });

    it("won't nest a menu in a menu, and Escape cancels", async () => {
      const other = { label: "Docs", children: [{ label: "odoo", href: "https://odoo" }] };
      await openConfig({ links: [MENU, other] });
      // a menu dropped into another menu's body: nothing moves
      await drag(handleOf("Docs"), () => editor().querySelector(".link-menu-body"));
      const drop = () => pointer("pointerup", 1, 1);
      expect(savesFrom(app, drop)).toBe(0);
      // …nor before a row inside a menu
      await drag(handleOf("Docs"), () => rowOf("runbot"));
      expect(savesFrom(app, drop)).toBe(0);
      // a link dragged then cancelled stays put
      await drag(handleOf("odoo"), () => editor().querySelector(".links-drop-end"));
      expect(savesFrom(app, escape)).toBe(0);
      await app.settle();
      expect(editor().querySelectorAll(".link-menu")).toHaveLength(2);
    });
  });
});
