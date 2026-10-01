// The Configuration screen's settings, launch mode, rust bundler, update check,
// review prompt, presets, reset and backup — against a fake backend whose
// /api/config stores what the screen saves (rev-checked, see configBackend).
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountApp, type MountedApp, type Route } from "../helpers/app.ts";
import {
  answer,
  byText,
  check,
  configBackend,
  dialog,
  type,
  until,
} from "../helpers/screen_fixtures.ts";
import type { Config } from "../../src/core/config.ts";

let app: MountedApp;
afterEach(() => {
  app?.destroy();
  vi.restoreAllMocks();
});

const fail =
  (error: string, status = 500) =>
  () =>
    new Response(JSON.stringify({ ok: false, error }), { status });

async function openConfig(config: Partial<Config> = {}, routes: Record<string, Route> = {}) {
  const be = configBackend(config);
  app = await mountApp({
    section: "config",
    routes: {
      "/api/config": be.route,
      "/api/goo/update": { ok: true, checked: true, behind: 0 },
      "/api/rust-bundler": { installed: true, current: true, version: "1.2" },
      "/api/review-prompt": { ok: true, content: "" },
      ...routes,
    },
  });
  be.saves.length = 0; // only what the screen saves from here on
  return be;
}

const input = (id: string) => app.root.querySelector<HTMLInputElement>(`#${id}`)!;
const labels = () =>
  [...app.root.querySelectorAll(".settings-grid label")].map((l) => l.getAttribute("for"));
describe("Config screen — settings", () => {
  it("saves a trimmed text setting with the current rev, and shows it when reopened", async () => {
    const be = await openConfig();
    const rev = be.rev(); // the server's rev once the app booted
    const user = input("setting-db_user");
    expect(user.value).toBe("odoo");
    type(user, "  pierre ");
    await until(app, () => be.saves.length);
    expect(be.last().rev).toBe(rev);
    expect(be.last().config).toMatchObject({ db_user: "pierre", db_password: "odoo" });

    // a second edit goes out with the rev the first save returned
    type(input("setting-editor"), "nvim");
    await until(app, () => be.saves.length === 2);
    expect(be.last().rev).toBe(rev + 1);
    expect(be.last().config).toMatchObject({ editor: "nvim", db_user: "pierre" });
    // the screen opened afresh shows the saved value
    await app.navigate("todo");
    await app.navigate("config");
    expect(input("setting-db_user").value).toBe("pierre");
  });

  it("switching launch mode saves it and shows that mode's settings", async () => {
    const be = await openConfig();
    expect(labels()).toContain("setting-server_path");
    expect(labels()).not.toContain("setting-docker_network");
    expect(app.root.textContent).not.toContain("Docker images");

    check(app.root.querySelector<HTMLInputElement>("input[name=launch-mode][value=docker]")!);
    await until(app, () => be.saves.length);
    expect(be.last().config!.launch_mode).toBe("docker");
    expect(labels()).toContain("setting-docker_network");
    expect(labels()).toContain("setting-docker-headed-browser");
    expect(labels()).not.toContain("setting-server_path");
    expect(labels()).not.toContain("setting-db_host");
    expect(app.root.querySelector(".launch-mode-option.selected")!.textContent).toContain("Docker");
    expect(app.root.textContent).toContain("Docker images");

    check(input("setting-docker-headed-browser"));
    await until(app, () => be.last().config!.docker_headed_browser);

    check(app.root.querySelector<HTMLInputElement>("input[name=launch-mode][value=external]")!);
    await until(app, () => be.last().config!.launch_mode === "external");
    expect(labels()).toContain("setting-db_host");
    expect(labels()).not.toContain("setting-worktree_dir");
    // the rust bundler only applies to a local launch
    expect(app.root.querySelector("label[for=setting-rust-bundler]")!.classList).toContain("dim");
  });

  it("saves each Miscellaneous toggle", async () => {
    const be = await openConfig();
    const toggles: [string, keyof Config, boolean][] = [
      ["setting-auto-open-event-log", "auto_open_event_log", true],
      ["setting-rust-bundler", "rust_bundler", true],
      ["setting-update-check", "update_check", false],
      ["setting-ws-categories", "workspace_categories_enabled", true],
      ["setting-autologin-links", "autologin_links", false],
      ["setting-cleanup-enabled", "cleanup_enabled", true],
    ];
    for (const [id, , value] of toggles) check(input(id), value);
    await until(app, () => be.saves.length);
    for (const [, key, value] of toggles) expect(be.last().config![key]).toBe(value);

    const loc = app.root.querySelector<HTMLSelectElement>("#setting-default-ws-location")!;
    loc.value = "worktree";
    loc.dispatchEvent(new Event("change", { bubbles: true }));
    await until(app, () => be.last().config!.default_workspace_location === "worktree");
  });

  it("offers the auto Claude review only once auto-created review workspaces are on", async () => {
    const be = await openConfig();
    expect(app.root.querySelector("#setting-auto-claude-review")).toBeNull();
    check(input("setting-auto-workspace-on-review"));
    await app.settle();
    check(input("setting-auto-claude-review"));
    await until(app, () => be.saves.length);
    expect(be.last().config).toMatchObject({
      auto_workspace_on_review: true,
      auto_claude_review: true,
    });
  });
});

