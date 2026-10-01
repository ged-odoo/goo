import { afterEach, describe, expect, it } from "vitest";
import { DialogPlugin, type DialogValues } from "../../src/core/dialog_plugin.ts";
import { button, mountCore, typeInto, type MountedCore } from "../helpers/core_ui_fixtures.ts";

let core: MountedCore;
afterEach(() => core?.destroy());

async function openDialog(spec: Parameters<InstanceType<typeof DialogPlugin>["open"]>[0]) {
  core = await mountCore(null);
  const result = core.plugin(DialogPlugin).open(spec);
  await core.settle();
  const dialog = core.el.querySelector<HTMLElement>(".dialog")!;
  return { result, dialog };
}

describe("Dialog — a message dialog", () => {
  it("shows title + message and resolves {} on OK, closing itself", async () => {
    const { result, dialog } = await openDialog({ title: "Delete it?", message: "really" });
    expect(dialog.querySelector(".dialog-title")!.textContent).toBe("Delete it?");
    expect(dialog.querySelector(".dialog-msg")!.textContent).toBe("really");
    button(dialog, "OK").click();
    expect(await result).toEqual({});
    await core.settle();
    expect(core.el.querySelector(".dialog")).toBeNull();
  });

  it("Discard, Escape and a backdrop click all resolve null", async () => {
    const first = await openDialog({ title: "t", cancelLabel: "Nope" });
    button(first.dialog, "Nope").click();
    let result = first.result;
    expect(await result).toBeNull();
    core.destroy();

    ({ result } = await openDialog({ title: "t" }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(await result).toBeNull();
    core.destroy();

    ({ result } = await openDialog({ title: "t" }));
    core.el.querySelector<HTMLElement>(".dialog-backdrop")!.click();
    expect(await result).toBeNull();
  });

  it("the error modal has only an OK button", async () => {
    core = await mountCore(null);
    const result = core.plugin(DialogPlugin).error("Push failed", "rejected");
    await core.settle();
    const dialog = core.el.querySelector(".dialog.dialog-error")!;
    expect(dialog.textContent).toContain("rejected");
    expect([...dialog.querySelectorAll(".dialog-foot button")].map((b) => b.textContent)).toEqual([
      "OK",
    ]);
    button(dialog, "OK").click();
    expect(await result).toEqual({});
  });
});

describe("Dialog — form fields", () => {
  it("returns every field's edited value", async () => {
    const { result, dialog } = await openDialog({
      title: "New workspace",
      okLabel: "Create",
      fields: [
        { key: "name", label: "Name", value: "w1" },
        { key: "notes", type: "textarea", label: "Notes" },
        { key: "demo", type: "checkbox", label: "Demo data" },
        {
          key: "version",
          type: "select",
          label: "Version",
          options: [
            { value: "17.0", label: "17" },
            { value: "18.0", label: "18" },
          ],
        },
        {
          key: "repos",
          type: "repo-checks",
          label: "Repos",
          value: ["community"],
          options: [
            { value: "community", label: "community" },
            { value: "enterprise", label: "enterprise" },
          ],
        },
      ],
    });
    // the first text field is focused for typing straight away
    expect(document.activeElement).toBe(dialog.querySelector("input[type=text]"));
    typeInto(dialog.querySelector<HTMLInputElement>("input[type=text]")!, "w2");
    typeInto(dialog.querySelector("textarea")!, "hello");
    const demo = dialog.querySelectorAll<HTMLInputElement>("input[type=checkbox]")[0];
    demo.checked = true;
    demo.dispatchEvent(new Event("change"));
    const select = dialog.querySelector("select")!;
    select.value = "18.0";
    select.dispatchEvent(new Event("change"));
    const [community, enterprise] = [
      ...dialog.querySelectorAll<HTMLInputElement>(".dialog-repo-checks input"),
    ];
    expect(community.checked).toBe(true);
    enterprise.checked = true;
    enterprise.dispatchEvent(new Event("change"));
    community.checked = false;
    community.dispatchEvent(new Event("change"));
    await core.settle();
    button(dialog, "Create").click();
    expect(await result).toEqual({
      name: "w2",
      notes: "hello",
      demo: true,
      version: "18.0",
      repos: ["enterprise"],
    });
  });

  it("Enter in a text field submits the form", async () => {
    const { result, dialog } = await openDialog({ title: "t", fields: [{ key: "a" }] });
    const input = dialog.querySelector<HTMLInputElement>("input")!;
    typeInto(input, "x");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(await result).toEqual({ a: "x" });
  });

  it("onChange derives other fields; hint and visible follow the live values", async () => {
    const { result, dialog } = await openDialog({
      title: "t",
      fields: [
        {
          key: "branch",
          label: "Branch",
          onChange: (v) => ({ db: `${v}-db` }),
          hint: (vals: DialogValues) => (vals.branch === "taken" ? "already exists" : null),
        },
        { key: "db", label: "Database", visible: (vals: DialogValues) => vals.branch !== "" },
      ],
    });
    expect(dialog.querySelectorAll("input[type=text]").length).toBe(1); // db hidden while empty
    typeInto(dialog.querySelector<HTMLInputElement>("input")!, "taken");
    await core.settle();
    const inputs = dialog.querySelectorAll<HTMLInputElement>("input[type=text]");
    expect(inputs.length).toBe(2);
    expect(inputs[1].value).toBe("taken-db");
    expect(dialog.querySelector(".dialog-field-hint")!.textContent).toBe("already exists");
    button(dialog, "OK").click();
    expect(await result).toEqual({ branch: "taken", db: "taken-db" });
  });

  it("validate() disables OK, shows the error once edited, and blocks Enter", async () => {
    const { result, dialog } = await openDialog({
      title: "t",
      validate: (v) => (v.name ? "" : "a name is required"),
      fields: [{ key: "name" }],
    });
    const ok = button(dialog, "OK");
    expect(ok.disabled).toBe(true);
    expect(dialog.querySelector(".form-error")).toBeNull(); // untouched: no nagging yet
    const input = dialog.querySelector<HTMLInputElement>("input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await core.settle();
    expect(dialog.querySelector(".form-error")!.textContent).toBe("a name is required");
    typeInto(input, "ok");
    await core.settle();
    expect(ok.disabled).toBe(false);
    expect(dialog.querySelector(".form-error")).toBeNull();
    ok.click();
    expect(await result).toEqual({ name: "ok" });
  });

  it("a check-select seeds its select from default() on tick and clears on untick", async () => {
    const { result, dialog } = await openDialog({
      title: "t",
      fields: [
        {
          key: "db",
          type: "check-select",
          label: "Use a database",
          default: () => "b",
          options: [
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ],
        },
        {
          key: "other",
          type: "check-select",
          label: "Other",
          options: [{ value: "first", label: "First" }],
        },
      ],
    });
    expect(dialog.querySelector("select")).toBeNull();
    const [db, other] = [...dialog.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
    db.checked = true;
    db.dispatchEvent(new Event("change"));
    other.checked = true;
    other.dispatchEvent(new Event("change"));
    await core.settle();
    const selects = dialog.querySelectorAll("select");
    expect(selects.length).toBe(2);
    expect(selects[0].value).toBe("b");
    selects[0].value = "a";
    selects[0].dispatchEvent(new Event("change"));
    other.checked = false;
    other.dispatchEvent(new Event("change"));
    await core.settle();
    button(dialog, "OK").click();
    expect(await result).toEqual({ db: "a", other: "" });
  });

  it("an action field runs and merges its result; a null result leaves the form alone", async () => {
    let release: (v: DialogValues | null) => void = () => {};
    const { result, dialog } = await openDialog({
      title: "t",
      fields: [
        { key: "branch", value: "" },
        {
          key: "pick",
          type: "action",
          label: "Search…",
          run: () => new Promise<DialogValues | null>((r) => (release = r)),
        },
      ],
    });
    const action = button(dialog, "Search…");
    action.click();
    await core.settle();
    expect(action.textContent).toBe("…"); // busy while the nested flow runs
    expect(action.disabled).toBe(true);
    release(null);
    await core.settle();
    expect(dialog.querySelector<HTMLInputElement>("input")!.value).toBe("");
    button(dialog, "Search…").click();
    await core.settle();
    release({ branch: "master-feat" });
    await core.settle();
    expect(dialog.querySelector<HTMLInputElement>("input")!.value).toBe("master-feat");
    button(dialog, "OK").click();
    expect(await result).toEqual({ branch: "master-feat" });
  });
});