describe("Config screen — rust bundler", () => {
  const statusText = () =>
    app.root.querySelector(".rust-bundler-control span.dim")!.textContent!.trim();

  it.each([
    [{ installed: false, expected_version: "2.0" }, "not installed (expected 2.0)"],
    [{ installed: false }, "not installed (expected unknown)"],
    [
      { installed: true, current: false, version: "1.0", expected_version: "2.0" },
      "update required (1.0 → 2.0)",
    ],
    [
      { installed: true, current: true, version: "2.0", restart_required: true },
      "installed 2.0; restart Odoo to load it",
    ],
    [{ installed: true, current: true, version: "2.0" }, "installed 2.0"],
  ])("shows the install status %o", async (status, text) => {
    await openConfig({}, { "/api/rust-bundler": status });
    expect(statusText()).toBe(text);
  });

  it("shows a status check failure", async () => {
    await openConfig({}, { "/api/rust-bundler": fail("no cargo") });
    expect(statusText()).toBe("failed: no cargo");
    expect(app.root.querySelector(".rust-bundler-control span.error")).not.toBeNull();
  });

  it("builds the bundler and shows the new status", async () => {
    await openConfig(
      {},
      {
        "/api/rust-bundler": { installed: false, expected_version: "2.0" },
        "/api/rust-bundler/install": {
          installed: true,
          current: true,
          version: "2.0",
          restart_required: true,
        },
      },
    );
    byText(app.root, "Build / update Rust bundler").click();
    await app.settle();
    expect(app.callsTo("/api/rust-bundler/install")).toHaveLength(1);
    expect(statusText()).toBe("installed 2.0; restart Odoo to load it");
    expect(byText(app.root, "Build / update Rust bundler").disabled).toBe(false);
  });

  it("reports a failed build", async () => {
    await openConfig({}, { "/api/rust-bundler/install": fail("cargo: not found") });
    byText(app.root, "Build / update Rust bundler").click();
    await app.settle();
    expect(dialog()!.textContent).toContain("Rust bundler build failed");
    expect(dialog()!.textContent).toContain("cargo: not found");
    expect(statusText()).toBe("failed: cargo: not found");
  });
});

describe("Config screen — update check", () => {
  it("shows a quiet check mark when goo is up to date", async () => {
    await openConfig({}, { "/api/goo/check": { ok: true, behind: 0 } });
    byText(app.root, "Check for update").click();
    await app.settle();
    expect(app.callsTo("/api/goo/check")).toHaveLength(1);
    expect(app.root.querySelector(".check-uptodate")!.textContent).toContain("up to date");
    expect(dialog()).toBeNull();
  });

  it("explains a manual update when goo can't fast-forward", async () => {
    await openConfig(
      {},
      { "/api/goo/check": { ok: true, behind: 3, ahead: 1, can_fast_forward: false } },
    );
    byText(app.root, "Check for update").click();
    await app.settle();
    expect(dialog()!.textContent).toContain("goo update available");
    expect(dialog()!.textContent).toContain("3 commits behind origin/master");
    expect(app.root.querySelector(".check-uptodate")).toBeNull();
  });

  it("reports a check that couldn't reach origin", async () => {
    await openConfig({}, { "/api/goo/check": fail("no remote") });
    byText(app.root, "Check for update").click();
    await app.settle();
    expect(dialog()!.textContent).toContain("Couldn't check for updates");
  });
});

describe("Config screen — review prompt", () => {
  it("loads the prompt file and saves edits after a pause in typing", async () => {
    await openConfig({}, { "/api/review-prompt": { ok: true, content: "Review {{branch}}" } });
    const area = app.root.querySelector<HTMLTextAreaElement>(".review-prompt-input")!;
    expect(area.value).toBe("Review {{branch}}");
    type(area, "Review", false);
    type(area, "Review {{repos}} carefully", false);
    const saves = () => app.callsTo("/api/review-prompt").filter((c) => c.method === "POST");
    await until(app, () => saves().length);
    // one save, of the final text
    expect(saves().map((c) => c.body)).toEqual([{ content: "Review {{repos}} carefully" }]);
  });
});

describe("Config screen — presets and reset", () => {
  it("applies a chosen preset (replacing the whole config), or nothing when cancelled", async () => {
    const be = await openConfig({ editor: "emacs" });
    byText(app.root, "Presets").click();
    await app.settle();
    expect(dialog()!.textContent).toContain("Configuration presets");
    await answer(app, false);
    expect(be.saves).toHaveLength(0);

    byText(app.root, "Presets").click();
    await app.settle();
    const select = dialog()!.querySelector<HTMLSelectElement>("select")!;
    select.value = "ged";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await app.settle();
    await answer(app, true);
    expect(be.saves).toHaveLength(1);
    const saved = be.last().config!;
    expect(saved.editor).toBe("code"); // the preset's, not ours
    expect(JSON.stringify(saved.links)).toContain("mergebot.odoo.com");
  });

  it("resets to the initial config only after confirmation", async () => {
    const be = await openConfig({ editor: "emacs", db_user: "me" });
    byText(app.root, "Reset to initial config").click();
    await app.settle();
    expect(dialog()!.classList).toContain("dialog-error");
    await answer(app, false);
    expect(be.saves).toHaveLength(0);

    byText(app.root, "Reset to initial config").click();
    await app.settle();
    await answer(app, true);
    expect(be.last().config).toMatchObject({ editor: "code", db_user: "odoo" });
  });
});

describe("Config screen — backup", () => {
  it("exports the config and state as a JSON file", async () => {
    let blob: Blob | undefined;
    URL.createObjectURL = vi.fn((b: Blob) => {
      blob = b;
      return "blob:goo";
    });
    URL.revokeObjectURL = vi.fn();
    await openConfig({ editor: "emacs" });
    byText(app.root, "Export").click();
    await app.settle();
    const data = JSON.parse(await blob!.text());
    expect(data.config.editor).toBe("emacs");
    expect(data).toHaveProperty("state");
    expect(app.root.textContent).toContain("Exported.");
  });

  async function importFile(text: string) {
    const fileInput = app.root.querySelector<HTMLInputElement>("#goo-import-file")!;
    Object.defineProperty(fileInput, "files", {
      value: [new File([text], "goo-backup.json")],
      configurable: true,
    });
    fileInput.dispatchEvent(new Event("change"));
    await app.settle();
  }

  it("imports a backup, storing its config on the server", async () => {
    const be = await openConfig();
    const click = vi.fn();
    app.root.querySelector<HTMLInputElement>("#goo-import-file")!.click = click;
    byText(app.root, "Import").click();
    expect(click).toHaveBeenCalled(); // opens the file picker
    await importFile(JSON.stringify({ config: { editor: "vim", db_user: "bob" }, state: {} }));
    await until(app, () => be.saves.length);
    expect(be.last().config).toMatchObject({ editor: "vim", db_user: "bob" });
    expect(app.root.textContent).toContain("Imported, reloading…");
  });

  it("refuses a file that isn't a goo backup", async () => {
    const be = await openConfig();
    await importFile(JSON.stringify({ hello: 1 }));
    expect(app.root.textContent).toContain("Import failed: not a goo config backup");
    await importFile("{broken");
    expect(app.root.textContent).toContain("Import failed:");
    expect(be.saves).toHaveLength(0);
  });
});
